// One open session: signed spends with the request journal, retries, and status recovery.
//
// Rules (implementation.md section 11, "Retry and recovery"):
// - The SDK encodes one JSON-RPC object and keeps the exact bytes. The sequence starts at 0.
// - The SDK writes the signed request to storage before it sends it (the journal).
// - A lost response is sent again with the same bytes and the same signature.
// - After response_expired, the SDK reads the signed status. It reports the lost result. It does
//   not send a new charged request unless the caller asks for retryAsNew.
// - A restarted client resumes the pending request. It never gives the same sequence to a
//   different request.

import {
  PROTOCOL_VERSION,
  decodeBase64,
  readSpendResponseHeaders,
  type ReceiptMetadata,
  type SessionState,
  type SpendRequest,
  type SpendResponseHeaders,
  type StatusResponse,
} from "@anon-credit/protocol";
import { LostResultError, SdkError, ServiceError, type Thrown } from "./errors.ts";
import { buildStatusRequest, type GatewayClient } from "./gateway.ts";
import { serviceError } from "./http.ts";
import type { SessionKey } from "./keys.ts";
import type { Clock, RandomSource } from "./random.ts";
import {
  buildSpendRequest,
  encodeRpcRequest,
  jsonRpcResponseSchema,
  unitsOf,
  type JsonRpcResponse,
  type JsonValue,
  jsonValueSchema,
  type SpendIdentity,
} from "./spend.ts";
import { batchKey, type BatchRecord, type DeploymentRecord, type PendingSpend, type SessionRecord } from "./state.ts";
import type { EncryptedStore } from "./storage.ts";
import { z } from "zod";

export interface RetryPolicy {
  // Sends of one request before the SDK gives up and keeps it pending. Default: 3.
  readonly attempts: number;
  // Wait between sends, in milliseconds. Default: 1000.
  readonly delayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, delayMs: 1000 };

export interface SessionContext {
  readonly store: EncryptedStore;
  readonly gateway: GatewayClient;
  readonly deployment: DeploymentRecord;
  readonly random: RandomSource;
  readonly clock: Clock;
  readonly retry: RetryPolicy;
}

export interface RpcOutcome {
  readonly seq: bigint;
  readonly units: number;
  readonly unitsTotal: bigint;
  // Units that remain after the request.
  readonly remaining: number;
  readonly nextSeq: bigint;
  // true if the gateway served a stored response without a new charge. null if the
  // X-Anon-* headers were not available and the SDK used the status call.
  readonly replayed: boolean | null;
  // "headers": X-Anon-* response headers. "status": the signed status call.
  readonly stateSource: "headers" | "status";
  // Number of sends of this request.
  readonly attempts: number;
  // Exact response body.
  readonly body: string;
  readonly response: JsonRpcResponse;
  // The signed request as sent. A replay sends it again without a change.
  readonly request: SpendRequest;
  // Receipt of an earlier request whose result was lost (only with retryAsNew).
  readonly lostReceipt: ReceiptMetadata | null;
}

export interface RpcOptions {
  // After response_expired of an earlier pending request, send this request as a new charged
  // request. Default: false (report the lost result).
  readonly retryAsNew?: boolean;
}

// The result of a raw send. It changes no local state. Used by diagnostic probes.
export interface RawSpendResult {
  readonly httpStatus: number;
  readonly body: string;
  readonly headers: SpendResponseHeaders | null;
  readonly errorCode: string | null;
}

function pendingRequest(record: BatchRecord, pending: PendingSpend): SpendRequest {
  return {
    protocol_version: PROTOCOL_VERSION,
    batch_id: record.batch_id,
    seq: pending.seq,
    units_total: pending.units_total,
    rpc: pending.rpc,
    signature: pending.signature,
  };
}

// The method and the parameters of a journaled JSON-RPC request.
const rpcCallSchema = z.object({ method: z.string(), params: z.array(jsonValueSchema) });

// The larger of two decimal u64 values.
function maxText(a: string, b: string): string {
  return BigInt(a) >= BigInt(b) ? a : b;
}

function headersOf(response: Response): SpendResponseHeaders | null {
  try {
    return readSpendResponseHeaders(response.headers);
  } catch {
    return null;
  }
}

export class Session {
  #record: BatchRecord;
  readonly #key: SessionKey;
  readonly #context: SessionContext;
  #queue: Promise<void> = Promise.resolve();

  constructor(record: BatchRecord, key: SessionKey, context: SessionContext) {
    this.#record = record;
    this.#key = key;
    this.#context = context;
  }

  get batchId(): string {
    return this.#record.batch_id;
  }

  // The isolation key of this batch: the batch ID.
  get isolationKey(): string {
    return this.#record.batch_id;
  }

  get record(): BatchRecord {
    return this.#record;
  }

  get state(): SessionRecord {
    const session = this.#record.session;
    if (session === null) throw new SdkError("session_not_open", `batch ${this.batchId} has no open session`);
    return session;
  }

  get pending(): PendingSpend | null {
    return this.#record.pending;
  }

  get #identity(): SpendIdentity {
    return {
      deploymentId: this.#context.deployment.deployment_id,
      gatewayId: this.#context.deployment.gateway_id,
      batchId: this.#record.batch_id,
      priceTableHash: this.state.price_table_hash,
    };
  }

  // Run one operation at a time on this session.
  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(operation);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #save(record: BatchRecord): Promise<void> {
    await this.#context.store.write(batchKey(record.batch_id), record);
    this.#record = record;
  }

  // Sign a spend request with any sequence and units_total. It changes no state. Used by
  // diagnostic probes (for example a sequence gap). Normal calls use rpc().
  buildRequest(seq: bigint, unitsTotal: bigint, method: string, params: readonly JsonValue[]): SpendRequest {
    return buildSpendRequest(this.#identity, this.#key, { seq, unitsTotal, rpcBytes: encodeRpcRequest(seq, method, params) });
  }

  // Send a request without a state change. Used by diagnostic probes and replay checks.
  async sendRaw(request: SpendRequest): Promise<RawSpendResult> {
    const response = await this.#context.gateway.spend(request, this.isolationKey);
    switch (response.ok) {
      case true:
        return { httpStatus: response.status, body: await response.text(), headers: headersOf(response), errorCode: null };
      case false: {
        const error = await serviceError(response);
        return {
          httpStatus: response.status,
          body: "",
          headers: null,
          errorCode: error instanceof ServiceError ? error.serviceCode : error.code,
        };
      }
    }
  }

  // Signed status. It checks the echoed nonce and the session key, and it updates the local
  // session state.
  status(): Promise<StatusResponse> {
    return this.#exclusive(() => this.#statusInner());
  }

  async #statusInner(): Promise<StatusResponse> {
    const request = buildStatusRequest(
      {
        deploymentId: this.#context.deployment.deployment_id,
        gatewayId: this.#context.deployment.gateway_id,
        batchId: this.#record.batch_id,
      },
      this.#key,
      this.#context.random,
    );
    const status = await this.#context.gateway.status(request, this.isolationKey);
    if (status.nonce !== request.nonce) throw new SdkError("invalid_response", "the status nonce is not the request nonce");
    if (status.session.batch_id !== this.#record.batch_id || status.session.session_pub !== this.#record.session_pub) {
      throw new SdkError("invalid_response", "the status is for a different batch or session key");
    }
    await this.#sync(status.session);
    return status;
  }

  async #sync(session: SessionState): Promise<void> {
    const local = this.state;
    await this.#save({
      ...this.#record,
      session: {
        ...local,
        remaining: session.remaining,
        units_total: session.units_total,
        next_seq: session.next_seq,
        state: session.state,
        deadline_epoch: session.deadline_epoch,
      },
    });
  }

  // Send one JSON-RPC request and pay for it.
  rpc(method: string, params: readonly JsonValue[], options: RpcOptions = {}): Promise<RpcOutcome> {
    return this.#exclusive(() => this.#rpcInner(method, params, options));
  }

  // Send the pending request of the journal again (same bytes, same signature).
  // Return null if there is no pending request. With retryAsNew, a lost result (after
  // response_expired) is followed by the same JSON-RPC call as a new charged request.
  resume(options: RpcOptions = {}): Promise<RpcOutcome | null> {
    return this.#exclusive(async () => {
      const pending = this.#record.pending;
      if (pending === null) return null;
      try {
        return await this.#deliver(pending, pendingRequest(this.#record, pending), null);
      } catch (error) {
        if (!(error instanceof LostResultError && options.retryAsNew === true)) throw error;
        const call = rpcCallSchema.parse(JSON.parse(new TextDecoder().decode(decodeBase64(pending.rpc))));
        return this.#newRequest(call.method, call.params, {}, error.receipt ?? null);
      }
    });
  }

  async #rpcInner(method: string, params: readonly JsonValue[], options: RpcOptions): Promise<RpcOutcome> {
    if (this.#record.pending !== null) {
      throw new SdkError("pending_request", `sequence ${this.#record.pending.seq} waits for an answer; call resume() first`);
    }
    return this.#newRequest(method, params, options, null);
  }

  async #newRequest(
    method: string,
    params: readonly JsonValue[],
    options: RpcOptions,
    lostReceipt: ReceiptMetadata | null,
  ): Promise<RpcOutcome> {
    const session = this.state;
    const units = unitsOf(session.price_table, method);
    const seq = BigInt(session.next_seq);
    const unitsTotal = BigInt(session.units_total) + BigInt(units);
    const request = this.buildRequest(seq, unitsTotal, method, params);
    const pending: PendingSpend = {
      seq: request.seq,
      units_total: request.units_total,
      units,
      method,
      rpc: request.rpc,
      signature: request.signature,
    };
    // Journal the request before transmission.
    await this.#save({ ...this.#record, pending });
    try {
      return await this.#deliver(pending, request, lostReceipt);
    } catch (error) {
      if (error instanceof LostResultError && options.retryAsNew === true) {
        return this.#newRequest(method, params, {}, error.receipt ?? null);
      }
      throw error;
    }
  }

  async #deliver(pending: PendingSpend, request: SpendRequest, lostReceipt: ReceiptMetadata | null): Promise<RpcOutcome> {
    let lastError: Thrown = undefined;
    for (let attempt = 1; attempt <= this.#context.retry.attempts; attempt += 1) {
      if (attempt > 1) await this.#context.clock.sleep(this.#context.retry.delayMs);
      let response: Response;
      try {
        response = await this.#context.gateway.spend(request, this.isolationKey);
      } catch (error) {
        // The response is lost. Send the same bytes and signature again.
        lastError = error;
        continue;
      }
      if (response.ok) return this.#accept(pending, request, response, attempt, lostReceipt);
      const error = await serviceError(response);
      if (!(error instanceof ServiceError)) {
        lastError = error;
        continue;
      }
      switch (error.serviceCode) {
        case "busy":
        case "upstream_failed":
        case "storage_unavailable":
          // Not charged. The same request can succeed later.
          lastError = error;
          continue;
        case "response_expired":
          return this.#lost(pending, error);
        case "sequence_conflict":
        case "sequence_gap":
          // The local sequence does not agree with the gateway. Read the status and drop the
          // request; the gateway did not charge this request.
          await this.#statusInner();
          await this.#save({ ...this.#record, pending: null });
          throw error;
        default:
          // Rejected before any charge (signature, units, method, deadline, schema).
          await this.#save({ ...this.#record, pending: null });
          throw error;
      }
    }
    // Keep the request pending. resume() sends it again later.
    throw lastError instanceof SdkError
      ? lastError
      : new SdkError("transport_failed", `sequence ${pending.seq}: no answer after ${this.#context.retry.attempts} sends`);
  }

  async #lost(pending: PendingSpend, error: ServiceError): Promise<never> {
    const status = await this.#statusInner();
    const seq = BigInt(pending.seq);
    await this.#save({ ...this.#record, pending: null });
    if (BigInt(status.session.next_seq) > seq) {
      throw new LostResultError(seq, error.receipt ?? status.latest_receipt ?? undefined);
    }
    throw error;
  }

  async #accept(
    pending: PendingSpend,
    request: SpendRequest,
    response: Response,
    attempts: number,
    lostReceipt: ReceiptMetadata | null,
  ): Promise<RpcOutcome> {
    const body = await response.text();
    const seq = BigInt(pending.seq);
    const headers = headersOf(response);
    let stateSource: RpcOutcome["stateSource"] = "headers";
    let remaining: number;
    let nextSeq: bigint;
    switch (headers) {
      case null: {
        // The transport did not give the X-Anon-* headers. Use the signed status call.
        const status = await this.#statusInner();
        stateSource = "status";
        remaining = status.session.remaining;
        nextSeq = BigInt(status.session.next_seq);
        break;
      }
      default:
        remaining = headers.remaining;
        nextSeq = headers.next_seq;
    }
    if (nextSeq <= seq) throw new SdkError("invalid_response", `next sequence ${nextSeq} is not after ${seq}`);
    const local = this.state;
    await this.#save({
      ...this.#record,
      pending: null,
      session: {
        ...local,
        remaining,
        units_total: maxText(local.units_total, pending.units_total),
        next_seq: maxText(local.next_seq, nextSeq.toString(10)),
        state: remaining === 0 ? "exhausted" : local.state,
      },
    });
    let parsed: JsonRpcResponse;
    try {
      const result = jsonRpcResponseSchema.safeParse(JSON.parse(body));
      if (!result.success) throw new Error(result.error.message);
      parsed = result.data;
    } catch (error) {
      throw new SdkError("invalid_response", `the gateway charged sequence ${seq}, but the body is not a JSON-RPC response: ${String(error)}`);
    }
    return {
      seq,
      units: pending.units,
      unitsTotal: BigInt(pending.units_total),
      remaining,
      nextSeq,
      replayed: headers === null ? null : headers.replayed,
      stateSource,
      attempts,
      body,
      response: parsed,
      request,
      lostReceipt,
    };
  }
}

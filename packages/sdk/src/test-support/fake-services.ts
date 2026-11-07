// In-process fake gateway and issuer for SDK tests. The fake is a Transport, so the SDK code
// under test is the real code. The fake checks the same signatures as the real gateway and
// follows its sequence, replay, expiry, and chunked upload rules. Hooks inject lost
// responses, missing headers, transport failures, and chunk failures.

import type { Transport, TransportLogEntry } from "@anon-credit/anon-transport";
import { TransportError } from "@anon-credit/anon-transport";
import { fieldToHex } from "@anon-credit/crypto";
import {
  CURRENT_PRICE_TABLE,
  OPEN_CHUNK_MAX_BYTES,
  OPEN_CHUNK_PATH_PREFIX,
  PROTOCOL_VERSION,
  decodeBase64,
  decodeFixedHex,
  deploymentId,
  deploymentConfigSchema,
  encodeBase64,
  encodeHex,
  openMessageDigest,
  openMessageFromRequest,
  openRequestSchema,
  parseOpenChunkPath,
  priceTableHash,
  spendMessageDigest,
  spendRequestSchema,
  statusMessageDigest,
  statusMessageFromRequest,
  statusRequestSchema,
  type ErrorCode,
  type Issuance,
  type ReceiptMetadata,
  type SessionState,
} from "@anon-credit/protocol";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { z } from "zod";
import { buildMmr, type TestMmr } from "./mmr.ts";

export const GATEWAY_URL = "https://gateway.test";
export const ISSUER_URL = "https://issuer.test";
export const MANIFEST_SHA = `0x${"ab".repeat(32)}`;
export const EPOCH_SECONDS = 30;

const deploymentText = {
  protocol_version: PROTOCOL_VERSION,
  payment_chain_id: 11_155_111,
  sale_address: `0x${"11".repeat(20)}`,
  root_registry_address: `0x${"22".repeat(20)}`,
  issuer_address: `0x${"33".repeat(20)}`,
  gateway_id: `0x${"44".repeat(32)}`,
  batch_size: 100,
  epoch_seconds: EPOCH_SECONDS,
  credit_lifetime_epochs: 35_040,
  circuit_id: "0x00000000000000616e6f6e2d6372656469742f76312f62617463682d6f70656e",
  verifier_artifact_hash: `0x${"55".repeat(32)}`,
  prover_manifest_hash: MANIFEST_SHA,
};

export const DEPLOYMENT_ID = encodeHex(deploymentId(deploymentConfigSchema.parse(deploymentText)));
const PRICE_HASH = encodeHex(priceTableHash(CURRENT_PRICE_TABLE));

export interface CallRecord {
  readonly method: string;
  readonly path: string;
  readonly isolationKey: string;
  // Text of a JSON body. undefined for a binary body (proof chunks) and for no body.
  readonly body: string | undefined;
  // Raw bytes of a binary body.
  readonly bytes: Uint8Array | undefined;
}

interface FakeSession {
  state: SessionState;
  openDigest: string;
  receipts: Map<bigint, { digest: string; units: number; unitsTotal: bigint; response: string | null }>;
}

export interface FakeHooks {
  // Commit the next n spends, then throw a transport error instead of the response.
  dropResponses: number;
  // Leave out the X-Anon-* headers of successful spends.
  omitHeaders: boolean;
  // Throw a transport error for every request (nothing reaches the fake).
  transportDown: boolean;
  // Reject proofs whose bytes are not the fake prover output.
  validProof: string;
  // Throw a transport error for the next n chunk requests (nothing reaches the fake).
  failChunks: number;
  // Throw a transport error for a chunk request while another chunk request is in flight.
  refuseParallelChunks: boolean;
}

export interface ChunkStats {
  // Chunk requests that reached the fake.
  received: number;
  // Largest number of chunk requests in flight at the same time.
  maxInFlight: number;
  // Uploads that wait for an open request.
  pendingUploads: () => number;
}

export interface FakeServices {
  readonly transport: Transport;
  readonly calls: CallRecord[];
  readonly hooks: FakeHooks;
  readonly sessions: Map<string, FakeSession>;
  readonly chunkStats: ChunkStats;
  // Make the issuance of commitments: leaves, MMR, and one finalized root of `epoch`.
  readonly issue: (commitments: readonly bigint[], leafFor: (commitment: bigint) => bigint, epoch: bigint) => Issuance;
  // Drop the stored response bytes of all receipts (the 60 s retention passed).
  readonly expireResponses: () => void;
  readonly setEpoch: (epoch: bigint) => void;
}

function json(status: number, body: object, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function error(status: number, code: ErrorCode, receipt?: ReceiptMetadata): Response {
  return json(status, { code, message: code, retryable: false, ...(receipt === undefined ? {} : { receipt }) });
}

function verify(signature: string, digest: Uint8Array, publicKey: string): boolean {
  return ed25519.verify(decodeBase64(signature), digest, decodeFixedHex(publicKey, 32));
}

const rpcSchema = z.object({ jsonrpc: z.literal("2.0"), id: z.number(), method: z.string(), params: z.array(z.json()) });

export function fakeServices(kind: "anon" | "direct" = "anon"): FakeServices {
  const calls: CallRecord[] = [];
  const hooks: FakeHooks = {
    dropResponses: 0,
    omitHeaders: false,
    transportDown: false,
    validProof: encodeBase64Text("proof"),
    failChunks: 0,
    refuseParallelChunks: false,
  };
  const uploads = new Map<string, { total: number; count: number; chunks: (Uint8Array | undefined)[]; complete: boolean }>();
  let inFlight = 0;
  const chunkStats: ChunkStats = { received: 0, maxInFlight: 0, pendingUploads: () => uploads.size };
  const sessions = new Map<string, FakeSession>();
  const keys: string[] = [];
  let currentEpoch = 1000n;
  let mmr: TestMmr | null = null;
  let leaves: bigint[] = [];
  const roots: { epoch: bigint; root: bigint; leafCount: number }[] = [];
  const logs: TransportLogEntry[] = [];

  const receiptOf = (seq: bigint, receipt: { digest: string; units: number; unitsTotal: bigint; response: string | null }): ReceiptMetadata => ({
    seq: seq.toString(10),
    request_digest: receipt.digest,
    units: receipt.units,
    units_total: receipt.unitsTotal.toString(10),
    committed_at: "1",
    response_retained: receipt.response !== null,
  });

  const spendHeaders = (session: SessionState, replayed: boolean): Record<string, string> =>
    hooks.omitHeaders
      ? {}
      : { "x-anon-remaining": String(session.remaining), "x-anon-next-seq": session.next_seq, "x-anon-replayed": String(replayed) };

  // The proof bytes of an open request as base64: inline, or from the upload (decompressed).
  // The upload is deleted in all cases. null: the upload is missing or not usable.
  const proofOf = async (request: z.output<typeof openRequestSchema>): Promise<string | null> => {
    if ("proof" in request) return request.proof;
    const reference = request.proof_upload;
    const key = `${request.batch_id}:${reference.proof_sha256}`;
    const upload = uploads.get(key);
    uploads.delete(key);
    if (upload === undefined || !upload.complete || upload.total !== reference.total_bytes) return null;
    const bytes = concat(upload.chunks);
    switch (reference.proof_encoding) {
      case "json+gzip": {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
        return encodeBase64(new Uint8Array(await new Response(stream).arrayBuffer()));
      }
      case "json":
      case "np":
        return encodeBase64(bytes);
    }
  };

  // PUT /v1/open/chunks/... with the raw chunk bytes as the body.
  const putChunk = (path: string, data: Uint8Array | undefined): Response => {
    const chunk = parseOpenChunkPath(path);
    if (chunk === null || data === undefined || data.byteLength === 0 || data.byteLength > OPEN_CHUNK_MAX_BYTES) return error(400, "invalid_request");
    const key = `${chunk.batch_id}:${chunk.proof_sha256}`;
    const upload = uploads.get(key) ?? { total: chunk.total_bytes, count: chunk.chunk_count, chunks: new Array<Uint8Array | undefined>(chunk.chunk_count).fill(undefined), complete: false };
    uploads.set(key, upload);
    if (upload.total !== chunk.total_bytes || upload.count !== chunk.chunk_count || chunk.chunk_index >= upload.count) return error(400, "invalid_request");
    const existing = upload.chunks[chunk.chunk_index];
    if (existing !== undefined && encodeHex(existing) !== encodeHex(data)) return error(400, "invalid_request");
    upload.chunks[chunk.chunk_index] = data;
    const received = upload.chunks.filter((item) => item !== undefined).length;
    if (received === upload.count && !upload.complete) {
      const bytes = concat(upload.chunks);
      if (bytes.byteLength !== upload.total || encodeHex(sha256(bytes)) !== chunk.proof_sha256) {
        uploads.delete(key);
        return error(400, "invalid_request");
      }
      upload.complete = true;
    }
    return json(200, { received_chunks: received, complete: upload.complete });
  };

  const gateway = async (method: string, path: string, body: string | undefined, bytes: Uint8Array | undefined): Promise<Response> => {
    if (method === "PUT" && path.startsWith(`${OPEN_CHUNK_PATH_PREFIX}/`)) return putChunk(path, bytes);
    switch (`${method} ${path}`) {
      case "GET /v1/config":
        return json(200, {
          protocol_version: PROTOCOL_VERSION,
          deployment_id: DEPLOYMENT_ID,
          gateway_id: deploymentText.gateway_id,
          circuit_id: deploymentText.circuit_id,
          verifier_artifact_hash: deploymentText.verifier_artifact_hash,
          payment_chain_id: 11_155_111,
          upstream_chain_id: 11_155_111,
          root_registry_address: deploymentText.root_registry_address,
          epoch_seconds: EPOCH_SECONDS,
          current_epoch: currentEpoch.toString(10),
          root_window_epochs: 96,
          session_lifetime_epochs: 35_040,
          batch_size: 100,
          price_table_hash: PRICE_HASH,
          limits: {
            open_body_bytes: 16_777_216,
            spend_body_bytes: 65_536,
            upstream_response_bytes: 1_048_576,
            upstream_timeout_ms: 15_000,
            proof_verify_concurrency: 2,
            proof_queue_depth: 8,
            response_retention_seconds: 60,
            batch_lock_wait_ms: 5000,
            open_upload_max_bytes: 4_194_304,
            open_upload_chunk_bytes: 40_000,
            open_upload_chunk_body_bytes: 40_000,
            open_upload_max_chunks: 256,
            open_upload_ttl_seconds: 600,
            open_upload_max_pending: 1000,
            open_upload_max_pending_bytes: 536_870_912,
          },
          demo_peer_enabled: false,
          block_tag: "finalized",
        });
      case "GET /v1/prices":
        return json(200, { price_table_hash: PRICE_HASH, price_table: CURRENT_PRICE_TABLE });
      case "GET /v1/roots":
        return json(200, {
          current_epoch: currentEpoch.toString(10),
          root_window_epochs: 96,
          roots: [...roots].reverse().map((root) => ({ source_epoch: root.epoch.toString(10), root: fieldToHex(root.root), leaf_count: root.leafCount })),
        });
      case "POST /v1/open": {
        const request = openRequestSchema.parse(JSON.parse(body ?? ""));
        const proof = await proofOf(request);
        const messageDigest = openMessageDigest(openMessageFromRequest(request));
        if (!verify(request.signature, messageDigest, request.session_pub)) {
          return error(401, "signature_invalid");
        }
        const digest = encodeHex(messageDigest);
        const existing = sessions.get(request.batch_id);
        if (existing !== undefined) {
          return existing.openDigest === digest ? json(200, { session: existing.state, existing: true }) : error(409, "session_conflict");
        }
        if (proof === null) return error(400, "invalid_request");
        if (proof !== hooks.validProof) return error(422, "proof_invalid");
        const state: SessionState = {
          batch_id: request.batch_id,
          session_pub: request.session_pub,
          price_table_hash: request.price_table_hash,
          remaining: 100,
          units_total: "0",
          next_seq: "0",
          open_epoch: currentEpoch.toString(10),
          deadline_epoch: (currentEpoch + 35_040n).toString(10),
          state: "active",
        };
        sessions.set(request.batch_id, { state, openDigest: digest, receipts: new Map() });
        return json(200, { session: state, existing: false });
      }
      case "POST /v1/rpc": {
        const request = spendRequestSchema.parse(JSON.parse(body ?? ""));
        const session = sessions.get(request.batch_id);
        if (session === undefined) return error(404, "not_found");
        const rpcBytes = decodeBase64(request.rpc);
        const seq = BigInt(request.seq);
        const unitsTotal = BigInt(request.units_total);
        const digest = spendMessageDigest({
          deploymentId: decodeFixedHex(DEPLOYMENT_ID, 32),
          gatewayId: decodeFixedHex(deploymentText.gateway_id, 32),
          batchId: decodeFixedHex(request.batch_id, 32),
          priceTableHash: decodeFixedHex(session.state.price_table_hash, 32),
          seq,
          unitsTotal,
          rpcBytes,
        });
        if (!verify(request.signature, digest, session.state.session_pub)) return error(401, "signature_invalid");
        const digestHex = encodeHex(digest);
        const next = BigInt(session.state.next_seq);
        if (seq < next) {
          const receipt = session.receipts.get(seq);
          if (receipt === undefined || receipt.digest !== digestHex) return error(409, "sequence_conflict");
          if (receipt.response === null) return error(410, "response_expired", receiptOf(seq, receipt));
          return new Response(receipt.response, { status: 200, headers: spendHeaders(session.state, true) });
        }
        if (seq > next) return error(409, "sequence_gap");
        const rpc = rpcSchema.parse(JSON.parse(new TextDecoder().decode(rpcBytes)));
        const units = CURRENT_PRICE_TABLE.units[rpc.method];
        if (units === undefined) return error(422, "method_not_allowed");
        if (session.state.remaining < units) return error(402, "insufficient_units");
        if (unitsTotal !== BigInt(session.state.units_total) + BigInt(units)) return error(400, "invalid_request");
        const response = JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: `0x${(1000 + Number(seq)).toString(16)}` });
        session.receipts.set(seq, { digest: digestHex, units, unitsTotal, response });
        const remaining = session.state.remaining - units;
        session.state = {
          ...session.state,
          remaining,
          units_total: unitsTotal.toString(10),
          next_seq: (seq + 1n).toString(10),
          state: remaining === 0 ? "exhausted" : "active",
        };
        if (hooks.dropResponses > 0) {
          hooks.dropResponses -= 1;
          throw new TransportError("network_error", "fake: the response was lost after the commit");
        }
        return new Response(response, { status: 200, headers: spendHeaders(session.state, false) });
      }
      case "POST /v1/session/status": {
        const request = statusRequestSchema.parse(JSON.parse(body ?? ""));
        const session = sessions.get(request.batch_id);
        if (session === undefined) return error(404, "not_found");
        if (!verify(request.signature, statusMessageDigest(statusMessageFromRequest(request)), session.state.session_pub)) {
          return error(401, "signature_invalid");
        }
        const last = [...session.receipts.entries()].at(-1);
        return json(200, {
          session: session.state,
          current_epoch: currentEpoch.toString(10),
          latest_receipt: last === undefined ? null : receiptOf(last[0], last[1]),
          nonce: request.nonce,
        });
      }
      default:
        return error(404, "not_found");
    }
  };

  const issuer = (path: string, query: URLSearchParams): Response => {
    switch (true) {
      case path === "/v1/config":
        return json(200, {
          deployment: deploymentText,
          deployment_id: DEPLOYMENT_ID,
          batch_price_wei: "100000000000000",
          max_batches_per_purchase: 100,
          root_window_epochs: 96,
          block_tag: "finalized",
        });
      case path === "/v1/roots":
        return json(200, {
          current_epoch: currentEpoch.toString(10),
          finalized_block: "10",
          roots: roots.map((root) => ({
            epoch: root.epoch.toString(10),
            leaf_count: root.leafCount,
            root: fieldToHex(root.root),
            status: "finalized",
            tx_hash: `0x${"cd".repeat(32)}`,
            block_number: "5",
          })),
        });
      case path.startsWith("/v1/tree/path/"): {
        const index = Number(path.slice("/v1/tree/path/".length));
        const root = roots.find((item) => fieldToHex(item.root) === query.get("root"));
        if (mmr === null || root === undefined || index >= root.leafCount) return error(404, "not_found");
        const proof = mmr.proof(index);
        return json(200, {
          root: fieldToHex(root.root),
          epoch: root.epoch.toString(10),
          leaf: fieldToHex(leaves[index] ?? 0n),
          proof: {
            leaf_index: proof.leafIndex,
            leaf_count: proof.leafCount,
            peak_position: proof.peakPosition,
            siblings: proof.siblings.map(fieldToHex),
            peaks: proof.peaks.map(fieldToHex),
          },
        });
      }
      default:
        return error(404, "not_found");
    }
  };

  const transport: Transport = {
    kind,
    maxBodyBytes: kind === "anon" ? 40_000 : Number.POSITIVE_INFINITY,
    logs,
    isolationKeys: () => [...keys],
    close: () => undefined,
    fetch: async (url, init, options) => {
      const raw = init.body instanceof ReadableStream ? new Uint8Array(await new Response(init.body).arrayBuffer()) : init.body;
      const body = typeof raw === "string" ? raw : undefined;
      const bytes = raw instanceof Uint8Array ? raw : undefined;
      const size = body?.length ?? bytes?.byteLength ?? 0;
      if (hooks.transportDown) throw new TransportError("network_error", "fake: the transport is down");
      const parsed = new URL(url);
      if (!keys.includes(options.isolationKey)) keys.push(options.isolationKey);
      calls.push({ method: init.method, path: parsed.pathname, isolationKey: options.isolationKey, body, bytes });
      if (size > transport.maxBodyBytes) throw new TransportError("worker_error", "fake: the body is too large");
      if (parsed.pathname.startsWith(`${OPEN_CHUNK_PATH_PREFIX}/`)) {
        if (hooks.failChunks > 0) {
          hooks.failChunks -= 1;
          throw new TransportError("network_error", "fake: the chunk request failed");
        }
        if (hooks.refuseParallelChunks && inFlight > 0) throw new TransportError("network_error", "fake: parallel chunk refused");
        inFlight += 1;
        chunkStats.maxInFlight = Math.max(chunkStats.maxInFlight, inFlight);
        try {
          // Let other requests start, so that parallel requests overlap.
          await new Promise((resolve) => setTimeout(resolve, 1));
          chunkStats.received += 1;
          return await gateway(init.method, parsed.pathname, body, bytes);
        } finally {
          inFlight -= 1;
        }
      }
      switch (parsed.origin) {
        case GATEWAY_URL:
          return gateway(init.method, parsed.pathname, body, bytes);
        case ISSUER_URL:
          return issuer(parsed.pathname, parsed.searchParams);
        default:
          throw new TransportError("network_error", `fake: unknown origin ${parsed.origin}`);
      }
    },
  };

  return {
    transport,
    calls,
    hooks,
    sessions,
    chunkStats,
    issue: (commitments, leafFor, epoch) => {
      const start = leaves.length;
      leaves = [...leaves, ...commitments.map(leafFor)];
      mmr = buildMmr(leaves);
      roots.push({ epoch, root: mmr.root, leafCount: leaves.length });
      return {
        purchase_id: "1",
        payer: `0x${"99".repeat(20)}`,
        amount_wei: "300000000000000",
        block_number: "5",
        insertion_epoch: (epoch - 1n).toString(10),
        eligible_epoch: epoch.toString(10),
        expiry: (epoch - 1n + 35_040n).toString(10),
        leaves: commitments.map((commitment, offset) => ({
          leaf_index: start + offset,
          commitment: fieldToHex(commitment),
          leaf: fieldToHex(leaves[start + offset] ?? 0n),
        })),
      };
    },
    expireResponses: () => {
      for (const session of sessions.values()) {
        for (const receipt of session.receipts.values()) receipt.response = null;
      }
    },
    setEpoch: (epoch) => {
      currentEpoch = epoch;
    },
  };
}

function encodeBase64Text(text: string): string {
  return btoa(text);
}

function concat(parts: readonly (Uint8Array | undefined)[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + (part?.byteLength ?? 0), 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    if (part === undefined) continue;
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

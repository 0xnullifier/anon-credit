// Spend requests: one UTF-8 JSON-RPC object, the exact bytes, the units of the frozen price
// table, the cumulative units_total, and the Ed25519 signature over the spend digest.

import {
  PROTOCOL_VERSION,
  decodeFixedHex,
  encodeBase64,
  spendMessageDigest,
  type PriceTable,
  type SpendRequest,
} from "@anon-credit/protocol";
import { z } from "zod";
import { SdkError } from "./errors.ts";
import { signDigest, type SessionKey } from "./keys.ts";

// JSON-RPC parameters. Only JSON values; no functions, no undefined.
export const jsonValueSchema = z.json();
export type JsonValue = z.infer<typeof jsonValueSchema>;

// Encode one JSON-RPC request object. The id is the sequence number, so each request of a
// session has its own id. The SDK keeps these bytes for retries and never encodes them again.
export function encodeRpcRequest(seq: bigint, method: string, params: readonly JsonValue[]): Uint8Array {
  const text = JSON.stringify({ jsonrpc: "2.0", id: Number(seq), method, params });
  return new TextEncoder().encode(text);
}

// Units of `method` in the frozen price table.
export function unitsOf(table: PriceTable, method: string): number {
  const units = table.units[method];
  if (units === undefined) throw new SdkError("method_not_priced", `the frozen price table has no price for ${method}`);
  return units;
}

export interface SpendIdentity {
  readonly deploymentId: string;
  readonly gatewayId: string;
  readonly batchId: string;
  readonly priceTableHash: string;
}

export interface SpendInput {
  readonly seq: bigint;
  // Cumulative units including this request.
  readonly unitsTotal: bigint;
  readonly rpcBytes: Uint8Array;
}

// The signature of a spend request as canonical base64.
export function signSpend(identity: SpendIdentity, key: SessionKey, input: SpendInput): string {
  const digest = spendMessageDigest({
    deploymentId: decodeFixedHex(identity.deploymentId, 32),
    gatewayId: decodeFixedHex(identity.gatewayId, 32),
    batchId: decodeFixedHex(identity.batchId, 32),
    priceTableHash: decodeFixedHex(identity.priceTableHash, 32),
    seq: input.seq,
    unitsTotal: input.unitsTotal,
    rpcBytes: input.rpcBytes,
  });
  return encodeBase64(signDigest(key, digest));
}

// A complete signed spend request.
export function buildSpendRequest(identity: SpendIdentity, key: SessionKey, input: SpendInput): SpendRequest {
  return {
    protocol_version: PROTOCOL_VERSION,
    batch_id: identity.batchId,
    seq: input.seq.toString(10),
    units_total: input.unitsTotal.toString(10),
    rpc: encodeBase64(input.rpcBytes),
    signature: signSpend(identity, key, input),
  };
}

// A JSON-RPC response object. The gateway charges a result and an error object alike.
export const jsonRpcResponseSchema = z.union([
  z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.number(), z.string(), z.null()]), result: jsonValueSchema }),
  z.object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.number(), z.string(), z.null()]),
    error: z.object({ code: z.number(), message: z.string(), data: jsonValueSchema.optional() }),
  }),
]);
export type JsonRpcResponse = z.infer<typeof jsonRpcResponseSchema>;

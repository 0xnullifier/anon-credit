// Runtime schemas of the gateway HTTP API (implementation.md section 10).
// The Rust crate has the same envelopes in crates/protocol/src/api.rs.
//
// Rules for all envelopes:
// - Unknown fields are rejected.
// - IDs, keys, roots, and digests are canonical lowercase hex.
// - Proofs, signatures, and RPC bytes are canonical base64.
// - u64 values are decimal strings. Small values (u16, u32) are numbers.
//
// The schemas check the wire text and keep it. Use the decode helpers in this file to get
// bytes and bigints for the signing messages.

import { z } from "zod";
import { decodeFixedHex, MAX_U16, MAX_U32 } from "./bytes.ts";
import { errorCodeSchema } from "./errors.ts";
import { blockTagSchema } from "./issuer-api.ts";
import type { OpenMessage } from "./open.ts";
import { priceTableSchema } from "./price.ts";
import type { StatusMessage } from "./status.ts";
import {
  addressTextSchema,
  base64TextSchema,
  decimalU64TextSchema,
  hex32TextSchema,
  signatureTextSchema,
} from "./wire.ts";

// Response header: units that remain in the session after the request.
export const HEADER_REMAINING = "x-anon-remaining";
// Response header: the next sequence number of the session.
export const HEADER_NEXT_SEQ = "x-anon-next-seq";
// Response header: "true" if the gateway served a stored response without a new charge.
export const HEADER_REPLAYED = "x-anon-replayed";
// All X-Anon-* response headers of POST /v1/rpc.
export const SPEND_RESPONSE_HEADERS: readonly string[] = [HEADER_REMAINING, HEADER_NEXT_SEQ, HEADER_REPLAYED];

const u16Schema = z.number().int().min(0).max(MAX_U16);
const u32Schema = z.number().int().min(0).max(MAX_U32);
const safeChainIdSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

// Path prefix of the chunk route. The full path is
// /v1/open/chunks/{batch_id}/{proof_sha256}/{total_bytes}/{chunk_count}/{chunk_index}.
export const OPEN_CHUNK_PATH_PREFIX = "/v1/open/chunks";
// Largest raw data of one PUT /v1/open/chunks/... chunk: 40,000 bytes. The request body is
// the raw chunk bytes (application/octet-stream), so this is also the body size.
export const OPEN_CHUNK_MAX_BYTES = 40_000;
// Largest PUT /v1/open/chunks/... body. The body is the raw chunk, thus the limit is
// OPEN_CHUNK_MAX_BYTES. The Nox worker refuses requests above about 48,000 bytes; the path and
// the headers use less than 1,000 bytes.
export const OPEN_CHUNK_BODY_LIMIT_BYTES = OPEN_CHUNK_MAX_BYTES;

// Encoding of the proof bytes of a chunked upload.
// "np": binary ProveKit proof. "json": JSON proof as the browser prover emits it.
// "json+gzip": JSON proof in gzip; the gateway decompresses it with a size limit.
export const proofEncodingSchema = z.enum(["np", "json", "json+gzip"]);
export type ProofEncoding = z.output<typeof proofEncodingSchema>;

// Reference to a complete chunked proof upload. proof_sha256 and total_bytes describe the
// uploaded bytes (after the encoding, before decompression).
export const proofUploadSchema = z.strictObject({
  proof_sha256: hex32TextSchema,
  total_bytes: u32Schema,
  proof_encoding: proofEncodingSchema,
});
export type ProofUpload = z.output<typeof proofUploadSchema>;

// Path parameters of PUT /v1/open/chunks/...: the identity of one chunk of a proof upload.
// The request body is the raw chunk bytes (1 to OPEN_CHUNK_MAX_BYTES). The gateway keys an
// upload by (batch_id, proof_sha256). Chunks can arrive in any order. The path has no secret:
// the batch ID and the digest are public to the gateway. The object form is for the shared
// fixtures; the wire form is the path (openChunkPath, parseOpenChunkPath).
export const openChunkPathSchema = z.strictObject({
  batch_id: hex32TextSchema,
  proof_sha256: hex32TextSchema,
  total_bytes: u32Schema,
  chunk_count: u32Schema,
  chunk_index: u32Schema,
});
export type OpenChunkPath = z.output<typeof openChunkPathSchema>;

// A canonical decimal u32: "0", or a digit 1 to 9 and more digits; at most 2^32 - 1.
const decimalU32Pattern = /^(0|[1-9][0-9]{0,9})$/;

// The request path of one chunk.
export function openChunkPath(target: OpenChunkPath): string {
  const checked = openChunkPathSchema.parse(target);
  return `${OPEN_CHUNK_PATH_PREFIX}/${checked.batch_id}/${checked.proof_sha256}/${checked.total_bytes}/${checked.chunk_count}/${checked.chunk_index}`;
}

// Read a full chunk request path (no query, no trailing slash). Return null if it is not valid.
export function parseOpenChunkPath(path: string): OpenChunkPath | null {
  if (!path.startsWith(`${OPEN_CHUNK_PATH_PREFIX}/`)) return null;
  const segments = path.slice(OPEN_CHUNK_PATH_PREFIX.length + 1).split("/");
  const [batchId, proofSha256, totalBytes, chunkCount, chunkIndex] = segments;
  if (segments.length !== 5 || totalBytes === undefined || chunkCount === undefined || chunkIndex === undefined) return null;
  if (![totalBytes, chunkCount, chunkIndex].every((text) => decimalU32Pattern.test(text))) return null;
  const parsed = openChunkPathSchema.safeParse({
    batch_id: batchId,
    proof_sha256: proofSha256,
    total_bytes: Number(totalBytes),
    chunk_count: Number(chunkCount),
    chunk_index: Number(chunkIndex),
  });
  return parsed.success ? parsed.data : null;
}

// PUT /v1/open/chunks/... response body.
export const openChunkResponseSchema = z.strictObject({
  received_chunks: u32Schema,
  complete: z.boolean(),
});
export type OpenChunkResponse = z.output<typeof openChunkResponseSchema>;

const openRequestFields = {
  protocol_version: u16Schema,
  deployment_id: hex32TextSchema,
  gateway_id: hex32TextSchema,
  batch_id: hex32TextSchema,
  root: hex32TextSchema,
  leaf_count: u32Schema,
  proof_epoch: decimalU64TextSchema,
  session_pub: hex32TextSchema,
  price_table_hash: hex32TextSchema,
  signature: signatureTextSchema,
};

// POST /v1/open request body with the inline proof.
export const inlineOpenRequestSchema = z.strictObject({ ...openRequestFields, proof: base64TextSchema });
export type InlineOpenRequest = z.output<typeof inlineOpenRequestSchema>;

// POST /v1/open request body with a reference to a complete chunked upload.
export const uploadOpenRequestSchema = z.strictObject({ ...openRequestFields, proof_upload: proofUploadSchema });
export type UploadOpenRequest = z.output<typeof uploadOpenRequestSchema>;

// POST /v1/open request body: exactly one of proof and proof_upload. The open signature
// does not cover the proof.
export const openRequestSchema = z.union([inlineOpenRequestSchema, uploadOpenRequestSchema]);
export type OpenRequest = z.output<typeof openRequestSchema>;

export const sessionStatusSchema = z.enum(["active", "exhausted", "expired"]);
export type SessionStatus = z.output<typeof sessionStatusSchema>;

// State of one session.
export const sessionStateSchema = z.strictObject({
  batch_id: hex32TextSchema,
  session_pub: hex32TextSchema,
  price_table_hash: hex32TextSchema,
  remaining: u32Schema,
  units_total: decimalU64TextSchema,
  next_seq: decimalU64TextSchema,
  open_epoch: decimalU64TextSchema,
  deadline_epoch: decimalU64TextSchema,
  state: sessionStatusSchema,
});
export type SessionState = z.output<typeof sessionStateSchema>;

// POST /v1/open response body. existing is true for an exact retry of an earlier open.
export const openResponseSchema = z.strictObject({
  session: sessionStateSchema,
  existing: z.boolean(),
});
export type OpenResponse = z.output<typeof openResponseSchema>;

// POST /v1/rpc request body. A successful response body is the raw JSON-RPC response.
export const spendRequestSchema = z.strictObject({
  protocol_version: u16Schema,
  batch_id: hex32TextSchema,
  seq: decimalU64TextSchema,
  units_total: decimalU64TextSchema,
  rpc: base64TextSchema,
  signature: signatureTextSchema,
});
export type SpendRequest = z.output<typeof spendRequestSchema>;

// X-Anon-* headers of a successful POST /v1/rpc response.
export const spendResponseHeadersSchema = z.strictObject({
  remaining: z.string().regex(/^(?:0|[1-9][0-9]{0,9})$/).transform(Number).pipe(u32Schema),
  next_seq: decimalU64TextSchema.transform(BigInt),
  replayed: z.enum(["true", "false"]).transform((text) => text === "true"),
});
export type SpendResponseHeaders = z.output<typeof spendResponseHeadersSchema>;

// Read the X-Anon-* headers of a POST /v1/rpc response. Throw if a header is missing or bad.
export function readSpendResponseHeaders(headers: { get(name: string): string | null }): SpendResponseHeaders {
  return spendResponseHeadersSchema.parse({
    remaining: headers.get(HEADER_REMAINING),
    next_seq: headers.get(HEADER_NEXT_SEQ),
    replayed: headers.get(HEADER_REPLAYED),
  });
}

// Metadata of one committed receipt.
export const receiptMetadataSchema = z.strictObject({
  seq: decimalU64TextSchema,
  request_digest: hex32TextSchema,
  units: u32Schema,
  units_total: decimalU64TextSchema,
  committed_at: decimalU64TextSchema,
  response_retained: z.boolean(),
});
export type ReceiptMetadata = z.output<typeof receiptMetadataSchema>;

// Gateway error body. response_expired errors include the committed receipt.
export const gatewayErrorBodySchema = z.strictObject({
  code: errorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
  receipt: receiptMetadataSchema.optional(),
});
export type GatewayErrorBody = z.output<typeof gatewayErrorBodySchema>;

// POST /v1/session/status request body.
export const statusRequestSchema = z.strictObject({
  protocol_version: u16Schema,
  deployment_id: hex32TextSchema,
  gateway_id: hex32TextSchema,
  batch_id: hex32TextSchema,
  nonce: hex32TextSchema,
  signature: signatureTextSchema,
});
export type StatusRequest = z.output<typeof statusRequestSchema>;

// POST /v1/session/status response body.
export const statusResponseSchema = z.strictObject({
  session: sessionStateSchema,
  current_epoch: decimalU64TextSchema,
  latest_receipt: receiptMetadataSchema.nullable(),
  nonce: hex32TextSchema,
});
export type StatusResponse = z.output<typeof statusResponseSchema>;

// Published resource limits of the gateway.
export const gatewayLimitsSchema = z.strictObject({
  open_body_bytes: u32Schema,
  spend_body_bytes: u32Schema,
  upstream_response_bytes: u32Schema,
  upstream_timeout_ms: u32Schema,
  proof_verify_concurrency: u32Schema,
  proof_queue_depth: u32Schema,
  response_retention_seconds: u32Schema,
  batch_lock_wait_ms: u32Schema,
  open_upload_max_bytes: u32Schema,
  open_upload_chunk_bytes: u32Schema,
  open_upload_chunk_body_bytes: u32Schema,
  open_upload_max_chunks: u32Schema,
  open_upload_ttl_seconds: u32Schema,
  open_upload_max_pending: u32Schema,
  open_upload_max_pending_bytes: u32Schema,
});
export type GatewayLimits = z.output<typeof gatewayLimitsSchema>;

// GET /v1/config response body.
export const gatewayConfigResponseSchema = z.strictObject({
  protocol_version: u16Schema,
  deployment_id: hex32TextSchema,
  gateway_id: hex32TextSchema,
  circuit_id: hex32TextSchema,
  verifier_artifact_hash: hex32TextSchema,
  payment_chain_id: safeChainIdSchema,
  upstream_chain_id: safeChainIdSchema,
  root_registry_address: addressTextSchema,
  epoch_seconds: u32Schema,
  current_epoch: decimalU64TextSchema,
  root_window_epochs: u32Schema,
  session_lifetime_epochs: u32Schema,
  batch_size: u32Schema,
  price_table_hash: hex32TextSchema,
  limits: gatewayLimitsSchema,
  demo_peer_enabled: z.boolean(),
  // Block tag of the root source (BLOCK_TAG). "latest" is for a testnet only.
  block_tag: blockTagSchema,
});
export type GatewayConfigResponse = z.output<typeof gatewayConfigResponseSchema>;

// GET /v1/prices response body. Check price_table_hash with priceTableHash(price_table).
export const pricesResponseSchema = z.strictObject({
  price_table_hash: hex32TextSchema,
  price_table: priceTableSchema,
});
export type PricesResponse = z.output<typeof pricesResponseSchema>;

// One root that the gateway accepts.
export const acceptedRootSchema = z.strictObject({
  source_epoch: decimalU64TextSchema,
  root: hex32TextSchema,
  leaf_count: u32Schema,
});
export type AcceptedRoot = z.output<typeof acceptedRootSchema>;

// GET /v1/roots response body. Roots are newest first.
export const rootsResponseSchema = z.strictObject({
  current_epoch: decimalU64TextSchema,
  root_window_epochs: u32Schema,
  roots: z.array(acceptedRootSchema),
});
export type RootsResponse = z.output<typeof rootsResponseSchema>;

export const ipAttributionSchema = z.enum(["socket", "trusted_proxy", "unavailable"]);
export type IpAttribution = z.output<typeof ipAttributionSchema>;

// GET /v1/demo/peer response body. Only the demo profile has this endpoint.
export const demoPeerResponseSchema = z.strictObject({
  observed_ip: z.string(),
  attribution: ipAttributionSchema,
  proxy_hop: z.string().nullable(),
});
export type DemoPeerResponse = z.output<typeof demoPeerResponseSchema>;

// The signing message of an open request.
export function openMessageFromRequest(request: OpenRequest): OpenMessage {
  return {
    deploymentId: decodeFixedHex(request.deployment_id, 32),
    gatewayId: decodeFixedHex(request.gateway_id, 32),
    batchId: decodeFixedHex(request.batch_id, 32),
    root: decodeFixedHex(request.root, 32),
    leafCount: request.leaf_count,
    proofEpoch: BigInt(request.proof_epoch),
    sessionPub: decodeFixedHex(request.session_pub, 32),
    priceTableHash: decodeFixedHex(request.price_table_hash, 32),
  };
}

// The signing message of a status request.
export function statusMessageFromRequest(request: StatusRequest): StatusMessage {
  return {
    deploymentId: decodeFixedHex(request.deployment_id, 32),
    gatewayId: decodeFixedHex(request.gateway_id, 32),
    batchId: decodeFixedHex(request.batch_id, 32),
    nonce: decodeFixedHex(request.nonce, 32),
  };
}

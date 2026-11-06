// Runtime schemas of the gateway admin API (implementation.md sections 10 and 14).
// The Rust crate has the same envelopes in crates/protocol/src/admin.rs.
// Optional values are null; they are never omitted. u64 values are decimal strings.
// Events and snapshots have no keys, proofs, tokens, RPC parameters, or RPC results.

import { z } from "zod";
import { MAX_U32 } from "./bytes.ts";
import { errorCodeSchema } from "./errors.ts";
import { acceptedRootSchema, ipAttributionSchema, receiptMetadataSchema, sessionStateSchema } from "./gateway-api.ts";
import { priceTableSchema } from "./price.ts";
import { decimalU64TextSchema, hex32TextSchema } from "./wire.ts";

// Value of the observed IP field when IP capture is off.
export const IP_UNAVAILABLE = "unavailable";

const u32Schema = z.number().int().min(0).max(MAX_U32);

export const eventKindSchema = z.enum([
  "open_received",
  "open_verified",
  "open_rejected",
  "session_opened",
  "rpc_received",
  "rpc_completed",
  "rpc_replayed",
  "rpc_rejected",
  "upstream_failed",
  "storage_failed",
]);
export type EventKind = z.output<typeof eventKindSchema>;

// One diagnostic event. id is also the Server-Sent Events id.
export const gatewayEventSchema = z.strictObject({
  id: decimalU64TextSchema,
  at_ms: decimalU64TextSchema,
  kind: eventKindSchema,
  batch_id: hex32TextSchema.nullable(),
  seq: decimalU64TextSchema.nullable(),
  method: z.string().nullable(),
  error_code: errorCodeSchema.nullable(),
  latency_ms: u32Schema.nullable(),
  units: u32Schema.nullable(),
  remaining: u32Schema.nullable(),
  request_bytes: u32Schema.nullable(),
  response_bytes: u32Schema.nullable(),
  observed_ip: z.string(),
  ip_attribution: ipAttributionSchema,
  proxy_hop: z.string().nullable(),
});
export type GatewayEvent = z.output<typeof gatewayEventSchema>;

export const eventCountersSchema = z.strictObject({
  open_received: decimalU64TextSchema,
  open_rejected: decimalU64TextSchema,
  sessions_opened: decimalU64TextSchema,
  rpc_received: decimalU64TextSchema,
  rpc_completed: decimalU64TextSchema,
  rpc_replayed: decimalU64TextSchema,
  rpc_rejected: decimalU64TextSchema,
  upstream_failed: decimalU64TextSchema,
  storage_failed: decimalU64TextSchema,
  units_charged: decimalU64TextSchema,
});
export type EventCounters = z.output<typeof eventCountersSchema>;

export const rootStatusSchema = z.strictObject({
  accepted: u32Schema,
  latest_source_epoch: decimalU64TextSchema.nullable(),
  latest_age_epochs: decimalU64TextSchema.nullable(),
  last_refresh_at: decimalU64TextSchema.nullable(),
  last_error: z.string().nullable(),
});

export const verifierStatusSchema = z.strictObject({
  pkv_sha256: z.string(),
  circuit_id: z.string(),
  witness_mode: z.string(),
});

export const sessionTotalsSchema = z.strictObject({
  active: decimalU64TextSchema,
  exhausted: decimalU64TextSchema,
  expired: decimalU64TextSchema,
  units_charged: decimalU64TextSchema,
});

export const sessionSummarySchema = z.strictObject({
  session: sessionStateSchema,
  opened_at: decimalU64TextSchema,
  proof_size: u32Schema,
  verify_ms: u32Schema,
});
export type SessionSummary = z.output<typeof sessionSummarySchema>;

// GET /admin/v1/snapshot response body.
export const adminSnapshotSchema = z.strictObject({
  status: z.string(),
  started_at: decimalU64TextSchema,
  now: decimalU64TextSchema,
  current_epoch: decimalU64TextSchema,
  deployment_id: hex32TextSchema,
  gateway_id: hex32TextSchema,
  upstream_chain_id: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  // Epoch length in seconds (deployment value). Epoch e starts at e * epoch_seconds.
  epoch_seconds: z.number().int().min(1).max(MAX_U32),
  circuit_id: hex32TextSchema,
  // SHA-256 of the verifier key that the deployment pins.
  verifier_artifact_hash: hex32TextSchema,
  demo_ip_logging: z.boolean(),
  verifier: verifierStatusSchema,
  // keccak256 of the canonical encoding of price_table. Check it with priceTableHash.
  price_table_hash: hex32TextSchema,
  price_table: priceTableSchema,
  roots: rootStatusSchema,
  root_window_epochs: u32Schema,
  // Accepted roots, newest first. The same list as GET /v1/roots.
  accepted_roots: z.array(acceptedRootSchema),
  counters: eventCountersSchema,
  sessions: sessionTotalsSchema,
  recent_events: z.array(gatewayEventSchema),
  recent_sessions: z.array(sessionSummarySchema),
});
export type AdminSnapshot = z.output<typeof adminSnapshotSchema>;

// GET /admin/v1/sessions/{batch_id} response body.
export const sessionDetailSchema = z.strictObject({
  summary: sessionSummarySchema,
  receipts: z.array(z.strictObject({ receipt: receiptMetadataSchema, method: z.string() })),
});
export type SessionDetail = z.output<typeof sessionDetailSchema>;

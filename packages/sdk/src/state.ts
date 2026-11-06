// Stored client state. All records are in the encrypted store.
//
// Keys:
// - "deployment": the deployment identity of the client (one per store).
// - "batch/<batch_id>": one batch: secret, session key, leaf metadata, open request, session
//   state, and the pending signed spend request (the request journal).
//
// The batch record is written before each transmission that changes it, so a restarted client
// resumes the pending request with the same bytes and the same signature.

import {
  addressTextSchema,
  base64TextSchema,
  decimalU64TextSchema,
  fieldHexTextSchema,
  hex32TextSchema,
  openRequestSchema,
  priceTableSchema,
  sessionStatusSchema,
  signatureTextSchema,
} from "@anon-credit/protocol";
import { z } from "zod";

export const DEPLOYMENT_KEY = "deployment";
export const BATCH_PREFIX = "batch/";

export function batchKey(batchId: string): string {
  return `${BATCH_PREFIX}${batchId}`;
}

// The identity that the client checked at setup. A store belongs to one deployment.
export const deploymentRecordSchema = z.strictObject({
  deployment_id: hex32TextSchema,
  gateway_id: hex32TextSchema,
  circuit_id: hex32TextSchema,
  prover_manifest_hash: hex32TextSchema,
  verifier_artifact_hash: hex32TextSchema,
  payment_chain_id: z.number().int().positive(),
  sale_address: addressTextSchema,
  root_registry_address: addressTextSchema,
  epoch_seconds: z.number().int().positive(),
  batch_size: z.number().int().positive(),
});
export type DeploymentRecord = z.output<typeof deploymentRecordSchema>;

// Leaf metadata from the issuer.
export const leafRecordSchema = z.strictObject({
  leaf_index: z.number().int().nonnegative(),
  leaf: fieldHexTextSchema,
  insertion_epoch: decimalU64TextSchema,
  eligible_epoch: decimalU64TextSchema,
  expiry: decimalU64TextSchema,
});
export type LeafRecord = z.output<typeof leafRecordSchema>;

// Session state after open. The price table is frozen at open.
export const sessionRecordSchema = z.strictObject({
  remaining: z.number().int().nonnegative(),
  units_total: decimalU64TextSchema,
  next_seq: decimalU64TextSchema,
  state: sessionStatusSchema,
  open_epoch: decimalU64TextSchema,
  deadline_epoch: decimalU64TextSchema,
  price_table_hash: hex32TextSchema,
  price_table: priceTableSchema,
});
export type SessionRecord = z.output<typeof sessionRecordSchema>;

// A signed spend request that waits for an answer. It is written before transmission.
export const pendingSpendSchema = z.strictObject({
  seq: decimalU64TextSchema,
  units_total: decimalU64TextSchema,
  units: z.number().int().positive(),
  method: z.string(),
  rpc: base64TextSchema,
  signature: signatureTextSchema,
});
export type PendingSpend = z.output<typeof pendingSpendSchema>;

export const batchRecordSchema = z.strictObject({
  // Creation order in this store. The client uses batches in this order.
  order: z.number().int().nonnegative(),
  batch_id: fieldHexTextSchema,
  commitment: fieldHexTextSchema,
  // Batch secret k. Secret.
  k: hex32TextSchema,
  // Ed25519 session secret key. Secret.
  session_secret: hex32TextSchema,
  session_pub: hex32TextSchema,
  // Random first-use delay in epochs (0 to 3), chosen once.
  delay_epochs: z.number().int().min(0).max(3),
  leaf: leafRecordSchema.nullable(),
  open_request: openRequestSchema.nullable(),
  session: sessionRecordSchema.nullable(),
  pending: pendingSpendSchema.nullable(),
  // true after the application rotated away from this batch.
  retired: z.boolean(),
});
export type BatchRecord = z.output<typeof batchRecordSchema>;

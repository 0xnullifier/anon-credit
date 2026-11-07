// Runtime schemas of the issuer HTTP API (implementation.md section 10, FUTURE.md C6).
// The Rust crate has the same envelopes in crates/protocol/src/issuer_api.rs.
// fixtures/protocol/issuer-api.json has shared examples. Both test suites parse them.
//
// Rules for all envelopes:
// - Unknown fields are rejected.
// - Hashes and IDs are canonical lowercase hex.
// - Field values (commitments, leaves, roots, siblings, peaks) are canonical field elements:
//   "0x" and 64 lowercase hex digits, less than the BN254 scalar field modulus.
// - u64 values (epochs, block numbers, wei amounts) are decimal strings. u32 values are numbers.
// - A field without a value is null. It is never left out.
//
// The schemas check the wire text and keep it. The membership proof has the same JSON form as
// membershipProofSchema in @anon-credit/crypto, which converts it to bigints for verification.

import { z } from "zod";
import { MAX_U32 } from "./bytes.ts";
import { type DeploymentConfig, deploymentConfigSchema } from "./deployment.ts";
import { errorBodySchema } from "./errors.ts";
import { PROTOCOL_VERSION } from "./version.ts";
import { addressTextSchema, decimalU64TextSchema, hex32TextSchema } from "./wire.ts";

// Path prefix of all issuer endpoints.
export const ISSUER_API_PREFIX = "/v1";
// Largest number of batches in one purchase. CreditSale has the same limit.
export const MAX_BATCHES_PER_PURCHASE = 100;
// Largest page size of GET /v1/roots and the event endpoints.
export const MAX_PAGE_LIMIT = 1000;
// BN254 scalar field modulus.
export const BN254_FIELD_MODULUS = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;
// Largest number of siblings or peaks in a proof (heights 0..31).
const MAX_PROOF_ITEMS = 32;

const u32Schema = z.number().int().min(0).max(MAX_U32);
const positiveU32Schema = z.number().int().min(1).max(MAX_U32);
const safeChainIdSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

// Schema: a canonical field element as hex text. The text is kept.
export const fieldHexTextSchema = hex32TextSchema.refine(
  (text) => BigInt(text) < BN254_FIELD_MODULUS,
  "value is not less than the BN254 scalar field modulus",
);

// The deployment configuration as wire text. deploymentConfigSchema decodes the same JSON
// into bytes; see deploymentFromIssuerConfig.
export const deploymentConfigTextSchema = z.strictObject({
  protocol_version: z.literal(PROTOCOL_VERSION),
  payment_chain_id: safeChainIdSchema,
  sale_address: addressTextSchema,
  root_registry_address: addressTextSchema,
  issuer_address: addressTextSchema,
  gateway_id: hex32TextSchema,
  batch_size: positiveU32Schema,
  epoch_seconds: positiveU32Schema,
  credit_lifetime_epochs: positiveU32Schema,
  circuit_id: hex32TextSchema,
  verifier_artifact_hash: hex32TextSchema,
  prover_manifest_hash: hex32TextSchema,
});

// Block tag at which the services read the chain (BLOCK_TAG). Production: "finalized".
// "latest" trades reorg safety for speed: testnet only.
export const blockTagSchema = z.enum(["finalized", "safe", "latest"]);
export type BlockTag = z.output<typeof blockTagSchema>;

// GET /v1/config response body.
export const issuerConfigResponseSchema = z.strictObject({
  deployment: deploymentConfigTextSchema,
  deployment_id: hex32TextSchema,
  batch_price_wei: decimalU64TextSchema,
  max_batches_per_purchase: u32Schema,
  root_window_epochs: u32Schema,
  // A payment or a root publication at or below the block of this tag counts as final.
  block_tag: blockTagSchema,
});
export type IssuerConfigResponse = z.output<typeof issuerConfigResponseSchema>;

// Decode the deployment of a config response into bytes, for deploymentId().
export function deploymentFromIssuerConfig(config: IssuerConfigResponse): DeploymentConfig {
  return deploymentConfigSchema.parse(config.deployment);
}

// POST /v1/topups request body. The issuer reads the log from the chain; it never mints from
// values that the client sends.
export const topupRequestSchema = z.strictObject({
  tx_hash: hex32TextSchema,
  log_index: u32Schema,
});
export type TopupRequest = z.output<typeof topupRequestSchema>;

export const topupStatusSchema = z.enum(["pending", "issued", "rejected"]);
export type TopupStatus = z.output<typeof topupStatusSchema>;

// awaiting_receipt: the RPC has no receipt yet.
// awaiting_finality: the log block is after the finalized block (about 13 minutes on Sepolia).
// finality_unavailable: the RPC gives no finalized block; the issuer waits.
// chain_unavailable: the RPC request failed; the issuer tries again.
export const pendingReasonSchema = z.enum([
  "awaiting_receipt",
  "awaiting_finality",
  "finality_unavailable",
  "chain_unavailable",
]);
export type PendingReason = z.output<typeof pendingReasonSchema>;

export const rejectReasonSchema = z.enum(["reverted", "log_not_found", "not_a_purchase", "malformed_purchase"]);
export type RejectReason = z.output<typeof rejectReasonSchema>;

// One leaf of an issuance. leaf = H(DOM_LEAF, commitment, K, expiry).
export const issuedLeafSchema = z.strictObject({
  leaf_index: u32Schema,
  commitment: fieldHexTextSchema,
  leaf: fieldHexTextSchema,
});
export type IssuedLeaf = z.output<typeof issuedLeafSchema>;

// The result of one issued payment. The issuer sets insertion_epoch and expiry.
export const issuanceSchema = z.strictObject({
  purchase_id: decimalU64TextSchema,
  payer: addressTextSchema,
  amount_wei: decimalU64TextSchema,
  block_number: decimalU64TextSchema,
  insertion_epoch: decimalU64TextSchema,
  eligible_epoch: decimalU64TextSchema,
  expiry: decimalU64TextSchema,
  leaves: z.array(issuedLeafSchema).min(1).max(MAX_BATCHES_PER_PURCHASE),
});
export type Issuance = z.output<typeof issuanceSchema>;

// POST /v1/topups and GET /v1/topups/:tx_hash/:log_index response body.
export const topupResponseSchema = z.strictObject({
  chain_id: safeChainIdSchema,
  tx_hash: hex32TextSchema,
  log_index: u32Schema,
  status: topupStatusSchema,
  pending_reason: pendingReasonSchema.nullable(),
  reject_reason: rejectReasonSchema.nullable(),
  block_number: decimalU64TextSchema.nullable(),
  finalized_block: decimalU64TextSchema.nullable(),
  issuance: issuanceSchema.nullable(),
});
export type TopupResponse = z.output<typeof topupResponseSchema>;

// pending: snapshot recorded, no transaction. submitted: signed and sent, no receipt.
// included: successful receipt, block not finalized. finalized: the gateway can accept the root.
// skipped: a newer epoch replaced it. failed: reverted or dropped.
export const publicationStatusSchema = z.enum(["pending", "submitted", "included", "finalized", "skipped", "failed"]);
export type PublicationStatus = z.output<typeof publicationStatusSchema>;

export const issuerRootRecordSchema = z.strictObject({
  epoch: decimalU64TextSchema,
  leaf_count: u32Schema,
  root: fieldHexTextSchema,
  status: publicationStatusSchema,
  tx_hash: hex32TextSchema.nullable(),
  block_number: decimalU64TextSchema.nullable(),
});
export type IssuerRootRecord = z.output<typeof issuerRootRecordSchema>;

// GET /v1/roots response body. Records are in ascending epoch order.
export const issuerRootsResponseSchema = z.strictObject({
  current_epoch: decimalU64TextSchema,
  finalized_block: decimalU64TextSchema.nullable(),
  roots: z.array(issuerRootRecordSchema),
});
export type IssuerRootsResponse = z.output<typeof issuerRootsResponseSchema>;

// Complete MMR membership proof (the JSON form of the Rust registry and @anon-credit/crypto).
export const membershipProofTextSchema = z.strictObject({
  leaf_index: u32Schema,
  leaf_count: u32Schema,
  peak_position: u32Schema,
  siblings: z.array(fieldHexTextSchema).max(MAX_PROOF_ITEMS),
  peaks: z.array(fieldHexTextSchema).max(MAX_PROOF_ITEMS),
});
export type MembershipProofText = z.output<typeof membershipProofTextSchema>;

// GET /v1/tree/path/:leaf_index?root=... response body.
export const treePathResponseSchema = z.strictObject({
  root: fieldHexTextSchema,
  epoch: decimalU64TextSchema,
  leaf: fieldHexTextSchema,
  proof: membershipProofTextSchema,
});
export type TreePathResponse = z.output<typeof treePathResponseSchema>;

// GET /v1/epoch response body.
export const epochResponseSchema = z.strictObject({
  epoch: decimalU64TextSchema,
  epoch_seconds: positiveU32Schema,
  now: decimalU64TextSchema,
  seconds_until_next: positiveU32Schema,
});
export type EpochResponse = z.output<typeof epochResponseSchema>;

// LeafAppended(index, leaf).
export const leafAppendedEventSchema = z.strictObject({
  index: u32Schema,
  leaf: fieldHexTextSchema,
});
export type LeafAppendedEvent = z.output<typeof leafAppendedEventSchema>;

// GET /v1/events/leaves?from=N&limit=L response body.
export const leafEventsResponseSchema = z.strictObject({
  leaf_count: u32Schema,
  events: z.array(leafAppendedEventSchema).max(MAX_PAGE_LIMIT),
});
export type LeafEventsResponse = z.output<typeof leafEventsResponseSchema>;

// RootUpdated(index, root). index is the source epoch. Only roots with a successful postRoot
// transaction have an event.
export const rootUpdatedEventSchema = z.strictObject({
  index: decimalU64TextSchema,
  root: fieldHexTextSchema,
  leaf_count: u32Schema,
  tx_hash: hex32TextSchema,
  block_number: decimalU64TextSchema,
  finalized: z.boolean(),
});
export type RootUpdatedEvent = z.output<typeof rootUpdatedEventSchema>;

// GET /v1/events/roots?from=E&limit=L response body.
export const rootEventsResponseSchema = z.strictObject({
  events: z.array(rootUpdatedEventSchema).max(MAX_PAGE_LIMIT),
});
export type RootEventsResponse = z.output<typeof rootEventsResponseSchema>;

// Error body of the issuer: the shared ErrorBody.
export const issuerErrorBodySchema = errorBodySchema;

// Paths of the issuer endpoints. The caller adds the base URL.
export const issuerPaths = {
  config: (): string => `${ISSUER_API_PREFIX}/config`,
  topups: (): string => `${ISSUER_API_PREFIX}/topups`,
  topup: (txHash: string, logIndex: number): string =>
    `${ISSUER_API_PREFIX}/topups/${hex32TextSchema.parse(txHash)}/${u32Schema.parse(logIndex)}`,
  roots: (): string => `${ISSUER_API_PREFIX}/roots`,
  treePath: (leafIndex: number, root: string): string =>
    `${ISSUER_API_PREFIX}/tree/path/${u32Schema.parse(leafIndex)}?root=${fieldHexTextSchema.parse(root)}`,
  epoch: (): string => `${ISSUER_API_PREFIX}/epoch`,
  leafEvents: (from: number, limit: number): string =>
    `${ISSUER_API_PREFIX}/events/leaves?from=${u32Schema.parse(from)}&limit=${positiveU32Schema.parse(limit)}`,
  rootEvents: (from: string, limit: number): string =>
    `${ISSUER_API_PREFIX}/events/roots?from=${decimalU64TextSchema.parse(from)}&limit=${positiveU32Schema.parse(limit)}`,
};

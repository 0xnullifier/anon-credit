// Client SDK (browser side). Purchase coordination for the Node runner is in
// "@anon-credit/sdk/purchase".
//
// - Batch lifecycle: random batch secrets, commitments, batch IDs, and one Ed25519 session key
//   per batch. Secrets stay in the browser.
// - Persistent state in encrypted IndexedDB (AES-GCM, PBKDF2 key from a passphrase), a request
//   journal written before each transmission, and a backup string.
// - Registry client with local membership proof checks.
// - Open: eligible root, first-use delay, circuit inputs, proof, signed open request.
// - Spend: exact JSON-RPC bytes, frozen prices, cumulative units, signed requests, retries
//   with the same bytes, and status recovery.
//
// The SDK sends only the required protocol headers to the gateway. It never sends payer
// identity, cookies, or purchase correlation IDs.

export { PROTOCOL_VERSION } from "@anon-credit/protocol";
export { BACKUP_PREFIX, backupSchema, decodeBackup, encodeBackup, type Backup } from "./backup.ts";
export { createClient, importBackup, type BatchSummary, type Client, type ClientConfig, type OpenOutcome } from "./client.ts";
export { LostResultError, SdkError, ServiceError, sdkErrorCodeSchema, type SdkErrorCode } from "./errors.ts";
export { buildStatusRequest, gatewayClient, type GatewayClient } from "./gateway.ts";
export {
  BATCH_SECRET_BYTES,
  batchValues,
  createBatchSecret,
  createSessionKey,
  sessionKeyFromSecret,
  signDigest,
  type BatchValues,
  type SessionKey,
} from "./keys.ts";
export {
  openEpoch,
  prepareOpen,
  selectRoot,
  submitOpen,
  useChunkedUpload,
  waitForEligibleRoot,
  type OpenContext,
  type OpenProgress,
  type PreparedOpen,
  type ProverLike,
  type SelectedRoot,
  type SubmitOpenOptions,
  type SubmitOpenResult,
} from "./open.ts";
export { epochAt, systemClock, webCryptoRandom, type Clock, type RandomSource } from "./random.ts";
export { CONFIG_ISOLATION_KEY, expectedLeaf, registryClient, registryIsolationKey, verifyPath, type RegistryClient } from "./registry.ts";
export { DEFAULT_RETRY, Session, type RawSpendResult, type RetryPolicy, type RpcOptions, type RpcOutcome } from "./session.ts";
export {
  buildSpendRequest,
  encodeRpcRequest,
  jsonRpcResponseSchema,
  signSpend,
  unitsOf,
  type JsonRpcResponse,
  type JsonValue,
  type SpendIdentity,
} from "./spend.ts";
export {
  batchRecordSchema,
  deploymentRecordSchema,
  pendingSpendSchema,
  sessionRecordSchema,
  type BatchRecord,
  type DeploymentRecord,
  type PendingSpend,
  type SessionRecord,
} from "./state.ts";
export {
  DEFAULT_UPLOAD_POLICY,
  encodeProof,
  planUpload,
  sendChunks,
  uploadChunkBytes,
  type EncodedProof,
  type OpenChunk,
  type OpenUploadMode,
  type UploadDeps,
  type UploadPlan,
  type UploadPolicy,
  type UploadStats,
} from "./upload.ts";
export {
  DEFAULT_KDF_ITERATIONS,
  indexedDbStorage,
  memoryStorage,
  openEncryptedStore,
  type EncryptedStore,
  type IndexedDbOptions,
  type StorageAdapter,
} from "./storage.ts";

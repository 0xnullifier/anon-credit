// ProveKit browser adapter.
//
// - Loads the pinned ProveKit WASM build (scalar or threaded) and the prover key. Every
//   artifact comes from a manifest whose SHA-256 digest the client pins. Each artifact has
//   a pinned size and digest. No artifact is used before its check passes.
// - Runs Noir witness generation and ProveKit proving in a dedicated Web Worker.
// - Returns the proof bytes with timing and WASM memory measurements.
//
// Keep this interface separate from batch storage and request signing.
// Do not use a remote prover. Do not turn off hiding mode: the manifest accepts only
// the "zk" witness mode, and the Rust verifier rejects a non-hiding verifier key.

export { fetchBytes, fetchVerified, type FetchFunction } from "./artifacts.ts";
export { createBatchOpenProver, type BatchOpenProver, type ProverOptions, type WorkerLike } from "./client.ts";
export { sha256Hex, sha256HexSchema } from "./digest.ts";
export { ProverError, proverErrorCodeSchema, type ProverErrorCode } from "./errors.ts";
export { inputMapSchema, inputValueSchema, parseCircuit } from "./inputs.ts";
export {
  MANIFEST_FORMAT,
  fileEntrySchema,
  loadManifest,
  parseManifest,
  proverManifestSchema,
  type FileEntry,
  type ProverManifest,
} from "./manifest.ts";
export {
  proofResultSchema,
  proverInfoSchema,
  threadModeSchema,
  workerRequestSchema,
  workerResponseSchema,
  type ProofResult,
  type ProverInfo,
  type ThreadMode,
  type WorkerRequest,
  type WorkerResponse,
} from "./messages.ts";

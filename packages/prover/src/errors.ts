// Typed errors of the prover adapter.
// Callers must branch on the code. They must not branch on the message text.

import { z } from "zod";

export const proverErrorCodeSchema = z.enum([
  // The manifest bytes do not have the pinned digest, or the manifest is not valid.
  "manifest_invalid",
  // An artifact request failed.
  "artifact_fetch_failed",
  // An artifact does not have the size or the digest in the manifest.
  "artifact_digest_mismatch",
  // The WASM module or its JavaScript glue is not valid.
  "wasm_invalid",
  // The threaded build needs cross-origin isolation and SharedArrayBuffer.
  "threads_unavailable",
  // The circuit inputs do not satisfy the circuit.
  "witness_failed",
  // The ProveKit prover failed.
  "proving_failed",
  // The worker stopped or sent a message that is not valid.
  "worker_failed",
  // The prover was disposed.
  "disposed",
]);

export type ProverErrorCode = z.infer<typeof proverErrorCodeSchema>;

export class ProverError extends Error {
  readonly code: ProverErrorCode;

  constructor(code: ProverErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProverError";
    this.code = code;
  }
}

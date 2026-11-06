// ProveKit browser adapter.
//
// Phase 1 adds these parts here:
// - A loader for the pinned ProveKit WASM build (threaded and scalar).
// - A dedicated worker that runs the prover.
// - Artifact loading with a check against the pinned prover manifest digest.
// - Timing and memory measurements.
//
// Keep this interface separate from batch storage and request signing.
// Do not use a remote prover. Do not turn off hiding mode.

// Result of one batch-open proof.
export interface ProofResult {
  // Serialized native ProveKit proof.
  readonly proof: Uint8Array;
  // Proof generation time in milliseconds.
  readonly durationMs: number;
}

// The batch-open prover. Phase 1 defines the witness and public-input types.
export interface BatchOpenProver {
  readonly prove: (witness: Uint8Array) => Promise<ProofResult>;
}

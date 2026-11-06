// WASM interface to the shared Rust hash and MMR operations.
//
// Phase 1 adds the Poseidon2 hash after the parameters are pinned.
// Phase 2 adds MMR path checks from crates/registry.
// Both come from the Rust code compiled to WASM. Do not write a second implementation here.

// Operations that the WASM module will provide.
export interface CryptoBackend {
  // Poseidon2 hash with a domain tag. Phase 1 fixes the input and output encoding.
  readonly poseidon2: (domain: Uint8Array, inputs: readonly Uint8Array[]) => Uint8Array;
  // Check a complete MMR membership proof against a root. Phase 2 fixes the proof format.
  readonly verifyMembership: (root: Uint8Array, leaf: Uint8Array, proof: Uint8Array) => boolean;
}

// Status of this package. Later phases replace it with the real backend loader.
export const CRYPTO_BACKEND_STATUS = "not-implemented";

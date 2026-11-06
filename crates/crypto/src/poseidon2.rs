//! Poseidon2 circuit hash. Not implemented.
//!
//! TODO(phase 1): Implement Poseidon2 for the circuit, the registry, and the SDK.
//!
//! Phase 1 must pin these values first:
//!
//! - The field. Use the field of the selected Noir and ProveKit stack.
//! - The permutation width, round counts, and round constants.
//! - The sponge or compression rules and the output width.
//! - The byte-to-field input encoding. Encode each 32-byte value as two bounded
//!   128-bit limbs. Do not reduce arbitrary bytes modulo the field.
//! - The domain-tag encoding for `c`, `leaf`, `id`, MMR nodes, and the session binding.
//!
//! Write these values into the protocol manifest and the shared vectors in
//! `fixtures/protocol/`. Rust, WASM, and Noir must match the same vectors.
//! Do not invent constants separately in each language.

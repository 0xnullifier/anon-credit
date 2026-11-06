//! Shared cryptographic primitives for anon-credit.
//!
//! This crate has no wire-protocol knowledge. It has the circuit hash and its encodings.
//!
//! Contents:
//!
//! - [`keccak256`]: Keccak-256 (Ethereum variant, not NIST SHA3-256).
//! - [`verify_ed25519`]: strict Ed25519 signature verification.
//! - [`field`]: BN254 scalar field elements, the canonical 32-byte encoding, and 128-bit limbs.
//! - [`poseidon2`]: the Poseidon2 hash that the Noir circuit uses.
//! - [`constants`]: domain tags and circuit constants. Generated from `fixtures/protocol/`.
//! - [`batch`]: the commitment, leaf, batch ID, and session binding constructions.
//! - [`mmr_hash`]: MMR leaf-node, internal-node, and root hash rules.
//! - [`public_inputs`]: the public-input vector of the batch-open circuit.

pub mod batch;
#[rustfmt::skip]
pub mod constants;
pub mod ed25519;
pub mod field;
pub mod keccak;
pub mod mmr_hash;
pub mod poseidon2;
pub mod public_inputs;

pub use ed25519::{ED25519_PUBLIC_KEY_LEN, ED25519_SIGNATURE_LEN, Ed25519Error, verify_ed25519};
pub use field::{FIELD_BYTES, FieldElement, FieldError, bytes32_to_limbs};
pub use keccak::{KECCAK256_LEN, keccak256};
pub use public_inputs::{BatchOpenPublicInputs, PUBLIC_INPUT_COUNT};

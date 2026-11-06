//! ProveKit verifier adapter.
//!
//! This crate verifies native ProveKit proofs (Spartan with WHIR commitments).
//! It has these parts:
//!
//! - [`Sha256Digest`]: a pinned artifact digest.
//! - [`PinnedVerifier`]: a verifier key (`.pkv`) that is loaded only if its SHA-256 digest
//!   is equal to the pinned digest. The load also rejects a key that does not use a hiding
//!   (zero-knowledge) witness commitment.
//! - [`Proof`]: a decoded proof. It accepts the JSON encoding from the browser WASM prover
//!   and the binary `.np` encoding from the native CLI.
//! - [`PublicInput`]: one canonical BN254 field element.
//!
//! The gateway must make the expected public inputs from its own values. Do not read the
//! expected public inputs from the request.
//!
//! Do not add a Groth16 wrapper. Do not add a remote prover.

mod digest;
mod error;
mod proof;
mod public_input;
mod verifier;

pub use digest::Sha256Digest;
pub use error::{DecodeError, LoadError, PublicInputError, VerifyError};
pub use proof::{DEFAULT_MAX_PROOF_BYTES, Proof, ProofEncoding};
pub use public_input::PublicInput;
pub use verifier::{PinnedVerifier, Verified, VerifierInfo};

/// The ProveKit commit that this crate links. Artifacts must come from the same commit.
pub const PROVEKIT_REV: &str = "201b7b639f5dd5632c01561fcb2a96c2fc8851f3";

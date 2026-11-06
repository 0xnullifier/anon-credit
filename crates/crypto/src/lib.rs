//! Shared cryptographic primitives for anon-credit.
//!
//! This crate has no protocol knowledge. Callers supply domain tags and message layouts.
//!
//! Contents:
//!
//! - [`keccak256`]: Keccak-256 (Ethereum variant, not NIST SHA3-256).
//! - [`verify_ed25519`]: strict Ed25519 signature verification.
//! - [`poseidon2`]: placeholder for the circuit hash. Phase 1 sets its parameters.

pub mod ed25519;
pub mod keccak;
pub mod poseidon2;

pub use ed25519::{ED25519_PUBLIC_KEY_LEN, ED25519_SIGNATURE_LEN, Ed25519Error, verify_ed25519};
pub use keccak::{KECCAK256_LEN, keccak256};

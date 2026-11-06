//! Error types.

use std::path::PathBuf;

use thiserror::Error;

use crate::digest::Sha256Digest;

/// An error when the verifier key is loaded.
#[derive(Debug, Error)]
pub enum LoadError {
    /// The digest text is not 64 lowercase hex digits.
    #[error("digest must be 64 lowercase hex digits")]
    DigestFormat,
    /// The verifier key file cannot be read.
    #[error("cannot read verifier key {path}: {source}")]
    Io {
        /// The path of the file.
        path: PathBuf,
        /// The I/O error.
        source: std::io::Error,
    },
    /// The SHA-256 digest of the verifier key is not the pinned digest.
    /// The key is not parsed.
    #[error("verifier key digest mismatch: expected {expected}, found {actual}")]
    DigestMismatch {
        /// The pinned digest.
        expected: Sha256Digest,
        /// The digest of the bytes that were read.
        actual: Sha256Digest,
    },
    /// The bytes are not a valid ProveKit verifier key for the pinned ProveKit commit.
    #[error("invalid verifier key: {0}")]
    Format(String),
    /// The verifier key has no WHIR scheme.
    #[error("verifier key has no WHIR scheme")]
    MissingScheme,
    /// The verifier key does not use a hiding witness commitment.
    #[error("verifier key does not use a hiding (zero-knowledge) witness commitment")]
    NotHiding,
}

/// An error when proof bytes are decoded.
#[derive(Debug, Error)]
pub enum DecodeError {
    /// The proof is larger than the limit.
    #[error("proof has {actual} bytes, the limit is {limit}")]
    TooLarge {
        /// The size of the proof.
        actual: usize,
        /// The limit.
        limit: usize,
    },
    /// The proof bytes are not a valid JSON proof.
    #[error("invalid JSON proof: {0}")]
    Json(String),
    /// The proof bytes are not a valid binary `.np` proof.
    #[error("invalid binary proof: {0}")]
    Binary(String),
}

/// An error when a public input is parsed.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum PublicInputError {
    /// The text is not `0x` and 1 to 64 lowercase hex digits.
    #[error("public input must be 0x and 1 to 64 lowercase hex digits")]
    Format,
    /// The value is not less than the BN254 scalar field modulus.
    #[error("public input is not a canonical BN254 field element")]
    OutOfRange,
}

/// An error when a proof is verified.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum VerifyError {
    /// The number of public inputs is not the number that the circuit has.
    #[error("expected {expected} public inputs, the proof has {actual}")]
    PublicInputCount {
        /// The number of expected public inputs.
        expected: usize,
        /// The number of public inputs in the proof.
        actual: usize,
    },
    /// The circuit has a different number of public inputs than the caller expects.
    #[error("the circuit has {circuit} public inputs, the caller gave {given}")]
    CircuitPublicInputCount {
        /// The number of public inputs in the circuit.
        circuit: usize,
        /// The number of public inputs that the caller gave.
        given: usize,
    },
    /// A public input in the proof is not equal to the expected value.
    #[error("public input {index} is not the expected value")]
    PublicInputMismatch {
        /// The index of the first different public input.
        index: usize,
    },
    /// The proof is not valid for the pinned verifier key.
    #[error("proof rejected: {0}")]
    Rejected(String),
}

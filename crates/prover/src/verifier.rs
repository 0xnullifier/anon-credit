//! The pinned verifier key and proof verification.

use std::{
    panic::{AssertUnwindSafe, catch_unwind},
    path::Path,
    time::{Duration, Instant},
};

use provekit_backend_bn254::{Verifier, Verify};
use whir::protocols::params::Mode;

use crate::{
    digest::Sha256Digest,
    error::{LoadError, VerifyError},
    proof::Proof,
    public_input::PublicInput,
};

/// A ProveKit verifier key (`.pkv`) with a checked digest.
///
/// A value of this type exists only if:
///
/// 1. The SHA-256 digest of the key bytes is equal to the pinned digest.
/// 2. The key is a valid key for the pinned ProveKit commit.
/// 3. The key uses a hiding (zero-knowledge) witness commitment.
#[derive(Debug, Clone)]
pub struct PinnedVerifier {
    verifier: Verifier,
    info: VerifierInfo,
}

/// Facts about a loaded verifier key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifierInfo {
    /// The SHA-256 digest of the key bytes.
    pub digest: Sha256Digest,
    /// The number of public inputs of the circuit.
    pub num_public_inputs: usize,
    /// The number of R1CS constraints.
    pub num_constraints: usize,
    /// The number of R1CS witnesses.
    pub num_witnesses: usize,
    /// The name of the hash for Merkle commitments and Fiat-Shamir.
    pub hash: String,
}

/// The result of a successful verification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verified {
    /// The time of the cryptographic verification. It does not include proof decoding.
    pub duration: Duration,
}

impl PinnedVerifier {
    /// Reads a verifier key file and loads it with [`PinnedVerifier::from_bytes`].
    pub fn load(path: &Path, expected: &Sha256Digest) -> Result<Self, LoadError> {
        let bytes = std::fs::read(path).map_err(|source| LoadError::Io {
            path: path.to_path_buf(),
            source,
        })?;
        Self::from_bytes(&bytes, expected)
    }

    /// Loads a verifier key from its bytes.
    ///
    /// It checks the digest before it parses the bytes. A wrong digest gives
    /// [`LoadError::DigestMismatch`], and the bytes are not parsed.
    pub fn from_bytes(bytes: &[u8], expected: &Sha256Digest) -> Result<Self, LoadError> {
        let actual = Sha256Digest::of(bytes);
        if actual != *expected {
            return Err(LoadError::DigestMismatch {
                expected: *expected,
                actual,
            });
        }
        let verifier = provekit_common::file::deserialize::<Verifier>(bytes)
            .map_err(|error| LoadError::Format(format!("{error:#}")))?;
        let scheme = verifier
            .whir_for_witness
            .as_ref()
            .ok_or(LoadError::MissingScheme)?;
        match scheme.whir_witness.security().mode {
            Mode::ZeroKnowledge => {}
            Mode::Standard => return Err(LoadError::NotHiding),
        }
        let (num_constraints, num_witnesses) = (
            verifier.r1cs.num_constraints(),
            verifier.r1cs.num_witnesses(),
        );
        let info = VerifierInfo {
            digest: actual,
            num_public_inputs: verifier.r1cs.num_public_inputs,
            num_constraints,
            num_witnesses,
            hash: verifier.hash_config.to_string(),
        };
        Ok(Self { verifier, info })
    }

    /// Returns facts about the loaded key.
    pub const fn info(&self) -> &VerifierInfo {
        &self.info
    }

    /// Verifies a proof against the expected public inputs.
    ///
    /// The caller must make `expected` from its own values, not from the request.
    /// The steps are:
    ///
    /// 1. The number of expected values must be the number of public inputs of the circuit.
    /// 2. The public inputs in the proof must be equal to the expected values.
    /// 3. The proof must be valid for the pinned key. The Fiat-Shamir transcript binds the
    ///    public inputs, so a proof with changed public inputs fails this step.
    pub fn verify(&self, proof: &Proof, expected: &[PublicInput]) -> Result<Verified, VerifyError> {
        if expected.len() != self.info.num_public_inputs {
            return Err(VerifyError::CircuitPublicInputCount {
                circuit: self.info.num_public_inputs,
                given: expected.len(),
            });
        }
        let actual = proof.public_inputs();
        if actual.len() != expected.len() {
            return Err(VerifyError::PublicInputCount {
                expected: expected.len(),
                actual: actual.len(),
            });
        }
        if let Some(index) = actual.iter().zip(expected).position(|(a, e)| a != e) {
            return Err(VerifyError::PublicInputMismatch { index });
        }
        // ProveKit consumes the verifier state on each call. Use a fresh copy each time.
        let mut verifier = self.verifier.clone();
        let start = Instant::now();
        // A malformed proof must not stop the process. Catch a panic in the ProveKit code
        // and return it as a rejection.
        let outcome = catch_unwind(AssertUnwindSafe(|| verifier.verify(&proof.inner)));
        let duration = start.elapsed();
        match outcome {
            Ok(Ok(())) => Ok(Verified { duration }),
            Ok(Err(error)) => Err(VerifyError::Rejected(format!("{error:#}"))),
            Err(_) => Err(VerifyError::Rejected("verifier panicked".to_owned())),
        }
    }
}

//! Proof decoding.

use provekit_backend_bn254::{Bn254Field, ProvekitProof};

use crate::{error::DecodeError, public_input::PublicInput};

/// The default size limit for one encoded proof (4 MiB).
///
/// Measured JSON proofs: about 0.45 MB (sample circuit) and 0.48 MB (batch-open circuit).
/// Binary `.np` proofs are smaller. Set the limit for each circuit from measured proof sizes.
pub const DEFAULT_MAX_PROOF_BYTES: usize = 4 * 1024 * 1024;

/// The encoding of a proof.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProofEncoding {
    /// JSON from the browser WASM prover (`Prover.proveBytes`).
    Json,
    /// Binary `.np` from the native CLI: a header and zstd-compressed postcard data.
    Binary,
}

/// A decoded ProveKit proof.
#[derive(Debug, Clone)]
pub struct Proof {
    pub(crate) inner: ProvekitProof<Bn254Field>,
    encoding: ProofEncoding,
    encoded_len: usize,
}

impl Proof {
    /// Decodes a proof. It finds the encoding from the first bytes.
    ///
    /// It rejects a proof that is larger than `max_bytes` before it decodes the proof.
    pub fn decode(bytes: &[u8], max_bytes: usize) -> Result<Self, DecodeError> {
        if bytes.len() > max_bytes {
            return Err(DecodeError::TooLarge {
                actual: bytes.len(),
                limit: max_bytes,
            });
        }
        let encoding = match bytes.starts_with(provekit_common::binary_format::MAGIC_BYTES) {
            true => ProofEncoding::Binary,
            false => ProofEncoding::Json,
        };
        let inner = match encoding {
            ProofEncoding::Json => serde_json::from_slice::<ProvekitProof<Bn254Field>>(bytes)
                .map_err(|error| DecodeError::Json(error.to_string()))?,
            ProofEncoding::Binary => {
                provekit_common::file::deserialize::<ProvekitProof<Bn254Field>>(bytes)
                    .map_err(|error| DecodeError::Binary(format!("{error:#}")))?
            }
        };
        Ok(Self {
            inner,
            encoding,
            encoded_len: bytes.len(),
        })
    }

    /// Returns the encoding of the decoded bytes.
    pub const fn encoding(&self) -> ProofEncoding {
        self.encoding
    }

    /// Returns the size of the decoded bytes.
    pub const fn encoded_len(&self) -> usize {
        self.encoded_len
    }

    /// Returns the public inputs that the proof contains.
    pub fn public_inputs(&self) -> Vec<PublicInput> {
        self.inner
            .public_inputs
            .0
            .iter()
            .map(PublicInput::from_field)
            .collect()
    }

    /// Encodes the proof in the binary `.np` encoding.
    pub fn to_binary(&self) -> Result<Vec<u8>, DecodeError> {
        provekit_common::file::serialize(&self.inner)
            .map_err(|error| DecodeError::Binary(format!("{error:#}")))
    }
}

//! Chunked proof upload: `PUT /v1/open/chunks`.
//!
//! The Nox worker refuses request bodies above about 48,000 bytes. An open request with an
//! inline proof is about 640 KB. Thus a client sends the proof bytes in chunks of at most
//! 24 KiB, then sends `POST /v1/open` with `proof_upload: {proof_sha256, total_bytes,
//! proof_encoding}` in place of `proof`. The open pipeline does not change.
//!
//! Rules:
//!
//! - The gateway keys an upload by `(batch_id, proof_sha256)`. Chunks can arrive in any
//!   order. A duplicate chunk with the same bytes has no effect. A duplicate chunk with
//!   different bytes is `invalid_request`.
//! - All chunks of an upload must give the same `total_bytes` and `chunk_count`.
//! - When the last chunk arrives, the gateway checks the length and the SHA-256. If one of
//!   them does not agree, the gateway deletes the upload and returns `invalid_request`.
//! - `POST /v1/open` takes the upload out of the store. Thus each open request deletes its
//!   upload: on success, on `proof_invalid`, and on each other rejection.
//! - Uploads stay in memory. A background task deletes uploads older than the TTL.
//!
//! Spam: chunks are not authenticated before the proof verifies. The plan accepts the same
//! risk for invalid proofs. The limits are the mitigation: the largest upload, the largest
//! number of chunks, the TTL, the largest number of pending uploads, and the largest sum of
//! pending bytes. A full store gives `busy` (retryable). The gateway reserves the declared
//! `total_bytes` of an upload when its first chunk arrives, so the memory use stays below
//! the pending byte limit.

use crate::app::{SharedGateway, read_body};
use crate::error::ApiError;
use anon_credit_crypto::FieldElement;
use anon_credit_protocol::api::{
    OPEN_CHUNK_MAX_BYTES, OpenChunkRequest, OpenChunkResponse, ProofEncoding, ProofUpload,
};
use anon_credit_protocol::{Bytes32, ErrorCode};
use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::extract::rejection::BytesRejection;
use axum::response::{IntoResponse, Response};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Read;
use std::sync::Mutex;

/// Limits of the upload store.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UploadLimits {
    /// Largest upload in bytes. Also the largest proof after decompression.
    pub max_bytes: usize,
    /// Largest number of chunks of one upload.
    pub max_chunks: u32,
    /// Time in seconds that an unused upload stays in the store.
    pub ttl_secs: u64,
    /// Largest number of pending uploads.
    pub max_pending: usize,
    /// Largest sum of the declared sizes of all pending uploads.
    pub max_pending_bytes: usize,
}

impl Default for UploadLimits {
    fn default() -> Self {
        Self {
            max_bytes: 4 * 1024 * 1024,
            max_chunks: 256,
            ttl_secs: 600,
            max_pending: 1000,
            max_pending_bytes: 512 * 1024 * 1024,
        }
    }
}

/// Key of one upload.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct UploadKey {
    /// Batch ID of the open request.
    pub batch_id: Bytes32,
    /// SHA-256 of the uploaded bytes.
    pub proof_sha256: Bytes32,
}

/// Why the store refused a chunk or an upload.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum UploadError {
    /// The request breaks a rule. Not retryable.
    #[error("{0}")]
    Invalid(&'static str),
    /// The store is full. Retryable.
    #[error("{0}")]
    Full(&'static str),
}

impl UploadError {
    /// The API error of this refusal.
    pub fn to_api(&self) -> ApiError {
        match self {
            UploadError::Invalid(message) => ApiError::new(ErrorCode::InvalidRequest, message),
            UploadError::Full(message) => ApiError::new(ErrorCode::Busy, message),
        }
    }
}

/// Result of one accepted chunk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChunkOutcome {
    /// Number of different chunks that the store has.
    pub received_chunks: u32,
    /// `true` if all chunks are present and checked.
    pub complete: bool,
}

#[derive(Debug)]
struct Pending {
    total_bytes: usize,
    chunk_count: u32,
    chunks: Vec<Option<Vec<u8>>>,
    received_chunks: u32,
    received_bytes: usize,
    created_at: u64,
    complete: bool,
}

#[derive(Debug, Default)]
struct Inner {
    uploads: HashMap<UploadKey, Pending>,
    reserved_bytes: usize,
}

impl Inner {
    fn remove(&mut self, key: &UploadKey) -> Option<Pending> {
        let pending = self.uploads.remove(key)?;
        self.reserved_bytes = self.reserved_bytes.saturating_sub(pending.total_bytes);
        Some(pending)
    }

    fn evict_expired(&mut self, now_unix: u64, ttl_secs: u64) -> usize {
        let expired: Vec<UploadKey> = self
            .uploads
            .iter()
            .filter(|(_, pending)| is_expired(pending, now_unix, ttl_secs))
            .map(|(key, _)| *key)
            .collect();
        for key in &expired {
            self.remove(key);
        }
        expired.len()
    }
}

fn is_expired(pending: &Pending, now_unix: u64, ttl_secs: u64) -> bool {
    now_unix >= pending.created_at.saturating_add(ttl_secs)
}

/// In-memory store of pending proof uploads.
#[derive(Debug)]
pub struct UploadStore {
    limits: UploadLimits,
    inner: Mutex<Inner>,
}

/// Size facts of one chunk request, checked before the store lock.
struct ChunkShape {
    total_bytes: usize,
    chunk_count: u32,
    index: usize,
}

impl UploadStore {
    /// Make an empty store.
    pub fn new(limits: UploadLimits) -> Self {
        Self {
            limits,
            inner: Mutex::new(Inner::default()),
        }
    }

    /// The limits of the store.
    pub fn limits(&self) -> UploadLimits {
        self.limits
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // A panic while the lock is held cannot leave a broken map: each change is one call.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Number of pending uploads and the sum of their declared sizes.
    pub fn pending(&self) -> (usize, usize) {
        let inner = self.lock();
        (inner.uploads.len(), inner.reserved_bytes)
    }

    fn shape(&self, chunk: &OpenChunkRequest) -> Result<ChunkShape, UploadError> {
        let total_bytes = usize::try_from(chunk.total_bytes)
            .map_err(|_| UploadError::Invalid("total_bytes is too large"))?;
        if total_bytes == 0 || total_bytes > self.limits.max_bytes {
            return Err(UploadError::Invalid(
                "total_bytes is zero or above the upload limit",
            ));
        }
        let chunk_count = chunk.chunk_count;
        if chunk_count == 0 || chunk_count > self.limits.max_chunks {
            return Err(UploadError::Invalid(
                "chunk_count is zero or above the chunk limit",
            ));
        }
        let count = usize::try_from(chunk_count)
            .map_err(|_| UploadError::Invalid("chunk_count is too large"))?;
        // Each chunk has at least one byte and at most OPEN_CHUNK_MAX_BYTES bytes.
        if count > total_bytes || count.saturating_mul(OPEN_CHUNK_MAX_BYTES) < total_bytes {
            return Err(UploadError::Invalid(
                "chunk_count does not agree with total_bytes",
            ));
        }
        if chunk.chunk_index >= chunk_count {
            return Err(UploadError::Invalid("chunk_index is not below chunk_count"));
        }
        let index = usize::try_from(chunk.chunk_index)
            .map_err(|_| UploadError::Invalid("chunk_index is too large"))?;
        let data_len = chunk.data.0.len();
        if data_len == 0 || data_len > OPEN_CHUNK_MAX_BYTES {
            return Err(UploadError::Invalid(
                "chunk data is empty or above the chunk size limit",
            ));
        }
        Ok(ChunkShape {
            total_bytes,
            chunk_count,
            index,
        })
    }

    /// Add one chunk at `now_unix`.
    pub fn put_chunk(
        &self,
        chunk: &OpenChunkRequest,
        now_unix: u64,
    ) -> Result<ChunkOutcome, UploadError> {
        let shape = self.shape(chunk)?;
        let key = UploadKey {
            batch_id: chunk.batch_id,
            proof_sha256: chunk.proof_sha256,
        };
        let mut inner = self.lock();
        if inner
            .uploads
            .get(&key)
            .is_some_and(|pending| is_expired(pending, now_unix, self.limits.ttl_secs))
        {
            inner.remove(&key);
        }
        if !inner.uploads.contains_key(&key) {
            self.reserve(&mut inner, now_unix, shape.total_bytes)?;
            inner.reserved_bytes = inner.reserved_bytes.saturating_add(shape.total_bytes);
            inner.uploads.insert(
                key,
                Pending {
                    total_bytes: shape.total_bytes,
                    chunk_count: shape.chunk_count,
                    chunks: vec![None; usize::try_from(shape.chunk_count).unwrap_or(0)],
                    received_chunks: 0,
                    received_bytes: 0,
                    created_at: now_unix,
                    complete: false,
                },
            );
        }
        let outcome = {
            let pending = inner
                .uploads
                .get_mut(&key)
                .ok_or(UploadError::Invalid("upload is not present"))?;
            add_chunk(pending, &shape, &chunk.data.0)
        };
        match outcome {
            Ok(Added::Waiting(outcome)) => Ok(outcome),
            Ok(Added::AllChunks) => {
                let checked = inner
                    .uploads
                    .get_mut(&key)
                    .ok_or(UploadError::Invalid("upload is not present"))
                    .and_then(|pending| finish(pending, &key.proof_sha256));
                if checked.is_err() {
                    inner.remove(&key);
                }
                checked
            }
            Err(Broken::Rejected(error)) => Err(error),
            Err(Broken::Delete(error)) => {
                inner.remove(&key);
                Err(error)
            }
        }
    }

    /// Check the pending limits for a new upload of `total_bytes`. Delete expired uploads
    /// first if a limit is reached.
    fn reserve(
        &self,
        inner: &mut Inner,
        now_unix: u64,
        total_bytes: usize,
    ) -> Result<(), UploadError> {
        let fits = |inner: &Inner| {
            inner.uploads.len() < self.limits.max_pending
                && inner.reserved_bytes.saturating_add(total_bytes) <= self.limits.max_pending_bytes
        };
        if fits(inner) {
            return Ok(());
        }
        inner.evict_expired(now_unix, self.limits.ttl_secs);
        match (inner.uploads.len() < self.limits.max_pending, fits(inner)) {
            (false, _) => Err(UploadError::Full("too many pending proof uploads")),
            (true, false) => Err(UploadError::Full(
                "pending proof uploads use too much memory",
            )),
            (true, true) => Ok(()),
        }
    }

    /// Take a complete upload out of the store and return its bytes. The upload is deleted
    /// in all cases, also if it is incomplete or does not agree with `reference`.
    pub fn take(
        &self,
        batch_id: Bytes32,
        reference: &ProofUpload,
        now_unix: u64,
    ) -> Result<Vec<u8>, UploadError> {
        let key = UploadKey {
            batch_id,
            proof_sha256: reference.proof_sha256,
        };
        let pending = self
            .lock()
            .remove(&key)
            .ok_or(UploadError::Invalid("proof upload is not present"))?;
        if is_expired(&pending, now_unix, self.limits.ttl_secs) {
            return Err(UploadError::Invalid("proof upload is expired"));
        }
        if !pending.complete {
            return Err(UploadError::Invalid("proof upload is not complete"));
        }
        let declared = usize::try_from(reference.total_bytes)
            .map_err(|_| UploadError::Invalid("total_bytes is too large"))?;
        if declared != pending.total_bytes {
            return Err(UploadError::Invalid(
                "proof_upload total_bytes is not the uploaded length",
            ));
        }
        let mut bytes = Vec::with_capacity(pending.total_bytes);
        for chunk in pending.chunks.into_iter().flatten() {
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }

    /// Delete an upload if it is present.
    pub fn remove(&self, key: &UploadKey) -> bool {
        self.lock().remove(key).is_some()
    }

    /// Delete the uploads that are older than the TTL. Return the number deleted.
    pub fn evict_expired(&self, now_unix: u64) -> usize {
        self.lock().evict_expired(now_unix, self.limits.ttl_secs)
    }
}

enum Added {
    Waiting(ChunkOutcome),
    AllChunks,
}

enum Broken {
    /// Refuse the chunk. Keep the upload.
    Rejected(UploadError),
    /// Refuse the chunk and delete the upload: it cannot complete.
    Delete(UploadError),
}

fn add_chunk(pending: &mut Pending, shape: &ChunkShape, data: &[u8]) -> Result<Added, Broken> {
    if pending.total_bytes != shape.total_bytes || pending.chunk_count != shape.chunk_count {
        return Err(Broken::Rejected(UploadError::Invalid(
            "total_bytes or chunk_count differs from the earlier chunks of the upload",
        )));
    }
    let slot =
        pending
            .chunks
            .get_mut(shape.index)
            .ok_or(Broken::Rejected(UploadError::Invalid(
                "chunk_index is not below chunk_count",
            )))?;
    match slot {
        Some(existing) if existing.as_slice() == data => {
            return Ok(Added::Waiting(ChunkOutcome {
                received_chunks: pending.received_chunks,
                complete: pending.complete,
            }));
        }
        Some(_) => {
            return Err(Broken::Rejected(UploadError::Invalid(
                "chunk differs from an earlier chunk with the same index",
            )));
        }
        None => {}
    }
    let received_bytes = pending.received_bytes.saturating_add(data.len());
    if received_bytes > pending.total_bytes {
        return Err(Broken::Delete(UploadError::Invalid(
            "chunks are longer than total_bytes",
        )));
    }
    *slot = Some(data.to_vec());
    pending.received_bytes = received_bytes;
    pending.received_chunks = pending.received_chunks.saturating_add(1);
    match pending.received_chunks == pending.chunk_count {
        true => Ok(Added::AllChunks),
        false => Ok(Added::Waiting(ChunkOutcome {
            received_chunks: pending.received_chunks,
            complete: false,
        })),
    }
}

/// Check the length and the SHA-256 of a pending upload with all chunks.
fn finish(pending: &mut Pending, proof_sha256: &Bytes32) -> Result<ChunkOutcome, UploadError> {
    if pending.received_bytes != pending.total_bytes {
        return Err(UploadError::Invalid("chunks are shorter than total_bytes"));
    }
    let mut hasher = Sha256::new();
    for chunk in pending.chunks.iter().flatten() {
        hasher.update(chunk);
    }
    let digest: [u8; 32] = hasher.finalize().into();
    if &Bytes32(digest) != proof_sha256 {
        return Err(UploadError::Invalid(
            "SHA-256 of the chunks is not proof_sha256",
        ));
    }
    pending.complete = true;
    Ok(ChunkOutcome {
        received_chunks: pending.received_chunks,
        complete: true,
    })
}

/// Decode uploaded proof bytes for the verifier. `json+gzip` is decompressed; the result
/// must not be larger than `max_bytes`.
pub fn decode_proof(
    encoding: ProofEncoding,
    bytes: Vec<u8>,
    max_bytes: usize,
) -> Result<Vec<u8>, UploadError> {
    match encoding {
        ProofEncoding::Np | ProofEncoding::Json => Ok(bytes),
        ProofEncoding::JsonGzip => {
            let limit = u64::try_from(max_bytes)
                .unwrap_or(u64::MAX)
                .saturating_add(1);
            let mut decoded = Vec::new();
            flate2::read::GzDecoder::new(bytes.as_slice())
                .take(limit)
                .read_to_end(&mut decoded)
                .map_err(|_| UploadError::Invalid("proof is not valid gzip"))?;
            if decoded.len() > max_bytes {
                return Err(UploadError::Invalid(
                    "decompressed proof is above the upload limit",
                ));
            }
            Ok(decoded)
        }
    }
}

/// `PUT /v1/open/chunks`.
pub async fn put_chunk(
    State(gateway): State<SharedGateway>,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    match put_chunk_inner(&gateway, body) {
        Ok(outcome) => Json(OpenChunkResponse {
            received_chunks: outcome.received_chunks,
            complete: outcome.complete,
        })
        .into_response(),
        Err(error) => error.into_response(),
    }
}

fn put_chunk_inner(
    gateway: &SharedGateway,
    body: Result<Bytes, BytesRejection>,
) -> Result<ChunkOutcome, ApiError> {
    let body = read_body(body)?;
    let chunk: OpenChunkRequest = serde_json::from_slice(&body).map_err(|_| {
        ApiError::new(
            ErrorCode::InvalidRequest,
            "chunk request does not match the schema",
        )
    })?;
    FieldElement::from_bytes_be(&chunk.batch_id.0).map_err(|_| {
        ApiError::new(
            ErrorCode::InvalidRequest,
            "batch_id is not a canonical field element",
        )
    })?;
    gateway
        .uploads
        .put_chunk(&chunk, gateway.clock.now_unix())
        .map_err(|error| error.to_api())
}

#[cfg(test)]
mod tests {
    use super::*;
    use anon_credit_protocol::Base64Bytes;
    use std::io::Write;

    fn sha(bytes: &[u8]) -> Bytes32 {
        Bytes32(Sha256::digest(bytes).into())
    }

    fn chunks_of(batch: u8, bytes: &[u8], size: usize) -> Vec<OpenChunkRequest> {
        let count = u32::try_from(bytes.len().div_ceil(size)).unwrap();
        bytes
            .chunks(size)
            .enumerate()
            .map(|(index, data)| OpenChunkRequest {
                batch_id: Bytes32([batch; 32]),
                proof_sha256: sha(bytes),
                total_bytes: u32::try_from(bytes.len()).unwrap(),
                chunk_index: u32::try_from(index).unwrap(),
                chunk_count: count,
                data: Base64Bytes(data.to_vec()),
            })
            .collect()
    }

    fn reference(bytes: &[u8], encoding: ProofEncoding) -> ProofUpload {
        ProofUpload {
            proof_sha256: sha(bytes),
            total_bytes: u32::try_from(bytes.len()).unwrap(),
            proof_encoding: encoding,
        }
    }

    fn proof(len: usize) -> Vec<u8> {
        (0..len).map(|i| u8::try_from(i % 251).unwrap()).collect()
    }

    #[test]
    fn chunks_in_any_order_complete_the_upload() {
        let store = UploadStore::new(UploadLimits::default());
        let bytes = proof(100_000);
        let mut chunks = chunks_of(1, &bytes, OPEN_CHUNK_MAX_BYTES);
        assert_eq!(chunks.len(), 5);
        chunks.reverse();
        let mut last = None;
        for chunk in &chunks {
            last = Some(store.put_chunk(chunk, 10).unwrap());
        }
        assert_eq!(
            last,
            Some(ChunkOutcome {
                received_chunks: 5,
                complete: true
            })
        );
        let taken = store
            .take(
                Bytes32([1; 32]),
                &reference(&bytes, ProofEncoding::Json),
                11,
            )
            .unwrap();
        assert_eq!(taken, bytes);
        assert_eq!(store.pending(), (0, 0));
    }

    #[test]
    fn duplicates_are_idempotent_and_a_different_duplicate_is_refused() {
        let store = UploadStore::new(UploadLimits::default());
        let bytes = proof(50_000);
        let chunks = chunks_of(1, &bytes, OPEN_CHUNK_MAX_BYTES);
        let first = store.put_chunk(&chunks[0], 0).unwrap();
        assert_eq!(store.put_chunk(&chunks[0], 0).unwrap(), first);
        let mut changed = chunks[0].clone();
        changed.data.0[0] ^= 1;
        assert_eq!(
            store.put_chunk(&changed, 0),
            Err(UploadError::Invalid(
                "chunk differs from an earlier chunk with the same index"
            ))
        );
        for chunk in &chunks[1..] {
            store.put_chunk(chunk, 0).unwrap();
        }
        // A duplicate after completion still answers "complete".
        assert!(store.put_chunk(&chunks[1], 0).unwrap().complete);
    }

    #[test]
    fn wrong_sha256_deletes_the_upload() {
        let store = UploadStore::new(UploadLimits::default());
        let bytes = proof(30_000);
        let mut chunks = chunks_of(1, &bytes, OPEN_CHUNK_MAX_BYTES);
        for chunk in &mut chunks {
            chunk.proof_sha256 = Bytes32([9; 32]);
        }
        store.put_chunk(&chunks[0], 0).unwrap();
        assert!(matches!(
            store.put_chunk(&chunks[1], 0),
            Err(UploadError::Invalid(_))
        ));
        assert_eq!(store.pending(), (0, 0));
    }

    #[test]
    fn shape_and_limit_checks() {
        let limits = UploadLimits {
            max_bytes: 100_000,
            max_chunks: 8,
            ttl_secs: 60,
            max_pending: 2,
            max_pending_bytes: 150_000,
        };
        let store = UploadStore::new(limits);
        let base = chunks_of(1, &proof(60_000), OPEN_CHUNK_MAX_BYTES)[0].clone();
        let cases: Vec<(&str, OpenChunkRequest)> = vec![
            (
                "too large",
                OpenChunkRequest {
                    total_bytes: 100_001,
                    chunk_count: 5,
                    ..base.clone()
                },
            ),
            (
                "zero length",
                OpenChunkRequest {
                    total_bytes: 0,
                    ..base.clone()
                },
            ),
            (
                "too many chunks",
                OpenChunkRequest {
                    chunk_count: 9,
                    ..base.clone()
                },
            ),
            (
                "too few chunks",
                OpenChunkRequest {
                    chunk_count: 2,
                    ..base.clone()
                },
            ),
            (
                "index",
                OpenChunkRequest {
                    chunk_index: 3,
                    ..base.clone()
                },
            ),
            (
                "big data",
                OpenChunkRequest {
                    data: Base64Bytes(vec![0; OPEN_CHUNK_MAX_BYTES + 1]),
                    ..base.clone()
                },
            ),
            (
                "empty data",
                OpenChunkRequest {
                    data: Base64Bytes(Vec::new()),
                    ..base.clone()
                },
            ),
        ];
        for (name, chunk) in cases {
            assert!(
                matches!(store.put_chunk(&chunk, 0), Err(UploadError::Invalid(_))),
                "{name}"
            );
        }
        assert_eq!(store.pending(), (0, 0));

        // A chunk with another total_bytes than the first chunk of the upload.
        store.put_chunk(&base, 0).unwrap();
        let other = OpenChunkRequest {
            total_bytes: 60_001,
            chunk_index: 1,
            ..base.clone()
        };
        assert!(matches!(
            store.put_chunk(&other, 0),
            Err(UploadError::Invalid(_))
        ));

        // Pending bytes: 60,000 reserved; another 100,000 does not fit in 150,000.
        let big = chunks_of(2, &proof(100_000), OPEN_CHUNK_MAX_BYTES);
        assert!(matches!(
            store.put_chunk(&big[0], 0),
            Err(UploadError::Full(_))
        ));
        // Pending count: two uploads fit, a third is refused.
        store
            .put_chunk(&chunks_of(3, &proof(1000), 500)[0], 0)
            .unwrap();
        assert!(matches!(
            store.put_chunk(&chunks_of(4, &proof(1000), 500)[0], 0),
            Err(UploadError::Full(_))
        ));
        assert_eq!(UploadError::Full("x").to_api().code(), ErrorCode::Busy);
        // After the TTL, the expired uploads make space again.
        assert!(store.put_chunk(&big[0], 60).is_ok());
        assert_eq!(store.pending(), (1, 100_000));
    }

    #[test]
    fn ttl_eviction_and_take_after_expiry() {
        let store = UploadStore::new(UploadLimits::default());
        let bytes = proof(1000);
        for chunk in chunks_of(1, &bytes, 400) {
            store.put_chunk(&chunk, 100).unwrap();
        }
        assert_eq!(store.evict_expired(699), 0);
        assert_eq!(
            store.take(Bytes32([1; 32]), &reference(&bytes, ProofEncoding::Np), 700),
            Err(UploadError::Invalid("proof upload is expired"))
        );
        for chunk in chunks_of(1, &bytes, 400) {
            store.put_chunk(&chunk, 100).unwrap();
        }
        assert_eq!(store.evict_expired(700), 1);
        assert_eq!(store.pending(), (0, 0));
    }

    #[test]
    fn take_refuses_an_incomplete_upload_and_deletes_it() {
        let store = UploadStore::new(UploadLimits::default());
        let bytes = proof(1000);
        let chunks = chunks_of(1, &bytes, 400);
        store.put_chunk(&chunks[0], 0).unwrap();
        let reference = reference(&bytes, ProofEncoding::Json);
        assert_eq!(
            store.take(Bytes32([1; 32]), &reference, 0),
            Err(UploadError::Invalid("proof upload is not complete"))
        );
        assert_eq!(store.pending(), (0, 0));
        for chunk in &chunks {
            store.put_chunk(chunk, 0).unwrap();
        }
        let wrong_length = ProofUpload {
            total_bytes: 999,
            ..reference
        };
        assert!(store.take(Bytes32([1; 32]), &wrong_length, 0).is_err());
        assert_eq!(store.pending(), (0, 0));
    }

    #[test]
    fn gzip_decoding_has_a_size_limit() {
        let text = vec![b'7'; 10_000];
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&text).unwrap();
        let gzip = encoder.finish().unwrap();
        assert_eq!(
            decode_proof(ProofEncoding::JsonGzip, gzip.clone(), 10_000).unwrap(),
            text
        );
        assert!(decode_proof(ProofEncoding::JsonGzip, gzip, 9_999).is_err());
        assert!(decode_proof(ProofEncoding::JsonGzip, b"not gzip".to_vec(), 10_000).is_err());
        assert_eq!(
            decode_proof(ProofEncoding::Np, vec![1, 2], 1).unwrap(),
            vec![1, 2]
        );
    }
}

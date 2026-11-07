//! JSON envelopes of the gateway HTTP API (implementation.md section 10).
//!
//! Rules for all envelopes:
//!
//! - Unknown fields are rejected.
//! - IDs, keys, roots, and digests are canonical lowercase hex ([`Bytes32`]).
//! - Proofs, signatures, and RPC bytes are canonical base64 ([`Base64Bytes`], [`Signature64`]).
//! - `u64` values are decimal strings ([`DecimalU64`]). Small values (`u16`, `u32`) are numbers.
//!
//! The TypeScript package `@anon-credit/protocol` has the same schemas in `gateway-api.ts`.
//! `fixtures/protocol/gateway-api.json` has shared examples.

use crate::error::{ErrorBody, ErrorCode};
use crate::hex_bytes::{Address, Bytes32};
use crate::open::OpenMessage;
use crate::price::PriceTable;
use crate::spend::{SpendMessage, SpendMessageError};
use crate::status::StatusMessage;
use crate::wire::{Base64Bytes, DecimalU64, Signature64};
use serde::{Deserialize, Serialize};

/// Response header: units that remain in the session after the request.
pub const HEADER_REMAINING: &str = "x-anon-remaining";
/// Response header: the next sequence number of the session.
pub const HEADER_NEXT_SEQ: &str = "x-anon-next-seq";
/// Response header: `true` if the gateway served a stored response without a new charge.
pub const HEADER_REPLAYED: &str = "x-anon-replayed";
/// All `X-Anon-*` response headers. CORS must expose them.
pub const SPEND_RESPONSE_HEADERS: [&str; 3] = [HEADER_REMAINING, HEADER_NEXT_SEQ, HEADER_REPLAYED];

/// Path prefix of the chunk route. The full path is
/// `/v1/open/chunks/{batch_id}/{proof_sha256}/{total_bytes}/{chunk_count}/{chunk_index}`.
pub const OPEN_CHUNK_PATH_PREFIX: &str = "/v1/open/chunks";

/// Largest raw data of one `PUT /v1/open/chunks/...` chunk: 40,000 bytes. The request body
/// is the raw chunk bytes (`application/octet-stream`), so this is also the body size.
pub const OPEN_CHUNK_MAX_BYTES: usize = 40_000;

/// Largest `PUT /v1/open/chunks/...` body. The body is the raw chunk, thus the limit is
/// [`OPEN_CHUNK_MAX_BYTES`]. The Nox worker refuses requests above about 48,000 bytes; the
/// path and the headers use less than 1,000 bytes.
pub const OPEN_CHUNK_BODY_LIMIT_BYTES: usize = OPEN_CHUNK_MAX_BYTES;

/// Encoding of the proof bytes of a chunked upload.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ProofEncoding {
    /// Binary ProveKit proof (`.np`). The gateway sends the bytes to the verifier as they are.
    #[serde(rename = "np")]
    Np,
    /// JSON ProveKit proof, as the browser prover emits it. Sent to the verifier as it is.
    #[serde(rename = "json")]
    Json,
    /// JSON ProveKit proof in gzip. The gateway decompresses it with a size limit.
    #[serde(rename = "json+gzip")]
    JsonGzip,
}

impl ProofEncoding {
    /// Wire name of the encoding.
    pub const fn as_str(self) -> &'static str {
        match self {
            ProofEncoding::Np => "np",
            ProofEncoding::Json => "json",
            ProofEncoding::JsonGzip => "json+gzip",
        }
    }
}

/// Reference to a complete chunked proof upload (`PUT /v1/open/chunks/...`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProofUpload {
    /// SHA-256 of the uploaded bytes (after the encoding, before decompression).
    pub proof_sha256: Bytes32,
    /// Length of the uploaded bytes.
    pub total_bytes: u32,
    /// Encoding of the uploaded bytes.
    pub proof_encoding: ProofEncoding,
}

/// Path parameters of `PUT /v1/open/chunks/...`: the identity of one chunk of a proof upload.
///
/// The request body is the raw chunk bytes: 1 to [`OPEN_CHUNK_MAX_BYTES`] bytes. The gateway
/// keys an upload by `(batch_id, proof_sha256)`. The chunks can arrive in any order. The proof
/// bytes are the chunk bodies in `chunk_index` order. The path has no secret: the batch ID
/// and the digest are public to the gateway.
///
/// The JSON form (serde) is for the shared fixtures only. The wire form is the path
/// ([`OpenChunkPath::to_path`], [`OpenChunkPath::parse`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpenChunkPath {
    /// Public batch ID of the open request that uses the upload.
    pub batch_id: Bytes32,
    /// SHA-256 of all uploaded bytes.
    pub proof_sha256: Bytes32,
    /// Length of all uploaded bytes.
    pub total_bytes: u32,
    /// Number of chunks of the upload.
    pub chunk_count: u32,
    /// Index of this chunk, from 0.
    pub chunk_index: u32,
}

/// Failure to read a chunk path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ChunkPathError {
    /// The path does not start with [`OPEN_CHUNK_PATH_PREFIX`] or has the wrong number of
    /// segments.
    #[error(
        "chunk path must be /v1/open/chunks/{{batch_id}}/{{proof_sha256}}/{{total_bytes}}/{{chunk_count}}/{{chunk_index}}"
    )]
    Shape,
    /// A digest segment is not canonical lowercase hex of 32 bytes.
    #[error("chunk path batch_id and proof_sha256 must be canonical lowercase hex of 32 bytes")]
    Hex,
    /// A number segment is not a canonical decimal `u32`.
    #[error(
        "chunk path total_bytes, chunk_count, and chunk_index must be decimal u32 values without leading zeros"
    )]
    Number,
}

/// Read a canonical decimal `u32`: `0`, or a digit 1 to 9 and more digits. No sign, no
/// leading zero, at most 2^32 - 1.
fn decimal_u32(text: &str) -> Result<u32, ChunkPathError> {
    let canonical = !text.is_empty()
        && text.bytes().all(|b| b.is_ascii_digit())
        && (text == "0" || !text.starts_with('0'));
    if !canonical {
        return Err(ChunkPathError::Number);
    }
    text.parse::<u32>().map_err(|_| ChunkPathError::Number)
}

impl OpenChunkPath {
    /// The request path of this chunk.
    pub fn to_path(&self) -> String {
        format!(
            "{OPEN_CHUNK_PATH_PREFIX}/{}/{}/{}/{}/{}",
            self.batch_id.to_hex(),
            self.proof_sha256.to_hex(),
            self.total_bytes,
            self.chunk_count,
            self.chunk_index
        )
    }

    /// Read the five path segments after [`OPEN_CHUNK_PATH_PREFIX`].
    pub fn from_segments(
        batch_id: &str,
        proof_sha256: &str,
        total_bytes: &str,
        chunk_count: &str,
        chunk_index: &str,
    ) -> Result<Self, ChunkPathError> {
        Ok(Self {
            batch_id: Bytes32::from_hex(batch_id).map_err(|_| ChunkPathError::Hex)?,
            proof_sha256: Bytes32::from_hex(proof_sha256).map_err(|_| ChunkPathError::Hex)?,
            total_bytes: decimal_u32(total_bytes)?,
            chunk_count: decimal_u32(chunk_count)?,
            chunk_index: decimal_u32(chunk_index)?,
        })
    }

    /// Read a full request path (no query, no trailing slash).
    pub fn parse(path: &str) -> Result<Self, ChunkPathError> {
        let rest = path
            .strip_prefix(OPEN_CHUNK_PATH_PREFIX)
            .and_then(|rest| rest.strip_prefix('/'))
            .ok_or(ChunkPathError::Shape)?;
        let segments: Vec<&str> = rest.split('/').collect();
        match segments.as_slice() {
            [
                batch_id,
                proof_sha256,
                total_bytes,
                chunk_count,
                chunk_index,
            ] => Self::from_segments(
                batch_id,
                proof_sha256,
                total_bytes,
                chunk_count,
                chunk_index,
            ),
            _ => Err(ChunkPathError::Shape),
        }
    }
}

/// `PUT /v1/open/chunks/...` response body.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpenChunkResponse {
    /// Number of different chunks that the gateway has for the upload.
    pub received_chunks: u32,
    /// `true` if all chunks are present and the SHA-256 and the length agree.
    pub complete: bool,
}

/// `POST /v1/open` request body.
///
/// The request has exactly one of `proof` (inline proof bytes) and `proof_upload` (a
/// complete chunked upload). The open signature does not cover the proof.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "OpenRequestWire")]
pub struct OpenRequest {
    /// Protocol version. Must equal [`crate::PROTOCOL_VERSION`].
    pub protocol_version: u16,
    /// Deployment ID. Must equal the gateway deployment ID.
    pub deployment_id: Bytes32,
    /// Gateway ID. Must equal the gateway ID of the deployment.
    pub gateway_id: Bytes32,
    /// Public batch ID (canonical field element).
    pub batch_id: Bytes32,
    /// Selected published MMR root (canonical field element).
    pub root: Bytes32,
    /// Leaf count of the selected root.
    pub leaf_count: u32,
    /// Epoch of the proof. Must be the current or the previous epoch.
    pub proof_epoch: DecimalU64,
    /// Session Ed25519 public key.
    pub session_pub: Bytes32,
    /// Hash of the current gateway price table.
    pub price_table_hash: Bytes32,
    /// Inline proof bytes. Absent if `proof_upload` is present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proof: Option<Base64Bytes>,
    /// Reference to a chunked proof upload. Absent if `proof` is present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proof_upload: Option<ProofUpload>,
    /// Ed25519 signature over [`OpenMessage::digest`] with the session key.
    pub signature: Signature64,
}

/// The source of the proof bytes of an open request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProofSource<'a> {
    /// Inline proof bytes.
    Inline(&'a [u8]),
    /// A chunked upload.
    Upload(&'a ProofUpload),
}

/// Wire form of [`OpenRequest`]. Deserialization checks that exactly one proof source is set.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OpenRequestWire {
    protocol_version: u16,
    deployment_id: Bytes32,
    gateway_id: Bytes32,
    batch_id: Bytes32,
    root: Bytes32,
    leaf_count: u32,
    proof_epoch: DecimalU64,
    session_pub: Bytes32,
    price_table_hash: Bytes32,
    #[serde(default)]
    proof: Option<Base64Bytes>,
    #[serde(default)]
    proof_upload: Option<ProofUpload>,
    signature: Signature64,
}

impl TryFrom<OpenRequestWire> for OpenRequest {
    type Error = &'static str;

    fn try_from(wire: OpenRequestWire) -> Result<Self, Self::Error> {
        let request = OpenRequest {
            protocol_version: wire.protocol_version,
            deployment_id: wire.deployment_id,
            gateway_id: wire.gateway_id,
            batch_id: wire.batch_id,
            root: wire.root,
            leaf_count: wire.leaf_count,
            proof_epoch: wire.proof_epoch,
            session_pub: wire.session_pub,
            price_table_hash: wire.price_table_hash,
            proof: wire.proof,
            proof_upload: wire.proof_upload,
            signature: wire.signature,
        };
        request.proof_source()?;
        Ok(request)
    }
}

impl OpenRequest {
    /// The proof source. Exactly one of `proof` and `proof_upload` must be set.
    pub fn proof_source(&self) -> Result<ProofSource<'_>, &'static str> {
        match (&self.proof, &self.proof_upload) {
            (Some(proof), None) => Ok(ProofSource::Inline(&proof.0)),
            (None, Some(upload)) => Ok(ProofSource::Upload(upload)),
            (Some(_), Some(_)) => Err("open request has both proof and proof_upload"),
            (None, None) => Err("open request has neither proof nor proof_upload"),
        }
    }

    /// The signing message of this request.
    pub fn message(&self) -> OpenMessage {
        OpenMessage {
            deployment_id: self.deployment_id,
            gateway_id: self.gateway_id,
            batch_id: self.batch_id,
            root: self.root,
            leaf_count: self.leaf_count,
            proof_epoch: self.proof_epoch.0,
            session_pub: self.session_pub,
            price_table_hash: self.price_table_hash,
        }
    }
}

/// Life-cycle state of a session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    /// The session has units and its deadline has not passed.
    Active,
    /// The session has no units.
    Exhausted,
    /// The session deadline has passed.
    Expired,
}

impl SessionStatus {
    /// Wire name of the state.
    pub const fn as_str(self) -> &'static str {
        match self {
            SessionStatus::Active => "active",
            SessionStatus::Exhausted => "exhausted",
            SessionStatus::Expired => "expired",
        }
    }
}

/// State of one session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionState {
    /// Public batch ID.
    pub batch_id: Bytes32,
    /// Session Ed25519 public key.
    pub session_pub: Bytes32,
    /// Price table hash that the session froze at open.
    pub price_table_hash: Bytes32,
    /// Units that remain.
    pub remaining: u32,
    /// Cumulative units charged.
    pub units_total: DecimalU64,
    /// Next sequence number.
    pub next_seq: DecimalU64,
    /// Epoch of the open.
    pub open_epoch: DecimalU64,
    /// Last epoch in which the session can spend.
    pub deadline_epoch: DecimalU64,
    /// Life-cycle state.
    pub state: SessionStatus,
}

/// `POST /v1/open` response body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpenResponse {
    /// Session state.
    pub session: SessionState,
    /// `true` if the request was an exact retry and the session already existed.
    pub existing: bool,
}

/// `POST /v1/rpc` request body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpendRequest {
    /// Protocol version. Must equal [`crate::PROTOCOL_VERSION`].
    pub protocol_version: u16,
    /// Public batch ID of the session.
    pub batch_id: Bytes32,
    /// Sequence number.
    pub seq: DecimalU64,
    /// Cumulative units charged, including this request.
    pub units_total: DecimalU64,
    /// Exact UTF-8 bytes of one JSON-RPC object.
    pub rpc: Base64Bytes,
    /// Ed25519 signature over [`SpendMessage::digest`] with the session key.
    pub signature: Signature64,
}

impl SpendRequest {
    /// The signing message of this request. The deployment ID, gateway ID, and price table
    /// hash come from the gateway configuration and the session.
    pub fn message(
        &self,
        deployment_id: Bytes32,
        gateway_id: Bytes32,
        price_table_hash: Bytes32,
    ) -> SpendMessage<'_> {
        SpendMessage {
            deployment_id,
            gateway_id,
            batch_id: self.batch_id,
            price_table_hash,
            seq: self.seq.0,
            units_total: self.units_total.0,
            rpc_bytes: &self.rpc.0,
        }
    }

    /// The digest of the signing message.
    pub fn digest(
        &self,
        deployment_id: Bytes32,
        gateway_id: Bytes32,
        price_table_hash: Bytes32,
    ) -> Result<Bytes32, SpendMessageError> {
        self.message(deployment_id, gateway_id, price_table_hash)
            .digest()
    }
}

/// Values of the `X-Anon-*` headers of a successful `POST /v1/rpc` response.
///
/// The body of a successful response is the raw JSON-RPC response bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpendResponseHeaders {
    /// Units that remain in the session.
    pub remaining: u32,
    /// Next sequence number of the session.
    pub next_seq: u64,
    /// `true` if the gateway served a stored response without a new charge.
    pub replayed: bool,
}

impl SpendResponseHeaders {
    /// Header names and values. Values are decimal integers or `true` / `false`.
    pub fn to_pairs(&self) -> [(&'static str, String); 3] {
        [
            (HEADER_REMAINING, self.remaining.to_string()),
            (HEADER_NEXT_SEQ, self.next_seq.to_string()),
            (HEADER_REPLAYED, self.replayed.to_string()),
        ]
    }
}

/// Metadata of one committed receipt. It has no response bytes and no RPC parameters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReceiptMetadata {
    /// Sequence number of the request.
    pub seq: DecimalU64,
    /// Digest of the spend message of the request.
    pub request_digest: Bytes32,
    /// Units charged for the request.
    pub units: u32,
    /// Cumulative units charged after the request.
    pub units_total: DecimalU64,
    /// Commit time in Unix seconds.
    pub committed_at: DecimalU64,
    /// `true` if the gateway still keeps the response bytes.
    pub response_retained: bool,
}

/// Error body of the gateway. It is [`ErrorBody`] with optional receipt metadata.
///
/// `response_expired` errors include the committed receipt of the sequence number.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GatewayErrorBody {
    /// Stable error code.
    pub code: ErrorCode,
    /// Safe message for people. Do not branch on it.
    pub message: String,
    /// Copy of [`ErrorCode::retryable`] for the code.
    pub retryable: bool,
    /// Committed receipt metadata, only for `response_expired`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt: Option<ReceiptMetadata>,
}

impl GatewayErrorBody {
    /// Make an error body without receipt metadata.
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: code.retryable(),
            receipt: None,
        }
    }
}

impl From<ErrorBody> for GatewayErrorBody {
    fn from(body: ErrorBody) -> Self {
        Self {
            code: body.code,
            message: body.message,
            retryable: body.retryable,
            receipt: None,
        }
    }
}

/// `POST /v1/session/status` request body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StatusRequest {
    /// Protocol version. Must equal [`crate::PROTOCOL_VERSION`].
    pub protocol_version: u16,
    /// Deployment ID. Must equal the gateway deployment ID.
    pub deployment_id: Bytes32,
    /// Gateway ID. Must equal the gateway ID of the deployment.
    pub gateway_id: Bytes32,
    /// Public batch ID of the session.
    pub batch_id: Bytes32,
    /// Random client nonce. The response echoes it.
    pub nonce: Bytes32,
    /// Ed25519 signature over [`StatusMessage::digest`] with the session key.
    pub signature: Signature64,
}

impl StatusRequest {
    /// The signing message of this request.
    pub fn message(&self) -> StatusMessage {
        StatusMessage {
            deployment_id: self.deployment_id,
            gateway_id: self.gateway_id,
            batch_id: self.batch_id,
            nonce: self.nonce,
        }
    }
}

/// `POST /v1/session/status` response body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StatusResponse {
    /// Session state.
    pub session: SessionState,
    /// Current gateway epoch.
    pub current_epoch: DecimalU64,
    /// Metadata of the receipt with the highest sequence number, or `null`.
    pub latest_receipt: Option<ReceiptMetadata>,
    /// The nonce of the request.
    pub nonce: Bytes32,
}

/// Published resource limits of the gateway.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GatewayLimits {
    /// Largest `POST /v1/open` body in bytes.
    pub open_body_bytes: u32,
    /// Largest `POST /v1/rpc` and `POST /v1/session/status` body in bytes.
    pub spend_body_bytes: u32,
    /// Largest upstream response in bytes.
    pub upstream_response_bytes: u32,
    /// Upstream timeout in milliseconds.
    pub upstream_timeout_ms: u32,
    /// Proof verifications that run at the same time.
    pub proof_verify_concurrency: u32,
    /// Open requests that can wait for a proof verification slot.
    pub proof_queue_depth: u32,
    /// Time in seconds for which the gateway keeps response bytes after commit.
    pub response_retention_seconds: u32,
    /// Time in milliseconds that a request waits for the batch lock.
    pub batch_lock_wait_ms: u32,
    /// Largest chunked proof upload in bytes. Also the largest proof after decompression.
    pub open_upload_max_bytes: u32,
    /// Largest raw data of one chunk in bytes. The client plans its chunks with this value.
    pub open_upload_chunk_bytes: u32,
    /// Largest `PUT /v1/open/chunks/...` body in bytes.
    pub open_upload_chunk_body_bytes: u32,
    /// Largest number of chunks of one upload.
    pub open_upload_max_chunks: u32,
    /// Time in seconds that the gateway keeps an upload that no open request used.
    pub open_upload_ttl_seconds: u32,
    /// Largest number of pending uploads.
    pub open_upload_max_pending: u32,
    /// Largest sum of the declared sizes of all pending uploads in bytes.
    pub open_upload_max_pending_bytes: u32,
}

/// `GET /v1/config` response body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GatewayConfigResponse {
    /// Protocol version.
    pub protocol_version: u16,
    /// Deployment ID.
    pub deployment_id: Bytes32,
    /// Gateway ID.
    pub gateway_id: Bytes32,
    /// Circuit ID (first public input of the batch-open circuit).
    pub circuit_id: Bytes32,
    /// Digest of the pinned verifier artifact.
    pub verifier_artifact_hash: Bytes32,
    /// Chain ID of payments and roots. At most `2^53 - 1`.
    pub payment_chain_id: u64,
    /// Chain ID of the upstream RPC. At most `2^53 - 1`.
    pub upstream_chain_id: u64,
    /// Address of the `RootRegistry` contract.
    pub root_registry_address: Address,
    /// Epoch length in seconds.
    pub epoch_seconds: u32,
    /// Current epoch.
    pub current_epoch: DecimalU64,
    /// Number of source epochs for which the gateway accepts a root.
    pub root_window_epochs: u32,
    /// Session lifetime in epochs: `deadline_epoch = open_epoch + session_lifetime_epochs`.
    pub session_lifetime_epochs: u32,
    /// Units in one batch.
    pub batch_size: u32,
    /// Hash of the current price table.
    pub price_table_hash: Bytes32,
    /// Resource limits.
    pub limits: GatewayLimits,
    /// `true` if `GET /v1/demo/peer` is available.
    pub demo_peer_enabled: bool,
    /// Block tag of the root source (`BLOCK_TAG`). Production: `finalized`. `latest` trades
    /// reorg safety for speed: testnet only.
    pub block_tag: crate::settings::BlockTag,
}

/// `GET /v1/prices` response body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PricesResponse {
    /// `keccak256` of the canonical encoding of `price_table`.
    pub price_table_hash: Bytes32,
    /// The current price table.
    pub price_table: PriceTable,
}

/// One root that the gateway accepts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcceptedRoot {
    /// Epoch for which the issuer published the root.
    pub source_epoch: DecimalU64,
    /// MMR root (canonical field element).
    pub root: Bytes32,
    /// Leaf count of the root.
    pub leaf_count: u32,
}

/// `GET /v1/roots` response body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RootsResponse {
    /// Current epoch.
    pub current_epoch: DecimalU64,
    /// Number of source epochs for which the gateway accepts a root.
    pub root_window_epochs: u32,
    /// Accepted roots, newest source epoch first.
    pub roots: Vec<AcceptedRoot>,
}

/// How the gateway found the observed source address.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IpAttribution {
    /// The socket peer address of the connection.
    Socket,
    /// The forwarding header of a trusted proxy.
    TrustedProxy,
    /// IP capture is off. The gateway did not record an address.
    Unavailable,
}

/// `GET /v1/demo/peer` response body. Only the demo profile has this endpoint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DemoPeerResponse {
    /// Observed source address.
    pub observed_ip: String,
    /// Source of the attribution.
    pub attribution: IpAttribution,
    /// Socket peer address of the trusted proxy, if a trusted proxy forwarded the request.
    pub proxy_hop: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spend_headers_use_decimal_text() {
        let pairs = SpendResponseHeaders {
            remaining: 96,
            next_seq: 3,
            replayed: false,
        }
        .to_pairs();
        assert_eq!(pairs[0], (HEADER_REMAINING, "96".to_owned()));
        assert_eq!(pairs[1], (HEADER_NEXT_SEQ, "3".to_owned()));
        assert_eq!(pairs[2], (HEADER_REPLAYED, "false".to_owned()));
    }

    #[test]
    fn error_body_omits_absent_receipt() {
        let body = GatewayErrorBody::new(ErrorCode::Busy, "later");
        let json = serde_json::to_string(&body).unwrap();
        assert_eq!(
            json,
            r#"{"code":"busy","message":"later","retryable":true}"#
        );
        let back: ErrorBody = serde_json::from_str(&json).unwrap();
        assert_eq!(back.code, ErrorCode::Busy);
    }
    #[test]
    fn chunk_path_round_trip_and_strict_parsing() {
        let path = OpenChunkPath {
            batch_id: Bytes32([0x0a; 32]),
            proof_sha256: Bytes32([0xff; 32]),
            total_bytes: 318_335,
            chunk_count: 8,
            chunk_index: 7,
        };
        let text = path.to_path();
        assert_eq!(
            text,
            format!(
                "/v1/open/chunks/0x{}/0x{}/318335/8/7",
                "0a".repeat(32),
                "ff".repeat(32)
            )
        );
        assert_eq!(OpenChunkPath::parse(&text), Ok(path));
        let largest = OpenChunkPath {
            total_bytes: u32::MAX,
            chunk_count: u32::MAX,
            chunk_index: u32::MAX,
            ..path
        };
        assert_eq!(OpenChunkPath::parse(&largest.to_path()), Ok(largest));
        // The path is short; with the headers it stays far below the Nox margin of
        // 48,000 - OPEN_CHUNK_BODY_LIMIT_BYTES bytes.
        assert!(largest.to_path().len() < 200);
        const { assert!(OPEN_CHUNK_BODY_LIMIT_BYTES <= 44_000) };
        const { assert!(OPEN_CHUNK_BODY_LIMIT_BYTES >= OPEN_CHUNK_MAX_BYTES) };

        let hex = |b: &str| format!("0x{}", b.repeat(32));
        let bad = [
            ("/v1/open/chunks".to_owned(), ChunkPathError::Shape),
            (
                format!("/v1/open/chunks/{}/{}/1/1", hex("0a"), hex("ff")),
                ChunkPathError::Shape,
            ),
            (
                format!("/v1/open/chunks/{}/{}/1/1/0/", hex("0a"), hex("ff")),
                ChunkPathError::Shape,
            ),
            (
                format!("/v1/open/chunk/{}/{}/1/1/0", hex("0a"), hex("ff")),
                ChunkPathError::Shape,
            ),
            (
                format!("/v1/open/chunks/{}/{}/1/1/0", hex("0A"), hex("ff")),
                ChunkPathError::Hex,
            ),
            (
                format!("/v1/open/chunks/{}/{}/1/1/0", "0a".repeat(32), hex("ff")),
                ChunkPathError::Hex,
            ),
            (
                format!("/v1/open/chunks/{}/{}/01/1/0", hex("0a"), hex("ff")),
                ChunkPathError::Number,
            ),
            (
                format!("/v1/open/chunks/{}/{}/+1/1/0", hex("0a"), hex("ff")),
                ChunkPathError::Number,
            ),
            (
                format!("/v1/open/chunks/{}/{}/1/1/-1", hex("0a"), hex("ff")),
                ChunkPathError::Number,
            ),
            (
                format!("/v1/open/chunks/{}/{}/4294967296/1/0", hex("0a"), hex("ff")),
                ChunkPathError::Number,
            ),
            (
                format!("/v1/open/chunks/{}/{}//1/0", hex("0a"), hex("ff")),
                ChunkPathError::Number,
            ),
        ];
        for (text, error) in bad {
            assert_eq!(OpenChunkPath::parse(&text), Err(error), "{text}");
        }
    }

    fn open_json(proof: Option<&str>, upload: bool) -> String {
        let mut value = serde_json::json!({
            "protocol_version": 1,
            "deployment_id": format!("0x{}", "11".repeat(32)),
            "gateway_id": format!("0x{}", "22".repeat(32)),
            "batch_id": format!("0x{}", "03".repeat(32)),
            "root": format!("0x{}", "04".repeat(32)),
            "leaf_count": 5,
            "proof_epoch": "6",
            "session_pub": format!("0x{}", "77".repeat(32)),
            "price_table_hash": format!("0x{}", "88".repeat(32)),
            "signature": "A".repeat(86) + "==",
        });
        if let Some(proof) = proof {
            value["proof"] = serde_json::Value::String(proof.to_owned());
        }
        if upload {
            value["proof_upload"] = serde_json::json!({
                "proof_sha256": format!("0x{}", "99".repeat(32)),
                "total_bytes": 300000,
                "proof_encoding": "json+gzip",
            });
        }
        value.to_string()
    }

    #[test]
    fn open_request_needs_exactly_one_proof_source() {
        let inline: OpenRequest = serde_json::from_str(&open_json(Some("AQID"), false)).unwrap();
        assert_eq!(inline.proof_source(), Ok(ProofSource::Inline(&[1, 2, 3])));
        let upload: OpenRequest = serde_json::from_str(&open_json(None, true)).unwrap();
        let Ok(ProofSource::Upload(reference)) = upload.proof_source() else {
            panic!("expected an upload");
        };
        assert_eq!(reference.proof_encoding, ProofEncoding::JsonGzip);
        assert_eq!(reference.total_bytes, 300_000);
        // Serialization omits the absent source.
        let back = serde_json::to_value(&upload).unwrap();
        assert!(back.get("proof").is_none());
        assert!(serde_json::from_str::<OpenRequest>(&open_json(Some("AQID"), true)).is_err());
        assert!(serde_json::from_str::<OpenRequest>(&open_json(None, false)).is_err());
    }

    #[test]
    fn proof_encoding_names() {
        for encoding in [
            ProofEncoding::Np,
            ProofEncoding::Json,
            ProofEncoding::JsonGzip,
        ] {
            let json = serde_json::to_string(&encoding).unwrap();
            assert_eq!(json, format!("\"{}\"", encoding.as_str()));
        }
        assert!(serde_json::from_str::<ProofEncoding>("\"gzip\"").is_err());
    }
}

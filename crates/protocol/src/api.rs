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

/// `POST /v1/open` request body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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
    /// Proof bytes.
    pub proof: Base64Bytes,
    /// Ed25519 signature over [`OpenMessage::digest`] with the session key.
    pub signature: Signature64,
}

impl OpenRequest {
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
}

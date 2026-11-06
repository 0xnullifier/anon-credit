//! JSON envelopes of the gateway admin API (implementation.md sections 10 and 14).
//!
//! The admin API runs on a separate private listener with a bearer token. The rules of
//! [`crate::api`] apply: unknown fields are rejected, `u64` values are decimal strings, and
//! IDs are canonical hex. Optional values are `null`; they are never omitted.
//!
//! Events and snapshots have no keys, proofs, tokens, RPC parameters, or RPC results.
//! The observed source IP is `"unavailable"` unless the demo profile turns on IP capture.

use crate::api::{IpAttribution, ReceiptMetadata, SessionState};
use crate::error::ErrorCode;
use crate::hex_bytes::Bytes32;
use crate::wire::DecimalU64;
use serde::{Deserialize, Serialize};

/// Value of the observed IP field when IP capture is off.
pub const IP_UNAVAILABLE: &str = "unavailable";

/// Kind of a gateway event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    /// The gateway received an open request.
    OpenReceived,
    /// The proof of an open request verified.
    OpenVerified,
    /// The gateway rejected an open request.
    OpenRejected,
    /// The gateway committed a new session, or returned the session of an exact retry.
    SessionOpened,
    /// The gateway received a spend request.
    RpcReceived,
    /// The gateway committed a debit and returned the upstream response.
    RpcCompleted,
    /// The gateway returned a stored response without a new debit.
    RpcReplayed,
    /// The gateway rejected a spend request.
    RpcRejected,
    /// The upstream call failed. The gateway did not charge units.
    UpstreamFailed,
    /// The debit commit failed. The gateway did not return the response.
    StorageFailed,
}

impl EventKind {
    /// All event kinds, in declaration order.
    pub const ALL: [EventKind; 10] = [
        EventKind::OpenReceived,
        EventKind::OpenVerified,
        EventKind::OpenRejected,
        EventKind::SessionOpened,
        EventKind::RpcReceived,
        EventKind::RpcCompleted,
        EventKind::RpcReplayed,
        EventKind::RpcRejected,
        EventKind::UpstreamFailed,
        EventKind::StorageFailed,
    ];

    /// Wire name of the kind.
    pub const fn as_str(self) -> &'static str {
        match self {
            EventKind::OpenReceived => "open_received",
            EventKind::OpenVerified => "open_verified",
            EventKind::OpenRejected => "open_rejected",
            EventKind::SessionOpened => "session_opened",
            EventKind::RpcReceived => "rpc_received",
            EventKind::RpcCompleted => "rpc_completed",
            EventKind::RpcReplayed => "rpc_replayed",
            EventKind::RpcRejected => "rpc_rejected",
            EventKind::UpstreamFailed => "upstream_failed",
            EventKind::StorageFailed => "storage_failed",
        }
    }
}

/// One diagnostic event of the gateway. Events are not the durable receipt ledger.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GatewayEvent {
    /// Monotonic event ID. It is also the Server-Sent Events `id`.
    pub id: DecimalU64,
    /// Event time in Unix milliseconds (UTC).
    pub at_ms: DecimalU64,
    /// Event kind.
    pub kind: EventKind,
    /// Batch ID, if the request has one.
    pub batch_id: Option<Bytes32>,
    /// Sequence number of a spend request.
    pub seq: Option<DecimalU64>,
    /// JSON-RPC method name. Never the parameters.
    pub method: Option<String>,
    /// Error code of a rejection or failure.
    pub error_code: Option<ErrorCode>,
    /// Processing time in milliseconds.
    pub latency_ms: Option<u32>,
    /// Units charged.
    pub units: Option<u32>,
    /// Units that remain after the event.
    pub remaining: Option<u32>,
    /// Request body size in bytes.
    pub request_bytes: Option<u32>,
    /// Response body or proof size in bytes.
    pub response_bytes: Option<u32>,
    /// Observed source IP, or `"unavailable"`.
    pub observed_ip: String,
    /// Source of the observed IP.
    pub ip_attribution: IpAttribution,
    /// Socket address of the trusted proxy hop, if a trusted proxy forwarded the request.
    pub proxy_hop: Option<String>,
}

/// Event counters since the gateway process started.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventCounters {
    /// Open requests received.
    pub open_received: DecimalU64,
    /// Open requests rejected.
    pub open_rejected: DecimalU64,
    /// Sessions committed (exact retries are not counted).
    pub sessions_opened: DecimalU64,
    /// Spend requests received.
    pub rpc_received: DecimalU64,
    /// Spend requests completed with a committed debit.
    pub rpc_completed: DecimalU64,
    /// Stored responses served again.
    pub rpc_replayed: DecimalU64,
    /// Spend requests rejected.
    pub rpc_rejected: DecimalU64,
    /// Upstream failures.
    pub upstream_failed: DecimalU64,
    /// Debit commit failures.
    pub storage_failed: DecimalU64,
    /// Units charged by committed debits.
    pub units_charged: DecimalU64,
}

/// Status of the accepted roots.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RootStatus {
    /// Number of roots in the acceptance window.
    pub accepted: u32,
    /// Newest accepted source epoch.
    pub latest_source_epoch: Option<DecimalU64>,
    /// Current epoch minus the newest accepted source epoch.
    pub latest_age_epochs: Option<DecimalU64>,
    /// Time of the last successful refresh in Unix seconds.
    pub last_refresh_at: Option<DecimalU64>,
    /// Safe text of the last refresh failure, if the last refresh failed.
    pub last_error: Option<String>,
}

/// Status of the proof verifier sidecar, read at startup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VerifierStatus {
    /// SHA-256 of the verifier key that the sidecar loaded.
    pub pkv_sha256: String,
    /// Circuit name or ID that the sidecar reports.
    pub circuit_id: String,
    /// Witness commitment mode. The gateway requires `zk`.
    pub witness_mode: String,
}

/// Session totals from the gateway database.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionTotals {
    /// Sessions with units before their deadline.
    pub active: DecimalU64,
    /// Sessions with no units.
    pub exhausted: DecimalU64,
    /// Sessions after their deadline.
    pub expired: DecimalU64,
    /// Units charged in all retained sessions.
    pub units_charged: DecimalU64,
}

/// Summary of one session for the admin views.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionSummary {
    /// Session state.
    pub session: SessionState,
    /// Open time in Unix seconds.
    pub opened_at: DecimalU64,
    /// Open proof size in bytes.
    pub proof_size: u32,
    /// Proof verification time in milliseconds.
    pub verify_ms: u32,
}

/// `GET /admin/v1/snapshot` response body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AdminSnapshot {
    /// `ok` while the gateway serves requests.
    pub status: String,
    /// Process start time in Unix seconds.
    pub started_at: DecimalU64,
    /// Snapshot time in Unix seconds.
    pub now: DecimalU64,
    /// Current epoch.
    pub current_epoch: DecimalU64,
    /// Deployment ID.
    pub deployment_id: Bytes32,
    /// Gateway ID.
    pub gateway_id: Bytes32,
    /// Chain ID of the upstream RPC.
    pub upstream_chain_id: u64,
    /// `true` if the demo profile captures the observed source IP.
    pub demo_ip_logging: bool,
    /// Proof verifier status.
    pub verifier: VerifierStatus,
    /// Root status.
    pub roots: RootStatus,
    /// Event counters since start.
    pub counters: EventCounters,
    /// Session totals.
    pub sessions: SessionTotals,
    /// Most recent events, oldest first.
    pub recent_events: Vec<GatewayEvent>,
    /// Most recently opened sessions, newest first.
    pub recent_sessions: Vec<SessionSummary>,
}

/// Receipt metadata with the method name, for the admin session view.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AdminReceipt {
    /// Receipt metadata.
    pub receipt: ReceiptMetadata,
    /// JSON-RPC method name.
    pub method: String,
}

/// `GET /admin/v1/sessions/{batch_id}` response body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionDetail {
    /// Session summary.
    pub summary: SessionSummary,
    /// Most recent receipts, newest first.
    pub receipts: Vec<AdminReceipt>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_kind_names_match_as_str() {
        for kind in EventKind::ALL {
            let json = serde_json::to_string(&kind).unwrap();
            assert_eq!(json, format!("\"{}\"", kind.as_str()));
        }
    }
}

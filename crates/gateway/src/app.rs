//! Gateway state and HTTP routers.
//!
//! The public router serves `/v1/*`. The admin router serves `/admin/v1/*` on a separate
//! listener with a bearer token. The public listener does not have the admin routes.

use crate::clock::Clock;
use crate::epoch::{SESSION_LIFETIME_EPOCHS, epoch_of};
use crate::error::ApiError;
use crate::events::EventBus;
use crate::locks::BatchLocks;
use crate::peer::PeerPolicy;
use crate::roots::RootTracker;
use crate::store::{ReceiptRow, SessionRow, Store, StoredState};
use crate::upload::{UploadLimits, UploadStore};
use crate::upstream::Upstream;
use crate::verifier::{ProofVerifier, VerifyQueue};
use crate::{admin, open, public, spend, status, upload};
use anon_credit_protocol::admin::VerifierStatus;
use anon_credit_protocol::api::{
    GatewayLimits, OPEN_CHUNK_BODY_LIMIT_BYTES, OPEN_CHUNK_MAX_BYTES, ReceiptMetadata,
    SPEND_RESPONSE_HEADERS, SessionState, SessionStatus,
};
use anon_credit_protocol::{Bytes32, DecimalU64, DeploymentConfig, ErrorCode, PriceTable};
use axum::Router;
use axum::body::Bytes;
use axum::extract::DefaultBodyLimit;
use axum::extract::rejection::BytesRejection;
use axum::http::{HeaderName, HeaderValue, Method, StatusCode, header};
use axum::routing::{get, post, put};
use std::sync::Arc;
use std::time::Duration;
use tower_http::cors::{AllowOrigin, CorsLayer};

/// Resource limits (implementation.md section 12).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Limits {
    /// Largest open request body.
    pub open_body_bytes: usize,
    /// Largest spend and status request body.
    pub spend_body_bytes: usize,
    /// Largest upstream response.
    pub upstream_response_bytes: usize,
    /// Upstream timeout.
    pub upstream_timeout: Duration,
    /// Proof verifications that run at the same time.
    pub proof_concurrency: usize,
    /// Open requests that wait for a verification slot.
    pub proof_queue_depth: usize,
    /// Time for which the gateway keeps response bytes after commit.
    pub response_retention_secs: u64,
    /// Time that a spend request waits for the batch lock.
    pub batch_lock_wait: Duration,
    /// Limits of chunked proof uploads (`PUT /v1/open/chunks`).
    pub upload: UploadLimits,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            open_body_bytes: 16 * 1024 * 1024,
            spend_body_bytes: 64 * 1024,
            upstream_response_bytes: 1024 * 1024,
            upstream_timeout: Duration::from_secs(15),
            proof_concurrency: 2,
            proof_queue_depth: 8,
            response_retention_secs: 60,
            batch_lock_wait: Duration::from_secs(5),
            upload: UploadLimits::default(),
        }
    }
}

fn clamp_u32(value: u128) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

impl Limits {
    /// Wire form for `GET /v1/config`.
    pub fn to_api(&self) -> GatewayLimits {
        GatewayLimits {
            open_body_bytes: clamp_u32(self.open_body_bytes as u128),
            spend_body_bytes: clamp_u32(self.spend_body_bytes as u128),
            upstream_response_bytes: clamp_u32(self.upstream_response_bytes as u128),
            upstream_timeout_ms: clamp_u32(self.upstream_timeout.as_millis()),
            proof_verify_concurrency: clamp_u32(self.proof_concurrency as u128),
            proof_queue_depth: clamp_u32(self.proof_queue_depth as u128),
            response_retention_seconds: clamp_u32(u128::from(self.response_retention_secs)),
            batch_lock_wait_ms: clamp_u32(self.batch_lock_wait.as_millis()),
            open_upload_max_bytes: clamp_u32(self.upload.max_bytes as u128),
            open_upload_chunk_bytes: clamp_u32(OPEN_CHUNK_MAX_BYTES as u128),
            open_upload_chunk_body_bytes: clamp_u32(OPEN_CHUNK_BODY_LIMIT_BYTES as u128),
            open_upload_max_chunks: self.upload.max_chunks,
            open_upload_ttl_seconds: clamp_u32(u128::from(self.upload.ttl_secs)),
            open_upload_max_pending: clamp_u32(self.upload.max_pending as u128),
            open_upload_max_pending_bytes: clamp_u32(self.upload.max_pending_bytes as u128),
        }
    }
}

/// Fixed configuration of a running gateway.
#[derive(Debug, Clone)]
pub struct GatewayConfig {
    /// Deployment configuration.
    pub deployment: DeploymentConfig,
    /// `deployment_id` of the deployment.
    pub deployment_id: Bytes32,
    /// Current price table. New sessions freeze its hash.
    pub prices: PriceTable,
    /// Hash of the current price table.
    pub price_table_hash: Bytes32,
    /// Resource limits.
    pub limits: Limits,
    /// Chain ID of the upstream RPC, checked at startup.
    pub upstream_chain_id: u64,
    /// Admin bearer token. Secret.
    pub admin_token: String,
    /// Allowed CORS origins.
    pub cors_origins: Vec<HeaderValue>,
}

impl GatewayConfig {
    /// Make a configuration. The price table must be valid.
    pub fn new(
        deployment: DeploymentConfig,
        prices: PriceTable,
        limits: Limits,
        upstream_chain_id: u64,
        admin_token: String,
        cors_origins: Vec<HeaderValue>,
    ) -> Self {
        Self {
            deployment_id: deployment.deployment_id(),
            price_table_hash: prices.hash(),
            deployment,
            prices,
            limits,
            upstream_chain_id,
            admin_token,
            cors_origins,
        }
    }

    /// Gateway ID of the deployment.
    pub fn gateway_id(&self) -> Bytes32 {
        self.deployment.gateway_id
    }
}

/// Parts that the gateway needs. Tests give fakes for each adapter.
pub struct GatewayParts {
    /// Fixed configuration.
    pub config: GatewayConfig,
    /// Database.
    pub store: Store,
    /// Clock.
    pub clock: Arc<dyn Clock>,
    /// Accepted roots.
    pub roots: RootTracker,
    /// Proof verifier.
    pub verifier: Arc<dyn ProofVerifier>,
    /// Verifier status from the startup check.
    pub verifier_status: VerifierStatus,
    /// Upstream JSON-RPC node.
    pub upstream: Arc<dyn Upstream>,
    /// Observed source address rules.
    pub peer: PeerPolicy,
}

/// The running gateway.
pub struct Gateway {
    /// Fixed configuration.
    pub config: GatewayConfig,
    /// Database.
    pub store: Store,
    /// Clock.
    pub clock: Arc<dyn Clock>,
    /// Accepted roots.
    pub roots: RootTracker,
    /// Proof verifier.
    pub verifier: Arc<dyn ProofVerifier>,
    /// Verifier status from the startup check.
    pub verifier_status: VerifierStatus,
    /// Bounded proof verification queue.
    pub verify_queue: VerifyQueue,
    /// Upstream JSON-RPC node.
    pub upstream: Arc<dyn Upstream>,
    /// Diagnostic events.
    pub events: EventBus,
    /// Per-batch locks.
    pub locks: BatchLocks,
    /// Pending chunked proof uploads.
    pub uploads: UploadStore,
    /// Observed source address rules.
    pub peer: PeerPolicy,
    /// Start time in Unix seconds.
    pub started_at: u64,
}

/// Shared handle of the gateway.
pub type SharedGateway = Arc<Gateway>;

impl Gateway {
    /// Make the gateway from its parts.
    pub fn new(parts: GatewayParts) -> SharedGateway {
        let limits = &parts.config.limits;
        let verify_queue = VerifyQueue::new(limits.proof_concurrency, limits.proof_queue_depth);
        Arc::new(Self {
            started_at: parts.clock.now_unix(),
            events: EventBus::new(Arc::clone(&parts.clock)),
            verify_queue,
            locks: BatchLocks::new(),
            uploads: UploadStore::new(limits.upload),
            config: parts.config,
            store: parts.store,
            clock: parts.clock,
            roots: parts.roots,
            verifier: parts.verifier,
            verifier_status: parts.verifier_status,
            upstream: parts.upstream,
            peer: parts.peer,
        })
    }

    /// The current epoch.
    pub fn current_epoch(&self) -> u64 {
        // The deployment check rejects a zero epoch length, so the division is defined.
        epoch_of(self.clock.now_unix(), self.config.deployment.epoch_seconds).unwrap_or(0)
    }

    /// Wire state of a session row at `current_epoch`.
    pub fn session_state(&self, row: &SessionRow, current_epoch: u64) -> SessionState {
        let state = match (current_epoch > row.deadline_epoch, row.state) {
            (true, _) => SessionStatus::Expired,
            (false, StoredState::Active) => SessionStatus::Active,
            (false, StoredState::Exhausted) => SessionStatus::Exhausted,
        };
        SessionState {
            batch_id: row.batch_id,
            session_pub: row.session_pub,
            price_table_hash: row.price_table_hash,
            remaining: row.remaining,
            units_total: DecimalU64(row.units_total),
            next_seq: DecimalU64(row.next_seq),
            open_epoch: DecimalU64(row.open_epoch),
            deadline_epoch: DecimalU64(row.deadline_epoch),
            state,
        }
    }

    /// `true` if the response bytes of a receipt are still retained at `now_unix`.
    pub fn response_retained(&self, row: &ReceiptRow, now_unix: u64) -> bool {
        row.response_bytes.is_some()
            && now_unix
                < row
                    .committed_at
                    .saturating_add(self.config.limits.response_retention_secs)
    }

    /// Wire metadata of a receipt.
    pub fn receipt_metadata(&self, row: &ReceiptRow, now_unix: u64) -> ReceiptMetadata {
        ReceiptMetadata {
            seq: DecimalU64(row.seq),
            request_digest: row.request_digest,
            units: row.units,
            units_total: DecimalU64(row.units_total),
            committed_at: DecimalU64(row.committed_at),
            response_retained: self.response_retained(row, now_unix),
        }
    }
}

/// Session lifetime as a `u32` for the API.
pub const SESSION_LIFETIME_EPOCHS_U32: u32 = SESSION_LIFETIME_EPOCHS as u32;

/// Map a body extraction failure to an API error.
pub fn body_error(rejection: &BytesRejection) -> ApiError {
    match rejection.status() {
        StatusCode::PAYLOAD_TOO_LARGE => ApiError::body_too_large(),
        _ => ApiError::new(ErrorCode::InvalidRequest, "request body is not readable"),
    }
}

/// Read the body, or map the failure.
pub fn read_body(body: Result<Bytes, BytesRejection>) -> Result<Bytes, ApiError> {
    body.map_err(|rejection| body_error(&rejection))
}

fn cors(origins: &[HeaderValue], admin: bool) -> CorsLayer {
    let mut layer = CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins.iter().cloned()))
        .allow_methods([Method::GET, Method::POST, Method::PUT]);
    match admin {
        true => {
            layer = layer.allow_headers([
                header::AUTHORIZATION,
                header::CONTENT_TYPE,
                HeaderName::from_static("last-event-id"),
            ]);
        }
        false => {
            let exposed: Vec<HeaderName> = SPEND_RESPONSE_HEADERS
                .iter()
                .map(|name| HeaderName::from_static(name))
                .collect();
            layer = layer
                .allow_headers([header::CONTENT_TYPE])
                .expose_headers(exposed);
        }
    }
    layer
}

/// Router of the public API.
pub fn public_router(gateway: SharedGateway) -> Router {
    let limits = &gateway.config.limits;
    let mut router = Router::new()
        .route("/v1/config", get(public::config))
        .route("/v1/prices", get(public::prices))
        .route("/v1/roots", get(public::roots))
        .route(
            "/v1/open",
            post(open::open).layer(DefaultBodyLimit::max(limits.open_body_bytes)),
        )
        .route(
            "/v1/open/chunks",
            put(upload::put_chunk).layer(DefaultBodyLimit::max(OPEN_CHUNK_BODY_LIMIT_BYTES)),
        )
        .route(
            "/v1/rpc",
            post(spend::spend).layer(DefaultBodyLimit::max(limits.spend_body_bytes)),
        )
        .route(
            "/v1/session/status",
            post(status::status).layer(DefaultBodyLimit::max(limits.spend_body_bytes)),
        );
    if gateway.peer.captures() {
        router = router.route("/v1/demo/peer", get(public::demo_peer));
    }
    router
        .layer(cors(&gateway.config.cors_origins, false))
        .with_state(gateway)
}

/// Router of the admin API. Every route needs the bearer token.
pub fn admin_router(gateway: SharedGateway) -> Router {
    Router::new()
        .route("/admin/v1/snapshot", get(admin::snapshot))
        .route("/admin/v1/events", get(admin::events))
        .route("/admin/v1/sessions/{batch_id}", get(admin::session))
        .layer(axum::middleware::from_fn_with_state(
            Arc::clone(&gateway),
            admin::require_token,
        ))
        .layer(cors(&gateway.config.cors_origins, true))
        .with_state(gateway)
}

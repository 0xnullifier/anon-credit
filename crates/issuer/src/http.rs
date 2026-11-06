//! The issuer HTTP API (implementation.md section 10). All paths have the `/v1` prefix.
//!
//! | Method | Path | Body |
//! |---|---|---|
//! | GET | `/v1/config` | [`IssuerConfigResponse`] |
//! | POST | `/v1/topups` | [`TopupRequest`] in, [`TopupResponse`] out |
//! | GET | `/v1/topups/:tx_hash/:log_index` | [`TopupResponse`] |
//! | GET | `/v1/roots?from=E&limit=N` | [`IssuerRootsResponse`] |
//! | GET | `/v1/tree/path/:leaf_index?root=R` | [`TreePathResponse`] |
//! | GET | `/v1/epoch` | [`EpochResponse`] |
//! | GET | `/v1/events/leaves?from=N&limit=L` | [`LeafEventsResponse`] |
//! | GET | `/v1/events/roots?from=E&limit=L` | [`RootEventsResponse`] |
//!
//! Errors use [`ErrorBody`] with a stable code. Unknown body fields and unknown query
//! parameters are rejected. CORS allows any origin for `GET` only, because the browser SDK
//! fetches paths and roots. The service does not record client addresses: the router does not
//! read the peer address, and the logs do not have it.
//!
//! [`IssuerConfigResponse`]: anon_credit_protocol::issuer_api::IssuerConfigResponse
//! [`IssuerRootsResponse`]: anon_credit_protocol::issuer_api::IssuerRootsResponse
//! [`EpochResponse`]: anon_credit_protocol::issuer_api::EpochResponse
//! [`LeafEventsResponse`]: anon_credit_protocol::issuer_api::LeafEventsResponse
//! [`RootEventsResponse`]: anon_credit_protocol::issuer_api::RootEventsResponse

use crate::chain::Chain;
use crate::service::{Service, ServiceError, TopupOutcome};
use crate::verify::PaymentKey;
use alloy::primitives::B256;
use anon_credit_crypto::FieldElement;
use anon_credit_protocol::error::{ErrorBody, ErrorCode};
use anon_credit_protocol::hex_bytes::Bytes32;
use anon_credit_protocol::issuer_api::{
    MAX_PAGE_LIMIT, TopupRequest, TopupResponse, TreePathResponse,
};
use anon_credit_protocol::wire::decode_decimal_u64;
use axum::extract::rejection::{JsonRejection, PathRejection, QueryRejection};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};

/// Largest request body in bytes. A top-up request is less than 200 bytes.
pub const MAX_BODY_BYTES: usize = 4 * 1024;

/// An error response with a status and an [`ErrorBody`].
#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    body: ErrorBody,
}

impl ApiError {
    fn new(status: StatusCode, code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            status,
            body: ErrorBody::new(code, message),
        }
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, ErrorCode::InvalidRequest, message)
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, ErrorCode::NotFound, message)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(self.body)).into_response()
    }
}

impl From<ServiceError> for ApiError {
    fn from(error: ServiceError) -> Self {
        match error {
            ServiceError::Busy => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ErrorCode::Busy,
                "too many tracked payments; try again later",
            ),
            ServiceError::Chain(chain) => {
                tracing::warn!(error = %chain, "chain request failed");
                Self::new(
                    StatusCode::BAD_GATEWAY,
                    ErrorCode::UpstreamFailed,
                    "the chain RPC request failed",
                )
            }
            other => {
                tracing::error!(error = %other, "issuer storage failure");
                Self::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    ErrorCode::StorageUnavailable,
                    "issuer storage is not available",
                )
            }
        }
    }
}

fn json_rejection(rejection: JsonRejection) -> ApiError {
    ApiError::invalid(format!(
        "request body is not valid: {}",
        rejection.body_text()
    ))
}

fn query_rejection(rejection: QueryRejection) -> ApiError {
    ApiError::invalid(format!("query is not valid: {}", rejection.body_text()))
}

fn path_rejection(rejection: PathRejection) -> ApiError {
    ApiError::invalid(format!("path is not valid: {}", rejection.body_text()))
}

/// Build the router.
pub fn router<C: Chain>(service: Arc<Service<C>>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET]);
    Router::new()
        .route("/v1/config", get(config::<C>))
        .route("/v1/topups", post(submit_topup::<C>))
        .route("/v1/topups/{tx_hash}/{log_index}", get(topup_status::<C>))
        .route("/v1/roots", get(roots::<C>))
        .route("/v1/tree/path/{leaf_index}", get(tree_path::<C>))
        .route("/v1/epoch", get(epoch::<C>))
        .route("/v1/events/leaves", get(leaf_events::<C>))
        .route("/v1/events/roots", get(root_events::<C>))
        .fallback(not_found)
        .method_not_allowed_fallback(method_not_allowed)
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .layer(cors)
        .with_state(service)
}

async fn not_found() -> ApiError {
    ApiError::not_found("no such endpoint")
}

async fn method_not_allowed() -> ApiError {
    ApiError::new(
        StatusCode::METHOD_NOT_ALLOWED,
        ErrorCode::InvalidRequest,
        "method not allowed",
    )
}

async fn config<C: Chain>(State(service): State<Arc<Service<C>>>) -> Response {
    Json(service.config_response()).into_response()
}

async fn epoch<C: Chain>(State(service): State<Arc<Service<C>>>) -> Response {
    Json(service.epoch_response()).into_response()
}

fn outcome_response(outcome: TopupOutcome, pending_status: StatusCode) -> Response {
    match outcome {
        TopupOutcome::Issued(body) => (StatusCode::OK, Json(body)).into_response(),
        TopupOutcome::Pending(body) => (pending_status, Json(body)).into_response(),
        TopupOutcome::Rejected(body) => (StatusCode::OK, Json(body)).into_response(),
    }
}

fn rejected_error(body: &TopupResponse) -> ApiError {
    let reason = body
        .reject_reason
        .map(|r| format!("{r:?}"))
        .unwrap_or_default();
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        ErrorCode::PaymentInvalid,
        format!("the log is not a valid purchase: {reason}"),
    )
}

async fn submit_topup<C: Chain>(
    State(service): State<Arc<Service<C>>>,
    body: Result<Json<TopupRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(request) = body.map_err(json_rejection)?;
    let key = PaymentKey {
        chain_id: service.config().deployment.payment_chain_id,
        tx_hash: B256::from(request.tx_hash.0),
        log_index: request.log_index,
    };
    match service.submit_topup(&key).await? {
        TopupOutcome::Rejected(body) => Err(rejected_error(&body)),
        outcome => Ok(outcome_response(outcome, StatusCode::ACCEPTED)),
    }
}

async fn topup_status<C: Chain>(
    State(service): State<Arc<Service<C>>>,
    path: Result<Path<(String, String)>, PathRejection>,
) -> Result<Response, ApiError> {
    let Path((tx_hash, log_index)) = path.map_err(path_rejection)?;
    let tx_hash =
        Bytes32::from_hex(&tx_hash).map_err(|e| ApiError::invalid(format!("tx_hash: {e}")))?;
    let log_index = decode_decimal_u64(&log_index)
        .ok()
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| ApiError::invalid("log_index must be a decimal u32"))?;
    let key = PaymentKey {
        chain_id: service.config().deployment.payment_chain_id,
        tx_hash: B256::from(tx_hash.0),
        log_index,
    };
    match service.topup_status(&key).await? {
        Some(outcome) => Ok(outcome_response(outcome, StatusCode::OK)),
        None => Err(ApiError::not_found(
            "the payment is not issued and not tracked",
        )),
    }
}

/// Query of the paged endpoints. `from` is a decimal string, as in the JSON bodies.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct PageQuery {
    from: Option<String>,
    limit: Option<String>,
}

impl PageQuery {
    fn start(&self) -> Result<Option<u64>, ApiError> {
        self.from
            .as_deref()
            .map(|text| {
                decode_decimal_u64(text)
                    .map_err(|_| ApiError::invalid("from must be a decimal u64"))
            })
            .transpose()
    }

    fn limit(&self, default: u32) -> Result<u32, ApiError> {
        match self.limit.as_deref() {
            None => Ok(default),
            Some(text) => decode_decimal_u64(text)
                .ok()
                .and_then(|value| u32::try_from(value).ok())
                .filter(|value| (1..=MAX_PAGE_LIMIT).contains(value))
                .ok_or_else(|| {
                    ApiError::invalid(format!(
                        "limit must be a decimal from 1 to {MAX_PAGE_LIMIT}"
                    ))
                }),
        }
    }
}

async fn roots<C: Chain>(
    State(service): State<Arc<Service<C>>>,
    query: Result<Query<PageQuery>, QueryRejection>,
) -> Result<Response, ApiError> {
    let Query(query) = query.map_err(query_rejection)?;
    let body = service
        .roots(query.start()?, query.limit(MAX_PAGE_LIMIT)?)
        .await?;
    Ok(Json(body).into_response())
}

async fn leaf_events<C: Chain>(
    State(service): State<Arc<Service<C>>>,
    query: Result<Query<PageQuery>, QueryRejection>,
) -> Result<Response, ApiError> {
    let Query(query) = query.map_err(query_rejection)?;
    let from = query.start()?.unwrap_or(0);
    let Ok(from) = u32::try_from(from) else {
        return Err(ApiError::invalid("from must be a leaf index (u32)"));
    };
    let body = service
        .leaf_events(from, query.limit(MAX_PAGE_LIMIT)?)
        .await?;
    Ok(Json(body).into_response())
}

async fn root_events<C: Chain>(
    State(service): State<Arc<Service<C>>>,
    query: Result<Query<PageQuery>, QueryRejection>,
) -> Result<Response, ApiError> {
    let Query(query) = query.map_err(query_rejection)?;
    let from = query.start()?.unwrap_or(0);
    let body = service
        .root_events(from, query.limit(MAX_PAGE_LIMIT)?)
        .await?;
    Ok(Json(body).into_response())
}

/// Query of the path endpoint.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PathQuery {
    root: String,
}

async fn tree_path<C: Chain>(
    State(service): State<Arc<Service<C>>>,
    path: Result<Path<String>, PathRejection>,
    query: Result<Query<PathQuery>, QueryRejection>,
) -> Result<Json<TreePathResponse>, ApiError> {
    let Path(leaf_index) = path.map_err(path_rejection)?;
    let Query(query) = query.map_err(query_rejection)?;
    let leaf_index = decode_decimal_u64(&leaf_index)
        .ok()
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| ApiError::invalid("leaf_index must be a decimal u32"))?;
    let root =
        FieldElement::from_hex(&query.root).map_err(|e| ApiError::invalid(format!("root: {e}")))?;
    match service.tree_path(leaf_index, root).await? {
        Some(body) => Ok(Json(body)),
        None => Err(ApiError::not_found(
            "the root is not a kept snapshot, or the leaf is not in it",
        )),
    }
}

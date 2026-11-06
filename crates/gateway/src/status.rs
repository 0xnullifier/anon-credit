//! `POST /v1/session/status`: signed session status for client recovery.
//!
//! The client signs the status message (batch ID and a random nonce) with the session key.
//! The gateway returns the balance, the next sequence number, the deadline, the latest
//! receipt metadata, and the nonce. The request changes no state.

use crate::app::{SharedGateway, read_body};
use crate::error::ApiError;
use anon_credit_crypto::verify_ed25519;
use anon_credit_protocol::api::{StatusRequest, StatusResponse};
use anon_credit_protocol::{DecimalU64, ErrorCode, PROTOCOL_VERSION};
use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::extract::rejection::BytesRejection;
use axum::response::{IntoResponse, Response};

/// `POST /v1/session/status`.
pub async fn status(
    State(gateway): State<SharedGateway>,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    match status_inner(&gateway, body).await {
        Ok(response) => Json(response).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn status_inner(
    gateway: &SharedGateway,
    body: Result<Bytes, BytesRejection>,
) -> Result<StatusResponse, ApiError> {
    let body = read_body(body)?;
    let request: StatusRequest = serde_json::from_slice(&body).map_err(|_| {
        ApiError::new(
            ErrorCode::InvalidRequest,
            "status request does not match the schema",
        )
    })?;
    if request.protocol_version != PROTOCOL_VERSION {
        return Err(ApiError::new(
            ErrorCode::UnsupportedVersion,
            "protocol version is not supported",
        ));
    }
    let config = &gateway.config;
    if request.deployment_id != config.deployment_id || request.gateway_id != config.gateway_id() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "deployment_id or gateway_id is not this gateway",
        ));
    }
    let session = gateway
        .store
        .session(&request.batch_id)
        .await
        .map_err(|_| ApiError::storage())?
        .ok_or_else(ApiError::unknown_session)?;
    let digest = request.message().digest();
    verify_ed25519(&session.session_pub.0, &digest.0, &request.signature.0).map_err(|_| {
        ApiError::new(
            ErrorCode::SignatureInvalid,
            "status signature does not verify",
        )
    })?;
    let latest = gateway
        .store
        .receipts(&request.batch_id, 1)
        .await
        .map_err(|_| ApiError::storage())?;
    let now = gateway.clock.now_unix();
    let current = gateway.current_epoch();
    Ok(StatusResponse {
        session: gateway.session_state(&session, current),
        current_epoch: DecimalU64(current),
        latest_receipt: latest.first().map(|row| gateway.receipt_metadata(row, now)),
        nonce: request.nonce,
    })
}

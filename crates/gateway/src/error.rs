//! HTTP error responses of the gateway.
//!
//! The body is [`GatewayErrorBody`]: a stable code, a safe message, the retryable flag, and,
//! for `response_expired`, the committed receipt metadata. Clients branch on the code.

use anon_credit_protocol::ErrorCode;
use anon_credit_protocol::api::{GatewayErrorBody, ReceiptMetadata};
use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

/// One error response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiError {
    /// HTTP status.
    pub status: StatusCode,
    /// JSON body.
    pub body: GatewayErrorBody,
}

/// The HTTP status of an error code.
pub fn status_of(code: ErrorCode) -> StatusCode {
    match code {
        ErrorCode::InvalidRequest | ErrorCode::UnsupportedVersion | ErrorCode::PaymentInvalid => {
            StatusCode::BAD_REQUEST
        }
        ErrorCode::NotFound => StatusCode::NOT_FOUND,
        ErrorCode::SignatureInvalid => StatusCode::UNAUTHORIZED,
        ErrorCode::InsufficientUnits => StatusCode::PAYMENT_REQUIRED,
        ErrorCode::SessionConflict | ErrorCode::SequenceGap | ErrorCode::SequenceConflict => {
            StatusCode::CONFLICT
        }
        ErrorCode::ResponseExpired | ErrorCode::SessionExpired => StatusCode::GONE,
        ErrorCode::ProofInvalid
        | ErrorCode::RootNotAccepted
        | ErrorCode::ProofEpochStale
        | ErrorCode::MethodNotAllowed => StatusCode::UNPROCESSABLE_ENTITY,
        ErrorCode::UpstreamFailed => StatusCode::BAD_GATEWAY,
        ErrorCode::StorageUnavailable | ErrorCode::Busy => StatusCode::SERVICE_UNAVAILABLE,
    }
}

impl ApiError {
    /// Make an error with the default status of the code.
    pub fn new(code: ErrorCode, message: &str) -> Self {
        Self {
            status: status_of(code),
            body: GatewayErrorBody::new(code, message),
        }
    }

    /// Set a different HTTP status.
    pub fn with_status(mut self, status: StatusCode) -> Self {
        self.status = status;
        self
    }

    /// Add receipt metadata.
    pub fn with_receipt(mut self, receipt: ReceiptMetadata) -> Self {
        self.body.receipt = Some(receipt);
        self
    }

    /// The error code.
    pub fn code(&self) -> ErrorCode {
        self.body.code
    }

    /// `not_found` for an unknown session.
    pub fn unknown_session() -> Self {
        Self::new(ErrorCode::NotFound, "session does not exist")
    }

    /// `invalid_request` with HTTP 413 for a body above the limit.
    pub fn body_too_large() -> Self {
        Self::new(ErrorCode::InvalidRequest, "request body is too large")
            .with_status(StatusCode::PAYLOAD_TOO_LARGE)
    }

    /// `storage_unavailable`.
    pub fn storage() -> Self {
        Self::new(
            ErrorCode::StorageUnavailable,
            "gateway storage is not available",
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(self.body)).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_code_has_an_error_status() {
        for code in ErrorCode::ALL {
            let status = status_of(code);
            assert!(
                status.is_client_error() || status.is_server_error(),
                "{code}"
            );
            // A retryable code must not look like a permanent client error.
            if code.retryable() {
                assert!(status.is_server_error(), "{code}");
            }
        }
    }
}

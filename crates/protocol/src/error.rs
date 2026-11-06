//! Stable error codes for the HTTP interfaces.
//!
//! Clients must branch on the code. They must not branch on the message text.

use serde::{Deserialize, Serialize};

/// Stable error code. The wire form is the `snake_case` name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// The request body, schema, or encoding is not valid.
    InvalidRequest,
    /// The protocol version is not supported.
    UnsupportedVersion,
    /// The open proof does not verify.
    ProofInvalid,
    /// The gateway does not accept the root.
    RootNotAccepted,
    /// The proof epoch is not the current or the previous epoch.
    ProofEpochStale,
    /// A session for the batch ID already exists with a different open request.
    SessionConflict,
    /// The signature does not verify.
    SignatureInvalid,
    /// The sequence number is greater than the next sequence number.
    SequenceGap,
    /// The sequence number is already used with a different request digest.
    SequenceConflict,
    /// The stored response for a committed sequence number has expired.
    ResponseExpired,
    /// The session has fewer units than the request needs.
    InsufficientUnits,
    /// The session deadline has passed.
    SessionExpired,
    /// The RPC method is not in the allowlist.
    MethodNotAllowed,
    /// The upstream RPC call failed. The gateway did not charge units.
    UpstreamFailed,
    /// The gateway storage is not available. The gateway did not charge units.
    StorageUnavailable,
    /// The gateway is at a concurrency limit.
    Busy,
    /// The requested record does not exist (for example an untracked payment or a root that
    /// the issuer does not keep).
    NotFound,
    /// The referenced chain log is not a valid purchase. The issuer will never issue it.
    PaymentInvalid,
}

impl ErrorCode {
    /// All error codes, in declaration order.
    pub const ALL: [ErrorCode; 18] = [
        ErrorCode::InvalidRequest,
        ErrorCode::UnsupportedVersion,
        ErrorCode::ProofInvalid,
        ErrorCode::RootNotAccepted,
        ErrorCode::ProofEpochStale,
        ErrorCode::SessionConflict,
        ErrorCode::SignatureInvalid,
        ErrorCode::SequenceGap,
        ErrorCode::SequenceConflict,
        ErrorCode::ResponseExpired,
        ErrorCode::InsufficientUnits,
        ErrorCode::SessionExpired,
        ErrorCode::MethodNotAllowed,
        ErrorCode::UpstreamFailed,
        ErrorCode::StorageUnavailable,
        ErrorCode::Busy,
        ErrorCode::NotFound,
        ErrorCode::PaymentInvalid,
    ];

    /// Wire name of the code.
    pub const fn as_str(self) -> &'static str {
        match self {
            ErrorCode::InvalidRequest => "invalid_request",
            ErrorCode::UnsupportedVersion => "unsupported_version",
            ErrorCode::ProofInvalid => "proof_invalid",
            ErrorCode::RootNotAccepted => "root_not_accepted",
            ErrorCode::ProofEpochStale => "proof_epoch_stale",
            ErrorCode::SessionConflict => "session_conflict",
            ErrorCode::SignatureInvalid => "signature_invalid",
            ErrorCode::SequenceGap => "sequence_gap",
            ErrorCode::SequenceConflict => "sequence_conflict",
            ErrorCode::ResponseExpired => "response_expired",
            ErrorCode::InsufficientUnits => "insufficient_units",
            ErrorCode::SessionExpired => "session_expired",
            ErrorCode::MethodNotAllowed => "method_not_allowed",
            ErrorCode::UpstreamFailed => "upstream_failed",
            ErrorCode::StorageUnavailable => "storage_unavailable",
            ErrorCode::Busy => "busy",
            ErrorCode::NotFound => "not_found",
            ErrorCode::PaymentInvalid => "payment_invalid",
        }
    }

    /// Tell if the client can send the same request again later.
    ///
    /// `true` means a later identical request can succeed and no units were charged.
    /// `false` means the client must change the request, make a new proof, or stop.
    pub const fn retryable(self) -> bool {
        match self {
            ErrorCode::UpstreamFailed | ErrorCode::StorageUnavailable | ErrorCode::Busy => true,
            ErrorCode::InvalidRequest
            | ErrorCode::UnsupportedVersion
            | ErrorCode::ProofInvalid
            | ErrorCode::RootNotAccepted
            | ErrorCode::ProofEpochStale
            | ErrorCode::SessionConflict
            | ErrorCode::SignatureInvalid
            | ErrorCode::SequenceGap
            | ErrorCode::SequenceConflict
            | ErrorCode::ResponseExpired
            | ErrorCode::InsufficientUnits
            | ErrorCode::SessionExpired
            | ErrorCode::MethodNotAllowed
            | ErrorCode::NotFound
            | ErrorCode::PaymentInvalid => false,
        }
    }
}

impl std::fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// JSON error body for all HTTP error responses.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ErrorBody {
    /// Stable error code.
    pub code: ErrorCode,
    /// Safe message for people. Do not branch on it.
    pub message: String,
    /// Copy of [`ErrorCode::retryable`] for the code.
    pub retryable: bool,
}

impl ErrorBody {
    /// Make an error body. The retryable flag comes from the code.
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: code.retryable(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serde_name_matches_as_str() {
        for code in ErrorCode::ALL {
            let json = serde_json::to_string(&code).unwrap();
            assert_eq!(json, format!("\"{}\"", code.as_str()));
            let back: ErrorCode = serde_json::from_str(&json).unwrap();
            assert_eq!(back, code);
        }
    }

    #[test]
    fn unknown_code_is_rejected() {
        assert!(serde_json::from_str::<ErrorCode>("\"InvalidRequest\"").is_err());
        assert!(serde_json::from_str::<ErrorCode>("\"not_a_code\"").is_err());
    }

    #[test]
    fn error_body_sets_retryable_from_code() {
        let body = ErrorBody::new(ErrorCode::Busy, "try later");
        assert!(body.retryable);
        let body = ErrorBody::new(ErrorCode::SequenceGap, "gap");
        assert!(!body.retryable);
    }

    #[test]
    fn error_body_rejects_unknown_fields() {
        let json = r#"{"code":"busy","message":"m","retryable":true,"extra":1}"#;
        assert!(serde_json::from_str::<ErrorBody>(json).is_err());
    }
}

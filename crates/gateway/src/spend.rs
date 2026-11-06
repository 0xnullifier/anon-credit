//! `POST /v1/rpc` (implementation.md section 11, Architecture.md section 5.2).
//!
//! The order of the steps:
//!
//! 1. Body limit (64 KiB by default) and the envelope schema.
//! 2. Read the session. Verify the Ed25519 signature over the spend message digest with the
//!    session key and the price table hash that the session froze. This is the
//!    authorization check. It runs before the lock and before any state changes.
//! 3. Lock the batch. Wait at most 5 s, else `busy`.
//! 4. Read the session again under the lock. Compare `seq` with `next_seq`:
//!    - lower: the stored receipt answers. The same digest gives the stored response with no
//!      new charge, or `response_expired` with the receipt metadata after the retention time.
//!      A different digest gives `sequence_conflict`.
//!    - higher: `sequence_gap`.
//! 5. Deadline, method allowlist and parameters, units, cumulative `units_total`.
//! 6. Call the upstream with the exact client bytes. No transaction is open during the call.
//!    A transport failure, a non-200 status, or a malformed response is `upstream_failed`
//!    and changes nothing.
//! 7. Commit the debit, the receipt, and the response in one transaction. A commit failure
//!    gives `storage_unavailable` and the gateway does not return the response.
//! 8. Release the lock and return the raw JSON-RPC bytes with the `X-Anon-*` headers.

use crate::app::{SharedGateway, read_body};
use crate::error::ApiError;
use crate::events::EventDraft;
use crate::peer::Observed;
use crate::rpc::{RpcRejection, check_request, check_response};
use crate::store::{SessionRow, SpendCommit};
use anon_credit_crypto::verify_ed25519;
use anon_credit_protocol::admin::EventKind;
use anon_credit_protocol::api::{SpendRequest, SpendResponseHeaders};
use anon_credit_protocol::{Bytes32, ErrorCode, PROTOCOL_VERSION};
use axum::body::{Body, Bytes};
use axum::extract::rejection::BytesRejection;
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use std::net::SocketAddr;
use std::time::Instant;

/// `POST /v1/rpc`.
pub async fn spend(
    State(gateway): State<SharedGateway>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let started = Instant::now();
    let observed = gateway.peer.observe(peer, &headers);
    let mut context = Context {
        gateway: &gateway,
        observed: &observed,
        started,
        batch_id: None,
        seq: None,
        method: None,
    };
    match spend_inner(&mut context, body).await {
        Ok(response) => response,
        Err(error) => {
            context.reject(&error);
            error.into_response()
        }
    }
}

struct Context<'a> {
    gateway: &'a SharedGateway,
    observed: &'a Observed,
    started: Instant,
    batch_id: Option<Bytes32>,
    seq: Option<u64>,
    method: Option<String>,
}

impl Context<'_> {
    fn draft(&self, kind: EventKind) -> EventDraft {
        let mut draft = EventDraft::new(kind, self.observed).latency(self.started);
        if let Some(batch_id) = self.batch_id {
            draft = draft.batch(batch_id);
        }
        if let Some(seq) = self.seq {
            draft = draft.seq(seq);
        }
        if let Some(method) = &self.method {
            draft = draft.method(method);
        }
        draft
    }

    fn reject(&self, error: &ApiError) {
        // Upstream and storage failures have their own events.
        let kind = match error.code() {
            ErrorCode::UpstreamFailed => EventKind::UpstreamFailed,
            ErrorCode::StorageUnavailable => EventKind::StorageFailed,
            _ => EventKind::RpcRejected,
        };
        self.gateway
            .events
            .publish(self.draft(kind).error(error.code()));
    }
}

fn invalid(message: &str) -> ApiError {
    ApiError::new(ErrorCode::InvalidRequest, message)
}

fn rpc_response(body: Vec<u8>, headers: SpendResponseHeaders) -> Response {
    let mut response = (StatusCode::OK, Body::from(body)).into_response();
    let map = response.headers_mut();
    map.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    for (name, value) in headers.to_pairs() {
        if let Ok(value) = HeaderValue::from_str(&value) {
            map.insert(name, value);
        }
    }
    response
}

async fn spend_inner(
    context: &mut Context<'_>,
    body: Result<Bytes, BytesRejection>,
) -> Result<Response, ApiError> {
    let gateway = context.gateway;
    let body = read_body(body)?;
    let request: SpendRequest = serde_json::from_slice(&body)
        .map_err(|_| invalid("spend request does not match the schema"))?;
    context.batch_id = Some(request.batch_id);
    context.seq = Some(request.seq.0);
    gateway.events.publish(
        context
            .draft(EventKind::RpcReceived)
            .request_bytes(body.len()),
    );
    if request.protocol_version != PROTOCOL_VERSION {
        return Err(ApiError::new(
            ErrorCode::UnsupportedVersion,
            "protocol version is not supported",
        ));
    }

    // Authorization first: the session key and the frozen price table do not change.
    let session = gateway
        .store
        .session(&request.batch_id)
        .await
        .map_err(|_| ApiError::storage())?
        .ok_or_else(ApiError::unknown_session)?;
    let config = &gateway.config;
    let digest = request
        .digest(
            config.deployment_id,
            config.gateway_id(),
            session.price_table_hash,
        )
        .map_err(|_| invalid("rpc bytes are too long"))?;
    verify_ed25519(&session.session_pub.0, &digest.0, &request.signature.0).map_err(|_| {
        ApiError::new(
            ErrorCode::SignatureInvalid,
            "spend signature does not verify",
        )
    })?;

    let _guard = gateway
        .locks
        .acquire(request.batch_id, config.limits.batch_lock_wait)
        .await
        .ok_or_else(|| ApiError::new(ErrorCode::Busy, "another request of the batch is active"))?;
    let session = gateway
        .store
        .session(&request.batch_id)
        .await
        .map_err(|_| ApiError::storage())?
        .ok_or_else(ApiError::unknown_session)?;

    let seq = request.seq.0;
    match seq.cmp(&session.next_seq) {
        std::cmp::Ordering::Less => return replay(context, &session, seq, &digest).await,
        std::cmp::Ordering::Greater => {
            return Err(ApiError::new(
                ErrorCode::SequenceGap,
                "sequence number is ahead of the session",
            ));
        }
        std::cmp::Ordering::Equal => {}
    }

    if gateway.current_epoch() > session.deadline_epoch {
        return Err(ApiError::new(
            ErrorCode::SessionExpired,
            "session deadline has passed",
        ));
    }
    let call = check_request(&request.rpc.0, &session_prices(gateway, &session)?).map_err(
        |rejection| match rejection {
            RpcRejection::MethodNotAllowed => {
                ApiError::new(ErrorCode::MethodNotAllowed, "method is not allowed")
            }
            RpcRejection::Invalid(message) => invalid(message),
        },
    )?;
    context.method = Some(call.method.clone());
    let expected_total = session
        .units_total
        .checked_add(u64::from(call.units))
        .ok_or_else(|| invalid("units_total is out of range"))?;
    if session.remaining < call.units {
        return Err(ApiError::new(
            ErrorCode::InsufficientUnits,
            "session has too few units for the request",
        ));
    }
    if request.units_total.0 != expected_total {
        return Err(invalid(
            "units_total is not the session units plus the method units",
        ));
    }

    let reply = gateway
        .upstream
        .call(Bytes::from(request.rpc.0.clone()))
        .await
        .map_err(|_| ApiError::new(ErrorCode::UpstreamFailed, "upstream call failed"))?;
    check_response(reply.status, &reply.body, &call.id).map_err(|_| {
        ApiError::new(
            ErrorCode::UpstreamFailed,
            "upstream response is not a valid JSON-RPC response",
        )
    })?;

    let committed = gateway
        .store
        .commit_spend(SpendCommit {
            batch_id: &request.batch_id,
            seq,
            units: call.units,
            units_total: expected_total,
            request_digest: &digest,
            method: &call.method,
            response: &reply.body,
            now_unix: gateway.clock.now_unix(),
        })
        .await;
    let after = match committed {
        Ok(after) => after,
        Err(error) => {
            tracing::error!(error = %error, "debit commit failed; response discarded");
            return Err(ApiError::storage());
        }
    };
    gateway.events.publish(
        context
            .draft(EventKind::RpcCompleted)
            .units(call.units, after.remaining)
            .response_bytes(reply.body.len()),
    );
    Ok(rpc_response(
        reply.body.to_vec(),
        SpendResponseHeaders {
            remaining: after.remaining,
            next_seq: after.next_seq,
            replayed: false,
        },
    ))
}

/// The price table of a session. The session froze the hash of the table at open.
fn session_prices(
    gateway: &SharedGateway,
    session: &SessionRow,
) -> Result<anon_credit_protocol::PriceTable, ApiError> {
    // The gateway has one table. A session with an older table cannot spend until the
    // gateway keeps old tables; the open check makes this case impossible today.
    match session.price_table_hash == gateway.config.price_table_hash {
        true => Ok(gateway.config.prices.clone()),
        false => Err(invalid("price table of the session is not available")),
    }
}

/// Answer a request with a sequence number that already has a receipt.
async fn replay(
    context: &mut Context<'_>,
    session: &SessionRow,
    seq: u64,
    digest: &Bytes32,
) -> Result<Response, ApiError> {
    let gateway = context.gateway;
    let receipt = gateway
        .store
        .receipt(&session.batch_id, seq)
        .await
        .map_err(|_| ApiError::storage())?
        .ok_or_else(ApiError::storage)?;
    context.method = Some(receipt.method.clone());
    if receipt.request_digest != *digest {
        return Err(ApiError::new(
            ErrorCode::SequenceConflict,
            "sequence number is used by a different request",
        ));
    }
    let now = gateway.clock.now_unix();
    let retained = gateway.response_retained(&receipt, now);
    match (retained, receipt.response_bytes.clone()) {
        (true, Some(bytes)) => {
            gateway.events.publish(
                context
                    .draft(EventKind::RpcReplayed)
                    .remaining(session.remaining)
                    .response_bytes(bytes.len()),
            );
            Ok(rpc_response(
                bytes,
                SpendResponseHeaders {
                    remaining: session.remaining,
                    next_seq: session.next_seq,
                    replayed: true,
                },
            ))
        }
        _ => Err(ApiError::new(
            ErrorCode::ResponseExpired,
            "stored response has expired; the debit is committed",
        )
        .with_receipt(gateway.receipt_metadata(&receipt, now))),
    }
}

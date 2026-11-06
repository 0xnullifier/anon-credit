//! Admin API (implementation.md sections 10 and 14).
//!
//! - Every route needs `Authorization: Bearer <GATEWAY_ADMIN_TOKEN>`. The token is never in
//!   a URL. The comparison takes the same time for each wrong token of the same length.
//! - `GET /admin/v1/events` is a Server-Sent Events stream. Each event has its monotonic ID.
//!   A client that reconnects with `Last-Event-ID` gets the retained events after that ID.

use crate::app::SharedGateway;
use crate::error::ApiError;
use crate::roots::WINDOW_EPOCHS_U32;
use crate::store::SessionRow;
use anon_credit_crypto::constants::CIRCUIT_ID;
use anon_credit_protocol::admin::{
    AdminReceipt, AdminSnapshot, GatewayEvent, SessionDetail, SessionSummary, SessionTotals,
};
use anon_credit_protocol::{Bytes32, DecimalU64, ErrorCode};
use axum::Json;
use axum::extract::{Path, Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::Next;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use futures_util::stream::{self, Stream, StreamExt};
use std::convert::Infallible;

/// Number of events in a snapshot.
pub const SNAPSHOT_EVENTS: usize = 100;
/// Number of sessions in a snapshot.
pub const SNAPSHOT_SESSIONS: u32 = 50;
/// Number of receipts in a session view. A batch has at most `batch_size` (100) units and a
/// spend costs at least one unit, so a session has at most 100 receipts. This value shows all.
pub const SESSION_RECEIPTS: u32 = 200;

/// Compare two byte strings in time that does not depend on the first different byte.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Middleware: require the admin bearer token.
pub async fn require_token(
    State(gateway): State<SharedGateway>,
    request: Request,
    next: Next,
) -> Response {
    let expected = gateway.config.admin_token.as_bytes();
    let given = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|text| text.strip_prefix("Bearer "));
    match given {
        Some(token) if !expected.is_empty() && constant_time_eq(token.as_bytes(), expected) => {
            next.run(request).await
        }
        _ => {
            let mut response = ApiError::new(ErrorCode::InvalidRequest, "admin token is required")
                .with_status(StatusCode::UNAUTHORIZED)
                .into_response();
            response.headers_mut().insert(
                header::WWW_AUTHENTICATE,
                axum::http::HeaderValue::from_static("Bearer"),
            );
            response
        }
    }
}

fn summary(gateway: &SharedGateway, row: &SessionRow, current: u64) -> SessionSummary {
    SessionSummary {
        session: gateway.session_state(row, current),
        opened_at: DecimalU64(row.opened_at),
        proof_size: row.proof_size,
        verify_ms: row.verify_ms,
    }
}

/// `GET /admin/v1/snapshot`.
pub async fn snapshot(State(gateway): State<SharedGateway>) -> Response {
    let current = gateway.current_epoch();
    let counts = gateway.store.session_counts(current).await;
    let recent = gateway.store.recent_sessions(SNAPSHOT_SESSIONS).await;
    let (counts, recent) = match (counts, recent) {
        (Ok(counts), Ok(recent)) => (counts, recent),
        _ => return ApiError::storage().into_response(),
    };
    let config = &gateway.config;
    let deployment = &config.deployment;
    Json(AdminSnapshot {
        status: "ok".to_owned(),
        started_at: DecimalU64(gateway.started_at),
        now: DecimalU64(gateway.clock.now_unix()),
        current_epoch: DecimalU64(current),
        deployment_id: config.deployment_id,
        gateway_id: config.gateway_id(),
        upstream_chain_id: config.upstream_chain_id,
        epoch_seconds: deployment.epoch_seconds,
        circuit_id: Bytes32(CIRCUIT_ID.to_bytes_be()),
        verifier_artifact_hash: deployment.verifier_artifact_hash,
        demo_ip_logging: gateway.peer.captures(),
        verifier: gateway.verifier_status.clone(),
        price_table_hash: config.price_table_hash,
        price_table: config.prices.clone(),
        roots: gateway.roots.status(current),
        root_window_epochs: WINDOW_EPOCHS_U32,
        accepted_roots: gateway
            .roots
            .accepted(current)
            .iter()
            .map(|record| record.to_api())
            .collect(),
        counters: gateway.events.counters(),
        sessions: SessionTotals {
            active: DecimalU64(counts.active),
            exhausted: DecimalU64(counts.exhausted),
            expired: DecimalU64(counts.expired),
            units_charged: DecimalU64(counts.units_charged),
        },
        recent_events: gateway.events.recent(SNAPSHOT_EVENTS),
        recent_sessions: recent
            .iter()
            .map(|row| summary(&gateway, row, current))
            .collect(),
    })
    .into_response()
}

/// `GET /admin/v1/sessions/{batch_id}`. No issuer payment lookup.
pub async fn session(
    State(gateway): State<SharedGateway>,
    Path(batch_id): Path<String>,
) -> Response {
    let Ok(batch_id) = Bytes32::from_hex(&batch_id) else {
        return ApiError::new(ErrorCode::InvalidRequest, "batch_id is not canonical hex")
            .into_response();
    };
    let row = match gateway.store.session(&batch_id).await {
        Ok(Some(row)) => row,
        Ok(None) => return ApiError::unknown_session().into_response(),
        Err(_) => return ApiError::storage().into_response(),
    };
    let Ok(receipts) = gateway.store.receipts(&batch_id, SESSION_RECEIPTS).await else {
        return ApiError::storage().into_response();
    };
    let now = gateway.clock.now_unix();
    let current = gateway.current_epoch();
    Json(SessionDetail {
        summary: summary(&gateway, &row, current),
        receipts: receipts
            .iter()
            .map(|receipt| AdminReceipt {
                receipt: gateway.receipt_metadata(receipt, now),
                method: receipt.method.clone(),
            })
            .collect(),
    })
    .into_response()
}

fn sse_event(event: &GatewayEvent) -> Event {
    let base = Event::default().id(event.id.0.to_string());
    match serde_json::to_string(event) {
        Ok(data) => base.data(data),
        Err(_) => base.comment("event encoding failed"),
    }
}

/// `GET /admin/v1/events`: Server-Sent Events with `Last-Event-ID` reconnect.
///
/// A subscriber that falls behind the live channel is disconnected. It reconnects with its
/// last ID and gets the missed events from the ring.
pub async fn events(
    State(gateway): State<SharedGateway>,
    headers: HeaderMap,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let after = headers
        .get("last-event-id")
        .and_then(|value| value.to_str().ok())
        .and_then(|text| text.trim().parse::<u64>().ok())
        .unwrap_or(0);
    let (backlog, receiver) = gateway.events.subscribe(after);
    let live = stream::unfold(receiver, |mut receiver| async move {
        match receiver.recv().await {
            Ok(event) => Some((event, receiver)),
            Err(_) => None,
        }
    });
    let stream = stream::iter(backlog)
        .chain(live)
        .map(|event| Ok(sse_event(&event)));
    Sse::new(stream).keep_alive(KeepAlive::default())
}

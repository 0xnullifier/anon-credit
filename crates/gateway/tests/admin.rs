//! Admin API, event stream, and observed IP tests (implementation.md section 14).

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod common;

use anon_credit_protocol::admin::{AdminSnapshot, EventKind, GatewayEvent, SessionDetail};
use anon_credit_protocol::api::{DemoPeerResponse, IpAttribution, PricesResponse, RootsResponse};
use anon_credit_protocol::{ErrorBody, ErrorCode, PriceTable};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::*;
use http_body_util::BodyExt;
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tower::ServiceExt;

async fn spend_once(h: &Harness, client: &Client, seq: u64, units_total: u64) {
    let request = client.spend_request(h, seq, units_total, rpc_bytes("eth_chainId", seq));
    assert_eq!(h.spend(&request).await.status, StatusCode::OK);
}

#[tokio::test]
async fn admin_routes_need_the_bearer_token() {
    let h = Harness::new().await;
    let none = h.admin_get("/admin/v1/snapshot", None).await;
    assert_eq!(none.status, StatusCode::UNAUTHORIZED);
    let wrong = h
        .admin_get("/admin/v1/snapshot", Some("wrong-token-0123456789"))
        .await;
    assert_eq!(wrong.status, StatusCode::UNAUTHORIZED);
    let prefix = h
        .admin_get("/admin/v1/snapshot", Some(&ADMIN_TOKEN[..10]))
        .await;
    assert_eq!(prefix.status, StatusCode::UNAUTHORIZED);
    let in_url = h
        .admin_get(&format!("/admin/v1/snapshot?token={ADMIN_TOKEN}"), None)
        .await;
    assert_eq!(in_url.status, StatusCode::UNAUTHORIZED);
    let events = h.admin_get("/admin/v1/events", None).await;
    assert_eq!(events.status, StatusCode::UNAUTHORIZED);
    let body: ErrorBody = none.json();
    assert_eq!(body.code, ErrorCode::InvalidRequest);
    let ok = h.admin_get("/admin/v1/snapshot", Some(ADMIN_TOKEN)).await;
    assert_eq!(ok.status, StatusCode::OK);
    // The public listener has no admin routes.
    assert_eq!(
        h.get("/admin/v1/snapshot").await.status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn snapshot_and_session_view_reflect_committed_state() {
    let h = Harness::new().await;
    let client = Client::new(1);
    h.open_ok(&client).await;
    spend_once(&h, &client, 0, 1).await;
    let rejected = client.spend_request(&h, 5, 2, rpc_bytes("eth_chainId", 5));
    assert_eq!(
        h.spend(&rejected).await.error_code(),
        ErrorCode::SequenceGap
    );

    let snapshot: AdminSnapshot = h
        .admin_get("/admin/v1/snapshot", Some(ADMIN_TOKEN))
        .await
        .json();
    assert_eq!(snapshot.status, "ok");
    assert_eq!(snapshot.counters.open_received.0, 1);
    assert_eq!(snapshot.counters.sessions_opened.0, 1);
    assert_eq!(snapshot.counters.rpc_completed.0, 1);
    assert_eq!(snapshot.counters.rpc_rejected.0, 1);
    assert_eq!(snapshot.counters.units_charged.0, 1);
    assert_eq!(snapshot.sessions.active.0, 1);
    assert_eq!(snapshot.sessions.units_charged.0, 1);
    assert_eq!(snapshot.roots.accepted, 1);
    assert_eq!(snapshot.roots.latest_age_epochs.map(|e| e.0), Some(1));
    assert_eq!(snapshot.recent_sessions.len(), 1);
    assert_eq!(snapshot.recent_sessions[0].session.remaining, 99);
    assert!(!snapshot.demo_ip_logging);
    let kinds: Vec<EventKind> = snapshot.recent_events.iter().map(|e| e.kind).collect();
    assert_eq!(
        kinds,
        vec![
            EventKind::OpenReceived,
            EventKind::OpenVerified,
            EventKind::SessionOpened,
            EventKind::RpcReceived,
            EventKind::RpcCompleted,
            EventKind::RpcReceived,
            EventKind::RpcRejected,
        ]
    );
    let completed = &snapshot.recent_events[4];
    assert_eq!(completed.method.as_deref(), Some("eth_chainId"));
    assert_eq!((completed.units, completed.remaining), (Some(1), Some(99)));
    assert_eq!(
        snapshot.recent_events[6].error_code,
        Some(ErrorCode::SequenceGap)
    );

    let path = format!("/admin/v1/sessions/{}", client.batch_id.to_hex());
    let detail: SessionDetail = h.admin_get(&path, Some(ADMIN_TOKEN)).await.json();
    assert_eq!(detail.summary.session.next_seq.0, 1);
    assert!(detail.summary.proof_size > 0);
    assert_eq!(detail.summary.verify_ms, 3);
    assert_eq!(detail.receipts.len(), 1);
    assert_eq!(detail.receipts[0].method, "eth_chainId");
    let missing = format!("/admin/v1/sessions/{}", Client::new(2).batch_id.to_hex());
    assert_eq!(
        h.admin_get(&missing, Some(ADMIN_TOKEN)).await.status,
        StatusCode::NOT_FOUND
    );
    let bad = h
        .admin_get("/admin/v1/sessions/0xABC", Some(ADMIN_TOKEN))
        .await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn snapshot_has_the_deployment_prices_and_accepted_roots() {
    let h = Harness::new().await;
    let snapshot: AdminSnapshot = h
        .admin_get("/admin/v1/snapshot", Some(ADMIN_TOKEN))
        .await
        .json();
    let deployment = deployment();
    assert_eq!(snapshot.epoch_seconds, EPOCH_SECONDS);
    assert_eq!(snapshot.circuit_id, deployment.circuit_id);
    assert_eq!(snapshot.verifier_artifact_hash, VERIFIER_HASH);
    assert_eq!(snapshot.gateway_id, deployment.gateway_id);
    assert_eq!(snapshot.deployment_id, deployment.deployment_id());
    assert_eq!(snapshot.root_window_epochs, 96);

    // The price table and the roots are the same values as on the public API.
    let prices: PricesResponse = h.get("/v1/prices").await.json();
    assert_eq!(snapshot.price_table, prices.price_table);
    assert_eq!(snapshot.price_table_hash, prices.price_table_hash);
    assert_eq!(snapshot.price_table, PriceTable::initial());
    assert_eq!(snapshot.price_table_hash, PriceTable::initial().hash());
    let roots: RootsResponse = h.get("/v1/roots").await.json();
    assert_eq!(snapshot.accepted_roots, roots.roots);
    assert_eq!(snapshot.accepted_roots.len(), 1);
    assert_eq!(snapshot.accepted_roots[0].root, root());
    assert_eq!(snapshot.accepted_roots[0].leaf_count, LEAF_COUNT);
    assert_eq!(
        Some(snapshot.accepted_roots[0].source_epoch),
        snapshot.roots.latest_source_epoch
    );
}

#[tokio::test]
async fn session_view_lists_more_than_fifty_receipts() {
    let h = Harness::new().await;
    let client = Client::new(1);
    h.open_ok(&client).await;
    for seq in 0..60 {
        spend_once(&h, &client, seq, seq + 1).await;
    }
    let path = format!("/admin/v1/sessions/{}", client.batch_id.to_hex());
    let detail: SessionDetail = h.admin_get(&path, Some(ADMIN_TOKEN)).await.json();
    assert_eq!(detail.receipts.len(), 60);
    assert_eq!(detail.receipts[0].receipt.seq.0, 59);
    assert_eq!(detail.receipts[59].receipt.seq.0, 0);
    assert_eq!(detail.summary.session.remaining, 40);
}

/// Read Server-Sent Events from a stream until `count` events arrive.
async fn read_sse(
    h: &Harness,
    last_event_id: Option<&str>,
    count: usize,
    during: impl std::future::Future<Output = ()>,
) -> Vec<GatewayEvent> {
    let mut builder = Request::builder()
        .uri("/admin/v1/events")
        .header("authorization", format!("Bearer {ADMIN_TOKEN}"));
    if let Some(id) = last_event_id {
        builder = builder.header("last-event-id", id);
    }
    let response = h
        .admin()
        .oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get("content-type").unwrap(),
        "text/event-stream"
    );
    during.await;
    let mut body = response.into_body();
    let mut text = String::new();
    let mut events = Vec::new();
    while events.len() < count {
        let frame = tokio::time::timeout(Duration::from_secs(5), body.frame())
            .await
            .expect("event in time")
            .unwrap()
            .unwrap();
        if let Ok(data) = frame.into_data() {
            text.push_str(std::str::from_utf8(&data).unwrap());
        }
        while let Some(end) = text.find("\n\n") {
            let block: String = text.drain(..end + 2).collect();
            let id = block
                .lines()
                .find_map(|l| l.strip_prefix("id: "))
                .map(str::to_owned);
            if let Some(data) = block.lines().find_map(|l| l.strip_prefix("data: ")) {
                let event: GatewayEvent = serde_json::from_str(data).unwrap();
                assert_eq!(id, Some(event.id.0.to_string()));
                events.push(event);
            }
        }
    }
    events
}

#[tokio::test]
async fn event_stream_resumes_after_last_event_id() {
    let h = Harness::new().await;
    let client = Client::new(3);
    h.open_ok(&client).await;
    // Events 1..=3 exist: open_received, open_verified, session_opened.
    let resumed = read_sse(&h, Some("1"), 2, async {}).await;
    assert_eq!(
        resumed.iter().map(|e| e.id.0).collect::<Vec<_>>(),
        vec![2, 3]
    );
    // A new connection gets the backlog and then live events in ID order.
    let live = read_sse(&h, Some("3"), 2, spend_once(&h, &client, 0, 1)).await;
    assert_eq!(
        live.iter().map(|e| (e.id.0, e.kind)).collect::<Vec<_>>(),
        vec![(4, EventKind::RpcReceived), (5, EventKind::RpcCompleted)]
    );
    // Without Last-Event-ID the stream starts at the oldest retained event.
    let all = read_sse(&h, None, 5, async {}).await;
    assert_eq!(all.first().map(|e| e.id.0), Some(1));
}

#[tokio::test]
async fn forged_forwarding_header_from_untrusted_peer_is_ignored() {
    let h = Harness::with(Options {
        capture_ip: true,
        ..Options::default()
    })
    .await;
    let client = Client::new(4);
    let request = client.open_request(&h, &OpenOptions::default());
    let response = h
        .post_with(
            "/v1/open",
            serde_json::to_vec(&request).unwrap(),
            &[
                ("x-forwarded-for", "203.0.113.66"),
                ("forwarded", "for=203.0.113.67"),
            ],
        )
        .await;
    assert_eq!(response.status, StatusCode::OK);
    let event = &h.gateway.events.recent(10)[0];
    assert_eq!(event.observed_ip, "198.51.100.7");
    assert_eq!(event.ip_attribution, IpAttribution::Socket);
    assert_eq!(event.proxy_hop, None);

    let request = Request::builder()
        .uri("/v1/demo/peer")
        .header("x-forwarded-for", "203.0.113.66")
        .body(Body::empty())
        .unwrap();
    let peer: DemoPeerResponse = Harness::send(h.router(), request).await.json();
    assert_eq!(peer.observed_ip, "198.51.100.7");
    assert_eq!(peer.attribution, IpAttribution::Socket);
}

#[tokio::test]
async fn trusted_proxy_header_sets_the_observed_ip_and_shows_the_hop() {
    let h = Harness::with(Options {
        capture_ip: true,
        trusted: vec!["10.0.0.1".parse().unwrap()],
        peer: "10.0.0.1:55000".parse().unwrap(),
        ..Options::default()
    })
    .await;
    let request = Request::builder()
        .uri("/v1/demo/peer")
        .header("x-forwarded-for", "192.0.2.1, 203.0.113.66")
        .body(Body::empty())
        .unwrap();
    let peer: DemoPeerResponse = Harness::send(h.router(), request).await.json();
    assert_eq!(peer.observed_ip, "203.0.113.66");
    assert_eq!(peer.attribution, IpAttribution::TrustedProxy);
    assert_eq!(peer.proxy_hop.as_deref(), Some("10.0.0.1"));
}

#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl Write for Captured {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(data);
        Ok(data.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn normal_profile_records_and_logs_no_ip() {
    let captured = Captured::default();
    let writer = captured.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::TRACE)
        .with_writer(move || writer.clone())
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);

    let h = Harness::new().await;
    let client = Client::new(5);
    let request = client.open_request(&h, &OpenOptions::default());
    let forged = [("x-forwarded-for", "203.0.113.66")];
    let response = h
        .post_with("/v1/open", serde_json::to_vec(&request).unwrap(), &forged)
        .await;
    assert_eq!(response.status, StatusCode::OK);
    // Make the gateway log: a failed commit and a failed root refresh.
    sqlx::query(
        "CREATE TRIGGER fail_receipts BEFORE INSERT ON receipts \
         BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
    )
    .execute(h.gateway.store.pool())
    .await
    .unwrap();
    let spend = client.spend_request(&h, 0, 1, rpc_bytes("eth_chainId", 1));
    let response = h
        .post_with("/v1/rpc", serde_json::to_vec(&spend).unwrap(), &forged)
        .await;
    assert_eq!(response.error_code(), ErrorCode::StorageUnavailable);
    h.roots
        .fail
        .store(true, std::sync::atomic::Ordering::SeqCst);
    anon_credit_gateway::server::refresh_roots(&h.gateway).await;

    let snapshot = h.admin_get("/admin/v1/snapshot", Some(ADMIN_TOKEN)).await;
    let text = String::from_utf8_lossy(&snapshot.body).into_owned();
    let parsed: AdminSnapshot = snapshot.json();
    assert!(
        parsed
            .recent_events
            .iter()
            .all(|e| e.observed_ip == "unavailable"
                && e.ip_attribution == IpAttribution::Unavailable
                && e.proxy_hop.is_none())
    );
    let log = String::from_utf8_lossy(&captured.0.lock().unwrap()).into_owned();
    assert!(
        log.contains("debit commit failed"),
        "the test must see a log line"
    );
    for output in [&text, &log] {
        assert!(!output.contains("198.51.100"), "socket IP leaked");
        assert!(!output.contains("203.0.113"), "forwarded IP leaked");
    }
    // Keys, proofs, and the admin token are not in the log either.
    assert!(!log.contains(ADMIN_TOKEN));
    assert!(!log.contains("fake_public_inputs"));
}

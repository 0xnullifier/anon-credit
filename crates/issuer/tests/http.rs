//! The HTTP API through the router: status codes, error bodies, strict inputs, CORS, and the
//! path endpoint against the registry verifier.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod common;

use alloy::primitives::B256;
use anon_credit_crypto::FieldElement;
use anon_credit_crypto::batch::leaf;
use anon_credit_issuer::http::router;
use anon_credit_protocol::error::{ErrorBody, ErrorCode};
use anon_credit_protocol::issuer_api::{
    EpochResponse, IssuerConfigResponse, IssuerRootsResponse, LeafEventsResponse, PendingReason,
    RootEventsResponse, TopupResponse, TopupStatus, TreePathResponse,
};
use anon_credit_registry::{MembershipProof, verify_proof};
use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use common::*;
use serde::de::DeserializeOwned;
use tower::ServiceExt;

struct Reply {
    status: StatusCode,
    headers: axum::http::HeaderMap,
    body: Vec<u8>,
}

impl Reply {
    fn json<T: DeserializeOwned>(&self) -> T {
        serde_json::from_slice(&self.body)
            .unwrap_or_else(|e| panic!("{e}: {}", String::from_utf8_lossy(&self.body)))
    }

    fn error(&self, status: StatusCode, code: ErrorCode) {
        assert_eq!(
            self.status,
            status,
            "{}",
            String::from_utf8_lossy(&self.body)
        );
        let body: ErrorBody = self.json();
        assert_eq!(body.code, code);
        assert_eq!(body.retryable, code.retryable());
    }
}

async fn send(h: &Harness, request: Request<Body>) -> Reply {
    let response = router(h.service.clone()).oneshot(request).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let body = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap()
        .to_vec();
    Reply {
        status,
        headers,
        body,
    }
}

async fn get(h: &Harness, uri: &str) -> Reply {
    send(h, Request::get(uri).body(Body::empty()).unwrap()).await
}

async fn post(h: &Harness, uri: &str, json: &str) -> Reply {
    let request = Request::post(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json.to_owned()))
        .unwrap();
    send(h, request).await
}

fn hex32(value: B256) -> String {
    format!("0x{}", hex::encode(value))
}

fn topup_json(tx_hash: B256, log_index: u32) -> String {
    format!(
        r#"{{"tx_hash":"{}","log_index":{log_index}}}"#,
        hex32(tx_hash)
    )
}

#[tokio::test]
async fn config_and_epoch() {
    let h = harness().await;
    let reply = get(&h, "/v1/config").await;
    assert_eq!(reply.status, StatusCode::OK);
    let config: IssuerConfigResponse = reply.json();
    assert_eq!(config.deployment, deployment());
    assert_eq!(config.deployment_id, deployment().deployment_id());
    assert_eq!(config.batch_price_wei.0, PRICE);
    assert_eq!(config.max_batches_per_purchase, 100);
    assert_eq!(config.root_window_epochs, 96);

    h.clock.advance(12);
    let epoch: EpochResponse = get(&h, "/v1/epoch").await.json();
    assert_eq!(epoch.epoch.0, 1000);
    assert_eq!(epoch.epoch_seconds, 30);
    assert_eq!(epoch.now.0, T0 + 12);
    assert_eq!(epoch.seconds_until_next, 18);
}

#[tokio::test]
async fn topup_registration_and_status() {
    let h = harness().await;
    h.chain
        .purchase(tx(1), 50, 3, 0, &[commitment(1), commitment(2)]);
    h.chain.finalize(49);

    let reply = post(&h, "/v1/topups", &topup_json(tx(1), 3)).await;
    assert_eq!(reply.status, StatusCode::ACCEPTED);
    let pending: TopupResponse = reply.json();
    assert_eq!(pending.status, TopupStatus::Pending);
    assert_eq!(
        pending.pending_reason,
        Some(PendingReason::AwaitingFinality)
    );
    assert!(pending.issuance.is_none());

    let uri = format!("/v1/topups/{}/3", hex32(tx(1)));
    let reply = get(&h, &uri).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.json::<TopupResponse>().status, TopupStatus::Pending);

    h.chain.finalize(50);
    let reply = post(&h, "/v1/topups", &topup_json(tx(1), 3)).await;
    assert_eq!(reply.status, StatusCode::OK);
    let issued: TopupResponse = reply.json();
    assert_eq!(issued.status, TopupStatus::Issued);
    assert_eq!(issued.issuance.as_ref().unwrap().leaves.len(), 2);
    let again: TopupResponse = get(&h, &uri).await.json();
    assert_eq!(again, issued);

    get(&h, &format!("/v1/topups/{}/4", hex32(tx(1))))
        .await
        .error(StatusCode::NOT_FOUND, ErrorCode::NotFound);
    get(&h, "/v1/topups/0xABCD/3")
        .await
        .error(StatusCode::BAD_REQUEST, ErrorCode::InvalidRequest);
    get(&h, &format!("/v1/topups/{}/-1", hex32(tx(1))))
        .await
        .error(StatusCode::BAD_REQUEST, ErrorCode::InvalidRequest);
}

#[tokio::test]
async fn topup_request_is_strict() {
    let h = harness().await;
    let extra = format!(
        r#"{{"tx_hash":"{}","log_index":0,"commitments":["0x01"]}}"#,
        hex32(tx(1))
    );
    post(&h, "/v1/topups", &extra)
        .await
        .error(StatusCode::BAD_REQUEST, ErrorCode::InvalidRequest);
    let upper = topup_json(tx(1), 0)
        .to_uppercase()
        .replace("0X", "0x")
        .replace("TX_HASH", "tx_hash")
        .replace("LOG_INDEX", "log_index");
    post(&h, "/v1/topups", &upper)
        .await
        .error(StatusCode::BAD_REQUEST, ErrorCode::InvalidRequest);
    post(&h, "/v1/topups", "not json")
        .await
        .error(StatusCode::BAD_REQUEST, ErrorCode::InvalidRequest);
    let big = format!(
        r#"{{"tx_hash":"{}","log_index":0,"x":"{}"}}"#,
        hex32(tx(1)),
        "a".repeat(10_000)
    );
    post(&h, "/v1/topups", &big)
        .await
        .error(StatusCode::BAD_REQUEST, ErrorCode::InvalidRequest);
}

#[tokio::test]
async fn invalid_payment_is_unprocessable() {
    let h = harness().await;
    let other = alloy::primitives::Address::repeat_byte(0x42);
    let log = purchased_log(
        other,
        tx(5),
        10,
        0,
        0,
        &[commitment(1)],
        alloy::primitives::U256::from(PRICE),
    );
    h.chain.add_receipt(tx(5), 10, true, vec![log]);
    h.chain.finalize(10);
    post(&h, "/v1/topups", &topup_json(tx(5), 0))
        .await
        .error(StatusCode::UNPROCESSABLE_ENTITY, ErrorCode::PaymentInvalid);
}

#[tokio::test]
async fn chain_failure_is_pending_and_storage_errors_are_retryable() {
    let h = harness().await;
    h.chain.state().down = true;
    let reply = post(&h, "/v1/topups", &topup_json(tx(1), 0)).await;
    assert_eq!(reply.status, StatusCode::ACCEPTED);
    assert_eq!(
        reply.json::<TopupResponse>().pending_reason,
        Some(PendingReason::ChainUnavailable)
    );
    h.pool.close().await;
    get(&h, "/v1/roots").await.error(
        StatusCode::SERVICE_UNAVAILABLE,
        ErrorCode::StorageUnavailable,
    );
}

/// Issue 5 leaves in epoch 1000 and 2 leaves in epoch 1001, and snapshot epochs 999 to 1001.
async fn build_tree(h: &Harness) -> (Vec<FieldElement>, Vec<FieldElement>) {
    h.chain.publisher_off();
    h.service.publisher_tick().await.unwrap();
    let first: Vec<FieldElement> = (1..=5).map(commitment).collect();
    h.chain.purchase(tx(1), 10, 0, 0, &first[..3]);
    h.chain.purchase(tx(2), 11, 0, 1, &first[3..]);
    h.chain.finalize(11);
    h.service.indexer_tick().await.unwrap();
    h.clock.advance(30);
    h.service.publisher_tick().await.unwrap();
    let second: Vec<FieldElement> = (6..=7).map(commitment).collect();
    h.chain.purchase(tx(3), 12, 0, 2, &second);
    h.chain.finalize(12);
    h.service.indexer_tick().await.unwrap();
    h.clock.advance(30);
    h.service.publisher_tick().await.unwrap();
    (first, second)
}

#[tokio::test]
async fn path_endpoint_proofs_verify_with_the_registry() {
    let h = harness().await;
    let (first, second) = build_tree(&h).await;
    let roots: IssuerRootsResponse = get(&h, "/v1/roots").await.json();
    let epochs: Vec<u64> = roots.roots.iter().map(|r| r.epoch.0).collect();
    assert_eq!(epochs, vec![999, 1000, 1001]);
    let counts: Vec<u32> = roots.roots.iter().map(|r| r.leaf_count).collect();
    assert_eq!(counts, vec![0, 5, 7]);

    let expiry_first = 1000 + u64::from(LIFETIME);
    let expiry_second = 1001 + u64::from(LIFETIME);
    for record in &roots.roots {
        for index in 0..record.leaf_count {
            let uri = format!("/v1/tree/path/{index}?root={}", record.root.to_hex());
            let reply = get(&h, &uri).await;
            assert_eq!(reply.status, StatusCode::OK);
            let path: TreePathResponse = reply.json();
            assert_eq!(path.root, record.root);
            assert_eq!(path.epoch, record.epoch);
            // The JSON proof is the registry proof form.
            let proof: MembershipProof =
                serde_json::from_value(serde_json::to_value(&path.proof).unwrap()).unwrap();
            assert!(verify_proof(record.root, &proof, path.leaf));
            let expected = match index {
                0..5 => leaf(first[index as usize], expiry_first),
                _ => leaf(second[index as usize - 5], expiry_second),
            };
            assert_eq!(path.leaf, expected);
        }
        // A leaf after the snapshot is not in it.
        let uri = format!(
            "/v1/tree/path/{}?root={}",
            record.leaf_count,
            record.root.to_hex()
        );
        get(&h, &uri)
            .await
            .error(StatusCode::NOT_FOUND, ErrorCode::NotFound);
    }

    let unknown = FieldElement::from_u64(12345).to_hex();
    get(&h, &format!("/v1/tree/path/0?root={unknown}"))
        .await
        .error(StatusCode::NOT_FOUND, ErrorCode::NotFound);
    get(&h, "/v1/tree/path/0")
        .await
        .error(StatusCode::BAD_REQUEST, ErrorCode::InvalidRequest);
    let modulus = "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001";
    get(&h, &format!("/v1/tree/path/0?root={modulus}"))
        .await
        .error(StatusCode::BAD_REQUEST, ErrorCode::InvalidRequest);
    let root = roots.roots[1].root.to_hex();
    get(&h, &format!("/v1/tree/path/0?root={root}&extra=1"))
        .await
        .error(StatusCode::BAD_REQUEST, ErrorCode::InvalidRequest);
    get(&h, &format!("/v1/tree/path/x?root={root}"))
        .await
        .error(StatusCode::BAD_REQUEST, ErrorCode::InvalidRequest);
}

#[tokio::test]
async fn event_endpoints() {
    let h = harness().await;
    build_tree(&h).await;
    let leaves: LeafEventsResponse = get(&h, "/v1/events/leaves?from=2&limit=3").await.json();
    assert_eq!(leaves.leaf_count, 7);
    let indices: Vec<u32> = leaves.events.iter().map(|e| e.index).collect();
    assert_eq!(indices, vec![2, 3, 4]);
    let all: LeafEventsResponse = get(&h, "/v1/events/leaves").await.json();
    assert_eq!(all.events.len(), 7);
    get(&h, "/v1/events/leaves?limit=0")
        .await
        .error(StatusCode::BAD_REQUEST, ErrorCode::InvalidRequest);
    get(&h, "/v1/events/leaves?from=01")
        .await
        .error(StatusCode::BAD_REQUEST, ErrorCode::InvalidRequest);
    get(&h, "/v1/events/leaves?start=1")
        .await
        .error(StatusCode::BAD_REQUEST, ErrorCode::InvalidRequest);

    // No root is sent without a publisher key, so there are no root events.
    let roots: RootEventsResponse = get(&h, "/v1/events/roots?from=0").await.json();
    assert!(roots.events.is_empty());
    let page: IssuerRootsResponse = get(&h, "/v1/roots?from=1000&limit=1").await.json();
    assert_eq!(page.roots.len(), 1);
    assert_eq!(page.roots[0].epoch.0, 1000);
}

#[tokio::test]
async fn cors_allows_get_only_and_unknown_routes_have_error_bodies() {
    let h = harness().await;
    let request = Request::get("/v1/epoch")
        .header(header::ORIGIN, "https://example.org")
        .body(Body::empty())
        .unwrap();
    let reply = send(&h, request).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(
        reply
            .headers
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .unwrap(),
        "*"
    );
    let preflight = Request::builder()
        .method(Method::OPTIONS)
        .uri("/v1/topups")
        .header(header::ORIGIN, "https://example.org")
        .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
        .body(Body::empty())
        .unwrap();
    let reply = send(&h, preflight).await;
    let allowed = reply
        .headers
        .get(header::ACCESS_CONTROL_ALLOW_METHODS)
        .map(|v| v.to_str().unwrap().to_owned())
        .unwrap_or_default();
    assert!(!allowed.contains("POST"), "allowed methods: {allowed}");

    get(&h, "/v1/nothing")
        .await
        .error(StatusCode::NOT_FOUND, ErrorCode::NotFound);
    let delete = Request::delete("/v1/config").body(Body::empty()).unwrap();
    send(&h, delete)
        .await
        .error(StatusCode::METHOD_NOT_ALLOWED, ErrorCode::InvalidRequest);
}

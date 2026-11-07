//! Open pipeline tests (implementation.md section 11, Architecture.md section 5.1).

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod common;

use anon_credit_crypto::FieldElement;
use anon_credit_protocol::api::{
    GatewayConfigResponse, OpenResponse, PricesResponse, RootsResponse, SessionStatus,
};
use anon_credit_protocol::{Bytes32, ErrorCode, PriceTable};
use axum::http::StatusCode;
use common::*;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use tokio::sync::Semaphore;

#[tokio::test]
async fn open_happy_path_creates_one_session() {
    let h = Harness::new().await;
    let client = Client::new(1);
    let response = h.open(&client).await;
    assert_eq!(response.status, StatusCode::OK);
    let body: OpenResponse = response.json();
    assert!(!body.existing);
    assert_eq!(body.session.batch_id, client.batch_id);
    assert_eq!(body.session.remaining, 100);
    assert_eq!(body.session.next_seq.0, 0);
    assert_eq!(body.session.units_total.0, 0);
    assert_eq!(body.session.open_epoch.0, h.epoch());
    assert_eq!(body.session.deadline_epoch.0, h.epoch() + 35_040);
    assert_eq!(body.session.state, SessionStatus::Active);
    assert_eq!(h.verifier.calls.load(Ordering::SeqCst), 1);

    let row = h.session_row(&client).await.unwrap();
    assert_eq!(row.session_pub, client.session_pub());
    assert!(!row.open_request_json.contains("\"proof\""));
    assert!(row.open_request_json.contains("proof_keccak256"));
    assert!(row.proof_size > 0);
}

#[tokio::test]
async fn gateway_builds_public_inputs_in_circuit_order() {
    let h = Harness::new().await;
    let client = Client::new(2);
    h.open_ok(&client).await;
    let inputs = h.verifier.last_inputs.lock().unwrap().clone();
    let config = &h.gateway.config;
    let binding =
        anon_credit_crypto::batch::session_binding(&config.gateway_id().0, &client.session_pub().0);
    let [dep_hi, dep_lo] = anon_credit_crypto::bytes32_to_limbs(&config.deployment_id.0);
    let [gw_hi, gw_lo] = anon_credit_crypto::bytes32_to_limbs(&config.gateway_id().0);
    // adapters.rs checks the same builder against fixtures/protocol/batch-open-public-inputs.json.
    let expected = vec![
        anon_credit_crypto::constants::CIRCUIT_ID,
        dep_hi,
        dep_lo,
        gw_hi,
        gw_lo,
        FieldElement::from_bytes_be(&root().0).unwrap(),
        FieldElement::from_u64(u64::from(LEAF_COUNT)),
        FieldElement::from_u64(h.epoch()),
        FieldElement::from_bytes_be(&client.batch_id.0).unwrap(),
        binding,
    ];
    assert_eq!(inputs, expected);
}

#[tokio::test]
async fn altered_binding_is_rejected_and_writes_nothing() {
    let h = Harness::new().await;
    let client = Client::new(3);
    let other = Client::new(4);
    // The proof binds another session key. The request carries the client key.
    let options = OpenOptions {
        proof_session_pub: Some(other.session_pub()),
        ..OpenOptions::default()
    };
    let request = client.open_request(&h, &options);
    let response = h
        .post("/v1/open", serde_json::to_vec(&request).unwrap())
        .await;
    assert_eq!(response.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(response.error_code(), ErrorCode::ProofInvalid);
    assert!(h.session_row(&client).await.is_none());
}

#[tokio::test]
async fn proof_epoch_must_be_current_or_previous() {
    let h = Harness::new().await;
    let stale = OpenOptions {
        proof_epoch: Some(h.epoch() - 2),
        ..OpenOptions::default()
    };
    let client = Client::new(5);
    let request = client.open_request(&h, &stale);
    let response = h
        .post("/v1/open", serde_json::to_vec(&request).unwrap())
        .await;
    assert_eq!(response.error_code(), ErrorCode::ProofEpochStale);
    let future = OpenOptions {
        proof_epoch: Some(h.epoch() + 1),
        ..OpenOptions::default()
    };
    let request = client.open_request(&h, &future);
    let response = h
        .post("/v1/open", serde_json::to_vec(&request).unwrap())
        .await;
    assert_eq!(response.error_code(), ErrorCode::ProofEpochStale);
    assert_eq!(h.verifier.calls.load(Ordering::SeqCst), 0);

    let previous = OpenOptions {
        proof_epoch: Some(h.epoch() - 1),
        ..OpenOptions::default()
    };
    let request = client.open_request(&h, &previous);
    let response = h
        .post("/v1/open", serde_json::to_vec(&request).unwrap())
        .await;
    assert_eq!(response.status, StatusCode::OK);
}

#[tokio::test]
async fn unaccepted_roots_are_rejected_before_the_proof() {
    let h = Harness::new().await;
    let client = Client::new(6);
    let unknown = OpenOptions {
        root: Some(Bytes32(FieldElement::from_u64(1).to_bytes_be())),
        ..OpenOptions::default()
    };
    let request = client.open_request(&h, &unknown);
    let response = h
        .post("/v1/open", serde_json::to_vec(&request).unwrap())
        .await;
    assert_eq!(response.error_code(), ErrorCode::RootNotAccepted);

    let wrong_count = OpenOptions {
        leaf_count: Some(LEAF_COUNT + 1),
        ..OpenOptions::default()
    };
    let request = client.open_request(&h, &wrong_count);
    let response = h
        .post("/v1/open", serde_json::to_vec(&request).unwrap())
        .await;
    assert_eq!(response.error_code(), ErrorCode::RootNotAccepted);
    assert_eq!(h.verifier.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn root_leaves_the_window_after_96_source_epochs() {
    let h = Harness::new().await;
    let source_epoch = h.epoch() - 1;
    // At current = source + 95 the root is still accepted.
    h.clock
        .set_unix((source_epoch + 95) * u64::from(EPOCH_SECONDS));
    let roots: RootsResponse = h.get("/v1/roots").await.json();
    assert_eq!(roots.roots.len(), 1);
    let client = Client::new(7);
    h.open_ok(&client).await;
    // At current = source + 96 it is not accepted.
    h.clock
        .set_unix((source_epoch + 96) * u64::from(EPOCH_SECONDS));
    let roots: RootsResponse = h.get("/v1/roots").await.json();
    assert!(roots.roots.is_empty());
    let late = Client::new(8);
    let response = h.open(&late).await;
    assert_eq!(response.error_code(), ErrorCode::RootNotAccepted);
}

#[tokio::test]
async fn bad_open_signature_is_rejected_before_the_proof() {
    let h = Harness::new().await;
    let client = Client::new(9);
    let options = OpenOptions {
        bad_signature: true,
        ..OpenOptions::default()
    };
    let request = client.open_request(&h, &options);
    let response = h
        .post("/v1/open", serde_json::to_vec(&request).unwrap())
        .await;
    assert_eq!(response.error_code(), ErrorCode::SignatureInvalid);
    assert_eq!(h.verifier.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn identities_version_price_table_and_schema_are_checked() {
    let h = Harness::new().await;
    let client = Client::new(10);
    let mut request = client.open_request(&h, &OpenOptions::default());
    request.gateway_id = Bytes32([1; 32]);
    let response = h
        .post("/v1/open", serde_json::to_vec(&request).unwrap())
        .await;
    assert_eq!(response.error_code(), ErrorCode::InvalidRequest);

    let mut request = client.open_request(&h, &OpenOptions::default());
    request.protocol_version = 2;
    let response = h
        .post("/v1/open", serde_json::to_vec(&request).unwrap())
        .await;
    assert_eq!(response.error_code(), ErrorCode::UnsupportedVersion);

    let other_table = OpenOptions {
        price_table_hash: Some(Bytes32([3; 32])),
        ..OpenOptions::default()
    };
    let request = client.open_request(&h, &other_table);
    let response = h
        .post("/v1/open", serde_json::to_vec(&request).unwrap())
        .await;
    assert_eq!(response.error_code(), ErrorCode::InvalidRequest);

    let mut value = serde_json::to_value(client.open_request(&h, &OpenOptions::default())).unwrap();
    value["extra"] = serde_json::json!(1);
    let response = h
        .post("/v1/open", serde_json::to_vec(&value).unwrap())
        .await;
    assert_eq!(response.error_code(), ErrorCode::InvalidRequest);

    let mut request = client.open_request(&h, &OpenOptions::default());
    request.batch_id = Bytes32([0xff; 32]);
    let response = h
        .post("/v1/open", serde_json::to_vec(&request).unwrap())
        .await;
    assert_eq!(response.error_code(), ErrorCode::InvalidRequest);
    assert!(h.session_row(&client).await.is_none());
}

#[tokio::test]
async fn open_body_limit_applies_before_parsing() {
    let limits = anon_credit_gateway::app::Limits {
        open_body_bytes: 1024,
        ..anon_credit_gateway::app::Limits::default()
    };
    let h = Harness::with(Options {
        limits,
        ..Options::default()
    })
    .await;
    let response = h.post("/v1/open", vec![b' '; 2048]).await;
    assert_eq!(response.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(response.error_code(), ErrorCode::InvalidRequest);
}

#[tokio::test]
async fn exact_retry_returns_existing_state_without_reset() {
    let h = Harness::new().await;
    let client = Client::new(11);
    let request = client.open_request(&h, &OpenOptions::default());
    let body = serde_json::to_vec(&request).unwrap();
    assert_eq!(
        h.post("/v1/open", body.clone()).await.status,
        StatusCode::OK
    );

    // Spend one unit, then let the proof epoch age out.
    let spend = client.spend_request(&h, 0, 1, rpc_bytes("eth_chainId", 1));
    assert_eq!(h.spend(&spend).await.status, StatusCode::OK);
    h.clock.advance_secs(10 * u64::from(EPOCH_SECONDS));

    let retry = h.post("/v1/open", body).await;
    assert_eq!(retry.status, StatusCode::OK);
    let state: OpenResponse = retry.json();
    assert!(state.existing);
    assert_eq!(state.session.remaining, 99);
    assert_eq!(state.session.next_seq.0, 1);
    assert_eq!(h.verifier.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn different_key_for_an_open_batch_is_a_conflict() {
    let h = Harness::new().await;
    let client = Client::new(12);
    h.open_ok(&client).await;
    let mut thief = Client::new(13);
    thief.batch_id = client.batch_id;
    let response = h.open(&thief).await;
    assert_eq!(response.status, StatusCode::CONFLICT);
    assert_eq!(response.error_code(), ErrorCode::SessionConflict);
    let row = h.session_row(&client).await.unwrap();
    assert_eq!(row.session_pub, client.session_pub());

    // The same key with a new signed message (another proof epoch) is also a conflict.
    h.clock.advance_secs(u64::from(EPOCH_SECONDS));
    let response = h.open(&client).await;
    assert_eq!(response.error_code(), ErrorCode::SessionConflict);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_opens_of_one_batch_create_one_session() {
    let h = Arc::new(Harness::new().await);
    let gate = Arc::new(Semaphore::new(0));
    *h.verifier.gate.lock().unwrap() = Some(gate.clone());
    let client = Client::new(14);
    let body = serde_json::to_vec(&client.open_request(&h, &OpenOptions::default())).unwrap();
    let mut tasks = Vec::new();
    for _ in 0..2 {
        let h = h.clone();
        let body = body.clone();
        tasks.push(tokio::spawn(async move { h.post("/v1/open", body).await }));
    }
    while h.verifier.calls.load(Ordering::SeqCst) < 2 {
        tokio::task::yield_now().await;
    }
    gate.add_permits(2);
    let mut existing = 0;
    for task in tasks {
        let response = task.await.unwrap();
        assert_eq!(response.status, StatusCode::OK);
        let body: OpenResponse = response.json();
        existing += usize::from(body.existing);
    }
    assert_eq!(existing, 1);
}

#[tokio::test]
async fn full_verification_queue_gives_busy() {
    let limits = anon_credit_gateway::app::Limits {
        proof_concurrency: 1,
        proof_queue_depth: 0,
        ..anon_credit_gateway::app::Limits::default()
    };
    let h = Arc::new(
        Harness::with(Options {
            limits,
            ..Options::default()
        })
        .await,
    );
    let gate = Arc::new(Semaphore::new(0));
    *h.verifier.gate.lock().unwrap() = Some(gate.clone());
    let first = {
        let h = h.clone();
        tokio::spawn(async move { h.open(&Client::new(15)).await })
    };
    while h.verifier.calls.load(Ordering::SeqCst) < 1 {
        tokio::task::yield_now().await;
    }
    let second = h.open(&Client::new(16)).await;
    assert_eq!(second.error_code(), ErrorCode::Busy);
    assert!(
        second
            .json::<anon_credit_protocol::api::GatewayErrorBody>()
            .retryable
    );
    gate.add_permits(1);
    assert_eq!(first.await.unwrap().status, StatusCode::OK);
}

#[tokio::test]
async fn unavailable_verifier_gives_busy_and_no_session() {
    let h = Harness::new().await;
    h.verifier.unavailable.store(true, Ordering::SeqCst);
    let client = Client::new(17);
    let response = h.open(&client).await;
    assert_eq!(response.error_code(), ErrorCode::Busy);
    assert!(h.session_row(&client).await.is_none());
}

#[tokio::test]
async fn config_prices_and_roots_are_published() {
    let h = Harness::new().await;
    let config: GatewayConfigResponse = h.get("/v1/config").await.json();
    assert_eq!(config.gateway_id, h.gateway.config.gateway_id());
    assert_eq!(config.deployment_id, deployment().deployment_id());
    assert_eq!(config.limits.spend_body_bytes, 64 * 1024);
    assert_eq!(config.limits.open_body_bytes, 16 * 1024 * 1024);
    assert_eq!(config.root_window_epochs, 96);
    assert!(!config.demo_peer_enabled);
    assert_eq!(
        config.block_tag,
        anon_credit_protocol::settings::BlockTag::Finalized
    );
    let prices: PricesResponse = h.get("/v1/prices").await.json();
    assert_eq!(prices.price_table, PriceTable::initial());
    assert_eq!(prices.price_table_hash, prices.price_table.hash());
    assert_eq!(config.price_table_hash, prices.price_table_hash);
    let roots: RootsResponse = h.get("/v1/roots").await.json();
    assert_eq!(roots.roots.len(), 1);
    assert_eq!(roots.roots[0].root, root());
    assert_eq!(roots.roots[0].leaf_count, LEAF_COUNT);
    // The demo probe is off in the normal profile.
    assert_eq!(h.get("/v1/demo/peer").await.status, StatusCode::NOT_FOUND);
}

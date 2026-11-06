//! Adapter tests: public-input order against the shared fixtures, the verifier startup check,
//! the sidecar and upstream HTTP clients against loopback servers, and the root tracker.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod common;

use anon_credit_crypto::FieldElement;
use anon_credit_crypto::constants::CIRCUIT_ID;
use anon_credit_gateway::open::build_public_inputs;
use anon_credit_gateway::roots::{RootSource, RootTracker};
use anon_credit_gateway::upstream::{HttpUpstream, Upstream, UpstreamError, read_chain_id};
use anon_credit_gateway::verifier::{
    ProofVerifier, SidecarVerifier, VerifierCheckError, VerifierError, check_verifier,
};
use anon_credit_protocol::Bytes32;
use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use common::*;
use serde::Deserialize;
use serde_json::{Value, json};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const PUBLIC_INPUTS: &str =
    include_str!("../../../fixtures/protocol/batch-open-public-inputs.json");
const BATCH_OPEN: &str = include_str!("../../../fixtures/protocol/batch-open.json");

#[derive(Deserialize)]
struct CaseInput {
    deployment_id: Bytes32,
    gateway_id: Bytes32,
    session_pub: Bytes32,
    root: FieldElement,
    leaf_count: u32,
    proof_epoch: String,
    batch_id: FieldElement,
}

fn build(input: &CaseInput) -> Vec<String> {
    build_public_inputs(
        &input.deployment_id,
        &input.gateway_id,
        input.root,
        input.leaf_count,
        input.proof_epoch.parse().unwrap(),
        input.batch_id,
        &input.session_pub,
    )
    .iter()
    .map(FieldElement::to_hex)
    .collect()
}

#[test]
fn public_inputs_match_the_pinned_order_and_gate_case() {
    let file: Value = serde_json::from_str(PUBLIC_INPUTS).unwrap();
    let names: Vec<&str> = file["order"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        [
            "circuit_id",
            "deployment_id_hi",
            "deployment_id_lo",
            "gateway_id_hi",
            "gateway_id_lo",
            "root",
            "leaf_count",
            "proof_epoch",
            "batch_id",
            "binding"
        ]
    );
    assert_eq!(file["count"], 10);
    let case = &file["gate_case"];
    let input: CaseInput = serde_json::from_value(case["input"].clone()).unwrap();
    let expected: Vec<String> = serde_json::from_value(case["public_inputs"].clone()).unwrap();
    assert_eq!(build(&input), expected);
    assert_eq!(expected[0], CIRCUIT_ID.to_hex());
}

#[test]
fn public_inputs_match_every_batch_open_vector() {
    let file: Value = serde_json::from_str(BATCH_OPEN).unwrap();
    let cases = file["cases"].as_array().unwrap();
    assert!(!cases.is_empty());
    for case in cases {
        let witness = &case["witness"];
        let input = CaseInput {
            deployment_id: serde_json::from_value(case["input"]["deployment_id"].clone()).unwrap(),
            gateway_id: serde_json::from_value(case["input"]["gateway_id"].clone()).unwrap(),
            session_pub: serde_json::from_value(case["input"]["session_pub"].clone()).unwrap(),
            root: serde_json::from_value(witness["root"].clone()).unwrap(),
            leaf_count: serde_json::from_value(witness["leaf_count"].clone()).unwrap(),
            proof_epoch: serde_json::from_value(witness["proof_epoch"].clone()).unwrap(),
            batch_id: serde_json::from_value(witness["batch_id"].clone()).unwrap(),
        };
        let expected: Vec<String> = serde_json::from_value(case["public_inputs"].clone()).unwrap();
        assert_eq!(build(&input), expected, "case {}", case["name"]);
    }
}

#[tokio::test]
async fn verifier_check_needs_pinned_key_zk_mode_and_circuit() {
    let verifier = FakeVerifier::default();
    assert!(check_verifier(&verifier, &VERIFIER_HASH).await.is_ok());
    // A 0x prefix and uppercase digits are the same digest.
    verifier.health.lock().unwrap().pkv_sha256 = VERIFIER_HASH
        .to_hex()
        .to_uppercase()
        .replacen("0X", "0x", 1);
    assert!(check_verifier(&verifier, &VERIFIER_HASH).await.is_ok());
    assert!(matches!(
        check_verifier(&verifier, &Bytes32([1; 32])).await,
        Err(VerifierCheckError::WrongArtifact { .. })
    ));
    verifier.health.lock().unwrap().witness_mode = "standard".to_owned();
    assert!(matches!(
        check_verifier(&verifier, &VERIFIER_HASH).await,
        Err(VerifierCheckError::NotHiding(_))
    ));
    verifier.health.lock().unwrap().witness_mode = "zk".to_owned();
    verifier.health.lock().unwrap().circuit_id = FieldElement::from_u64(1).to_hex();
    assert!(matches!(
        check_verifier(&verifier, &VERIFIER_HASH).await,
        Err(VerifierCheckError::WrongCircuit(_))
    ));
}

async fn serve_local(app: Router) -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    addr
}

#[tokio::test]
async fn sidecar_client_follows_the_sidecar_contract() {
    let seen: Arc<Mutex<Vec<Value>>> = Arc::default();
    let record = seen.clone();
    let app = Router::new()
        .route(
            "/health",
            get(|| async {
                Json(json!({
                    "ok": true,
                    "pkv_sha256": "99".repeat(32),
                    "circuit_id": CIRCUIT_ID.to_hex(),
                    "witness_mode": "zk",
                    "hash": "skyscraper",
                    "provekit_rev": "x",
                    "num_public_inputs": 10,
                    "num_constraints": 1,
                    "max_concurrency": 2,
                    "max_body_bytes": 1
                }))
            }),
        )
        .route(
            "/verify",
            post(move |Json(body): Json<Value>| {
                let record = record.clone();
                async move {
                    record.lock().unwrap().push(body.clone());
                    match body["proof"].as_str() {
                        Some("AAEC") => Json(json!({"ok": true, "duration_ms": 9.2, "error_code": null})).into_response(),
                        Some("AAED") => Json(json!({"ok": false, "duration_ms": 1.0, "error_code": "public_input_mismatch"})).into_response(),
                        _ => (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"ok": false, "duration_ms": 0.0, "error_code": "busy"}))).into_response(),
                    }
                }
            }),
        );
    let addr = serve_local(app).await;
    let base = reqwest::Url::parse(&format!("http://{addr}")).unwrap();
    let client = SidecarVerifier::new(base, Duration::from_secs(5)).unwrap();
    let health = check_verifier(&client, &VERIFIER_HASH).await.unwrap();
    assert_eq!(health.witness_mode, "zk");

    let inputs = [CIRCUIT_ID, FieldElement::from_u64(5)];
    let outcome = client.verify(&[0, 1, 2], &inputs).await.unwrap();
    assert!(outcome.ok);
    assert_eq!(outcome.duration_ms, 10);
    let request = seen.lock().unwrap()[0].clone();
    assert_eq!(request["proof"], "AAEC");
    assert_eq!(
        request["public_inputs"],
        json!([CIRCUIT_ID.to_hex(), FieldElement::from_u64(5).to_hex()])
    );
    let rejected = client.verify(&[0, 1, 3], &inputs).await.unwrap();
    assert!(!rejected.ok);
    assert_eq!(
        rejected.error_code.as_deref(),
        Some("public_input_mismatch")
    );
    // A busy sidecar is not a proof rejection.
    assert!(matches!(
        client.verify(&[9], &inputs).await,
        Err(VerifierError::Unavailable(_))
    ));
}

#[tokio::test]
async fn sidecar_down_is_unavailable() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    drop(listener);
    let client = SidecarVerifier::new(
        reqwest::Url::parse(&format!("http://{addr}")).unwrap(),
        Duration::from_secs(2),
    )
    .unwrap();
    assert!(matches!(
        check_verifier(&client, &VERIFIER_HASH).await,
        Err(VerifierCheckError::Unavailable(_))
    ));
}

#[tokio::test]
async fn http_upstream_enforces_status_size_and_timeout() {
    let app = Router::new()
        .route(
            "/ok",
            post(|body: Bytes| async move {
                let request: Value = serde_json::from_slice(&body).unwrap();
                Json(json!({"jsonrpc": "2.0", "id": request["id"], "result": "0xaa36a7"}))
            }),
        )
        .route("/big", post(|| async { "x".repeat(4096) }))
        .route(
            "/bad",
            post(|| async { (StatusCode::TOO_MANY_REQUESTS, "slow down") }),
        )
        .route(
            "/slow",
            post(|| async {
                tokio::time::sleep(Duration::from_secs(2)).await;
                "late"
            }),
        );
    let addr = serve_local(app).await;
    let url = |path: &str| reqwest::Url::parse(&format!("http://{addr}{path}")).unwrap();
    let make = |path: &str| HttpUpstream::new(url(path), Duration::from_millis(300), 1024).unwrap();

    let ok = make("/ok");
    assert_eq!(read_chain_id(&ok).await.unwrap(), 11_155_111);
    let reply = ok
        .call(Bytes::from_static(
            br#"{"jsonrpc":"2.0","id":4,"method":"eth_chainId"}"#,
        ))
        .await
        .unwrap();
    assert_eq!(reply.status, 200);

    assert_eq!(
        make("/big").call(Bytes::from_static(b"{}")).await,
        Err(UpstreamError::TooLarge(1024))
    );
    assert_eq!(
        make("/bad")
            .call(Bytes::from_static(b"{}"))
            .await
            .unwrap()
            .status,
        429
    );
    assert!(matches!(
        make("/slow").call(Bytes::from_static(b"{}")).await,
        Err(UpstreamError::Transport(_))
    ));
    assert!(read_chain_id(&make("/bad")).await.is_err());
}

#[tokio::test]
async fn root_tracker_skips_empty_epochs_and_rejects_bad_roots() {
    let source = Arc::new(FakeRoots::default());
    source.publish(10, root(), 3);
    // Epoch 11 is skipped. Epoch 12 has a newer root.
    let newer = Bytes32(FieldElement::from_u64(42).to_bytes_be());
    source.publish(12, newer, 5);
    let tracker = RootTracker::new(source.clone(), Vec::new());
    let added = tracker.refresh(13, 1).await.unwrap();
    assert_eq!(added.len(), 2);
    assert_eq!(
        tracker
            .accepted(13)
            .iter()
            .map(|r| r.source_epoch)
            .collect::<Vec<_>>(),
        vec![12, 10]
    );
    assert_eq!(tracker.find(&newer, 13).map(|r| r.leaf_count), Some(5));
    // A second refresh reads nothing new.
    assert!(tracker.refresh(13, 2).await.unwrap().is_empty());
    // A root that is not a canonical field element is refused.
    source.publish(13, Bytes32([0xff; 32]), 6);
    assert!(tracker.refresh(13, 3).await.is_err());
    assert!(tracker.status(13).last_error.is_some());
    // A leaf count above 2^32 - 1 is refused.
    let source = Arc::new(FakeRoots::default());
    source.publish(1, root(), u64::from(u32::MAX) + 1);
    let tracker = RootTracker::new(source, Vec::new());
    assert!(tracker.refresh(2, 1).await.is_err());
    assert!(tracker.accepted(2).is_empty());
}

#[tokio::test]
async fn root_source_trait_reports_unpublished_epochs() {
    let source = FakeRoots::default();
    source.publish(5, root(), 1);
    assert_eq!(source.latest_epoch().await.unwrap(), 5);
    assert!(source.root_at(4).await.unwrap().is_none());
}

/// One issuer root record as JSON.
fn issuer_record(epoch: u64, leaf_count: u32, root: u64, status: &str) -> Value {
    let block = match status {
        "finalized" | "included" => json!(epoch.to_string()),
        _ => Value::Null,
    };
    let tx = match status {
        "pending" | "skipped" => Value::Null,
        _ => json!(format!("0x{}", "ab".repeat(32))),
    };
    json!({
        "epoch": epoch.to_string(),
        "leaf_count": leaf_count,
        "root": FieldElement::from_u64(root).to_hex(),
        "status": status,
        "tx_hash": tx,
        "block_number": block,
    })
}

/// A fake issuer: `GET /v1/roots` with the optional `from` and `limit` query. It records the
/// query of each request.
async fn fake_issuer(records: Vec<Value>, seen: Arc<Mutex<Vec<String>>>) -> SocketAddr {
    let app = Router::new().route(
        "/v1/roots",
        get(move |query: axum::extract::RawQuery| {
            let records = records.clone();
            let seen = seen.clone();
            async move {
                let text = query.0.unwrap_or_default();
                seen.lock().unwrap().push(text.clone());
                let from = text
                    .split('&')
                    .find_map(|pair| pair.strip_prefix("from="))
                    .and_then(|value| value.parse::<u64>().ok());
                let roots: Vec<Value> = records
                    .iter()
                    .filter(|record| {
                        let epoch: u64 = record["epoch"].as_str().unwrap().parse().unwrap();
                        from.is_none_or(|start| epoch >= start)
                    })
                    .cloned()
                    .collect();
                Json(json!({"current_epoch": "20", "finalized_block": "90", "roots": roots}))
            }
        }),
    );
    serve_local(app).await
}

#[tokio::test]
async fn issuer_http_source_accepts_only_finalized_records() {
    use anon_credit_gateway::roots::IssuerHttpRootSource;
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    let records = vec![
        issuer_record(10, 3, 100, "finalized"),
        issuer_record(11, 3, 101, "skipped"),
        issuer_record(12, 5, 102, "finalized"),
        issuer_record(13, 5, 103, "included"),
        issuer_record(14, 6, 104, "submitted"),
        issuer_record(15, 6, 105, "pending"),
    ];
    let addr = fake_issuer(records, seen.clone()).await;
    let base = reqwest::Url::parse(&format!("http://{addr}")).unwrap();
    let source = IssuerHttpRootSource::new(base, Duration::from_secs(5)).unwrap();

    // The latest epoch is the newest finalized record, not the newest record.
    assert_eq!(source.latest_epoch().await.unwrap(), 12);
    let ten = source.root_at(10).await.unwrap().unwrap();
    assert_eq!(ten.root, Bytes32(FieldElement::from_u64(100).to_bytes_be()));
    assert_eq!(ten.leaf_count, 3);
    assert_eq!(source.root_at(11).await.unwrap(), None);
    assert_eq!(source.root_at(13).await.unwrap(), None);
    assert_eq!(source.root_at(15).await.unwrap(), None);
    // The default list covers epochs 10 and up, so these reads use no new request.
    assert_eq!(seen.lock().unwrap().len(), 1);

    // An epoch below the list asks the issuer from that epoch.
    assert_eq!(source.root_at(4).await.unwrap(), None);
    let queries = seen.lock().unwrap().clone();
    assert_eq!(queries.len(), 2);
    assert_eq!(queries[1], "from=4&limit=1000");

    // The tracker accepts the two finalized roots.
    let tracker = RootTracker::new(Arc::new(source), Vec::new());
    let added = tracker.refresh(20, 1).await.unwrap();
    let epochs: Vec<u64> = added.iter().map(|record| record.source_epoch).collect();
    assert_eq!(epochs, vec![10, 12]);
}

#[tokio::test]
async fn issuer_http_source_reports_bad_responses_without_the_url() {
    use anon_credit_gateway::roots::IssuerHttpRootSource;
    let app = Router::new().route(
        "/v1/roots",
        get(|| async { (StatusCode::SERVICE_UNAVAILABLE, "down") }),
    );
    let addr = serve_local(app).await;
    let base = reqwest::Url::parse(&format!("http://{addr}/?key=secret")).unwrap();
    let source = IssuerHttpRootSource::new(base, Duration::from_secs(5)).unwrap();
    let error = source.latest_epoch().await.unwrap_err();
    assert!(error.0.contains("503"));
    assert!(!error.0.contains("secret"));

    // A record with an unknown field is not valid.
    let app = Router::new().route(
        "/v1/roots",
        get(|| async {
            let mut record = issuer_record(1, 1, 1, "finalized");
            record["extra"] = json!(true);
            Json(json!({"current_epoch": "2", "finalized_block": null, "roots": [record]}))
        }),
    );
    let addr = serve_local(app).await;
    let source = IssuerHttpRootSource::new(
        reqwest::Url::parse(&format!("http://{addr}")).unwrap(),
        Duration::from_secs(5),
    )
    .unwrap();
    assert!(source.latest_epoch().await.is_err());

    // No server.
    let source = IssuerHttpRootSource::new(
        reqwest::Url::parse("http://127.0.0.1:9").unwrap(),
        Duration::from_secs(2),
    )
    .unwrap();
    assert!(source.root_at(3).await.is_err());
}

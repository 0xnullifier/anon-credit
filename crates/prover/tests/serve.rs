//! Tests of the verifier sidecar (`anon_credit_prover::serve`) with the batch-open artifacts.

// Test helpers outside `#[test]` functions also stop on bad fixtures.
#![allow(clippy::unwrap_used, clippy::panic)]

use std::path::PathBuf;

use anon_credit_prover::{
    PinnedVerifier, PublicInput, Sha256Digest,
    serve::{
        BATCH_OPEN_CIRCUIT_ID, DEFAULT_MAX_BODY_BYTES, ErrorCode, HealthResponse, ServeConfig,
        VerifyResponse, router,
    },
};
use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use base64::Engine;
use http_body_util::BodyExt;
use tower::ServiceExt;

const PKV_SHA256: &str = "c8b4fb4722bb6d926d73112223865bd2756413f6f8085e549a90dd16a8aef6d4";

fn repo(path: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(path)
}

fn app() -> Router {
    let digest = Sha256Digest::from_hex(PKV_SHA256).unwrap();
    let verifier =
        PinnedVerifier::load(&repo("artifacts/batch-open/batch-open.pkv"), &digest).unwrap();
    let circuit_id = PublicInput::from_hex(BATCH_OPEN_CIRCUIT_ID).unwrap();
    router(verifier, ServeConfig::new(circuit_id))
}

fn expected() -> Vec<String> {
    let text =
        std::fs::read_to_string(repo("fixtures/protocol/batch-open-public-inputs.json")).unwrap();
    let contract: serde_json::Value = serde_json::from_str(&text).unwrap();
    contract["gate_case"]["public_inputs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap().to_owned())
        .collect()
}

fn browser_proof() -> serde_json::Value {
    let bytes = std::fs::read(repo("artifacts/batch-open/proof.browser.json")).unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

async fn post(app: Router, body: Vec<u8>) -> (StatusCode, VerifyResponse) {
    let request = Request::post("/verify")
        .header("content-type", "application/json")
        .body(Body::from(body))
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

fn body(proof: serde_json::Value, public_inputs: Vec<String>) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({ "proof": proof, "public_inputs": public_inputs }))
        .unwrap()
}

#[tokio::test]
async fn health_reports_the_pinned_key() {
    let request = Request::get("/health").body(Body::empty()).unwrap();
    let response = app().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let health: HealthResponse = serde_json::from_slice(&bytes).unwrap();
    assert!(health.ok);
    assert_eq!(health.pkv_sha256, PKV_SHA256);
    assert_eq!(health.circuit_id, BATCH_OPEN_CIRCUIT_ID);
    assert_eq!(health.witness_mode, "zk");
    assert_eq!(health.num_public_inputs, 10);
    assert_eq!(health.max_concurrency, 2);
    assert_eq!(health.max_body_bytes, DEFAULT_MAX_BODY_BYTES);
}

#[tokio::test]
async fn valid_browser_json_proof_is_accepted() {
    let (status, response) = post(app(), body(browser_proof(), expected())).await;
    assert_eq!(status, StatusCode::OK);
    assert!(response.ok, "{response:?}");
    assert_eq!(response.error_code, None);
    assert!(response.duration_ms > 0.0);
}

#[tokio::test]
async fn valid_base64_binary_proof_is_accepted() {
    let bytes = std::fs::read(repo("artifacts/batch-open/proof.np")).unwrap();
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    let (status, response) =
        post(app(), body(serde_json::Value::String(encoded), expected())).await;
    assert_eq!(status, StatusCode::OK);
    assert!(response.ok, "{response:?}");
}

#[tokio::test]
async fn tampered_proof_is_rejected() {
    let mut proof = browser_proof();
    let text = proof["whir_r1cs_proof"]["narg_string"]
        .as_str()
        .unwrap()
        .to_owned();
    let index = text.len() / 2;
    let new = if text.as_bytes()[index] == b'a' {
        "b"
    } else {
        "a"
    };
    let mut changed = text.clone();
    changed.replace_range(index..=index, new);
    proof["whir_r1cs_proof"]["narg_string"] = serde_json::Value::String(changed);
    let (status, response) = post(app(), body(proof, expected())).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!response.ok);
    assert_eq!(response.error_code, Some(ErrorCode::ProofInvalid));
}

#[tokio::test]
async fn unexpected_public_input_is_rejected() {
    let mut inputs = expected();
    // leaf_count 100 becomes 101.
    inputs[6] = "0x65".to_owned();
    let (status, response) = post(app(), body(browser_proof(), inputs)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(response.error_code, Some(ErrorCode::PublicInputMismatch));
}

#[tokio::test]
async fn other_circuit_id_is_rejected() {
    let mut inputs = expected();
    inputs[0] = "0x1".to_owned();
    let (_, response) = post(app(), body(browser_proof(), inputs)).await;
    assert_eq!(response.error_code, Some(ErrorCode::CircuitIdMismatch));
}

#[tokio::test]
async fn wrong_public_input_count_is_rejected() {
    let mut inputs = expected();
    inputs.pop();
    let (_, response) = post(app(), body(browser_proof(), inputs)).await;
    assert_eq!(response.error_code, Some(ErrorCode::PublicInputCount));
}

#[tokio::test]
async fn oversized_body_is_rejected() {
    // A JSON string longer than the 16 MiB body limit.
    let filler = "A".repeat(DEFAULT_MAX_BODY_BYTES);
    let (status, response) = post(app(), body(serde_json::Value::String(filler), expected())).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert!(!response.ok);
    assert_eq!(response.error_code, Some(ErrorCode::BodyTooLarge));
}

#[tokio::test]
async fn oversized_proof_is_rejected_before_decoding() {
    // Under the body limit, but over the 4 MiB proof limit.
    let filler = base64::engine::general_purpose::STANDARD.encode(vec![0_u8; 5 * 1024 * 1024]);
    let (status, response) = post(app(), body(serde_json::Value::String(filler), expected())).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(response.error_code, Some(ErrorCode::ProofMalformed));
}

#[tokio::test]
async fn malformed_requests_are_rejected() {
    for bad in [
        b"not json".to_vec(),
        serde_json::to_vec(&serde_json::json!({ "proof": 7, "public_inputs": [] })).unwrap(),
        serde_json::to_vec(&serde_json::json!({ "proof": "!!", "public_inputs": [] })).unwrap(),
        body(browser_proof(), vec!["0xZZ".to_owned()]),
        serde_json::to_vec(&serde_json::json!({ "proof": {}, "public_inputs": [], "x": 1 }))
            .unwrap(),
    ] {
        let (status, response) = post(app(), bad).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(response.error_code, Some(ErrorCode::InvalidRequest));
    }
}

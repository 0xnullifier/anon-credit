//! The shared issuer API examples in `fixtures/protocol/issuer-api.json`.
//!
//! `regenerate` (ignored) writes the file from the real service on the mock chain:
//!
//! ```sh
//! cargo test -p anon-credit-issuer --test issuer_fixtures -- --ignored regenerate
//! ```
//!
//! The other tests check the file: each valid example parses and serializes back to the same
//! JSON value, each invalid example fails, the path proof verifies with the registry, and the
//! issued leaves are `H(DOM_LEAF, c, K, expiry)`. `packages/protocol` runs the same examples.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod common;

use anon_credit_crypto::batch::leaf;
use anon_credit_issuer::service::TopupOutcome;
use anon_credit_issuer::verify::PaymentKey;
use anon_credit_protocol::error::{ErrorBody, ErrorCode};
use anon_credit_protocol::issuer_api::{
    EpochResponse, IssuerConfigResponse, IssuerRootsResponse, LeafEventsResponse,
    RootEventsResponse, TopupRequest, TopupResponse, TreePathResponse,
};
use anon_credit_protocol::wire::DecimalU64;
use anon_credit_registry::{MembershipProof, verify_proof};
use common::*;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

const PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../fixtures/protocol/issuer-api.json"
);

fn to_value<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap()
}

fn outcome_body(outcome: TopupOutcome) -> TopupResponse {
    match outcome {
        TopupOutcome::Issued(body) | TopupOutcome::Pending(body) | TopupOutcome::Rejected(body) => {
            body
        }
    }
}

fn key(n: u64, log_index: u32) -> PaymentKey {
    PaymentKey {
        chain_id: CHAIN_ID,
        tx_hash: tx(n),
        log_index,
    }
}

/// Build the valid examples with the real service.
async fn valid_examples() -> Map<String, Value> {
    let h = harness().await;
    let mut valid = Map::new();
    valid.insert(
        "config_response".into(),
        to_value(&h.service.config_response()),
    );
    valid.insert(
        "topup_request".into(),
        to_value(&TopupRequest {
            tx_hash: anon_credit_protocol::Bytes32(tx(1).0),
            log_index: 2,
        }),
    );

    // Epoch 1000: snapshot of 999, published and finalized.
    h.service.publisher_tick().await.unwrap();
    let hash = h.chain.state().signed[0].hash;
    h.chain.mine(hash, 5, true);
    h.chain.finalize(5);
    h.service.publisher_tick().await.unwrap();

    // One pending payment and one issued payment of three batches.
    h.chain.purchase(
        tx(1),
        20,
        2,
        0,
        &[commitment(1), commitment(2), commitment(3)],
    );
    h.chain.purchase(tx(2), 21, 0, 1, &[commitment(4)]);
    h.chain.finalize(20);
    valid.insert(
        "topup_response_issued".into(),
        to_value(&outcome_body(
            h.service.submit_topup(&key(1, 2)).await.unwrap(),
        )),
    );
    valid.insert(
        "topup_response_pending".into(),
        to_value(&outcome_body(
            h.service.submit_topup(&key(2, 0)).await.unwrap(),
        )),
    );
    let other = alloy::primitives::Address::repeat_byte(0x42);
    let log = purchased_log(
        other,
        tx(3),
        19,
        0,
        0,
        &[commitment(9)],
        alloy::primitives::U256::from(PRICE),
    );
    h.chain.add_receipt(tx(3), 19, true, vec![log]);
    valid.insert(
        "topup_response_rejected".into(),
        to_value(&outcome_body(
            h.service.submit_topup(&key(3, 0)).await.unwrap(),
        )),
    );

    // Epoch 1001: snapshot of 1000 with three leaves, published and included.
    h.clock.advance(30 + 7);
    h.chain.state().latest_timestamp = T0 + 37;
    h.service.publisher_tick().await.unwrap();
    let hash = h.chain.state().signed[1].hash;
    h.chain.mine(hash, 22, true);
    h.service.publisher_tick().await.unwrap();

    let roots = h.service.roots(None, 1000).await.unwrap();
    let root = roots.roots[1].root;
    valid.insert("roots_response".into(), to_value(&roots));
    let path = h.service.tree_path(1, root).await.unwrap().unwrap();
    valid.insert("tree_path_response".into(), to_value(&path));
    valid.insert(
        "epoch_response".into(),
        to_value(&h.service.epoch_response()),
    );
    valid.insert(
        "leaf_events_response".into(),
        to_value(&h.service.leaf_events(0, 1000).await.unwrap()),
    );
    valid.insert(
        "root_events_response".into(),
        to_value(&h.service.root_events(0, 1000).await.unwrap()),
    );
    valid.insert(
        "error_body".into(),
        to_value(&ErrorBody::new(
            ErrorCode::NotFound,
            "the root is not a kept snapshot, or the leaf is not in it",
        )),
    );
    valid
}

fn with(value: &Value, pointer: &str, replacement: Value) -> Value {
    let mut changed = value.clone();
    *changed.pointer_mut(pointer).unwrap() = replacement;
    changed
}

fn without(value: &Value, field: &str) -> Value {
    let mut changed = value.clone();
    changed.as_object_mut().unwrap().remove(field);
    changed
}

fn invalid_examples(valid: &Map<String, Value>) -> Vec<Value> {
    let get = |name: &str| valid.get(name).unwrap().clone();
    let modulus = "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001";
    let mut extra = get("topup_request");
    extra
        .as_object_mut()
        .unwrap()
        .insert("commitments".into(), json!([]));
    let request = get("topup_request");
    let issued = get("topup_response_issued");
    let path = get("tree_path_response");
    let upper = request["tx_hash"]
        .as_str()
        .unwrap()
        .to_uppercase()
        .replace("0X", "0x");
    let cases = vec![
        ("unknown_field", "topup_request", extra),
        (
            "uppercase_hex",
            "topup_request",
            with(&request, "/tx_hash", json!(upper)),
        ),
        (
            "negative_log_index",
            "topup_request",
            with(&request, "/log_index", json!(-1)),
        ),
        (
            "string_log_index",
            "topup_request",
            with(&request, "/log_index", json!("2")),
        ),
        (
            "missing_log_index",
            "topup_request",
            without(&request, "log_index"),
        ),
        (
            "unknown_status",
            "topup_response",
            with(&issued, "/status", json!("minted")),
        ),
        (
            "missing_null_field",
            "topup_response",
            without(&issued, "pending_reason"),
        ),
        (
            "epoch_as_number",
            "topup_response",
            with(&issued, "/issuance/expiry", json!(36040)),
        ),
        (
            "leading_zero_epoch",
            "topup_response",
            with(&issued, "/issuance/expiry", json!("036040")),
        ),
        (
            "commitment_not_in_field",
            "topup_response",
            with(&issued, "/issuance/leaves/0/commitment", json!(modulus)),
        ),
        (
            "root_not_in_field",
            "tree_path_response",
            with(&path, "/root", json!(modulus)),
        ),
        ("proof_unknown_field", "tree_path_response", {
            let mut changed = path.clone();
            changed["proof"]
                .as_object_mut()
                .unwrap()
                .insert("height".into(), json!(1));
            changed
        }),
        (
            "short_sibling",
            "tree_path_response",
            with(&path, "/proof/siblings/0", json!("0x01")),
        ),
        (
            "price_leading_zero",
            "config_response",
            with(
                &get("config_response"),
                "/batch_price_wei",
                json!("0100000000000000"),
            ),
        ),
        (
            "chain_id_as_string",
            "config_response",
            with(
                &get("config_response"),
                "/deployment/payment_chain_id",
                json!("11155111"),
            ),
        ),
        (
            "epoch_as_number",
            "epoch_response",
            with(&get("epoch_response"), "/epoch", json!(1001)),
        ),
        (
            "index_as_string",
            "leaf_events_response",
            with(&get("leaf_events_response"), "/events/0/index", json!("0")),
        ),
        (
            "unknown_publication_status",
            "roots_response",
            with(&get("roots_response"), "/roots/0/status", json!("mined")),
        ),
        (
            "finalized_as_string",
            "root_events_response",
            with(
                &get("root_events_response"),
                "/events/0/finalized",
                json!("true"),
            ),
        ),
        (
            "unknown_code",
            "error_body",
            with(&get("error_body"), "/code", json!("missing")),
        ),
    ];
    cases
        .into_iter()
        .map(|(name, kind, value)| json!({ "name": name, "type": kind, "value": value }))
        .collect()
}

#[tokio::test]
#[ignore = "writes fixtures/protocol/issuer-api.json"]
async fn regenerate() {
    let valid = valid_examples().await;
    let invalid = invalid_examples(&valid);
    let file = json!({
        "description": "Shared examples of the issuer API JSON envelopes (crates/protocol/src/issuer_api.rs, packages/protocol/src/issuer-api.ts). The issuer service made the valid examples on a mock chain (crates/issuer/tests/issuer_fixtures.rs). Each valid example must parse and serialize back to the same JSON value. Each invalid example must fail to parse as its type. tree_path_response must verify against its root.",
        "valid": valid,
        "invalid": invalid,
    });
    let text = serde_json::to_string_pretty(&file).unwrap() + "\n";
    std::fs::write(PATH, text).unwrap();
}

fn load() -> Value {
    serde_json::from_str(&std::fs::read_to_string(PATH).unwrap()).unwrap()
}

fn round_trip<T: Serialize + DeserializeOwned>(value: &Value) -> Result<Value, serde_json::Error> {
    let parsed: T = serde_json::from_value(value.clone())?;
    Ok(serde_json::to_value(&parsed).unwrap())
}

fn parse_as(kind: &str, value: &Value) -> Result<Value, serde_json::Error> {
    match kind {
        "config_response" => round_trip::<IssuerConfigResponse>(value),
        "topup_request" => round_trip::<TopupRequest>(value),
        "topup_response"
        | "topup_response_issued"
        | "topup_response_pending"
        | "topup_response_rejected" => round_trip::<TopupResponse>(value),
        "roots_response" => round_trip::<IssuerRootsResponse>(value),
        "tree_path_response" => round_trip::<TreePathResponse>(value),
        "epoch_response" => round_trip::<EpochResponse>(value),
        "leaf_events_response" => round_trip::<LeafEventsResponse>(value),
        "root_events_response" => round_trip::<RootEventsResponse>(value),
        "error_body" => round_trip::<ErrorBody>(value),
        other => panic!("unknown envelope type {other}"),
    }
}

#[test]
fn valid_examples_round_trip() {
    let file = load();
    let valid = file["valid"].as_object().unwrap();
    assert!(valid.len() >= 11);
    for (kind, value) in valid {
        let back = parse_as(kind, value).unwrap_or_else(|e| panic!("{kind}: {e}"));
        assert_eq!(&back, value, "{kind}");
    }
}

#[test]
fn invalid_examples_fail() {
    let file = load();
    for case in file["invalid"].as_array().unwrap() {
        let kind = case["type"].as_str().unwrap();
        let name = case["name"].as_str().unwrap();
        assert!(parse_as(kind, &case["value"]).is_err(), "{kind} {name}");
    }
}

#[test]
fn path_example_verifies_and_leaves_match_the_commitments() {
    let file = load();
    let path: TreePathResponse =
        serde_json::from_value(file["valid"]["tree_path_response"].clone()).unwrap();
    let proof: MembershipProof = serde_json::from_value(to_value(&path.proof)).unwrap();
    assert!(verify_proof(path.root, &proof, path.leaf));

    let issued: TopupResponse =
        serde_json::from_value(file["valid"]["topup_response_issued"].clone()).unwrap();
    let issuance = issued.issuance.unwrap();
    assert_eq!(
        issuance.eligible_epoch,
        DecimalU64(issuance.insertion_epoch.0 + 1)
    );
    assert_eq!(
        issuance.expiry,
        DecimalU64(issuance.insertion_epoch.0 + u64::from(LIFETIME))
    );
    for issued_leaf in &issuance.leaves {
        assert_eq!(
            issued_leaf.leaf,
            leaf(issued_leaf.commitment, issuance.expiry.0)
        );
    }
    let proven = issuance
        .leaves
        .iter()
        .find(|l| l.leaf_index == path.proof.leaf_index)
        .unwrap();
    assert_eq!(proven.leaf, path.leaf);

    let config: IssuerConfigResponse =
        serde_json::from_value(file["valid"]["config_response"].clone()).unwrap();
    assert_eq!(config.deployment_id, config.deployment.deployment_id());
}

#[tokio::test]
async fn fixture_is_up_to_date() {
    let file = load();
    let valid = valid_examples().await;
    assert_eq!(
        file["valid"],
        Value::Object(valid),
        "run the regenerate test to update the fixture"
    );
}

//! Check the open and status signing messages and the gateway API envelopes against the
//! shared vectors in `fixtures/protocol/`.
//!
//! The TypeScript package runs the same vectors. Both must pass.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use anon_credit_crypto::verify_ed25519;
use anon_credit_protocol::admin::{AdminSnapshot, GatewayEvent, SessionDetail};
use anon_credit_protocol::api::{
    DemoPeerResponse, GatewayConfigResponse, GatewayErrorBody, OpenChunkPath, OpenChunkResponse,
    OpenRequest, OpenResponse, PricesResponse, RootsResponse, SPEND_RESPONSE_HEADERS, SpendRequest,
    StatusRequest, StatusResponse,
};
use anon_credit_protocol::hex_bytes::{decode_fixed, encode};
use anon_credit_protocol::{
    Bytes32, DecimalU64, OPEN_MESSAGE_LEN, OpenMessage, PROTOCOL_VERSION, PriceTable,
    STATUS_MESSAGE_LEN, StatusMessage, domain,
};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

const OPEN: &str = include_str!("../../../fixtures/protocol/open-message.json");
const STATUS: &str = include_str!("../../../fixtures/protocol/status-message.json");
const API: &str = include_str!("../../../fixtures/protocol/gateway-api.json");

#[derive(Deserialize)]
struct MessageFile<I> {
    protocol_version: u16,
    operation_domain: String,
    message_length: usize,
    test_signing_key: TestKey,
    cases: Vec<MessageCase<I>>,
}

#[derive(Deserialize)]
struct TestKey {
    public_key: String,
}

#[derive(Deserialize)]
struct MessageCase<I> {
    name: String,
    input: I,
    expected: Expected,
}

#[derive(Deserialize)]
struct Expected {
    message: String,
    digest: Bytes32,
    signature: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OpenInput {
    deployment_id: Bytes32,
    gateway_id: Bytes32,
    batch_id: Bytes32,
    root: Bytes32,
    leaf_count: u32,
    proof_epoch: DecimalU64,
    session_pub: Bytes32,
    price_table_hash: Bytes32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StatusInput {
    deployment_id: Bytes32,
    gateway_id: Bytes32,
    batch_id: Bytes32,
    nonce: Bytes32,
}

fn check_signature(public_key: &str, case: &Expected, name: &str) {
    let public_key = decode_fixed::<32>(public_key).unwrap();
    let signature = decode_fixed::<64>(&case.signature).unwrap();
    assert_eq!(
        verify_ed25519(&public_key, &case.digest.0, &signature),
        Ok(()),
        "case {name}"
    );
}

#[test]
fn open_message_matches_shared_vectors() {
    let file: MessageFile<OpenInput> = serde_json::from_str(OPEN).unwrap();
    assert_eq!(file.protocol_version, PROTOCOL_VERSION);
    assert_eq!(file.operation_domain, encode(domain::OPEN.as_bytes()));
    assert_eq!(file.message_length, OPEN_MESSAGE_LEN);
    assert!(!file.cases.is_empty());
    for case in file.cases {
        let input = case.input;
        let message = OpenMessage {
            deployment_id: input.deployment_id,
            gateway_id: input.gateway_id,
            batch_id: input.batch_id,
            root: input.root,
            leaf_count: input.leaf_count,
            proof_epoch: input.proof_epoch.0,
            session_pub: input.session_pub,
            price_table_hash: input.price_table_hash,
        };
        assert_eq!(
            encode(&message.encode()),
            case.expected.message,
            "case {}",
            case.name
        );
        assert_eq!(message.digest(), case.expected.digest, "case {}", case.name);
        check_signature(
            &file.test_signing_key.public_key,
            &case.expected,
            &case.name,
        );
    }
}

#[test]
fn status_message_matches_shared_vectors() {
    let file: MessageFile<StatusInput> = serde_json::from_str(STATUS).unwrap();
    assert_eq!(file.protocol_version, PROTOCOL_VERSION);
    assert_eq!(file.operation_domain, encode(domain::STATUS.as_bytes()));
    assert_eq!(file.message_length, STATUS_MESSAGE_LEN);
    assert!(!file.cases.is_empty());
    for case in file.cases {
        let input = case.input;
        let message = StatusMessage {
            deployment_id: input.deployment_id,
            gateway_id: input.gateway_id,
            batch_id: input.batch_id,
            nonce: input.nonce,
        };
        assert_eq!(
            encode(&message.encode()),
            case.expected.message,
            "case {}",
            case.name
        );
        assert_eq!(message.digest(), case.expected.digest, "case {}", case.name);
        check_signature(
            &file.test_signing_key.public_key,
            &case.expected,
            &case.name,
        );
    }
}

#[derive(Deserialize)]
struct ApiFile {
    price_table: PriceTableVector,
    spend_response_headers: Vec<String>,
    open_chunk_paths: ChunkPathVectors,
    valid: serde_json::Map<String, Value>,
    invalid: Vec<InvalidCase>,
}

#[derive(Deserialize)]
struct ChunkPathVectors {
    valid: Vec<ValidChunkPath>,
    invalid: Vec<InvalidChunkPath>,
}

#[derive(Deserialize)]
struct ValidChunkPath {
    path: String,
    target: OpenChunkPath,
}

#[derive(Deserialize)]
struct InvalidChunkPath {
    name: String,
    path: String,
}

#[derive(Deserialize)]
struct PriceTableVector {
    table: PriceTable,
    canonical_json: String,
    price_table_hash: Bytes32,
}

#[derive(Deserialize)]
struct InvalidCase {
    name: String,
    #[serde(rename = "type")]
    kind: String,
    value: Value,
}

/// Parse `value` as `T`, serialize it again, and compare the JSON values.
fn round_trip<T: DeserializeOwned + serde::Serialize>(value: &Value) -> Result<(), String> {
    let parsed: T = serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
    let back = serde_json::to_value(&parsed).map_err(|e| e.to_string())?;
    if &back == value {
        Ok(())
    } else {
        Err(format!("round trip changed the value: {back}"))
    }
}

fn parse_as(kind: &str, value: &Value) -> Result<(), String> {
    let base = kind.trim_end_matches("_without_receipt");
    let base = base.trim_end_matches("_with_receipt");
    let base = base.trim_end_matches("_demo");
    let base = base.trim_end_matches("_upload");
    match base {
        "open_request" => round_trip::<OpenRequest>(value),
        "open_response" => round_trip::<OpenResponse>(value),
        "open_chunk_path" => round_trip::<OpenChunkPath>(value),
        "open_chunk_response" => round_trip::<OpenChunkResponse>(value),
        "spend_request" => round_trip::<SpendRequest>(value),
        "status_request" => round_trip::<StatusRequest>(value),
        "status_response" => round_trip::<StatusResponse>(value),
        "error_body" => round_trip::<GatewayErrorBody>(value),
        "config_response" => round_trip::<GatewayConfigResponse>(value),
        "prices_response" => round_trip::<PricesResponse>(value),
        "roots_response" => round_trip::<RootsResponse>(value),
        "demo_peer_response" => round_trip::<DemoPeerResponse>(value),
        "gateway_event" => round_trip::<GatewayEvent>(value),
        "admin_snapshot" => round_trip::<AdminSnapshot>(value),
        "session_detail" => round_trip::<SessionDetail>(value),
        other => panic!("unknown envelope type {other}"),
    }
}

#[test]
fn valid_api_examples_round_trip() {
    let file: ApiFile = serde_json::from_str(API).unwrap();
    assert!(file.valid.len() >= 10);
    for (kind, value) in &file.valid {
        assert_eq!(parse_as(kind, value), Ok(()), "example {kind}");
    }
}

#[test]
fn invalid_api_examples_fail() {
    let file: ApiFile = serde_json::from_str(API).unwrap();
    assert!(!file.invalid.is_empty());
    for case in &file.invalid {
        assert!(
            parse_as(&case.kind, &case.value).is_err(),
            "case {} of {} must fail",
            case.name,
            case.kind
        );
    }
}

#[test]
fn price_table_matches_shared_vector() {
    let file: ApiFile = serde_json::from_str(API).unwrap();
    assert_eq!(file.price_table.table, PriceTable::current());
    assert_eq!(
        file.price_table.table.canonical_json(),
        file.price_table.canonical_json
    );
    assert_eq!(
        file.price_table.table.hash(),
        file.price_table.price_table_hash
    );
}

#[test]
fn chunk_paths_match_shared_vectors() {
    let file: ApiFile = serde_json::from_str(API).unwrap();
    assert!(!file.open_chunk_paths.valid.is_empty());
    for case in &file.open_chunk_paths.valid {
        assert_eq!(OpenChunkPath::parse(&case.path), Ok(case.target));
        assert_eq!(case.target.to_path(), case.path);
    }
    assert!(!file.open_chunk_paths.invalid.is_empty());
    for case in &file.open_chunk_paths.invalid {
        assert!(
            OpenChunkPath::parse(&case.path).is_err(),
            "chunk path case {} must fail",
            case.name
        );
    }
}

#[test]
fn spend_response_headers_match_shared_list() {
    let file: ApiFile = serde_json::from_str(API).unwrap();
    assert_eq!(file.spend_response_headers, SPEND_RESPONSE_HEADERS.to_vec());
}

#[test]
fn open_request_example_signature_verifies() {
    let file: ApiFile = serde_json::from_str(API).unwrap();
    let request: OpenRequest = serde_json::from_value(file.valid["open_request"].clone()).unwrap();
    assert_eq!(
        verify_ed25519(
            &request.session_pub.0,
            &request.message().digest().0,
            &request.signature.0
        ),
        Ok(())
    );
}

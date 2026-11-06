//! Check the Rust encoders against the shared vectors in `fixtures/protocol/`.
//!
//! The TypeScript package runs the same vectors. Both must pass.

#![allow(clippy::expect_used, clippy::unwrap_used)]

use anon_credit_crypto::verify_ed25519;
use anon_credit_protocol::hex_bytes::{decode_fixed, encode};
use anon_credit_protocol::{
    Address, Bytes32, DeploymentConfig, ErrorCode, PROTOCOL_VERSION, SpendMessage, domain,
};
use serde::Deserialize;

const SPEND: &str = include_str!("../../../fixtures/protocol/spend-message.json");
const DEPLOYMENT: &str = include_str!("../../../fixtures/protocol/deployment-id.json");
const ERROR_CODES: &str = include_str!("../../../fixtures/protocol/error-codes.json");

#[derive(Deserialize)]
struct SpendFile {
    protocol_version: u16,
    operation_domain: String,
    test_signing_key: TestKey,
    cases: Vec<SpendCase>,
}

#[derive(Deserialize)]
struct TestKey {
    public_key: String,
}

#[derive(Deserialize)]
struct SpendCase {
    name: String,
    input: SpendInput,
    expected: SpendExpected,
}

#[derive(Deserialize)]
struct SpendInput {
    deployment_id: Bytes32,
    gateway_id: Bytes32,
    batch_id: Bytes32,
    price_table_hash: Bytes32,
    seq: String,
    units_total: String,
    rpc_bytes: String,
}

#[derive(Deserialize)]
struct SpendExpected {
    message: String,
    digest: Bytes32,
    signature: String,
}

fn decode_var_hex(text: &str) -> Vec<u8> {
    hex::decode(text.strip_prefix("0x").expect("hex must have 0x prefix")).expect("valid hex")
}

#[test]
fn spend_message_matches_shared_vectors() {
    let file: SpendFile = serde_json::from_str(SPEND).unwrap();
    assert_eq!(file.protocol_version, PROTOCOL_VERSION);
    assert_eq!(file.operation_domain, encode(domain::SPEND.as_bytes()));
    let public_key = decode_fixed::<32>(&file.test_signing_key.public_key).unwrap();
    assert!(!file.cases.is_empty());

    for case in file.cases {
        let rpc_bytes = decode_var_hex(&case.input.rpc_bytes);
        let message = SpendMessage {
            deployment_id: case.input.deployment_id,
            gateway_id: case.input.gateway_id,
            batch_id: case.input.batch_id,
            price_table_hash: case.input.price_table_hash,
            seq: case.input.seq.parse().unwrap(),
            units_total: case.input.units_total.parse().unwrap(),
            rpc_bytes: &rpc_bytes,
        };
        let encoded = message.encode().unwrap();
        assert_eq!(
            encode(&encoded),
            case.expected.message,
            "case {}",
            case.name
        );
        let digest = message.digest().unwrap();
        assert_eq!(digest, case.expected.digest, "case {}", case.name);

        let signature = decode_fixed::<64>(&case.expected.signature).unwrap();
        assert_eq!(
            verify_ed25519(&public_key, &digest.0, &signature),
            Ok(()),
            "case {}",
            case.name
        );
    }
}

#[derive(Deserialize)]
struct DeploymentFile {
    cases: Vec<DeploymentCase>,
}

#[derive(Deserialize)]
struct DeploymentCase {
    name: String,
    input: DeploymentInput,
    expected: DeploymentExpected,
}

#[derive(Deserialize)]
struct DeploymentInput {
    protocol_version: u16,
    payment_chain_id: u64,
    sale_address: Address,
    root_registry_address: Address,
    issuer_address: Address,
    gateway_id: Bytes32,
    batch_size: u32,
    epoch_seconds: u32,
    credit_lifetime_epochs: u32,
    circuit_id: Bytes32,
    verifier_artifact_hash: Bytes32,
    prover_manifest_hash: Bytes32,
}

#[derive(Deserialize)]
struct DeploymentExpected {
    encoding: String,
    deployment_id: Bytes32,
}

#[test]
fn deployment_id_matches_shared_vectors() {
    let file: DeploymentFile = serde_json::from_str(DEPLOYMENT).unwrap();
    assert!(!file.cases.is_empty());
    for case in file.cases {
        let input = case.input;
        let config = DeploymentConfig {
            protocol_version: input.protocol_version,
            payment_chain_id: input.payment_chain_id,
            sale_address: input.sale_address,
            root_registry_address: input.root_registry_address,
            issuer_address: input.issuer_address,
            gateway_id: input.gateway_id,
            batch_size: input.batch_size,
            epoch_seconds: input.epoch_seconds,
            credit_lifetime_epochs: input.credit_lifetime_epochs,
            circuit_id: input.circuit_id,
            verifier_artifact_hash: input.verifier_artifact_hash,
            prover_manifest_hash: input.prover_manifest_hash,
        };
        config.validate().unwrap();
        assert_eq!(
            encode(&config.encode()),
            case.expected.encoding,
            "case {}",
            case.name
        );
        assert_eq!(
            config.deployment_id(),
            case.expected.deployment_id,
            "case {}",
            case.name
        );
    }
}

#[derive(Deserialize)]
struct ErrorCodesFile {
    codes: Vec<ErrorCodeEntry>,
}

#[derive(Deserialize)]
struct ErrorCodeEntry {
    code: ErrorCode,
    retryable: bool,
}

#[test]
fn error_codes_match_shared_list() {
    let file: ErrorCodesFile = serde_json::from_str(ERROR_CODES).unwrap();
    let listed: Vec<ErrorCode> = file.codes.iter().map(|entry| entry.code).collect();
    assert_eq!(listed, ErrorCode::ALL.to_vec());
    for entry in file.codes {
        assert_eq!(
            entry.code.retryable(),
            entry.retryable,
            "code {}",
            entry.code
        );
    }
}

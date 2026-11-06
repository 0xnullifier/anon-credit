//! Check the batch-open public-input order against the contract file
//! `fixtures/protocol/batch-open-public-inputs.json`.
//!
//! The gateway (phase 3) builds the verifier input with `BatchOpenPublicInputs::for_open`.
//! These tests make sure that the vector has the order and the values of the contract.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use anon_credit_crypto::constants::CIRCUIT_ID;
use anon_credit_crypto::{
    BatchOpenPublicInputs, FieldElement, PUBLIC_INPUT_COUNT, PUBLIC_INPUT_NAMES,
};
use serde::Deserialize;

const CONTRACT: &str = include_str!("../../../fixtures/protocol/batch-open-public-inputs.json");

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Contract {
    #[allow(dead_code)]
    description: String,
    circuit: String,
    #[allow(dead_code)]
    encoding: String,
    count: usize,
    order: Vec<Entry>,
    circuit_id: FieldElement,
    gate_case: Case,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    index: usize,
    name: String,
    #[allow(dead_code)]
    noir_parameter: String,
    #[allow(dead_code)]
    source: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    #[allow(dead_code)]
    name: String,
    input: CaseInput,
    public_inputs: Vec<FieldElement>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CaseInput {
    deployment_id: String,
    gateway_id: String,
    session_pub: String,
    root: FieldElement,
    leaf_count: u32,
    proof_epoch: String,
    batch_id: FieldElement,
}

fn contract() -> Contract {
    serde_json::from_str(CONTRACT).unwrap()
}

fn bytes32(text: &str) -> [u8; 32] {
    let mut bytes = [0_u8; 32];
    hex::decode_to_slice(text.strip_prefix("0x").unwrap(), &mut bytes).unwrap();
    bytes
}

#[test]
fn names_and_count_match_the_contract() {
    let contract = contract();
    assert_eq!(contract.circuit, "circuits/batch-open");
    assert_eq!(contract.count, PUBLIC_INPUT_COUNT);
    assert_eq!(contract.order.len(), PUBLIC_INPUT_COUNT);
    for (position, entry) in contract.order.iter().enumerate() {
        assert_eq!(entry.index, position);
        assert_eq!(entry.name, PUBLIC_INPUT_NAMES[position], "index {position}");
    }
}

#[test]
fn circuit_id_matches_the_contract() {
    assert_eq!(contract().circuit_id, CIRCUIT_ID);
}

#[test]
fn gateway_vector_matches_the_contract() {
    let case = contract().gate_case;
    let input = &case.input;
    let fields = BatchOpenPublicInputs::for_open(
        bytes32(&input.deployment_id),
        bytes32(&input.gateway_id),
        input.root,
        input.leaf_count,
        input.proof_epoch.parse().unwrap(),
        input.batch_id,
        &bytes32(&input.session_pub),
    )
    .to_fields();
    assert_eq!(fields.to_vec(), case.public_inputs);
}

#[test]
fn values_of_the_gate_case_are_distinct() {
    // Distinct values make the order observable: a proof with the same vector in a different
    // order does not match. crates/prover depends on this to check the circuit order.
    let case = contract().gate_case;
    for (i, a) in case.public_inputs.iter().enumerate() {
        for b in &case.public_inputs[i + 1..] {
            assert_ne!(a, b);
        }
    }
}

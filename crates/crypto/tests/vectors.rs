//! Check the Rust circuit hash against the shared vectors in `fixtures/protocol/`.
//!
//! The expected outputs in `poseidon2.json` come from Noir (`nargo test --show-output` in
//! `fixtures/protocol/noir-vectors`). The TypeScript package and the circuit check the same file.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use anon_credit_crypto::batch::{batch_id, commitment, leaf, session_binding};
use anon_credit_crypto::constants::{
    BATCH_UNITS_K, CIRCUIT_ID, DOMAIN_TAGS, MAX_HEIGHT, MAX_LEAVES, MAX_PEAKS,
};
use anon_credit_crypto::mmr_hash::{internal_node, leaf_node, root};
use anon_credit_crypto::poseidon2::{hash, permutation};
use anon_credit_crypto::{FieldElement, FieldError, bytes32_to_limbs};
use serde::Deserialize;

const POSEIDON2: &str = include_str!("../../../fixtures/protocol/poseidon2.json");
const DOMAINS: &str = include_str!("../../../fixtures/protocol/domains.json");

#[derive(Deserialize)]
struct Poseidon2File {
    permutation: Vec<PermutationVector>,
    hash: Vec<HashVector>,
    constructions: Vec<ConstructionVector>,
    batch_cases: Vec<BatchCase>,
    encoding: Encoding,
}

#[derive(Deserialize)]
struct PermutationVector {
    name: String,
    input: [FieldElement; 4],
    output: [FieldElement; 4],
}

#[derive(Deserialize)]
struct HashVector {
    name: String,
    inputs: Vec<FieldElement>,
    output: FieldElement,
}

#[derive(Deserialize)]
struct ConstructionVector {
    kind: String,
    name: String,
    inputs: Vec<FieldElement>,
    output: FieldElement,
}

#[derive(Deserialize)]
struct BatchCase {
    name: String,
    deployment_id: String,
    gateway_id: String,
    k: String,
    session_pub: String,
    expiry: String,
    expected: BatchExpected,
}

#[derive(Deserialize)]
struct BatchExpected {
    commitment: FieldElement,
    leaf: FieldElement,
    batch_id: FieldElement,
    binding: FieldElement,
    mmr_leaf_node: FieldElement,
}

#[derive(Deserialize)]
struct Encoding {
    limbs: Vec<LimbCase>,
    field_accept: Vec<AcceptCase>,
    field_reject: Vec<RejectCase>,
}

#[derive(Deserialize)]
struct LimbCase {
    bytes: String,
    hi: FieldElement,
    lo: FieldElement,
}

#[derive(Deserialize)]
struct AcceptCase {
    wire: String,
    value: String,
}

#[derive(Deserialize)]
struct RejectCase {
    wire: String,
    reason: String,
}

#[derive(Deserialize)]
struct DomainsFile {
    tags: Vec<DomainTag>,
    circuit_id: DomainValue,
    constants: DomainConstants,
}

#[derive(Deserialize)]
struct DomainTag {
    name: String,
    text: String,
    value: FieldElement,
}

#[derive(Deserialize)]
struct DomainValue {
    value: FieldElement,
}

#[derive(Deserialize)]
struct DomainConstants {
    batch_units_k: u64,
    max_height: usize,
    max_peaks: usize,
    max_leaves: u32,
}

fn bytes32(text: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    hex::decode_to_slice(text.strip_prefix("0x").unwrap(), &mut out).unwrap();
    out
}

fn poseidon2_file() -> Poseidon2File {
    serde_json::from_str(POSEIDON2).expect("poseidon2.json must parse")
}

#[test]
fn permutation_matches_noir() {
    for vector in poseidon2_file().permutation {
        assert_eq!(permutation(vector.input), vector.output, "{}", vector.name);
    }
}

#[test]
fn sponge_matches_noir() {
    let file = poseidon2_file();
    for vector in file.hash {
        assert_eq!(hash(&vector.inputs), vector.output, "{}", vector.name);
    }
    for vector in file.constructions {
        assert_eq!(
            hash(&vector.inputs),
            vector.output,
            "{} {}",
            vector.kind,
            vector.name
        );
    }
}

#[test]
fn mmr_rules_match_noir() {
    let file = poseidon2_file();
    for vector in &file.constructions {
        match vector.kind.as_str() {
            "mmr_node" => {
                let height = match vector.name.as_str() {
                    "height_1" => 1,
                    "height_31" => 31,
                    other => panic!("unknown node vector {other}"),
                };
                assert_eq!(
                    internal_node(height, vector.inputs[1], vector.inputs[2]),
                    vector.output
                );
            }
            "mmr_root" => {
                let mut slots = [FieldElement::ZERO; MAX_PEAKS];
                // Input 2 + (31 - h) holds slot h.
                for (h, slot) in slots.iter_mut().enumerate() {
                    *slot = vector.inputs[2 + 31 - h];
                }
                assert_eq!(root(5, &slots), vector.output);
            }
            "mmr_leaf" => {
                assert_eq!(leaf_node(vector.inputs[1]), vector.output);
            }
            _ => {}
        }
    }
}

#[test]
fn batch_constructions_match_noir() {
    for case in poseidon2_file().batch_cases {
        let deployment_id = bytes32(&case.deployment_id);
        let gateway_id = bytes32(&case.gateway_id);
        let k = bytes32(&case.k);
        let session_pub = bytes32(&case.session_pub);
        let expiry: u64 = case.expiry.parse().unwrap();
        let c = commitment(&deployment_id, &k);
        assert_eq!(c, case.expected.commitment, "{}", case.name);
        let leaf_value = leaf(c, expiry);
        assert_eq!(leaf_value, case.expected.leaf, "{}", case.name);
        assert_eq!(leaf_node(leaf_value), case.expected.mmr_leaf_node);
        assert_eq!(batch_id(&deployment_id, &k), case.expected.batch_id);
        assert_eq!(
            session_binding(&gateway_id, &session_pub),
            case.expected.binding
        );
    }
}

#[test]
fn encoding_rules_match_fixture() {
    let encoding = poseidon2_file().encoding;
    for case in encoding.limbs {
        assert_eq!(bytes32_to_limbs(&bytes32(&case.bytes)), [case.hi, case.lo]);
    }
    for case in encoding.field_accept {
        let value = FieldElement::from_hex(&case.wire).unwrap();
        assert_eq!(value.to_hex(), case.wire);
        if case.value == "0" {
            assert_eq!(value, FieldElement::ZERO);
        }
    }
    for case in encoding.field_reject {
        let expected = match case.reason.as_str() {
            "out_of_range" => FieldError::OutOfRange,
            "bad_hex" => FieldError::BadHex,
            other => panic!("unknown reason {other}"),
        };
        assert_eq!(FieldElement::from_hex(&case.wire), Err(expected));
    }
}

#[test]
fn constants_match_domains_fixture() {
    let file: DomainsFile = serde_json::from_str(DOMAINS).unwrap();
    assert_eq!(file.tags.len(), DOMAIN_TAGS.len());
    for (tag, (name, text, value)) in file.tags.iter().zip(DOMAIN_TAGS) {
        assert_eq!(tag.name, name);
        assert_eq!(tag.text, text);
        assert_eq!(tag.value, value);
        let mut bytes = [0u8; 32];
        bytes[32 - text.len()..].copy_from_slice(text.as_bytes());
        assert_eq!(FieldElement::from_bytes_be(&bytes).unwrap(), value);
    }
    assert_eq!(file.circuit_id.value, CIRCUIT_ID);
    assert_eq!(file.constants.batch_units_k, BATCH_UNITS_K);
    assert_eq!(file.constants.max_height, MAX_HEIGHT);
    assert_eq!(file.constants.max_peaks, MAX_PEAKS);
    assert_eq!(file.constants.max_leaves, MAX_LEAVES);
}

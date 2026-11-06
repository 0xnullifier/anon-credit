//! Verification tests of the real batch-open circuit, with the checked-in artifacts in
//! `artifacts/batch-open/`.
//!
//! `tooling/provekit/prepare-batch-open.sh` makes the keys and the native proofs. The browser
//! gate (`GATE_WRITE_FIXTURE=1 node packages/prover/dev/gate.ts --circuit batch-open`) writes
//! `proof.browser.json`. The expected public inputs come from the order contract
//! `fixtures/protocol/batch-open-public-inputs.json`, not from the proofs.

// Test helpers outside `#[test]` functions also stop on bad fixtures.
#![allow(clippy::unwrap_used, clippy::panic)]

use std::path::PathBuf;

use anon_credit_prover::{
    DEFAULT_MAX_PROOF_BYTES, LoadError, PinnedVerifier, Proof, ProofEncoding, PublicInput,
    Sha256Digest, VerifyError,
};

/// The pinned digest of `batch-open.pkv`. `config/deployment.testnet.template.toml` has the
/// same value as `verifier_artifact_hash`.
const PKV_SHA256: &str = "c8b4fb4722bb6d926d73112223865bd2756413f6f8085e549a90dd16a8aef6d4";
/// The digest of `batch-open-standard.pkv`, a non-hiding key.
const STANDARD_PKV_SHA256: &str =
    "7a11d6718b89d708749d91f295f55c195d43f2136115d07b744d2e3c7444b69f";

/// Names of the public inputs in circuit order (the order contract).
const NAMES: [&str; 10] = [
    "circuit_id",
    "deployment_id_hi",
    "deployment_id_lo",
    "gateway_id_hi",
    "gateway_id_lo",
    "root",
    "leaf_count",
    "proof_epoch",
    "batch_id",
    "binding",
];

fn repo(path: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(path)
}

fn read(name: &str) -> Vec<u8> {
    std::fs::read(repo("artifacts/batch-open").join(name)).unwrap()
}

fn verifier() -> PinnedVerifier {
    let digest = Sha256Digest::from_hex(PKV_SHA256).unwrap();
    PinnedVerifier::load(&repo("artifacts/batch-open/batch-open.pkv"), &digest).unwrap()
}

/// The expected public inputs: `gate_case.public_inputs` of the order contract.
fn expected() -> Vec<PublicInput> {
    let text =
        std::fs::read_to_string(repo("fixtures/protocol/batch-open-public-inputs.json")).unwrap();
    let contract: serde_json::Value = serde_json::from_str(&text).unwrap();
    let names: Vec<&str> = contract["order"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, NAMES);
    contract["gate_case"]["public_inputs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| PublicInput::from_hex(value.as_str().unwrap()).unwrap())
        .collect()
}

fn decode(bytes: &[u8]) -> Proof {
    Proof::decode(bytes, DEFAULT_MAX_PROOF_BYTES).unwrap()
}

/// Adds one to a public input. No value of the gate case is `p - 1`, so the result is valid.
fn plus_one(value: &PublicInput) -> PublicInput {
    let mut bytes = value.to_be_bytes();
    for byte in bytes.iter_mut().rev() {
        let (sum, carry) = byte.overflowing_add(1);
        *byte = sum;
        if !carry {
            break;
        }
    }
    PublicInput::from_be_bytes(bytes).unwrap()
}

/// Replaces one character of a JSON string field of `whir_r1cs_proof`. The new character is
/// in the same alphabet, so the field still decodes, but one proof byte changes.
fn flip_char(json: &[u8], field: &str) -> Vec<u8> {
    let mut value: serde_json::Value = serde_json::from_slice(json).unwrap();
    let text = value["whir_r1cs_proof"][field].as_str().unwrap().to_owned();
    let index = text.len() / 2;
    let old = text.as_bytes()[index];
    let new = if old == b'a' { 'b' } else { 'a' };
    let mut changed = text.clone();
    changed.replace_range(index..=index, &new.to_string());
    value["whir_r1cs_proof"][field] = serde_json::Value::String(changed);
    serde_json::to_vec(&value).unwrap()
}

/// Replaces public input `index` of a JSON proof. The JSON form is little-endian hex.
fn replace_public_input(json: &[u8], index: usize, value: &PublicInput) -> Vec<u8> {
    let mut proof: serde_json::Value = serde_json::from_slice(json).unwrap();
    let mut little_endian = value.to_be_bytes();
    little_endian.reverse();
    proof["public_inputs"][index] = serde_json::Value::String(hex::encode(little_endian));
    serde_json::to_vec(&proof).unwrap()
}

/// The JSON proofs: the native CLI proof and the Chromium proof.
const JSON_PROOFS: [&str; 2] = ["proof.native.json", "proof.browser.json"];

#[test]
fn loads_hiding_key_with_pinned_digest() {
    let info = verifier().info().clone();
    assert_eq!(info.num_public_inputs, NAMES.len());
    assert_eq!(info.num_constraints, 14416);
    assert_eq!(info.num_witnesses, 14672);
    assert_eq!(info.hash, "skyscraper");
}

#[test]
fn non_hiding_key_is_rejected() {
    let digest = Sha256Digest::from_hex(STANDARD_PKV_SHA256).unwrap();
    let result = PinnedVerifier::load(
        &repo("artifacts/batch-open/batch-open-standard.pkv"),
        &digest,
    );
    assert!(matches!(result, Err(LoadError::NotHiding)), "{result:?}");
}

/// The proofs carry the contract vector in the contract order. The ten values are distinct, so
/// a different order in the circuit gives a different vector.
#[test]
fn proofs_have_the_contract_public_inputs() {
    for name in ["proof.np", JSON_PROOFS[0], JSON_PROOFS[1]] {
        assert_eq!(decode(&read(name)).public_inputs(), expected(), "{name}");
    }
}

#[test]
fn native_binary_proof_verifies() {
    let proof = decode(&read("proof.np"));
    assert_eq!(proof.encoding(), ProofEncoding::Binary);
    verifier().verify(&proof, &expected()).unwrap();
}

/// The phase 1 gate for the real circuit: the Chromium proof verifies natively.
#[test]
fn json_proofs_verify() {
    for name in JSON_PROOFS {
        let proof = decode(&read(name));
        assert_eq!(proof.encoding(), ProofEncoding::Json);
        verifier().verify(&proof, &expected()).unwrap();
    }
}

#[test]
fn proof_with_flipped_byte_fails() {
    for name in JSON_PROOFS {
        let json = read(name);
        for field in ["narg_string", "hints"] {
            let proof = decode(&flip_char(&json, field));
            let error = verifier().verify(&proof, &expected()).unwrap_err();
            assert!(
                matches!(error, VerifyError::Rejected(_)),
                "{name} {field}: {error:?}"
            );
        }
    }
}

#[test]
fn binary_proof_with_flipped_byte_fails() {
    let mut bytes = read("proof.np");
    let middle = bytes.len() / 2;
    bytes[middle] ^= 0x01;
    let result = Proof::decode(&bytes, DEFAULT_MAX_PROOF_BYTES)
        .map_err(|error| error.to_string())
        .and_then(|proof| {
            verifier()
                .verify(&proof, &expected())
                .map_err(|e| e.to_string())
        });
    assert!(result.is_err());
}

/// Each public input, one at a time: the gateway expects a different value. The adapter
/// rejects the proof before the cryptographic check.
#[test]
fn each_unexpected_public_input_is_rejected() {
    let verifier = verifier();
    for name in JSON_PROOFS {
        let proof = decode(&read(name));
        for (index, input) in NAMES.iter().enumerate() {
            let mut wrong = expected();
            wrong[index] = plus_one(&wrong[index]);
            assert_eq!(
                verifier.verify(&proof, &wrong),
                Err(VerifyError::PublicInputMismatch { index }),
                "{name} {input}"
            );
        }
    }
}

/// Each public input, one at a time: the proof and the expected values both have the altered
/// value. The cryptographic check rejects the proof, because the transcript binds the
/// original public inputs.
#[test]
fn each_altered_public_input_in_the_proof_is_rejected() {
    let verifier = verifier();
    for name in JSON_PROOFS {
        let json = read(name);
        for (index, input) in NAMES.iter().enumerate() {
            let mut altered = expected();
            altered[index] = plus_one(&altered[index]);
            let proof = decode(&replace_public_input(&json, index, &altered[index]));
            assert_eq!(proof.public_inputs(), altered);
            let error = verifier.verify(&proof, &altered).unwrap_err();
            assert!(
                matches!(error, VerifyError::Rejected(_)),
                "{name} {input}: {error:?}"
            );
        }
    }
}

#[test]
fn sample_key_does_not_verify_a_batch_open_proof() {
    let digest =
        Sha256Digest::from_hex("2924a15365089797df27e664edb73d8db918b445b4a4cea02d5effc0ea8c5260")
            .unwrap();
    let sample =
        PinnedVerifier::load(&repo("artifacts/provekit-sample/sample.pkv"), &digest).unwrap();
    let proof = decode(&read("proof.np"));
    assert_eq!(
        sample.verify(&proof, &expected()),
        Err(VerifyError::CircuitPublicInputCount {
            circuit: 3,
            given: 10
        })
    );
}

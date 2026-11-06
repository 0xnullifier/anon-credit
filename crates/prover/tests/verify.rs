//! Verification tests against the checked-in sample artifacts in `artifacts/provekit-sample/`.
//!
//! `tooling/provekit/prepare-sample.sh` makes these artifacts.

// Test helpers outside `#[test]` functions also stop on bad fixtures.
#![allow(clippy::unwrap_used, clippy::panic)]

use std::path::PathBuf;

use anon_credit_prover::{
    DEFAULT_MAX_PROOF_BYTES, DecodeError, LoadError, PinnedVerifier, Proof, ProofEncoding,
    PublicInput, Sha256Digest, VerifyError,
};

/// The pinned digest of `sample.pkv`.
const SAMPLE_PKV_SHA256: &str = "2924a15365089797df27e664edb73d8db918b445b4a4cea02d5effc0ea8c5260";
/// The digest of `sample-standard.pkv`, a non-hiding key.
const STANDARD_PKV_SHA256: &str =
    "d05c962643265eeb015d10ea45e20f407b9663e184311edf2cdb68e01e5715f5";

const ROOT: &str = "0x2defe77ad67d41ed53118ca13e97d82c88a0796fc3adb8858509598d115eccb1";
const BATCH_ID: &str = "0x00292c827d85a6f524c3dc038c7d1fef7c3a63d666fc46b710ff5c98eeed772e";
const EPOCH: u64 = 999;

fn artifact(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../artifacts/provekit-sample")
        .join(name)
}

fn read(name: &str) -> Vec<u8> {
    std::fs::read(artifact(name)).unwrap()
}

fn verifier() -> PinnedVerifier {
    let digest = Sha256Digest::from_hex(SAMPLE_PKV_SHA256).unwrap();
    PinnedVerifier::load(&artifact("sample.pkv"), &digest).unwrap()
}

fn expected() -> Vec<PublicInput> {
    vec![
        PublicInput::from_hex(ROOT).unwrap(),
        PublicInput::from_hex(BATCH_ID).unwrap(),
        PublicInput::from_u64(EPOCH),
    ]
}

fn decode(bytes: &[u8]) -> Proof {
    Proof::decode(bytes, DEFAULT_MAX_PROOF_BYTES).unwrap()
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

#[test]
fn loads_hiding_key_with_pinned_digest() {
    let info = verifier().info().clone();
    assert_eq!(info.num_public_inputs, 3);
    assert_eq!(info.digest.to_string(), SAMPLE_PKV_SHA256);
    assert_eq!(info.hash, "skyscraper");
}

#[test]
fn valid_binary_proof_verifies() {
    let proof = decode(&read("proof.np"));
    assert_eq!(proof.encoding(), ProofEncoding::Binary);
    assert_eq!(proof.public_inputs(), expected());
    verifier().verify(&proof, &expected()).unwrap();
}

#[test]
fn valid_json_proof_verifies() {
    let proof = decode(&read("proof.native.json"));
    assert_eq!(proof.encoding(), ProofEncoding::Json);
    verifier().verify(&proof, &expected()).unwrap();
}

#[test]
fn verifier_is_reusable() {
    let verifier = verifier();
    let proof = decode(&read("proof.np"));
    verifier.verify(&proof, &expected()).unwrap();
    verifier.verify(&proof, &expected()).unwrap();
}

#[test]
fn proof_with_flipped_byte_fails() {
    let json = read("proof.native.json");
    for field in ["narg_string", "hints"] {
        let proof = decode(&flip_char(&json, field));
        let error = verifier().verify(&proof, &expected()).unwrap_err();
        assert!(
            matches!(error, VerifyError::Rejected(_)),
            "{field}: {error:?}"
        );
    }
}

#[test]
fn binary_proof_with_flipped_byte_fails() {
    let mut bytes = read("proof.np");
    let middle = bytes.len() / 2;
    bytes[middle] ^= 0x01;
    // The flip is in the compressed data. Decoding or verification must fail.
    let result = Proof::decode(&bytes, DEFAULT_MAX_PROOF_BYTES)
        .map_err(|error| error.to_string())
        .and_then(|proof| {
            verifier()
                .verify(&proof, &expected())
                .map_err(|e| e.to_string())
        });
    assert!(result.is_err());
}

#[test]
fn proof_with_altered_public_input_fails() {
    let json = read("proof.native.json");
    let altered_values = [
        PublicInput::from_hex("0x1234").unwrap(),
        PublicInput::from_hex("0x1").unwrap(),
        PublicInput::from_u64(EPOCH - 1),
    ];
    for (index, altered) in altered_values.iter().enumerate() {
        let proof = decode(&replace_public_input(&json, index, altered));
        let mut altered_expected = expected();
        altered_expected[index] = *altered;
        // The proof and the expected values agree, but the transcript binds the original.
        let error = verifier().verify(&proof, &altered_expected).unwrap_err();
        assert!(
            matches!(error, VerifyError::Rejected(_)),
            "input {index}: {error:?}"
        );
    }
}

#[test]
fn unexpected_public_input_fails_before_verification() {
    let proof = decode(&read("proof.np"));
    let mut wrong = expected();
    wrong[2] = PublicInput::from_u64(EPOCH + 1);
    assert_eq!(
        verifier().verify(&proof, &wrong),
        Err(VerifyError::PublicInputMismatch { index: 2 })
    );
    assert_eq!(
        verifier().verify(&proof, &expected()[..2]),
        Err(VerifyError::CircuitPublicInputCount {
            circuit: 3,
            given: 2
        })
    );
}

#[test]
fn wrong_digest_is_rejected_before_parsing() {
    let bytes = read("sample.pkv");
    let wrong = Sha256Digest::of(b"another key");
    match PinnedVerifier::from_bytes(&bytes, &wrong) {
        Err(LoadError::DigestMismatch { expected, actual }) => {
            assert_eq!(expected, wrong);
            assert_eq!(actual.to_string(), SAMPLE_PKV_SHA256);
        }
        other => panic!("expected a digest mismatch, got {other:?}"),
    }
    // Bytes that do not parse give a digest error, not a format error: no parse happens.
    let garbage = b"not a verifier key";
    assert!(matches!(
        PinnedVerifier::from_bytes(garbage, &wrong),
        Err(LoadError::DigestMismatch { .. })
    ));
    // With the correct digest, the same garbage gives a format error.
    assert!(matches!(
        PinnedVerifier::from_bytes(garbage, &Sha256Digest::of(garbage)),
        Err(LoadError::Format(_))
    ));
}

#[test]
fn non_hiding_key_is_rejected() {
    let digest = Sha256Digest::from_hex(STANDARD_PKV_SHA256).unwrap();
    let result = PinnedVerifier::load(&artifact("sample-standard.pkv"), &digest);
    assert!(matches!(result, Err(LoadError::NotHiding)), "{result:?}");
}

#[test]
fn oversized_proof_is_rejected_before_decoding() {
    let bytes = read("proof.np");
    let result = Proof::decode(&bytes, bytes.len() - 1);
    assert!(
        matches!(result, Err(DecodeError::TooLarge { .. })),
        "{result:?}"
    );
}

#[test]
fn malformed_json_is_rejected() {
    let result = Proof::decode(b"{\"public_inputs\":[]}", DEFAULT_MAX_PROOF_BYTES);
    assert!(matches!(result, Err(DecodeError::Json(_))), "{result:?}");
}

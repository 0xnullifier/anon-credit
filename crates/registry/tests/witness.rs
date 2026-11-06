//! Tests of the batch-open witness builder.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use anon_credit_crypto::batch::{batch_id, commitment, leaf};
use anon_credit_crypto::{BatchOpenPublicInputs, FieldElement};
use anon_credit_registry::{
    BatchOpenWitness, MemoryStore, Mmr, MmrWitnessError, OpenSecrets, ProofError, WitnessError,
};

fn secrets(seed: u8) -> OpenSecrets {
    OpenSecrets {
        deployment_id: [1; 32],
        gateway_id: [2; 32],
        k: [seed; 32],
        session_pub: [seed.wrapping_add(100); 32],
        expiry: 500 + u64::from(seed),
        proof_epoch: 400,
    }
}

fn tree(count: u8) -> Mmr<MemoryStore> {
    let mut mmr = Mmr::new(MemoryStore::new());
    for seed in 0..count {
        let s = secrets(seed);
        mmr.append(leaf(commitment(&s.deployment_id, &s.k), s.expiry))
            .unwrap();
    }
    mmr
}

#[test]
fn public_inputs_match_the_gateway_construction() {
    let mmr = tree(11);
    let s = secrets(6);
    let witness = BatchOpenWitness::from_mmr(&mmr, 9, 6, &s).unwrap();
    let gateway = BatchOpenPublicInputs::for_open(
        s.deployment_id,
        s.gateway_id,
        mmr.root_at(9).unwrap(),
        9,
        s.proof_epoch,
        batch_id(&s.deployment_id, &s.k),
        &s.session_pub,
    );
    assert_eq!(witness.public_inputs(), gateway.to_fields());
    // Leaf 6 of 9 is under the peak of height 3: three siblings, then zero padding.
    assert!(
        witness.siblings[..3]
            .iter()
            .all(|v| *v != FieldElement::ZERO)
    );
    assert!(
        witness.siblings[3..]
            .iter()
            .all(|v| *v == FieldElement::ZERO)
    );
    let occupied: Vec<usize> = (0..32)
        .filter(|h| witness.peaks[*h] != FieldElement::ZERO)
        .collect();
    assert_eq!(occupied, vec![0, 3]);
}

#[test]
fn rejects_expired_and_foreign_secrets() {
    let mmr = tree(4);
    let mut s = secrets(2);
    s.proof_epoch = s.expiry + 1;
    assert!(matches!(
        BatchOpenWitness::from_mmr(&mmr, 4, 2, &s),
        Err(MmrWitnessError::Witness(WitnessError::Expired { .. }))
    ));
    s.proof_epoch = s.expiry;
    assert!(BatchOpenWitness::from_mmr(&mmr, 4, 2, &s).is_ok());
    // The secrets of leaf 3 do not open leaf 2.
    assert!(matches!(
        BatchOpenWitness::from_mmr(&mmr, 4, 2, &secrets(3)),
        Err(MmrWitnessError::Witness(WitnessError::Proof(
            ProofError::PeakMismatch
        )))
    ));
    // Credit of another deployment does not open here.
    let mut other = secrets(2);
    other.deployment_id = [9; 32];
    assert!(BatchOpenWitness::from_mmr(&mmr, 4, 2, &other).is_err());
}

#[test]
fn json_round_trip_and_prover_toml() {
    let mmr = tree(3);
    let witness = BatchOpenWitness::from_mmr(&mmr, 3, 1, &secrets(1)).unwrap();
    let text = serde_json::to_string(&witness).unwrap();
    assert!(text.contains("\"proof_epoch\":\"400\""));
    assert_eq!(
        serde_json::from_str::<BatchOpenWitness>(&text).unwrap(),
        witness
    );
    let bad = text.replace("\"proof_epoch\":\"400\"", "\"proof_epoch\":\"0400\"");
    assert!(serde_json::from_str::<BatchOpenWitness>(&bad).is_err());
    let toml = witness.to_prover_toml();
    for name in [
        "circuit_id",
        "deployment_id",
        "gateway_id",
        "root",
        "leaf_count",
        "proof_epoch",
        "batch_id",
        "binding",
        "k",
        "expiry",
        "leaf_index",
        "siblings",
        "peaks",
        "session_pub",
    ] {
        assert!(toml.contains(&format!("\n{name} = ")) || toml.starts_with(&format!("{name} = ")));
    }
}

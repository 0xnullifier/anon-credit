//! Property tests of the MMR against a direct reference calculation.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use anon_credit_crypto::FieldElement;
use anon_credit_crypto::mmr_hash::{internal_node, leaf_node, peak_heights, root_from_peaks};
use anon_credit_registry::proof::peak_height_of;
use anon_credit_registry::{
    AppendUpdate, MAX_LEAVES, MembershipProof, MemoryStore, Mmr, MmrError, MmrStore, ProofError,
    check_proof, verify_proof,
};
use proptest::prelude::*;

/// Hash of the perfect subtree of `leaves`. The length is a power of two.
fn subtree(leaves: &[FieldElement]) -> FieldElement {
    if leaves.len() == 1 {
        return leaf_node(leaves[0]);
    }
    let half = leaves.len() / 2;
    let height = u8::try_from(leaves.len().trailing_zeros()).unwrap();
    internal_node(height, subtree(&leaves[..half]), subtree(&leaves[half..]))
}

/// Root of the first `count` leaves, from the definition and without the store.
fn reference_root(leaves: &[FieldElement], count: u32) -> FieldElement {
    let mut offset = 0usize;
    let mut peaks = Vec::new();
    for height in peak_heights(count) {
        let size = 1usize << height;
        peaks.push(subtree(&leaves[offset..offset + size]));
        offset += size;
    }
    root_from_peaks(count, &peaks).unwrap()
}

fn leaf_value(i: u64) -> FieldElement {
    FieldElement::from_u64(1_000_003 * i + 17)
}

fn build(count: u32) -> (Mmr<MemoryStore>, Vec<FieldElement>) {
    let mut mmr = Mmr::new(MemoryStore::new());
    let leaves: Vec<FieldElement> = (0..u64::from(count)).map(leaf_value).collect();
    for (i, leaf) in leaves.iter().enumerate() {
        assert_eq!(mmr.append(*leaf).unwrap() as usize, i);
    }
    (mmr, leaves)
}

fn bump(value: FieldElement) -> FieldElement {
    let mut bytes = value.to_bytes_be();
    bytes[31] ^= 1;
    FieldElement::from_bytes_be(&bytes).unwrap()
}

fn assert_tampering_fails(root: FieldElement, proof: &MembershipProof, leaf: FieldElement) {
    assert!(!verify_proof(root, proof, bump(leaf)));
    assert!(!verify_proof(bump(root), proof, leaf));
    for i in 0..proof.siblings.len() {
        let mut changed = proof.clone();
        changed.siblings[i] = bump(changed.siblings[i]);
        assert!(!verify_proof(root, &changed, leaf));
    }
    for i in 0..proof.peaks.len() {
        let mut changed = proof.clone();
        changed.peaks[i] = bump(changed.peaks[i]);
        assert!(!verify_proof(root, &changed, leaf));
    }
    let mut changed = proof.clone();
    changed.leaf_count += 1;
    assert!(!verify_proof(root, &changed, leaf));
    let mut changed = proof.clone();
    changed.leaf_index ^= 1;
    assert!(!verify_proof(root, &changed, leaf));
    let mut changed = proof.clone();
    changed.peak_position += 1;
    assert!(!verify_proof(root, &changed, leaf));
    let mut changed = proof.clone();
    changed.siblings.push(FieldElement::ZERO);
    assert_eq!(
        check_proof(root, &changed, leaf),
        Err(ProofError::WrongSiblingCount)
    );
}

#[test]
fn every_proof_of_every_snapshot_up_to_33_leaves() {
    let (mmr, leaves) = build(33);
    for count in 0..=33u32 {
        let root = mmr.root_at(count).unwrap();
        assert_eq!(root, reference_root(&leaves, count), "root of {count}");
        assert_eq!(
            mmr.peaks_at(count).unwrap().len(),
            count.count_ones() as usize
        );
        for index in 0..count {
            let proof = mmr.membership_proof_at(index, count).unwrap();
            assert_eq!(
                proof.siblings.len(),
                usize::from(peak_height_of(index, count).unwrap())
            );
            assert_eq!(check_proof(root, &proof, leaves[index as usize]), Ok(()));
        }
    }
}

#[test]
fn tampered_proofs_fail() {
    let (mmr, leaves) = build(23);
    for count in [1u32, 2, 3, 7, 8, 13, 23] {
        let root = mmr.root_at(count).unwrap();
        for index in 0..count {
            let proof = mmr.membership_proof_at(index, count).unwrap();
            assert_tampering_fails(root, &proof, leaves[index as usize]);
        }
    }
}

#[test]
fn proof_against_a_newer_root_fails() {
    let (mmr, leaves) = build(9);
    let proof = mmr.membership_proof_at(2, 5).unwrap();
    assert!(verify_proof(mmr.root_at(5).unwrap(), &proof, leaves[2]));
    assert!(!verify_proof(mmr.root().unwrap(), &proof, leaves[2]));
}

#[test]
fn snapshot_and_index_bounds() {
    let (mmr, _) = build(5);
    assert!(matches!(
        mmr.root_at(6),
        Err(MmrError::SnapshotAhead {
            requested: 6,
            current: 5
        })
    ));
    assert!(matches!(
        mmr.membership_proof_at(5, 5),
        Err(MmrError::IndexOutOfRange { .. })
    ));
    assert!(matches!(
        mmr.membership_proof_at(0, 0),
        Err(MmrError::IndexOutOfRange { .. })
    ));
}

#[test]
fn proof_json_round_trip_rejects_unknown_fields() {
    let (mmr, _) = build(6);
    let proof = mmr.membership_proof(3).unwrap();
    let text = serde_json::to_string(&proof).unwrap();
    assert_eq!(
        serde_json::from_str::<MembershipProof>(&text).unwrap(),
        proof
    );
    let extra = text.replacen('{', "{\"extra\":1,", 1);
    assert!(serde_json::from_str::<MembershipProof>(&extra).is_err());
}

/// A store that reports a full MMR.
struct FullStore;

#[derive(Debug, thiserror::Error)]
#[error("not used")]
struct NeverError;

impl MmrStore for FullStore {
    type Error = NeverError;
    fn leaf_count(&self) -> Result<u32, NeverError> {
        Ok(MAX_LEAVES)
    }
    fn leaf(&self, _: u32) -> Result<Option<FieldElement>, NeverError> {
        Ok(None)
    }
    fn node(&self, _: u8, _: u32) -> Result<Option<FieldElement>, NeverError> {
        Ok(Some(FieldElement::ZERO))
    }
    fn append(&mut self, _: &AppendUpdate) -> Result<(), NeverError> {
        Ok(())
    }
}

#[test]
fn append_stops_at_max_leaves() {
    let mut mmr = Mmr::new(FullStore);
    assert!(matches!(
        mmr.append(FieldElement::ZERO),
        Err(MmrError::Full)
    ));
    // The largest snapshot has 32 peaks.
    assert_eq!(mmr.peaks().unwrap().len(), 32);
    let proof = mmr.membership_proof(0).unwrap();
    assert_eq!(proof.siblings.len(), 31);
    assert_eq!(proof.peak_position, 0);
    let proof = mmr.membership_proof(MAX_LEAVES - 1).unwrap();
    assert_eq!(proof.siblings.len(), 0);
    assert_eq!(proof.peak_position, 31);
}

#[test]
fn memory_store_rejects_out_of_order_updates() {
    let mut store = MemoryStore::new();
    let update = AppendUpdate {
        leaf_index: 1,
        leaf: FieldElement::ZERO,
        nodes: vec![],
    };
    assert!(store.append(&update).is_err());
    assert_eq!(store.leaf_count().unwrap(), 0);
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    #[test]
    fn random_snapshots_and_indices(
        count in 1u32..=260,
        snapshot_seed in any::<u32>(),
        index_seed in any::<u32>(),
        leaf_seed in any::<u64>(),
    ) {
        let mut mmr = Mmr::new(MemoryStore::new());
        let leaves: Vec<FieldElement> = (0..u64::from(count))
            .map(|i| FieldElement::from_u64(leaf_seed.wrapping_add(i.wrapping_mul(0x9e37_79b9))))
            .collect();
        for leaf in &leaves {
            mmr.append(*leaf).unwrap();
        }
        let snapshot = 1 + snapshot_seed % count;
        let index = index_seed % snapshot;
        let root = mmr.root_at(snapshot).unwrap();
        prop_assert_eq!(root, reference_root(&leaves, snapshot));
        let proof = mmr.membership_proof_at(index, snapshot).unwrap();
        prop_assert_eq!(check_proof(root, &proof, leaves[index as usize]), Ok(()));
        let other = (index + 1) % snapshot;
        if leaves[other as usize] != leaves[index as usize] {
            prop_assert!(!verify_proof(root, &proof, leaves[other as usize]));
        }
    }
}

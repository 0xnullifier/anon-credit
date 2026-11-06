//! Membership proofs and their verification.
//!
//! Path rule. Let `n` be the leaf count and `i < n` the leaf index. The peaks of the MMR are the
//! 1 bits of `n`, from the highest bit (left) to the lowest bit (right). Leaf `i` is under the
//! peak of height `h`, where `h` is the highest bit in which `i` and `n` are different. (In that
//! bit `n` has 1 and `i` has 0, because `i < n`.) The path from the leaf to that peak has `h`
//! levels. At level `j` (`0 <= j < h`), bit `j` of `i` is the side of the current node: 0 means
//! that the node is the left child, 1 means that the node is the right child.
//!
//! Thus the leaf index and the leaf count fix the peak and each left/right decision.
//! The verifier calculates them. It does not accept them from the proof.

use crate::mmr_hash_ext::path_root;
use anon_credit_crypto::FieldElement;
use anon_credit_crypto::mmr_hash::{peak_heights, root_from_peaks};
use serde::{Deserialize, Serialize};

/// Complete membership proof of one leaf against one root snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MembershipProof {
    /// Leaf index.
    pub leaf_index: u32,
    /// Leaf count of the root snapshot.
    pub leaf_count: u32,
    /// Position of the leaf's peak in `peaks` (0 is the left, highest peak).
    pub peak_position: u32,
    /// Siblings from the leaf level up to one level below the peak. Length: the peak height.
    pub siblings: Vec<FieldElement>,
    /// All peaks of the snapshot, in descending height order.
    pub peaks: Vec<FieldElement>,
}

/// Reason why a membership proof is not valid.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ProofError {
    /// The leaf index is not less than the leaf count.
    #[error("leaf index is not less than the leaf count")]
    IndexOutOfRange,
    /// The sibling count is not the peak height.
    #[error("sibling count is not the peak height")]
    WrongSiblingCount,
    /// The peak count is not the number of 1 bits of the leaf count.
    #[error("peak count does not agree with the leaf count")]
    WrongPeakCount,
    /// The peak position does not agree with the leaf index and the leaf count.
    #[error("peak position does not agree with the leaf index")]
    WrongPeakPosition,
    /// The path does not give the peak in the proof.
    #[error("path does not give the peak")]
    PeakMismatch,
    /// The peaks and the leaf count do not give the root.
    #[error("peaks do not give the root")]
    RootMismatch,
}

/// Height of the peak that has leaf `leaf_index` in an MMR of `leaf_count` leaves.
/// `None` if `leaf_index >= leaf_count`.
pub fn peak_height_of(leaf_index: u32, leaf_count: u32) -> Option<u8> {
    if leaf_index >= leaf_count {
        return None;
    }
    let differ = leaf_index ^ leaf_count;
    // differ is not zero, so leading_zeros is at most 31.
    u8::try_from(31 - differ.leading_zeros()).ok()
}

/// Position of the peak of height `height` in the descending peak list of `leaf_count`.
pub fn peak_position_of(leaf_count: u32, height: u8) -> Option<u32> {
    peak_heights(leaf_count)
        .iter()
        .position(|h| *h == height)
        .and_then(|position| u32::try_from(position).ok())
}

/// Check a membership proof of `leaf` against `root`.
pub fn check_proof(
    root: FieldElement,
    proof: &MembershipProof,
    leaf: FieldElement,
) -> Result<(), ProofError> {
    let height =
        peak_height_of(proof.leaf_index, proof.leaf_count).ok_or(ProofError::IndexOutOfRange)?;
    if proof.siblings.len() != usize::from(height) {
        return Err(ProofError::WrongSiblingCount);
    }
    if proof.peaks.len() != peak_heights(proof.leaf_count).len() {
        return Err(ProofError::WrongPeakCount);
    }
    let position =
        peak_position_of(proof.leaf_count, height).ok_or(ProofError::WrongPeakPosition)?;
    if position != proof.peak_position {
        return Err(ProofError::WrongPeakPosition);
    }
    let peak = path_root(leaf, proof.leaf_index, &proof.siblings);
    if proof.peaks.get(position as usize) != Some(&peak) {
        return Err(ProofError::PeakMismatch);
    }
    let calculated =
        root_from_peaks(proof.leaf_count, &proof.peaks).map_err(|_| ProofError::WrongPeakCount)?;
    if calculated != root {
        return Err(ProofError::RootMismatch);
    }
    Ok(())
}

/// Tell if a membership proof of `leaf` against `root` is valid.
pub fn verify_proof(root: FieldElement, proof: &MembershipProof, leaf: FieldElement) -> bool {
    check_proof(root, proof, leaf).is_ok()
}

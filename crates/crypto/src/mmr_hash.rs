//! MMR hash rules. `crates/registry` builds the tree with these rules. The circuit and the
//! TypeScript verifier use the same rules.
//!
//! ```text
//! leaf_node = H(DOM_MMR_LEAF, leaf)
//! node      = H(DOM_MMR_NODE * 2^32 + height, left, right)    height = parent height, 1..=31
//! root      = H(DOM_MMR_ROOT, leaf_count, slot[31], slot[30], ..., slot[0])
//! ```
//!
//! A leaf node has height 0. A node of height `h` covers `2^h` leaves.
//! `slot[h]` is the peak of height `h` if bit `h` of `leaf_count` is 1, else zero.
//! Thus the root commits to `leaf_count` and to each occupied peak, in descending height order
//! (left to right in the MMR). The leaf and node domains are different, so a leaf node is never
//! equal to an internal node of the same inputs. The tag text is at most 27 bytes, so the node
//! domain value is less than `2^248` and is never equal to a plain tag value.

use crate::constants::{DOM_MMR_LEAF, DOM_MMR_NODE, DOM_MMR_ROOT, MAX_PEAKS};
use crate::field::FieldElement;
use crate::poseidon2::hash;
use ark_bn254::Fr;

/// Domain value of an internal node of height `height`: `DOM_MMR_NODE * 2^32 + height`.
pub fn node_domain(height: u8) -> FieldElement {
    let shifted = DOM_MMR_NODE.fr() * Fr::from(1u64 << 32);
    FieldElement::from_fr(shifted + Fr::from(u64::from(height)))
}

/// Leaf node (height 0) of a tree leaf.
pub fn leaf_node(leaf: FieldElement) -> FieldElement {
    hash(&[DOM_MMR_LEAF, leaf])
}

/// Internal node. `height` is the height of this node: one more than its children.
pub fn internal_node(height: u8, left: FieldElement, right: FieldElement) -> FieldElement {
    hash(&[node_domain(height), left, right])
}

/// Root of an MMR with `leaf_count` leaves. `peak_slots[h]` is the peak of height `h`, or zero.
///
/// The caller must give zero in each slot whose bit in `leaf_count` is 0.
/// [`root_from_peaks`] makes the slots from a peak list and checks this rule.
pub fn root(leaf_count: u32, peak_slots: &[FieldElement; MAX_PEAKS]) -> FieldElement {
    let mut inputs = Vec::with_capacity(MAX_PEAKS + 2);
    inputs.push(DOM_MMR_ROOT);
    inputs.push(FieldElement::from_u64(u64::from(leaf_count)));
    inputs.extend(peak_slots.iter().rev());
    hash(&inputs)
}

/// The peak heights of an MMR with `leaf_count` leaves, in descending order.
pub fn peak_heights(leaf_count: u32) -> Vec<u8> {
    (0..32u8)
        .rev()
        .filter(|height| leaf_count >> height & 1 == 1)
        .collect()
}

/// Failure to make peak slots from a peak list.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("leaf count {leaf_count} has {expected} peaks, found {found}")]
pub struct PeakCountError {
    /// Leaf count.
    pub leaf_count: u32,
    /// Peak count that the leaf count needs.
    pub expected: usize,
    /// Peak count in the input.
    pub found: usize,
}

/// Height-indexed peak slots from the occupied peaks in descending height order.
pub fn peak_slots(
    leaf_count: u32,
    peaks: &[FieldElement],
) -> Result<[FieldElement; MAX_PEAKS], PeakCountError> {
    let heights = peak_heights(leaf_count);
    if heights.len() != peaks.len() {
        return Err(PeakCountError {
            leaf_count,
            expected: heights.len(),
            found: peaks.len(),
        });
    }
    let mut slots = [FieldElement::ZERO; MAX_PEAKS];
    for (height, peak) in heights.into_iter().zip(peaks) {
        slots[usize::from(height)] = *peak;
    }
    Ok(slots)
}

/// Root from the occupied peaks in descending height order.
pub fn root_from_peaks(
    leaf_count: u32,
    peaks: &[FieldElement],
) -> Result<FieldElement, PeakCountError> {
    peak_slots(leaf_count, peaks).map(|slots| root(leaf_count, &slots))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peak_heights_follow_the_bits_of_leaf_count() {
        assert_eq!(peak_heights(0), Vec::<u8>::new());
        assert_eq!(peak_heights(1), vec![0]);
        assert_eq!(peak_heights(7), vec![2, 1, 0]);
        assert_eq!(peak_heights(8), vec![3]);
        assert_eq!(peak_heights(100), vec![6, 5, 2]);
        assert_eq!(peak_heights(u32::MAX).len(), 32);
    }

    #[test]
    fn peak_slots_reject_a_wrong_count() {
        assert!(peak_slots(3, &[FieldElement::ZERO]).is_err());
        assert!(peak_slots(3, &[FieldElement::ZERO, FieldElement::ZERO]).is_ok());
    }
}

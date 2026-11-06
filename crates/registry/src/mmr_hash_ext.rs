//! Path calculation shared by the MMR and the proof verifier.

use anon_credit_crypto::FieldElement;
use anon_credit_crypto::mmr_hash::{internal_node, leaf_node};

/// Peak hash from a leaf, its index, and the siblings from the leaf level upward.
///
/// At level `j`, bit `j` of `leaf_index` is 1 if the current node is the right child.
pub(crate) fn path_root(
    leaf: FieldElement,
    leaf_index: u32,
    siblings: &[FieldElement],
) -> FieldElement {
    let mut node = leaf_node(leaf);
    for (level, sibling) in siblings.iter().enumerate() {
        let is_right = (leaf_index >> level) & 1 == 1;
        let height = u8::try_from(level + 1).unwrap_or(u8::MAX);
        node = if is_right {
            internal_node(height, *sibling, node)
        } else {
            internal_node(height, node, *sibling)
        };
    }
    node
}

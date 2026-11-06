// MMR membership with fixed-size witness arrays.
//
// Hash rules (the same as anon_credit_crypto::mmr_hash):
//   leaf_node = H(DOM_MMR_LEAF, leaf)
//   node      = H(DOM_MMR_NODE * 2^32 + height, left, right)    height = parent height
//   root      = H(DOM_MMR_ROOT, leaf_count, peaks[31], peaks[30], ..., peaks[0])
//
// Witness layout:
//   siblings[j]: the sibling at level j for j < h, else zero. h is the peak height of the leaf.
//   peaks[t]:    the peak of height t if bit t of leaf_count is 1, else zero.
//
// Path rule: the peak height h is the highest bit in which leaf_index and leaf_count are
// different. In that bit leaf_count has 1 and leaf_index has 0, which also proves that
// leaf_index < leaf_count. At level j < h, bit j of leaf_index is 1 if the current node is the
// right child. The circuit calculates h and each decision from the private leaf_index and the
// public leaf_count. It does not accept a path selection from the prover.

use crate::constants::{DOM_MMR_LEAF, DOM_MMR_NODE, DOM_MMR_ROOT, MAX_HEIGHT, MAX_PEAKS};
use crate::hash::hash;

global TWO_POW_32: Field = 0x100000000;
global INDEX_BITS: u32 = 32;
global ROOT_INPUTS: u32 = 34;

pub fn leaf_node(leaf: Field) -> Field {
    hash([DOM_MMR_LEAF, leaf])
}

pub fn internal_node(height: Field, left: Field, right: Field) -> Field {
    hash([DOM_MMR_NODE * TWO_POW_32 + height, left, right])
}

// Root of an MMR. The caller must constrain the empty slots of `peaks` to zero.
pub fn root(leaf_count: Field, peaks: [Field; MAX_PEAKS]) -> Field {
    assert(ROOT_INPUTS == MAX_PEAKS + 2);
    let mut inputs: [Field; ROOT_INPUTS] = [0; ROOT_INPUTS];
    inputs[0] = DOM_MMR_ROOT;
    inputs[1] = leaf_count;
    for t in 0..MAX_PEAKS {
        inputs[2 + (MAX_PEAKS - 1 - t)] = peaks[t];
    }
    hash(inputs)
}

// Calculate the root from a leaf, its private index, the public leaf count, and the witness.
// The function constrains:
//   - leaf_index and leaf_count are less than 2^32, and leaf_index < leaf_count;
//   - the peak height and each left/right decision come from leaf_index and leaf_count;
//   - each sibling slot at or above the peak height is zero;
//   - each peak slot of a 0 bit of leaf_count is zero;
//   - the peak slot of the leaf's peak height is the calculated path node.
pub fn membership_root(
    leaf: Field,
    leaf_index: Field,
    leaf_count: Field,
    siblings: [Field; MAX_HEIGHT],
    peaks: [Field; MAX_PEAKS],
) -> Field {
    assert(MAX_HEIGHT == INDEX_BITS);
    assert(MAX_PEAKS == INDEX_BITS);
    // The bit decompositions also constrain both values to be less than 2^32.
    let index_bits: [u1; INDEX_BITS] = leaf_index.to_le_bits();
    let count_bits: [u1; INDEX_BITS] = leaf_count.to_le_bits();

    // in_path[j] = 1 if level j is below the peak (j < h).
    // is_peak[t] = 1 if t is the peak height h.
    let mut in_path: [Field; INDEX_BITS] = [0; INDEX_BITS];
    let mut is_peak: [Field; INDEX_BITS] = [0; INDEX_BITS];
    let mut differ_above: Field = 0;
    for step in 0..INDEX_BITS {
        let t = INDEX_BITS - 1 - step;
        let index_bit = index_bits[t] as Field;
        let count_bit = count_bits[t] as Field;
        let differ = index_bit + count_bit - 2 * index_bit * count_bit;
        in_path[t] = differ_above;
        is_peak[t] = differ * (1 - differ_above);
        // At the highest different bit, leaf_count has 1 (thus leaf_index < leaf_count).
        assert(is_peak[t] * (1 - count_bit) == 0, "leaf index not below leaf count");
        differ_above += is_peak[t];
    }
    // The values are different in at least one bit. Thus exactly one is_peak[t] is 1.
    assert(differ_above == 1, "leaf index not below leaf count");

    let mut node = leaf_node(leaf);
    // Level 31 is never below a peak, because the peak height is at most 31.
    assert(siblings[MAX_HEIGHT - 1] == 0, "sibling padding not zero");
    for j in 0..MAX_HEIGHT - 1 {
        let sibling = siblings[j];
        let is_right = index_bits[j] as Field;
        let left = node + is_right * (sibling - node);
        let right = sibling + is_right * (node - sibling);
        let parent = internal_node((j + 1) as Field, left, right);
        node += in_path[j] * (parent - node);
        assert((1 - in_path[j]) * sibling == 0, "sibling padding not zero");
    }

    for t in 0..MAX_PEAKS {
        let count_bit = count_bits[t] as Field;
        assert((1 - count_bit) * peaks[t] == 0, "empty peak slot not zero");
        assert(is_peak[t] * (peaks[t] - node) == 0, "peak mismatch");
    }
    root(leaf_count, peaks)
}

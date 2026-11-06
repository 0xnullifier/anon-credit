//! Append-only Merkle Mountain Range registry.
//!
//! Phase 2 adds these parts here:
//!
//! - MMR insertion. Hash leaf nodes and internal nodes under different domain tags.
//!   Include the parent height in each internal-node hash.
//! - Root calculation. The root commits to `leaf_count` and to each occupied peak in order.
//! - Complete membership proofs against one retained root snapshot.
//! - Durable snapshots and persistence.
//!
//! Phase 1 must first freeze the Poseidon2 parameters and the domain-tag encoding.
//! Do not add hash constants here before that.

/// Maximum number of leaves in the first deployment (`2^32 - 1`).
pub const MAX_LEAVES: u64 = u32::MAX as u64;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_leaves_is_two_pow_32_minus_one() {
        assert_eq!(MAX_LEAVES, (1u64 << 32) - 1);
    }
}

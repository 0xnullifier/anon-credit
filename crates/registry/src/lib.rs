//! Append-only Merkle Mountain Range registry.
//!
//! - [`mmr`]: insertion, peaks, roots, snapshots, and membership proofs.
//! - [`store`]: the storage interface and an in-memory store. Phase 2 adds SQLite.
//! - [`proof`]: the proof format and the verifier.
//! - [`witness`]: the full input set of the batch-open circuit.
//!
//! The hash rules are in `anon_credit_crypto::mmr_hash`.

pub mod mmr;
mod mmr_hash_ext;
pub mod proof;
pub mod store;
pub mod witness;

pub use anon_credit_crypto::constants::MAX_LEAVES;
pub use mmr::{Mmr, MmrError, Peak};
pub use proof::{MembershipProof, ProofError, check_proof, verify_proof};
pub use store::{AppendUpdate, MemoryStore, MmrStore, NodeWrite};
pub use witness::{BatchOpenWitness, MmrWitnessError, OpenSecrets, WitnessError};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_leaves_is_two_pow_32_minus_one() {
        assert_eq!(u64::from(MAX_LEAVES), (1u64 << 32) - 1);
    }
}

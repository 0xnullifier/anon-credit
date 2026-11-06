//! Append-only Merkle Mountain Range.
//!
//! Rules (implementation.md section 8). The hash rules are in `anon_credit_crypto::mmr_hash`.
//!
//! - At most `2^32 - 1` leaves.
//! - The peaks are the 1 bits of the leaf count, in descending height order.
//! - Leaf nodes and internal nodes use different domain tags. Each internal node hash has the
//!   parent height.
//! - Bagging rule: `root = H(DOM_MMR_ROOT, leaf_count, slot[31], ..., slot[0])`. `slot[h]` is the
//!   peak of height `h`, or zero if bit `h` of the leaf count is 0. The root of the empty MMR uses
//!   leaf count 0 and 32 zero slots.
//! - Snapshots: [`Mmr::root_at`] and [`Mmr::membership_proof_at`] use an earlier leaf count.
//!   Clients prove against a selected published root, which can be older than the current tree.

use crate::proof::{MembershipProof, peak_height_of, peak_position_of};
use crate::store::{AppendUpdate, MmrStore, NodeWrite};
use anon_credit_crypto::FieldElement;
use anon_credit_crypto::constants::MAX_LEAVES;
use anon_credit_crypto::mmr_hash::{internal_node, leaf_node, peak_heights, root_from_peaks};

/// One peak of the MMR.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Peak {
    /// Peak height. The peak covers `2^height` leaves.
    pub height: u8,
    /// Peak hash.
    pub hash: FieldElement,
}

/// MMR failure.
#[derive(Debug, thiserror::Error)]
pub enum MmrError<E: std::error::Error + 'static> {
    /// The store failed.
    #[error("store failure: {0}")]
    Store(#[source] E),
    /// The MMR has `2^32 - 1` leaves.
    #[error("the MMR is full")]
    Full,
    /// The leaf index is not less than the leaf count of the snapshot.
    #[error("leaf index {leaf_index} is not less than leaf count {leaf_count}")]
    IndexOutOfRange {
        /// Leaf index.
        leaf_index: u32,
        /// Leaf count.
        leaf_count: u32,
    },
    /// The snapshot leaf count is more than the current leaf count.
    #[error("snapshot leaf count {requested} is more than the leaf count {current}")]
    SnapshotAhead {
        /// Requested leaf count.
        requested: u32,
        /// Current leaf count.
        current: u32,
    },
    /// The store does not have a node that must exist.
    #[error("store has no node at height {height} index {index}")]
    MissingNode {
        /// Node height.
        height: u8,
        /// Node index.
        index: u32,
    },
}

/// Append-only MMR over a store.
#[derive(Debug, Clone, Default)]
pub struct Mmr<S> {
    store: S,
}

impl<S: MmrStore> Mmr<S> {
    /// An MMR that uses `store`. The store can already have leaves.
    pub fn new(store: S) -> Self {
        Self { store }
    }

    /// The store.
    pub fn store(&self) -> &S {
        &self.store
    }

    /// The store, for changes that are not appends (for example the staged writes of
    /// [`crate::sqlite::SqliteStore`]). Do not change the leaves or nodes through it.
    pub fn store_mut(&mut self) -> &mut S {
        &mut self.store
    }

    /// Number of leaves.
    pub fn leaf_count(&self) -> Result<u32, MmrError<S::Error>> {
        self.store.leaf_count().map_err(MmrError::Store)
    }

    /// Leaf value at `index`.
    pub fn leaf(&self, index: u32) -> Result<Option<FieldElement>, MmrError<S::Error>> {
        self.store.leaf(index).map_err(MmrError::Store)
    }

    fn node(&self, height: u8, index: u32) -> Result<FieldElement, MmrError<S::Error>> {
        self.store
            .node(height, index)
            .map_err(MmrError::Store)?
            .ok_or(MmrError::MissingNode { height, index })
    }

    /// Append a leaf. Return its index.
    pub fn append(&mut self, leaf: FieldElement) -> Result<u32, MmrError<S::Error>> {
        let leaf_index = self.leaf_count()?;
        if leaf_index == MAX_LEAVES {
            return Err(MmrError::Full);
        }
        let mut node = leaf_node(leaf);
        let mut height = 0u8;
        let mut index = leaf_index;
        let mut nodes = vec![NodeWrite {
            height,
            index,
            hash: node,
        }];
        // Each 1 bit at the bottom of the index closes one more subtree.
        while index & 1 == 1 {
            let left = self.node(height, index - 1)?;
            height += 1;
            index >>= 1;
            node = internal_node(height, left, node);
            nodes.push(NodeWrite {
                height,
                index,
                hash: node,
            });
        }
        let update = AppendUpdate {
            leaf_index,
            leaf,
            nodes,
        };
        self.store.append(&update).map_err(MmrError::Store)?;
        Ok(leaf_index)
    }

    fn check_snapshot(&self, leaf_count: u32) -> Result<(), MmrError<S::Error>> {
        let current = self.leaf_count()?;
        if leaf_count > current {
            return Err(MmrError::SnapshotAhead {
                requested: leaf_count,
                current,
            });
        }
        Ok(())
    }

    /// Peaks of the snapshot with `leaf_count` leaves, in descending height order.
    pub fn peaks_at(&self, leaf_count: u32) -> Result<Vec<Peak>, MmrError<S::Error>> {
        self.check_snapshot(leaf_count)?;
        peak_heights(leaf_count)
            .into_iter()
            .map(|height| {
                // Bit `height` of leaf_count is 1, so this index is the last complete node.
                let index = (leaf_count >> height) - 1;
                self.node(height, index).map(|hash| Peak { height, hash })
            })
            .collect()
    }

    /// Current peaks, in descending height order.
    pub fn peaks(&self) -> Result<Vec<Peak>, MmrError<S::Error>> {
        self.peaks_at(self.leaf_count()?)
    }

    /// Root of the snapshot with `leaf_count` leaves.
    pub fn root_at(&self, leaf_count: u32) -> Result<FieldElement, MmrError<S::Error>> {
        let peaks: Vec<FieldElement> = self
            .peaks_at(leaf_count)?
            .into_iter()
            .map(|peak| peak.hash)
            .collect();
        // peaks_at returns one peak for each 1 bit, so the count is correct.
        root_from_peaks(leaf_count, &peaks).map_err(|_| MmrError::MissingNode {
            height: 0,
            index: leaf_count,
        })
    }

    /// Current root.
    pub fn root(&self) -> Result<FieldElement, MmrError<S::Error>> {
        self.root_at(self.leaf_count()?)
    }

    /// Membership proof of leaf `leaf_index` against the snapshot with `leaf_count` leaves.
    pub fn membership_proof_at(
        &self,
        leaf_index: u32,
        leaf_count: u32,
    ) -> Result<MembershipProof, MmrError<S::Error>> {
        self.check_snapshot(leaf_count)?;
        let height = peak_height_of(leaf_index, leaf_count).ok_or(MmrError::IndexOutOfRange {
            leaf_index,
            leaf_count,
        })?;
        let siblings = (0..height)
            .map(|level| self.node(level, (leaf_index >> level) ^ 1))
            .collect::<Result<Vec<_>, _>>()?;
        let peaks = self
            .peaks_at(leaf_count)?
            .into_iter()
            .map(|peak| peak.hash)
            .collect();
        let peak_position = peak_position_of(leaf_count, height).unwrap_or(u32::MAX);
        Ok(MembershipProof {
            leaf_index,
            leaf_count,
            peak_position,
            siblings,
            peaks,
        })
    }

    /// Membership proof of leaf `leaf_index` against the current root.
    pub fn membership_proof(&self, leaf_index: u32) -> Result<MembershipProof, MmrError<S::Error>> {
        self.membership_proof_at(leaf_index, self.leaf_count()?)
    }
}

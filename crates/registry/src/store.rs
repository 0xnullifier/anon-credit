//! Storage interface of the MMR.
//!
//! The MMR keeps the hash of each complete subtree. A node is at `(height, index)`: it covers
//! leaves `index * 2^height .. (index + 1) * 2^height`. A node never changes after it is written.
//! Thus a proof against an earlier leaf count (a root snapshot) reads only nodes that existed
//! at that leaf count.
//!
//! Phase 2 adds a SQLite store. It must write one [`AppendUpdate`] in one transaction.

use anon_credit_crypto::FieldElement;

/// Number of node heights that the store keeps (heights 0..=31).
pub const NODE_HEIGHTS: usize = 32;

/// One node write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NodeWrite {
    /// Node height. A leaf node has height 0.
    pub height: u8,
    /// Node index at this height.
    pub index: u32,
    /// Node hash.
    pub hash: FieldElement,
}

/// All writes of one append. The store applies all of them or none of them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppendUpdate {
    /// Index of the new leaf. It is equal to the leaf count before the append.
    pub leaf_index: u32,
    /// The new leaf value (not the leaf node hash).
    pub leaf: FieldElement,
    /// The leaf node and each internal node that the append completes, in ascending height.
    pub nodes: Vec<NodeWrite>,
}

/// Storage of MMR leaves and nodes.
pub trait MmrStore {
    /// Storage failure.
    type Error: std::error::Error + Send + Sync + 'static;

    /// Number of leaves in the store.
    fn leaf_count(&self) -> Result<u32, Self::Error>;

    /// Leaf value at `index`, or `None` if there is no such leaf.
    fn leaf(&self, index: u32) -> Result<Option<FieldElement>, Self::Error>;

    /// Node hash at `(height, index)`, or `None` if the node is not complete.
    fn node(&self, height: u8, index: u32) -> Result<Option<FieldElement>, Self::Error>;

    /// Apply one append. The store must check that `update.leaf_index` is equal to its
    /// leaf count, and apply all writes atomically.
    fn append(&mut self, update: &AppendUpdate) -> Result<(), Self::Error>;
}

/// Failure of the in-memory store.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum MemoryStoreError {
    /// The update does not continue the current leaf sequence.
    #[error("append at leaf {found}, but the leaf count is {expected}")]
    OutOfOrder {
        /// Current leaf count.
        expected: u32,
        /// Leaf index of the update.
        found: u32,
    },
    /// A node write is not the next node at its height.
    #[error("node write at height {height} index {index} is out of order")]
    NodeOutOfOrder {
        /// Node height.
        height: u8,
        /// Node index.
        index: u32,
    },
}

/// MMR store in memory. For tests, fixtures, and the client.
#[derive(Debug, Clone, Default)]
pub struct MemoryStore {
    leaves: Vec<FieldElement>,
    levels: Vec<Vec<FieldElement>>,
}

impl MemoryStore {
    /// An empty store.
    pub fn new() -> Self {
        Self {
            leaves: Vec::new(),
            levels: vec![Vec::new(); NODE_HEIGHTS],
        }
    }
}

fn to_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

impl MmrStore for MemoryStore {
    type Error = MemoryStoreError;

    fn leaf_count(&self) -> Result<u32, Self::Error> {
        Ok(to_u32(self.leaves.len()))
    }

    fn leaf(&self, index: u32) -> Result<Option<FieldElement>, Self::Error> {
        Ok(self.leaves.get(index as usize).copied())
    }

    fn node(&self, height: u8, index: u32) -> Result<Option<FieldElement>, Self::Error> {
        Ok(self
            .levels
            .get(usize::from(height))
            .and_then(|level| level.get(index as usize))
            .copied())
    }

    fn append(&mut self, update: &AppendUpdate) -> Result<(), Self::Error> {
        let expected = to_u32(self.leaves.len());
        if update.leaf_index != expected {
            return Err(MemoryStoreError::OutOfOrder {
                expected,
                found: update.leaf_index,
            });
        }
        // Check all writes first, so that a bad update changes nothing.
        for write in &update.nodes {
            let next = self
                .levels
                .get(usize::from(write.height))
                .map(|level| to_u32(level.len()));
            if next != Some(write.index) {
                return Err(MemoryStoreError::NodeOutOfOrder {
                    height: write.height,
                    index: write.index,
                });
            }
        }
        for write in &update.nodes {
            if let Some(level) = self.levels.get_mut(usize::from(write.height)) {
                level.push(write.hash);
            }
        }
        self.leaves.push(update.leaf);
        Ok(())
    }
}

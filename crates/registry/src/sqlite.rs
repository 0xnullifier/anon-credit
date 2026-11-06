//! SQLite storage of the MMR and of the root snapshots.
//!
//! Tables:
//!
//! | Table | Key | Contents |
//! |---|---|---|
//! | `mmr_leaves` | `leaf_index` | The leaf value (32 bytes, canonical field encoding). |
//! | `mmr_nodes` | `(height, node_index)` | The hash of each complete subtree. Height 0 is the leaf node. |
//! | `mmr_root_snapshots` | `epoch` | The leaf count and the root at the end of a closed epoch. |
//!
//! A node never changes after it is written (see [`crate::store`]). Thus the store keeps a copy
//! of all leaves and nodes in memory and reads from that copy. The database is the durable
//! source. [`SqliteStore::open`] loads the copy and checks its structure.
//!
//! Writes. [`MmrStore::append`] does not write to the database, because the trait is
//! synchronous. It applies the update to the memory copy and keeps it as a staged update. The
//! caller then does these steps:
//!
//! 1. Start a database transaction.
//! 2. Call [`SqliteStore::write_staged`] in that transaction. The caller can write its own rows
//!    in the same transaction (for example a payment record).
//! 3. Commit the transaction.
//! 4. Call [`SqliteStore::commit_staged`] if the commit succeeds, or
//!    [`SqliteStore::discard_staged`] if a step fails.
//!
//! Thus each [`AppendUpdate`] is in exactly one transaction, and the caller can put many
//! appends and other rows in the same transaction. [`SqliteStore::append_durable`] does all
//! steps for callers that have no other rows.
//!
//! Durability: [`connect`] sets WAL journal mode and `synchronous = FULL`. A committed
//! transaction survives a power loss.

use crate::mmr::{Mmr, MmrError};
use crate::store::{
    AppendUpdate, MemoryStore, MemoryStoreError, MmrStore, NODE_HEIGHTS, NodeWrite,
};
use anon_credit_crypto::{FIELD_BYTES, FieldElement};
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous,
};
use sqlx::{Row, SqliteConnection};
use std::path::Path;
use std::time::Duration;

/// Failure of the SQLite store.
#[derive(Debug, thiserror::Error)]
pub enum SqliteStoreError {
    /// The database failed.
    #[error("database failure: {0}")]
    Database(#[from] sqlx::Error),
    /// The memory copy rejected an update.
    #[error("update rejected: {0}")]
    Rejected(#[from] MemoryStoreError),
    /// The stored data does not have the expected structure.
    #[error("stored MMR data is corrupt: {0}")]
    Corrupt(String),
    /// A value does not fit the SQLite integer range.
    #[error("value {0} does not fit a SQLite integer")]
    OutOfRange(u64),
    /// A root snapshot for the epoch already exists with different values.
    #[error("root snapshot for epoch {epoch} already exists with different values")]
    SnapshotConflict {
        /// The epoch.
        epoch: u64,
    },
    /// The snapshot leaf count is more than the committed leaf count.
    #[error("snapshot leaf count {requested} is more than the committed leaf count {committed}")]
    SnapshotAhead {
        /// Requested leaf count.
        requested: u32,
        /// Committed leaf count.
        committed: u32,
    },
    /// The store has staged updates. The operation needs a store without staged updates.
    #[error("the store has staged updates that are not committed")]
    StagedUpdates,
}

/// Root of the MMR at the end of one closed epoch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RootSnapshot {
    /// The closed epoch.
    pub epoch: u64,
    /// Leaf count at the end of the epoch.
    pub leaf_count: u32,
    /// Root of the MMR with `leaf_count` leaves.
    pub root: FieldElement,
}

/// Open a SQLite database file with the settings of the services.
///
/// Settings: create the file if it does not exist, WAL journal mode, `synchronous = FULL`,
/// foreign keys on, and a busy timeout of 5 seconds.
pub async fn connect(path: &Path) -> Result<SqlitePool, sqlx::Error> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Full)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5));
    SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await
}

/// Open a private in-memory database. For tests. The pool has one connection, so that all
/// queries see the same database.
pub async fn connect_in_memory() -> Result<SqlitePool, sqlx::Error> {
    let options = SqliteConnectOptions::new()
        .in_memory(true)
        .foreign_keys(true);
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
}

/// Make the MMR tables if they do not exist.
pub async fn migrate(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS mmr_leaves (
            leaf_index INTEGER PRIMARY KEY CHECK (leaf_index >= 0),
            leaf BLOB NOT NULL CHECK (length(leaf) = 32)
        ) STRICT",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS mmr_nodes (
            height INTEGER NOT NULL CHECK (height >= 0 AND height < 32),
            node_index INTEGER NOT NULL CHECK (node_index >= 0),
            hash BLOB NOT NULL CHECK (length(hash) = 32),
            PRIMARY KEY (height, node_index)
        ) STRICT, WITHOUT ROWID",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS mmr_root_snapshots (
            epoch INTEGER PRIMARY KEY CHECK (epoch >= 0),
            leaf_count INTEGER NOT NULL CHECK (leaf_count >= 0),
            root BLOB NOT NULL CHECK (length(root) = 32)
        ) STRICT",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS mmr_root_snapshots_root ON mmr_root_snapshots (root)")
        .execute(&mut *conn)
        .await?;
    Ok(())
}

fn to_i64(value: u64) -> Result<i64, SqliteStoreError> {
    i64::try_from(value).map_err(|_| SqliteStoreError::OutOfRange(value))
}

fn to_u32(value: i64, what: &str) -> Result<u32, SqliteStoreError> {
    u32::try_from(value)
        .map_err(|_| SqliteStoreError::Corrupt(format!("{what} {value} is not a u32")))
}

fn to_u64(value: i64, what: &str) -> Result<u64, SqliteStoreError> {
    u64::try_from(value)
        .map_err(|_| SqliteStoreError::Corrupt(format!("{what} {value} is not a u64")))
}

fn decode_field(bytes: &[u8], what: &str) -> Result<FieldElement, SqliteStoreError> {
    let array: [u8; FIELD_BYTES] = bytes
        .try_into()
        .map_err(|_| SqliteStoreError::Corrupt(format!("{what} does not have 32 bytes")))?;
    FieldElement::from_bytes_be(&array)
        .map_err(|_| SqliteStoreError::Corrupt(format!("{what} is not a canonical field element")))
}

/// MMR store that persists to SQLite. See the module documentation for the write steps.
#[derive(Debug, Clone)]
pub struct SqliteStore {
    memory: MemoryStore,
    committed_leaves: u32,
    staged: Vec<AppendUpdate>,
}

impl SqliteStore {
    /// Make the tables if necessary, then load all leaves and nodes.
    ///
    /// The load checks the structure: the leaf indices are `0..n`, and height `h` has exactly
    /// the nodes `0..(n >> h)`. It does not calculate the hashes again; see
    /// [`SqliteStore::check_hashes`].
    pub async fn open(conn: &mut SqliteConnection) -> Result<Self, SqliteStoreError> {
        migrate(conn).await?;
        let leaf_rows = sqlx::query("SELECT leaf_index, leaf FROM mmr_leaves ORDER BY leaf_index")
            .fetch_all(&mut *conn)
            .await?;
        let mut leaves = Vec::with_capacity(leaf_rows.len());
        for (position, row) in leaf_rows.iter().enumerate() {
            let index: i64 = row.try_get("leaf_index")?;
            if usize::try_from(index).ok() != Some(position) {
                return Err(SqliteStoreError::Corrupt(format!(
                    "leaf index {index} is at position {position}"
                )));
            }
            let bytes: Vec<u8> = row.try_get("leaf")?;
            leaves.push(decode_field(&bytes, "leaf")?);
        }
        let leaf_count = u32::try_from(leaves.len())
            .map_err(|_| SqliteStoreError::Corrupt("too many leaves".to_owned()))?;

        let node_rows = sqlx::query(
            "SELECT height, node_index, hash FROM mmr_nodes ORDER BY height, node_index",
        )
        .fetch_all(&mut *conn)
        .await?;
        let mut levels: Vec<Vec<FieldElement>> = vec![Vec::new(); NODE_HEIGHTS];
        for row in &node_rows {
            let height = to_u32(row.try_get("height")?, "node height")?;
            let index = to_u32(row.try_get("node_index")?, "node index")?;
            let bytes: Vec<u8> = row.try_get("hash")?;
            let level = levels
                .get_mut(height as usize)
                .ok_or_else(|| SqliteStoreError::Corrupt(format!("node height {height}")))?;
            if usize::try_from(index).ok() != Some(level.len()) {
                return Err(SqliteStoreError::Corrupt(format!(
                    "node {index} at height {height} is not the next node"
                )));
            }
            level.push(decode_field(&bytes, "node hash")?);
        }
        for (height, level) in levels.iter().enumerate() {
            let expected = (u64::from(leaf_count) >> height) as usize;
            if level.len() != expected {
                return Err(SqliteStoreError::Corrupt(format!(
                    "height {height} has {} nodes, expected {expected}",
                    level.len()
                )));
            }
        }

        // Replay the appends in order. Leaf i writes the node (h, ((i + 1) >> h) - 1) for each
        // height h where the low h bits of i + 1 are zero.
        let mut memory = MemoryStore::new();
        for (index, leaf) in leaves.iter().enumerate() {
            let leaf_index = u32::try_from(index)
                .map_err(|_| SqliteStoreError::Corrupt("too many leaves".to_owned()))?;
            let next = u64::from(leaf_index) + 1;
            let mut nodes = Vec::new();
            for height in 0..NODE_HEIGHTS {
                if height > 0 && next & ((1u64 << height) - 1) != 0 {
                    break;
                }
                let node_index = (next >> height) - 1;
                let hash = levels
                    .get(height)
                    .and_then(|level| level.get(node_index as usize))
                    .copied()
                    .ok_or_else(|| {
                        SqliteStoreError::Corrupt(format!(
                            "missing node {node_index} at height {height}"
                        ))
                    })?;
                nodes.push(NodeWrite {
                    height: u8::try_from(height).unwrap_or(u8::MAX),
                    index: u32::try_from(node_index).unwrap_or(u32::MAX),
                    hash,
                });
            }
            memory.append(&AppendUpdate {
                leaf_index,
                leaf: *leaf,
                nodes,
            })?;
        }
        Ok(Self {
            memory,
            committed_leaves: leaf_count,
            staged: Vec::new(),
        })
    }

    /// Leaf count in the database. Staged updates are not counted.
    pub fn committed_leaf_count(&self) -> u32 {
        self.committed_leaves
    }

    /// Tell if the store has staged updates.
    pub fn has_staged(&self) -> bool {
        !self.staged.is_empty()
    }

    /// Write all staged updates in the transaction of the caller. This does not commit.
    pub async fn write_staged(&self, conn: &mut SqliteConnection) -> Result<(), SqliteStoreError> {
        for update in &self.staged {
            sqlx::query("INSERT INTO mmr_leaves (leaf_index, leaf) VALUES (?, ?)")
                .bind(i64::from(update.leaf_index))
                .bind(update.leaf.to_bytes_be().to_vec())
                .execute(&mut *conn)
                .await?;
            for node in &update.nodes {
                sqlx::query("INSERT INTO mmr_nodes (height, node_index, hash) VALUES (?, ?, ?)")
                    .bind(i64::from(node.height))
                    .bind(i64::from(node.index))
                    .bind(node.hash.to_bytes_be().to_vec())
                    .execute(&mut *conn)
                    .await?;
            }
        }
        Ok(())
    }

    /// Mark the staged updates as committed. Call this only after the transaction that
    /// [`SqliteStore::write_staged`] used has committed.
    pub fn commit_staged(&mut self) {
        self.committed_leaves = self.memory.leaf_count().unwrap_or(self.committed_leaves);
        self.staged.clear();
    }

    /// Remove the staged updates from the memory copy. Call this if the transaction failed.
    pub fn discard_staged(&mut self) {
        self.memory.truncate(self.committed_leaves);
        self.staged.clear();
    }

    /// Calculate every node hash again from the leaves and compare. Return the first
    /// difference as [`SqliteStoreError::Corrupt`].
    pub fn check_hashes(&self) -> Result<(), SqliteStoreError> {
        let mut reference = Mmr::new(MemoryStore::new());
        let count = self.memory.leaf_count()?;
        for index in 0..count {
            let leaf = self
                .memory
                .leaf(index)?
                .ok_or_else(|| SqliteStoreError::Corrupt(format!("missing leaf {index}")))?;
            reference
                .append(leaf)
                .map_err(|e| SqliteStoreError::Corrupt(e.to_string()))?;
        }
        for height in 0..NODE_HEIGHTS {
            let height = u8::try_from(height).unwrap_or(u8::MAX);
            let nodes = count >> height;
            for index in 0..nodes {
                if reference.store().node(height, index)? != self.memory.node(height, index)? {
                    return Err(SqliteStoreError::Corrupt(format!(
                        "node {index} at height {height} has a wrong hash"
                    )));
                }
            }
        }
        Ok(())
    }

    /// Record the root snapshot of a closed epoch in the transaction of the caller.
    ///
    /// The leaf count must not be more than the committed leaf count. If the epoch already
    /// has the same snapshot, this does nothing. If it has a different snapshot, this fails.
    pub async fn record_snapshot(
        &self,
        conn: &mut SqliteConnection,
        snapshot: &RootSnapshot,
    ) -> Result<(), SqliteStoreError> {
        if snapshot.leaf_count > self.committed_leaves {
            return Err(SqliteStoreError::SnapshotAhead {
                requested: snapshot.leaf_count,
                committed: self.committed_leaves,
            });
        }
        match snapshot_at(conn, snapshot.epoch).await? {
            Some(existing) if existing == *snapshot => Ok(()),
            Some(_) => Err(SqliteStoreError::SnapshotConflict {
                epoch: snapshot.epoch,
            }),
            None => {
                sqlx::query(
                    "INSERT INTO mmr_root_snapshots (epoch, leaf_count, root) VALUES (?, ?, ?)",
                )
                .bind(to_i64(snapshot.epoch)?)
                .bind(i64::from(snapshot.leaf_count))
                .bind(snapshot.root.to_bytes_be().to_vec())
                .execute(&mut *conn)
                .await?;
                Ok(())
            }
        }
    }
}

impl Mmr<SqliteStore> {
    /// Append leaves in one transaction of their own. Return the index of the first leaf.
    ///
    /// Use this if no other rows go in the same transaction. Otherwise use the steps in the
    /// module documentation.
    pub async fn append_durable(
        &mut self,
        pool: &SqlitePool,
        leaves: &[FieldElement],
    ) -> Result<u32, MmrError<SqliteStoreError>> {
        if self.store().has_staged() {
            return Err(MmrError::Store(SqliteStoreError::StagedUpdates));
        }
        let first = self.leaf_count()?;
        match self.append_in_transaction(pool, leaves).await {
            Ok(()) => {
                self.store_mut().commit_staged();
                Ok(first)
            }
            Err(error) => {
                self.store_mut().discard_staged();
                Err(error)
            }
        }
    }

    async fn append_in_transaction(
        &mut self,
        pool: &SqlitePool,
        leaves: &[FieldElement],
    ) -> Result<(), MmrError<SqliteStoreError>> {
        for leaf in leaves {
            self.append(*leaf)?;
        }
        let store_error = |e: sqlx::Error| MmrError::Store(SqliteStoreError::Database(e));
        let mut tx = pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(store_error)?;
        self.store()
            .write_staged(&mut tx)
            .await
            .map_err(MmrError::Store)?;
        tx.commit().await.map_err(store_error)
    }
}

fn snapshot_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<RootSnapshot, SqliteStoreError> {
    let bytes: Vec<u8> = row.try_get("root")?;
    Ok(RootSnapshot {
        epoch: to_u64(row.try_get("epoch")?, "epoch")?,
        leaf_count: to_u32(row.try_get("leaf_count")?, "leaf count")?,
        root: decode_field(&bytes, "root")?,
    })
}

/// Root snapshot of `epoch`, if it exists.
pub async fn snapshot_at(
    conn: &mut SqliteConnection,
    epoch: u64,
) -> Result<Option<RootSnapshot>, SqliteStoreError> {
    let row = sqlx::query("SELECT epoch, leaf_count, root FROM mmr_root_snapshots WHERE epoch = ?")
        .bind(to_i64(epoch)?)
        .fetch_optional(&mut *conn)
        .await?;
    row.as_ref().map(snapshot_from_row).transpose()
}

/// The earliest root snapshot with `root`, if one exists.
///
/// Many epochs can have the same root when no leaf was added. They all have the same leaf
/// count, because the root commits to the leaf count.
pub async fn snapshot_by_root(
    conn: &mut SqliteConnection,
    root: FieldElement,
) -> Result<Option<RootSnapshot>, SqliteStoreError> {
    let row = sqlx::query(
        "SELECT epoch, leaf_count, root FROM mmr_root_snapshots WHERE root = ? ORDER BY epoch LIMIT 1",
    )
    .bind(root.to_bytes_be().to_vec())
    .fetch_optional(&mut *conn)
    .await?;
    row.as_ref().map(snapshot_from_row).transpose()
}

/// The latest root snapshot, if one exists.
pub async fn latest_snapshot(
    conn: &mut SqliteConnection,
) -> Result<Option<RootSnapshot>, SqliteStoreError> {
    let row = sqlx::query(
        "SELECT epoch, leaf_count, root FROM mmr_root_snapshots ORDER BY epoch DESC LIMIT 1",
    )
    .fetch_optional(&mut *conn)
    .await?;
    row.as_ref().map(snapshot_from_row).transpose()
}

/// Up to `limit` root snapshots with `epoch >= from`, in ascending epoch order.
pub async fn snapshots_from(
    conn: &mut SqliteConnection,
    from: u64,
    limit: u32,
) -> Result<Vec<RootSnapshot>, SqliteStoreError> {
    let rows = sqlx::query(
        "SELECT epoch, leaf_count, root FROM mmr_root_snapshots WHERE epoch >= ? ORDER BY epoch LIMIT ?",
    )
    .bind(to_i64(from)?)
    .bind(i64::from(limit))
    .fetch_all(&mut *conn)
    .await?;
    rows.iter().map(snapshot_from_row).collect()
}

impl MmrStore for SqliteStore {
    type Error = SqliteStoreError;

    fn leaf_count(&self) -> Result<u32, Self::Error> {
        Ok(self.memory.leaf_count()?)
    }

    fn leaf(&self, index: u32) -> Result<Option<FieldElement>, Self::Error> {
        Ok(self.memory.leaf(index)?)
    }

    fn node(&self, height: u8, index: u32) -> Result<Option<FieldElement>, Self::Error> {
        Ok(self.memory.node(height, index)?)
    }

    /// Apply the update to the memory copy and stage it. See the module documentation.
    fn append(&mut self, update: &AppendUpdate) -> Result<(), Self::Error> {
        self.memory.append(update)?;
        self.staged.push(update.clone());
        Ok(())
    }
}

//! Tests of the SQLite MMR store: equivalence with the memory store, transactions, and restart.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use anon_credit_crypto::FieldElement;
use anon_credit_registry::sqlite::{
    self, RootSnapshot, latest_snapshot, snapshot_at, snapshot_by_root, snapshots_from,
};
use anon_credit_registry::{
    MemoryStore, Mmr, MmrError, SqliteStore, SqliteStoreError, verify_proof,
};
use sqlx::SqlitePool;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

fn leaf_value(i: u64) -> FieldElement {
    FieldElement::from_u64(7_919 * i + 3)
}

/// A unique database path in the temporary directory. The test removes it at the end.
struct TempDb(PathBuf);

impl TempDb {
    fn new(name: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "anon-credit-registry-{name}-{}-{n}-{nanos}.db",
            std::process::id()
        ));
        Self(path)
    }
}

impl Drop for TempDb {
    fn drop(&mut self) {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", self.0.display()));
        }
    }
}

async fn open(pool: &SqlitePool) -> Mmr<SqliteStore> {
    let mut conn = pool.acquire().await.unwrap();
    Mmr::new(SqliteStore::open(&mut conn).await.unwrap())
}

#[tokio::test]
async fn appends_and_proofs_equal_the_memory_store() {
    let pool = sqlite::connect_in_memory().await.unwrap();
    let mut db_mmr = open(&pool).await;
    let mut memory = Mmr::new(MemoryStore::new());
    let mut next = 0u64;
    // Chunks of different sizes: each chunk is one transaction.
    for chunk in [1usize, 2, 3, 5, 8, 13, 1, 1, 30] {
        let leaves: Vec<FieldElement> = (next..next + chunk as u64).map(leaf_value).collect();
        next += chunk as u64;
        let first = db_mmr.append_durable(&pool, &leaves).await.unwrap();
        for leaf in &leaves {
            memory.append(*leaf).unwrap();
        }
        assert_eq!(u64::from(first) + chunk as u64, next);
    }
    let count = memory.leaf_count().unwrap();
    assert_eq!(db_mmr.leaf_count().unwrap(), count);
    assert_eq!(db_mmr.store().committed_leaf_count(), count);
    for n in 0..=count {
        let root = db_mmr.root_at(n).unwrap();
        assert_eq!(root, memory.root_at(n).unwrap());
        assert_eq!(db_mmr.peaks_at(n).unwrap(), memory.peaks_at(n).unwrap());
        for i in 0..n {
            let proof = db_mmr.membership_proof_at(i, n).unwrap();
            assert_eq!(proof, memory.membership_proof_at(i, n).unwrap());
            assert!(verify_proof(root, &proof, leaf_value(u64::from(i))));
        }
    }
    db_mmr.store().check_hashes().unwrap();
}

#[tokio::test]
async fn restart_recovers_leaves_nodes_and_snapshots() {
    let db = TempDb::new("restart");
    let leaves: Vec<FieldElement> = (0..37).map(leaf_value).collect();
    let (root_before, proof_before) = {
        let pool = sqlite::connect(&db.0).await.unwrap();
        let mut mmr = open(&pool).await;
        mmr.append_durable(&pool, &leaves[..20]).await.unwrap();
        let mut conn = pool.acquire().await.unwrap();
        let snapshot = RootSnapshot {
            epoch: 100,
            leaf_count: 20,
            root: mmr.root_at(20).unwrap(),
        };
        mmr.store()
            .record_snapshot(&mut conn, &snapshot)
            .await
            .unwrap();
        drop(conn);
        mmr.append_durable(&pool, &leaves[20..]).await.unwrap();
        let result = (mmr.root().unwrap(), mmr.membership_proof_at(5, 20).unwrap());
        pool.close().await;
        result
    };

    let pool = sqlite::connect(&db.0).await.unwrap();
    let mmr = open(&pool).await;
    assert_eq!(mmr.leaf_count().unwrap(), 37);
    assert_eq!(mmr.root().unwrap(), root_before);
    assert_eq!(mmr.membership_proof_at(5, 20).unwrap(), proof_before);
    mmr.store().check_hashes().unwrap();
    let mut conn = pool.acquire().await.unwrap();
    let snapshot = snapshot_at(&mut conn, 100).await.unwrap().unwrap();
    assert_eq!(snapshot.leaf_count, 20);
    assert_eq!(snapshot.root, mmr.root_at(20).unwrap());
    assert!(verify_proof(snapshot.root, &proof_before, leaves[5]));
    let mut reference = Mmr::new(MemoryStore::new());
    for leaf in &leaves {
        reference.append(*leaf).unwrap();
    }
    assert_eq!(reference.root().unwrap(), root_before);
}

#[tokio::test]
async fn staged_appends_in_a_caller_transaction() {
    let pool = sqlite::connect_in_memory().await.unwrap();
    let mut mmr = open(&pool).await;
    mmr.append_durable(&pool, &[leaf_value(0), leaf_value(1)])
        .await
        .unwrap();
    let root_two = mmr.root().unwrap();

    // A transaction that rolls back: the staged appends must not stay.
    mmr.append(leaf_value(2)).unwrap();
    mmr.append(leaf_value(3)).unwrap();
    assert!(mmr.store().has_staged());
    {
        let mut tx = pool.begin().await.unwrap();
        mmr.store().write_staged(&mut tx).await.unwrap();
        tx.rollback().await.unwrap();
    }
    mmr.store_mut().discard_staged();
    assert_eq!(mmr.leaf_count().unwrap(), 2);
    assert_eq!(mmr.root().unwrap(), root_two);
    let reopened = open(&pool).await;
    assert_eq!(reopened.leaf_count().unwrap(), 2);

    // A transaction that commits.
    mmr.append(leaf_value(2)).unwrap();
    {
        let mut tx = pool.begin().await.unwrap();
        mmr.store().write_staged(&mut tx).await.unwrap();
        tx.commit().await.unwrap();
    }
    mmr.store_mut().commit_staged();
    assert_eq!(mmr.store().committed_leaf_count(), 3);
    let reopened = open(&pool).await;
    assert_eq!(reopened.root().unwrap(), mmr.root().unwrap());
}

#[tokio::test]
async fn append_durable_refuses_staged_updates() {
    let pool = sqlite::connect_in_memory().await.unwrap();
    let mut mmr = open(&pool).await;
    mmr.append(leaf_value(0)).unwrap();
    let result = mmr.append_durable(&pool, &[leaf_value(1)]).await;
    assert!(matches!(
        result,
        Err(MmrError::Store(SqliteStoreError::StagedUpdates))
    ));
}

#[tokio::test]
async fn snapshots_are_idempotent_and_reject_conflicts() {
    let pool = sqlite::connect_in_memory().await.unwrap();
    let mut mmr = open(&pool).await;
    mmr.append_durable(&pool, &[leaf_value(0), leaf_value(1), leaf_value(2)])
        .await
        .unwrap();
    let mut conn = pool.acquire().await.unwrap();
    let first = RootSnapshot {
        epoch: 7,
        leaf_count: 2,
        root: mmr.root_at(2).unwrap(),
    };
    mmr.store()
        .record_snapshot(&mut conn, &first)
        .await
        .unwrap();
    mmr.store()
        .record_snapshot(&mut conn, &first)
        .await
        .unwrap();
    let conflict = RootSnapshot {
        leaf_count: 3,
        root: mmr.root_at(3).unwrap(),
        ..first
    };
    assert!(matches!(
        mmr.store().record_snapshot(&mut conn, &conflict).await,
        Err(SqliteStoreError::SnapshotConflict { epoch: 7 })
    ));
    let ahead = RootSnapshot {
        epoch: 8,
        leaf_count: 4,
        root: first.root,
    };
    assert!(matches!(
        mmr.store().record_snapshot(&mut conn, &ahead).await,
        Err(SqliteStoreError::SnapshotAhead { .. })
    ));
    // Same root in a later epoch: the lookup by root gives the earliest epoch.
    let same = RootSnapshot { epoch: 9, ..first };
    mmr.store().record_snapshot(&mut conn, &same).await.unwrap();
    let last = RootSnapshot {
        epoch: 10,
        leaf_count: 3,
        root: mmr.root_at(3).unwrap(),
    };
    mmr.store().record_snapshot(&mut conn, &last).await.unwrap();

    assert_eq!(
        snapshot_by_root(&mut conn, first.root).await.unwrap(),
        Some(first)
    );
    assert_eq!(latest_snapshot(&mut conn).await.unwrap(), Some(last));
    assert_eq!(snapshot_at(&mut conn, 8).await.unwrap(), None);
    let listed = snapshots_from(&mut conn, 8, 10).await.unwrap();
    assert_eq!(listed, vec![same, last]);
    assert_eq!(snapshots_from(&mut conn, 0, 1).await.unwrap(), vec![first]);
}

#[tokio::test]
async fn open_rejects_a_missing_node() {
    let pool = sqlite::connect_in_memory().await.unwrap();
    let mut mmr = open(&pool).await;
    let leaves: Vec<FieldElement> = (0..8).map(leaf_value).collect();
    mmr.append_durable(&pool, &leaves).await.unwrap();
    sqlx::query("DELETE FROM mmr_nodes WHERE height = 2")
        .execute(&pool)
        .await
        .unwrap();
    let mut conn = pool.acquire().await.unwrap();
    assert!(matches!(
        SqliteStore::open(&mut conn).await,
        Err(SqliteStoreError::Corrupt(_))
    ));
}

#[tokio::test]
async fn check_hashes_finds_a_changed_node() {
    let pool = sqlite::connect_in_memory().await.unwrap();
    let mut mmr = open(&pool).await;
    let leaves: Vec<FieldElement> = (0..4).map(leaf_value).collect();
    mmr.append_durable(&pool, &leaves).await.unwrap();
    sqlx::query("UPDATE mmr_nodes SET hash = ? WHERE height = 1 AND node_index = 0")
        .bind(leaf_value(99).to_bytes_be().to_vec())
        .execute(&pool)
        .await
        .unwrap();
    let mut conn = pool.acquire().await.unwrap();
    let store = SqliteStore::open(&mut conn).await.unwrap();
    assert!(matches!(
        store.check_hashes(),
        Err(SqliteStoreError::Corrupt(_))
    ));
}

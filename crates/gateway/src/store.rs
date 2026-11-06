//! SQLite store of sessions, receipts, and the root cache.
//!
//! Rules (implementation.md section 11):
//!
//! - WAL journal mode and `synchronous = FULL`: a committed debit survives a crash.
//! - One gateway process owns the database.
//! - The debit, the next sequence number, the cumulative units, the request digest, the
//!   response bytes, and the receipt change in one transaction ([`Store::commit_spend`]).
//! - No transaction stays open while the gateway waits for the upstream.
//!
//! The schema is in `migrations/0001_gateway.sql`.

use anon_credit_protocol::Bytes32;
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteRow,
    SqliteSynchronous,
};
use sqlx::{Row, Sqlite, Transaction};
use std::path::Path;
use std::str::FromStr;
use std::time::Duration;

use crate::roots::RootRecord;

/// Failure of a store operation.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// The database returned an error.
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    /// The migration failed.
    #[error("database migration failed: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),
    /// A stored value is out of range or not canonical.
    #[error("stored value is not valid: {0}")]
    Corrupt(&'static str),
    /// A value does not fit the database integer type.
    #[error("value is too large for the database: {0}")]
    Range(&'static str),
    /// The session changed after the caller read it. The caller holds the batch lock, so
    /// this means that a second process writes the database.
    #[error("session row changed during the request")]
    Conflict,
}

/// Session life-cycle value in the `state` column.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoredState {
    /// The session has units.
    Active,
    /// The session has no units.
    Exhausted,
}

impl StoredState {
    fn as_str(self) -> &'static str {
        match self {
            StoredState::Active => "active",
            StoredState::Exhausted => "exhausted",
        }
    }

    fn parse(text: &str) -> Result<Self, StoreError> {
        match text {
            "active" => Ok(StoredState::Active),
            "exhausted" => Ok(StoredState::Exhausted),
            _ => Err(StoreError::Corrupt("session state")),
        }
    }

    /// The state for `remaining` units.
    pub fn for_remaining(remaining: u32) -> Self {
        match remaining {
            0 => StoredState::Exhausted,
            _ => StoredState::Active,
        }
    }
}

/// One session row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRow {
    /// Public batch ID.
    pub batch_id: Bytes32,
    /// Session Ed25519 public key.
    pub session_pub: Bytes32,
    /// Units that remain.
    pub remaining: u32,
    /// Cumulative units charged.
    pub units_total: u64,
    /// Next sequence number.
    pub next_seq: u64,
    /// Epoch of the open.
    pub open_epoch: u64,
    /// Last epoch in which the session can spend.
    pub deadline_epoch: u64,
    /// keccak256 of the open signing message.
    pub open_request_digest: Bytes32,
    /// The open request without the proof bytes.
    pub open_request_json: String,
    /// Price table hash frozen at open.
    pub price_table_hash: Bytes32,
    /// Proof size in bytes.
    pub proof_size: u32,
    /// Proof verification time in milliseconds.
    pub verify_ms: u32,
    /// Stored life-cycle state.
    pub state: StoredState,
    /// Open time in Unix seconds.
    pub opened_at: u64,
}

/// One receipt row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceiptRow {
    /// Public batch ID.
    pub batch_id: Bytes32,
    /// Sequence number.
    pub seq: u64,
    /// Digest of the spend message.
    pub request_digest: Bytes32,
    /// JSON-RPC method name.
    pub method: String,
    /// Units charged.
    pub units: u32,
    /// Cumulative units after this receipt.
    pub units_total: u64,
    /// Response bytes, or `None` after the retention time.
    pub response_bytes: Option<Vec<u8>>,
    /// Commit time in Unix seconds.
    pub committed_at: u64,
}

/// One debit to commit.
#[derive(Debug, Clone, Copy)]
pub struct SpendCommit<'a> {
    /// Public batch ID.
    pub batch_id: &'a Bytes32,
    /// Sequence number. It must equal the stored `next_seq`.
    pub seq: u64,
    /// Units to charge.
    pub units: u32,
    /// Cumulative units after the debit.
    pub units_total: u64,
    /// Digest of the spend message.
    pub request_digest: &'a Bytes32,
    /// JSON-RPC method name.
    pub method: &'a str,
    /// Upstream response bytes.
    pub response: &'a [u8],
    /// Commit time in Unix seconds.
    pub now_unix: u64,
}

/// Result of a session insert.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InsertOutcome {
    /// The row is new.
    Inserted,
    /// A row with the batch ID already exists. Nothing changed.
    AlreadyExists,
}

/// Counts of sessions by state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SessionCounts {
    /// Sessions with units before their deadline.
    pub active: u64,
    /// Sessions with no units.
    pub exhausted: u64,
    /// Sessions after their deadline.
    pub expired: u64,
    /// Units charged in all retained sessions.
    pub units_charged: u64,
}

/// The gateway database.
#[derive(Debug, Clone)]
pub struct Store {
    pool: SqlitePool,
}

fn to_i64(value: u64, what: &'static str) -> Result<i64, StoreError> {
    i64::try_from(value).map_err(|_| StoreError::Range(what))
}

fn get_u64(row: &SqliteRow, column: &'static str) -> Result<u64, StoreError> {
    let value: i64 = row.try_get(column)?;
    u64::try_from(value).map_err(|_| StoreError::Corrupt(column))
}

fn get_u32(row: &SqliteRow, column: &'static str) -> Result<u32, StoreError> {
    let value: i64 = row.try_get(column)?;
    u32::try_from(value).map_err(|_| StoreError::Corrupt(column))
}

fn get_bytes32(row: &SqliteRow, column: &'static str) -> Result<Bytes32, StoreError> {
    let text: String = row.try_get(column)?;
    Bytes32::from_hex(&text).map_err(|_| StoreError::Corrupt(column))
}

fn session_from_row(row: &SqliteRow) -> Result<SessionRow, StoreError> {
    let state: String = row.try_get("state")?;
    Ok(SessionRow {
        batch_id: get_bytes32(row, "batch_id")?,
        session_pub: get_bytes32(row, "session_pub")?,
        remaining: get_u32(row, "remaining")?,
        units_total: get_u64(row, "units_total")?,
        next_seq: get_u64(row, "next_seq")?,
        open_epoch: get_u64(row, "open_epoch")?,
        deadline_epoch: get_u64(row, "deadline_epoch")?,
        open_request_digest: get_bytes32(row, "open_request_digest")?,
        open_request_json: row.try_get("open_request_json")?,
        price_table_hash: get_bytes32(row, "price_table_hash")?,
        proof_size: get_u32(row, "proof_size")?,
        verify_ms: get_u32(row, "verify_ms")?,
        state: StoredState::parse(&state)?,
        opened_at: get_u64(row, "opened_at")?,
    })
}

fn receipt_from_row(row: &SqliteRow) -> Result<ReceiptRow, StoreError> {
    Ok(ReceiptRow {
        batch_id: get_bytes32(row, "batch_id")?,
        seq: get_u64(row, "seq")?,
        request_digest: get_bytes32(row, "request_digest")?,
        method: row.try_get("method")?,
        units: get_u32(row, "units")?,
        units_total: get_u64(row, "units_total")?,
        response_bytes: row.try_get("response_bytes")?,
        committed_at: get_u64(row, "committed_at")?,
    })
}

const SESSION_COLUMNS: &str = "batch_id, session_pub, remaining, units_total, next_seq, \
     open_epoch, deadline_epoch, open_request_digest, open_request_json, price_table_hash, \
     proof_size, verify_ms, state, opened_at";

const RECEIPT_COLUMNS: &str =
    "batch_id, seq, request_digest, method, units, units_total, response_bytes, committed_at";

impl Store {
    /// Open (or make) the database file and apply the migrations.
    pub async fn open(path: &Path) -> Result<Self, StoreError> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent).map_err(|e| StoreError::Database(e.into()))?;
        }
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Full)
            .foreign_keys(true)
            .busy_timeout(Duration::from_secs(5));
        Self::connect(options).await
    }

    /// Connect with explicit options and apply the migrations.
    pub async fn connect(options: SqliteConnectOptions) -> Result<Self, StoreError> {
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await?;
        sqlx::migrate!("./migrations").run(&pool).await?;
        Ok(Self { pool })
    }

    /// Open an in-memory database. Only for tests.
    pub async fn open_in_memory() -> Result<Self, StoreError> {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")?.foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await?;
        sqlx::migrate!("./migrations").run(&pool).await?;
        Ok(Self { pool })
    }

    /// The connection pool. Tests use it to inject faults.
    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    /// Close the pool.
    pub async fn close(&self) {
        self.pool.close().await;
    }

    /// Read one session.
    pub async fn session(&self, batch_id: &Bytes32) -> Result<Option<SessionRow>, StoreError> {
        let sql = format!("SELECT {SESSION_COLUMNS} FROM sessions WHERE batch_id = ?1");
        let row = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(batch_id.to_hex())
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(session_from_row).transpose()
    }

    /// Insert a new session. A row with the same batch ID stays unchanged.
    pub async fn insert_session(&self, row: &SessionRow) -> Result<InsertOutcome, StoreError> {
        let result = sqlx::query(
            "INSERT INTO sessions (batch_id, session_pub, remaining, units_total, next_seq, \
             open_epoch, deadline_epoch, open_request_digest, open_request_json, \
             price_table_hash, proof_size, verify_ms, state, opened_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14) \
             ON CONFLICT (batch_id) DO NOTHING",
        )
        .bind(row.batch_id.to_hex())
        .bind(row.session_pub.to_hex())
        .bind(i64::from(row.remaining))
        .bind(to_i64(row.units_total, "units_total")?)
        .bind(to_i64(row.next_seq, "next_seq")?)
        .bind(to_i64(row.open_epoch, "open_epoch")?)
        .bind(to_i64(row.deadline_epoch, "deadline_epoch")?)
        .bind(row.open_request_digest.to_hex())
        .bind(&row.open_request_json)
        .bind(row.price_table_hash.to_hex())
        .bind(i64::from(row.proof_size))
        .bind(i64::from(row.verify_ms))
        .bind(row.state.as_str())
        .bind(to_i64(row.opened_at, "opened_at")?)
        .execute(&self.pool)
        .await?;
        match result.rows_affected() {
            0 => Ok(InsertOutcome::AlreadyExists),
            _ => Ok(InsertOutcome::Inserted),
        }
    }

    /// Read one receipt.
    pub async fn receipt(
        &self,
        batch_id: &Bytes32,
        seq: u64,
    ) -> Result<Option<ReceiptRow>, StoreError> {
        let sql =
            format!("SELECT {RECEIPT_COLUMNS} FROM receipts WHERE batch_id = ?1 AND seq = ?2");
        let row = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(batch_id.to_hex())
            .bind(to_i64(seq, "seq")?)
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(receipt_from_row).transpose()
    }

    /// Read the newest receipts of a session, newest first.
    pub async fn receipts(
        &self,
        batch_id: &Bytes32,
        limit: u32,
    ) -> Result<Vec<ReceiptRow>, StoreError> {
        let sql = format!(
            "SELECT {RECEIPT_COLUMNS} FROM receipts WHERE batch_id = ?1 ORDER BY seq DESC LIMIT ?2"
        );
        let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(batch_id.to_hex())
            .bind(i64::from(limit))
            .fetch_all(&self.pool)
            .await?;
        rows.iter().map(receipt_from_row).collect()
    }

    /// Commit one debit, its receipt, and its response bytes in one transaction.
    ///
    /// The update applies only if `next_seq` still equals `commit.seq` and the session has
    /// enough units. Otherwise nothing changes and the result is [`StoreError::Conflict`].
    /// Return the session row after the commit.
    pub async fn commit_spend(&self, commit: SpendCommit<'_>) -> Result<SessionRow, StoreError> {
        let mut tx: Transaction<'_, Sqlite> = self.pool.begin().await?;
        let updated = sqlx::query(
            "UPDATE sessions SET remaining = remaining - ?1, units_total = ?2, \
             next_seq = next_seq + 1, \
             state = CASE WHEN remaining - ?1 = 0 THEN 'exhausted' ELSE 'active' END \
             WHERE batch_id = ?3 AND next_seq = ?4 AND remaining >= ?1",
        )
        .bind(i64::from(commit.units))
        .bind(to_i64(commit.units_total, "units_total")?)
        .bind(commit.batch_id.to_hex())
        .bind(to_i64(commit.seq, "seq")?)
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() != 1 {
            tx.rollback().await?;
            return Err(StoreError::Conflict);
        }
        sqlx::query(
            "INSERT INTO receipts (batch_id, seq, request_digest, method, units, units_total, \
             response_bytes, committed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )
        .bind(commit.batch_id.to_hex())
        .bind(to_i64(commit.seq, "seq")?)
        .bind(commit.request_digest.to_hex())
        .bind(commit.method)
        .bind(i64::from(commit.units))
        .bind(to_i64(commit.units_total, "units_total")?)
        .bind(commit.response)
        .bind(to_i64(commit.now_unix, "committed_at")?)
        .execute(&mut *tx)
        .await?;
        let sql = format!("SELECT {SESSION_COLUMNS} FROM sessions WHERE batch_id = ?1");
        let row = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(commit.batch_id.to_hex())
            .fetch_one(&mut *tx)
            .await?;
        let session = session_from_row(&row)?;
        tx.commit().await?;
        Ok(session)
    }

    /// Remove response bytes committed at or before `cutoff_unix`. Return the count.
    pub async fn prune_responses(&self, cutoff_unix: u64) -> Result<u64, StoreError> {
        let result = sqlx::query(
            "UPDATE receipts SET response_bytes = NULL \
             WHERE response_bytes IS NOT NULL AND committed_at <= ?1",
        )
        .bind(to_i64(cutoff_unix, "cutoff")?)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
    }

    /// Delete sessions (and their receipts) whose retention ended before `current_epoch`.
    ///
    /// A row is kept through `deadline_epoch + 1` (see [`crate::epoch::retain_through`]).
    pub async fn prune_sessions(&self, current_epoch: u64) -> Result<u64, StoreError> {
        // deadline_epoch + grace < current  <=>  deadline_epoch < current - grace.
        let bound = current_epoch.saturating_sub(crate::epoch::PROOF_EPOCH_GRACE);
        let result = sqlx::query("DELETE FROM sessions WHERE deadline_epoch < ?1")
            .bind(to_i64(bound, "epoch")?)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected())
    }

    /// The most recently opened sessions, newest first.
    pub async fn recent_sessions(&self, limit: u32) -> Result<Vec<SessionRow>, StoreError> {
        let sql = format!(
            "SELECT {SESSION_COLUMNS} FROM sessions ORDER BY opened_at DESC, batch_id LIMIT ?1"
        );
        let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(i64::from(limit))
            .fetch_all(&self.pool)
            .await?;
        rows.iter().map(session_from_row).collect()
    }

    /// Session counts at `current_epoch`.
    pub async fn session_counts(&self, current_epoch: u64) -> Result<SessionCounts, StoreError> {
        let row = sqlx::query(
            "SELECT \
             COALESCE(SUM(CASE WHEN deadline_epoch >= ?1 AND state = 'active' THEN 1 ELSE 0 END), 0) AS active, \
             COALESCE(SUM(CASE WHEN deadline_epoch >= ?1 AND state = 'exhausted' THEN 1 ELSE 0 END), 0) AS exhausted, \
             COALESCE(SUM(CASE WHEN deadline_epoch < ?1 THEN 1 ELSE 0 END), 0) AS expired, \
             COALESCE(SUM(units_total), 0) AS units \
             FROM sessions",
        )
        .bind(to_i64(current_epoch, "epoch")?)
        .fetch_one(&self.pool)
        .await?;
        Ok(SessionCounts {
            active: get_u64(&row, "active")?,
            exhausted: get_u64(&row, "exhausted")?,
            expired: get_u64(&row, "expired")?,
            units_charged: get_u64(&row, "units")?,
        })
    }

    /// Write roots to the cache. An existing epoch stays unchanged.
    pub async fn save_roots(&self, roots: &[RootRecord], now_unix: u64) -> Result<(), StoreError> {
        let mut tx = self.pool.begin().await?;
        for record in roots {
            sqlx::query(
                "INSERT INTO roots (source_epoch, root, leaf_count, fetched_at) \
                 VALUES (?1, ?2, ?3, ?4) ON CONFLICT (source_epoch) DO NOTHING",
            )
            .bind(to_i64(record.source_epoch, "source_epoch")?)
            .bind(record.root.to_hex())
            .bind(i64::from(record.leaf_count))
            .bind(to_i64(now_unix, "fetched_at")?)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// Read the cached roots with a source epoch of at least `from_epoch`.
    pub async fn cached_roots(&self, from_epoch: u64) -> Result<Vec<RootRecord>, StoreError> {
        let rows = sqlx::query(
            "SELECT source_epoch, root, leaf_count FROM roots WHERE source_epoch >= ?1 \
             ORDER BY source_epoch",
        )
        .bind(to_i64(from_epoch, "epoch")?)
        .fetch_all(&self.pool)
        .await?;
        rows.iter()
            .map(|row| {
                Ok(RootRecord {
                    source_epoch: get_u64(row, "source_epoch")?,
                    root: get_bytes32(row, "root")?,
                    leaf_count: get_u32(row, "leaf_count")?,
                })
            })
            .collect()
    }

    /// Delete cached roots with a source epoch below `from_epoch`.
    pub async fn prune_roots(&self, from_epoch: u64) -> Result<u64, StoreError> {
        let result = sqlx::query("DELETE FROM roots WHERE source_epoch < ?1")
            .bind(to_i64(from_epoch, "epoch")?)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected())
    }
}

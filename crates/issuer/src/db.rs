//! Issuer database schema and queries.
//!
//! The issuer database is one SQLite file. It has the MMR tables of
//! `anon_credit_registry::sqlite` and these tables:
//!
//! | Table | Key | Contents |
//! |---|---|---|
//! | `issuer_meta` | `key` | `deployment_id`. The service refuses a database of a different deployment. |
//! | `payments` | `(chain_id, tx_hash, log_index)` | One issued payment: event values, block, insertion epoch, expiry, first leaf. |
//! | `issued_leaves` | `leaf_index` | The payment, the commitment, and the insertion epoch of each leaf. |
//! | `topup_tracking` | `(chain_id, tx_hash, log_index)` | Payments that a client registered and that are not issued: pending or rejected. |
//! | `root_publications` | `epoch` | One publication of a root snapshot: state, signed transaction, receipt block. |
//! | `indexer_state` | `id = 1` | The next block that the sale indexer reads. |
//!
//! A payment row, its `issued_leaves` rows, and the MMR rows of its leaves are written in one
//! transaction. Thus a payment is issued completely or not at all.

use crate::verify::PaymentKey;
use alloy::primitives::{Address as ChainAddress, B256};
use anon_credit_crypto::FieldElement;
use anon_credit_protocol::hex_bytes::{Address, Bytes32};
use anon_credit_protocol::issuer_api::{
    Issuance, IssuedLeaf, IssuerRootRecord, LeafAppendedEvent, PendingReason, PublicationStatus,
    RejectReason, RootUpdatedEvent,
};
use anon_credit_protocol::wire::DecimalU64;
use sqlx::sqlite::SqliteRow;
use sqlx::{Row, SqliteConnection};

/// Failure of an issuer database operation.
#[derive(Debug, thiserror::Error)]
pub enum DbError {
    /// SQLite failed.
    #[error("database failure: {0}")]
    Sqlx(#[from] sqlx::Error),
    /// The MMR store failed.
    #[error("mmr store failure: {0}")]
    Store(#[from] anon_credit_registry::SqliteStoreError),
    /// A stored value does not have the expected form.
    #[error("stored data is corrupt: {0}")]
    Corrupt(String),
    /// A value does not fit a SQLite integer.
    #[error("value {0} does not fit a SQLite integer")]
    OutOfRange(u64),
    /// The database belongs to a different deployment.
    #[error("database deployment_id {found} is not the configured deployment_id {expected}")]
    WrongDeployment {
        /// Deployment ID in the database.
        found: String,
        /// Configured deployment ID.
        expected: String,
    },
}

/// Convert a `u64` to a SQLite integer.
pub fn sql_int(value: u64) -> Result<i64, DbError> {
    i64::try_from(value).map_err(|_| DbError::OutOfRange(value))
}

fn get_u64(row: &SqliteRow, column: &str) -> Result<u64, DbError> {
    let value: i64 = row.try_get(column)?;
    u64::try_from(value).map_err(|_| DbError::Corrupt(format!("{column} is negative")))
}

fn get_opt_u64(row: &SqliteRow, column: &str) -> Result<Option<u64>, DbError> {
    let value: Option<i64> = row.try_get(column)?;
    value
        .map(|v| u64::try_from(v).map_err(|_| DbError::Corrupt(format!("{column} is negative"))))
        .transpose()
}

fn get_u32(row: &SqliteRow, column: &str) -> Result<u32, DbError> {
    let value: i64 = row.try_get(column)?;
    u32::try_from(value).map_err(|_| DbError::Corrupt(format!("{column} is not a u32")))
}

fn get_bytes<const N: usize>(row: &SqliteRow, column: &str) -> Result<[u8; N], DbError> {
    let value: Vec<u8> = row.try_get(column)?;
    value
        .try_into()
        .map_err(|_| DbError::Corrupt(format!("{column} does not have {N} bytes")))
}

fn get_field(row: &SqliteRow, column: &str) -> Result<FieldElement, DbError> {
    FieldElement::from_bytes_be(&get_bytes::<32>(row, column)?)
        .map_err(|_| DbError::Corrupt(format!("{column} is not a field element")))
}

fn get_decimal(row: &SqliteRow, column: &str) -> Result<u64, DbError> {
    let text: String = row.try_get(column)?;
    text.parse::<u64>()
        .map_err(|_| DbError::Corrupt(format!("{column} is not a decimal u64")))
}

/// Make the issuer and MMR tables if they do not exist.
pub async fn migrate(conn: &mut SqliteConnection) -> Result<(), DbError> {
    anon_credit_registry::sqlite::migrate(conn).await?;
    let statements: [&'static str; 9] = [
        "CREATE TABLE IF NOT EXISTS issuer_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        ) STRICT",
        "CREATE TABLE IF NOT EXISTS payments (
            chain_id INTEGER NOT NULL,
            tx_hash BLOB NOT NULL CHECK (length(tx_hash) = 32),
            log_index INTEGER NOT NULL CHECK (log_index >= 0),
            block_number INTEGER NOT NULL,
            block_hash BLOB NOT NULL CHECK (length(block_hash) = 32),
            payer BLOB NOT NULL CHECK (length(payer) = 20),
            purchase_id TEXT NOT NULL,
            amount_wei TEXT NOT NULL,
            batch_count INTEGER NOT NULL CHECK (batch_count > 0),
            first_leaf_index INTEGER NOT NULL,
            insertion_epoch INTEGER NOT NULL,
            expiry INTEGER NOT NULL,
            issued_at INTEGER NOT NULL,
            PRIMARY KEY (chain_id, tx_hash, log_index)
        ) STRICT",
        "CREATE TABLE IF NOT EXISTS issued_leaves (
            leaf_index INTEGER PRIMARY KEY REFERENCES mmr_leaves (leaf_index),
            chain_id INTEGER NOT NULL,
            tx_hash BLOB NOT NULL,
            log_index INTEGER NOT NULL,
            position INTEGER NOT NULL,
            commitment BLOB NOT NULL CHECK (length(commitment) = 32),
            insertion_epoch INTEGER NOT NULL,
            FOREIGN KEY (chain_id, tx_hash, log_index)
                REFERENCES payments (chain_id, tx_hash, log_index)
        ) STRICT",
        "CREATE INDEX IF NOT EXISTS issued_leaves_payment
            ON issued_leaves (chain_id, tx_hash, log_index, position)",
        "CREATE INDEX IF NOT EXISTS issued_leaves_epoch ON issued_leaves (insertion_epoch)",
        "CREATE TABLE IF NOT EXISTS topup_tracking (
            chain_id INTEGER NOT NULL,
            tx_hash BLOB NOT NULL CHECK (length(tx_hash) = 32),
            log_index INTEGER NOT NULL CHECK (log_index >= 0),
            status TEXT NOT NULL CHECK (status IN ('pending', 'rejected')),
            reason TEXT NOT NULL,
            block_number INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (chain_id, tx_hash, log_index)
        ) STRICT",
        "CREATE TABLE IF NOT EXISTS root_publications (
            epoch INTEGER PRIMARY KEY REFERENCES mmr_root_snapshots (epoch),
            leaf_count INTEGER NOT NULL,
            root BLOB NOT NULL CHECK (length(root) = 32),
            status TEXT NOT NULL CHECK (status IN
                ('pending', 'submitted', 'included', 'finalized', 'skipped', 'failed')),
            tx_hash BLOB CHECK (tx_hash IS NULL OR length(tx_hash) = 32),
            raw_tx BLOB,
            nonce INTEGER,
            block_number INTEGER,
            note TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        ) STRICT",
        "CREATE INDEX IF NOT EXISTS root_publications_status ON root_publications (status, epoch)",
        "CREATE TABLE IF NOT EXISTS indexer_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            next_block INTEGER NOT NULL
        ) STRICT",
    ];
    for statement in statements {
        sqlx::query(statement).execute(&mut *conn).await?;
    }
    Ok(())
}

/// Record the deployment ID in a new database, or check it in an existing database.
pub async fn bind_deployment(
    conn: &mut SqliteConnection,
    deployment_id: &str,
) -> Result<(), DbError> {
    let found: Option<String> =
        sqlx::query_scalar("SELECT value FROM issuer_meta WHERE key = 'deployment_id'")
            .fetch_optional(&mut *conn)
            .await?;
    match found {
        Some(value) if value == deployment_id => Ok(()),
        Some(value) => Err(DbError::WrongDeployment {
            found: value,
            expected: deployment_id.to_owned(),
        }),
        None => {
            sqlx::query("INSERT INTO issuer_meta (key, value) VALUES ('deployment_id', ?)")
                .bind(deployment_id)
                .execute(&mut *conn)
                .await?;
            Ok(())
        }
    }
}

/// Values of a new payment row.
#[derive(Debug, Clone)]
pub struct NewPayment<'a> {
    /// Payment key.
    pub key: &'a PaymentKey,
    /// Block of the transaction.
    pub block_number: u64,
    /// Hash of the block.
    pub block_hash: B256,
    /// Payer.
    pub payer: ChainAddress,
    /// Purchase ID.
    pub purchase_id: u64,
    /// Amount in wei.
    pub amount_wei: u64,
    /// Commitments in event order.
    pub commitments: &'a [FieldElement],
    /// Index of the first leaf.
    pub first_leaf_index: u32,
    /// Insertion epoch.
    pub insertion_epoch: u64,
    /// Expiry epoch.
    pub expiry: u64,
    /// Unix time of the issuance.
    pub issued_at: u64,
}

/// Insert a payment and its `issued_leaves` rows. The MMR rows must be in the same
/// transaction, before this call.
pub async fn insert_payment(
    conn: &mut SqliteConnection,
    payment: &NewPayment<'_>,
) -> Result<(), DbError> {
    let key = payment.key;
    let count = u32::try_from(payment.commitments.len())
        .map_err(|_| DbError::OutOfRange(payment.commitments.len() as u64))?;
    sqlx::query(
        "INSERT INTO payments (chain_id, tx_hash, log_index, block_number, block_hash, payer,
            purchase_id, amount_wei, batch_count, first_leaf_index, insertion_epoch, expiry,
            issued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(sql_int(key.chain_id)?)
    .bind(key.tx_hash.as_slice().to_vec())
    .bind(i64::from(key.log_index))
    .bind(sql_int(payment.block_number)?)
    .bind(payment.block_hash.as_slice().to_vec())
    .bind(payment.payer.as_slice().to_vec())
    .bind(payment.purchase_id.to_string())
    .bind(payment.amount_wei.to_string())
    .bind(i64::from(count))
    .bind(i64::from(payment.first_leaf_index))
    .bind(sql_int(payment.insertion_epoch)?)
    .bind(sql_int(payment.expiry)?)
    .bind(sql_int(payment.issued_at)?)
    .execute(&mut *conn)
    .await?;
    for (position, commitment) in payment.commitments.iter().enumerate() {
        let offset = u32::try_from(position).map_err(|_| DbError::OutOfRange(position as u64))?;
        let leaf_index = payment
            .first_leaf_index
            .checked_add(offset)
            .ok_or(DbError::OutOfRange(u64::from(offset)))?;
        sqlx::query(
            "INSERT INTO issued_leaves (leaf_index, chain_id, tx_hash, log_index, position,
                commitment, insertion_epoch)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(i64::from(leaf_index))
        .bind(sql_int(key.chain_id)?)
        .bind(key.tx_hash.as_slice().to_vec())
        .bind(i64::from(key.log_index))
        .bind(i64::from(offset))
        .bind(commitment.to_bytes_be().to_vec())
        .bind(sql_int(payment.insertion_epoch)?)
        .execute(&mut *conn)
        .await?;
    }
    sqlx::query("DELETE FROM topup_tracking WHERE chain_id = ? AND tx_hash = ? AND log_index = ?")
        .bind(sql_int(key.chain_id)?)
        .bind(key.tx_hash.as_slice().to_vec())
        .bind(i64::from(key.log_index))
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// The issuance of a payment, if the payment is issued.
pub async fn find_issuance(
    conn: &mut SqliteConnection,
    key: &PaymentKey,
) -> Result<Option<Issuance>, DbError> {
    let row = sqlx::query(
        "SELECT block_number, payer, purchase_id, amount_wei, insertion_epoch, expiry
         FROM payments WHERE chain_id = ? AND tx_hash = ? AND log_index = ?",
    )
    .bind(sql_int(key.chain_id)?)
    .bind(key.tx_hash.as_slice().to_vec())
    .bind(i64::from(key.log_index))
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let insertion_epoch = get_u64(&row, "insertion_epoch")?;
    let leaf_rows = sqlx::query(
        "SELECT l.leaf_index AS leaf_index, l.commitment AS commitment, m.leaf AS leaf
         FROM issued_leaves l JOIN mmr_leaves m ON m.leaf_index = l.leaf_index
         WHERE l.chain_id = ? AND l.tx_hash = ? AND l.log_index = ?
         ORDER BY l.position",
    )
    .bind(sql_int(key.chain_id)?)
    .bind(key.tx_hash.as_slice().to_vec())
    .bind(i64::from(key.log_index))
    .fetch_all(&mut *conn)
    .await?;
    let leaves = leaf_rows
        .iter()
        .map(|leaf| {
            Ok(IssuedLeaf {
                leaf_index: get_u32(leaf, "leaf_index")?,
                commitment: get_field(leaf, "commitment")?,
                leaf: get_field(leaf, "leaf")?,
            })
        })
        .collect::<Result<Vec<_>, DbError>>()?;
    Ok(Some(Issuance {
        purchase_id: DecimalU64(get_decimal(&row, "purchase_id")?),
        payer: Address(get_bytes::<20>(&row, "payer")?),
        amount_wei: DecimalU64(get_decimal(&row, "amount_wei")?),
        block_number: DecimalU64(get_u64(&row, "block_number")?),
        insertion_epoch: DecimalU64(insertion_epoch),
        eligible_epoch: DecimalU64(insertion_epoch.saturating_add(1)),
        expiry: DecimalU64(get_u64(&row, "expiry")?),
        leaves,
    }))
}

/// Number of issued leaves.
pub async fn issued_leaf_count(conn: &mut SqliteConnection) -> Result<u64, DbError> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM issued_leaves")
        .fetch_one(&mut *conn)
        .await?;
    u64::try_from(count).map_err(|_| DbError::Corrupt("negative count".to_owned()))
}

/// Number of leaves with an insertion epoch at or before `epoch`.
///
/// Leaves have non-decreasing insertion epochs in index order, so these leaves are the first
/// leaves of the MMR.
pub async fn leaf_count_through(conn: &mut SqliteConnection, epoch: u64) -> Result<u32, DbError> {
    let count: Option<i64> = sqlx::query_scalar(
        "SELECT MAX(leaf_index) + 1 FROM issued_leaves WHERE insertion_epoch <= ?",
    )
    .bind(sql_int(epoch)?)
    .fetch_one(&mut *conn)
    .await?;
    u32::try_from(count.unwrap_or(0)).map_err(|_| DbError::Corrupt("leaf count".to_owned()))
}

/// The largest insertion epoch of all leaves, if a leaf exists.
pub async fn last_insertion_epoch(conn: &mut SqliteConnection) -> Result<Option<u64>, DbError> {
    let value: Option<i64> = sqlx::query_scalar("SELECT MAX(insertion_epoch) FROM issued_leaves")
        .fetch_one(&mut *conn)
        .await?;
    value
        .map(|v| u64::try_from(v).map_err(|_| DbError::Corrupt("insertion epoch".to_owned())))
        .transpose()
}

/// Committed leaves with `index >= from`, at most `limit`.
pub async fn leaves_from(
    conn: &mut SqliteConnection,
    from: u32,
    limit: u32,
) -> Result<Vec<LeafAppendedEvent>, DbError> {
    let rows = sqlx::query(
        "SELECT leaf_index, leaf FROM mmr_leaves WHERE leaf_index >= ? ORDER BY leaf_index LIMIT ?",
    )
    .bind(i64::from(from))
    .bind(i64::from(limit))
    .fetch_all(&mut *conn)
    .await?;
    rows.iter()
        .map(|row| {
            Ok(LeafAppendedEvent {
                index: get_u32(row, "leaf_index")?,
                leaf: get_field(row, "leaf")?,
            })
        })
        .collect()
}

/// State of a tracked payment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tracking {
    /// The payment waits.
    Pending(PendingReason),
    /// The payment is rejected.
    Rejected(RejectReason),
}

/// One tracked payment row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrackingRow {
    /// Payment key.
    pub key: PaymentKey,
    /// State.
    pub state: Tracking,
    /// Block of the receipt, if known.
    pub block_number: Option<u64>,
    /// Unix time of the registration.
    pub created_at: u64,
}

fn pending_text(reason: PendingReason) -> &'static str {
    match reason {
        PendingReason::AwaitingReceipt => "awaiting_receipt",
        PendingReason::AwaitingFinality => "awaiting_finality",
        PendingReason::FinalityUnavailable => "finality_unavailable",
        PendingReason::ChainUnavailable => "chain_unavailable",
    }
}

fn reject_text(reason: RejectReason) -> &'static str {
    match reason {
        RejectReason::Reverted => "reverted",
        RejectReason::LogNotFound => "log_not_found",
        RejectReason::NotAPurchase => "not_a_purchase",
        RejectReason::MalformedPurchase => "malformed_purchase",
    }
}

fn tracking_from_text(status: &str, reason: &str) -> Result<Tracking, DbError> {
    let state = match (status, reason) {
        ("pending", "awaiting_receipt") => Tracking::Pending(PendingReason::AwaitingReceipt),
        ("pending", "awaiting_finality") => Tracking::Pending(PendingReason::AwaitingFinality),
        ("pending", "finality_unavailable") => {
            Tracking::Pending(PendingReason::FinalityUnavailable)
        }
        ("pending", "chain_unavailable") => Tracking::Pending(PendingReason::ChainUnavailable),
        ("rejected", "reverted") => Tracking::Rejected(RejectReason::Reverted),
        ("rejected", "log_not_found") => Tracking::Rejected(RejectReason::LogNotFound),
        ("rejected", "not_a_purchase") => Tracking::Rejected(RejectReason::NotAPurchase),
        ("rejected", "malformed_purchase") => Tracking::Rejected(RejectReason::MalformedPurchase),
        _ => {
            return Err(DbError::Corrupt(format!(
                "tracking state {status}/{reason}"
            )));
        }
    };
    Ok(state)
}

/// Insert or update a tracked payment.
pub async fn upsert_tracking(
    conn: &mut SqliteConnection,
    key: &PaymentKey,
    state: Tracking,
    block_number: Option<u64>,
    now: u64,
) -> Result<(), DbError> {
    let (status, reason) = match state {
        Tracking::Pending(reason) => ("pending", pending_text(reason)),
        Tracking::Rejected(reason) => ("rejected", reject_text(reason)),
    };
    sqlx::query(
        "INSERT INTO topup_tracking (chain_id, tx_hash, log_index, status, reason, block_number,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (chain_id, tx_hash, log_index) DO UPDATE SET
            status = excluded.status, reason = excluded.reason,
            block_number = excluded.block_number, updated_at = excluded.updated_at",
    )
    .bind(sql_int(key.chain_id)?)
    .bind(key.tx_hash.as_slice().to_vec())
    .bind(i64::from(key.log_index))
    .bind(status)
    .bind(reason)
    .bind(block_number.map(sql_int).transpose()?)
    .bind(sql_int(now)?)
    .bind(sql_int(now)?)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

fn tracking_from_row(row: &SqliteRow) -> Result<TrackingRow, DbError> {
    let status: String = row.try_get("status")?;
    let reason: String = row.try_get("reason")?;
    Ok(TrackingRow {
        key: PaymentKey {
            chain_id: get_u64(row, "chain_id")?,
            tx_hash: B256::from(get_bytes::<32>(row, "tx_hash")?),
            log_index: get_u32(row, "log_index")?,
        },
        state: tracking_from_text(&status, &reason)?,
        block_number: get_opt_u64(row, "block_number")?,
        created_at: get_u64(row, "created_at")?,
    })
}

/// A tracked payment, if it exists.
pub async fn get_tracking(
    conn: &mut SqliteConnection,
    key: &PaymentKey,
) -> Result<Option<TrackingRow>, DbError> {
    let row = sqlx::query(
        "SELECT chain_id, tx_hash, log_index, status, reason, block_number, created_at
         FROM topup_tracking WHERE chain_id = ? AND tx_hash = ? AND log_index = ?",
    )
    .bind(sql_int(key.chain_id)?)
    .bind(key.tx_hash.as_slice().to_vec())
    .bind(i64::from(key.log_index))
    .fetch_optional(&mut *conn)
    .await?;
    row.as_ref().map(tracking_from_row).transpose()
}

/// Up to `limit` pending tracked payments, oldest first.
pub async fn pending_tracking(
    conn: &mut SqliteConnection,
    limit: u32,
) -> Result<Vec<TrackingRow>, DbError> {
    let rows = sqlx::query(
        "SELECT chain_id, tx_hash, log_index, status, reason, block_number, created_at
         FROM topup_tracking WHERE status = 'pending' ORDER BY created_at LIMIT ?",
    )
    .bind(i64::from(limit))
    .fetch_all(&mut *conn)
    .await?;
    rows.iter().map(tracking_from_row).collect()
}

/// Number of tracked payments.
pub async fn tracking_count(conn: &mut SqliteConnection) -> Result<u64, DbError> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM topup_tracking")
        .fetch_one(&mut *conn)
        .await?;
    u64::try_from(count).map_err(|_| DbError::Corrupt("negative count".to_owned()))
}

/// Remove tracked payments that still have no receipt and were registered before `before`.
/// A random transaction hash never gets a receipt, so this limits the table size.
pub async fn expire_tracking(conn: &mut SqliteConnection, before: u64) -> Result<u64, DbError> {
    let result = sqlx::query(
        "DELETE FROM topup_tracking
         WHERE status = 'pending' AND reason = 'awaiting_receipt' AND created_at < ?",
    )
    .bind(sql_int(before)?)
    .execute(&mut *conn)
    .await?;
    Ok(result.rows_affected())
}

/// Next block of the sale indexer, if the indexer has run.
pub async fn indexer_next_block(conn: &mut SqliteConnection) -> Result<Option<u64>, DbError> {
    let value: Option<i64> =
        sqlx::query_scalar("SELECT next_block FROM indexer_state WHERE id = 1")
            .fetch_optional(&mut *conn)
            .await?;
    value
        .map(|v| u64::try_from(v).map_err(|_| DbError::Corrupt("next block".to_owned())))
        .transpose()
}

/// Set the next block of the sale indexer.
pub async fn set_indexer_next_block(
    conn: &mut SqliteConnection,
    next_block: u64,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO indexer_state (id, next_block) VALUES (1, ?)
         ON CONFLICT (id) DO UPDATE SET next_block = excluded.next_block",
    )
    .bind(sql_int(next_block)?)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// One root publication row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Publication {
    /// Source epoch.
    pub epoch: u64,
    /// Leaf count.
    pub leaf_count: u32,
    /// Root.
    pub root: FieldElement,
    /// State.
    pub status: PublicationStatus,
    /// Transaction hash, if signed.
    pub tx_hash: Option<B256>,
    /// Signed transaction, if signed.
    pub raw_tx: Option<Vec<u8>>,
    /// Transaction nonce, if signed.
    pub nonce: Option<u64>,
    /// Block of the successful receipt.
    pub block_number: Option<u64>,
    /// Reason for `skipped` or `failed`.
    pub note: Option<String>,
}

impl Publication {
    /// The API form of the row.
    pub fn record(&self) -> IssuerRootRecord {
        IssuerRootRecord {
            epoch: DecimalU64(self.epoch),
            leaf_count: self.leaf_count,
            root: self.root,
            status: self.status,
            tx_hash: self.tx_hash.map(|hash| Bytes32(hash.0)),
            block_number: self.block_number.map(DecimalU64),
        }
    }
}

/// Text form of a publication state in the database.
pub fn status_text(status: PublicationStatus) -> &'static str {
    match status {
        PublicationStatus::Pending => "pending",
        PublicationStatus::Submitted => "submitted",
        PublicationStatus::Included => "included",
        PublicationStatus::Finalized => "finalized",
        PublicationStatus::Skipped => "skipped",
        PublicationStatus::Failed => "failed",
    }
}

fn status_from_text(text: &str) -> Result<PublicationStatus, DbError> {
    match text {
        "pending" => Ok(PublicationStatus::Pending),
        "submitted" => Ok(PublicationStatus::Submitted),
        "included" => Ok(PublicationStatus::Included),
        "finalized" => Ok(PublicationStatus::Finalized),
        "skipped" => Ok(PublicationStatus::Skipped),
        "failed" => Ok(PublicationStatus::Failed),
        other => Err(DbError::Corrupt(format!("publication status {other}"))),
    }
}

fn publication_from_row(row: &SqliteRow) -> Result<Publication, DbError> {
    let status: String = row.try_get("status")?;
    let tx_hash: Option<Vec<u8>> = row.try_get("tx_hash")?;
    let tx_hash = tx_hash
        .map(|bytes| {
            <[u8; 32]>::try_from(bytes)
                .map(B256::from)
                .map_err(|_| DbError::Corrupt("tx_hash".to_owned()))
        })
        .transpose()?;
    Ok(Publication {
        epoch: get_u64(row, "epoch")?,
        leaf_count: get_u32(row, "leaf_count")?,
        root: get_field(row, "root")?,
        status: status_from_text(&status)?,
        tx_hash,
        raw_tx: row.try_get("raw_tx")?,
        nonce: get_opt_u64(row, "nonce")?,
        block_number: get_opt_u64(row, "block_number")?,
        note: row.try_get("note")?,
    })
}

/// Insert a pending publication. The snapshot of the epoch must exist.
pub async fn insert_publication(
    conn: &mut SqliteConnection,
    epoch: u64,
    leaf_count: u32,
    root: FieldElement,
    now: u64,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO root_publications (epoch, leaf_count, root, status, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?)",
    )
    .bind(sql_int(epoch)?)
    .bind(i64::from(leaf_count))
    .bind(root.to_bytes_be().to_vec())
    .bind(sql_int(now)?)
    .bind(sql_int(now)?)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Publications with `status`, in ascending epoch order.
pub async fn publications_with_status(
    conn: &mut SqliteConnection,
    status: PublicationStatus,
) -> Result<Vec<Publication>, DbError> {
    let rows = sqlx::query(
        "SELECT epoch, leaf_count, root, status, tx_hash, raw_tx, nonce, block_number, note
         FROM root_publications WHERE status = ? ORDER BY epoch",
    )
    .bind(status_text(status))
    .fetch_all(&mut *conn)
    .await?;
    rows.iter().map(publication_from_row).collect()
}

/// Publication of `epoch`, if it exists.
pub async fn publication(
    conn: &mut SqliteConnection,
    epoch: u64,
) -> Result<Option<Publication>, DbError> {
    let row = sqlx::query(
        "SELECT epoch, leaf_count, root, status, tx_hash, raw_tx, nonce, block_number, note
         FROM root_publications WHERE epoch = ?",
    )
    .bind(sql_int(epoch)?)
    .fetch_optional(&mut *conn)
    .await?;
    row.as_ref().map(publication_from_row).transpose()
}

/// Up to `limit` publications with `epoch >= from`, ascending.
pub async fn publications_from(
    conn: &mut SqliteConnection,
    from: u64,
    limit: u32,
) -> Result<Vec<Publication>, DbError> {
    let rows = sqlx::query(
        "SELECT epoch, leaf_count, root, status, tx_hash, raw_tx, nonce, block_number, note
         FROM root_publications WHERE epoch >= ? ORDER BY epoch LIMIT ?",
    )
    .bind(sql_int(from)?)
    .bind(i64::from(limit))
    .fetch_all(&mut *conn)
    .await?;
    rows.iter().map(publication_from_row).collect()
}

/// The last `limit` publications, ascending.
pub async fn latest_publications(
    conn: &mut SqliteConnection,
    limit: u32,
) -> Result<Vec<Publication>, DbError> {
    let rows = sqlx::query(
        "SELECT * FROM (
            SELECT epoch, leaf_count, root, status, tx_hash, raw_tx, nonce, block_number, note
            FROM root_publications ORDER BY epoch DESC LIMIT ?
         ) ORDER BY epoch",
    )
    .bind(i64::from(limit))
    .fetch_all(&mut *conn)
    .await?;
    rows.iter().map(publication_from_row).collect()
}

/// Up to `limit` root events (publications with a successful receipt) with `epoch >= from`.
pub async fn root_events_from(
    conn: &mut SqliteConnection,
    from: u64,
    limit: u32,
) -> Result<Vec<RootUpdatedEvent>, DbError> {
    let rows = sqlx::query(
        "SELECT epoch, leaf_count, root, status, tx_hash, raw_tx, nonce, block_number, note
         FROM root_publications
         WHERE epoch >= ? AND status IN ('included', 'finalized')
         ORDER BY epoch LIMIT ?",
    )
    .bind(sql_int(from)?)
    .bind(i64::from(limit))
    .fetch_all(&mut *conn)
    .await?;
    let mut events = Vec::with_capacity(rows.len());
    for row in &rows {
        let publication = publication_from_row(row)?;
        let (Some(tx_hash), Some(block_number)) = (publication.tx_hash, publication.block_number)
        else {
            return Err(DbError::Corrupt(format!(
                "publication {} has no transaction or block",
                publication.epoch
            )));
        };
        events.push(RootUpdatedEvent {
            index: DecimalU64(publication.epoch),
            root: publication.root,
            leaf_count: publication.leaf_count,
            tx_hash: Bytes32(tx_hash.0),
            block_number: DecimalU64(block_number),
            finalized: publication.status == PublicationStatus::Finalized,
        });
    }
    Ok(events)
}

/// Mark all pending publications before `epoch` as skipped.
pub async fn skip_pending_before(
    conn: &mut SqliteConnection,
    epoch: u64,
    now: u64,
) -> Result<u64, DbError> {
    let result = sqlx::query(
        "UPDATE root_publications SET status = 'skipped', note = 'a newer epoch replaced it',
            updated_at = ?
         WHERE status = 'pending' AND epoch < ?",
    )
    .bind(sql_int(now)?)
    .bind(sql_int(epoch)?)
    .execute(&mut *conn)
    .await?;
    Ok(result.rows_affected())
}

/// Record a signed transaction for a pending publication. Call this before the broadcast.
pub async fn mark_submitted(
    conn: &mut SqliteConnection,
    epoch: u64,
    tx_hash: B256,
    raw_tx: &[u8],
    nonce: u64,
    now: u64,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE root_publications SET status = 'submitted', tx_hash = ?, raw_tx = ?, nonce = ?,
            updated_at = ?
         WHERE epoch = ? AND status = 'pending'",
    )
    .bind(tx_hash.as_slice().to_vec())
    .bind(raw_tx.to_vec())
    .bind(sql_int(nonce)?)
    .bind(sql_int(now)?)
    .bind(sql_int(epoch)?)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Set the state, block, and note of a publication.
pub async fn set_publication_state(
    conn: &mut SqliteConnection,
    epoch: u64,
    status: PublicationStatus,
    block_number: Option<u64>,
    note: Option<&str>,
    now: u64,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE root_publications SET status = ?, block_number = ?, note = ?, updated_at = ?
         WHERE epoch = ?",
    )
    .bind(status_text(status))
    .bind(block_number.map(sql_int).transpose()?)
    .bind(note)
    .bind(sql_int(now)?)
    .bind(sql_int(epoch)?)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

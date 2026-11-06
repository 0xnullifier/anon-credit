//! The issuer core: issuance, the sale indexer, and the root publisher.
//!
//! [`Service`] has the database, the MMR, the chain, and the clock. The HTTP handlers and the
//! background loops call its methods. The tests call the same methods with a mock chain and a
//! manual clock.
//!
//! Locking. One `tokio::sync::Mutex` protects the MMR and the epoch of the last root snapshot.
//! An issuance holds it from the insertion-epoch decision to the commit. A snapshot holds it
//! from the leaf count decision to the commit. Thus no leaf can get an insertion epoch at or
//! before an epoch that already has a snapshot.

use crate::chain::{Chain, ChainError, CreditSale};
use crate::clock::{Clock, Epochs};
use crate::db::{self, DbError, NewPayment, Publication, Tracking};
use crate::verify::{PaymentKey, PurchaseRules, Verdict, VerifiedPurchase, assess_payment};
use alloy::primitives::{Address as ChainAddress, B256, U256};
use alloy::sol_types::SolEvent;
use anon_credit_crypto::FieldElement;
use anon_credit_crypto::batch::leaf as leaf_hash;
use anon_credit_protocol::deployment::{DeploymentConfig, ROOT_WINDOW_EPOCHS};
use anon_credit_protocol::hex_bytes::{Address, Bytes32};
use anon_credit_protocol::issuer_api::{
    EpochResponse, Issuance, IssuerConfigResponse, IssuerRootsResponse, LeafEventsResponse,
    MAX_BATCHES_PER_PURCHASE, MembershipProofJson, PendingReason, PublicationStatus, RejectReason,
    RootEventsResponse, TopupResponse, TopupStatus, TreePathResponse,
};
use anon_credit_protocol::wire::DecimalU64;
use anon_credit_registry::sqlite::{RootSnapshot, latest_snapshot, snapshot_by_root};
use anon_credit_registry::{Mmr, MmrError, SqliteStore, SqliteStoreError};
use sqlx::SqlitePool;
use std::sync::Arc;

/// Failure of a service operation.
#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    /// The database failed.
    #[error(transparent)]
    Db(#[from] DbError),
    /// The MMR failed.
    #[error("mmr failure: {0}")]
    Mmr(String),
    /// A chain request failed.
    #[error(transparent)]
    Chain(#[from] ChainError),
    /// The tracking table is full.
    #[error("too many tracked payments")]
    Busy,
    /// An epoch calculation overflowed.
    #[error("epoch arithmetic overflow")]
    Overflow,
    /// The chain or the database does not agree with the configuration.
    #[error("configuration mismatch: {0}")]
    Mismatch(String),
}

impl From<sqlx::Error> for ServiceError {
    fn from(error: sqlx::Error) -> Self {
        Self::Db(DbError::Sqlx(error))
    }
}

impl From<SqliteStoreError> for ServiceError {
    fn from(error: SqliteStoreError) -> Self {
        Self::Db(DbError::Store(error))
    }
}

impl From<MmrError<SqliteStoreError>> for ServiceError {
    fn from(error: MmrError<SqliteStoreError>) -> Self {
        match error {
            MmrError::Store(store) => Self::Db(DbError::Store(store)),
            other => Self::Mmr(other.to_string()),
        }
    }
}

/// Settings of the service.
#[derive(Debug, Clone)]
pub struct ServiceConfig {
    /// The deployment.
    pub deployment: DeploymentConfig,
    /// Price of one batch in wei, from `CreditSale.batchPriceWei()`.
    pub batch_price_wei: u64,
    /// First block that the sale indexer reads (the `CreditSale` deployment block).
    pub start_block: u64,
    /// Largest block range of one `eth_getLogs` request.
    pub log_chunk_blocks: u64,
    /// Largest number of tracked payments.
    pub max_tracked: u64,
    /// Seconds after which a tracked payment without a receipt is removed.
    pub tracking_ttl_seconds: u64,
}

impl ServiceConfig {
    /// Settings with the default limits.
    pub fn new(deployment: DeploymentConfig, batch_price_wei: u64, start_block: u64) -> Self {
        Self {
            deployment,
            batch_price_wei,
            start_block,
            log_chunk_blocks: 1_000,
            max_tracked: 10_000,
            tracking_ttl_seconds: 3_600,
        }
    }
}

/// What the service last saw of the chain.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Observed {
    /// The last finalized block number.
    pub finalized_block: Option<u64>,
    /// The reason why the last finalized block request failed, if it failed.
    pub finality_problem: Option<String>,
}

/// Result of a top-up registration or a status read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TopupOutcome {
    /// The leaves are in the tree.
    Issued(TopupResponse),
    /// The payment waits.
    Pending(TopupResponse),
    /// The payment is not valid.
    Rejected(TopupResponse),
}

/// Result of one indexer pass.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IndexerReport {
    /// Payments issued in this pass.
    pub issued: u32,
    /// `Purchased` logs that the checks rejected.
    pub rejected: u32,
    /// The next block to read after this pass.
    pub next_block: u64,
    /// `true` if the RPC gave no finalized block.
    pub finality_unavailable: bool,
}

struct Tree {
    mmr: Mmr<SqliteStore>,
    last_snapshot_epoch: Option<u64>,
}

/// The issuer service.
pub struct Service<C: Chain> {
    config: ServiceConfig,
    deployment_id: Bytes32,
    rules: PurchaseRules,
    epochs: Epochs,
    sale: ChainAddress,
    registry: ChainAddress,
    pool: SqlitePool,
    chain: C,
    clock: Arc<dyn Clock>,
    tree: tokio::sync::Mutex<Tree>,
    observed: std::sync::Mutex<Observed>,
}

fn chain_address(address: &Address) -> ChainAddress {
    ChainAddress::from(address.0)
}

fn root_b256(root: FieldElement) -> B256 {
    B256::from(root.to_bytes_be())
}

impl<C: Chain> Service<C> {
    /// Open the database, check it, and load the MMR.
    pub async fn open(
        config: ServiceConfig,
        pool: SqlitePool,
        chain: C,
        clock: Arc<dyn Clock>,
    ) -> Result<Self, ServiceError> {
        let deployment_id = config.deployment.deployment_id();
        let max_price = u64::MAX / u64::from(MAX_BATCHES_PER_PURCHASE);
        if config.batch_price_wei == 0 || config.batch_price_wei > max_price {
            return Err(ServiceError::Mismatch(format!(
                "batch price {} wei is zero or too large",
                config.batch_price_wei
            )));
        }
        let mut conn = pool.acquire().await?;
        db::migrate(&mut conn).await?;
        db::bind_deployment(&mut conn, &deployment_id.to_hex()).await?;
        let store = SqliteStore::open(&mut conn).await?;
        let mmr = Mmr::new(store);
        let leaves = u64::from(mmr.leaf_count()?);
        let issued = db::issued_leaf_count(&mut conn).await?;
        if leaves != issued {
            return Err(ServiceError::Mismatch(format!(
                "the MMR has {leaves} leaves but {issued} leaves are issued"
            )));
        }
        let last_snapshot_epoch = latest_snapshot(&mut conn).await?.map(|s| s.epoch);
        drop(conn);
        let rules = PurchaseRules {
            chain_id: config.deployment.payment_chain_id,
            sale: chain_address(&config.deployment.sale_address),
            batch_price_wei: U256::from(config.batch_price_wei),
        };
        Ok(Self {
            epochs: Epochs::new(config.deployment.epoch_seconds),
            sale: chain_address(&config.deployment.sale_address),
            registry: chain_address(&config.deployment.root_registry_address),
            deployment_id,
            rules,
            config,
            pool,
            chain,
            clock,
            tree: tokio::sync::Mutex::new(Tree {
                mmr,
                last_snapshot_epoch,
            }),
            observed: std::sync::Mutex::new(Observed::default()),
        })
    }

    /// Check the chain against the deployment: chain ID, sale issuer and price, registry
    /// issuer and epoch length, and the publisher key address.
    pub async fn check_chain(&self) -> Result<(), ServiceError> {
        let deployment = &self.config.deployment;
        let chain_id = self.chain.chain_id().await?;
        if chain_id != deployment.payment_chain_id {
            return Err(ServiceError::Mismatch(format!(
                "eth_chainId is {chain_id}, the deployment has {}",
                deployment.payment_chain_id
            )));
        }
        let issuer = chain_address(&deployment.issuer_address);
        let sale = self.chain.sale_info(self.sale).await?;
        if sale.issuer != issuer {
            return Err(ServiceError::Mismatch(format!(
                "CreditSale.issuer() is {}, the deployment has {issuer}",
                sale.issuer
            )));
        }
        if sale.batch_price_wei != U256::from(self.config.batch_price_wei) {
            return Err(ServiceError::Mismatch(
                "CreditSale.batchPriceWei() differs from the configured price".to_owned(),
            ));
        }
        let registry = self.chain.registry_info(self.registry).await?;
        if registry.issuer != issuer {
            return Err(ServiceError::Mismatch(format!(
                "RootRegistry.issuer() is {}, the deployment has {issuer}",
                registry.issuer
            )));
        }
        if registry.epoch_seconds != u64::from(deployment.epoch_seconds) {
            return Err(ServiceError::Mismatch(format!(
                "RootRegistry.epochSeconds() is {}, the deployment has {}",
                registry.epoch_seconds, deployment.epoch_seconds
            )));
        }
        if let Some(publisher) = self.chain.publisher()
            && publisher != issuer
        {
            return Err(ServiceError::Mismatch(format!(
                "the publisher key address {publisher} is not the issuer {issuer}"
            )));
        }
        Ok(())
    }

    /// The configuration.
    pub fn config(&self) -> &ServiceConfig {
        &self.config
    }

    /// The database pool.
    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    /// The chain.
    pub fn chain(&self) -> &C {
        &self.chain
    }

    /// Current Unix time of the service clock.
    pub fn now(&self) -> u64 {
        self.clock.now_unix()
    }

    /// Current epoch.
    pub fn current_epoch(&self) -> u64 {
        self.epochs.epoch_of(self.now())
    }

    /// What the service last saw of the chain.
    pub fn observed(&self) -> Observed {
        match self.observed.lock() {
            Ok(guard) => guard.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }

    fn observe(&self, finalized: Result<u64, String>) {
        let mut guard = match self.observed.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        match finalized {
            Ok(number) => {
                guard.finalized_block = Some(number);
                guard.finality_problem = None;
            }
            Err(problem) => guard.finality_problem = Some(problem),
        }
    }

    /// `GET /v1/config` body.
    pub fn config_response(&self) -> IssuerConfigResponse {
        IssuerConfigResponse {
            deployment: self.config.deployment.clone(),
            deployment_id: self.deployment_id,
            batch_price_wei: DecimalU64(self.config.batch_price_wei),
            max_batches_per_purchase: MAX_BATCHES_PER_PURCHASE,
            root_window_epochs: ROOT_WINDOW_EPOCHS,
        }
    }

    /// `GET /v1/epoch` body.
    pub fn epoch_response(&self) -> EpochResponse {
        let now = self.now();
        EpochResponse {
            epoch: DecimalU64(self.epochs.epoch_of(now)),
            epoch_seconds: self.config.deployment.epoch_seconds,
            now: DecimalU64(now),
            seconds_until_next: u32::try_from(self.epochs.seconds_until_next(now))
                .unwrap_or(u32::MAX),
        }
    }

    fn response(
        &self,
        key: &PaymentKey,
        status: TopupStatus,
        block_number: Option<u64>,
    ) -> TopupResponse {
        TopupResponse {
            chain_id: key.chain_id,
            tx_hash: Bytes32(key.tx_hash.0),
            log_index: key.log_index,
            status,
            pending_reason: None,
            reject_reason: None,
            block_number: block_number.map(DecimalU64),
            finalized_block: self.observed().finalized_block.map(DecimalU64),
            issuance: None,
        }
    }

    fn issued_response(&self, key: &PaymentKey, issuance: Issuance) -> TopupResponse {
        TopupResponse {
            block_number: Some(issuance.block_number),
            issuance: Some(issuance),
            ..self.response(key, TopupStatus::Issued, None)
        }
    }

    fn pending_response(
        &self,
        key: &PaymentKey,
        reason: PendingReason,
        block_number: Option<u64>,
    ) -> TopupResponse {
        TopupResponse {
            pending_reason: Some(reason),
            ..self.response(key, TopupStatus::Pending, block_number)
        }
    }

    fn rejected_response(
        &self,
        key: &PaymentKey,
        reason: RejectReason,
        block_number: Option<u64>,
    ) -> TopupResponse {
        TopupResponse {
            reject_reason: Some(reason),
            ..self.response(key, TopupStatus::Rejected, block_number)
        }
    }

    /// Issue a verified payment. If the payment is already issued, return the existing
    /// issuance and append nothing.
    pub async fn issue(&self, purchase: &VerifiedPurchase) -> Result<Issuance, ServiceError> {
        let mut tree = self.tree.lock().await;
        let mut conn = self.pool.acquire().await?;
        if let Some(existing) = db::find_issuance(&mut conn, &purchase.key).await? {
            return Ok(existing);
        }
        drop(conn);
        // A leaf never gets an epoch that already has a root snapshot.
        let floor = match tree.last_snapshot_epoch {
            Some(epoch) => epoch.checked_add(1).ok_or(ServiceError::Overflow)?,
            None => 0,
        };
        let insertion_epoch = self.current_epoch().max(floor);
        let expiry = insertion_epoch
            .checked_add(u64::from(self.config.deployment.credit_lifetime_epochs))
            .ok_or(ServiceError::Overflow)?;
        let first_leaf_index = tree.mmr.leaf_count()?;
        let result = self
            .issue_in_transaction(
                &mut tree,
                purchase,
                insertion_epoch,
                expiry,
                first_leaf_index,
            )
            .await;
        match result {
            Ok(()) => tree.mmr.store_mut().commit_staged(),
            Err(error) => {
                tree.mmr.store_mut().discard_staged();
                return Err(error);
            }
        }
        drop(tree);
        let mut conn = self.pool.acquire().await?;
        db::find_issuance(&mut conn, &purchase.key)
            .await?
            .ok_or_else(|| ServiceError::Mismatch("the issued payment is not stored".to_owned()))
    }

    async fn issue_in_transaction(
        &self,
        tree: &mut Tree,
        purchase: &VerifiedPurchase,
        insertion_epoch: u64,
        expiry: u64,
        first_leaf_index: u32,
    ) -> Result<(), ServiceError> {
        for commitment in &purchase.commitments {
            tree.mmr.append(leaf_hash(*commitment, expiry))?;
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        tree.mmr.store().write_staged(&mut tx).await?;
        db::insert_payment(
            &mut tx,
            &NewPayment {
                key: &purchase.key,
                block_number: purchase.block_number,
                block_hash: purchase.block_hash,
                payer: purchase.payer,
                purchase_id: purchase.purchase_id,
                amount_wei: purchase.amount_wei,
                commitments: &purchase.commitments,
                first_leaf_index,
                insertion_epoch,
                expiry,
                issued_at: self.now(),
            },
        )
        .await?;
        tx.commit().await?;
        tracing::info!(
            tx_hash = %purchase.key.tx_hash,
            log_index = purchase.key.log_index,
            leaves = purchase.commitments.len(),
            first_leaf_index,
            insertion_epoch,
            "payment issued"
        );
        Ok(())
    }

    async fn store_tracking(
        &self,
        key: &PaymentKey,
        state: Tracking,
        block_number: Option<u64>,
    ) -> Result<(), ServiceError> {
        let mut conn = self.pool.acquire().await?;
        db::upsert_tracking(&mut conn, key, state, block_number, self.now()).await?;
        Ok(())
    }

    /// Check a payment against the chain and issue it if it is valid.
    ///
    /// `track` is `true` for a payment in the tracking table: then a rejection is stored.
    async fn process(&self, key: &PaymentKey, track: bool) -> Result<TopupOutcome, ServiceError> {
        {
            let mut conn = self.pool.acquire().await?;
            if let Some(issuance) = db::find_issuance(&mut conn, key).await? {
                return Ok(TopupOutcome::Issued(self.issued_response(key, issuance)));
            }
        }
        let assessed = assess_payment(&self.chain, &self.rules, key).await;
        let verdict = match assessed {
            Ok((verdict, finalized)) => {
                match (&verdict, finalized) {
                    (_, Some(number)) => self.observe(Ok(number)),
                    (
                        Verdict::Pending {
                            reason: PendingReason::FinalityUnavailable,
                            ..
                        },
                        None,
                    ) => self.observe(Err("the RPC has no finalized block".to_owned())),
                    _ => {}
                }
                verdict
            }
            Err(error) => {
                tracing::warn!(%error, "chain request failed while checking a payment");
                Verdict::Pending {
                    reason: PendingReason::ChainUnavailable,
                    block_number: None,
                }
            }
        };
        match verdict {
            Verdict::Valid(purchase) => {
                let issuance = self.issue(&purchase).await?;
                Ok(TopupOutcome::Issued(self.issued_response(key, issuance)))
            }
            Verdict::Pending {
                reason,
                block_number,
            } => {
                self.store_tracking(key, Tracking::Pending(reason), block_number)
                    .await?;
                Ok(TopupOutcome::Pending(self.pending_response(
                    key,
                    reason,
                    block_number,
                )))
            }
            Verdict::Rejected {
                reason,
                block_number,
            } => {
                if track {
                    self.store_tracking(key, Tracking::Rejected(reason), block_number)
                        .await?;
                }
                Ok(TopupOutcome::Rejected(self.rejected_response(
                    key,
                    reason,
                    block_number,
                )))
            }
        }
    }

    /// `POST /v1/topups`: register a payment for tracking and check it now.
    ///
    /// A valid finalized payment is issued at once. A pending payment is tracked. A rejected
    /// payment is not stored.
    pub async fn submit_topup(&self, key: &PaymentKey) -> Result<TopupOutcome, ServiceError> {
        {
            let mut conn = self.pool.acquire().await?;
            if let Some(issuance) = db::find_issuance(&mut conn, key).await? {
                return Ok(TopupOutcome::Issued(self.issued_response(key, issuance)));
            }
            if db::get_tracking(&mut conn, key).await?.is_none()
                && db::tracking_count(&mut conn).await? >= self.config.max_tracked
            {
                return Err(ServiceError::Busy);
            }
        }
        self.process(key, false).await
    }

    /// `GET /v1/topups/:tx_hash/:log_index`: the stored state of a payment. `None` if the
    /// payment is not issued and not tracked. This reads only the database.
    pub async fn topup_status(
        &self,
        key: &PaymentKey,
    ) -> Result<Option<TopupOutcome>, ServiceError> {
        let mut conn = self.pool.acquire().await?;
        if let Some(issuance) = db::find_issuance(&mut conn, key).await? {
            return Ok(Some(TopupOutcome::Issued(
                self.issued_response(key, issuance),
            )));
        }
        let outcome = db::get_tracking(&mut conn, key)
            .await?
            .map(|row| match row.state {
                Tracking::Pending(reason) => {
                    TopupOutcome::Pending(self.pending_response(key, reason, row.block_number))
                }
                Tracking::Rejected(reason) => {
                    TopupOutcome::Rejected(self.rejected_response(key, reason, row.block_number))
                }
            });
        Ok(outcome)
    }

    /// One pass of the sale indexer.
    ///
    /// It reads `Purchased` logs from the stored next block up to the finalized block, checks
    /// and issues each one, and stores the next block. Then it checks the tracked payments
    /// again. If the RPC gives no finalized block, it does nothing and reports the reason.
    pub async fn indexer_tick(&self) -> Result<IndexerReport, ServiceError> {
        let mut report = IndexerReport::default();
        let finalized = match self.chain.finalized_block().await {
            Ok(block) => block,
            Err(ChainError::FinalityUnavailable(reason)) => {
                tracing::warn!(%reason, "no finalized block; payment issuance waits");
                self.observe(Err(reason));
                report.finality_unavailable = true;
                return Ok(report);
            }
            Err(error) => return Err(error.into()),
        };
        self.observe(Ok(finalized.number));
        let mut next = {
            let mut conn = self.pool.acquire().await?;
            db::indexer_next_block(&mut conn)
                .await?
                .unwrap_or(self.config.start_block)
        };
        let chunk = self.config.log_chunk_blocks.max(1);
        while next <= finalized.number {
            let to = next.saturating_add(chunk - 1).min(finalized.number);
            let mut logs = self
                .chain
                .logs(self.sale, CreditSale::Purchased::SIGNATURE_HASH, next, to)
                .await?;
            logs.sort_by_key(|log| (log.block_number, log.log_index));
            for log in logs {
                let Ok(log_index) = u32::try_from(log.log_index) else {
                    report.rejected += 1;
                    continue;
                };
                let key = PaymentKey {
                    chain_id: self.rules.chain_id,
                    tx_hash: log.tx_hash,
                    log_index,
                };
                let known = {
                    let mut conn = self.pool.acquire().await?;
                    db::find_issuance(&mut conn, &key).await?.is_some()
                };
                if known {
                    continue;
                }
                let (verdict, _) = assess_payment(&self.chain, &self.rules, &key).await?;
                match verdict {
                    Verdict::Valid(purchase) => {
                        self.issue(&purchase).await?;
                        report.issued += 1;
                    }
                    Verdict::Rejected { reason, .. } => {
                        tracing::warn!(tx_hash = %key.tx_hash, log_index, ?reason, "purchase log rejected");
                        report.rejected += 1;
                    }
                    Verdict::Pending { reason, .. } => {
                        // The log is at or below the finalized block, so the RPC is not
                        // consistent yet. Do not move the cursor. Try again in the next pass.
                        tracing::warn!(tx_hash = %key.tx_hash, ?reason, "finalized log is not ready");
                        report.next_block = next;
                        return Ok(report);
                    }
                }
            }
            next = to.saturating_add(1);
            let mut conn = self.pool.acquire().await?;
            db::set_indexer_next_block(&mut conn, next).await?;
        }
        report.next_block = next;
        self.recheck_tracked().await?;
        Ok(report)
    }

    async fn recheck_tracked(&self) -> Result<(), ServiceError> {
        let rows = {
            let mut conn = self.pool.acquire().await?;
            let before = self.now().saturating_sub(self.config.tracking_ttl_seconds);
            db::expire_tracking(&mut conn, before).await?;
            db::pending_tracking(&mut conn, 100).await?
        };
        for row in rows {
            self.process(&row.key, true).await?;
        }
        Ok(())
    }

    /// Record the root snapshot of the last closed epoch, if it has none.
    ///
    /// Return the new snapshot. The snapshot and a pending publication are in one transaction.
    pub async fn snapshot_closed_epoch(&self) -> Result<Option<RootSnapshot>, ServiceError> {
        let current = self.current_epoch();
        let Some(target) = current.checked_sub(1) else {
            return Ok(None);
        };
        let mut tree = self.tree.lock().await;
        if tree.last_snapshot_epoch.is_some_and(|last| last >= target) {
            return Ok(None);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let leaf_count = db::leaf_count_through(&mut tx, target).await?;
        let snapshot = RootSnapshot {
            epoch: target,
            leaf_count,
            root: tree.mmr.root_at(leaf_count)?,
        };
        tree.mmr.store().record_snapshot(&mut tx, &snapshot).await?;
        db::insert_publication(&mut tx, target, leaf_count, snapshot.root, self.now()).await?;
        db::skip_pending_before(&mut tx, target, self.now()).await?;
        tx.commit().await?;
        tree.last_snapshot_epoch = Some(target);
        Ok(Some(snapshot))
    }

    /// One pass of the root publisher: snapshot the closed epoch, reconcile the sent
    /// transactions, and send the newest pending publication if no transaction is in flight.
    ///
    /// Without a publisher key, only the snapshot step runs.
    pub async fn publisher_tick(&self) -> Result<(), ServiceError> {
        self.snapshot_closed_epoch().await?;
        if self.chain.publisher().is_none() {
            return Ok(());
        }
        let finalized = match self.chain.finalized_block().await {
            Ok(block) => {
                self.observe(Ok(block.number));
                Some(block.number)
            }
            Err(ChainError::FinalityUnavailable(reason)) => {
                self.observe(Err(reason));
                None
            }
            Err(error) => return Err(error.into()),
        };
        let mut in_flight = false;
        for status in [PublicationStatus::Submitted, PublicationStatus::Included] {
            let rows = {
                let mut conn = self.pool.acquire().await?;
                db::publications_with_status(&mut conn, status).await?
            };
            for publication in rows {
                let state = self.reconcile(&publication, finalized).await?;
                in_flight |= state == PublicationStatus::Submitted;
            }
        }
        if in_flight {
            return Ok(());
        }
        let pending = {
            let mut conn = self.pool.acquire().await?;
            db::publications_with_status(&mut conn, PublicationStatus::Pending).await?
        };
        if let Some(newest) = pending.last() {
            let mut conn = self.pool.acquire().await?;
            db::skip_pending_before(&mut conn, newest.epoch, self.now()).await?;
            drop(conn);
            self.submit(newest).await?;
        }
        Ok(())
    }

    async fn set_state(
        &self,
        publication: &Publication,
        status: PublicationStatus,
        block_number: Option<u64>,
        note: Option<&str>,
    ) -> Result<PublicationStatus, ServiceError> {
        let mut conn = self.pool.acquire().await?;
        db::set_publication_state(
            &mut conn,
            publication.epoch,
            status,
            block_number,
            note,
            self.now(),
        )
        .await?;
        Ok(status)
    }

    /// Check the receipt of a sent publication and update its state. Return the new state.
    async fn reconcile(
        &self,
        publication: &Publication,
        finalized: Option<u64>,
    ) -> Result<PublicationStatus, ServiceError> {
        let (Some(tx_hash), Some(raw), Some(nonce)) = (
            publication.tx_hash,
            publication.raw_tx.as_ref(),
            publication.nonce,
        ) else {
            return self
                .set_state(
                    publication,
                    PublicationStatus::Failed,
                    None,
                    Some("no signed transaction is stored"),
                )
                .await;
        };
        let mut receipt = self.chain.receipt(tx_hash).await?;
        if receipt.is_none() {
            // A different transaction used the nonce: this one can never be mined. Read the
            // receipt again after the nonce, because the transaction can be mined in between.
            let used = self.chain.publisher_nonce().await? > nonce;
            receipt = self.chain.receipt(tx_hash).await?;
            if receipt.is_none() {
                if used {
                    return self
                        .set_state(
                            publication,
                            PublicationStatus::Failed,
                            None,
                            Some("dropped: another transaction used the nonce"),
                        )
                        .await;
                }
                if let Err(error) = self.chain.send_raw(&raw.clone().into()).await {
                    tracing::warn!(epoch = publication.epoch, %error, "rebroadcast failed");
                }
                return self
                    .set_state(publication, PublicationStatus::Submitted, None, None)
                    .await;
            }
        }
        let Some(receipt) = receipt else {
            return Ok(publication.status);
        };
        if !receipt.success {
            tracing::warn!(epoch = publication.epoch, %tx_hash, "postRoot reverted");
            return self
                .set_state(
                    publication,
                    PublicationStatus::Failed,
                    Some(receipt.block_number),
                    Some("reverted"),
                )
                .await;
        }
        let final_and_canonical = match finalized {
            Some(number) if receipt.block_number <= number => {
                self.chain.block_hash(receipt.block_number).await? == Some(receipt.block_hash)
            }
            _ => false,
        };
        let status = match final_and_canonical {
            true => PublicationStatus::Finalized,
            false => PublicationStatus::Included,
        };
        if status != publication.status || publication.block_number != Some(receipt.block_number) {
            tracing::info!(
                epoch = publication.epoch,
                ?status,
                block = receipt.block_number,
                "root publication updated"
            );
        }
        self.set_state(publication, status, Some(receipt.block_number), None)
            .await
    }

    /// Sign, store, and send the publication. The signed transaction is stored before the
    /// broadcast, so that a restart sends the same transaction again.
    async fn submit(&self, publication: &Publication) -> Result<(), ServiceError> {
        let Some(close) = self.epochs.close_time(publication.epoch) else {
            return Err(ServiceError::Overflow);
        };
        // The contract checks `block.timestamp >= close`. Wait until the chain is past it.
        let latest = self.chain.latest_block().await?;
        if latest.timestamp < close {
            return Ok(());
        }
        let registry = self.chain.registry_info(self.registry).await?;
        if registry.latest_epoch >= publication.epoch {
            let (root, _) = self
                .chain
                .registry_root(self.registry, publication.epoch)
                .await?;
            let note = match root == root_b256(publication.root) {
                true => "the registry already has this root for the epoch",
                false => "the registry is already at or after this epoch",
            };
            self.set_state(publication, PublicationStatus::Skipped, None, Some(note))
                .await?;
            return Ok(());
        }
        let signed = self
            .chain
            .sign_post_root(
                self.registry,
                publication.epoch,
                root_b256(publication.root),
                u64::from(publication.leaf_count),
            )
            .await?;
        {
            let mut conn = self.pool.acquire().await?;
            db::mark_submitted(
                &mut conn,
                publication.epoch,
                signed.hash,
                &signed.raw,
                signed.nonce,
                self.now(),
            )
            .await?;
        }
        tracing::info!(epoch = publication.epoch, tx_hash = %signed.hash, leaf_count = publication.leaf_count, "postRoot sent");
        if let Err(error) = self.chain.send_raw(&signed.raw).await {
            tracing::warn!(epoch = publication.epoch, %error, "postRoot broadcast failed; the next pass sends it again");
        }
        Ok(())
    }

    /// `GET /v1/roots` body: the publications from `from`, or the last
    /// [`ROOT_WINDOW_EPOCHS`] publications.
    pub async fn roots(
        &self,
        from: Option<u64>,
        limit: u32,
    ) -> Result<IssuerRootsResponse, ServiceError> {
        let mut conn = self.pool.acquire().await?;
        let rows = match from {
            Some(from) => db::publications_from(&mut conn, from, limit).await?,
            None => db::latest_publications(&mut conn, limit.min(ROOT_WINDOW_EPOCHS)).await?,
        };
        Ok(IssuerRootsResponse {
            current_epoch: DecimalU64(self.current_epoch()),
            finalized_block: self.observed().finalized_block.map(DecimalU64),
            roots: rows.iter().map(Publication::record).collect(),
        })
    }

    /// `GET /v1/tree/path/:leaf_index?root=...` body. `None` if the root is not a kept
    /// snapshot or the leaf is not in it.
    pub async fn tree_path(
        &self,
        leaf_index: u32,
        root: FieldElement,
    ) -> Result<Option<TreePathResponse>, ServiceError> {
        let snapshot = {
            let mut conn = self.pool.acquire().await?;
            snapshot_by_root(&mut conn, root).await?
        };
        let Some(snapshot) = snapshot else {
            return Ok(None);
        };
        if leaf_index >= snapshot.leaf_count {
            return Ok(None);
        }
        let tree = self.tree.lock().await;
        let proof = tree
            .mmr
            .membership_proof_at(leaf_index, snapshot.leaf_count)?;
        let leaf = tree
            .mmr
            .leaf(leaf_index)?
            .ok_or_else(|| ServiceError::Mmr(format!("leaf {leaf_index} is missing")))?;
        Ok(Some(TreePathResponse {
            root: snapshot.root,
            epoch: DecimalU64(snapshot.epoch),
            leaf,
            proof: MembershipProofJson {
                leaf_index: proof.leaf_index,
                leaf_count: proof.leaf_count,
                peak_position: proof.peak_position,
                siblings: proof.siblings,
                peaks: proof.peaks,
            },
        }))
    }

    /// `GET /v1/events/leaves` body.
    pub async fn leaf_events(
        &self,
        from: u32,
        limit: u32,
    ) -> Result<LeafEventsResponse, ServiceError> {
        let leaf_count = self.tree.lock().await.mmr.store().committed_leaf_count();
        let mut conn = self.pool.acquire().await?;
        let events = db::leaves_from(&mut conn, from, limit).await?;
        Ok(LeafEventsResponse { leaf_count, events })
    }

    /// `GET /v1/events/roots` body.
    pub async fn root_events(
        &self,
        from: u64,
        limit: u32,
    ) -> Result<RootEventsResponse, ServiceError> {
        let mut conn = self.pool.acquire().await?;
        let events = db::root_events_from(&mut conn, from, limit).await?;
        Ok(RootEventsResponse { events })
    }
}

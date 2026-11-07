//! Test support: a mock chain, a manual clock, and a service on an in-memory or file database.

#![allow(dead_code, clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use alloy::primitives::{Address, B256, Bytes, U256, keccak256};
use alloy::sol_types::SolEvent;
use anon_credit_crypto::FieldElement;
use anon_credit_issuer::chain::{
    BlockRef, Chain, ChainError, ChainLog, ChainReceipt, CreditSale, RegistryInfo, SaleInfo,
    SignedTx,
};
use anon_credit_issuer::clock::ManualClock;
use anon_credit_issuer::service::{Service, ServiceConfig};
use anon_credit_protocol::deployment::DeploymentConfig;
use anon_credit_protocol::hex_bytes::{Address as WireAddress, Bytes32};
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

pub const CHAIN_ID: u64 = 11_155_111;
pub const PRICE: u64 = 100_000_000_000_000;
pub const EPOCH_SECONDS: u32 = 30;
pub const LIFETIME: u32 = 35_040;
/// Start time: the beginning of epoch 1000.
pub const T0: u64 = 30_000;

pub fn sale() -> Address {
    Address::repeat_byte(0x5a)
}

pub fn registry() -> Address {
    Address::repeat_byte(0x7e)
}

pub fn issuer() -> Address {
    Address::repeat_byte(0x15)
}

pub fn payer() -> Address {
    Address::repeat_byte(0xb0)
}

pub fn deployment() -> DeploymentConfig {
    DeploymentConfig {
        protocol_version: anon_credit_protocol::PROTOCOL_VERSION,
        payment_chain_id: CHAIN_ID,
        sale_address: WireAddress(sale().0.0),
        root_registry_address: WireAddress(registry().0.0),
        issuer_address: WireAddress(issuer().0.0),
        gateway_id: Bytes32([0x61; 32]),
        batch_size: 100,
        epoch_seconds: EPOCH_SECONDS,
        credit_lifetime_epochs: LIFETIME,
        circuit_id: Bytes32([0x01; 32]),
        verifier_artifact_hash: Bytes32([0x02; 32]),
        prover_manifest_hash: Bytes32([0x03; 32]),
    }
}

pub fn commitment(i: u64) -> FieldElement {
    FieldElement::from_u64(1_000_000 + i)
}

/// A recorded publication transaction of the mock.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MockTx {
    pub hash: B256,
    pub epoch: u64,
    pub root: B256,
    pub leaf_count: u64,
    pub nonce: u64,
}

/// State of the mock chain. The tests change it directly.
#[derive(Debug, Default)]
pub struct MockState {
    pub chain_id: u64,
    /// `None`: the RPC has no finalized block.
    pub finalized: Option<u64>,
    pub latest: u64,
    pub latest_timestamp: u64,
    /// Canonical block hashes.
    pub blocks: HashMap<u64, B256>,
    pub receipts: HashMap<B256, ChainReceipt>,
    pub logs: Vec<ChainLog>,
    /// `true`: every request fails with an RPC error.
    pub down: bool,
    pub sale_issuer: Address,
    pub price: U256,
    pub registry_issuer: Address,
    pub registry_epoch_seconds: u64,
    pub registry_latest_epoch: u64,
    pub registry_roots: HashMap<u64, (B256, u64)>,
    pub publisher: Option<Address>,
    /// Count of mined publisher transactions.
    pub mined_nonce: u64,
    /// Next nonce that a signature uses.
    pub pending_nonce: u64,
    pub signed: Vec<MockTx>,
    /// Raw transactions in broadcast order.
    pub broadcasts: Vec<Bytes>,
    pub receipt_requests: u32,
}

#[derive(Debug, Clone)]
pub struct MockChain(pub Arc<Mutex<MockState>>);

impl MockChain {
    pub fn new() -> Self {
        let state = MockState {
            chain_id: CHAIN_ID,
            finalized: Some(0),
            latest: 0,
            latest_timestamp: T0,
            sale_issuer: issuer(),
            price: U256::from(PRICE),
            registry_issuer: issuer(),
            registry_epoch_seconds: u64::from(EPOCH_SECONDS),
            publisher: Some(issuer()),
            ..MockState::default()
        };
        let chain = Self(Arc::new(Mutex::new(state)));
        chain.add_block(0);
        chain
    }

    pub fn state(&self) -> std::sync::MutexGuard<'_, MockState> {
        self.0.lock().unwrap()
    }

    pub fn block_hash_for(number: u64) -> B256 {
        keccak256(format!("block {number}"))
    }

    /// Make block `number` canonical and the latest block, if it is newer.
    pub fn add_block(&self, number: u64) {
        let mut state = self.state();
        state.blocks.insert(number, Self::block_hash_for(number));
        if number > state.latest {
            state.latest = number;
        }
    }

    /// Remove the publisher key.
    pub fn publisher_off(&self) {
        self.state().publisher = None;
    }

    pub fn finalize(&self, number: u64) {
        self.add_block(number);
        self.state().finalized = Some(number);
    }

    /// Add a successful purchase transaction with one `Purchased` log at `log_index`.
    pub fn purchase(
        &self,
        tx_hash: B256,
        block: u64,
        log_index: u64,
        purchase_id: u64,
        commitments: &[FieldElement],
    ) -> ChainLog {
        let amount = U256::from(PRICE) * U256::from(commitments.len());
        let log = purchased_log(
            sale(),
            tx_hash,
            block,
            log_index,
            purchase_id,
            commitments,
            amount,
        );
        self.add_receipt(tx_hash, block, true, vec![log.clone()]);
        self.state().logs.push(log.clone());
        log
    }

    pub fn add_receipt(&self, tx_hash: B256, block: u64, success: bool, logs: Vec<ChainLog>) {
        self.add_block(block);
        self.state().receipts.insert(
            tx_hash,
            ChainReceipt {
                tx_hash,
                success,
                block_number: block,
                block_hash: Self::block_hash_for(block),
                logs,
            },
        );
    }

    /// Mine a signed publication in `block`. `success = true` also updates the registry.
    pub fn mine(&self, hash: B256, block: u64, success: bool) {
        let tx = {
            let state = self.state();
            state
                .signed
                .iter()
                .find(|tx| tx.hash == hash)
                .cloned()
                .expect("signed transaction")
        };
        self.add_receipt(hash, block, success, Vec::new());
        let mut state = self.state();
        state.mined_nonce = state.mined_nonce.max(tx.nonce + 1);
        if success {
            state
                .registry_roots
                .insert(tx.epoch, (tx.root, tx.leaf_count));
            state.registry_latest_epoch = tx.epoch;
        }
    }
}

pub fn purchased_log(
    address: Address,
    tx_hash: B256,
    block: u64,
    log_index: u64,
    purchase_id: u64,
    commitments: &[FieldElement],
    amount: U256,
) -> ChainLog {
    let event = CreditSale::Purchased {
        payer: payer(),
        purchaseId: U256::from(purchase_id),
        commitments: commitments
            .iter()
            .map(|c| alloy::primitives::FixedBytes(c.to_bytes_be()))
            .collect(),
        amount,
    };
    let data = event.encode_log_data();
    ChainLog {
        address,
        topics: data.topics().to_vec(),
        data: data.data,
        block_number: block,
        block_hash: MockChain::block_hash_for(block),
        tx_hash,
        log_index,
        removed: false,
    }
}

impl MockState {
    fn check_up(&self) -> Result<(), ChainError> {
        match self.down {
            true => Err(ChainError::Rpc("mock RPC is down".to_owned())),
            false => Ok(()),
        }
    }

    fn block_ref(&self, number: u64) -> BlockRef {
        BlockRef {
            number,
            hash: self
                .blocks
                .get(&number)
                .copied()
                .unwrap_or(MockChain::block_hash_for(number)),
            timestamp: self.latest_timestamp,
        }
    }
}

impl Chain for MockChain {
    async fn chain_id(&self) -> Result<u64, ChainError> {
        let state = self.state();
        state.check_up()?;
        Ok(state.chain_id)
    }

    async fn confirmed_block(&self) -> Result<BlockRef, ChainError> {
        let state = self.state();
        state.check_up()?;
        match state.finalized {
            Some(number) => Ok(state.block_ref(number)),
            None => Err(ChainError::FinalityUnavailable(
                "mock has no finalized tag".to_owned(),
            )),
        }
    }

    async fn latest_block(&self) -> Result<BlockRef, ChainError> {
        let state = self.state();
        state.check_up()?;
        Ok(state.block_ref(state.latest))
    }

    async fn block_hash(&self, number: u64) -> Result<Option<B256>, ChainError> {
        let state = self.state();
        state.check_up()?;
        Ok(state.blocks.get(&number).copied())
    }

    async fn receipt(&self, tx_hash: B256) -> Result<Option<ChainReceipt>, ChainError> {
        let mut state = self.state();
        state.check_up()?;
        state.receipt_requests += 1;
        Ok(state.receipts.get(&tx_hash).cloned())
    }

    async fn logs(
        &self,
        address: Address,
        topic0: B256,
        from: u64,
        to: u64,
    ) -> Result<Vec<ChainLog>, ChainError> {
        let state = self.state();
        state.check_up()?;
        Ok(state
            .logs
            .iter()
            .filter(|log| {
                log.address == address
                    && log.topics.first() == Some(&topic0)
                    && (from..=to).contains(&log.block_number)
            })
            .cloned()
            .collect())
    }

    async fn sale_info(&self, _sale: Address) -> Result<SaleInfo, ChainError> {
        let state = self.state();
        state.check_up()?;
        Ok(SaleInfo {
            issuer: state.sale_issuer,
            batch_price_wei: state.price,
        })
    }

    async fn registry_info(&self, _registry: Address) -> Result<RegistryInfo, ChainError> {
        let state = self.state();
        state.check_up()?;
        Ok(RegistryInfo {
            issuer: state.registry_issuer,
            epoch_seconds: state.registry_epoch_seconds,
            latest_epoch: state.registry_latest_epoch,
        })
    }

    async fn registry_root(
        &self,
        _registry: Address,
        epoch: u64,
    ) -> Result<(B256, u64), ChainError> {
        let state = self.state();
        state.check_up()?;
        Ok(state
            .registry_roots
            .get(&epoch)
            .copied()
            .unwrap_or_default())
    }

    fn publisher(&self) -> Option<Address> {
        self.state().publisher
    }

    async fn publisher_nonce(&self) -> Result<u64, ChainError> {
        let state = self.state();
        state.check_up()?;
        Ok(state.mined_nonce)
    }

    async fn sign_post_root(
        &self,
        _registry: Address,
        epoch: u64,
        root: B256,
        leaf_count: u64,
    ) -> Result<SignedTx, ChainError> {
        let mut state = self.state();
        state.check_up()?;
        let nonce = state.pending_nonce.max(state.mined_nonce);
        state.pending_nonce = nonce + 1;
        let raw =
            Bytes::from(format!("postRoot {epoch} {root} {leaf_count} nonce {nonce}").into_bytes());
        let hash = keccak256(&raw);
        state.signed.push(MockTx {
            hash,
            epoch,
            root,
            leaf_count,
            nonce,
        });
        Ok(SignedTx { hash, raw, nonce })
    }

    async fn send_raw(&self, raw: &Bytes) -> Result<(), ChainError> {
        let mut state = self.state();
        state.check_up()?;
        state.broadcasts.push(raw.clone());
        Ok(())
    }
}

/// A unique database path in the temporary directory. The file is removed at drop.
pub struct TempDb(pub PathBuf);

impl TempDb {
    pub fn new(name: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        Self(std::env::temp_dir().join(format!(
            "anon-credit-issuer-{name}-{}-{n}-{nanos}.db",
            std::process::id()
        )))
    }
}

impl Drop for TempDb {
    fn drop(&mut self) {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", self.0.display()));
        }
    }
}

pub struct Harness {
    pub service: Arc<Service<MockChain>>,
    pub chain: MockChain,
    pub clock: ManualClock,
    pub pool: SqlitePool,
}

pub async fn open_service(pool: SqlitePool, chain: MockChain, clock: ManualClock) -> Harness {
    let config = ServiceConfig::new(deployment(), PRICE, 0);
    let service = Service::open(config, pool.clone(), chain.clone(), Arc::new(clock.clone()))
        .await
        .unwrap();
    Harness {
        service: Arc::new(service),
        chain,
        clock,
        pool,
    }
}

pub async fn harness() -> Harness {
    let pool = anon_credit_registry::sqlite::connect_in_memory()
        .await
        .unwrap();
    open_service(pool, MockChain::new(), ManualClock::new(T0)).await
}

pub fn tx(n: u64) -> B256 {
    keccak256(format!("purchase {n}"))
}

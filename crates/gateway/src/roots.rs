//! Accepted roots (implementation.md section 6, FUTURE.md C7).
//!
//! [`RootSource`] reads published roots. [`RegistryRootSource`] reads the `RootRegistry`
//! contract on Sepolia at the `finalized` block tag. It does not trust the issuer HTTP API.
//! Tests use a fake source.
//!
//! [`RootTracker`] keeps the published roots of the last [`ROOT_WINDOW_EPOCHS`] source epochs.
//! The window uses the source epoch of the root, not the time of publication. Thus late
//! publication does not make a newer root valid for an earlier epoch.

use crate::epoch::{ROOT_WINDOW_EPOCHS, root_in_window, window_start};
use alloy::eips::BlockId;
use alloy::primitives::Address as EvmAddress;
use alloy::providers::{DynProvider, Provider, ProviderBuilder};
use anon_credit_crypto::FieldElement;
use anon_credit_protocol::admin::RootStatus;
use anon_credit_protocol::api::AcceptedRoot;
use anon_credit_protocol::{Address, Bytes32, DecimalU64};
use async_trait::async_trait;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, RwLock, RwLockReadGuard, RwLockWriteGuard};

alloy::sol! {
    /// Read interface of `contracts/src/RootRegistry.sol`.
    #[sol(rpc)]
    contract RootRegistry {
        function latestEpoch() external view returns (uint64);
        function rootAt(uint64 epoch) external view returns (bytes32 root, uint64 leafCount);
        event RootPosted(uint64 indexed epoch, bytes32 root, uint64 leafCount);
    }
}

/// A root that the issuer published for one epoch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PublishedRoot {
    /// MMR root.
    pub root: Bytes32,
    /// Leaf count of the root.
    pub leaf_count: u64,
}

/// Failure to read the root source.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("root source failed: {0}")]
pub struct RootSourceError(pub String);

/// Source of published roots.
#[async_trait]
pub trait RootSource: Send + Sync + 'static {
    /// The latest published epoch, or zero if no epoch is published.
    async fn latest_epoch(&self) -> Result<u64, RootSourceError>;

    /// The root of `epoch`, or `None` if the epoch is not published.
    async fn root_at(&self, epoch: u64) -> Result<Option<PublishedRoot>, RootSourceError>;
}

/// `RootRegistry` contract reader. All reads use the `finalized` block tag.
#[derive(Clone)]
pub struct RegistryRootSource {
    registry: RootRegistry::RootRegistryInstance<DynProvider>,
}

impl RegistryRootSource {
    /// Make a reader for the contract at `address` through the RPC at `url`.
    pub fn new(url: reqwest::Url, address: Address) -> Self {
        let provider = ProviderBuilder::new().connect_http(url).erased();
        Self {
            registry: RootRegistry::new(EvmAddress::from(address.0), provider),
        }
    }
}

/// Text of a contract call error. The RPC URL can contain an API key, so keep only the kind.
fn contract_error(error: &alloy::contract::Error) -> RootSourceError {
    let kind = match error {
        alloy::contract::Error::TransportError(_) => "transport error",
        alloy::contract::Error::AbiError(_) => "abi decode error",
        _ => "contract call error",
    };
    RootSourceError(kind.to_owned())
}

#[async_trait]
impl RootSource for RegistryRootSource {
    async fn latest_epoch(&self) -> Result<u64, RootSourceError> {
        self.registry
            .latestEpoch()
            .block(BlockId::finalized())
            .call()
            .await
            .map_err(|e| contract_error(&e))
    }

    async fn root_at(&self, epoch: u64) -> Result<Option<PublishedRoot>, RootSourceError> {
        let record = self
            .registry
            .rootAt(epoch)
            .block(BlockId::finalized())
            .call()
            .await
            .map_err(|e| contract_error(&e))?;
        let root = Bytes32(record.root.0);
        match root.is_zero() {
            true => Ok(None),
            false => Ok(Some(PublishedRoot {
                root,
                leaf_count: record.leafCount,
            })),
        }
    }
}

/// One accepted root record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RootRecord {
    /// Epoch for which the issuer published the root.
    pub source_epoch: u64,
    /// MMR root (canonical field element).
    pub root: Bytes32,
    /// Leaf count of the root.
    pub leaf_count: u32,
}

impl RootRecord {
    /// Wire form.
    pub fn to_api(&self) -> AcceptedRoot {
        AcceptedRoot {
            source_epoch: DecimalU64(self.source_epoch),
            root: self.root,
            leaf_count: self.leaf_count,
        }
    }
}

#[derive(Debug, Default)]
struct TrackerState {
    records: BTreeMap<u64, RootRecord>,
    // Epochs at or below the latest published epoch that have no root. The contract only
    // accepts increasing epochs, so these epochs stay empty.
    empty: BTreeSet<u64>,
    last_refresh_at: Option<u64>,
    last_error: Option<String>,
}

/// The roots that the gateway accepts.
pub struct RootTracker {
    source: Arc<dyn RootSource>,
    state: RwLock<TrackerState>,
    refresh_lock: tokio::sync::Mutex<()>,
}

impl RootTracker {
    /// Make a tracker with the roots from the database cache.
    pub fn new(source: Arc<dyn RootSource>, cached: Vec<RootRecord>) -> Self {
        let records = cached.into_iter().map(|r| (r.source_epoch, r)).collect();
        Self {
            source,
            state: RwLock::new(TrackerState {
                records,
                ..TrackerState::default()
            }),
            refresh_lock: tokio::sync::Mutex::new(()),
        }
    }

    fn read(&self) -> RwLockReadGuard<'_, TrackerState> {
        self.state.read().unwrap_or_else(|e| e.into_inner())
    }

    fn write(&self) -> RwLockWriteGuard<'_, TrackerState> {
        self.state.write().unwrap_or_else(|e| e.into_inner())
    }

    /// Read the roots of the window that the tracker does not have. Return the new records.
    ///
    /// The caller writes the new records to the database cache.
    pub async fn refresh(
        &self,
        current_epoch: u64,
        now_unix: u64,
    ) -> Result<Vec<RootRecord>, RootSourceError> {
        let _one_refresh = self.refresh_lock.lock().await;
        let result = self.refresh_inner(current_epoch).await;
        let mut state = self.write();
        let start = window_start(current_epoch);
        state.records.retain(|epoch, _| *epoch >= start);
        state.empty.retain(|epoch| *epoch >= start);
        match &result {
            Ok(_) => {
                state.last_refresh_at = Some(now_unix);
                state.last_error = None;
            }
            Err(error) => state.last_error = Some(error.to_string()),
        }
        result
    }

    async fn refresh_inner(&self, current_epoch: u64) -> Result<Vec<RootRecord>, RootSourceError> {
        let latest = self.source.latest_epoch().await?;
        let last = latest.min(current_epoch);
        let mut added = Vec::new();
        for epoch in window_start(current_epoch)..=last {
            let known = {
                let state = self.read();
                state.records.contains_key(&epoch) || state.empty.contains(&epoch)
            };
            if known {
                continue;
            }
            match self.source.root_at(epoch).await? {
                None => {
                    self.write().empty.insert(epoch);
                }
                Some(published) => {
                    let record = check_published(epoch, published)?;
                    self.write().records.insert(epoch, record);
                    added.push(record);
                }
            }
        }
        Ok(added)
    }

    /// Find an accepted record of `root` at `current_epoch`.
    pub fn find(&self, root: &Bytes32, current_epoch: u64) -> Option<RootRecord> {
        self.read()
            .records
            .values()
            .rev()
            .find(|r| r.root == *root && root_in_window(r.source_epoch, current_epoch))
            .copied()
    }

    /// All accepted records at `current_epoch`, newest source epoch first.
    pub fn accepted(&self, current_epoch: u64) -> Vec<RootRecord> {
        self.read()
            .records
            .values()
            .rev()
            .filter(|r| root_in_window(r.source_epoch, current_epoch))
            .copied()
            .collect()
    }

    /// Status for the admin snapshot.
    pub fn status(&self, current_epoch: u64) -> RootStatus {
        let accepted = self.accepted(current_epoch);
        let latest = accepted.first().map(|r| r.source_epoch);
        let state = self.read();
        RootStatus {
            accepted: u32::try_from(accepted.len()).unwrap_or(u32::MAX),
            latest_source_epoch: latest.map(DecimalU64),
            latest_age_epochs: latest.map(|e| DecimalU64(current_epoch.saturating_sub(e))),
            last_refresh_at: state.last_refresh_at.map(DecimalU64),
            last_error: state.last_error.clone(),
        }
    }
}

/// Check a published root: a canonical field element and a leaf count below `2^32`.
fn check_published(epoch: u64, published: PublishedRoot) -> Result<RootRecord, RootSourceError> {
    FieldElement::from_bytes_be(&published.root.0).map_err(|_| {
        RootSourceError(format!(
            "root of epoch {epoch} is not a canonical field element"
        ))
    })?;
    let leaf_count = u32::try_from(published.leaf_count)
        .map_err(|_| RootSourceError(format!("leaf count of epoch {epoch} is too large")))?;
    Ok(RootRecord {
        source_epoch: epoch,
        root: published.root,
        leaf_count,
    })
}

/// Number of source epochs in the window, for the API.
pub const WINDOW_EPOCHS_U32: u32 = ROOT_WINDOW_EPOCHS as u32;

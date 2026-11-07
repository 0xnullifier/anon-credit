//! The chain interface of the issuer.
//!
//! The issuer reads and writes Sepolia only through [`Chain`]. [`crate::rpc_chain::RpcChain`]
//! is the JSON-RPC implementation. The tests use a mock implementation, so that no test needs
//! a network.
//!
//! The interface gives raw logs and receipts. The issuer checks the contract address, the
//! event signature, the event data, the receipt status, and the canonical block itself (see
//! [`crate::verify`]). Thus the same checks run in the tests and in production.

use alloy::primitives::{Address, B256, Bytes, U256};
use alloy::sol;
use std::future::Future;

sol! {
    /// Event and functions of `contracts/src/CreditSale.sol` that the issuer uses.
    #[derive(Debug, PartialEq, Eq)]
    contract CreditSale {
        event Purchased(address indexed payer, uint256 indexed purchaseId, bytes32[] commitments, uint256 amount);
        function issuer() external view returns (address);
        function batchPriceWei() external view returns (uint256);
    }

    /// Event and functions of `contracts/src/RootRegistry.sol` that the issuer uses.
    #[derive(Debug, PartialEq, Eq)]
    contract RootRegistry {
        event RootPosted(uint64 indexed epoch, bytes32 root, uint64 leafCount);
        function issuer() external view returns (address);
        function epochSeconds() external view returns (uint64);
        function latestEpoch() external view returns (uint64);
        function rootAt(uint64 epoch) external view returns (bytes32 root, uint64 leafCount);
        function postRoot(uint64 epoch, bytes32 root, uint64 leafCount) external;
    }
}

/// Failure of a chain request.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ChainError {
    /// The RPC request failed. A later request can succeed.
    #[error("rpc request failed: {0}")]
    Rpc(String),
    /// The RPC does not give a block for the configured block tag (`BLOCK_TAG`). The issuer
    /// must wait. It must not use a fixed block depth instead.
    #[error("block of the configured block tag is not available: {0}")]
    FinalityUnavailable(String),
    /// A contract call returned data that does not decode.
    #[error("contract response does not decode: {0}")]
    Decode(String),
    /// The service has no publisher key.
    #[error("no publisher key is configured")]
    NoSigner,
    /// The transaction could not be built or signed.
    #[error("transaction signing failed: {0}")]
    Signing(String),
}

/// A block number, hash, and timestamp.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlockRef {
    /// Block number.
    pub number: u64,
    /// Block hash.
    pub hash: B256,
    /// Block timestamp in Unix seconds.
    pub timestamp: u64,
}

/// One log as the RPC gives it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainLog {
    /// Address of the contract that emitted the log.
    pub address: Address,
    /// Log topics.
    pub topics: Vec<B256>,
    /// Log data.
    pub data: Bytes,
    /// Block number.
    pub block_number: u64,
    /// Block hash.
    pub block_hash: B256,
    /// Transaction hash.
    pub tx_hash: B256,
    /// Index of the log in its block.
    pub log_index: u64,
    /// `true` if a reorganization removed the log.
    pub removed: bool,
}

/// One transaction receipt as the RPC gives it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainReceipt {
    /// Transaction hash.
    pub tx_hash: B256,
    /// `true` if the transaction succeeded.
    pub success: bool,
    /// Block number.
    pub block_number: u64,
    /// Block hash.
    pub block_hash: B256,
    /// All logs of the transaction.
    pub logs: Vec<ChainLog>,
}

/// Immutable values of the `CreditSale` contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SaleInfo {
    /// `issuer()`.
    pub issuer: Address,
    /// `batchPriceWei()`.
    pub batch_price_wei: U256,
}

/// Values of the `RootRegistry` contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RegistryInfo {
    /// `issuer()`.
    pub issuer: Address,
    /// `epochSeconds()`.
    pub epoch_seconds: u64,
    /// `latestEpoch()`.
    pub latest_epoch: u64,
}

/// A signed transaction that is not sent yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedTx {
    /// Transaction hash.
    pub hash: B256,
    /// EIP-2718 encoding of the signed transaction.
    pub raw: Bytes,
    /// Account nonce of the transaction.
    pub nonce: u64,
}

/// Access to the payment and root chain.
///
/// Each method is one request (or a small fixed set of requests). The methods do not retry.
pub trait Chain: Send + Sync + 'static {
    /// `eth_chainId`.
    fn chain_id(&self) -> impl Future<Output = Result<u64, ChainError>> + Send;

    /// The block of the configured block tag (`BLOCK_TAG`: `finalized` by default, `safe`,
    /// or `latest`). The issuer trusts a payment or a root publication at or below this
    /// block. [`ChainError::FinalityUnavailable`] if the RPC does not support the tag or
    /// returns no block.
    fn confirmed_block(&self) -> impl Future<Output = Result<BlockRef, ChainError>> + Send;

    /// The block of the `latest` tag.
    fn latest_block(&self) -> impl Future<Output = Result<BlockRef, ChainError>> + Send;

    /// Hash of the canonical block at `number`, or `None` if the chain has no such block.
    fn block_hash(
        &self,
        number: u64,
    ) -> impl Future<Output = Result<Option<B256>, ChainError>> + Send;

    /// Receipt of a transaction, or `None` if the RPC has no receipt.
    fn receipt(
        &self,
        tx_hash: B256,
    ) -> impl Future<Output = Result<Option<ChainReceipt>, ChainError>> + Send;

    /// Logs of `address` with first topic `topic0` in blocks `from..=to`.
    fn logs(
        &self,
        address: Address,
        topic0: B256,
        from: u64,
        to: u64,
    ) -> impl Future<Output = Result<Vec<ChainLog>, ChainError>> + Send;

    /// Immutable values of the sale contract.
    fn sale_info(&self, sale: Address)
    -> impl Future<Output = Result<SaleInfo, ChainError>> + Send;

    /// Values of the root registry contract.
    fn registry_info(
        &self,
        registry: Address,
    ) -> impl Future<Output = Result<RegistryInfo, ChainError>> + Send;

    /// `rootAt(epoch)` of the root registry at the latest block.
    fn registry_root(
        &self,
        registry: Address,
        epoch: u64,
    ) -> impl Future<Output = Result<(B256, u64), ChainError>> + Send;

    /// Address of the publisher key, or `None` if no key is configured.
    fn publisher(&self) -> Option<Address>;

    /// Nonce of the publisher account at the latest block (the count of mined transactions).
    fn publisher_nonce(&self) -> impl Future<Output = Result<u64, ChainError>> + Send;

    /// Build and sign `postRoot(epoch, root, leaf_count)` with the next pending nonce of the
    /// publisher. This does not send the transaction.
    fn sign_post_root(
        &self,
        registry: Address,
        epoch: u64,
        root: B256,
        leaf_count: u64,
    ) -> impl Future<Output = Result<SignedTx, ChainError>> + Send;

    /// Send a signed transaction. The RPC answer "already known" counts as success.
    fn send_raw(&self, raw: &Bytes) -> impl Future<Output = Result<(), ChainError>> + Send;
}

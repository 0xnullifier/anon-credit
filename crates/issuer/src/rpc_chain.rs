//! JSON-RPC implementation of [`Chain`] with alloy.
//!
//! The RPC URL can contain an API key. This module never prints it.

use crate::chain::{
    BlockRef, Chain, ChainError, ChainLog, ChainReceipt, CreditSale, RegistryInfo, RootRegistry,
    SaleInfo, SignedTx,
};
use alloy::eips::eip2718::Encodable2718;
use alloy::network::{Ethereum, EthereumWallet, NetworkTransactionBuilder, TransactionBuilder};
use alloy::primitives::{Address, B256, Bytes};
use alloy::providers::{Provider, ProviderBuilder, RootProvider};
use alloy::rpc::types::{BlockNumberOrTag, Filter, Log, TransactionReceipt, TransactionRequest};
use alloy::signers::local::PrivateKeySigner;
use alloy::sol_types::SolCall;
use alloy::transports::{RpcError, TransportErrorKind};

/// Chain access through one JSON-RPC endpoint.
#[derive(Clone)]
pub struct RpcChain {
    provider: RootProvider,
    signer: Option<(EthereumWallet, Address)>,
    chain_id: u64,
}

impl std::fmt::Debug for RpcChain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Do not print the URL or the key.
        f.debug_struct("RpcChain")
            .field("chain_id", &self.chain_id)
            .field(
                "publisher",
                &self.signer.as_ref().map(|(_, address)| *address),
            )
            .finish()
    }
}

fn rpc_error(error: RpcError<TransportErrorKind>) -> ChainError {
    ChainError::Rpc(error.to_string())
}

impl RpcChain {
    /// Connect to `rpc_url`. `private_key` is the hex publisher key, if root publication is on.
    /// `chain_id` goes into each signed transaction. [`crate::service::Service::check_chain`]
    /// compares it with `eth_chainId`.
    pub fn new(
        rpc_url: &str,
        private_key: Option<&str>,
        chain_id: u64,
    ) -> Result<Self, ChainError> {
        let url = rpc_url
            .parse()
            .map_err(|_| ChainError::Rpc("SEPOLIA_RPC_URL is not a valid URL".to_owned()))?;
        let provider = ProviderBuilder::new()
            .disable_recommended_fillers()
            .connect_http(url)
            .root()
            .clone();
        let signer = private_key
            .map(|key| {
                let signer: PrivateKeySigner = key.parse().map_err(|_| {
                    ChainError::Signing("the publisher key does not parse".to_owned())
                })?;
                let address = signer.address();
                Ok::<_, ChainError>((EthereumWallet::from(signer), address))
            })
            .transpose()?;
        Ok(Self {
            provider,
            signer,
            chain_id,
        })
    }

    async fn block(
        &self,
        tag: BlockNumberOrTag,
    ) -> Result<Option<BlockRef>, RpcError<TransportErrorKind>> {
        let block = self.provider.get_block_by_number(tag).await?;
        Ok(block.map(|block| BlockRef {
            number: block.header.number,
            hash: block.header.hash,
            timestamp: block.header.timestamp,
        }))
    }

    async fn call(&self, to: Address, input: Vec<u8>) -> Result<Bytes, ChainError> {
        let request = TransactionRequest::default().with_to(to).with_input(input);
        self.provider.call(request).await.map_err(rpc_error)
    }
}

fn chain_log(log: &Log) -> Option<ChainLog> {
    Some(ChainLog {
        address: log.address(),
        topics: log.topics().to_vec(),
        data: log.data().data.clone(),
        block_number: log.block_number?,
        block_hash: log.block_hash?,
        tx_hash: log.transaction_hash?,
        log_index: log.log_index?,
        removed: log.removed,
    })
}

fn chain_receipt(receipt: &TransactionReceipt) -> Option<ChainReceipt> {
    // A receipt without a block is not mined.
    let logs = receipt
        .inner
        .logs()
        .iter()
        .map(chain_log)
        .collect::<Option<Vec<_>>>()?;
    Some(ChainReceipt {
        tx_hash: receipt.transaction_hash,
        success: receipt.status(),
        block_number: receipt.block_number?,
        block_hash: receipt.block_hash?,
        logs,
    })
}

fn decode<T: SolCall>(bytes: &Bytes) -> Result<T::Return, ChainError> {
    T::abi_decode_returns(bytes).map_err(|e| ChainError::Decode(e.to_string()))
}

impl Chain for RpcChain {
    async fn chain_id(&self) -> Result<u64, ChainError> {
        self.provider.get_chain_id().await.map_err(rpc_error)
    }

    async fn finalized_block(&self) -> Result<BlockRef, ChainError> {
        match self.block(BlockNumberOrTag::Finalized).await {
            Ok(Some(block)) => Ok(block),
            Ok(None) => Err(ChainError::FinalityUnavailable(
                "the RPC returned no finalized block".to_owned(),
            )),
            // A JSON-RPC error response means that the node does not support the tag.
            Err(RpcError::ErrorResp(payload)) => Err(ChainError::FinalityUnavailable(format!(
                "the RPC rejected the finalized tag: {}",
                payload.message
            ))),
            Err(other) => Err(rpc_error(other)),
        }
    }

    async fn latest_block(&self) -> Result<BlockRef, ChainError> {
        self.block(BlockNumberOrTag::Latest)
            .await
            .map_err(rpc_error)?
            .ok_or_else(|| ChainError::Rpc("the RPC returned no latest block".to_owned()))
    }

    async fn block_hash(&self, number: u64) -> Result<Option<B256>, ChainError> {
        Ok(self
            .block(BlockNumberOrTag::Number(number))
            .await
            .map_err(rpc_error)?
            .map(|block| block.hash))
    }

    async fn receipt(&self, tx_hash: B256) -> Result<Option<ChainReceipt>, ChainError> {
        let receipt = self
            .provider
            .get_transaction_receipt(tx_hash)
            .await
            .map_err(rpc_error)?;
        Ok(receipt.as_ref().and_then(chain_receipt))
    }

    async fn logs(
        &self,
        address: Address,
        topic0: B256,
        from: u64,
        to: u64,
    ) -> Result<Vec<ChainLog>, ChainError> {
        let filter = Filter::new()
            .address(address)
            .event_signature(topic0)
            .from_block(from)
            .to_block(to);
        let logs = self.provider.get_logs(&filter).await.map_err(rpc_error)?;
        logs.iter()
            .map(|log| {
                chain_log(log).ok_or_else(|| ChainError::Rpc("a log has no block data".to_owned()))
            })
            .collect()
    }

    async fn sale_info(&self, sale: Address) -> Result<SaleInfo, ChainError> {
        let issuer = self
            .call(sale, CreditSale::issuerCall {}.abi_encode())
            .await?;
        let price = self
            .call(sale, CreditSale::batchPriceWeiCall {}.abi_encode())
            .await?;
        Ok(SaleInfo {
            issuer: decode::<CreditSale::issuerCall>(&issuer)?,
            batch_price_wei: decode::<CreditSale::batchPriceWeiCall>(&price)?,
        })
    }

    async fn registry_info(&self, registry: Address) -> Result<RegistryInfo, ChainError> {
        let issuer = self
            .call(registry, RootRegistry::issuerCall {}.abi_encode())
            .await?;
        let seconds = self
            .call(registry, RootRegistry::epochSecondsCall {}.abi_encode())
            .await?;
        let latest = self
            .call(registry, RootRegistry::latestEpochCall {}.abi_encode())
            .await?;
        Ok(RegistryInfo {
            issuer: decode::<RootRegistry::issuerCall>(&issuer)?,
            epoch_seconds: decode::<RootRegistry::epochSecondsCall>(&seconds)?,
            latest_epoch: decode::<RootRegistry::latestEpochCall>(&latest)?,
        })
    }

    async fn registry_root(
        &self,
        registry: Address,
        epoch: u64,
    ) -> Result<(B256, u64), ChainError> {
        let bytes = self
            .call(registry, RootRegistry::rootAtCall { epoch }.abi_encode())
            .await?;
        let value = decode::<RootRegistry::rootAtCall>(&bytes)?;
        Ok((value.root, value.leafCount))
    }

    fn publisher(&self) -> Option<Address> {
        self.signer.as_ref().map(|(_, address)| *address)
    }

    async fn publisher_nonce(&self) -> Result<u64, ChainError> {
        let (_, from) = self.signer.as_ref().ok_or(ChainError::NoSigner)?;
        self.provider
            .get_transaction_count(*from)
            .latest()
            .await
            .map_err(rpc_error)
    }

    async fn sign_post_root(
        &self,
        registry: Address,
        epoch: u64,
        root: B256,
        leaf_count: u64,
    ) -> Result<SignedTx, ChainError> {
        let (wallet, from) = self.signer.as_ref().ok_or(ChainError::NoSigner)?;
        let input = RootRegistry::postRootCall {
            epoch,
            root,
            leafCount: leaf_count,
        }
        .abi_encode();
        let nonce = self
            .provider
            .get_transaction_count(*from)
            .pending()
            .await
            .map_err(rpc_error)?;
        let fees = self
            .provider
            .estimate_eip1559_fees()
            .await
            .map_err(rpc_error)?;
        let request = TransactionRequest::default()
            .with_from(*from)
            .with_to(registry)
            .with_input(input)
            .with_chain_id(self.chain_id)
            .with_nonce(nonce)
            .with_max_fee_per_gas(fees.max_fee_per_gas)
            .with_max_priority_fee_per_gas(fees.max_priority_fee_per_gas);
        let gas = self
            .provider
            .estimate_gas(request.clone())
            .await
            .map_err(rpc_error)?;
        // 20 % margin over the estimate.
        let request = request.with_gas_limit(gas.saturating_add(gas / 5));
        let envelope =
            <TransactionRequest as NetworkTransactionBuilder<Ethereum>>::build(request, wallet)
                .await
                .map_err(|e| ChainError::Signing(e.to_string()))?;
        Ok(SignedTx {
            hash: *envelope.tx_hash(),
            raw: Bytes::from(envelope.encoded_2718()),
            nonce,
        })
    }

    async fn send_raw(&self, raw: &Bytes) -> Result<(), ChainError> {
        match self.provider.send_raw_transaction(raw).await {
            Ok(_) => Ok(()),
            Err(RpcError::ErrorResp(payload))
                if payload
                    .message
                    .to_ascii_lowercase()
                    .contains("already known") =>
            {
                Ok(())
            }
            Err(error) => Err(rpc_error(error)),
        }
    }
}

//! Checks of a payment against the chain.
//!
//! A payment is one `Purchased` log, keyed by `(chain_id, tx_hash, log_index)`. The issuer
//! issues credit for a payment only if all of these are true (implementation.md section 7):
//!
//! 1. The RPC has a receipt for the transaction, and the receipt status is success.
//! 2. The receipt block is at or below the `finalized` block of the RPC. If the RPC gives no
//!    finalized block, the payment waits. A fixed block depth is never used instead.
//! 3. The receipt block hash is the canonical hash at that height.
//! 4. The receipt has a log with the requested block log index. The log is not removed, it
//!    belongs to the same transaction and block, it is from the configured `CreditSale`
//!    address, and its first topic is the `Purchased` signature.
//! 5. The event decodes. It has 1 to 100 commitments, each a canonical field element, and the
//!    amount is exactly `batch_price_wei * commitments.length`.
//!
//! The chain ID comes from the configuration. The service checks `eth_chainId` at start.

use crate::chain::{Chain, ChainError, ChainLog, ChainReceipt, CreditSale};
use alloy::primitives::{Address, B256, U256};
use alloy::sol_types::SolEvent;
use anon_credit_crypto::FieldElement;
use anon_credit_protocol::issuer_api::{MAX_BATCHES_PER_PURCHASE, PendingReason, RejectReason};

/// Key of one payment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct PaymentKey {
    /// Chain ID of the payment.
    pub chain_id: u64,
    /// Transaction hash.
    pub tx_hash: B256,
    /// Index of the log in its block.
    pub log_index: u32,
}

/// The values that the issuer checks a payment against.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PurchaseRules {
    /// Chain ID of the deployment.
    pub chain_id: u64,
    /// Address of the `CreditSale` contract.
    pub sale: Address,
    /// Price of one batch in wei.
    pub batch_price_wei: U256,
}

/// A payment that passed all checks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedPurchase {
    /// Payment key.
    pub key: PaymentKey,
    /// Block of the transaction.
    pub block_number: u64,
    /// Hash of that block.
    pub block_hash: B256,
    /// `payer` of the event.
    pub payer: Address,
    /// `purchaseId` of the event.
    pub purchase_id: u64,
    /// `amount` of the event in wei.
    pub amount_wei: u64,
    /// The commitments, in event order.
    pub commitments: Vec<FieldElement>,
}

/// Result of the checks of one payment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// All checks pass.
    Valid(VerifiedPurchase),
    /// The payment can become valid later.
    Pending {
        /// Reason.
        reason: PendingReason,
        /// Block of the receipt, if known.
        block_number: Option<u64>,
    },
    /// The payment is not valid. This is final, because the block is finalized.
    Rejected {
        /// Reason.
        reason: RejectReason,
        /// Block of the receipt.
        block_number: Option<u64>,
    },
}

/// Check one log. The caller has checked the receipt status, finality, and canonical block.
pub fn check_log(
    rules: &PurchaseRules,
    key: &PaymentKey,
    receipt: &ChainReceipt,
    log: &ChainLog,
) -> Result<VerifiedPurchase, RejectReason> {
    let same_place = log.tx_hash == key.tx_hash
        && log.tx_hash == receipt.tx_hash
        && log.block_hash == receipt.block_hash
        && log.block_number == receipt.block_number
        && log.log_index == u64::from(key.log_index);
    if !same_place || log.removed {
        return Err(RejectReason::LogNotFound);
    }
    if log.address != rules.sale
        || log.topics.first() != Some(&CreditSale::Purchased::SIGNATURE_HASH)
    {
        return Err(RejectReason::NotAPurchase);
    }
    let event = CreditSale::Purchased::decode_raw_log(log.topics.iter().copied(), &log.data)
        .map_err(|_| RejectReason::MalformedPurchase)?;
    let count = event.commitments.len();
    if count == 0 || count > MAX_BATCHES_PER_PURCHASE as usize {
        return Err(RejectReason::MalformedPurchase);
    }
    let expected = rules
        .batch_price_wei
        .checked_mul(U256::from(count))
        .ok_or(RejectReason::MalformedPurchase)?;
    if event.amount != expected {
        return Err(RejectReason::MalformedPurchase);
    }
    let commitments = event
        .commitments
        .iter()
        .map(|c| FieldElement::from_bytes_be(&c.0))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| RejectReason::MalformedPurchase)?;
    let purchase_id =
        u64::try_from(event.purchaseId).map_err(|_| RejectReason::MalformedPurchase)?;
    let amount_wei = u64::try_from(event.amount).map_err(|_| RejectReason::MalformedPurchase)?;
    Ok(VerifiedPurchase {
        key: *key,
        block_number: receipt.block_number,
        block_hash: receipt.block_hash,
        payer: event.payer,
        purchase_id,
        amount_wei,
        commitments,
    })
}

/// Read the receipt, the finalized block, and the canonical hash, then check the payment.
///
/// `ChainError::FinalityUnavailable` gives a pending verdict. Other chain errors return `Err`.
pub async fn assess_payment<C: Chain>(
    chain: &C,
    rules: &PurchaseRules,
    key: &PaymentKey,
) -> Result<(Verdict, Option<u64>), ChainError> {
    if key.chain_id != rules.chain_id {
        return Ok((
            Verdict::Rejected {
                reason: RejectReason::LogNotFound,
                block_number: None,
            },
            None,
        ));
    }
    let Some(receipt) = chain.receipt(key.tx_hash).await? else {
        return Ok((
            Verdict::Pending {
                reason: PendingReason::AwaitingReceipt,
                block_number: None,
            },
            None,
        ));
    };
    let block_number = Some(receipt.block_number);
    let finalized = match chain.finalized_block().await {
        Ok(block) => block,
        Err(ChainError::FinalityUnavailable(_)) => {
            return Ok((
                Verdict::Pending {
                    reason: PendingReason::FinalityUnavailable,
                    block_number,
                },
                None,
            ));
        }
        Err(other) => return Err(other),
    };
    let finalized_number = Some(finalized.number);
    if receipt.block_number > finalized.number {
        return Ok((
            Verdict::Pending {
                reason: PendingReason::AwaitingFinality,
                block_number,
            },
            finalized_number,
        ));
    }
    if chain.block_hash(receipt.block_number).await? != Some(receipt.block_hash) {
        // The receipt is from a block that is not canonical. The RPC can give the canonical
        // receipt later.
        return Ok((
            Verdict::Pending {
                reason: PendingReason::AwaitingReceipt,
                block_number,
            },
            finalized_number,
        ));
    }
    if !receipt.success {
        return Ok((
            Verdict::Rejected {
                reason: RejectReason::Reverted,
                block_number,
            },
            finalized_number,
        ));
    }
    let Some(log) = receipt
        .logs
        .iter()
        .find(|log| log.log_index == u64::from(key.log_index))
    else {
        return Ok((
            Verdict::Rejected {
                reason: RejectReason::LogNotFound,
                block_number,
            },
            finalized_number,
        ));
    };
    let verdict = match check_log(rules, key, &receipt, log) {
        Ok(purchase) => Verdict::Valid(purchase),
        Err(reason) => Verdict::Rejected {
            reason,
            block_number,
        },
    };
    Ok((verdict, finalized_number))
}

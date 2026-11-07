//! JSON envelopes of the issuer HTTP API (implementation.md section 10, FUTURE.md C6).
//!
//! All paths have the `/v1` prefix. Rules for all envelopes:
//!
//! - Unknown fields are rejected.
//! - Hashes and IDs are canonical lowercase hex ([`Bytes32`], [`Address`]).
//! - Field values (commitments, leaves, roots, siblings, peaks) are canonical field elements
//!   ([`FieldElement`]): `0x` and 64 lowercase hex digits, less than the BN254 scalar modulus.
//! - `u64` values (epochs, block numbers, wei amounts) are decimal strings ([`DecimalU64`]).
//!   `u32` values (leaf indices, leaf counts, log indices) are numbers.
//! - A field that has no value is `null`. It is never left out.
//!
//! The TypeScript package `@anon-credit/protocol` has the same schemas in `issuer-api.ts`.
//! `fixtures/protocol/issuer-api.json` has shared examples.

use crate::deployment::DeploymentConfig;
use crate::hex_bytes::{Address, Bytes32};
use crate::settings::BlockTag;
use crate::wire::DecimalU64;
use anon_credit_crypto::FieldElement;
use serde::{Deserialize, Serialize};

/// Deserialize an `Option` field that must be present. `null` gives `None`.
///
/// Serde accepts a missing `Option` field as `None`. The wire rule is that a field without a
/// value is `null` and never left out, so this function makes the field required.
fn required<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

/// Largest number of batches in one purchase. `CreditSale` has the same limit.
pub const MAX_BATCHES_PER_PURCHASE: u32 = 100;

/// Largest number of items in one page of `GET /v1/roots` and the event endpoints.
pub const MAX_PAGE_LIMIT: u32 = 1000;

/// `GET /v1/config` response body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IssuerConfigResponse {
    /// The deployment configuration.
    pub deployment: DeploymentConfig,
    /// `keccak256` of the deployment encoding.
    pub deployment_id: Bytes32,
    /// Price of one batch in wei, read from `CreditSale.batchPriceWei()`.
    pub batch_price_wei: DecimalU64,
    /// Largest number of batches in one purchase.
    pub max_batches_per_purchase: u32,
    /// Number of source epochs for which the gateway accepts a root.
    pub root_window_epochs: u32,
    /// Block tag of the sale indexer and the root publisher (`BLOCK_TAG`). A payment or a
    /// root publication at or below the block of this tag counts as final. Production:
    /// `finalized`. `latest` is for a testnet only.
    pub block_tag: BlockTag,
}

/// `POST /v1/topups` request body. It asks the issuer to track one `Purchased` log.
///
/// The issuer reads the log from the chain. It never mints from the values of the client.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TopupRequest {
    /// Hash of the purchase transaction.
    pub tx_hash: Bytes32,
    /// Index of the `Purchased` log in its block.
    pub log_index: u32,
}

/// Status of a tracked payment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TopupStatus {
    /// The issuer waits for the chain. See [`PendingReason`].
    Pending,
    /// The leaves are in the tree. See [`Issuance`].
    Issued,
    /// The log is not a valid purchase. See [`RejectReason`]. This is final.
    Rejected,
}

/// Reason why a payment is pending.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PendingReason {
    /// The RPC has no receipt for the transaction yet.
    AwaitingReceipt,
    /// The block of the log is after the finalized block.
    AwaitingFinality,
    /// The RPC does not give a `finalized` block. The issuer waits. It does not use a fixed
    /// block depth instead.
    FinalityUnavailable,
    /// The RPC request failed. The issuer tries again.
    ChainUnavailable,
}

/// Reason why a payment is rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RejectReason {
    /// The finalized transaction reverted.
    Reverted,
    /// The finalized transaction has no log with this index.
    LogNotFound,
    /// The log is not a `Purchased` event of the configured `CreditSale` contract.
    NotAPurchase,
    /// The log data does not decode, or a commitment is not a canonical field element.
    MalformedPurchase,
}

/// One leaf of an issuance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IssuedLeaf {
    /// Index of the leaf in the MMR.
    pub leaf_index: u32,
    /// The commitment `c` from the purchase.
    pub commitment: FieldElement,
    /// `leaf = H(DOM_LEAF, c, K, expiry)`.
    pub leaf: FieldElement,
}

/// The result of one issued payment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Issuance {
    /// `purchaseId` from the `Purchased` event.
    pub purchase_id: DecimalU64,
    /// `payer` from the `Purchased` event.
    pub payer: Address,
    /// `amount` from the `Purchased` event, in wei.
    pub amount_wei: DecimalU64,
    /// Block of the purchase transaction.
    pub block_number: DecimalU64,
    /// Epoch in which the issuer appended the leaves.
    pub insertion_epoch: DecimalU64,
    /// First epoch in which the leaves can be in a published root: `insertion_epoch + 1`.
    pub eligible_epoch: DecimalU64,
    /// Last epoch in which a batch can be opened: `insertion_epoch + credit_lifetime_epochs`.
    pub expiry: DecimalU64,
    /// The leaves, in commitment order.
    pub leaves: Vec<IssuedLeaf>,
}

/// `POST /v1/topups` and `GET /v1/topups/:tx_hash/:log_index` response body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TopupResponse {
    /// Chain ID of the payment.
    pub chain_id: u64,
    /// Hash of the purchase transaction.
    pub tx_hash: Bytes32,
    /// Index of the log in its block.
    pub log_index: u32,
    /// Status of the payment.
    pub status: TopupStatus,
    /// Set only if `status` is `pending`.
    #[serde(deserialize_with = "required")]
    pub pending_reason: Option<PendingReason>,
    /// Set only if `status` is `rejected`.
    #[serde(deserialize_with = "required")]
    pub reject_reason: Option<RejectReason>,
    /// Block of the log, if the issuer knows it.
    #[serde(deserialize_with = "required")]
    pub block_number: Option<DecimalU64>,
    /// The last finalized block that the issuer saw, if any.
    #[serde(deserialize_with = "required")]
    pub finalized_block: Option<DecimalU64>,
    /// Set only if `status` is `issued`.
    #[serde(deserialize_with = "required")]
    pub issuance: Option<Issuance>,
}

/// State of one root publication.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PublicationStatus {
    /// The snapshot is recorded. No transaction is signed yet.
    Pending,
    /// The `postRoot` transaction is signed and sent. It has no receipt yet.
    Submitted,
    /// The transaction succeeded in a block that is not finalized yet.
    Included,
    /// The transaction succeeded in a finalized block. The gateway can accept the root.
    Finalized,
    /// The issuer did not send the transaction, because a newer epoch replaced it.
    Skipped,
    /// The transaction reverted or was dropped. A later epoch replaces it.
    Failed,
}

/// One root publication record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IssuerRootRecord {
    /// The closed source epoch of the root.
    pub epoch: DecimalU64,
    /// Leaf count of the root.
    pub leaf_count: u32,
    /// MMR root.
    pub root: FieldElement,
    /// Publication state.
    pub status: PublicationStatus,
    /// Hash of the `postRoot` transaction, if one is signed.
    #[serde(deserialize_with = "required")]
    pub tx_hash: Option<Bytes32>,
    /// Block of the successful transaction, if it has a receipt.
    #[serde(deserialize_with = "required")]
    pub block_number: Option<DecimalU64>,
}

/// `GET /v1/roots` response body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IssuerRootsResponse {
    /// Current epoch of the issuer clock.
    pub current_epoch: DecimalU64,
    /// The last finalized block that the issuer saw, if any.
    #[serde(deserialize_with = "required")]
    pub finalized_block: Option<DecimalU64>,
    /// Publication records, in ascending epoch order.
    pub roots: Vec<IssuerRootRecord>,
}

/// Complete MMR membership proof. The same JSON form as `anon_credit_registry::MembershipProof`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MembershipProofJson {
    /// Leaf index.
    pub leaf_index: u32,
    /// Leaf count of the root snapshot.
    pub leaf_count: u32,
    /// Position of the leaf's peak in `peaks` (0 is the left, highest peak).
    pub peak_position: u32,
    /// Siblings from the leaf level up to one level below the peak.
    pub siblings: Vec<FieldElement>,
    /// All peaks of the snapshot, in descending height order.
    pub peaks: Vec<FieldElement>,
}

/// `GET /v1/tree/path/:leaf_index?root=...` response body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TreePathResponse {
    /// The requested root.
    pub root: FieldElement,
    /// The earliest closed epoch with this root.
    pub epoch: DecimalU64,
    /// The leaf value at `proof.leaf_index`.
    pub leaf: FieldElement,
    /// The membership proof of `leaf` against `root`.
    pub proof: MembershipProofJson,
}

/// `GET /v1/epoch` response body.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EpochResponse {
    /// Current epoch: `floor(now / epoch_seconds)`.
    pub epoch: DecimalU64,
    /// Epoch length in seconds.
    pub epoch_seconds: u32,
    /// Issuer clock in Unix seconds.
    pub now: DecimalU64,
    /// Seconds until the next epoch boundary (1 to `epoch_seconds`).
    pub seconds_until_next: u32,
}

/// One `LeafAppended(index, leaf)` event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LeafAppendedEvent {
    /// Leaf index.
    pub index: u32,
    /// Leaf value.
    pub leaf: FieldElement,
}

/// `GET /v1/events/leaves?from=N&limit=L` response body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LeafEventsResponse {
    /// Committed leaf count at the time of the request.
    pub leaf_count: u32,
    /// Events with `index >= from`, in ascending order.
    pub events: Vec<LeafAppendedEvent>,
}

/// One `RootUpdated(index, root)` event. `index` is the source epoch. Only roots with a
/// successful `postRoot` transaction have an event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RootUpdatedEvent {
    /// Source epoch of the root.
    pub index: DecimalU64,
    /// MMR root.
    pub root: FieldElement,
    /// Leaf count of the root.
    pub leaf_count: u32,
    /// Hash of the `postRoot` transaction.
    pub tx_hash: Bytes32,
    /// Block of the transaction.
    pub block_number: DecimalU64,
    /// `true` if the block is finalized.
    pub finalized: bool,
}

/// `GET /v1/events/roots?from=E&limit=L` response body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RootEventsResponse {
    /// Events with `index >= from`, in ascending order.
    pub events: Vec<RootUpdatedEvent>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topup_request_rejects_unknown_fields_and_bad_hex() {
        let hash = format!("0x{}", "ab".repeat(32));
        let ok = format!(r#"{{"tx_hash":"{hash}","log_index":3}}"#);
        assert!(serde_json::from_str::<TopupRequest>(&ok).is_ok());
        let extra = format!(r#"{{"tx_hash":"{hash}","log_index":3,"commitments":[]}}"#);
        assert!(serde_json::from_str::<TopupRequest>(&extra).is_err());
        let upper = format!(r#"{{"tx_hash":"0x{}","log_index":3}}"#, "AB".repeat(32));
        assert!(serde_json::from_str::<TopupRequest>(&upper).is_err());
        let negative = format!(r#"{{"tx_hash":"{hash}","log_index":-1}}"#);
        assert!(serde_json::from_str::<TopupRequest>(&negative).is_err());
    }

    #[test]
    fn optional_fields_must_be_present() {
        let json = r#"{"current_epoch":"5","roots":[]}"#;
        assert!(serde_json::from_str::<IssuerRootsResponse>(json).is_err());
        let json = r#"{"current_epoch":"5","finalized_block":null,"roots":[]}"#;
        assert!(serde_json::from_str::<IssuerRootsResponse>(json).is_ok());
    }

    #[test]
    fn status_names_are_snake_case() {
        let json = serde_json::to_string(&PendingReason::FinalityUnavailable).unwrap_or_default();
        assert_eq!(json, "\"finality_unavailable\"");
        let json = serde_json::to_string(&PublicationStatus::Finalized).unwrap_or_default();
        assert_eq!(json, "\"finalized\"");
    }
}

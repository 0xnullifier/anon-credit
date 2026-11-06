//! The issuer service library.
//!
//! Later phases add these modules here:
//!
//! - Phase 2 `indexer`: read `CreditSale` events, check contract, chain, receipt, and
//!   canonical block, and wait for Sepolia finality.
//! - Phase 2 `issuance`: key each payment by `(chain_id, tx_hash, log_index)` and append
//!   leaves in one database transaction.
//! - Phase 2 `publisher`: persist, submit, and reconcile one root publication per epoch.
//! - Phase 2 `http`: the `/v1` issuer API from implementation.md section 10.
//!
//! The issuer owns payment records. The gateway must never import them.

pub mod settings;

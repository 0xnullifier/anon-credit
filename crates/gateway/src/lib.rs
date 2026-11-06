//! The gateway service library.
//!
//! Later phases add these modules here:
//!
//! - Phase 3 `open`: check limits, schema, identities, price-table hash, proof freshness,
//!   root acceptance, open signature, and proof, then insert one session per batch ID.
//! - Phase 3 `spend`: per-batch lock, sequence checks, upstream call, and one durable
//!   commit of debit, sequence, response bytes, and receipt.
//! - Phase 3 `recovery`: replay of stored responses and signed session status.
//! - Phase 3 `upstream`: the allowlisted Sepolia JSON-RPC client with limits.
//! - Phase 3 `roots`: read finalized roots from `RootRegistry`, independent of the issuer.
//! - Phase 5 `admin` and `events`: snapshot, Server-Sent Events, and demo IP attribution.
//!
//! The gateway must not depend on the issuer crate or on payment records.

pub mod settings;

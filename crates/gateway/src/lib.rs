//! The gateway service library.
//!
//! Modules:
//!
//! - [`open`]: `POST /v1/open`. Checks limits, schema, identities, price-table hash, proof
//!   freshness, root acceptance, open signature, and proof, then inserts one session per
//!   batch ID.
//! - [`spend`]: `POST /v1/rpc`. Signature first, per-batch lock, sequence checks, upstream
//!   call, and one durable commit of debit, sequence, response bytes, and receipt.
//! - [`status`]: `POST /v1/session/status`. Signed status for client recovery.
//! - [`public`]: `GET /v1/config`, `/v1/prices`, `/v1/roots`, and the demo peer probe.
//! - [`admin`]: snapshot, Server-Sent Events, and session views on the private listener.
//! - [`roots`]: finalized roots from `RootRegistry`, independent of the issuer.
//! - [`verifier`]: the ProveKit verifier sidecar client and the bounded queue.
//! - [`upstream`]: the upstream JSON-RPC client with limits.
//! - [`store`]: SQLite sessions, receipts, and the root cache.
//! - [`events`]: in-memory diagnostic events and counters.
//! - [`peer`]: observed source address and trusted proxies.
//!
//! The gateway must not depend on the issuer crate or on payment records.

pub mod clock;
pub mod epoch;
pub mod rpc;
pub mod settings;
pub mod strict_json;

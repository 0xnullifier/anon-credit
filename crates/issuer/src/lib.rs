//! The issuer service library.
//!
//! - [`chain`]: the chain interface and the contract bindings.
//! - [`rpc_chain`]: the JSON-RPC implementation of the chain interface (alloy).
//! - [`verify`]: the checks of a payment against the chain.
//! - [`db`]: the issuer database schema and queries.
//! - [`service`]: issuance, the sale indexer, and the root publisher.
//! - [`http`]: the `/v1` issuer API from implementation.md section 10.
//! - [`clock`]: the clock and the epoch arithmetic.
//! - [`settings`]: the settings from environment variables.
//!
//! The issuer owns payment records. The gateway must never import them.

pub mod chain;
pub mod clock;
pub mod db;
pub mod http;
pub mod rpc_chain;
pub mod service;
pub mod settings;
pub mod verify;

//! Wire structures, signing bytes, error codes, and configuration IDs.
//!
//! The TypeScript package `@anon-credit/protocol` mirrors this crate.
//! The shared vectors in `fixtures/protocol/` prove that both encoders agree.
//!
//! Contents by phase:
//!
//! - Phase 1 (done): the circuit domain tags, the Poseidon2 hash, and the batch-open
//!   public-input layout are in `anon_credit_crypto` (`constants`, `batch`, `public_inputs`).
//!   Their single source is `fixtures/protocol/domains.json`.
//! - Phase 3 (done): JSON envelopes of the gateway API ([`api`]), the open and status signing
//!   messages ([`open`], [`status`]), the price table ([`price`]), and the wire encodings
//!   ([`wire`]).

pub mod deployment;
pub mod domain;
pub mod error;
pub mod hex_bytes;
pub mod open;
pub mod settings;
pub mod spend;
pub mod status;
pub mod version;
pub mod wire;

pub use deployment::{DeploymentConfig, DeploymentError};
pub use domain::DomainTag;
pub use error::{ErrorBody, ErrorCode};
pub use hex_bytes::{Address, Bytes32, HexError};
pub use open::{OPEN_MESSAGE_LEN, OpenMessage};
pub use spend::{SpendMessage, SpendMessageError};
pub use status::{STATUS_MESSAGE_LEN, StatusMessage};
pub use version::PROTOCOL_VERSION;
pub use wire::{Base64Bytes, DecimalU64, Signature64, WireError};

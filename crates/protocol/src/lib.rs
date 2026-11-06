//! Wire structures, signing bytes, error codes, and configuration IDs.
//!
//! The TypeScript package `@anon-credit/protocol` mirrors this crate.
//! The shared vectors in `fixtures/protocol/` prove that both encoders agree.
//!
//! Later phases add these parts here:
//!
//! - Phase 1: circuit domain tags (`c`, `leaf`, `id`, MMR nodes, session binding) and the
//!   public-input layout. Phase 1 freezes these with the Poseidon2 parameters.
//! - Phase 3: JSON envelopes for open, spend, and status requests, and the open and status
//!   signing messages.

pub mod deployment;
pub mod domain;
pub mod error;
pub mod hex_bytes;
pub mod settings;
pub mod spend;
pub mod version;

pub use deployment::{DeploymentConfig, DeploymentError};
pub use domain::DomainTag;
pub use error::{ErrorBody, ErrorCode};
pub use hex_bytes::{Address, Bytes32, HexError};
pub use spend::{SpendMessage, SpendMessageError};
pub use version::PROTOCOL_VERSION;

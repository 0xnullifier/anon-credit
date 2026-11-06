//! Immutable deployment configuration and `deployment_id`.
//!
//! `deployment_id = keccak256(encode())`. The encoding has fixed widths and big-endian
//! integers. A change to any field gives a new deployment. Do not accept proofs from the
//! previous deployment under the new one.
//!
//! | Offset | Size | Field                                     |
//! |-------:|-----:|-------------------------------------------|
//! |      0 |   32 | operation domain ([`domain::DEPLOYMENT`]) |
//! |     32 |    2 | `protocol_version` (`u16`)                |
//! |     34 |    8 | `payment_chain_id` (`u64`)                |
//! |     42 |   20 | `sale_address`                            |
//! |     62 |   20 | `root_registry_address`                   |
//! |     82 |   20 | `issuer_address`                          |
//! |    102 |   32 | `gateway_id`                              |
//! |    134 |    4 | `batch_size` (`u32`)                      |
//! |    138 |    4 | `epoch_seconds` (`u32`)                   |
//! |    142 |    4 | `credit_lifetime_epochs` (`u32`)          |
//! |    146 |   32 | `circuit_id`                              |
//! |    178 |   32 | `verifier_artifact_hash`                  |
//! |    210 |   32 | `prover_manifest_hash`                    |

use crate::domain;
use crate::hex_bytes::{Address, Bytes32};
use crate::version::PROTOCOL_VERSION;
use anon_credit_crypto::keccak256;
use serde::{Deserialize, Serialize};

/// Length of the deployment encoding in bytes.
pub const DEPLOYMENT_ENCODING_LEN: usize = 242;

/// Sepolia chain ID.
pub const SEPOLIA_CHAIN_ID: u64 = 11_155_111;

/// Units in one batch (`K`).
pub const BATCH_SIZE: u32 = 100;

/// Credit activation lifetime in epochs.
pub const CREDIT_LIFETIME_EPOCHS: u32 = 35_040;

/// Number of source epochs for which the gateway accepts a root.
pub const ROOT_WINDOW_EPOCHS: u32 = 96;

/// Epoch length of the Sepolia testnet profile.
pub const EPOCH_SECONDS_TESTNET: u32 = 30;

/// Epoch length of the production profile.
pub const EPOCH_SECONDS_PRODUCTION: u32 = 900;

/// Failure of a deployment configuration check.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DeploymentError {
    /// The configuration text is not valid TOML for this structure.
    #[error("deployment configuration does not parse: {0}")]
    Parse(String),
    /// The protocol version is not the version of this build.
    #[error("protocol version {found} is not supported; expected {expected}")]
    UnsupportedVersion {
        /// Version in the configuration.
        found: u16,
        /// Version of this build.
        expected: u16,
    },
    /// A numeric field is zero.
    #[error("field {0} must be greater than zero")]
    ZeroValue(&'static str),
}

/// Immutable deployment configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeploymentConfig {
    /// Protocol version. Must equal [`PROTOCOL_VERSION`].
    pub protocol_version: u16,
    /// Chain ID of the payment and root chain.
    pub payment_chain_id: u64,
    /// Address of the `CreditSale` contract.
    pub sale_address: Address,
    /// Address of the `RootRegistry` contract.
    pub root_registry_address: Address,
    /// Issuer identity: the EVM address that owns the sale and publishes roots.
    pub issuer_address: Address,
    /// Random 32-byte gateway identity, made at deployment. Not a customer identifier.
    pub gateway_id: Bytes32,
    /// Units in one batch (`K`).
    pub batch_size: u32,
    /// Epoch length in seconds.
    pub epoch_seconds: u32,
    /// Credit activation lifetime in epochs.
    pub credit_lifetime_epochs: u32,
    /// Circuit ID that the gateway pins.
    pub circuit_id: Bytes32,
    /// Digest of the verifier artifact that the gateway pins.
    pub verifier_artifact_hash: Bytes32,
    /// Digest of the prover manifest that the client pins.
    pub prover_manifest_hash: Bytes32,
}

impl DeploymentConfig {
    /// Parse a TOML deployment configuration and check it.
    pub fn from_toml_str(text: &str) -> Result<Self, DeploymentError> {
        let config: Self =
            toml::from_str(text).map_err(|e| DeploymentError::Parse(e.to_string()))?;
        config.validate()?;
        Ok(config)
    }

    /// Check the version and the numeric fields.
    pub fn validate(&self) -> Result<(), DeploymentError> {
        if self.protocol_version != PROTOCOL_VERSION {
            return Err(DeploymentError::UnsupportedVersion {
                found: self.protocol_version,
                expected: PROTOCOL_VERSION,
            });
        }
        let numeric = [
            ("payment_chain_id", self.payment_chain_id),
            ("batch_size", u64::from(self.batch_size)),
            ("epoch_seconds", u64::from(self.epoch_seconds)),
            (
                "credit_lifetime_epochs",
                u64::from(self.credit_lifetime_epochs),
            ),
        ];
        match numeric.iter().find(|(_, value)| *value == 0) {
            Some((name, _)) => Err(DeploymentError::ZeroValue(name)),
            None => Ok(()),
        }
    }

    /// Names of the fields that still have the all-zero placeholder value.
    ///
    /// A template has placeholders. A live deployment must have none.
    pub fn placeholder_fields(&self) -> Vec<&'static str> {
        let fields = [
            ("sale_address", self.sale_address.is_zero()),
            (
                "root_registry_address",
                self.root_registry_address.is_zero(),
            ),
            ("issuer_address", self.issuer_address.is_zero()),
            ("gateway_id", self.gateway_id.is_zero()),
            ("circuit_id", self.circuit_id.is_zero()),
            (
                "verifier_artifact_hash",
                self.verifier_artifact_hash.is_zero(),
            ),
            ("prover_manifest_hash", self.prover_manifest_hash.is_zero()),
        ];
        fields
            .iter()
            .filter(|(_, zero)| *zero)
            .map(|(name, _)| *name)
            .collect()
    }

    /// Encode the configuration in its fixed binary form.
    pub fn encode(&self) -> [u8; DEPLOYMENT_ENCODING_LEN] {
        let mut out = [0u8; DEPLOYMENT_ENCODING_LEN];
        let parts: [&[u8]; 13] = [
            domain::DEPLOYMENT.as_bytes(),
            &self.protocol_version.to_be_bytes(),
            &self.payment_chain_id.to_be_bytes(),
            &self.sale_address.0,
            &self.root_registry_address.0,
            &self.issuer_address.0,
            &self.gateway_id.0,
            &self.batch_size.to_be_bytes(),
            &self.epoch_seconds.to_be_bytes(),
            &self.credit_lifetime_epochs.to_be_bytes(),
            &self.circuit_id.0,
            &self.verifier_artifact_hash.0,
            &self.prover_manifest_hash.0,
        ];
        let mut offset = 0;
        for part in parts {
            out[offset..offset + part.len()].copy_from_slice(part);
            offset += part.len();
        }
        out
    }

    /// Calculate `deployment_id = keccak256(encode())`.
    pub fn deployment_id(&self) -> Bytes32 {
        Bytes32(keccak256(&self.encode()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> DeploymentConfig {
        DeploymentConfig {
            protocol_version: PROTOCOL_VERSION,
            payment_chain_id: SEPOLIA_CHAIN_ID,
            sale_address: Address([0x11; 20]),
            root_registry_address: Address([0x22; 20]),
            issuer_address: Address([0x33; 20]),
            gateway_id: Bytes32([0x44; 32]),
            batch_size: BATCH_SIZE,
            epoch_seconds: EPOCH_SECONDS_TESTNET,
            credit_lifetime_epochs: CREDIT_LIFETIME_EPOCHS,
            circuit_id: Bytes32([0x55; 32]),
            verifier_artifact_hash: Bytes32([0x66; 32]),
            prover_manifest_hash: Bytes32([0x77; 32]),
        }
    }

    #[test]
    fn encoding_fills_every_byte_at_fixed_offsets() {
        let bytes = sample().encode();
        assert_eq!(&bytes[0..32], domain::DEPLOYMENT.as_bytes());
        assert_eq!(&bytes[32..34], &[0, 1]);
        assert_eq!(&bytes[34..42], &SEPOLIA_CHAIN_ID.to_be_bytes());
        assert_eq!(&bytes[42..62], &[0x11; 20]);
        assert_eq!(&bytes[62..82], &[0x22; 20]);
        assert_eq!(&bytes[82..102], &[0x33; 20]);
        assert_eq!(&bytes[102..134], &[0x44; 32]);
        assert_eq!(&bytes[134..138], &100u32.to_be_bytes());
        assert_eq!(&bytes[138..142], &30u32.to_be_bytes());
        assert_eq!(&bytes[142..146], &35_040u32.to_be_bytes());
        assert_eq!(&bytes[146..178], &[0x55; 32]);
        assert_eq!(&bytes[178..210], &[0x66; 32]);
        assert_eq!(&bytes[210..242], &[0x77; 32]);
    }

    #[test]
    fn epoch_change_gives_new_deployment_id() {
        let mut other = sample();
        other.epoch_seconds = EPOCH_SECONDS_PRODUCTION;
        assert_ne!(sample().deployment_id(), other.deployment_id());
    }

    #[test]
    fn validate_rejects_wrong_version_and_zero_values() {
        let mut config = sample();
        config.protocol_version = 2;
        assert!(matches!(
            config.validate(),
            Err(DeploymentError::UnsupportedVersion { .. })
        ));
        let mut config = sample();
        config.epoch_seconds = 0;
        assert_eq!(
            config.validate(),
            Err(DeploymentError::ZeroValue("epoch_seconds"))
        );
    }

    #[test]
    fn placeholder_fields_lists_zero_values() {
        let mut config = sample();
        assert!(config.placeholder_fields().is_empty());
        config.gateway_id = Bytes32::ZERO;
        assert_eq!(config.placeholder_fields(), vec!["gateway_id"]);
    }

    #[test]
    fn toml_rejects_unknown_fields() {
        let text = "protocol_version = 1\nextra = 2\n";
        assert!(matches!(
            DeploymentConfig::from_toml_str(text),
            Err(DeploymentError::Parse(_))
        ));
    }
}

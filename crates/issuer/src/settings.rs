//! Issuer settings from environment variables.
//!
//! | Variable | Default | Use |
//! |---|---|---|
//! | `DEPLOYMENT_CONFIG` | none (required to run) | Deployment TOML file. |
//! | `EPOCH_SECONDS` | deployment value | Must equal the deployment value if set. |
//! | `SEPOLIA_RPC_URL` | none (required to run) | RPC for indexing and publication. Secret. |
//! | `ISSUER_PRIVATE_KEY` | none | Root publisher key. Secret. Without it, no root is sent. |
//! | `SALE_ADDRESS` | deployment value | Must equal `sale_address` if set. |
//! | `ROOT_REGISTRY_ADDRESS` | deployment value | Must equal `root_registry_address` if set. |
//! | `ISSUER_DB_PATH` | `data/issuer.db` | SQLite database file. |
//! | `ISSUER_BIND` | `0.0.0.0:8080` | API listen address. |
//! | `ISSUER_START_BLOCK` | `0` | First block of the sale indexer: the `CreditSale` deployment block. |
//! | `ISSUER_INDEX_POLL_SECONDS` | `12` | Time between indexer passes. |
//! | `ISSUER_PUBLISH_POLL_SECONDS` | `5` | Time between publisher passes. |
//! | `ISSUER_LOG_CHUNK_BLOCKS` | `1000` | Largest block range of one `eth_getLogs` request. |

use anon_credit_protocol::hex_bytes::Address;
use anon_credit_protocol::settings::{
    CommonSettings, ISSUER_PORT, SettingsError, presence, read_optional, read_parsed,
};
use std::net::SocketAddr;
use std::path::PathBuf;

/// Issuer settings.
#[derive(Debug, Clone)]
pub struct IssuerSettings {
    /// Shared settings.
    pub common: CommonSettings,
    /// Listen address of the issuer API (`ISSUER_BIND`).
    pub bind: SocketAddr,
    /// SQLite database path (`ISSUER_DB_PATH`).
    pub database_path: PathBuf,
    /// Sepolia RPC for indexing and publication (`SEPOLIA_RPC_URL`). Secret.
    pub sepolia_rpc_url: Option<String>,
    /// Root publisher private key (`ISSUER_PRIVATE_KEY`). Secret.
    pub private_key: Option<String>,
    /// First block of the sale indexer (`ISSUER_START_BLOCK`).
    pub start_block: u64,
    /// Seconds between indexer passes (`ISSUER_INDEX_POLL_SECONDS`).
    pub index_poll_seconds: u64,
    /// Seconds between publisher passes (`ISSUER_PUBLISH_POLL_SECONDS`).
    pub publish_poll_seconds: u64,
    /// Largest block range of one log request (`ISSUER_LOG_CHUNK_BLOCKS`).
    pub log_chunk_blocks: u64,
}

fn check_address(
    lookup: &impl Fn(&str) -> Option<String>,
    name: &'static str,
    expected: Option<&Address>,
) -> Result<(), SettingsError> {
    let Some(text) = read_optional(lookup, name) else {
        return Ok(());
    };
    let value = Address::from_hex(&text).map_err(|e| SettingsError::Invalid {
        name,
        reason: e.to_string(),
    })?;
    match expected {
        Some(expected) if *expected != value => Err(SettingsError::Invalid {
            name,
            reason: format!("value {value} differs from the deployment value {expected}"),
        }),
        _ => Ok(()),
    }
}

fn positive(name: &'static str, value: u64) -> Result<u64, SettingsError> {
    match value {
        0 => Err(SettingsError::Invalid {
            name,
            reason: "must be greater than zero".to_owned(),
        }),
        value => Ok(value),
    }
}

impl IssuerSettings {
    /// Read the settings with a lookup function.
    pub fn from_lookup(lookup: &impl Fn(&str) -> Option<String>) -> Result<Self, SettingsError> {
        let common = CommonSettings::from_lookup(lookup)?;
        let deployment = common.deployment.as_ref().map(|(_, config)| config);
        check_address(lookup, "SALE_ADDRESS", deployment.map(|d| &d.sale_address))?;
        check_address(
            lookup,
            "ROOT_REGISTRY_ADDRESS",
            deployment.map(|d| &d.root_registry_address),
        )?;
        Ok(Self {
            bind: read_parsed(
                lookup,
                "ISSUER_BIND",
                SocketAddr::from(([0, 0, 0, 0], ISSUER_PORT)),
            )?,
            database_path: read_parsed(lookup, "ISSUER_DB_PATH", PathBuf::from("data/issuer.db"))?,
            sepolia_rpc_url: read_optional(lookup, "SEPOLIA_RPC_URL"),
            private_key: read_optional(lookup, "ISSUER_PRIVATE_KEY"),
            start_block: read_parsed(lookup, "ISSUER_START_BLOCK", 0u64)?,
            index_poll_seconds: positive(
                "ISSUER_INDEX_POLL_SECONDS",
                read_parsed(lookup, "ISSUER_INDEX_POLL_SECONDS", 12u64)?,
            )?,
            publish_poll_seconds: positive(
                "ISSUER_PUBLISH_POLL_SECONDS",
                read_parsed(lookup, "ISSUER_PUBLISH_POLL_SECONDS", 5u64)?,
            )?,
            log_chunk_blocks: positive(
                "ISSUER_LOG_CHUNK_BLOCKS",
                read_parsed(lookup, "ISSUER_LOG_CHUNK_BLOCKS", 1000u64)?,
            )?,
            common,
        })
    }

    /// Summary lines for the log. Secret values are never included.
    pub fn summary_lines(&self) -> Vec<String> {
        let mut lines = self.common.summary_lines();
        lines.push(format!("bind: {}", self.bind));
        lines.push(format!("database: {}", self.database_path.display()));
        lines.push(format!("start block: {}", self.start_block));
        lines.push(format!(
            "poll seconds: index {}, publish {}",
            self.index_poll_seconds, self.publish_poll_seconds
        ));
        lines.push(format!("log chunk blocks: {}", self.log_chunk_blocks));
        lines.push(format!(
            "SEPOLIA_RPC_URL: {}",
            presence(&self.sepolia_rpc_url)
        ));
        lines.push(format!(
            "ISSUER_PRIVATE_KEY: {}",
            presence(&self.private_key)
        ));
        lines
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEMPLATE: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../config/deployment.testnet.template.toml"
    );

    #[test]
    fn defaults_bind_to_all_interfaces_8080_and_hide_secrets() {
        let lookup = |name: &str| match name {
            "ISSUER_PRIVATE_KEY" => Some("0xdeadbeef".to_owned()),
            "SEPOLIA_RPC_URL" => Some("https://rpc.example/key-abc".to_owned()),
            _ => None,
        };
        let settings = IssuerSettings::from_lookup(&lookup).unwrap();
        assert_eq!(settings.bind, SocketAddr::from(([0, 0, 0, 0], 8080)));
        assert_eq!(settings.database_path, PathBuf::from("data/issuer.db"));
        let summary = settings.summary_lines().join("\n");
        assert!(summary.contains("ISSUER_PRIVATE_KEY: set"));
        assert!(summary.contains("SEPOLIA_RPC_URL: set"));
        assert!(!summary.contains("deadbeef"));
        assert!(!summary.contains("key-abc"));
    }

    #[test]
    fn contract_addresses_must_match_the_deployment() {
        let zero = "0x0000000000000000000000000000000000000000";
        let other = "0x00000000000000000000000000000000000000aa";
        let matching = |name: &str| match name {
            "DEPLOYMENT_CONFIG" => Some(TEMPLATE.to_owned()),
            "SALE_ADDRESS" | "ROOT_REGISTRY_ADDRESS" => Some(zero.to_owned()),
            _ => None,
        };
        assert!(IssuerSettings::from_lookup(&matching).is_ok());
        let different = |name: &str| match name {
            "DEPLOYMENT_CONFIG" => Some(TEMPLATE.to_owned()),
            "SALE_ADDRESS" => Some(other.to_owned()),
            _ => None,
        };
        assert!(IssuerSettings::from_lookup(&different).is_err());
        let bad = |name: &str| match name {
            "ROOT_REGISTRY_ADDRESS" => Some("0xABC".to_owned()),
            _ => None,
        };
        assert!(IssuerSettings::from_lookup(&bad).is_err());
    }

    #[test]
    fn poll_intervals_must_be_positive() {
        let lookup = |name: &str| match name {
            "ISSUER_INDEX_POLL_SECONDS" => Some("0".to_owned()),
            _ => None,
        };
        assert!(IssuerSettings::from_lookup(&lookup).is_err());
    }
}

//! Issuer settings from environment variables.

use anon_credit_protocol::settings::{
    CommonSettings, ISSUER_PORT, SettingsError, presence, read_bind, read_optional, read_parsed,
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
    /// SQLite database path (`ISSUER_DATABASE_PATH`).
    pub database_path: PathBuf,
    /// Sepolia RPC for indexing and publication (`SEPOLIA_RPC_URL`). Secret.
    pub sepolia_rpc_url: Option<String>,
    /// Root publisher private key (`ISSUER_PUBLISHER_KEY`). Secret.
    pub publisher_key: Option<String>,
}

impl IssuerSettings {
    /// Read the settings with a lookup function.
    pub fn from_lookup(lookup: &impl Fn(&str) -> Option<String>) -> Result<Self, SettingsError> {
        Ok(Self {
            common: CommonSettings::from_lookup(lookup)?,
            bind: read_bind(lookup, "ISSUER_BIND", ISSUER_PORT)?,
            database_path: read_parsed(
                lookup,
                "ISSUER_DATABASE_PATH",
                PathBuf::from("data/issuer.db"),
            )?,
            sepolia_rpc_url: read_optional(lookup, "SEPOLIA_RPC_URL"),
            publisher_key: read_optional(lookup, "ISSUER_PUBLISHER_KEY"),
        })
    }

    /// Summary lines for the log. Secret values are never included.
    pub fn summary_lines(&self) -> Vec<String> {
        let mut lines = self.common.summary_lines();
        lines.push(format!("bind: {}", self.bind));
        lines.push(format!("database: {}", self.database_path.display()));
        lines.push(format!(
            "SEPOLIA_RPC_URL: {}",
            presence(&self.sepolia_rpc_url)
        ));
        lines.push(format!(
            "ISSUER_PUBLISHER_KEY: {}",
            presence(&self.publisher_key)
        ));
        lines
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_bind_to_loopback_8080_and_hide_secrets() {
        let lookup = |name: &str| match name {
            "ISSUER_PUBLISHER_KEY" => Some("0xdeadbeef".to_owned()),
            _ => None,
        };
        let settings = IssuerSettings::from_lookup(&lookup).unwrap();
        assert_eq!(settings.bind.port(), 8080);
        assert!(settings.bind.ip().is_loopback());
        let summary = settings.summary_lines().join("\n");
        assert!(summary.contains("ISSUER_PUBLISHER_KEY: set"));
        assert!(!summary.contains("deadbeef"));
    }
}

//! Helpers to read service settings from environment variables.
//!
//! Each reader takes a lookup function, so that tests do not change the process
//! environment. Services pass `|name| std::env::var(name).ok()`.
//!
//! Secrets (keys, tokens, RPC URLs that can contain API keys) come only from the
//! environment. Never write them into tracked configuration. Never print their values.

use crate::deployment::{DeploymentConfig, EPOCH_SECONDS_TESTNET};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::str::FromStr;

/// Default issuer HTTP port.
pub const ISSUER_PORT: u16 = 8080;
/// Default gateway public API port.
pub const GATEWAY_PUBLIC_PORT: u16 = 8081;
/// Default gateway admin API port.
pub const GATEWAY_ADMIN_PORT: u16 = 8082;
/// Default port of the end-to-end browser page in development.
pub const DEV_PAGE_PORT: u16 = 5173;
/// Default port of the dashboard in development.
pub const DASHBOARD_PORT: u16 = 5174;

/// Failure to read a setting.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SettingsError {
    /// The value does not parse.
    #[error("environment variable {name} has an invalid value: {reason}")]
    Invalid {
        /// Variable name.
        name: &'static str,
        /// Reason for the failure.
        reason: String,
    },
}

/// Name of the variable with the epoch length in seconds.
pub const EPOCH_SECONDS_VAR: &str = "EPOCH_SECONDS";
/// Name of the variable with the path of the deployment TOML file.
pub const DEPLOYMENT_CONFIG_VAR: &str = "DEPLOYMENT_CONFIG";
/// Name of the variable with the block tag of the chain readers.
pub const BLOCK_TAG_VAR: &str = "BLOCK_TAG";

/// The block tag at which the chain readers trust the chain (`BLOCK_TAG`).
///
/// The issuer sale indexer, the issuer root publisher, and the gateway root source read the
/// chain at this tag. Production uses `finalized`. `safe` and `latest` give less protection
/// from a reorganization. `latest` trades reorg safety for speed: use it only on a testnet.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BlockTag {
    /// `finalized` (default): the block cannot be reverted without a large slashing.
    #[default]
    Finalized,
    /// `safe`: the block has a supermajority attestation. A reorganization is unlikely.
    Safe,
    /// `latest`: the newest block. A reorganization can remove it. Testnet only.
    Latest,
}

impl BlockTag {
    /// The text of the tag.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Finalized => "finalized",
            Self::Safe => "safe",
            Self::Latest => "latest",
        }
    }
}

impl std::fmt::Display for BlockTag {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for BlockTag {
    type Err = String;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        match text {
            "finalized" => Ok(Self::Finalized),
            "safe" => Ok(Self::Safe),
            "latest" => Ok(Self::Latest),
            _ => Err("must be finalized, safe, or latest".to_owned()),
        }
    }
}

/// Settings that the issuer and the gateway share.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommonSettings {
    /// Epoch length in seconds. Testnet uses 30. Production uses 900.
    pub epoch_seconds: u32,
    /// Deployment file path and its parsed contents, if `DEPLOYMENT_CONFIG` is set.
    pub deployment: Option<(PathBuf, DeploymentConfig)>,
    /// Block tag of the chain readers (`BLOCK_TAG`). Default: `finalized`.
    pub block_tag: BlockTag,
}

impl CommonSettings {
    /// Read the shared settings.
    ///
    /// If a deployment file is set, its `epoch_seconds` is the effective value.
    /// Then `EPOCH_SECONDS`, if set, must have the same value. A mismatch is an error,
    /// because the epoch length is part of `deployment_id`.
    pub fn from_lookup(lookup: &impl Fn(&str) -> Option<String>) -> Result<Self, SettingsError> {
        let env_epoch: Option<u32> = match read_optional(lookup, EPOCH_SECONDS_VAR) {
            None => None,
            Some(text) => Some(text.parse::<u32>().map_err(|e| SettingsError::Invalid {
                name: EPOCH_SECONDS_VAR,
                reason: e.to_string(),
            })?),
        };
        if env_epoch == Some(0) {
            return Err(SettingsError::Invalid {
                name: EPOCH_SECONDS_VAR,
                reason: "must be greater than zero".to_owned(),
            });
        }
        let deployment = match read_optional(lookup, DEPLOYMENT_CONFIG_VAR) {
            None => None,
            Some(path) => {
                let path = PathBuf::from(path);
                let text = std::fs::read_to_string(&path).map_err(|e| SettingsError::Invalid {
                    name: DEPLOYMENT_CONFIG_VAR,
                    reason: format!("cannot read {}: {e}", path.display()),
                })?;
                let config =
                    DeploymentConfig::from_toml_str(&text).map_err(|e| SettingsError::Invalid {
                        name: DEPLOYMENT_CONFIG_VAR,
                        reason: e.to_string(),
                    })?;
                Some((path, config))
            }
        };
        let epoch_seconds = match (&deployment, env_epoch) {
            (Some((_, config)), Some(value)) if value != config.epoch_seconds => {
                return Err(SettingsError::Invalid {
                    name: EPOCH_SECONDS_VAR,
                    reason: format!(
                        "value {value} differs from deployment epoch_seconds {}",
                        config.epoch_seconds
                    ),
                });
            }
            (Some((_, config)), _) => config.epoch_seconds,
            (None, Some(value)) => value,
            (None, None) => EPOCH_SECONDS_TESTNET,
        };
        Ok(Self {
            epoch_seconds,
            deployment,
            block_tag: read_parsed(lookup, BLOCK_TAG_VAR, BlockTag::Finalized)?,
        })
    }

    /// Write the summary lines for the shared settings.
    pub fn summary_lines(&self) -> Vec<String> {
        let mut lines = vec![
            format!("epoch_seconds: {}", self.epoch_seconds),
            format!("block tag: {}", self.block_tag),
        ];
        if self.block_tag != BlockTag::Finalized {
            lines.push(format!(
                "WARNING: BLOCK_TAG={} trades reorg safety for speed; use it only on a testnet",
                self.block_tag
            ));
        }
        match &self.deployment {
            None => lines.push("deployment: not set (DEPLOYMENT_CONFIG)".to_owned()),
            Some((path, config)) => {
                lines.push(format!("deployment file: {}", path.display()));
                lines.push(format!("deployment_id: {}", config.deployment_id()));
                lines.push(format!("payment_chain_id: {}", config.payment_chain_id));
                lines.push(format!("gateway_id: {}", config.gateway_id));
                lines.push(format!("batch_size: {}", config.batch_size));
                let placeholders = config.placeholder_fields();
                if !placeholders.is_empty() {
                    lines.push(format!(
                        "WARNING: placeholder values in: {}",
                        placeholders.join(", ")
                    ));
                }
            }
        }
        lines
    }
}

/// Read a strict boolean. Accept only `true` or `false`.
pub fn read_bool(
    lookup: &impl Fn(&str) -> Option<String>,
    name: &'static str,
    default: bool,
) -> Result<bool, SettingsError> {
    match lookup(name).as_deref() {
        None => Ok(default),
        Some("true") => Ok(true),
        Some("false") => Ok(false),
        Some(_) => Err(SettingsError::Invalid {
            name,
            reason: "expected true or false".to_owned(),
        }),
    }
}

/// Read a value that implements [`FromStr`], or use the default.
pub fn read_parsed<T>(
    lookup: &impl Fn(&str) -> Option<String>,
    name: &'static str,
    default: T,
) -> Result<T, SettingsError>
where
    T: FromStr,
    T::Err: std::fmt::Display,
{
    match lookup(name) {
        None => Ok(default),
        Some(text) => text.parse::<T>().map_err(|e| SettingsError::Invalid {
            name,
            reason: e.to_string(),
        }),
    }
}

/// Read a socket address, or use `127.0.0.1:<default_port>`.
pub fn read_bind(
    lookup: &impl Fn(&str) -> Option<String>,
    name: &'static str,
    default_port: u16,
) -> Result<SocketAddr, SettingsError> {
    read_parsed(
        lookup,
        name,
        SocketAddr::from(([127, 0, 0, 1], default_port)),
    )
}

/// Read an optional string. An empty value counts as not set.
pub fn read_optional(lookup: &impl Fn(&str) -> Option<String>, name: &str) -> Option<String> {
    lookup(name).filter(|value| !value.is_empty())
}

/// Text for a summary line about a secret: `set` or `not set`. Never the value.
pub fn presence(value: &Option<String>) -> &'static str {
    match value {
        Some(_) => "set",
        None => "not set",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        move |name| map.get(name).cloned()
    }

    #[test]
    fn bool_is_strict() {
        let lookup = env(&[("A", "true"), ("B", "1")]);
        assert_eq!(read_bool(&lookup, "A", false), Ok(true));
        assert!(read_bool(&lookup, "B", false).is_err());
        assert_eq!(read_bool(&lookup, "C", false), Ok(false));
    }

    #[test]
    fn parsed_uses_default_and_rejects_garbage() {
        let lookup = env(&[("N", "900"), ("BAD", "x")]);
        assert_eq!(read_parsed(&lookup, "N", 30u32), Ok(900));
        assert_eq!(read_parsed(&lookup, "MISSING", 30u32), Ok(30));
        assert!(read_parsed(&lookup, "BAD", 30u32).is_err());
    }

    #[test]
    fn bind_defaults_to_loopback() {
        let lookup = env(&[]);
        let addr = read_bind(&lookup, "BIND", GATEWAY_ADMIN_PORT).unwrap();
        assert!(addr.ip().is_loopback());
        assert_eq!(addr.port(), 8082);
    }

    #[test]
    fn common_defaults_to_testnet_epoch() {
        let settings = CommonSettings::from_lookup(&env(&[])).unwrap();
        assert_eq!(settings.epoch_seconds, 30);
        assert!(settings.deployment.is_none());
    }

    #[test]
    fn common_reads_epoch_and_rejects_zero() {
        let settings = CommonSettings::from_lookup(&env(&[("EPOCH_SECONDS", "900")])).unwrap();
        assert_eq!(settings.epoch_seconds, 900);
        assert!(CommonSettings::from_lookup(&env(&[("EPOCH_SECONDS", "0")])).is_err());
    }

    #[test]
    fn common_rejects_epoch_mismatch_with_template() {
        let template = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../config/deployment.testnet.template.toml"
        );
        let settings =
            CommonSettings::from_lookup(&env(&[("DEPLOYMENT_CONFIG", template)])).unwrap();
        assert_eq!(settings.epoch_seconds, 30);
        let mismatch = CommonSettings::from_lookup(&env(&[
            ("DEPLOYMENT_CONFIG", template),
            ("EPOCH_SECONDS", "900"),
        ]));
        assert!(mismatch.is_err());
    }

    /// The `KEY=value` pairs of an env example file. Comments and empty values are not set.
    fn env_file(name: &str) -> impl Fn(&str) -> Option<String> {
        let path = format!("{}/../../config/{name}", env!("CARGO_MANIFEST_DIR"));
        let text = std::fs::read_to_string(&path).unwrap();
        let map: HashMap<String, String> = text
            .lines()
            .filter(|line| !line.starts_with('#'))
            .filter_map(|line| line.split_once('='))
            .filter(|(_, value)| !value.is_empty())
            .map(|(key, value)| (key.to_owned(), value.to_owned()))
            .collect();
        move |name| map.get(name).cloned()
    }

    #[test]
    fn block_tag_defaults_to_finalized_and_rejects_other_text() {
        let settings = CommonSettings::from_lookup(&env(&[])).unwrap();
        assert_eq!(settings.block_tag, BlockTag::Finalized);
        assert!(!settings.summary_lines().join("\n").contains("WARNING"));
        for (text, tag) in [
            ("finalized", BlockTag::Finalized),
            ("safe", BlockTag::Safe),
            ("latest", BlockTag::Latest),
        ] {
            let settings = CommonSettings::from_lookup(&env(&[("BLOCK_TAG", text)])).unwrap();
            assert_eq!(settings.block_tag, tag);
            assert_eq!(serde_json::to_value(tag).unwrap(), text);
        }
        let latest = CommonSettings::from_lookup(&env(&[("BLOCK_TAG", "latest")])).unwrap();
        assert!(
            latest
                .summary_lines()
                .join("\n")
                .contains("WARNING: BLOCK_TAG=latest")
        );
        for bad in ["Finalized", "pending", "earliest", "0x10"] {
            assert!(CommonSettings::from_lookup(&env(&[("BLOCK_TAG", bad)])).is_err());
        }
    }

    #[test]
    fn production_example_keeps_the_finalized_tag() {
        let production = CommonSettings::from_lookup(&env_file("production.env.example")).unwrap();
        assert_eq!(production.epoch_seconds, 900);
        assert_eq!(production.block_tag, BlockTag::Finalized);
        // The demo example points at a deployment file that git ignores. Read only the tag.
        let demo_tag = read_parsed(
            &env_file("testnet-demo.env.example"),
            BLOCK_TAG_VAR,
            BlockTag::Finalized,
        )
        .unwrap();
        assert_eq!(demo_tag, BlockTag::Latest);
    }

    #[test]
    fn presence_hides_value() {
        assert_eq!(presence(&Some("secret".to_owned())), "set");
        assert_eq!(presence(&None), "not set");
    }
}

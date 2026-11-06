//! Helpers to read service settings from environment variables.
//!
//! Each reader takes a lookup function, so that tests do not change the process
//! environment. Services pass `|name| std::env::var(name).ok()`.
//!
//! Secrets (keys, tokens, RPC URLs that can contain API keys) come only from the
//! environment. Never write them into tracked configuration. Never print their values.

use crate::deployment::{DeploymentConfig, EPOCH_SECONDS_TESTNET};
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

/// Settings that the issuer and the gateway share.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommonSettings {
    /// Epoch length in seconds. Testnet uses 30. Production uses 900.
    pub epoch_seconds: u32,
    /// Deployment file path and its parsed contents, if `DEPLOYMENT_CONFIG` is set.
    pub deployment: Option<(PathBuf, DeploymentConfig)>,
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
        })
    }

    /// Write the summary lines for the shared settings.
    pub fn summary_lines(&self) -> Vec<String> {
        let mut lines = vec![format!("epoch_seconds: {}", self.epoch_seconds)];
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

    #[test]
    fn presence_hides_value() {
        assert_eq!(presence(&Some("secret".to_owned())), "set");
        assert_eq!(presence(&None), "not set");
    }
}

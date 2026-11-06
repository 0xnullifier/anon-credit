//! Helpers to read service settings from environment variables.
//!
//! Each reader takes a lookup function, so that tests do not change the process
//! environment. Services pass `|name| std::env::var(name).ok()`.
//!
//! Secrets (keys, tokens, RPC URLs that can contain API keys) come only from the
//! environment. Never write them into tracked configuration. Never print their values.

use std::net::SocketAddr;
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
    fn presence_hides_value() {
        assert_eq!(presence(&Some("secret".to_owned())), "set");
        assert_eq!(presence(&None), "not set");
    }
}

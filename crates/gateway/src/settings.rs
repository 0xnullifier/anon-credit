//! Gateway settings from environment variables.

use anon_credit_protocol::settings::{
    CommonSettings, GATEWAY_ADMIN_PORT, GATEWAY_PUBLIC_PORT, SettingsError, presence, read_bind,
    read_bool, read_optional, read_parsed,
};
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;

/// Default origins for CORS: the development browser page and the dashboard.
pub const DEFAULT_CORS_ORIGINS: &str = "http://localhost:5173,http://localhost:5174";

/// Gateway settings.
#[derive(Debug, Clone)]
pub struct GatewaySettings {
    /// Shared settings.
    pub common: CommonSettings,
    /// Public API listen address (`GATEWAY_PUBLIC_BIND`).
    pub public_bind: SocketAddr,
    /// Admin API listen address (`GATEWAY_ADMIN_BIND`). Loopback by default.
    pub admin_bind: SocketAddr,
    /// SQLite database path (`GATEWAY_DATABASE_PATH`).
    pub database_path: PathBuf,
    /// Upstream RPC for paid reads (`GATEWAY_UPSTREAM_RPC_URL`). Secret.
    pub upstream_rpc_url: Option<String>,
    /// RPC to read roots (`GATEWAY_ROOT_RPC_URL`, else `SEPOLIA_RPC_URL`). Secret.
    pub root_rpc_url: Option<String>,
    /// Admin bearer token (`GATEWAY_ADMIN_TOKEN`). Secret.
    pub admin_token: Option<String>,
    /// Demo profile: capture the observed source IP (`DEMO_IP_LOGGING`). Default `false`.
    pub demo_ip_logging: bool,
    /// Trusted reverse proxy address (`GATEWAY_TRUSTED_PROXY`).
    pub trusted_proxy: Option<IpAddr>,
    /// Allowed CORS origins (`GATEWAY_CORS_ORIGINS`), comma separated.
    pub cors_origins: Vec<String>,
}

impl GatewaySettings {
    /// Read the settings with a lookup function.
    pub fn from_lookup(lookup: &impl Fn(&str) -> Option<String>) -> Result<Self, SettingsError> {
        let trusted_proxy = match read_optional(lookup, "GATEWAY_TRUSTED_PROXY") {
            None => None,
            Some(text) => Some(text.parse::<IpAddr>().map_err(|e| SettingsError::Invalid {
                name: "GATEWAY_TRUSTED_PROXY",
                reason: e.to_string(),
            })?),
        };
        let cors_origins = read_optional(lookup, "GATEWAY_CORS_ORIGINS")
            .unwrap_or_else(|| DEFAULT_CORS_ORIGINS.to_owned())
            .split(',')
            .map(str::trim)
            .filter(|origin| !origin.is_empty())
            .map(str::to_owned)
            .collect();
        Ok(Self {
            common: CommonSettings::from_lookup(lookup)?,
            public_bind: read_bind(lookup, "GATEWAY_PUBLIC_BIND", GATEWAY_PUBLIC_PORT)?,
            admin_bind: read_bind(lookup, "GATEWAY_ADMIN_BIND", GATEWAY_ADMIN_PORT)?,
            database_path: read_parsed(
                lookup,
                "GATEWAY_DATABASE_PATH",
                PathBuf::from("data/gateway.db"),
            )?,
            upstream_rpc_url: read_optional(lookup, "GATEWAY_UPSTREAM_RPC_URL"),
            root_rpc_url: read_optional(lookup, "GATEWAY_ROOT_RPC_URL")
                .or_else(|| read_optional(lookup, "SEPOLIA_RPC_URL")),
            admin_token: read_optional(lookup, "GATEWAY_ADMIN_TOKEN"),
            demo_ip_logging: read_bool(lookup, "DEMO_IP_LOGGING", false)?,
            trusted_proxy,
            cors_origins,
        })
    }

    /// Summary lines for the log. Secret values are never included.
    pub fn summary_lines(&self) -> Vec<String> {
        let mut lines = self.common.summary_lines();
        lines.push(format!("public bind: {}", self.public_bind));
        lines.push(format!("admin bind: {}", self.admin_bind));
        if !self.admin_bind.ip().is_loopback() {
            lines.push("WARNING: admin listener is not on loopback; keep it private".to_owned());
        }
        lines.push(format!("database: {}", self.database_path.display()));
        lines.push(format!(
            "GATEWAY_UPSTREAM_RPC_URL: {}",
            presence(&self.upstream_rpc_url)
        ));
        lines.push(format!("root RPC URL: {}", presence(&self.root_rpc_url)));
        lines.push(format!(
            "GATEWAY_ADMIN_TOKEN: {}",
            presence(&self.admin_token)
        ));
        lines.push(format!("DEMO_IP_LOGGING: {}", self.demo_ip_logging));
        let proxy = match self.trusted_proxy {
            Some(ip) => ip.to_string(),
            None => "none (use socket peer address)".to_owned(),
        };
        lines.push(format!("trusted proxy: {proxy}"));
        lines.push(format!("CORS origins: {}", self.cors_origins.join(", ")));
        lines
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lookup_from(
        pairs: &'static [(&'static str, &'static str)],
    ) -> impl Fn(&str) -> Option<String> {
        move |name| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_owned())
        }
    }

    #[test]
    fn defaults_match_implementation_plan() {
        let settings = GatewaySettings::from_lookup(&lookup_from(&[])).unwrap();
        assert_eq!(settings.public_bind.port(), 8081);
        assert_eq!(settings.admin_bind.port(), 8082);
        assert!(settings.admin_bind.ip().is_loopback());
        assert!(!settings.demo_ip_logging);
        assert_eq!(settings.cors_origins.len(), 2);
    }

    #[test]
    fn root_rpc_falls_back_to_sepolia_rpc() {
        let settings =
            GatewaySettings::from_lookup(&lookup_from(&[("SEPOLIA_RPC_URL", "https://x")]))
                .unwrap();
        assert_eq!(settings.root_rpc_url.as_deref(), Some("https://x"));
    }

    #[test]
    fn summary_hides_admin_token() {
        let settings = GatewaySettings::from_lookup(&lookup_from(&[(
            "GATEWAY_ADMIN_TOKEN",
            "token-value-123",
        )]))
        .unwrap();
        let summary = settings.summary_lines().join("\n");
        assert!(summary.contains("GATEWAY_ADMIN_TOKEN: set"));
        assert!(!summary.contains("token-value-123"));
    }

    #[test]
    fn rejects_bad_trusted_proxy() {
        let result =
            GatewaySettings::from_lookup(&lookup_from(&[("GATEWAY_TRUSTED_PROXY", "not-an-ip")]));
        assert!(result.is_err());
    }
}

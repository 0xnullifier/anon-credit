//! Gateway settings from environment variables.
//!
//! The README lists each variable. Secrets (the admin token and RPC URLs with API keys) come
//! only from the environment. The summary prints `set` or `not set` for them.

use crate::app::Limits;
use crate::peer::DEFAULT_FORWARDED_HEADER;
use crate::upload::UploadLimits;
use anon_credit_protocol::settings::{
    CommonSettings, GATEWAY_ADMIN_PORT, GATEWAY_PUBLIC_PORT, SettingsError, presence, read_bind,
    read_bool, read_optional, read_parsed,
};
use axum::http::HeaderName;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::time::Duration;

/// Default address of the ProveKit verifier sidecar.
pub const DEFAULT_VERIFIER_URL: &str = "http://127.0.0.1:8083";

/// Default interval between root refreshes, in seconds.
pub const DEFAULT_ROOT_POLL_SECONDS: u64 = 10;

/// Shortest admin token that the gateway accepts.
pub const MIN_ADMIN_TOKEN_LEN: usize = 16;

/// Default origins for CORS: the development browser page and the dashboard.
pub const DEFAULT_CORS_ORIGINS: &str = "http://localhost:5173,http://localhost:5174";

/// Source of accepted roots (`GATEWAY_ROOT_SOURCE`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RootSourceKind {
    /// `contract` (default): `RootRegistry` at the `finalized` block tag.
    Contract,
    /// `issuer-http`: the issuer `GET /v1/roots`, only `finalized` records. Local runs only.
    IssuerHttp,
}

impl RootSourceKind {
    /// The text of the setting.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Contract => "contract",
            Self::IssuerHttp => "issuer-http",
        }
    }
}

fn read_root_source(
    lookup: &impl Fn(&str) -> Option<String>,
) -> Result<RootSourceKind, SettingsError> {
    match read_optional(lookup, "GATEWAY_ROOT_SOURCE").as_deref() {
        None | Some("contract") => Ok(RootSourceKind::Contract),
        Some("issuer-http") => Ok(RootSourceKind::IssuerHttp),
        Some(_) => Err(invalid(
            "GATEWAY_ROOT_SOURCE",
            "must be contract or issuer-http",
        )),
    }
}

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
    /// Source of accepted roots (`GATEWAY_ROOT_SOURCE`). Default: the contract.
    pub root_source: RootSourceKind,
    /// Issuer base URL for the `issuer-http` root source (`GATEWAY_ROOT_ISSUER_URL`).
    pub root_issuer_url: Option<String>,
    /// Admin bearer token (`GATEWAY_ADMIN_TOKEN`). Secret.
    pub admin_token: Option<String>,
    /// Demo profile: capture the observed source IP (`DEMO_IP_LOGGING`). Default `false`.
    pub demo_ip_logging: bool,
    /// Trusted reverse proxy addresses (`GATEWAY_TRUSTED_PROXY_ADDRS`, comma separated, and
    /// the older single-value `GATEWAY_TRUSTED_PROXY`).
    pub trusted_proxies: Vec<IpAddr>,
    /// Forwarding header that a trusted proxy sets (`GATEWAY_FORWARDED_HEADER`).
    pub forwarded_header: HeaderName,
    /// Allowed CORS origins (`GATEWAY_CORS_ORIGINS`), comma separated.
    pub cors_origins: Vec<String>,
    /// Verifier sidecar base URL (`GATEWAY_VERIFIER_URL`).
    pub verifier_url: String,
    /// Expected upstream chain ID (`GATEWAY_UPSTREAM_CHAIN_ID`). Default: the deployment
    /// `payment_chain_id`.
    pub upstream_chain_id: Option<u64>,
    /// Interval between root refreshes (`GATEWAY_ROOT_POLL_SECONDS`).
    pub root_poll_seconds: u64,
    /// Resource limits (`GATEWAY_*_LIMIT_BYTES`, `GATEWAY_UPSTREAM_TIMEOUT_MS`,
    /// `GATEWAY_PROOF_CONCURRENCY`, `GATEWAY_PROOF_QUEUE_DEPTH`, `GATEWAY_OPEN_UPLOAD_*`).
    pub limits: Limits,
}

fn invalid(name: &'static str, reason: impl Into<String>) -> SettingsError {
    SettingsError::Invalid {
        name,
        reason: reason.into(),
    }
}

fn read_ip_list(
    lookup: &impl Fn(&str) -> Option<String>,
    name: &'static str,
) -> Result<Vec<IpAddr>, SettingsError> {
    read_optional(lookup, name)
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(|text| {
            text.parse::<IpAddr>()
                .map_err(|e| invalid(name, e.to_string()))
        })
        .collect()
}

fn read_positive(
    lookup: &impl Fn(&str) -> Option<String>,
    name: &'static str,
    default: u64,
) -> Result<u64, SettingsError> {
    match read_parsed(lookup, name, default)? {
        0 => Err(invalid(name, "must be greater than zero")),
        value => Ok(value),
    }
}

fn read_size(
    lookup: &impl Fn(&str) -> Option<String>,
    name: &'static str,
    default: usize,
) -> Result<usize, SettingsError> {
    let value = read_positive(lookup, name, default as u64)?;
    usize::try_from(value).map_err(|_| invalid(name, "value is too large"))
}

/// Largest value of `GATEWAY_OPEN_UPLOAD_MAX_BYTES`: the sidecar proof limit (4 MiB).
pub const MAX_OPEN_UPLOAD_BYTES: usize = 4 * 1024 * 1024;

fn read_upload_limits(
    lookup: &impl Fn(&str) -> Option<String>,
) -> Result<UploadLimits, SettingsError> {
    let defaults = UploadLimits::default();
    let max_bytes = read_size(lookup, "GATEWAY_OPEN_UPLOAD_MAX_BYTES", defaults.max_bytes)?;
    if max_bytes > MAX_OPEN_UPLOAD_BYTES {
        return Err(invalid(
            "GATEWAY_OPEN_UPLOAD_MAX_BYTES",
            "must be at most 4194304 (the verifier proof limit)",
        ));
    }
    let max_chunks = u32::try_from(read_positive(
        lookup,
        "GATEWAY_OPEN_UPLOAD_MAX_CHUNKS",
        u64::from(defaults.max_chunks),
    )?)
    .map_err(|_| invalid("GATEWAY_OPEN_UPLOAD_MAX_CHUNKS", "value is too large"))?;
    let max_pending_bytes = read_size(
        lookup,
        "GATEWAY_OPEN_UPLOAD_MAX_PENDING_BYTES",
        defaults.max_pending_bytes,
    )?;
    if max_pending_bytes < max_bytes {
        return Err(invalid(
            "GATEWAY_OPEN_UPLOAD_MAX_PENDING_BYTES",
            "must be at least GATEWAY_OPEN_UPLOAD_MAX_BYTES",
        ));
    }
    Ok(UploadLimits {
        max_bytes,
        max_chunks,
        ttl_secs: read_positive(lookup, "GATEWAY_OPEN_UPLOAD_TTL_SECONDS", defaults.ttl_secs)?,
        max_pending: read_size(
            lookup,
            "GATEWAY_OPEN_UPLOAD_MAX_PENDING",
            defaults.max_pending,
        )?,
        max_pending_bytes,
    })
}

fn read_limits(lookup: &impl Fn(&str) -> Option<String>) -> Result<Limits, SettingsError> {
    let defaults = Limits::default();
    Ok(Limits {
        open_body_bytes: read_size(
            lookup,
            "GATEWAY_OPEN_BODY_LIMIT_BYTES",
            defaults.open_body_bytes,
        )?,
        spend_body_bytes: read_size(
            lookup,
            "GATEWAY_SPEND_BODY_LIMIT_BYTES",
            defaults.spend_body_bytes,
        )?,
        upstream_response_bytes: read_size(
            lookup,
            "GATEWAY_UPSTREAM_RESPONSE_LIMIT_BYTES",
            defaults.upstream_response_bytes,
        )?,
        upstream_timeout: Duration::from_millis(read_positive(
            lookup,
            "GATEWAY_UPSTREAM_TIMEOUT_MS",
            15_000,
        )?),
        proof_concurrency: read_size(
            lookup,
            "GATEWAY_PROOF_CONCURRENCY",
            defaults.proof_concurrency,
        )?,
        proof_queue_depth: read_parsed(
            lookup,
            "GATEWAY_PROOF_QUEUE_DEPTH",
            defaults.proof_queue_depth,
        )?,
        response_retention_secs: defaults.response_retention_secs,
        batch_lock_wait: defaults.batch_lock_wait,
        upload: read_upload_limits(lookup)?,
    })
}

impl GatewaySettings {
    /// Read the settings with a lookup function.
    pub fn from_lookup(lookup: &impl Fn(&str) -> Option<String>) -> Result<Self, SettingsError> {
        let mut trusted_proxies = read_ip_list(lookup, "GATEWAY_TRUSTED_PROXY_ADDRS")?;
        trusted_proxies.extend(read_ip_list(lookup, "GATEWAY_TRUSTED_PROXY")?);
        let forwarded_header = read_optional(lookup, "GATEWAY_FORWARDED_HEADER")
            .unwrap_or_else(|| DEFAULT_FORWARDED_HEADER.to_owned())
            .to_ascii_lowercase()
            .parse::<HeaderName>()
            .map_err(|e| invalid("GATEWAY_FORWARDED_HEADER", e.to_string()))?;
        let upstream_chain_id = match read_optional(lookup, "GATEWAY_UPSTREAM_CHAIN_ID") {
            None => None,
            Some(text) => Some(
                text.parse::<u64>()
                    .map_err(|e| invalid("GATEWAY_UPSTREAM_CHAIN_ID", e.to_string()))?,
            ),
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
            public_bind: read_parsed(
                lookup,
                "GATEWAY_PUBLIC_BIND",
                SocketAddr::from(([0, 0, 0, 0], GATEWAY_PUBLIC_PORT)),
            )?,
            admin_bind: read_bind(lookup, "GATEWAY_ADMIN_BIND", GATEWAY_ADMIN_PORT)?,
            database_path: read_parsed(
                lookup,
                "GATEWAY_DATABASE_PATH",
                PathBuf::from("data/gateway.db"),
            )?,
            upstream_rpc_url: read_optional(lookup, "GATEWAY_UPSTREAM_RPC_URL"),
            root_rpc_url: read_optional(lookup, "GATEWAY_ROOT_RPC_URL")
                .or_else(|| read_optional(lookup, "SEPOLIA_RPC_URL")),
            root_source: read_root_source(lookup)?,
            root_issuer_url: read_optional(lookup, "GATEWAY_ROOT_ISSUER_URL"),
            admin_token: read_optional(lookup, "GATEWAY_ADMIN_TOKEN"),
            demo_ip_logging: read_bool(lookup, "DEMO_IP_LOGGING", false)?,
            trusted_proxies,
            forwarded_header,
            cors_origins,
            verifier_url: read_optional(lookup, "GATEWAY_VERIFIER_URL")
                .unwrap_or_else(|| DEFAULT_VERIFIER_URL.to_owned()),
            upstream_chain_id,
            root_poll_seconds: read_positive(
                lookup,
                "GATEWAY_ROOT_POLL_SECONDS",
                DEFAULT_ROOT_POLL_SECONDS,
            )?,
            limits: read_limits(lookup)?,
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
        lines.push(format!("root source: {}", self.root_source.as_str()));
        match self.root_source {
            RootSourceKind::Contract => {
                lines.push(format!("root RPC URL: {}", presence(&self.root_rpc_url)));
            }
            RootSourceKind::IssuerHttp => {
                lines.push(format!(
                    "GATEWAY_ROOT_ISSUER_URL: {}",
                    presence(&self.root_issuer_url)
                ));
                lines.push(
                    "WARNING: issuer-http root source trusts the issuer; use it only for local runs"
                        .to_owned(),
                );
            }
        }
        lines.push(format!(
            "GATEWAY_ADMIN_TOKEN: {}",
            presence(&self.admin_token)
        ));
        lines.push(format!("DEMO_IP_LOGGING: {}", self.demo_ip_logging));
        let proxies = match self.trusted_proxies.is_empty() {
            true => "none (use socket peer address)".to_owned(),
            false => format!("{} configured", self.trusted_proxies.len()),
        };
        lines.push(format!("trusted proxies: {proxies}"));
        lines.push(format!("forwarding header: {}", self.forwarded_header));
        lines.push(format!("CORS origins: {}", self.cors_origins.join(", ")));
        lines.push(format!("verifier sidecar: {}", self.verifier_url));
        lines.push(format!("root poll seconds: {}", self.root_poll_seconds));
        let limits = self.limits.to_api();
        lines.push(format!(
            "limits: open {} B, spend {} B, upstream {} B, timeout {} ms, proofs {} (+{} queued)",
            limits.open_body_bytes,
            limits.spend_body_bytes,
            limits.upstream_response_bytes,
            limits.upstream_timeout_ms,
            limits.proof_verify_concurrency,
            limits.proof_queue_depth
        ));
        lines.push(format!(
            "open uploads: {} B each, {} chunks, ttl {} s, {} pending, {} B pending",
            limits.open_upload_max_bytes,
            limits.open_upload_max_chunks,
            limits.open_upload_ttl_seconds,
            limits.open_upload_max_pending,
            limits.open_upload_max_pending_bytes
        ));
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
        assert!(settings.public_bind.ip().is_unspecified());
        assert_eq!(settings.admin_bind.port(), 8082);
        assert_eq!(settings.limits, Limits::default());
        assert_eq!(settings.verifier_url, DEFAULT_VERIFIER_URL);
        assert_eq!(settings.forwarded_header.as_str(), "x-forwarded-for");
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
    fn reads_trusted_proxy_list_and_limits() {
        let settings = GatewaySettings::from_lookup(&lookup_from(&[
            ("GATEWAY_TRUSTED_PROXY_ADDRS", "10.0.0.1, ::1"),
            ("GATEWAY_TRUSTED_PROXY", "10.0.0.2"),
            ("GATEWAY_SPEND_BODY_LIMIT_BYTES", "1024"),
            ("GATEWAY_FORWARDED_HEADER", "X-Real-IP"),
        ]))
        .unwrap();
        assert_eq!(settings.trusted_proxies.len(), 3);
        assert_eq!(settings.limits.spend_body_bytes, 1024);
        assert_eq!(settings.forwarded_header.as_str(), "x-real-ip");
        assert!(
            GatewaySettings::from_lookup(&lookup_from(&[("GATEWAY_PROOF_CONCURRENCY", "0")]))
                .is_err()
        );
    }

    #[test]
    fn root_source_defaults_to_contract_and_reads_issuer_http() {
        let settings = GatewaySettings::from_lookup(&lookup_from(&[])).unwrap();
        assert_eq!(settings.root_source, RootSourceKind::Contract);
        let settings = GatewaySettings::from_lookup(&lookup_from(&[
            ("GATEWAY_ROOT_SOURCE", "issuer-http"),
            ("GATEWAY_ROOT_ISSUER_URL", "http://127.0.0.1:8080"),
        ]))
        .unwrap();
        assert_eq!(settings.root_source, RootSourceKind::IssuerHttp);
        assert_eq!(
            settings.root_issuer_url.as_deref(),
            Some("http://127.0.0.1:8080")
        );
        assert!(
            settings
                .summary_lines()
                .join("\n")
                .contains("root source: issuer-http")
        );
        assert!(
            GatewaySettings::from_lookup(&lookup_from(&[("GATEWAY_ROOT_SOURCE", "issuer")]))
                .is_err()
        );
    }

    #[test]
    fn reads_open_upload_limits() {
        let defaults = GatewaySettings::from_lookup(&lookup_from(&[])).unwrap();
        assert_eq!(defaults.limits.upload, UploadLimits::default());
        let api = defaults.limits.to_api();
        assert_eq!(api.open_upload_max_bytes, 4_194_304);
        assert_eq!(api.open_upload_max_chunks, 256);
        assert_eq!(api.open_upload_ttl_seconds, 600);
        assert_eq!(api.open_upload_max_pending, 1000);
        assert_eq!(api.open_upload_max_pending_bytes, 536_870_912);
        assert_eq!(api.open_upload_chunk_bytes, 24_576);
        assert_eq!(api.open_upload_chunk_body_bytes, 40_000);
        let settings = GatewaySettings::from_lookup(&lookup_from(&[
            ("GATEWAY_OPEN_UPLOAD_MAX_BYTES", "1000000"),
            ("GATEWAY_OPEN_UPLOAD_MAX_CHUNKS", "64"),
            ("GATEWAY_OPEN_UPLOAD_TTL_SECONDS", "30"),
            ("GATEWAY_OPEN_UPLOAD_MAX_PENDING", "10"),
            ("GATEWAY_OPEN_UPLOAD_MAX_PENDING_BYTES", "2000000"),
        ]))
        .unwrap();
        assert_eq!(
            settings.limits.upload,
            UploadLimits {
                max_bytes: 1_000_000,
                max_chunks: 64,
                ttl_secs: 30,
                max_pending: 10,
                max_pending_bytes: 2_000_000,
            }
        );
        for pairs in [
            &[("GATEWAY_OPEN_UPLOAD_MAX_BYTES", "4194305")][..],
            &[("GATEWAY_OPEN_UPLOAD_MAX_CHUNKS", "0")][..],
            &[("GATEWAY_OPEN_UPLOAD_MAX_PENDING_BYTES", "1000")][..],
        ] {
            assert!(
                GatewaySettings::from_lookup(&lookup_from(pairs)).is_err(),
                "{pairs:?}"
            );
        }
    }

    #[test]
    fn rejects_bad_trusted_proxy() {
        let result =
            GatewaySettings::from_lookup(&lookup_from(&[("GATEWAY_TRUSTED_PROXY", "not-an-ip")]));
        assert!(result.is_err());
    }
}

//! Gateway startup, background work, and the two listeners.
//!
//! Startup refuses to serve unless:
//!
//! - the deployment file is set and has no placeholder values,
//! - the admin token is set (at least 16 characters),
//! - the verifier sidecar reports the pinned verifier key (`pkv_sha256` equals the deployment
//!   `verifier_artifact_hash`) and `witness_mode == "zk"`,
//! - the upstream RPC reports the expected chain ID with `eth_chainId`.

use crate::app::{
    Gateway, GatewayConfig, GatewayParts, SharedGateway, admin_router, public_router,
};
use crate::clock::{Clock, SystemClock};
use crate::epoch::window_start;
use crate::peer::PeerPolicy;
use crate::roots::{IssuerHttpRootSource, RegistryRootSource, RootSource, RootTracker};
use crate::settings::{GatewaySettings, MIN_ADMIN_TOKEN_LEN, RootSourceKind};
use crate::store::Store;
use crate::upstream::{HttpUpstream, Upstream, read_chain_id};
use crate::verifier::{ProofVerifier, SidecarVerifier, check_verifier};
use anon_credit_crypto::constants::CIRCUIT_ID;
use anon_credit_protocol::admin::VerifierStatus;
use anon_credit_protocol::{Bytes32, PriceTable};
use anyhow::{Context, anyhow, bail};
use axum::http::HeaderValue;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

/// Interval of the response pruning task.
pub const RESPONSE_PRUNE_INTERVAL: Duration = Duration::from_secs(5);

/// Interval of the session and root cache pruning task.
pub const SESSION_PRUNE_INTERVAL: Duration = Duration::from_secs(60);

/// Timeout of one issuer roots request (issuer-http root source).
pub const ISSUER_ROOTS_TIMEOUT: Duration = Duration::from_secs(10);

/// Timeout of one verifier sidecar call.
pub const VERIFIER_TIMEOUT: Duration = Duration::from_secs(30);

fn parse_url(name: &str, text: &str) -> anyhow::Result<reqwest::Url> {
    // Do not print the URL. It can contain an API key.
    reqwest::Url::parse(text).map_err(|_| anyhow!("{name} is not a valid URL"))
}

/// Read the settings, run the startup checks, and serve until Ctrl-C.
pub async fn run(settings: GatewaySettings) -> anyhow::Result<()> {
    let (_, deployment) = settings
        .common
        .deployment
        .clone()
        .context("DEPLOYMENT_CONFIG is not set; the gateway needs the deployment file")?;
    let placeholders = deployment.placeholder_fields();
    if !placeholders.is_empty() {
        bail!(
            "deployment has placeholder values in: {}",
            placeholders.join(", ")
        );
    }
    if deployment.circuit_id != Bytes32(CIRCUIT_ID.to_bytes_be()) {
        tracing::warn!("deployment circuit_id is not the batch-open CIRCUIT_ID constant");
    }
    let admin_token = settings
        .admin_token
        .clone()
        .filter(|token| token.len() >= MIN_ADMIN_TOKEN_LEN)
        .context("GATEWAY_ADMIN_TOKEN must be set (at least 16 characters)")?;
    let upstream_url = settings
        .upstream_rpc_url
        .as_deref()
        .context("GATEWAY_UPSTREAM_RPC_URL is not set")?;
    let source = root_source(&settings, &deployment)?;
    let cors_origins = settings
        .cors_origins
        .iter()
        .map(|origin| HeaderValue::from_str(origin))
        .collect::<Result<Vec<_>, _>>()
        .context("GATEWAY_CORS_ORIGINS has an origin that is not a valid header value")?;

    let verifier: Arc<dyn ProofVerifier> = Arc::new(
        SidecarVerifier::new(
            parse_url("GATEWAY_VERIFIER_URL", &settings.verifier_url)?,
            VERIFIER_TIMEOUT,
        )
        .map_err(|e| anyhow!("{e}"))?,
    );
    let health = check_verifier(verifier.as_ref(), &deployment.verifier_artifact_hash)
        .await
        .context("verifier sidecar check failed; the gateway does not serve")?;
    tracing::info!(
        pkv_sha256 = %health.pkv_sha256,
        circuit_id = %health.circuit_id,
        witness_mode = %health.witness_mode,
        "verifier sidecar check passed"
    );

    let limits = settings.limits.clone();
    let upstream: Arc<dyn Upstream> = Arc::new(
        HttpUpstream::new(
            parse_url("GATEWAY_UPSTREAM_RPC_URL", upstream_url)?,
            limits.upstream_timeout,
            limits.upstream_response_bytes,
        )
        .map_err(|e| anyhow!("{e}"))?,
    );
    let expected_chain = settings
        .upstream_chain_id
        .unwrap_or(deployment.payment_chain_id);
    let chain_id = read_chain_id(upstream.as_ref())
        .await
        .map_err(|e| anyhow!("upstream eth_chainId check failed: {e}"))?;
    if chain_id != expected_chain {
        bail!("upstream chain ID {chain_id} is not the expected chain ID {expected_chain}");
    }
    tracing::info!(chain_id, "upstream chain ID check passed");

    let clock: Arc<dyn Clock> = Arc::new(SystemClock);
    let store = Store::open(&settings.database_path)
        .await
        .context("cannot open the gateway database")?;
    let current = crate::epoch::epoch_of(clock.now_unix(), deployment.epoch_seconds).unwrap_or(0);
    let cached = store
        .cached_roots(window_start(current))
        .await
        .context("cannot read the root cache")?;
    let roots = RootTracker::new(source, cached);
    let config = GatewayConfig::new(
        deployment,
        PriceTable::initial(),
        limits,
        chain_id,
        admin_token,
        cors_origins,
    );
    let gateway = Gateway::new(GatewayParts {
        config,
        store,
        clock,
        roots,
        verifier,
        verifier_status: VerifierStatus {
            pkv_sha256: health.pkv_sha256,
            circuit_id: health.circuit_id,
            witness_mode: health.witness_mode,
        },
        upstream,
        peer: PeerPolicy::new(
            settings.demo_ip_logging,
            settings.trusted_proxies.clone(),
            settings.forwarded_header.clone(),
        ),
    });
    refresh_roots(&gateway).await;
    spawn_background(&gateway, Duration::from_secs(settings.root_poll_seconds));
    serve(gateway, settings.public_bind, settings.admin_bind).await
}

/// Make the root source that `GATEWAY_ROOT_SOURCE` selects.
fn root_source(
    settings: &GatewaySettings,
    deployment: &anon_credit_protocol::DeploymentConfig,
) -> anyhow::Result<Arc<dyn RootSource>> {
    match settings.root_source {
        RootSourceKind::Contract => {
            let root_url = settings
                .root_rpc_url
                .as_deref()
                .context("GATEWAY_ROOT_RPC_URL or SEPOLIA_RPC_URL is not set")?;
            Ok(Arc::new(RegistryRootSource::new(
                parse_url("GATEWAY_ROOT_RPC_URL", root_url)?,
                deployment.root_registry_address,
            )))
        }
        RootSourceKind::IssuerHttp => {
            let issuer_url = settings
                .root_issuer_url
                .as_deref()
                .context("GATEWAY_ROOT_SOURCE=issuer-http needs GATEWAY_ROOT_ISSUER_URL")?;
            tracing::warn!(
                "root source is issuer-http: the gateway trusts the issuer for roots; use it only for local runs"
            );
            let source = IssuerHttpRootSource::new(
                parse_url("GATEWAY_ROOT_ISSUER_URL", issuer_url)?,
                ISSUER_ROOTS_TIMEOUT,
            )
            .map_err(|e| anyhow!("{e}"))?;
            Ok(Arc::new(source))
        }
    }
}

/// Serve the public and the admin listener until Ctrl-C.
pub async fn serve(
    gateway: SharedGateway,
    public_bind: SocketAddr,
    admin_bind: SocketAddr,
) -> anyhow::Result<()> {
    let public = tokio::net::TcpListener::bind(public_bind)
        .await
        .with_context(|| format!("cannot bind the public listener {public_bind}"))?;
    let admin = tokio::net::TcpListener::bind(admin_bind)
        .await
        .with_context(|| format!("cannot bind the admin listener {admin_bind}"))?;
    tracing::info!(%public_bind, %admin_bind, "gateway listening");
    let public_app =
        public_router(Arc::clone(&gateway)).into_make_service_with_connect_info::<SocketAddr>();
    let admin_app = admin_router(Arc::clone(&gateway));
    let public_task = axum::serve(public, public_app).with_graceful_shutdown(shutdown());
    let admin_task = axum::serve(admin, admin_app).with_graceful_shutdown(shutdown());
    let (public_result, admin_result) = tokio::join!(public_task, admin_task);
    public_result.context("public listener failed")?;
    admin_result.context("admin listener failed")?;
    gateway.store.close().await;
    Ok(())
}

async fn shutdown() {
    // An error means that the signal handler is not available. Then serve until killed.
    if tokio::signal::ctrl_c().await.is_err() {
        std::future::pending::<()>().await;
    }
}

/// Read new roots from the source and write them to the cache.
pub async fn refresh_roots(gateway: &SharedGateway) {
    let current = gateway.current_epoch();
    let now = gateway.clock.now_unix();
    match gateway.roots.refresh(current, now).await {
        Ok(added) if added.is_empty() => {}
        Ok(added) => {
            if let Err(error) = gateway.store.save_roots(&added, now).await {
                tracing::warn!(error = %error, "cannot write the root cache");
            }
            tracing::info!(count = added.len(), "accepted new roots");
        }
        Err(error) => tracing::warn!(error = %error, "root refresh failed"),
    }
}

/// Remove expired response bytes, expired proof uploads, sessions after retention, and old
/// cached roots.
pub async fn prune(gateway: &SharedGateway, sessions_too: bool) {
    let now = gateway.clock.now_unix();
    let evicted = gateway.uploads.evict_expired(now);
    if evicted > 0 {
        tracing::info!(count = evicted, "deleted expired proof uploads");
    }
    let cutoff = now.saturating_sub(gateway.config.limits.response_retention_secs);
    if let Err(error) = gateway.store.prune_responses(cutoff).await {
        tracing::warn!(error = %error, "response pruning failed");
    }
    if sessions_too {
        let current = gateway.current_epoch();
        if let Err(error) = gateway.store.prune_sessions(current).await {
            tracing::warn!(error = %error, "session pruning failed");
        }
        if let Err(error) = gateway.store.prune_roots(window_start(current)).await {
            tracing::warn!(error = %error, "root cache pruning failed");
        }
    }
}

/// Start the root refresh task and the pruning task.
pub fn spawn_background(gateway: &SharedGateway, root_poll: Duration) {
    let roots_gateway = Arc::clone(gateway);
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(root_poll);
        loop {
            tick.tick().await;
            refresh_roots(&roots_gateway).await;
        }
    });
    let prune_gateway = Arc::clone(gateway);
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(RESPONSE_PRUNE_INTERVAL);
        let every = SESSION_PRUNE_INTERVAL.as_secs() / RESPONSE_PRUNE_INTERVAL.as_secs();
        let mut count: u64 = 0;
        loop {
            tick.tick().await;
            prune(&prune_gateway, count.is_multiple_of(every.max(1))).await;
            count = count.wrapping_add(1);
        }
    });
}

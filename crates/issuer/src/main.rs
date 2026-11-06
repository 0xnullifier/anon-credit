//! The issuer service entry point.
//!
//! `issuer` reads the settings, checks the chain against the deployment, and runs the HTTP
//! API, the sale indexer, and the root publisher until Ctrl-C.
//! `issuer --print-settings` prints the settings without secrets and stops.

use anon_credit_issuer::chain::{Chain, ChainError};
use anon_credit_issuer::clock::SystemClock;
use anon_credit_issuer::http::router;
use anon_credit_issuer::rpc_chain::RpcChain;
use anon_credit_issuer::service::{Service, ServiceConfig};
use anon_credit_issuer::settings::IssuerSettings;
use anyhow::{Context, bail};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();
    let lookup = |name: &str| std::env::var(name).ok();
    let settings = match IssuerSettings::from_lookup(&lookup) {
        Ok(settings) => settings,
        Err(error) => {
            eprintln!("issuer settings error: {error}");
            return ExitCode::FAILURE;
        }
    };
    if std::env::args().any(|arg| arg == "--print-settings") {
        println!("anon-credit issuer settings");
        for line in settings.summary_lines() {
            println!("  {line}");
        }
        return ExitCode::SUCCESS;
    }
    match run(settings).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!("issuer stopped: {error:#}");
            ExitCode::FAILURE
        }
    }
}

async fn run(settings: IssuerSettings) -> anyhow::Result<()> {
    for line in settings.summary_lines() {
        tracing::info!("{line}");
    }
    let Some((_, deployment)) = settings.common.deployment.clone() else {
        bail!("DEPLOYMENT_CONFIG is not set");
    };
    let address_placeholders: Vec<&str> = deployment
        .placeholder_fields()
        .into_iter()
        .filter(|field| field.ends_with("address"))
        .collect();
    if !address_placeholders.is_empty() {
        bail!(
            "the deployment has placeholder addresses: {}",
            address_placeholders.join(", ")
        );
    }
    let Some(rpc_url) = settings.sepolia_rpc_url.as_deref() else {
        bail!("SEPOLIA_RPC_URL is not set");
    };
    let chain = RpcChain::new(
        rpc_url,
        settings.private_key.as_deref(),
        deployment.payment_chain_id,
    )?;
    if chain.publisher().is_none() {
        tracing::warn!("ISSUER_PRIVATE_KEY is not set: roots are recorded but not published");
    }
    if settings.start_block == 0 {
        tracing::warn!("ISSUER_START_BLOCK is 0: the indexer reads from the genesis block");
    }
    let sale = chain
        .sale_info(alloy::primitives::Address::from(deployment.sale_address.0))
        .await
        .context("read CreditSale")?;
    let batch_price_wei = u64::try_from(sale.batch_price_wei)
        .map_err(|_| ChainError::Decode("batchPriceWei is larger than 2^64 - 1".to_owned()))?;

    if let Some(parent) = settings.database_path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent).context("create the database directory")?;
    }
    let pool = anon_credit_registry::sqlite::connect(&settings.database_path)
        .await
        .context("open the database")?;
    let mut config = ServiceConfig::new(deployment, batch_price_wei, settings.start_block);
    config.log_chunk_blocks = settings.log_chunk_blocks;
    let service = Arc::new(Service::open(config, pool, chain, Arc::new(SystemClock)).await?);
    service.check_chain().await.context("check the chain")?;

    let indexer = tokio::spawn(run_loop(
        service.clone(),
        Duration::from_secs(settings.index_poll_seconds),
        Task::Index,
    ));
    let publisher = tokio::spawn(run_loop(
        service.clone(),
        Duration::from_secs(settings.publish_poll_seconds),
        Task::Publish,
    ));
    let listener = tokio::net::TcpListener::bind(settings.bind)
        .await
        .with_context(|| format!("bind {}", settings.bind))?;
    tracing::info!(bind = %settings.bind, "issuer API listening");
    axum::serve(listener, router(service))
        .with_graceful_shutdown(async {
            if let Err(error) = tokio::signal::ctrl_c().await {
                tracing::error!(%error, "cannot wait for Ctrl-C");
            }
        })
        .await
        .context("serve")?;
    indexer.abort();
    publisher.abort();
    Ok(())
}

#[derive(Debug, Clone, Copy)]
enum Task {
    Index,
    Publish,
}

async fn run_loop<C: Chain>(service: Arc<Service<C>>, interval: Duration, task: Task) {
    loop {
        let result = match task {
            Task::Index => service.indexer_tick().await.map(|report| {
                if report.issued > 0 || report.rejected > 0 {
                    tracing::info!(?report, "indexer pass");
                }
            }),
            Task::Publish => service.publisher_tick().await,
        };
        if let Err(error) = result {
            tracing::warn!(?task, %error, "background pass failed; it runs again");
        }
        tokio::time::sleep(interval).await;
    }
}

//! The gateway service entry point.
//!
//! Read the settings from the environment, run the startup checks, and serve the public API
//! and the admin API until Ctrl-C. The log never has secret values or peer addresses.

use anon_credit_gateway::server;
use anon_credit_gateway::settings::GatewaySettings;
use std::process::ExitCode;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();
    let lookup = |name: &str| std::env::var(name).ok();
    let settings = match GatewaySettings::from_lookup(&lookup) {
        Ok(settings) => settings,
        Err(error) => {
            eprintln!("gateway settings error: {error}");
            return ExitCode::FAILURE;
        }
    };
    for line in settings.summary_lines() {
        tracing::info!("{line}");
    }
    match server::run(settings).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!("gateway stopped: {error:#}");
            ExitCode::FAILURE
        }
    }
}

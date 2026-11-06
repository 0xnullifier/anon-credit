//! The gateway service entry point.
//!
//! Phase 0: read the settings, print a summary, and stop. Phase 3 adds the HTTP servers.

use anon_credit_gateway::settings::GatewaySettings;
use std::process::ExitCode;

fn main() -> ExitCode {
    let lookup = |name: &str| std::env::var(name).ok();
    match GatewaySettings::from_lookup(&lookup) {
        Ok(settings) => {
            println!("anon-credit gateway (phase 0 skeleton)");
            for line in settings.summary_lines() {
                println!("  {line}");
            }
            println!("no server in phase 0; exit");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("gateway settings error: {error}");
            ExitCode::FAILURE
        }
    }
}

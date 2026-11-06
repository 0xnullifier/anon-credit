//! The issuer service entry point.
//!
//! Phase 0: read the settings, print a summary, and stop. Phase 2 adds the HTTP server.

use anon_credit_issuer::settings::IssuerSettings;
use std::process::ExitCode;

fn main() -> ExitCode {
    let lookup = |name: &str| std::env::var(name).ok();
    match IssuerSettings::from_lookup(&lookup) {
        Ok(settings) => {
            println!("anon-credit issuer (phase 0 skeleton)");
            for line in settings.summary_lines() {
                println!("  {line}");
            }
            println!("no server in phase 0; exit");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("issuer settings error: {error}");
            ExitCode::FAILURE
        }
    }
}

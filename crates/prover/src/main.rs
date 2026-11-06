//! Command line tool for the ProveKit verifier adapter.
//!
//! Commands:
//!
//! - `verify`: verify one proof file and print the duration.
//! - `bench`: verify one proof file many times and print the durations.
//! - `inspect`: print the encoding, size, and public inputs of a proof file.
//!
//! Exit codes: 0 for success, 1 for a rejected proof or a load error, 2 for a usage error.

use std::{
    path::PathBuf,
    process::ExitCode,
    time::{Duration, Instant},
};

use anon_credit_prover::{
    DEFAULT_MAX_PROOF_BYTES, PinnedVerifier, Proof, ProofEncoding, PublicInput, Sha256Digest,
};

const USAGE: &str = "\
usage:
  anon-credit-prover verify  --pkv <file> --pkv-sha256 <hex> --proof <file> --public-input <0xhex>...
  anon-credit-prover bench   --pkv <file> --pkv-sha256 <hex> --proof <file> --public-input <0xhex>... [--iterations <n>]
  anon-credit-prover inspect --proof <file>
options:
  --max-proof-bytes <n>   proof size limit (default 4194304)";

#[derive(Debug, Default)]
struct Args {
    pkv: Option<PathBuf>,
    pkv_sha256: Option<String>,
    proof: Option<PathBuf>,
    public_inputs: Vec<String>,
    iterations: Option<String>,
    max_proof_bytes: Option<String>,
}

enum Command {
    Verify,
    Bench,
    Inspect,
}

fn main() -> ExitCode {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    match run(&raw) {
        Ok(()) => ExitCode::SUCCESS,
        Err(Failure::Usage(message)) => {
            eprintln!("error: {message}\n{USAGE}");
            ExitCode::from(2)
        }
        Err(Failure::Failed(message)) => {
            eprintln!("error: {message}");
            ExitCode::from(1)
        }
    }
}

enum Failure {
    Usage(String),
    Failed(String),
}

fn run(raw: &[String]) -> Result<(), Failure> {
    let (command, rest) = raw.split_first().ok_or_else(|| usage("missing command"))?;
    let command = match command.as_str() {
        "verify" => Command::Verify,
        "bench" => Command::Bench,
        "inspect" => Command::Inspect,
        other => return Err(usage(&format!("unknown command {other}"))),
    };
    let args = parse_args(rest)?;
    let max_proof_bytes = match &args.max_proof_bytes {
        Some(text) => parse_count(text, "--max-proof-bytes")?,
        None => DEFAULT_MAX_PROOF_BYTES,
    };
    let proof_path = args
        .proof
        .clone()
        .ok_or_else(|| usage("--proof is required"))?;
    let proof_bytes = std::fs::read(&proof_path)
        .map_err(|error| failed(format!("cannot read {}: {error}", proof_path.display())))?;
    let decode_start = Instant::now();
    let proof = Proof::decode(&proof_bytes, max_proof_bytes).map_err(|e| failed(e.to_string()))?;
    let decode = decode_start.elapsed();

    match command {
        Command::Inspect => {
            let inputs: Vec<String> = proof
                .public_inputs()
                .iter()
                .map(|input| format!("\"{input}\""))
                .collect();
            println!(
                "{{\"encoding\":\"{}\",\"proof_bytes\":{},\"public_inputs\":[{}]}}",
                encoding_name(proof.encoding()),
                proof.encoded_len(),
                inputs.join(",")
            );
            Ok(())
        }
        Command::Verify => {
            let verifier = load_verifier(&args)?;
            let expected = parse_public_inputs(&args)?;
            let verified = verifier
                .verify(&proof, &expected)
                .map_err(|e| failed(e.to_string()))?;
            println!(
                "{{\"result\":\"valid\",\"encoding\":\"{}\",\"proof_bytes\":{},\"decode_ms\":{:.3},\"verify_ms\":{:.3}}}",
                encoding_name(proof.encoding()),
                proof.encoded_len(),
                millis(decode),
                millis(verified.duration)
            );
            Ok(())
        }
        Command::Bench => {
            let verifier = load_verifier(&args)?;
            let expected = parse_public_inputs(&args)?;
            let iterations = match &args.iterations {
                Some(text) => parse_count(text, "--iterations")?,
                None => 20,
            };
            let mut durations = Vec::with_capacity(iterations);
            for _ in 0..iterations {
                let verified = verifier
                    .verify(&proof, &expected)
                    .map_err(|e| failed(e.to_string()))?;
                durations.push(verified.duration);
            }
            durations.sort();
            let total: Duration = durations.iter().sum();
            let count = u32::try_from(durations.len()).map_err(|_| usage("too many iterations"))?;
            let mean = total.checked_div(count).unwrap_or_default();
            let median = durations
                .get(durations.len() / 2)
                .copied()
                .unwrap_or_default();
            let min = durations.first().copied().unwrap_or_default();
            let max = durations.last().copied().unwrap_or_default();
            println!(
                "{{\"result\":\"valid\",\"iterations\":{iterations},\"encoding\":\"{}\",\"proof_bytes\":{},\"decode_ms\":{:.3},\"verify_ms\":{{\"min\":{:.3},\"median\":{:.3},\"mean\":{:.3},\"max\":{:.3}}}}}",
                encoding_name(proof.encoding()),
                proof.encoded_len(),
                millis(decode),
                millis(min),
                millis(median),
                millis(mean),
                millis(max)
            );
            Ok(())
        }
    }
}

fn parse_args(rest: &[String]) -> Result<Args, Failure> {
    let mut args = Args::default();
    let mut items = rest.iter();
    while let Some(flag) = items.next() {
        let value = items
            .next()
            .ok_or_else(|| usage(&format!("{flag} needs a value")))?;
        match flag.as_str() {
            "--pkv" => args.pkv = Some(PathBuf::from(value)),
            "--pkv-sha256" => args.pkv_sha256 = Some(value.clone()),
            "--proof" => args.proof = Some(PathBuf::from(value)),
            "--public-input" => args.public_inputs.push(value.clone()),
            "--iterations" => args.iterations = Some(value.clone()),
            "--max-proof-bytes" => args.max_proof_bytes = Some(value.clone()),
            other => return Err(usage(&format!("unknown option {other}"))),
        }
    }
    Ok(args)
}

fn load_verifier(args: &Args) -> Result<PinnedVerifier, Failure> {
    let path = args
        .pkv
        .as_ref()
        .ok_or_else(|| usage("--pkv is required"))?;
    let digest_text = args
        .pkv_sha256
        .as_ref()
        .ok_or_else(|| usage("--pkv-sha256 is required"))?;
    let digest = Sha256Digest::from_hex(digest_text).map_err(|e| usage(&e.to_string()))?;
    PinnedVerifier::load(path, &digest).map_err(|e| failed(e.to_string()))
}

fn parse_public_inputs(args: &Args) -> Result<Vec<PublicInput>, Failure> {
    args.public_inputs
        .iter()
        .map(|text| PublicInput::from_hex(text).map_err(|e| usage(&format!("{text}: {e}"))))
        .collect()
}

fn parse_count(text: &str, flag: &str) -> Result<usize, Failure> {
    match text.parse::<usize>() {
        Ok(value) if value > 0 => Ok(value),
        _ => Err(usage(&format!("{flag} must be a positive integer"))),
    }
}

fn encoding_name(encoding: ProofEncoding) -> &'static str {
    match encoding {
        ProofEncoding::Json => "json",
        ProofEncoding::Binary => "binary",
    }
}

fn millis(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

fn usage(message: &str) -> Failure {
    Failure::Usage(message.to_owned())
}

fn failed(message: String) -> Failure {
    Failure::Failed(message)
}

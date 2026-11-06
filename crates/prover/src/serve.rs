//! The verifier sidecar: a loopback HTTP server that verifies batch-open proofs for the
//! gateway.
//!
//! The gateway uses stable Rust and ProveKit needs nightly Rust. Thus the gateway does not link
//! ProveKit. It sends each proof to this process on `127.0.0.1`.
//!
//! Routes:
//!
//! - `POST /verify`: body `{"proof": <proof>, "public_inputs": ["0x..", ...]}`. `proof` is a
//!   JSON object (the proof JSON that the browser prover writes) or a string (base64 of the
//!   proof bytes, JSON or binary `.np`). `public_inputs` are the expected values in circuit
//!   order, as canonical hex field elements. The gateway makes them from its own values.
//!   The response is `{"ok": bool, "duration_ms": number, "error_code": string | null}`.
//! - `GET /health`: the pinned verifier key digest, the circuit ID, and the witness mode.
//!
//! Limits: the body size limit (default 16 MiB) and the proof size limit apply before the proof
//! is decoded. At most `max_concurrency` verifications run at the same time, and at most
//! `max_queue` requests wait. A request above these limits gets `busy` at once.

use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, State, rejection::BytesRejection},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;

use crate::{
    DEFAULT_MAX_PROOF_BYTES, PROVEKIT_REV, PinnedVerifier, Proof, PublicInput, VerifyError,
};

/// The default port of the sidecar.
pub const DEFAULT_PORT: u16 = 8083;
/// The default body size limit (16 MiB, implementation.md section 11).
pub const DEFAULT_MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
/// The default number of verifications that run at the same time.
pub const DEFAULT_MAX_CONCURRENCY: usize = 2;
/// The default number of requests that wait for a verification slot.
pub const DEFAULT_MAX_QUEUE: usize = 32;
/// The circuit ID of the batch-open circuit (`CIRCUIT_ID` in `anon_credit_crypto`).
pub const BATCH_OPEN_CIRCUIT_ID: &str =
    "0x00000000000000616e6f6e2d6372656469742f76312f62617463682d6f70656e";

/// The settings of the sidecar.
#[derive(Debug, Clone, Copy)]
pub struct ServeConfig {
    /// The value that public input 0 must have.
    pub circuit_id: PublicInput,
    /// The request body size limit.
    pub max_body_bytes: usize,
    /// The decoded proof size limit.
    pub max_proof_bytes: usize,
    /// The number of verifications that run at the same time.
    pub max_concurrency: usize,
    /// The number of requests that wait for a verification slot.
    pub max_queue: usize,
}

impl ServeConfig {
    /// The default settings for a circuit ID.
    pub const fn new(circuit_id: PublicInput) -> Self {
        Self {
            circuit_id,
            max_body_bytes: DEFAULT_MAX_BODY_BYTES,
            max_proof_bytes: DEFAULT_MAX_PROOF_BYTES,
            max_concurrency: DEFAULT_MAX_CONCURRENCY,
            max_queue: DEFAULT_MAX_QUEUE,
        }
    }
}

/// A stable error code of `POST /verify`. The gateway branches on the code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// The body is not valid JSON of the request form, or a public input is not a canonical
    /// hex field element.
    InvalidRequest,
    /// The body is larger than the body size limit.
    BodyTooLarge,
    /// The proof is larger than the proof size limit, or it does not decode.
    ProofMalformed,
    /// Public input 0 is not the circuit ID of this sidecar.
    CircuitIdMismatch,
    /// The number of public inputs is not the number of the circuit.
    PublicInputCount,
    /// A public input in the proof is not equal to the expected value.
    PublicInputMismatch,
    /// The proof is not valid for the pinned verifier key.
    ProofInvalid,
    /// All verification slots and queue places are in use.
    Busy,
    /// The verification task stopped.
    Internal,
}

/// The response of `POST /verify`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct VerifyResponse {
    /// True if the proof is valid for the expected public inputs.
    pub ok: bool,
    /// The time of proof decoding and verification, in milliseconds. It does not include the
    /// time in the queue.
    pub duration_ms: f64,
    /// The error code, or null if `ok` is true.
    pub error_code: Option<ErrorCode>,
}

/// The response of `GET /health`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HealthResponse {
    /// Always true.
    pub ok: bool,
    /// The SHA-256 digest of the pinned verifier key.
    pub pkv_sha256: String,
    /// The circuit ID that public input 0 must have.
    pub circuit_id: String,
    /// The witness commitment mode of the key. Always `zk`: the sidecar does not load a
    /// non-hiding key.
    pub witness_mode: String,
    /// The Merkle and Fiat-Shamir hash of the key.
    pub hash: String,
    /// The ProveKit commit that the sidecar links.
    pub provekit_rev: String,
    /// The number of public inputs of the circuit.
    pub num_public_inputs: usize,
    /// The number of R1CS constraints of the circuit.
    pub num_constraints: usize,
    /// The number of verifications that run at the same time.
    pub max_concurrency: usize,
    /// The body size limit.
    pub max_body_bytes: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VerifyRequest {
    proof: serde_json::Value,
    public_inputs: Vec<String>,
}

struct Shared {
    verifier: PinnedVerifier,
    config: ServeConfig,
    // Permits for waiting and running requests.
    admission: Arc<Semaphore>,
    // Permits for running verifications.
    workers: Arc<Semaphore>,
}

/// Makes the router of the sidecar.
pub fn router(verifier: PinnedVerifier, config: ServeConfig) -> Router {
    let shared = Arc::new(Shared {
        verifier,
        config,
        admission: Arc::new(Semaphore::new(config.max_concurrency + config.max_queue)),
        workers: Arc::new(Semaphore::new(config.max_concurrency)),
    });
    Router::new()
        .route("/verify", post(verify))
        .route("/health", get(health))
        .layer(DefaultBodyLimit::max(config.max_body_bytes))
        .with_state(shared)
}

async fn health(State(shared): State<Arc<Shared>>) -> Json<HealthResponse> {
    let info = shared.verifier.info();
    Json(HealthResponse {
        ok: true,
        pkv_sha256: info.digest.to_string(),
        circuit_id: shared.config.circuit_id.to_string(),
        witness_mode: "zk".to_owned(),
        hash: info.hash.clone(),
        provekit_rev: PROVEKIT_REV.to_owned(),
        num_public_inputs: info.num_public_inputs,
        num_constraints: info.num_constraints,
        max_concurrency: shared.config.max_concurrency,
        max_body_bytes: shared.config.max_body_bytes,
    })
}

fn reply(status: StatusCode, duration: Duration, error_code: Option<ErrorCode>) -> Response {
    let body = VerifyResponse {
        ok: error_code.is_none(),
        duration_ms: duration.as_secs_f64() * 1000.0,
        error_code,
    };
    (status, Json(body)).into_response()
}

fn rejected(status: StatusCode, code: ErrorCode) -> Response {
    reply(status, Duration::ZERO, Some(code))
}

async fn verify(
    State(shared): State<Arc<Shared>>,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let body = match body {
        Ok(body) => body,
        Err(rejection) => {
            return match rejection.status() {
                StatusCode::PAYLOAD_TOO_LARGE => {
                    rejected(StatusCode::PAYLOAD_TOO_LARGE, ErrorCode::BodyTooLarge)
                }
                _ => rejected(StatusCode::BAD_REQUEST, ErrorCode::InvalidRequest),
            };
        }
    };
    let Ok(admission) = Arc::clone(&shared.admission).try_acquire_owned() else {
        return rejected(StatusCode::SERVICE_UNAVAILABLE, ErrorCode::Busy);
    };
    let Ok(worker) = Arc::clone(&shared.workers).acquire_owned().await else {
        return rejected(StatusCode::SERVICE_UNAVAILABLE, ErrorCode::Busy);
    };
    let task = Arc::clone(&shared);
    let outcome = tokio::task::spawn_blocking(move || {
        let start = Instant::now();
        let result = check(&task, &body);
        (start.elapsed(), result)
    })
    .await;
    drop(worker);
    drop(admission);
    match outcome {
        Ok((duration, Ok(()))) => reply(StatusCode::OK, duration, None),
        Ok((duration, Err((status, code)))) => reply(status, duration, Some(code)),
        Err(_) => rejected(StatusCode::INTERNAL_SERVER_ERROR, ErrorCode::Internal),
    }
}

type Failure = (StatusCode, ErrorCode);

// Parse, decode, and verify one request. A proof that is not valid gives status 200 with
// `ok: false`. A request that is not well formed gives status 400.
fn check(shared: &Shared, body: &[u8]) -> Result<(), Failure> {
    let invalid = (StatusCode::BAD_REQUEST, ErrorCode::InvalidRequest);
    let request: VerifyRequest = serde_json::from_slice(body).map_err(|_| invalid)?;
    let expected = request
        .public_inputs
        .iter()
        .map(|text| PublicInput::from_hex(text))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| invalid)?;
    let proof_bytes = match request.proof {
        serde_json::Value::String(text) => base64::engine::general_purpose::STANDARD
            .decode(text)
            .map_err(|_| invalid)?,
        value @ serde_json::Value::Object(_) => serde_json::to_vec(&value).map_err(|_| invalid)?,
        _ => return Err(invalid),
    };
    let not_valid = |code| (StatusCode::OK, code);
    if expected.first() != Some(&shared.config.circuit_id) {
        return Err(not_valid(ErrorCode::CircuitIdMismatch));
    }
    let proof = Proof::decode(&proof_bytes, shared.config.max_proof_bytes)
        .map_err(|_| not_valid(ErrorCode::ProofMalformed))?;
    shared
        .verifier
        .verify(&proof, &expected)
        .map(|_| ())
        .map_err(|error| match error {
            VerifyError::PublicInputCount { .. } | VerifyError::CircuitPublicInputCount { .. } => {
                not_valid(ErrorCode::PublicInputCount)
            }
            VerifyError::PublicInputMismatch { .. } => not_valid(ErrorCode::PublicInputMismatch),
            VerifyError::Rejected(_) => not_valid(ErrorCode::ProofInvalid),
        })
}

/// Serves the sidecar on `127.0.0.1:port` until the process gets Ctrl-C.
pub async fn serve(
    verifier: PinnedVerifier,
    config: ServeConfig,
    port: u16,
) -> std::io::Result<()> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    eprintln!(
        "anon-credit-prover serve: listening on {} (pkv {}, concurrency {}, queue {})",
        listener.local_addr()?,
        verifier.info().digest,
        config.max_concurrency,
        config.max_queue
    );
    axum::serve(listener, router(verifier, config))
        .with_graceful_shutdown(async {
            // If the signal handler cannot be installed, the server runs until it is killed.
            if tokio::signal::ctrl_c().await.is_err() {
                std::future::pending::<()>().await;
            }
        })
        .await
}

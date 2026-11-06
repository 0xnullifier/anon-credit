//! Proof verification through the ProveKit verifier sidecar.
//!
//! The gateway runs on stable Rust. ProveKit needs nightly Rust, so the verifier runs in a
//! separate process (`anon-credit-prover serve`, phase 1). The sidecar listens on loopback:
//!
//! - `GET /health` returns `{pkv_sha256, circuit_id, witness_mode}`.
//! - `POST /verify` takes `{proof, public_inputs}` and returns `{ok, duration_ms, error_code?}`.
//!   `proof` is the browser JSON proof text, or base64 of a binary proof.
//!
//! At startup the gateway requires `pkv_sha256` equal to the deployment
//! `verifier_artifact_hash` and `witness_mode == "zk"`. It refuses to serve otherwise.
//!
//! [`VerifyQueue`] limits the verifications that run at the same time and the requests that
//! wait. A full queue gives `busy` before any verification work.

use anon_credit_crypto::FieldElement;
use anon_credit_protocol::Bytes32;
use anon_credit_protocol::wire::encode_base64;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// Witness mode that the gateway requires.
pub const REQUIRED_WITNESS_MODE: &str = "zk";

/// Health report of the verifier.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerifierHealth {
    /// SHA-256 of the loaded verifier key, as hex.
    pub pkv_sha256: String,
    /// Circuit name or ID of the loaded key.
    pub circuit_id: String,
    /// Witness commitment mode of the loaded key.
    pub witness_mode: String,
}

/// Result of one verification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerifyOutcome {
    /// `true` if the proof verifies against the public inputs.
    pub ok: bool,
    /// Verification time in milliseconds.
    pub duration_ms: u64,
    /// Reason code of a rejection, from the verifier.
    #[serde(default)]
    pub error_code: Option<String>,
}

/// Failure to reach or read the verifier. It is not a proof rejection.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum VerifierError {
    /// The sidecar is not reachable or gave a bad response.
    #[error("proof verifier is not available: {0}")]
    Unavailable(String),
}

/// A proof verifier.
#[async_trait]
pub trait ProofVerifier: Send + Sync + 'static {
    /// Read the health report.
    async fn health(&self) -> Result<VerifierHealth, VerifierError>;

    /// Verify one proof against the public inputs that the gateway built.
    async fn verify(
        &self,
        proof: &[u8],
        public_inputs: &[FieldElement],
    ) -> Result<VerifyOutcome, VerifierError>;
}

/// Failure of the startup verifier check.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum VerifierCheckError {
    /// The health call failed.
    #[error(transparent)]
    Unavailable(#[from] VerifierError),
    /// The verifier key is not the pinned artifact.
    #[error("verifier key sha256 {found} is not the deployment verifier_artifact_hash {expected}")]
    WrongArtifact {
        /// Digest from the sidecar.
        found: String,
        /// Digest from the deployment.
        expected: String,
    },
    /// The verifier key does not use the hiding witness mode.
    #[error("verifier witness mode {0:?} is not \"zk\"")]
    NotHiding(String),
}

/// Check the verifier health against the deployment. Return the health report on success.
pub async fn check_verifier(
    verifier: &dyn ProofVerifier,
    verifier_artifact_hash: &Bytes32,
) -> Result<VerifierHealth, VerifierCheckError> {
    let health = verifier.health().await?;
    let found = health
        .pkv_sha256
        .strip_prefix("0x")
        .unwrap_or(&health.pkv_sha256)
        .to_ascii_lowercase();
    let expected = hex_digits(verifier_artifact_hash);
    if found != expected {
        return Err(VerifierCheckError::WrongArtifact { found, expected });
    }
    if health.witness_mode != REQUIRED_WITNESS_MODE {
        return Err(VerifierCheckError::NotHiding(health.witness_mode));
    }
    Ok(health)
}

fn hex_digits(value: &Bytes32) -> String {
    value.to_hex().trim_start_matches("0x").to_owned()
}

/// The wire form of a proof for the sidecar: the JSON text of a browser proof, or base64.
pub fn proof_wire_text(proof: &[u8]) -> String {
    match (proof.first(), std::str::from_utf8(proof)) {
        (Some(b'{'), Ok(text)) => text.to_owned(),
        _ => encode_base64(proof),
    }
}

#[derive(Serialize)]
struct VerifyRequest<'a> {
    proof: String,
    public_inputs: &'a [String],
}

/// HTTP client of the verifier sidecar.
#[derive(Debug, Clone)]
pub struct SidecarVerifier {
    client: reqwest::Client,
    base: reqwest::Url,
}

impl SidecarVerifier {
    /// Make a client for the sidecar at `base` (for example `http://127.0.0.1:8083`).
    pub fn new(base: reqwest::Url, timeout: Duration) -> Result<Self, VerifierError> {
        let client = reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .map_err(|e| VerifierError::Unavailable(e.to_string()))?;
        Ok(Self { client, base })
    }

    fn endpoint(&self, path: &str) -> Result<reqwest::Url, VerifierError> {
        self.base
            .join(path)
            .map_err(|e| VerifierError::Unavailable(e.to_string()))
    }
}

#[async_trait]
impl ProofVerifier for SidecarVerifier {
    async fn health(&self) -> Result<VerifierHealth, VerifierError> {
        let response = self
            .client
            .get(self.endpoint("/health")?)
            .send()
            .await
            .map_err(|e| VerifierError::Unavailable(e.to_string()))?;
        if !response.status().is_success() {
            return Err(VerifierError::Unavailable(format!(
                "health status {}",
                response.status()
            )));
        }
        response
            .json::<VerifierHealth>()
            .await
            .map_err(|e| VerifierError::Unavailable(e.to_string()))
    }

    async fn verify(
        &self,
        proof: &[u8],
        public_inputs: &[FieldElement],
    ) -> Result<VerifyOutcome, VerifierError> {
        let inputs: Vec<String> = public_inputs.iter().map(FieldElement::to_hex).collect();
        let body = VerifyRequest {
            proof: proof_wire_text(proof),
            public_inputs: &inputs,
        };
        let response = self
            .client
            .post(self.endpoint("/verify")?)
            .json(&body)
            .send()
            .await
            .map_err(|e| VerifierError::Unavailable(e.to_string()))?;
        // The sidecar can send a rejection with a 4xx status and a JSON body.
        let status = response.status();
        match response.json::<VerifyOutcome>().await {
            Ok(outcome) => Ok(outcome),
            Err(_) => Err(VerifierError::Unavailable(format!(
                "verify status {status}"
            ))),
        }
    }
}

/// Bounded queue for proof verification.
#[derive(Debug, Clone)]
pub struct VerifyQueue {
    admit: Arc<Semaphore>,
    run: Arc<Semaphore>,
}

/// Permission to verify one proof. Drop it after the verification.
#[derive(Debug)]
pub struct VerifySlot {
    _admitted: OwnedSemaphorePermit,
    _running: OwnedSemaphorePermit,
}

/// The queue is full.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("proof verification queue is full")]
pub struct QueueFull;

impl VerifyQueue {
    /// Make a queue with `concurrency` running verifications and `depth` waiting requests.
    pub fn new(concurrency: usize, depth: usize) -> Self {
        Self {
            admit: Arc::new(Semaphore::new(concurrency.saturating_add(depth))),
            run: Arc::new(Semaphore::new(concurrency)),
        }
    }

    /// Enter the queue and wait for a slot. Fail at once if the queue is full.
    pub async fn enter(&self) -> Result<VerifySlot, QueueFull> {
        let admitted = Arc::clone(&self.admit)
            .try_acquire_owned()
            .map_err(|_| QueueFull)?;
        let running = Arc::clone(&self.run)
            .acquire_owned()
            .await
            .map_err(|_| QueueFull)?;
        Ok(VerifySlot {
            _admitted: admitted,
            _running: running,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_proof_goes_as_text_and_binary_as_base64() {
        assert_eq!(proof_wire_text(br#"{"a":1}"#), r#"{"a":1}"#);
        assert_eq!(proof_wire_text(&[0, 1, 2]), "AAEC");
        assert_eq!(proof_wire_text(b"{\xff"), encode_base64(b"{\xff"));
    }

    #[tokio::test]
    async fn queue_rejects_when_full() {
        let queue = VerifyQueue::new(1, 1);
        let first = queue.enter().await;
        assert!(first.is_ok());
        // The second request waits for the running slot; it holds an admission permit.
        let waiting = {
            let queue = queue.clone();
            tokio::spawn(async move { queue.enter().await.map(|_| ()) })
        };
        tokio::task::yield_now().await;
        assert_eq!(queue.enter().await.map(|_| ()), Err(QueueFull));
        drop(first);
        assert_eq!(waiting.await.ok(), Some(Ok(())));
    }
}

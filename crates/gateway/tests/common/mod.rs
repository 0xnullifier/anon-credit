//! Test harness: a gateway with an injected clock, a fake root source, a fake proof
//! verifier, a fake upstream, and a SQLite file in a temporary directory. No network.

#![allow(dead_code, clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use anon_credit_crypto::constants::CIRCUIT_ID;
use anon_credit_crypto::{BatchOpenPublicInputs, FieldElement};
use anon_credit_gateway::app::{
    Gateway, GatewayConfig, GatewayParts, Limits, SharedGateway, admin_router, public_router,
};
use anon_credit_gateway::clock::ManualClock;
use anon_credit_gateway::peer::{DEFAULT_FORWARDED_HEADER, PeerPolicy};
use anon_credit_gateway::roots::{PublishedRoot, RootSource, RootSourceError, RootTracker};
use anon_credit_gateway::server::refresh_roots;
use anon_credit_gateway::store::Store;
use anon_credit_gateway::upstream::{Upstream, UpstreamError, UpstreamReply};
use anon_credit_gateway::verifier::{ProofVerifier, VerifierError, VerifierHealth, VerifyOutcome};
use anon_credit_protocol::admin::VerifierStatus;
use anon_credit_protocol::api::{OpenRequest, SpendRequest, StatusRequest};
use anon_credit_protocol::deployment::{CREDIT_LIFETIME_EPOCHS, SEPOLIA_CHAIN_ID};
use anon_credit_protocol::{
    Address, Base64Bytes, Bytes32, DecimalU64, DeploymentConfig, ErrorCode, PROTOCOL_VERSION,
    PriceTable, Signature64,
};
use async_trait::async_trait;
use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{HeaderMap, HeaderName, HeaderValue, Request, StatusCode};
use ed25519_dalek::{Signer, SigningKey};
use http_body_util::BodyExt;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tempfile::TempDir;
use tokio::sync::Semaphore;
use tower::ServiceExt;

pub const EPOCH_SECONDS: u32 = 30;
/// Start time: the first second of epoch 60_000_000.
pub const T0: u64 = 1_800_000_000;
pub const ADMIN_TOKEN: &str = "test-admin-token-0123456789";
pub const LEAF_COUNT: u32 = 7;
pub const VERIFIER_HASH: Bytes32 = Bytes32([0x99; 32]);

pub fn root() -> Bytes32 {
    Bytes32(FieldElement::from_u64(0x00ab_cdef_0123).to_bytes_be())
}

pub fn deployment() -> DeploymentConfig {
    DeploymentConfig {
        protocol_version: PROTOCOL_VERSION,
        payment_chain_id: SEPOLIA_CHAIN_ID,
        sale_address: Address([0x11; 20]),
        root_registry_address: Address([0x22; 20]),
        issuer_address: Address([0x33; 20]),
        gateway_id: Bytes32([0x42; 32]),
        batch_size: 100,
        epoch_seconds: EPOCH_SECONDS,
        credit_lifetime_epochs: CREDIT_LIFETIME_EPOCHS,
        circuit_id: Bytes32(CIRCUIT_ID.to_bytes_be()),
        verifier_artifact_hash: VERIFIER_HASH,
        prover_manifest_hash: Bytes32([0x77; 32]),
    }
}

// ----- Fake proof verifier ---------------------------------------------------------------

/// A fake proof is the JSON list of the public inputs that the "prover" used. The fake
/// verifier accepts it only if the gateway built exactly the same inputs.
pub fn fake_proof(inputs: &[FieldElement]) -> Vec<u8> {
    let list: Vec<String> = inputs.iter().map(FieldElement::to_hex).collect();
    serde_json::to_vec(&json!({ "fake_public_inputs": list })).unwrap()
}

pub struct FakeVerifier {
    pub calls: AtomicUsize,
    pub unavailable: AtomicBool,
    /// If set, each verification takes one permit and keeps it.
    pub gate: Mutex<Option<Arc<Semaphore>>>,
    pub health: Mutex<VerifierHealth>,
    pub last_inputs: Mutex<Vec<FieldElement>>,
}

impl Default for FakeVerifier {
    fn default() -> Self {
        Self {
            calls: AtomicUsize::new(0),
            unavailable: AtomicBool::new(false),
            gate: Mutex::new(None),
            health: Mutex::new(VerifierHealth {
                pkv_sha256: VERIFIER_HASH.to_hex().trim_start_matches("0x").to_owned(),
                circuit_id: CIRCUIT_ID.to_hex(),
                witness_mode: "zk".to_owned(),
            }),
            last_inputs: Mutex::new(Vec::new()),
        }
    }
}

#[async_trait]
impl ProofVerifier for FakeVerifier {
    async fn health(&self) -> Result<VerifierHealth, VerifierError> {
        Ok(self.health.lock().unwrap().clone())
    }

    async fn verify(
        &self,
        proof: &[u8],
        public_inputs: &[FieldElement],
    ) -> Result<VerifyOutcome, VerifierError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        *self.last_inputs.lock().unwrap() = public_inputs.to_vec();
        let gate = self.gate.lock().unwrap().clone();
        if let Some(gate) = gate {
            gate.acquire_owned().await.unwrap().forget();
        }
        if self.unavailable.load(Ordering::SeqCst) {
            return Err(VerifierError::Unavailable("down".to_owned()));
        }
        Ok(VerifyOutcome {
            ok: proof == fake_proof(public_inputs).as_slice(),
            duration_ms: 3,
            error_code: None,
        })
    }
}

// ----- Fake root source ------------------------------------------------------------------

#[derive(Default)]
pub struct FakeRoots {
    pub latest: AtomicU64,
    pub roots: Mutex<BTreeMap<u64, PublishedRoot>>,
    pub fail: AtomicBool,
}

impl FakeRoots {
    pub fn publish(&self, epoch: u64, root: Bytes32, leaf_count: u64) {
        self.roots
            .lock()
            .unwrap()
            .insert(epoch, PublishedRoot { root, leaf_count });
        self.latest.fetch_max(epoch, Ordering::SeqCst);
    }
}

#[async_trait]
impl RootSource for FakeRoots {
    async fn latest_epoch(&self) -> Result<u64, RootSourceError> {
        match self.fail.load(Ordering::SeqCst) {
            true => Err(RootSourceError("down".to_owned())),
            false => Ok(self.latest.load(Ordering::SeqCst)),
        }
    }

    async fn root_at(&self, epoch: u64) -> Result<Option<PublishedRoot>, RootSourceError> {
        Ok(self.roots.lock().unwrap().get(&epoch).copied())
    }
}

// ----- Fake upstream ---------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpstreamMode {
    Normal,
    RpcError,
    Transport,
    Status(u16),
    Malformed,
    WrongId,
}

pub struct FakeUpstream {
    pub mode: Mutex<UpstreamMode>,
    pub calls: AtomicUsize,
    pub delay_ms: AtomicU64,
    pub bodies: Mutex<Vec<Bytes>>,
    /// If set, the fake counts and records the call, and then sends it to this upstream.
    pub relay: Mutex<Option<Arc<dyn Upstream>>>,
}

impl Default for FakeUpstream {
    fn default() -> Self {
        Self {
            mode: Mutex::new(UpstreamMode::Normal),
            calls: AtomicUsize::new(0),
            delay_ms: AtomicU64::new(0),
            bodies: Mutex::new(Vec::new()),
            relay: Mutex::new(None),
        }
    }
}

impl FakeUpstream {
    pub fn set(&self, mode: UpstreamMode) {
        *self.mode.lock().unwrap() = mode;
    }

    pub fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }

    /// Send the next calls to a real upstream client.
    pub fn relay_to(&self, upstream: Arc<dyn Upstream>) {
        *self.relay.lock().unwrap() = Some(upstream);
    }
}

pub fn upstream_result(method: &str) -> Value {
    match method {
        "eth_chainId" => json!("0xaa36a7"),
        "eth_blockNumber" => json!("0x8a3b1c"),
        "eth_getBalance" => json!("0xde0b6b3a7640000"),
        "eth_call" => json!(format!("0x{}", "00".repeat(31) + "2a")),
        "eth_getTransactionReceipt" => json!({
            "transactionHash": TX_HASH,
            "status": "0x1",
            "blockNumber": "0x8a3b1c",
            "logs": [],
        }),
        _ => Value::Null,
    }
}

#[async_trait]
impl Upstream for FakeUpstream {
    async fn call(&self, body: Bytes) -> Result<UpstreamReply, UpstreamError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.bodies.lock().unwrap().push(body.clone());
        let relay = self.relay.lock().unwrap().clone();
        if let Some(relay) = relay {
            return relay.call(body).await;
        }
        let delay = self.delay_ms.load(Ordering::SeqCst);
        if delay > 0 {
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }
        let request: Value = serde_json::from_slice(&body).unwrap();
        let id = request["id"].clone();
        let method = request["method"].as_str().unwrap_or("").to_owned();
        let mode = *self.mode.lock().unwrap();
        let (status, reply) = match mode {
            UpstreamMode::Normal => (
                200,
                json!({"jsonrpc": "2.0", "id": id, "result": upstream_result(&method)}),
            ),
            UpstreamMode::RpcError => (
                200,
                json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32000, "message": "header not found"}}),
            ),
            UpstreamMode::Transport => {
                return Err(UpstreamError::Transport("connect error".to_owned()));
            }
            UpstreamMode::Status(status) => {
                (status, json!({"jsonrpc": "2.0", "id": id, "result": "0x1"}))
            }
            UpstreamMode::Malformed => (200, json!({"jsonrpc": "2.0", "id": id})),
            UpstreamMode::WrongId => (
                200,
                json!({"jsonrpc": "2.0", "id": "other", "result": "0x1"}),
            ),
        };
        Ok(UpstreamReply {
            status,
            body: Bytes::from(serde_json::to_vec(&reply).unwrap()),
        })
    }
}

// ----- Harness ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct Options {
    pub capture_ip: bool,
    pub trusted: Vec<IpAddr>,
    pub peer: SocketAddr,
    pub limits: Limits,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            capture_ip: false,
            trusted: Vec::new(),
            peer: "198.51.100.7:40000".parse().unwrap(),
            limits: Limits::default(),
        }
    }
}

pub struct Harness {
    pub gateway: SharedGateway,
    pub clock: Arc<ManualClock>,
    pub verifier: Arc<FakeVerifier>,
    pub upstream: Arc<FakeUpstream>,
    pub roots: Arc<FakeRoots>,
    pub dir: Arc<TempDir>,
    pub options: Options,
}

pub struct TestResponse {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Bytes,
}

impl TestResponse {
    pub fn json<T: DeserializeOwned>(&self) -> T {
        serde_json::from_slice(&self.body).unwrap_or_else(|e| {
            panic!(
                "body does not parse ({e}): {}",
                String::from_utf8_lossy(&self.body)
            )
        })
    }

    pub fn error_code(&self) -> ErrorCode {
        let body: anon_credit_protocol::api::GatewayErrorBody = self.json();
        body.code
    }

    pub fn header(&self, name: &str) -> Option<String> {
        self.headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
    }
}

pub fn db_path(dir: &TempDir) -> PathBuf {
    dir.path().join("gateway.db")
}

impl Harness {
    pub async fn new() -> Self {
        Self::with(Options::default()).await
    }

    pub async fn with(options: Options) -> Self {
        let dir = Arc::new(TempDir::new().unwrap());
        let clock = Arc::new(ManualClock::at_unix(T0));
        let roots = Arc::new(FakeRoots::default());
        let epoch = T0 / u64::from(EPOCH_SECONDS);
        roots.publish(epoch - 1, root(), u64::from(LEAF_COUNT));
        Self::build(
            dir,
            clock,
            Arc::new(FakeVerifier::default()),
            Arc::new(FakeUpstream::default()),
            roots,
            options,
        )
        .await
    }

    async fn build(
        dir: Arc<TempDir>,
        clock: Arc<ManualClock>,
        verifier: Arc<FakeVerifier>,
        upstream: Arc<FakeUpstream>,
        roots: Arc<FakeRoots>,
        options: Options,
    ) -> Self {
        let store = Store::open(&db_path(&dir)).await.unwrap();
        let cached = store.cached_roots(0).await.unwrap();
        let config = GatewayConfig::new(
            deployment(),
            PriceTable::current(),
            options.limits.clone(),
            SEPOLIA_CHAIN_ID,
            ADMIN_TOKEN.to_owned(),
            vec![HeaderValue::from_static("http://localhost:5174")],
        );
        let gateway = Gateway::new(GatewayParts {
            config,
            store,
            clock: clock.clone(),
            roots: RootTracker::new(roots.clone(), cached),
            verifier: verifier.clone(),
            verifier_status: VerifierStatus {
                pkv_sha256: "99".repeat(32),
                circuit_id: CIRCUIT_ID.to_hex(),
                witness_mode: "zk".to_owned(),
            },
            upstream: upstream.clone(),
            peer: PeerPolicy::new(
                options.capture_ip,
                options.trusted.clone(),
                HeaderName::from_static(DEFAULT_FORWARDED_HEADER),
            ),
        });
        refresh_roots(&gateway).await;
        Self {
            gateway,
            clock,
            verifier,
            upstream,
            roots,
            dir,
            options,
        }
    }

    /// Stop this gateway and start a new one on the same database file.
    pub async fn restart(self) -> Self {
        self.gateway.store.close().await;
        let Self {
            gateway,
            clock,
            verifier,
            upstream,
            roots,
            dir,
            options,
        } = self;
        drop(gateway);
        Self::build(dir, clock, verifier, upstream, roots, options).await
    }

    pub fn epoch(&self) -> u64 {
        self.gateway.current_epoch()
    }

    pub fn router(&self) -> Router {
        public_router(self.gateway.clone()).layer(MockConnectInfo(self.options.peer))
    }

    pub fn admin(&self) -> Router {
        admin_router(self.gateway.clone())
    }

    pub async fn send(router: Router, request: Request<Body>) -> TestResponse {
        let response = router.oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        TestResponse {
            status,
            headers,
            body,
        }
    }

    pub async fn post_with(
        &self,
        path: &str,
        body: Vec<u8>,
        headers: &[(&str, &str)],
    ) -> TestResponse {
        let mut builder = Request::builder()
            .method("POST")
            .uri(path)
            .header("content-type", "application/json");
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        Self::send(self.router(), builder.body(Body::from(body)).unwrap()).await
    }

    pub async fn post(&self, path: &str, body: Vec<u8>) -> TestResponse {
        self.post_with(path, body, &[]).await
    }

    /// `PUT` with a raw `application/octet-stream` body (the chunk route).
    pub async fn put(&self, path: &str, body: Vec<u8>) -> TestResponse {
        let request = Request::builder()
            .method("PUT")
            .uri(path)
            .header("content-type", "application/octet-stream")
            .body(Body::from(body))
            .unwrap();
        Self::send(self.router(), request).await
    }

    pub async fn get(&self, path: &str) -> TestResponse {
        let request = Request::builder().uri(path).body(Body::empty()).unwrap();
        Self::send(self.router(), request).await
    }

    pub async fn admin_get(&self, path: &str, token: Option<&str>) -> TestResponse {
        let mut builder = Request::builder().uri(path);
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        Self::send(self.admin(), builder.body(Body::empty()).unwrap()).await
    }

    pub async fn open(&self, client: &Client) -> TestResponse {
        let request = client.open_request(self, &OpenOptions::default());
        self.post("/v1/open", serde_json::to_vec(&request).unwrap())
            .await
    }

    pub async fn open_ok(&self, client: &Client) {
        let response = self.open(client).await;
        assert_eq!(
            response.status,
            StatusCode::OK,
            "{}",
            String::from_utf8_lossy(&response.body)
        );
    }

    pub async fn spend(&self, request: &SpendRequest) -> TestResponse {
        self.post("/v1/rpc", serde_json::to_vec(request).unwrap())
            .await
    }

    pub async fn session_row(
        &self,
        client: &Client,
    ) -> Option<anon_credit_gateway::store::SessionRow> {
        self.gateway.store.session(&client.batch_id).await.unwrap()
    }
}

// ----- Client ----------------------------------------------------------------------------

#[derive(Clone, Default)]
pub struct OpenOptions {
    /// Session key bound in the proof. `None`: the client key.
    pub proof_session_pub: Option<Bytes32>,
    /// Proof epoch. `None`: the current epoch.
    pub proof_epoch: Option<u64>,
    pub root: Option<Bytes32>,
    pub leaf_count: Option<u32>,
    pub price_table_hash: Option<Bytes32>,
    pub bad_signature: bool,
}

#[derive(Clone)]
pub struct Client {
    pub key: SigningKey,
    pub batch_id: Bytes32,
}

/// Transaction hash of the `eth_getTransactionReceipt` requests of the tests.
pub const TX_HASH: &str = "0x88df016429689c079f3b2f6ad39fa052532c56795b733da78a91ebe6a713944b";

/// `eth_call` request bytes with this call object.
pub fn eth_call_bytes(id: u64, call: &Value) -> Vec<u8> {
    format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"eth_call","params":[{call},"latest"]}}"#)
        .into_bytes()
}

pub fn rpc_bytes(method: &str, id: u64) -> Vec<u8> {
    match method {
        "eth_call" => eth_call_bytes(
            id,
            &json!({"to": "0x00000000219ab540356cbb839cbe05303d7705fa", "data": "0x70a08231"}),
        ),
        "eth_getTransactionReceipt" => format!(
            r#"{{"jsonrpc":"2.0","id":{id},"method":"eth_getTransactionReceipt","params":["{TX_HASH}"]}}"#
        )
        .into_bytes(),
        "eth_getBalance" => format!(
            r#"{{"jsonrpc":"2.0","id":{id},"method":"eth_getBalance","params":["0x00000000219ab540356cbb839cbe05303d7705fa","latest"]}}"#
        )
        .into_bytes(),
        _ => format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"{method}","params":[]}}"#).into_bytes(),
    }
}

impl Client {
    pub fn new(n: u64) -> Self {
        let mut seed = [0u8; 32];
        seed[..8].copy_from_slice(&n.to_be_bytes());
        seed[31] = 0x5a;
        Self {
            key: SigningKey::from_bytes(&seed),
            batch_id: Bytes32(FieldElement::from_u64(1_000 + n).to_bytes_be()),
        }
    }

    pub fn session_pub(&self) -> Bytes32 {
        Bytes32(self.key.verifying_key().to_bytes())
    }

    pub fn sign(&self, digest: &Bytes32) -> Signature64 {
        Signature64(self.key.sign(&digest.0).to_bytes())
    }

    pub fn open_request(&self, harness: &Harness, options: &OpenOptions) -> OpenRequest {
        let config = &harness.gateway.config;
        let proof_epoch = options.proof_epoch.unwrap_or_else(|| harness.epoch());
        let root = options.root.unwrap_or_else(root);
        let leaf_count = options.leaf_count.unwrap_or(LEAF_COUNT);
        let bound_pub = options
            .proof_session_pub
            .unwrap_or_else(|| self.session_pub());
        let inputs = BatchOpenPublicInputs::for_open(
            config.deployment_id.0,
            config.gateway_id().0,
            FieldElement::from_bytes_be(&root.0).unwrap(),
            leaf_count,
            proof_epoch,
            FieldElement::from_bytes_be(&self.batch_id.0).unwrap(),
            &bound_pub.0,
        );
        let mut request = OpenRequest {
            protocol_version: PROTOCOL_VERSION,
            deployment_id: config.deployment_id,
            gateway_id: config.gateway_id(),
            batch_id: self.batch_id,
            root,
            leaf_count,
            proof_epoch: DecimalU64(proof_epoch),
            session_pub: self.session_pub(),
            price_table_hash: options.price_table_hash.unwrap_or(config.price_table_hash),
            proof: Some(Base64Bytes(fake_proof(&inputs.to_fields()))),
            proof_upload: None,
            signature: Signature64([0; 64]),
        };
        request.signature = self.sign(&request.message().digest());
        if options.bad_signature {
            request.signature.0[0] ^= 1;
        }
        request
    }

    pub fn spend_request(
        &self,
        harness: &Harness,
        seq: u64,
        units_total: u64,
        rpc: Vec<u8>,
    ) -> SpendRequest {
        let config = &harness.gateway.config;
        let mut request = SpendRequest {
            protocol_version: PROTOCOL_VERSION,
            batch_id: self.batch_id,
            seq: DecimalU64(seq),
            units_total: DecimalU64(units_total),
            rpc: Base64Bytes(rpc),
            signature: Signature64([0; 64]),
        };
        let digest = request
            .digest(
                config.deployment_id,
                config.gateway_id(),
                config.price_table_hash,
            )
            .unwrap();
        request.signature = self.sign(&digest);
        request
    }

    pub fn status_request(&self, harness: &Harness, nonce: Bytes32) -> StatusRequest {
        let config = &harness.gateway.config;
        let mut request = StatusRequest {
            protocol_version: PROTOCOL_VERSION,
            deployment_id: config.deployment_id,
            gateway_id: config.gateway_id(),
            batch_id: self.batch_id,
            nonce,
            signature: Signature64([0; 64]),
        };
        request.signature = self.sign(&request.message().digest());
        request
    }
}

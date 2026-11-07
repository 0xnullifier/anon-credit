//! Chunked proof upload (`PUT /v1/open/chunks/...` with a raw body) and `POST /v1/open` with
//! `proof_upload`.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod common;

use anon_credit_gateway::app::Limits;
use anon_credit_gateway::server::prune;
use anon_credit_gateway::upload::UploadLimits;
use anon_credit_protocol::api::{
    GatewayConfigResponse, OPEN_CHUNK_BODY_LIMIT_BYTES, OPEN_CHUNK_MAX_BYTES, OpenChunkPath,
    OpenChunkResponse, OpenRequest, OpenResponse, ProofEncoding, ProofUpload,
};
use anon_credit_protocol::{Bytes32, ErrorCode};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::{Client, Harness, OpenOptions, Options};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::sync::atomic::Ordering;

fn sha256(bytes: &[u8]) -> Bytes32 {
    Bytes32(Sha256::digest(bytes).into())
}

fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}

/// One chunk request: the path and the raw body.
#[derive(Debug, Clone)]
struct Chunk {
    path: OpenChunkPath,
    data: Vec<u8>,
}

impl Chunk {
    /// The same body with another path.
    fn at(&self, path: OpenChunkPath) -> Self {
        Self {
            path,
            data: self.data.clone(),
        }
    }
}

/// Split `bytes` into chunk requests of at most `size` bytes.
fn chunks(batch_id: Bytes32, bytes: &[u8], size: usize) -> Vec<Chunk> {
    let count = u32::try_from(bytes.len().div_ceil(size)).unwrap();
    bytes
        .chunks(size)
        .enumerate()
        .map(|(index, data)| Chunk {
            path: OpenChunkPath {
                batch_id,
                proof_sha256: sha256(bytes),
                total_bytes: u32::try_from(bytes.len()).unwrap(),
                chunk_count: count,
                chunk_index: u32::try_from(index).unwrap(),
            },
            data: data.to_vec(),
        })
        .collect()
}

async fn put_chunk(h: &Harness, chunk: &Chunk) -> common::TestResponse {
    h.put(&chunk.path.to_path(), chunk.data.clone()).await
}

async fn put_ok(h: &Harness, chunk: &Chunk) -> OpenChunkResponse {
    let response = put_chunk(h, chunk).await;
    assert_eq!(
        response.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&response.body)
    );
    response.json()
}

/// The open request of `client` with its inline proof replaced by `proof_upload`.
fn upload_request(
    h: &Harness,
    client: &Client,
    uploaded: &[u8],
    encoding: ProofEncoding,
) -> OpenRequest {
    let mut request = client.open_request(h, &OpenOptions::default());
    request.proof = None;
    request.proof_upload = Some(ProofUpload {
        proof_sha256: sha256(uploaded),
        total_bytes: u32::try_from(uploaded.len()).unwrap(),
        proof_encoding: encoding,
    });
    request
}

fn inline_proof(h: &Harness, client: &Client) -> Vec<u8> {
    client
        .open_request(h, &OpenOptions::default())
        .proof
        .unwrap()
        .0
}

async fn upload_all(h: &Harness, client: &Client, uploaded: &[u8]) {
    let all = chunks(client.batch_id, uploaded, 64);
    let count = all.len();
    for (index, chunk) in all.iter().enumerate() {
        let reply = put_ok(h, chunk).await;
        assert_eq!(reply.complete, index + 1 == count);
    }
}

#[tokio::test]
async fn open_with_a_json_upload_and_with_a_gzip_upload() {
    let h = Harness::new().await;
    for (n, encoding) in [(1, ProofEncoding::Json), (2, ProofEncoding::JsonGzip)] {
        let client = Client::new(n);
        let proof = inline_proof(&h, &client);
        let uploaded = match encoding {
            ProofEncoding::JsonGzip => gzip(&proof),
            _ => proof.clone(),
        };
        upload_all(&h, &client, &uploaded).await;
        assert_eq!(h.gateway.uploads.pending().0, 1);
        let request = upload_request(&h, &client, &uploaded, encoding);
        let response = h
            .post("/v1/open", serde_json::to_vec(&request).unwrap())
            .await;
        assert_eq!(
            response.status,
            StatusCode::OK,
            "{}",
            String::from_utf8_lossy(&response.body)
        );
        let opened: OpenResponse = response.json();
        assert!(!opened.existing);
        assert_eq!(opened.session.remaining, 100);
        // The upload is gone after the session insert.
        assert_eq!(h.gateway.uploads.pending(), (0, 0));
        let row = h.session_row(&client).await.unwrap();
        // The verifier received the decompressed proof.
        assert_eq!(row.proof_size, u32::try_from(proof.len()).unwrap());
        assert!(row.open_request_json.contains("proof_upload"));
        assert!(row.open_request_json.contains("proof_keccak256"));

        // An exact retry needs no upload: the session exists.
        let retry = h
            .post("/v1/open", serde_json::to_vec(&request).unwrap())
            .await;
        assert_eq!(retry.status, StatusCode::OK);
        assert!(retry.json::<OpenResponse>().existing);
    }
    assert_eq!(h.verifier.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn chunks_arrive_in_any_order_and_duplicates_are_idempotent() {
    let h = Harness::new().await;
    let client = Client::new(1);
    let proof = inline_proof(&h, &client);
    let mut all = chunks(client.batch_id, &proof, 50);
    assert!(all.len() >= 4);
    all.swap(0, 2);
    all.reverse();
    let last = all.len() - 1;
    for chunk in &all[..last] {
        let first = put_ok(&h, chunk).await;
        assert!(!first.complete);
        // The same chunk again: no change.
        let again = put_ok(&h, chunk).await;
        assert_eq!(again, first);
    }
    // A chunk with the same index and different bytes is refused.
    let mut changed = all[0].clone();
    changed.data[0] ^= 1;
    let refused = put_chunk(&h, &changed).await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST);
    assert_eq!(refused.error_code(), ErrorCode::InvalidRequest);
    let done = put_ok(&h, &all[last]).await;
    assert_eq!(
        done,
        OpenChunkResponse {
            received_chunks: u32::try_from(all.len()).unwrap(),
            complete: true
        }
    );
    let request = upload_request(&h, &client, &proof, ProofEncoding::Json);
    let response = h
        .post("/v1/open", serde_json::to_vec(&request).unwrap())
        .await;
    assert_eq!(response.status, StatusCode::OK);
}

#[tokio::test]
async fn sha256_mismatch_deletes_the_upload() {
    let h = Harness::new().await;
    let client = Client::new(1);
    let proof = inline_proof(&h, &client);
    let mut all = chunks(client.batch_id, &proof, 100);
    for chunk in &mut all {
        chunk.path.proof_sha256 = Bytes32([7; 32]);
    }
    let last = all.len() - 1;
    for chunk in &all[..last] {
        put_ok(&h, chunk).await;
    }
    let response = put_chunk(&h, &all[last]).await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(response.error_code(), ErrorCode::InvalidRequest);
    assert_eq!(h.gateway.uploads.pending(), (0, 0));
}

#[tokio::test]
async fn size_and_limit_rejections() {
    let limits = Limits {
        upload: UploadLimits {
            max_bytes: 200_000,
            max_chunks: 16,
            ttl_secs: 600,
            max_pending: 2,
            max_pending_bytes: 300_000,
        },
        ..Limits::default()
    };
    let h = Harness::with(Options {
        limits,
        ..Options::default()
    })
    .await;
    let batch = Client::new(1).batch_id;

    let base = OpenChunkPath {
        batch_id: batch,
        proof_sha256: Bytes32([1; 32]),
        total_bytes: 50_000,
        chunk_count: 2,
        chunk_index: 0,
    };
    // A body above 40,000 bytes is refused before the store (HTTP 413).
    let response = h
        .put(&base.to_path(), vec![0; OPEN_CHUNK_BODY_LIMIT_BYTES + 1])
        .await;
    assert_eq!(response.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(response.error_code(), ErrorCode::InvalidRequest);
    // A body of exactly 40,000 bytes is accepted.
    let largest = Chunk {
        path: OpenChunkPath {
            proof_sha256: Bytes32([9; 32]),
            ..base
        },
        data: vec![0; OPEN_CHUNK_MAX_BYTES],
    };
    put_ok(&h, &largest).await;
    assert!(
        h.gateway
            .uploads
            .remove(&anon_credit_gateway::upload::UploadKey {
                batch_id: batch,
                proof_sha256: Bytes32([9; 32]),
            })
    );

    // An empty body.
    let empty = Chunk {
        path: base,
        data: Vec::new(),
    };
    assert_eq!(put_chunk(&h, &empty).await.status, StatusCode::BAD_REQUEST);
    let small = Chunk {
        path: base,
        data: vec![0; 100],
    };
    // An upload above the upload limit.
    let huge = small.at(OpenChunkPath {
        total_bytes: 200_001,
        chunk_count: 9,
        ..base
    });
    assert_eq!(put_chunk(&h, &huge).await.status, StatusCode::BAD_REQUEST);
    // More chunks than the chunk limit.
    let many = small.at(OpenChunkPath {
        total_bytes: 1000,
        chunk_count: 17,
        ..base
    });
    assert_eq!(put_chunk(&h, &many).await.status, StatusCode::BAD_REQUEST);
    // A batch ID that is not a canonical field element.
    let bad_batch = Chunk {
        path: OpenChunkPath {
            batch_id: Bytes32([0xff; 32]),
            total_bytes: 1000,
            chunk_count: 1,
            ..base
        },
        data: vec![0; 1000],
    };
    assert_eq!(
        put_chunk(&h, &bad_batch).await.status,
        StatusCode::BAD_REQUEST
    );
    // Paths that are not canonical: each is invalid_request with a JSON error body.
    let good = base.to_path();
    let bad_paths = [
        good.replace("/50000/", "/050000/"),
        good.replace("/50000/", "/+50000/"),
        good.replace(
            &batch.to_hex(),
            &batch.to_hex().to_uppercase().replacen('X', "x", 1),
        ),
        good.replace("/2/0", "/2/-1"),
        good.replace("/50000/", "/4294967296/"),
    ];
    for path in &bad_paths {
        assert_ne!(path, &good);
        let response = h.put(path, vec![0; 10]).await;
        assert_eq!(response.status, StatusCode::BAD_REQUEST, "{path}");
        assert_eq!(response.error_code(), ErrorCode::InvalidRequest, "{path}");
    }
    // The old JSON route and a path with a missing segment do not exist.
    for path in ["/v1/open/chunks", "/v1/open/chunks/0x01/0x02/1/1"] {
        let response = h.put(path, b"{}".to_vec()).await;
        assert_eq!(response.status, StatusCode::NOT_FOUND, "{path}");
    }
    assert_eq!(h.gateway.uploads.pending(), (0, 0));

    // Pending bytes: 200,000 reserved, then 150,000 more does not fit in 300,000.
    let first = small.at(OpenChunkPath {
        total_bytes: 200_000,
        chunk_count: 9,
        ..base
    });
    put_ok(&h, &first).await;
    let second = small.at(OpenChunkPath {
        proof_sha256: Bytes32([2; 32]),
        total_bytes: 150_000,
        chunk_count: 7,
        ..first.path
    });
    let busy = put_chunk(&h, &second).await;
    assert_eq!(busy.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(busy.error_code(), ErrorCode::Busy);
    // Pending count: a second upload fits, a third is refused.
    let small_upload = small.at(OpenChunkPath {
        total_bytes: 1000,
        chunk_count: 2,
        ..second.path
    });
    put_ok(&h, &small_upload).await;
    let third = small.at(OpenChunkPath {
        proof_sha256: Bytes32([3; 32]),
        ..small_upload.path
    });
    assert_eq!(put_chunk(&h, &third).await.error_code(), ErrorCode::Busy);
}

#[tokio::test]
async fn ttl_eviction_with_the_injected_clock() {
    let h = Harness::new().await;
    let client = Client::new(1);
    let proof = inline_proof(&h, &client);
    upload_all(&h, &client, &proof).await;
    h.clock.advance_secs(599);
    prune(&h.gateway, false).await;
    assert_eq!(h.gateway.uploads.pending().0, 1);
    h.clock.advance_secs(1);
    prune(&h.gateway, false).await;
    assert_eq!(h.gateway.uploads.pending(), (0, 0));
    // The epoch moved; make the open request now. The upload is gone.
    let request = upload_request(&h, &client, &proof, ProofEncoding::Json);
    let response = h
        .post("/v1/open", serde_json::to_vec(&request).unwrap())
        .await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(response.error_code(), ErrorCode::InvalidRequest);
    assert!(h.session_row(&client).await.is_none());
}

#[tokio::test]
async fn failed_open_deletes_the_upload() {
    let h = Harness::new().await;

    // proof_invalid: the uploaded proof is for another session key.
    let client = Client::new(1);
    let other = Client::new(2);
    let wrong = client
        .open_request(
            &h,
            &OpenOptions {
                proof_session_pub: Some(other.session_pub()),
                ..OpenOptions::default()
            },
        )
        .proof
        .unwrap()
        .0;
    upload_all(&h, &client, &wrong).await;
    let request = upload_request(&h, &client, &wrong, ProofEncoding::Json);
    let response = h
        .post("/v1/open", serde_json::to_vec(&request).unwrap())
        .await;
    assert_eq!(response.error_code(), ErrorCode::ProofInvalid);
    assert_eq!(h.gateway.uploads.pending(), (0, 0));
    assert!(h.session_row(&client).await.is_none());

    // A rejection before the proof step (bad signature) also deletes the upload.
    let proof = inline_proof(&h, &client);
    upload_all(&h, &client, &proof).await;
    let mut request = upload_request(&h, &client, &proof, ProofEncoding::Json);
    request.signature.0[0] ^= 1;
    let response = h
        .post("/v1/open", serde_json::to_vec(&request).unwrap())
        .await;
    assert_eq!(response.error_code(), ErrorCode::SignatureInvalid);
    assert_eq!(h.gateway.uploads.pending(), (0, 0));

    // A gzip encoding on bytes that are not gzip.
    upload_all(&h, &client, &proof).await;
    let request = upload_request(&h, &client, &proof, ProofEncoding::JsonGzip);
    let response = h
        .post("/v1/open", serde_json::to_vec(&request).unwrap())
        .await;
    assert_eq!(response.error_code(), ErrorCode::InvalidRequest);
    assert_eq!(h.gateway.uploads.pending(), (0, 0));

    // An incomplete upload.
    let all = chunks(client.batch_id, &proof, 64);
    put_ok(&h, &all[0]).await;
    let request = upload_request(&h, &client, &proof, ProofEncoding::Json);
    let response = h
        .post("/v1/open", serde_json::to_vec(&request).unwrap())
        .await;
    assert_eq!(response.error_code(), ErrorCode::InvalidRequest);
    assert_eq!(h.gateway.uploads.pending(), (0, 0));

    // The valid upload opens the batch after the failures.
    upload_all(&h, &client, &proof).await;
    let request = upload_request(&h, &client, &proof, ProofEncoding::Json);
    let response = h
        .post("/v1/open", serde_json::to_vec(&request).unwrap())
        .await;
    assert_eq!(response.status, StatusCode::OK);
}

#[tokio::test]
async fn open_request_with_both_or_no_proof_source_is_refused() {
    let h = Harness::new().await;
    let client = Client::new(1);
    let mut both = client.open_request(&h, &OpenOptions::default());
    both.proof_upload = Some(ProofUpload {
        proof_sha256: Bytes32([1; 32]),
        total_bytes: 10,
        proof_encoding: ProofEncoding::Json,
    });
    let mut none = client.open_request(&h, &OpenOptions::default());
    none.proof = None;
    for request in [both, none] {
        let response = h
            .post("/v1/open", serde_json::to_vec(&request).unwrap())
            .await;
        assert_eq!(response.status, StatusCode::BAD_REQUEST);
        assert_eq!(response.error_code(), ErrorCode::InvalidRequest);
    }
}

#[tokio::test]
async fn config_publishes_the_upload_limits_and_cors_allows_put() {
    let h = Harness::new().await;
    let config: GatewayConfigResponse = h.get("/v1/config").await.json();
    let limits = config.limits;
    assert_eq!(limits.open_upload_max_bytes, 4 * 1024 * 1024);
    assert_eq!(limits.open_upload_chunk_bytes, 40_000);
    assert_eq!(limits.open_upload_chunk_body_bytes, 40_000);
    assert_eq!(limits.open_upload_max_chunks, 256);
    assert_eq!(limits.open_upload_ttl_seconds, 600);
    assert_eq!(limits.open_upload_max_pending, 1000);
    assert_eq!(limits.open_upload_max_pending_bytes, 512 * 1024 * 1024);

    let preflight = Request::builder()
        .method("OPTIONS")
        .uri(
            OpenChunkPath {
                batch_id: Bytes32([1; 32]),
                proof_sha256: Bytes32([2; 32]),
                total_bytes: 10,
                chunk_count: 1,
                chunk_index: 0,
            }
            .to_path(),
        )
        .header("origin", "http://localhost:5174")
        .header("access-control-request-method", "PUT")
        .header("access-control-request-headers", "content-type")
        .body(Body::empty())
        .unwrap();
    let response = Harness::send(h.router(), preflight).await;
    assert_eq!(response.status, StatusCode::OK);
    let methods = response
        .header("access-control-allow-methods")
        .unwrap_or_default();
    assert!(methods.contains("PUT"), "{methods}");
}

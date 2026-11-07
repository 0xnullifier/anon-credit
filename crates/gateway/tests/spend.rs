//! Spend pipeline tests (implementation.md section 11, Architecture.md section 5.2).

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod common;

use anon_credit_gateway::upstream::HttpUpstream;
use anon_credit_protocol::api::{GatewayErrorBody, StatusResponse};
use anon_credit_protocol::{Bytes32, ErrorCode};
use axum::Router;
use axum::body::{Body, Bytes};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use common::*;
use serde_json::{Value, json};
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

async fn opened(n: u64) -> (Harness, Client) {
    let h = Harness::new().await;
    let client = Client::new(n);
    h.open_ok(&client).await;
    (h, client)
}

fn headers(response: &TestResponse) -> (String, String, String) {
    (
        response.header("x-anon-remaining").unwrap(),
        response.header("x-anon-next-seq").unwrap(),
        response.header("x-anon-replayed").unwrap(),
    )
}

#[tokio::test]
async fn three_reads_charge_1_1_2_units() {
    let (h, client) = opened(1).await;
    let plan = [
        ("eth_chainId", 1u64, "99"),
        ("eth_blockNumber", 2, "98"),
        ("eth_getBalance", 4, "96"),
    ];
    for (seq, (method, units_total, remaining)) in plan.iter().enumerate() {
        let seq = seq as u64;
        let rpc = rpc_bytes(method, seq + 1);
        let request = client.spend_request(&h, seq, *units_total, rpc.clone());
        let response = h.spend(&request).await;
        assert_eq!(response.status, StatusCode::OK, "{method}");
        assert_eq!(
            headers(&response),
            (
                remaining.to_string(),
                (seq + 1).to_string(),
                "false".to_owned()
            )
        );
        assert_eq!(
            response.header("content-type").as_deref(),
            Some("application/json")
        );
        let body: serde_json::Value = response.json();
        assert_eq!(body["result"], upstream_result(method));
        // The gateway forwards the exact client bytes.
        assert_eq!(
            h.upstream.bodies.lock().unwrap().last().unwrap().as_ref(),
            rpc.as_slice()
        );
    }
    let row = h.session_row(&client).await.unwrap();
    assert_eq!((row.remaining, row.units_total, row.next_seq), (96, 4, 3));
    let receipts = h
        .gateway
        .store
        .receipts(&client.batch_id, 10)
        .await
        .unwrap();
    assert_eq!(receipts.len(), 3);
    assert_eq!(receipts[0].method, "eth_getBalance");
}

#[tokio::test]
async fn eth_call_and_receipt_charge_3_and_2_units() {
    let (h, client) = opened(31).await;
    let plan = [
        ("eth_call", 3u64, "97"),
        ("eth_getTransactionReceipt", 5, "95"),
    ];
    for (seq, (method, units_total, remaining)) in plan.iter().enumerate() {
        let seq = seq as u64;
        let rpc = rpc_bytes(method, seq + 1);
        let request = client.spend_request(&h, seq, *units_total, rpc.clone());
        let response = h.spend(&request).await;
        assert_eq!(
            response.status,
            StatusCode::OK,
            "{method}: {}",
            String::from_utf8_lossy(&response.body)
        );
        assert_eq!(
            headers(&response),
            (
                remaining.to_string(),
                (seq + 1).to_string(),
                "false".to_owned()
            )
        );
        let body: Value = response.json();
        assert_eq!(body["result"], upstream_result(method));
        assert_eq!(
            h.upstream.bodies.lock().unwrap().last().unwrap().as_ref(),
            rpc.as_slice()
        );
    }
    let row = h.session_row(&client).await.unwrap();
    assert_eq!((row.remaining, row.units_total, row.next_seq), (95, 5, 2));
    let receipts = h
        .gateway
        .store
        .receipts(&client.batch_id, 10)
        .await
        .unwrap();
    let mut methods: Vec<(String, u32)> = receipts
        .iter()
        .map(|receipt| (receipt.method.clone(), receipt.units))
        .collect();
    methods.sort();
    assert_eq!(
        methods,
        vec![
            ("eth_call".to_owned(), 3),
            ("eth_getTransactionReceipt".to_owned(), 2)
        ]
    );
}

#[tokio::test]
async fn bad_eth_call_and_receipt_params_are_rejected_before_the_upstream() {
    let (h, client) = opened(32).await;
    let to = "0x00000000219ab540356cbb839cbe05303d7705fa";
    let long = format!("0x{}", "ab".repeat(8 * 1024 + 1));
    let bad: [Vec<u8>; 5] = [
        eth_call_bytes(1, &json!({"data": "0x00"})),
        eth_call_bytes(1, &json!({"to": to, "nonce": "0x1"})),
        eth_call_bytes(1, &json!({"to": to, "data": long})),
        br#"{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x00000000219ab540356cbb839cbe05303d7705fa"}]}"#.to_vec(),
        br#"{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["0x1234"]}"#.to_vec(),
    ];
    for rpc in bad {
        let units = match rpc.windows(8).any(|w| w == b"eth_call") {
            true => 3,
            false => 2,
        };
        let request = client.spend_request(&h, 0, units, rpc.clone());
        let response = h.spend(&request).await;
        assert_eq!(
            response.status,
            StatusCode::BAD_REQUEST,
            "{}",
            String::from_utf8_lossy(&rpc)
        );
        assert_eq!(response.error_code(), ErrorCode::InvalidRequest);
    }
    assert_eq!(h.upstream.calls(), 0);
    let row = h.session_row(&client).await.unwrap();
    assert_eq!((row.remaining, row.next_seq, row.units_total), (100, 0, 0));
}

/// A loopback JSON-RPC node for `eth_call`. The call data selects the result:
/// `0x01` gives a result above the response limit with a `content-length` header, `0x02`
/// gives a result above the limit as a stream with no length, and other data gives a
/// 32-byte result.
async fn serve_eth_call_node(limit: usize) -> SocketAddr {
    let app = Router::new().route(
        "/",
        post(move |body: Bytes| async move {
            let request: Value = serde_json::from_slice(&body).unwrap();
            let data = request["params"][0]["data"]
                .as_str()
                .unwrap_or("")
                .to_owned();
            let large = format!("0x{}", "ab".repeat(limit));
            let text = |result: &str| {
                json!({"jsonrpc": "2.0", "id": request["id"], "result": result}).to_string()
            };
            let response: Response = match data.as_str() {
                "0x01" => text(&large).into_response(),
                "0x02" => {
                    let chunks: Vec<Result<Bytes, std::io::Error>> = text(&large)
                        .into_bytes()
                        .chunks(4096)
                        .map(|chunk| Ok(Bytes::copy_from_slice(chunk)))
                        .collect();
                    Body::from_stream(futures_util::stream::iter(chunks)).into_response()
                }
                _ => text(&format!("0x{}", "00".repeat(31) + "2a")).into_response(),
            };
            response
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    addr
}

#[tokio::test]
async fn eth_call_response_above_the_limit_is_upstream_failed_without_charge() {
    let (h, client) = opened(33).await;
    let limit = h.gateway.config.limits.upstream_response_bytes;
    let addr = serve_eth_call_node(limit).await;
    let url = reqwest::Url::parse(&format!("http://{addr}/")).unwrap();
    h.upstream.relay_to(Arc::new(
        HttpUpstream::new(url, Duration::from_secs(5), limit).unwrap(),
    ));
    let to = "0x00000000219ab540356cbb839cbe05303d7705fa";

    for data in ["0x01", "0x02"] {
        let rpc = eth_call_bytes(1, &json!({"to": to, "data": data}));
        let request = client.spend_request(&h, 0, 3, rpc);
        let response = h.spend(&request).await;
        assert_eq!(response.status, StatusCode::BAD_GATEWAY, "data {data}");
        assert_eq!(response.error_code(), ErrorCode::UpstreamFailed);
        assert!(response.json::<GatewayErrorBody>().retryable);
        let row = h.session_row(&client).await.unwrap();
        assert_eq!((row.remaining, row.next_seq, row.units_total), (100, 0, 0));
    }
    assert_eq!(h.upstream.calls(), 2);
    assert!(
        h.gateway
            .store
            .receipts(&client.batch_id, 10)
            .await
            .unwrap()
            .is_empty()
    );

    // The gateway continues to serve: the same sequence with a small result is charged.
    let rpc = eth_call_bytes(2, &json!({"to": to, "data": "0x70a08231"}));
    let request = client.spend_request(&h, 0, 3, rpc);
    let response = h.spend(&request).await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(
        headers(&response),
        ("97".to_owned(), "1".to_owned(), "false".to_owned())
    );
}

#[tokio::test]
async fn replay_with_same_digest_returns_stored_response_without_charge() {
    let (h, client) = opened(2).await;
    let request = client.spend_request(&h, 0, 1, rpc_bytes("eth_chainId", 7));
    let first = h.spend(&request).await;
    assert_eq!(first.status, StatusCode::OK);
    let second = client.spend_request(&h, 1, 2, rpc_bytes("eth_blockNumber", 8));
    assert_eq!(h.spend(&second).await.status, StatusCode::OK);
    let calls = h.upstream.calls();

    let replay = h.spend(&request).await;
    assert_eq!(replay.status, StatusCode::OK);
    assert_eq!(replay.body, first.body);
    assert_eq!(
        headers(&replay),
        ("98".to_owned(), "2".to_owned(), "true".to_owned())
    );
    assert_eq!(h.upstream.calls(), calls);
    let row = h.session_row(&client).await.unwrap();
    assert_eq!((row.remaining, row.next_seq), (98, 2));
}

#[tokio::test]
async fn reuse_of_a_sequence_with_another_body_is_a_conflict() {
    let (h, client) = opened(3).await;
    let request = client.spend_request(&h, 0, 1, rpc_bytes("eth_chainId", 1));
    assert_eq!(h.spend(&request).await.status, StatusCode::OK);
    let other = client.spend_request(&h, 0, 1, rpc_bytes("eth_blockNumber", 1));
    let response = h.spend(&other).await;
    assert_eq!(response.status, StatusCode::CONFLICT);
    assert_eq!(response.error_code(), ErrorCode::SequenceConflict);
    let row = h.session_row(&client).await.unwrap();
    assert_eq!((row.remaining, row.next_seq), (99, 1));
}

#[tokio::test]
async fn sequence_gap_is_rejected_without_change() {
    let (h, client) = opened(4).await;
    let request = client.spend_request(&h, 1, 1, rpc_bytes("eth_chainId", 1));
    let response = h.spend(&request).await;
    assert_eq!(response.error_code(), ErrorCode::SequenceGap);
    assert_eq!(h.upstream.calls(), 0);
    let row = h.session_row(&client).await.unwrap();
    assert_eq!((row.remaining, row.next_seq), (100, 0));
}

#[tokio::test]
async fn bad_signature_is_rejected_first() {
    let (h, client) = opened(5).await;
    let mut request = client.spend_request(&h, 0, 1, rpc_bytes("eth_chainId", 1));
    request.signature.0[10] ^= 0x40;
    let response = h.spend(&request).await;
    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
    assert_eq!(response.error_code(), ErrorCode::SignatureInvalid);
    // Another key signs a valid message: also rejected.
    let mut thief = Client::new(99);
    thief.batch_id = client.batch_id;
    let response = h
        .spend(&thief.spend_request(&h, 0, 1, rpc_bytes("eth_chainId", 1)))
        .await;
    assert_eq!(response.error_code(), ErrorCode::SignatureInvalid);
    // A changed field after signing: also rejected.
    let mut request = client.spend_request(&h, 0, 1, rpc_bytes("eth_chainId", 1));
    request.units_total.0 = 0;
    assert_eq!(
        h.spend(&request).await.error_code(),
        ErrorCode::SignatureInvalid
    );
    assert_eq!(h.upstream.calls(), 0);
    let row = h.session_row(&client).await.unwrap();
    assert_eq!((row.remaining, row.next_seq), (100, 0));
}

#[tokio::test]
async fn unknown_session_is_not_found() {
    let h = Harness::new().await;
    let client = Client::new(6);
    let response = h
        .spend(&client.spend_request(&h, 0, 1, rpc_bytes("eth_chainId", 1)))
        .await;
    assert_eq!(response.status, StatusCode::NOT_FOUND);
    assert_eq!(response.error_code(), ErrorCode::NotFound);
}

#[tokio::test]
async fn exhaustion_rejects_further_spends_without_advancing() {
    let (h, client) = opened(7).await;
    for seq in 0..100u64 {
        let request = client.spend_request(&h, seq, seq + 1, rpc_bytes("eth_chainId", seq));
        let response = h.spend(&request).await;
        assert_eq!(response.status, StatusCode::OK, "seq {seq}");
    }
    let row = h.session_row(&client).await.unwrap();
    assert_eq!(
        (row.remaining, row.next_seq, row.units_total),
        (0, 100, 100)
    );
    let request = client.spend_request(&h, 100, 101, rpc_bytes("eth_chainId", 100));
    let response = h.spend(&request).await;
    assert_eq!(response.status, StatusCode::PAYMENT_REQUIRED);
    assert_eq!(response.error_code(), ErrorCode::InsufficientUnits);
    let row = h.session_row(&client).await.unwrap();
    assert_eq!((row.remaining, row.next_seq), (0, 100));
    assert_eq!(h.upstream.calls(), 100);
}

#[tokio::test]
async fn two_unit_method_needs_two_units() {
    let (h, client) = opened(8).await;
    for seq in 0..99u64 {
        let request = client.spend_request(&h, seq, seq + 1, rpc_bytes("eth_chainId", seq));
        assert_eq!(h.spend(&request).await.status, StatusCode::OK);
    }
    let request = client.spend_request(&h, 99, 101, rpc_bytes("eth_getBalance", 99));
    assert_eq!(
        h.spend(&request).await.error_code(),
        ErrorCode::InsufficientUnits
    );
    let request = client.spend_request(&h, 99, 100, rpc_bytes("eth_blockNumber", 99));
    assert_eq!(h.spend(&request).await.status, StatusCode::OK);
}

#[tokio::test]
async fn units_total_must_be_cumulative() {
    let (h, client) = opened(9).await;
    let request = client.spend_request(&h, 0, 2, rpc_bytes("eth_chainId", 1));
    let response = h.spend(&request).await;
    assert_eq!(response.error_code(), ErrorCode::InvalidRequest);
    assert_eq!(h.upstream.calls(), 0);
}

#[tokio::test]
async fn methods_and_params_are_allowlisted() {
    let (h, client) = opened(10).await;
    let logs = br#"{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[]}"#.to_vec();
    let response = h.spend(&client.spend_request(&h, 0, 1, logs)).await;
    assert_eq!(response.error_code(), ErrorCode::MethodNotAllowed);
    let bad_params = br#"{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[1]}"#.to_vec();
    let response = h.spend(&client.spend_request(&h, 0, 1, bad_params)).await;
    assert_eq!(response.error_code(), ErrorCode::InvalidRequest);
    let duplicate =
        br#"{"jsonrpc":"2.0","id":1,"method":"eth_chainId","method":"eth_call"}"#.to_vec();
    let response = h.spend(&client.spend_request(&h, 0, 1, duplicate)).await;
    assert_eq!(response.error_code(), ErrorCode::InvalidRequest);
    let batch = br#"[{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}]"#.to_vec();
    let response = h.spend(&client.spend_request(&h, 0, 1, batch)).await;
    assert_eq!(response.error_code(), ErrorCode::InvalidRequest);
    let notification = br#"{"jsonrpc":"2.0","method":"eth_chainId"}"#.to_vec();
    let response = h.spend(&client.spend_request(&h, 0, 1, notification)).await;
    assert_eq!(response.error_code(), ErrorCode::InvalidRequest);
    assert_eq!(h.upstream.calls(), 0);
    let row = h.session_row(&client).await.unwrap();
    assert_eq!((row.remaining, row.next_seq), (100, 0));
}

#[tokio::test]
async fn upstream_failures_leave_the_row_unchanged() {
    let (h, client) = opened(11).await;
    let request = client.spend_request(&h, 0, 1, rpc_bytes("eth_chainId", 1));
    for mode in [
        UpstreamMode::Transport,
        UpstreamMode::Status(502),
        UpstreamMode::Status(429),
        UpstreamMode::Malformed,
        UpstreamMode::WrongId,
    ] {
        h.upstream.set(mode);
        let response = h.spend(&request).await;
        assert_eq!(response.status, StatusCode::BAD_GATEWAY, "{mode:?}");
        assert_eq!(response.error_code(), ErrorCode::UpstreamFailed);
        let row = h.session_row(&client).await.unwrap();
        assert_eq!((row.remaining, row.next_seq, row.units_total), (100, 0, 0));
    }
    // The client retries the same sequence after the upstream recovers.
    h.upstream.set(UpstreamMode::Normal);
    assert_eq!(h.spend(&request).await.status, StatusCode::OK);
    let row = h.session_row(&client).await.unwrap();
    assert_eq!((row.remaining, row.next_seq), (99, 1));
}

#[tokio::test]
async fn json_rpc_error_with_http_200_is_charged() {
    let (h, client) = opened(12).await;
    h.upstream.set(UpstreamMode::RpcError);
    let request = client.spend_request(&h, 0, 2, rpc_bytes("eth_getBalance", 1));
    let response = h.spend(&request).await;
    assert_eq!(response.status, StatusCode::OK);
    let body: serde_json::Value = response.json();
    assert_eq!(body["error"]["code"], -32000);
    assert_eq!(response.header("x-anon-remaining").as_deref(), Some("98"));
}

#[tokio::test]
async fn commit_failure_returns_storage_unavailable_and_no_response() {
    let (h, client) = opened(13).await;
    // Inject a store failure: the receipt insert fails inside the debit transaction.
    sqlx::query(
        "CREATE TRIGGER fail_receipts BEFORE INSERT ON receipts \
         BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
    )
    .execute(h.gateway.store.pool())
    .await
    .unwrap();
    let request = client.spend_request(&h, 0, 1, rpc_bytes("eth_chainId", 1));
    let response = h.spend(&request).await;
    assert_eq!(response.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(response.error_code(), ErrorCode::StorageUnavailable);
    // The body is the error, not the upstream result.
    assert!(!String::from_utf8_lossy(&response.body).contains("0xaa36a7"));
    assert!(response.header("x-anon-remaining").is_none());
    let row = h.session_row(&client).await.unwrap();
    assert_eq!((row.remaining, row.next_seq, row.units_total), (100, 0, 0));
    assert!(
        h.gateway
            .store
            .receipt(&client.batch_id, 0)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(h.gateway.events.counters().storage_failed.0, 1);

    // After the store recovers, the same request succeeds. The upstream runs again.
    sqlx::query("DROP TRIGGER fail_receipts")
        .execute(h.gateway.store.pool())
        .await
        .unwrap();
    assert_eq!(h.spend(&request).await.status, StatusCode::OK);
    assert_eq!(h.upstream.calls(), 2);
}

#[tokio::test]
async fn stored_response_expires_after_60_seconds() {
    let (h, client) = opened(14).await;
    let request = client.spend_request(&h, 0, 1, rpc_bytes("eth_chainId", 1));
    assert_eq!(h.spend(&request).await.status, StatusCode::OK);
    h.clock.advance_secs(59);
    assert_eq!(h.spend(&request).await.status, StatusCode::OK);
    h.clock.advance_secs(1);
    let response = h.spend(&request).await;
    assert_eq!(response.status, StatusCode::GONE);
    let body: GatewayErrorBody = response.json();
    assert_eq!(body.code, ErrorCode::ResponseExpired);
    let receipt = body.receipt.unwrap();
    assert_eq!(receipt.seq.0, 0);
    assert_eq!(receipt.units, 1);
    assert_eq!(receipt.units_total.0, 1);
    assert_eq!(receipt.committed_at.0, T0);
    assert!(!receipt.response_retained);
    // The pruning task removes the bytes; the metadata stays.
    anon_credit_gateway::server::prune(&h.gateway, false).await;
    let row = h
        .gateway
        .store
        .receipt(&client.batch_id, 0)
        .await
        .unwrap()
        .unwrap();
    assert!(row.response_bytes.is_none());
    // A different body with the expired sequence is still a conflict.
    let other = client.spend_request(&h, 0, 1, rpc_bytes("eth_chainId", 2));
    assert_eq!(
        h.spend(&other).await.error_code(),
        ErrorCode::SequenceConflict
    );
}

#[tokio::test]
async fn state_survives_a_restart() {
    let (h, client) = opened(15).await;
    let first = client.spend_request(&h, 0, 1, rpc_bytes("eth_chainId", 1));
    let response = h.spend(&first).await;
    assert_eq!(response.status, StatusCode::OK);
    let h = h.restart().await;
    // The committed response survives within the retention time.
    let replay = h.spend(&first).await;
    assert_eq!(replay.status, StatusCode::OK);
    assert_eq!(replay.body, response.body);
    assert_eq!(replay.header("x-anon-replayed").as_deref(), Some("true"));
    // The sequence continues.
    let next = client.spend_request(&h, 1, 3, rpc_bytes("eth_getBalance", 2));
    let response = h.spend(&next).await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.header("x-anon-remaining").as_deref(), Some("97"));
    // The open is still an exact retry, not a new session.
    let open = h.open(&client).await;
    assert_eq!(open.status, StatusCode::OK);
    assert!(
        open.json::<anon_credit_protocol::api::OpenResponse>()
            .existing
    );
    // Roots come from the cache before the first refresh.
    assert_eq!(h.gateway.roots.accepted(h.epoch()).len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_requests_with_one_sequence_charge_once() {
    let (h, client) = opened(16).await;
    let h = Arc::new(h);
    h.upstream.delay_ms.store(30, Ordering::SeqCst);
    let mut tasks = Vec::new();
    for id in 0..8u64 {
        let h = h.clone();
        let request = client.spend_request(&h, 0, 1, rpc_bytes("eth_chainId", id));
        tasks.push(tokio::spawn(async move { h.spend(&request).await }));
    }
    let mut ok = 0;
    for task in tasks {
        let response = task.await.unwrap();
        match response.status {
            StatusCode::OK => ok += 1,
            _ => assert_eq!(response.error_code(), ErrorCode::SequenceConflict),
        }
    }
    assert_eq!(ok, 1);
    assert_eq!(h.upstream.calls(), 1);
    let row = h.session_row(&client).await.unwrap();
    assert_eq!((row.remaining, row.next_seq), (99, 1));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn identical_concurrent_requests_charge_once_and_replay() {
    let (h, client) = opened(17).await;
    let h = Arc::new(h);
    h.upstream.delay_ms.store(30, Ordering::SeqCst);
    let request = client.spend_request(&h, 0, 1, rpc_bytes("eth_chainId", 1));
    let mut tasks = Vec::new();
    for _ in 0..4 {
        let h = h.clone();
        let request = request.clone();
        tasks.push(tokio::spawn(async move { h.spend(&request).await }));
    }
    let mut replayed = 0;
    for task in tasks {
        let response = task.await.unwrap();
        assert_eq!(response.status, StatusCode::OK);
        replayed += usize::from(response.header("x-anon-replayed").as_deref() == Some("true"));
    }
    assert_eq!(replayed, 3);
    assert_eq!(h.upstream.calls(), 1);
}

#[tokio::test]
async fn lock_wait_limit_gives_busy() {
    let limits = anon_credit_gateway::app::Limits {
        batch_lock_wait: std::time::Duration::from_millis(20),
        ..anon_credit_gateway::app::Limits::default()
    };
    let h = Arc::new(
        Harness::with(Options {
            limits,
            ..Options::default()
        })
        .await,
    );
    let client = Client::new(18);
    h.open_ok(&client).await;
    h.upstream.delay_ms.store(300, Ordering::SeqCst);
    let slow = {
        let h = h.clone();
        let request = client.spend_request(&h, 0, 1, rpc_bytes("eth_chainId", 1));
        tokio::spawn(async move { h.spend(&request).await })
    };
    while h.upstream.calls() == 0 {
        tokio::task::yield_now().await;
    }
    let second = client.spend_request(&h, 1, 2, rpc_bytes("eth_chainId", 2));
    let response = h.spend(&second).await;
    assert_eq!(response.error_code(), ErrorCode::Busy);
    assert_eq!(slow.await.unwrap().status, StatusCode::OK);
}

#[tokio::test]
async fn session_expires_after_its_deadline() {
    let (h, client) = opened(19).await;
    let deadline = h.session_row(&client).await.unwrap().deadline_epoch;
    h.clock.set_unix(deadline * u64::from(EPOCH_SECONDS));
    let request = client.spend_request(&h, 0, 1, rpc_bytes("eth_chainId", 1));
    assert_eq!(h.spend(&request).await.status, StatusCode::OK);
    h.clock.set_unix((deadline + 1) * u64::from(EPOCH_SECONDS));
    let request = client.spend_request(&h, 1, 2, rpc_bytes("eth_chainId", 2));
    let response = h.spend(&request).await;
    assert_eq!(response.error_code(), ErrorCode::SessionExpired);
    // The row stays through deadline + 1, then pruning removes it.
    anon_credit_gateway::server::prune(&h.gateway, true).await;
    assert!(h.session_row(&client).await.is_some());
    h.clock.set_unix((deadline + 2) * u64::from(EPOCH_SECONDS));
    anon_credit_gateway::server::prune(&h.gateway, true).await;
    assert!(h.session_row(&client).await.is_none());
}

#[tokio::test]
async fn spend_body_limit_is_64_kib() {
    let (h, client) = opened(20).await;
    let mut rpc = rpc_bytes("eth_chainId", 1);
    rpc.extend(std::iter::repeat_n(b' ', 64 * 1024));
    let request = client.spend_request(&h, 0, 1, rpc);
    let response = h.spend(&request).await;
    assert_eq!(response.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(response.error_code(), ErrorCode::InvalidRequest);
    assert_eq!(h.upstream.calls(), 0);
}

#[tokio::test]
async fn signed_status_returns_state_receipt_and_nonce() {
    let (h, client) = opened(21).await;
    let nonce = Bytes32([0x5a; 32]);
    let request = client.status_request(&h, nonce);
    let response = h
        .post("/v1/session/status", serde_json::to_vec(&request).unwrap())
        .await;
    assert_eq!(response.status, StatusCode::OK);
    let status: StatusResponse = response.json();
    assert_eq!(status.nonce, nonce);
    assert_eq!(status.session.remaining, 100);
    assert!(status.latest_receipt.is_none());

    let spend = client.spend_request(&h, 0, 2, rpc_bytes("eth_getBalance", 1));
    assert_eq!(h.spend(&spend).await.status, StatusCode::OK);
    let response = h
        .post("/v1/session/status", serde_json::to_vec(&request).unwrap())
        .await;
    let status: StatusResponse = response.json();
    assert_eq!(status.session.remaining, 98);
    assert_eq!(status.session.next_seq.0, 1);
    let receipt = status.latest_receipt.unwrap();
    assert_eq!(
        (receipt.seq.0, receipt.units, receipt.response_retained),
        (0, 2, true)
    );

    let mut bad = client.status_request(&h, Bytes32([1; 32]));
    bad.nonce = Bytes32([2; 32]);
    let response = h
        .post("/v1/session/status", serde_json::to_vec(&bad).unwrap())
        .await;
    assert_eq!(response.error_code(), ErrorCode::SignatureInvalid);
}

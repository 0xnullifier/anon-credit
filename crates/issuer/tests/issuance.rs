//! Issuance: finality wait, idempotency, duplicate logs, and invalid payments.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod common;

use alloy::primitives::U256;
use anon_credit_crypto::batch::leaf;
use anon_credit_issuer::service::{ServiceError, TopupOutcome};
use anon_credit_issuer::verify::PaymentKey;
use anon_credit_protocol::issuer_api::{PendingReason, RejectReason, TopupResponse, TopupStatus};
use anon_credit_registry::{MmrStore, SqliteStore};
use common::*;

fn key(tx_hash: alloy::primitives::B256, log_index: u32) -> PaymentKey {
    PaymentKey {
        chain_id: CHAIN_ID,
        tx_hash,
        log_index,
    }
}

fn body(outcome: &TopupOutcome) -> &TopupResponse {
    match outcome {
        TopupOutcome::Issued(body) | TopupOutcome::Pending(body) | TopupOutcome::Rejected(body) => {
            body
        }
    }
}

async fn leaf_count(h: &Harness) -> u32 {
    let mut conn = h.pool.acquire().await.unwrap();
    SqliteStore::open(&mut conn)
        .await
        .unwrap()
        .leaf_count()
        .unwrap()
}

#[tokio::test]
async fn payment_waits_for_finality_then_issues_once() {
    let h = harness().await;
    let commitments = [commitment(1), commitment(2), commitment(3)];
    h.chain.purchase(tx(1), 100, 4, 0, &commitments);
    h.chain.finalize(99);

    // Block 100 is not finalized: the payment is tracked as pending.
    let outcome = h.service.submit_topup(&key(tx(1), 4)).await.unwrap();
    let TopupOutcome::Pending(pending) = &outcome else {
        panic!("expected pending, got {outcome:?}");
    };
    assert_eq!(
        pending.pending_reason,
        Some(PendingReason::AwaitingFinality)
    );
    assert_eq!(pending.block_number.map(|b| b.0), Some(100));
    assert_eq!(pending.finalized_block.map(|b| b.0), Some(99));
    let report = h.service.indexer_tick().await.unwrap();
    assert_eq!(report.issued, 0);
    assert_eq!(report.next_block, 100);
    assert_eq!(leaf_count(&h).await, 0);
    let status = h
        .service
        .topup_status(&key(tx(1), 4))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(body(&status).status, TopupStatus::Pending);

    // Finality reaches block 100 in epoch 1003.
    h.clock.advance(3 * 30 + 7);
    h.chain.finalize(100);
    let report = h.service.indexer_tick().await.unwrap();
    assert_eq!(report.issued, 1);
    assert_eq!(report.next_block, 101);
    assert_eq!(leaf_count(&h).await, 3);

    let status = h
        .service
        .topup_status(&key(tx(1), 4))
        .await
        .unwrap()
        .unwrap();
    let TopupOutcome::Issued(issued) = &status else {
        panic!("expected issued, got {status:?}");
    };
    let issuance = issued.issuance.as_ref().unwrap();
    assert_eq!(issuance.insertion_epoch.0, 1003);
    assert_eq!(issuance.eligible_epoch.0, 1004);
    assert_eq!(issuance.expiry.0, 1003 + u64::from(LIFETIME));
    assert_eq!(issuance.amount_wei.0, 3 * PRICE);
    assert_eq!(issuance.payer.0, payer().0.0);
    let indices: Vec<u32> = issuance.leaves.iter().map(|l| l.leaf_index).collect();
    assert_eq!(indices, vec![0, 1, 2]);
    for (issued_leaf, c) in issuance.leaves.iter().zip(commitments) {
        assert_eq!(issued_leaf.commitment, c);
        assert_eq!(issued_leaf.leaf, leaf(c, issuance.expiry.0));
    }

    // A second registration and a second indexer pass change nothing.
    let again = h.service.submit_topup(&key(tx(1), 4)).await.unwrap();
    assert_eq!(again, status);
    let report = h.service.indexer_tick().await.unwrap();
    assert_eq!(report.issued, 0);
    assert_eq!(leaf_count(&h).await, 3);
}

#[tokio::test]
async fn missing_finality_is_reported_and_never_replaced_by_a_depth() {
    let h = harness().await;
    h.chain.purchase(tx(1), 10, 0, 0, &[commitment(1)]);
    // The chain is 1000 blocks past the purchase, but it gives no finalized tag.
    h.chain.add_block(1010);
    h.chain.state().finalized = None;

    let outcome = h.service.submit_topup(&key(tx(1), 0)).await.unwrap();
    assert_eq!(
        body(&outcome).pending_reason,
        Some(PendingReason::FinalityUnavailable)
    );
    let report = h.service.indexer_tick().await.unwrap();
    assert!(report.finality_unavailable);
    assert_eq!(report.issued, 0);
    assert_eq!(leaf_count(&h).await, 0);
    assert!(h.service.observed().finality_problem.is_some());

    h.chain.finalize(1010);
    let report = h.service.indexer_tick().await.unwrap();
    assert_eq!(report.issued, 1);
    assert!(h.service.observed().finality_problem.is_none());
}

#[tokio::test]
async fn direct_issue_of_the_same_payment_is_idempotent() {
    let h = harness().await;
    h.chain
        .purchase(tx(7), 5, 1, 9, &[commitment(1), commitment(2)]);
    h.chain.finalize(5);
    let k = key(tx(7), 1);
    // Run the indexer and two registrations at the same time on a new payment.
    let (a, b, c) = tokio::join!(
        h.service.submit_topup(&k),
        h.service.indexer_tick(),
        h.service.submit_topup(&k),
    );
    let (a, b, c) = (a.unwrap(), b.unwrap(), c.unwrap());
    assert_eq!(a, c);
    assert!(matches!(a, TopupOutcome::Issued(_)));
    assert!(b.issued <= 1);
    assert_eq!(h.service.submit_topup(&k).await.unwrap(), a);
    assert_eq!(leaf_count(&h).await, 2);
    let mut conn = h.pool.acquire().await.unwrap();
    let payments: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM payments")
        .fetch_one(&mut *conn)
        .await
        .unwrap();
    assert_eq!(payments, 1);
}

#[tokio::test]
async fn duplicate_logs_from_get_logs_issue_once() {
    let h = harness().await;
    let log = h.chain.purchase(tx(3), 20, 2, 0, &[commitment(5)]);
    // The RPC returns the same log twice (for example from overlapping ranges).
    h.chain.state().logs.push(log);
    h.chain.finalize(25);
    let report = h.service.indexer_tick().await.unwrap();
    assert_eq!(report.issued, 1);
    assert_eq!(leaf_count(&h).await, 1);
    // A later pass from an earlier cursor finds the log again and issues nothing.
    sqlx::query("UPDATE indexer_state SET next_block = 0")
        .execute(&h.pool)
        .await
        .unwrap();
    let report = h.service.indexer_tick().await.unwrap();
    assert_eq!(report.issued, 0);
    assert_eq!(leaf_count(&h).await, 1);
}

#[tokio::test]
async fn two_logs_in_one_transaction_are_two_payments() {
    let h = harness().await;
    let first = purchased_log(sale(), tx(4), 30, 0, 0, &[commitment(1)], U256::from(PRICE));
    let second = purchased_log(sale(), tx(4), 30, 1, 1, &[commitment(2)], U256::from(PRICE));
    h.chain
        .add_receipt(tx(4), 30, true, vec![first.clone(), second.clone()]);
    h.chain.state().logs.extend([first, second]);
    h.chain.finalize(30);
    let report = h.service.indexer_tick().await.unwrap();
    assert_eq!(report.issued, 2);
    assert_eq!(leaf_count(&h).await, 2);
}

async fn assert_rejected(h: &Harness, k: PaymentKey, reason: RejectReason) {
    let outcome = h.service.submit_topup(&k).await.unwrap();
    let TopupOutcome::Rejected(body) = &outcome else {
        panic!("expected rejected, got {outcome:?}");
    };
    assert_eq!(body.reject_reason, Some(reason));
    // A rejected registration is not stored.
    assert!(h.service.topup_status(&k).await.unwrap().is_none());
}

#[tokio::test]
async fn invalid_payments_are_rejected() {
    let h = harness().await;
    h.chain.finalize(50);

    // A log from a different contract with the same event.
    let other = alloy::primitives::Address::repeat_byte(0x99);
    let log = purchased_log(other, tx(10), 40, 0, 0, &[commitment(1)], U256::from(PRICE));
    h.chain.add_receipt(tx(10), 40, true, vec![log.clone()]);
    h.chain.state().logs.push(log);
    assert_rejected(&h, key(tx(10), 0), RejectReason::NotAPurchase).await;

    // A wrong first topic.
    let mut log = purchased_log(
        sale(),
        tx(11),
        40,
        1,
        0,
        &[commitment(1)],
        U256::from(PRICE),
    );
    log.topics[0] = alloy::primitives::B256::repeat_byte(0x01);
    h.chain.add_receipt(tx(11), 40, true, vec![log]);
    assert_rejected(&h, key(tx(11), 1), RejectReason::NotAPurchase).await;

    // A wrong amount.
    let log = purchased_log(
        sale(),
        tx(12),
        40,
        2,
        0,
        &[commitment(1), commitment(2)],
        U256::from(PRICE),
    );
    h.chain.add_receipt(tx(12), 40, true, vec![log]);
    assert_rejected(&h, key(tx(12), 2), RejectReason::MalformedPurchase).await;

    // A commitment that is not a canonical field element.
    let mut log = purchased_log(
        sale(),
        tx(13),
        40,
        3,
        0,
        &[commitment(1)],
        U256::from(PRICE),
    );
    let mut data = log.data.to_vec();
    let len = data.len();
    data[len - 32..].copy_from_slice(&[0xff; 32]);
    log.data = data.into();
    h.chain.add_receipt(tx(13), 40, true, vec![log]);
    assert_rejected(&h, key(tx(13), 3), RejectReason::MalformedPurchase).await;

    // A reverted transaction.
    let log = purchased_log(
        sale(),
        tx(14),
        40,
        4,
        0,
        &[commitment(1)],
        U256::from(PRICE),
    );
    h.chain.add_receipt(tx(14), 40, false, vec![log]);
    assert_rejected(&h, key(tx(14), 4), RejectReason::Reverted).await;

    // A log index that the transaction does not have.
    h.chain.purchase(tx(15), 40, 5, 0, &[commitment(1)]);
    assert_rejected(&h, key(tx(15), 6), RejectReason::LogNotFound).await;

    // A removed log.
    let mut log = purchased_log(
        sale(),
        tx(16),
        40,
        7,
        0,
        &[commitment(1)],
        U256::from(PRICE),
    );
    log.removed = true;
    h.chain.add_receipt(tx(16), 40, true, vec![log]);
    assert_rejected(&h, key(tx(16), 7), RejectReason::LogNotFound).await;

    // The indexer skips the foreign log because getLogs filters by address, and it issues the
    // valid purchase only.
    let report = h.service.indexer_tick().await.unwrap();
    assert_eq!(report.issued, 1);
    assert_eq!(leaf_count(&h).await, 1);
}

#[tokio::test]
async fn non_canonical_receipt_block_waits() {
    let h = harness().await;
    h.chain.purchase(tx(1), 60, 0, 0, &[commitment(1)]);
    h.chain.finalize(70);
    // A reorganization replaced block 60.
    h.chain
        .state()
        .blocks
        .insert(60, alloy::primitives::B256::repeat_byte(0xee));
    let outcome = h.service.submit_topup(&key(tx(1), 0)).await.unwrap();
    assert_eq!(
        body(&outcome).pending_reason,
        Some(PendingReason::AwaitingReceipt)
    );
    assert_eq!(leaf_count(&h).await, 0);
}

#[tokio::test]
async fn unknown_transaction_is_tracked_then_expires() {
    let h = harness().await;
    let outcome = h.service.submit_topup(&key(tx(99), 0)).await.unwrap();
    assert_eq!(
        body(&outcome).pending_reason,
        Some(PendingReason::AwaitingReceipt)
    );
    assert!(
        h.service
            .topup_status(&key(tx(99), 0))
            .await
            .unwrap()
            .is_some()
    );
    h.clock.advance(3_601);
    h.service.indexer_tick().await.unwrap();
    assert!(
        h.service
            .topup_status(&key(tx(99), 0))
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn rpc_failure_is_pending_and_recovers() {
    let h = harness().await;
    h.chain.purchase(tx(1), 3, 0, 0, &[commitment(1)]);
    h.chain.finalize(3);
    h.chain.state().down = true;
    let outcome = h.service.submit_topup(&key(tx(1), 0)).await.unwrap();
    assert_eq!(
        body(&outcome).pending_reason,
        Some(PendingReason::ChainUnavailable)
    );
    assert!(matches!(
        h.service.indexer_tick().await,
        Err(ServiceError::Chain(_))
    ));
    h.chain.state().down = false;
    let report = h.service.indexer_tick().await.unwrap();
    assert_eq!(report.issued, 1);
    let status = h
        .service
        .topup_status(&key(tx(1), 0))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(body(&status).status, TopupStatus::Issued);
}

#[tokio::test]
async fn tracked_payment_turns_rejected_after_finality() {
    let h = harness().await;
    let log = purchased_log(sale(), tx(2), 80, 0, 0, &[commitment(1)], U256::from(PRICE));
    h.chain.add_receipt(tx(2), 80, false, vec![log]);
    h.chain.finalize(79);
    let outcome = h.service.submit_topup(&key(tx(2), 0)).await.unwrap();
    assert_eq!(
        body(&outcome).pending_reason,
        Some(PendingReason::AwaitingFinality)
    );
    h.chain.finalize(80);
    h.service.indexer_tick().await.unwrap();
    let status = h
        .service
        .topup_status(&key(tx(2), 0))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(body(&status).status, TopupStatus::Rejected);
    assert_eq!(body(&status).reject_reason, Some(RejectReason::Reverted));
}

#[tokio::test]
async fn tracking_table_has_a_limit() {
    let pool = anon_credit_registry::sqlite::connect_in_memory()
        .await
        .unwrap();
    let chain = MockChain::new();
    let clock = anon_credit_issuer::clock::ManualClock::new(T0);
    let mut config = anon_credit_issuer::service::ServiceConfig::new(deployment(), PRICE, 0);
    config.max_tracked = 2;
    let service =
        anon_credit_issuer::service::Service::open(config, pool, chain, std::sync::Arc::new(clock))
            .await
            .unwrap();
    service.submit_topup(&key(tx(1), 0)).await.unwrap();
    service.submit_topup(&key(tx(2), 0)).await.unwrap();
    // A known key is not counted again.
    service.submit_topup(&key(tx(2), 0)).await.unwrap();
    assert!(matches!(
        service.submit_topup(&key(tx(3), 0)).await,
        Err(ServiceError::Busy)
    ));
}

#[tokio::test]
async fn chain_check_finds_configuration_mismatches() {
    let h = harness().await;
    h.service.check_chain().await.unwrap();
    h.chain.state().price = U256::from(PRICE + 1);
    assert!(matches!(
        h.service.check_chain().await,
        Err(ServiceError::Mismatch(_))
    ));
    h.chain.state().price = U256::from(PRICE);
    h.chain.state().registry_epoch_seconds = 900;
    assert!(matches!(
        h.service.check_chain().await,
        Err(ServiceError::Mismatch(_))
    ));
    h.chain.state().registry_epoch_seconds = 30;
    h.chain.state().publisher = Some(payer());
    assert!(matches!(
        h.service.check_chain().await,
        Err(ServiceError::Mismatch(_))
    ));
    h.chain.state().publisher = Some(issuer());
    h.chain.state().chain_id = 1;
    assert!(matches!(
        h.service.check_chain().await,
        Err(ServiceError::Mismatch(_))
    ));
}

#[tokio::test]
async fn database_of_another_deployment_is_refused() {
    let db = TempDb::new("deployment");
    let pool = anon_credit_registry::sqlite::connect(&db.0).await.unwrap();
    open_service(
        pool.clone(),
        MockChain::new(),
        anon_credit_issuer::clock::ManualClock::new(T0),
    )
    .await;
    let mut other = deployment();
    other.gateway_id = anon_credit_protocol::hex_bytes::Bytes32([0x62; 32]);
    let config = anon_credit_issuer::service::ServiceConfig::new(other, PRICE, 0);
    let result = anon_credit_issuer::service::Service::open(
        config,
        pool,
        MockChain::new(),
        std::sync::Arc::new(anon_credit_issuer::clock::ManualClock::new(T0)),
    )
    .await;
    assert!(result.is_err());
}

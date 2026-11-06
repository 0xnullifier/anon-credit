//! Root publication: one root per closed epoch, receipt reconciliation, and restart recovery.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

mod common;

use alloy::primitives::B256;
use anon_credit_crypto::FieldElement;
use anon_credit_issuer::clock::ManualClock;
use anon_credit_issuer::db::{self, Publication};
use anon_credit_issuer::verify::PaymentKey;
use anon_credit_protocol::issuer_api::PublicationStatus;
use anon_credit_registry::sqlite::snapshot_at;
use anon_credit_registry::{MemoryStore, Mmr};
use common::*;

async fn publication(h: &Harness, epoch: u64) -> Publication {
    let mut conn = h.pool.acquire().await.unwrap();
    db::publication(&mut conn, epoch).await.unwrap().unwrap()
}

fn b256(root: FieldElement) -> B256 {
    B256::from(root.to_bytes_be())
}

fn empty_root() -> FieldElement {
    Mmr::new(MemoryStore::new()).root().unwrap()
}

#[tokio::test]
async fn publishes_each_closed_epoch_and_follows_the_receipt_to_finality() {
    let h = harness().await;
    // T0 is the start of epoch 1000. Epoch 999 is closed.
    h.service.publisher_tick().await.unwrap();
    let first = publication(&h, 999).await;
    assert_eq!(first.status, PublicationStatus::Submitted);
    assert_eq!(first.leaf_count, 0);
    assert_eq!(first.root, empty_root());
    let hash = first.tx_hash.unwrap();
    {
        let state = h.chain.state();
        assert_eq!(state.signed.len(), 1);
        assert_eq!(state.signed[0].epoch, 999);
        assert_eq!(state.signed[0].root, b256(empty_root()));
        assert_eq!(state.broadcasts.len(), 1);
    }

    // The same epoch is not published again.
    h.service.publisher_tick().await.unwrap();
    assert_eq!(h.chain.state().signed.len(), 1);

    h.chain.mine(hash, 7, true);
    h.service.publisher_tick().await.unwrap();
    let included = publication(&h, 999).await;
    assert_eq!(included.status, PublicationStatus::Included);
    assert_eq!(included.block_number, Some(7));

    h.chain.finalize(7);
    h.service.publisher_tick().await.unwrap();
    assert_eq!(
        publication(&h, 999).await.status,
        PublicationStatus::Finalized
    );

    // Next epoch: a new root is published.
    h.clock.advance(30);
    h.chain.state().latest_timestamp = T0 + 30;
    h.service.publisher_tick().await.unwrap();
    assert_eq!(
        publication(&h, 1000).await.status,
        PublicationStatus::Submitted
    );
    assert_eq!(h.chain.state().signed.len(), 2);
}

#[tokio::test]
async fn leaves_of_epoch_e_are_in_root_e_and_not_before() {
    let h = harness().await;
    h.chain.publisher_off();
    h.chain
        .purchase(tx(1), 10, 0, 0, &[commitment(1), commitment(2)]);
    h.chain.finalize(10);
    // Epoch 999 has its snapshot before the payment.
    h.service.publisher_tick().await.unwrap();
    h.service.indexer_tick().await.unwrap();
    let key = PaymentKey {
        chain_id: CHAIN_ID,
        tx_hash: tx(1),
        log_index: 0,
    };
    let issued = h.service.topup_status(&key).await.unwrap().unwrap();
    let anon_credit_issuer::service::TopupOutcome::Issued(body) = issued else {
        panic!("not issued");
    };
    assert_eq!(body.issuance.unwrap().insertion_epoch.0, 1000);

    h.clock.advance(30);
    h.service.publisher_tick().await.unwrap();
    let mut conn = h.pool.acquire().await.unwrap();
    assert_eq!(
        snapshot_at(&mut conn, 999)
            .await
            .unwrap()
            .unwrap()
            .leaf_count,
        0
    );
    assert_eq!(
        snapshot_at(&mut conn, 1000)
            .await
            .unwrap()
            .unwrap()
            .leaf_count,
        2
    );
}

#[tokio::test]
async fn a_leaf_never_gets_an_epoch_that_has_a_snapshot() {
    let h = harness().await;
    h.chain.publisher_off();
    h.clock.advance(5 * 30);
    // Snapshot of epoch 1004.
    h.service.publisher_tick().await.unwrap();
    // The clock moves back to epoch 1002 (for example after an NTP correction).
    h.clock.set(T0 + 2 * 30);
    h.chain.purchase(tx(1), 10, 0, 0, &[commitment(1)]);
    h.chain.finalize(10);
    h.service.indexer_tick().await.unwrap();
    let mut conn = h.pool.acquire().await.unwrap();
    let epoch: i64 = sqlx::query_scalar("SELECT insertion_epoch FROM payments")
        .fetch_one(&mut *conn)
        .await
        .unwrap();
    assert_eq!(epoch, 1005);
    assert_eq!(db::leaf_count_through(&mut conn, 1004).await.unwrap(), 0);
}

#[tokio::test]
async fn submitted_publication_is_sent_again_after_restart() {
    let file = TempDb::new("publisher-restart");
    let chain = MockChain::new();
    let clock = ManualClock::new(T0);
    let raw = {
        let pool = anon_credit_registry::sqlite::connect(&file.0)
            .await
            .unwrap();
        let h = open_service(pool.clone(), chain.clone(), clock.clone()).await;
        h.service.publisher_tick().await.unwrap();
        let first = publication(&h, 999).await;
        assert_eq!(first.status, PublicationStatus::Submitted);
        pool.close().await;
        first.raw_tx.unwrap()
    };
    // The broadcast was lost: the RPC does not know the transaction.
    chain.state().broadcasts.clear();

    let pool = anon_credit_registry::sqlite::connect(&file.0)
        .await
        .unwrap();
    let h = open_service(pool, chain.clone(), clock.clone()).await;
    h.service.publisher_tick().await.unwrap();
    {
        let state = chain.state();
        // The same signed bytes are sent again. No new transaction is signed.
        assert_eq!(state.signed.len(), 1);
        assert_eq!(state.broadcasts.len(), 1);
        assert_eq!(state.broadcasts[0].to_vec(), raw);
    }
    let hash = publication(&h, 999).await.tx_hash.unwrap();
    chain.mine(hash, 3, true);
    chain.finalize(3);
    h.service.publisher_tick().await.unwrap();
    assert_eq!(
        publication(&h, 999).await.status,
        PublicationStatus::Finalized
    );
}

#[tokio::test]
async fn receipt_mined_during_downtime_is_reconciled_after_restart() {
    let file = TempDb::new("publisher-mined");
    let chain = MockChain::new();
    let clock = ManualClock::new(T0);
    let hash = {
        let pool = anon_credit_registry::sqlite::connect(&file.0)
            .await
            .unwrap();
        let h = open_service(pool.clone(), chain.clone(), clock.clone()).await;
        h.service.publisher_tick().await.unwrap();
        let hash = publication(&h, 999).await.tx_hash.unwrap();
        pool.close().await;
        hash
    };
    chain.mine(hash, 4, true);
    chain.finalize(4);
    clock.advance(30);
    chain.state().latest_timestamp = T0 + 30;

    let pool = anon_credit_registry::sqlite::connect(&file.0)
        .await
        .unwrap();
    let h = open_service(pool, chain.clone(), clock).await;
    h.service.publisher_tick().await.unwrap();
    assert_eq!(
        publication(&h, 999).await.status,
        PublicationStatus::Finalized
    );
    assert_eq!(
        publication(&h, 1000).await.status,
        PublicationStatus::Submitted
    );
    assert_eq!(chain.state().signed.len(), 2);
}

#[tokio::test]
async fn in_flight_publication_blocks_the_next_one() {
    let h = harness().await;
    h.service.publisher_tick().await.unwrap();
    h.clock.advance(30);
    h.chain.state().latest_timestamp = T0 + 30;
    h.service.publisher_tick().await.unwrap();
    assert_eq!(
        publication(&h, 999).await.status,
        PublicationStatus::Submitted
    );
    assert_eq!(
        publication(&h, 1000).await.status,
        PublicationStatus::Pending
    );
    assert_eq!(h.chain.state().signed.len(), 1);

    let hash = publication(&h, 999).await.tx_hash.unwrap();
    h.chain.mine(hash, 2, true);
    h.service.publisher_tick().await.unwrap();
    assert_eq!(
        publication(&h, 999).await.status,
        PublicationStatus::Included
    );
    assert_eq!(
        publication(&h, 1000).await.status,
        PublicationStatus::Submitted
    );
}

#[tokio::test]
async fn dropped_transaction_fails_and_a_later_epoch_replaces_it() {
    let h = harness().await;
    h.service.publisher_tick().await.unwrap();
    // A different transaction used the nonce. The publication can never be mined.
    h.chain.state().mined_nonce = 1;
    h.clock.advance(30);
    h.chain.state().latest_timestamp = T0 + 30;
    h.service.publisher_tick().await.unwrap();
    let failed = publication(&h, 999).await;
    assert_eq!(failed.status, PublicationStatus::Failed);
    assert!(failed.note.unwrap().contains("dropped"));
    assert_eq!(
        publication(&h, 1000).await.status,
        PublicationStatus::Submitted
    );
}

#[tokio::test]
async fn reverted_publication_fails() {
    let h = harness().await;
    h.service.publisher_tick().await.unwrap();
    let hash = publication(&h, 999).await.tx_hash.unwrap();
    h.chain.mine(hash, 2, false);
    h.service.publisher_tick().await.unwrap();
    let failed = publication(&h, 999).await;
    assert_eq!(failed.status, PublicationStatus::Failed);
    assert_eq!(failed.note.as_deref(), Some("reverted"));
}

#[tokio::test]
async fn publisher_waits_until_chain_time_passes_the_epoch_end() {
    let h = harness().await;
    h.chain.state().latest_timestamp = T0 - 1;
    h.service.publisher_tick().await.unwrap();
    assert_eq!(
        publication(&h, 999).await.status,
        PublicationStatus::Pending
    );
    assert!(h.chain.state().signed.is_empty());
    h.chain.state().latest_timestamp = T0 + 12;
    h.service.publisher_tick().await.unwrap();
    assert_eq!(
        publication(&h, 999).await.status,
        PublicationStatus::Submitted
    );
}

#[tokio::test]
async fn backlog_publishes_only_the_newest_epoch() {
    let h = harness().await;
    h.chain.publisher_off();
    for _ in 0..3 {
        h.service.publisher_tick().await.unwrap();
        h.clock.advance(30);
    }
    // Snapshots of 999, 1000, 1001 and 1002 are pending (the last one in this pass).
    h.chain.state().publisher = Some(issuer());
    h.chain.state().latest_timestamp = T0 + 3 * 30;
    h.service.publisher_tick().await.unwrap();
    for epoch in [999, 1000, 1001] {
        assert_eq!(
            publication(&h, epoch).await.status,
            PublicationStatus::Skipped
        );
    }
    assert_eq!(
        publication(&h, 1002).await.status,
        PublicationStatus::Submitted
    );
    assert_eq!(h.chain.state().signed.len(), 1);
}

#[tokio::test]
async fn epoch_already_in_the_registry_is_skipped() {
    let h = harness().await;
    {
        let mut state = h.chain.state();
        state.registry_latest_epoch = 999;
        state.registry_roots.insert(999, (b256(empty_root()), 0));
    }
    h.service.publisher_tick().await.unwrap();
    let skipped = publication(&h, 999).await;
    assert_eq!(skipped.status, PublicationStatus::Skipped);
    assert!(h.chain.state().signed.is_empty());
}

#[tokio::test]
async fn without_a_key_roots_are_recorded_but_not_sent() {
    let h = harness().await;
    h.chain.publisher_off();
    h.service.publisher_tick().await.unwrap();
    assert_eq!(
        publication(&h, 999).await.status,
        PublicationStatus::Pending
    );
    assert!(h.chain.state().signed.is_empty());
    let roots = h.service.roots(None, 1000).await.unwrap();
    assert_eq!(roots.roots.len(), 1);
    assert_eq!(roots.current_epoch.0, 1000);
}

#[tokio::test]
async fn root_events_list_only_published_roots() {
    let h = harness().await;
    h.service.publisher_tick().await.unwrap();
    assert!(
        h.service
            .root_events(0, 10)
            .await
            .unwrap()
            .events
            .is_empty()
    );
    let hash = publication(&h, 999).await.tx_hash.unwrap();
    h.chain.mine(hash, 9, true);
    h.service.publisher_tick().await.unwrap();
    let events = h.service.root_events(0, 10).await.unwrap().events;
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].index.0, 999);
    assert!(!events[0].finalized);
    h.chain.finalize(9);
    h.service.publisher_tick().await.unwrap();
    assert!(h.service.root_events(999, 10).await.unwrap().events[0].finalized);
    assert!(
        h.service
            .root_events(1000, 10)
            .await
            .unwrap()
            .events
            .is_empty()
    );
}

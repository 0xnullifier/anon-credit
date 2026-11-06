//! In-memory diagnostic events (implementation.md section 14).
//!
//! The bus keeps the newest events in a ring: at most [`MAX_EVENTS`] events and at most
//! [`MAX_EVENT_AGE_MS`] old. Each event has a monotonic ID. The Server-Sent Events stream
//! sends events after a `Last-Event-ID` from the ring, then live events.
//!
//! Events are not the durable receipt ledger. The gateway emits a debit event only after the
//! debit commits. Events have no keys, proofs, tokens, RPC parameters, or RPC results.

use crate::clock::Clock;
use crate::peer::Observed;
use anon_credit_protocol::admin::{EventCounters, EventKind, GatewayEvent};
use anon_credit_protocol::{Bytes32, DecimalU64, ErrorCode};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use tokio::sync::broadcast;

/// Largest number of events in the ring.
pub const MAX_EVENTS: usize = 10_000;

/// Largest age of an event in the ring: 30 minutes.
pub const MAX_EVENT_AGE_MS: u64 = 30 * 60 * 1000;

/// Capacity of the live channel. A slow subscriber that falls behind is disconnected and
/// reconnects with `Last-Event-ID`.
const LIVE_CAPACITY: usize = 1024;

/// Fields of an event before the bus gives it an ID and a time.
#[derive(Debug, Clone)]
pub struct EventDraft {
    kind: EventKind,
    observed: Observed,
    batch_id: Option<Bytes32>,
    seq: Option<u64>,
    method: Option<String>,
    error_code: Option<ErrorCode>,
    latency_ms: Option<u32>,
    units: Option<u32>,
    remaining: Option<u32>,
    request_bytes: Option<u32>,
    response_bytes: Option<u32>,
}

fn clamp_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

impl EventDraft {
    /// Start an event of `kind` for a request from `observed`.
    pub fn new(kind: EventKind, observed: &Observed) -> Self {
        Self {
            kind,
            observed: observed.clone(),
            batch_id: None,
            seq: None,
            method: None,
            error_code: None,
            latency_ms: None,
            units: None,
            remaining: None,
            request_bytes: None,
            response_bytes: None,
        }
    }

    /// Set the batch ID.
    pub fn batch(mut self, batch_id: Bytes32) -> Self {
        self.batch_id = Some(batch_id);
        self
    }

    /// Set the sequence number.
    pub fn seq(mut self, seq: u64) -> Self {
        self.seq = Some(seq);
        self
    }

    /// Set the method name.
    pub fn method(mut self, method: &str) -> Self {
        self.method = Some(method.to_owned());
        self
    }

    /// Set the error code.
    pub fn error(mut self, code: ErrorCode) -> Self {
        self.error_code = Some(code);
        self
    }

    /// Set the latency.
    pub fn latency(mut self, started: std::time::Instant) -> Self {
        self.latency_ms = Some(u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX));
        self
    }

    /// Set a latency in milliseconds.
    pub fn latency_ms(mut self, ms: u64) -> Self {
        self.latency_ms = Some(u32::try_from(ms).unwrap_or(u32::MAX));
        self
    }

    /// Set the charged and the remaining units.
    pub fn units(mut self, units: u32, remaining: u32) -> Self {
        self.units = Some(units);
        self.remaining = Some(remaining);
        self
    }

    /// Set the remaining units.
    pub fn remaining(mut self, remaining: u32) -> Self {
        self.remaining = Some(remaining);
        self
    }

    /// Set the request size.
    pub fn request_bytes(mut self, len: usize) -> Self {
        self.request_bytes = Some(clamp_u32(len));
        self
    }

    /// Set the response or proof size.
    pub fn response_bytes(mut self, len: usize) -> Self {
        self.response_bytes = Some(clamp_u32(len));
        self
    }
}

#[derive(Debug, Default)]
struct Counters {
    open_received: AtomicU64,
    open_rejected: AtomicU64,
    sessions_opened: AtomicU64,
    rpc_received: AtomicU64,
    rpc_completed: AtomicU64,
    rpc_replayed: AtomicU64,
    rpc_rejected: AtomicU64,
    upstream_failed: AtomicU64,
    storage_failed: AtomicU64,
    units_charged: AtomicU64,
}

impl Counters {
    fn count(&self, event: &GatewayEvent) {
        let counter = match event.kind {
            EventKind::OpenReceived => &self.open_received,
            EventKind::OpenVerified => return,
            EventKind::OpenRejected => &self.open_rejected,
            EventKind::SessionOpened => match event.units {
                // An exact retry has no units field; it is not a new session.
                Some(_) => &self.sessions_opened,
                None => return,
            },
            EventKind::RpcReceived => &self.rpc_received,
            EventKind::RpcCompleted => {
                self.units_charged
                    .fetch_add(u64::from(event.units.unwrap_or(0)), Ordering::Relaxed);
                &self.rpc_completed
            }
            EventKind::RpcReplayed => &self.rpc_replayed,
            EventKind::RpcRejected => &self.rpc_rejected,
            EventKind::UpstreamFailed => &self.upstream_failed,
            EventKind::StorageFailed => &self.storage_failed,
        };
        counter.fetch_add(1, Ordering::Relaxed);
    }

    fn snapshot(&self) -> EventCounters {
        let read = |c: &AtomicU64| DecimalU64(c.load(Ordering::Relaxed));
        EventCounters {
            open_received: read(&self.open_received),
            open_rejected: read(&self.open_rejected),
            sessions_opened: read(&self.sessions_opened),
            rpc_received: read(&self.rpc_received),
            rpc_completed: read(&self.rpc_completed),
            rpc_replayed: read(&self.rpc_replayed),
            rpc_rejected: read(&self.rpc_rejected),
            upstream_failed: read(&self.upstream_failed),
            storage_failed: read(&self.storage_failed),
            units_charged: read(&self.units_charged),
        }
    }
}

#[derive(Debug)]
struct Ring {
    next_id: u64,
    events: VecDeque<GatewayEvent>,
}

/// The event bus.
pub struct EventBus {
    ring: Mutex<Ring>,
    live: broadcast::Sender<GatewayEvent>,
    counters: Counters,
    clock: Arc<dyn Clock>,
    max_events: usize,
    max_age_ms: u64,
}

impl EventBus {
    /// Make a bus with the default retention.
    pub fn new(clock: Arc<dyn Clock>) -> Self {
        Self::with_retention(clock, MAX_EVENTS, MAX_EVENT_AGE_MS)
    }

    /// Make a bus with a custom retention.
    pub fn with_retention(clock: Arc<dyn Clock>, max_events: usize, max_age_ms: u64) -> Self {
        let (live, _) = broadcast::channel(LIVE_CAPACITY);
        Self {
            ring: Mutex::new(Ring {
                next_id: 1,
                events: VecDeque::new(),
            }),
            live,
            counters: Counters::default(),
            clock,
            max_events,
            max_age_ms,
        }
    }

    fn lock(&self) -> MutexGuard<'_, Ring> {
        self.ring.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn prune(&self, ring: &mut Ring, now_ms: u64) {
        while ring.events.len() > self.max_events {
            ring.events.pop_front();
        }
        while ring
            .events
            .front()
            .is_some_and(|e| now_ms.saturating_sub(e.at_ms.0) > self.max_age_ms)
        {
            ring.events.pop_front();
        }
    }

    /// Give the draft an ID and a time, keep it, and send it to live subscribers.
    pub fn publish(&self, draft: EventDraft) -> GatewayEvent {
        let now_ms = self.clock.now_ms();
        let mut ring = self.lock();
        let event = GatewayEvent {
            id: DecimalU64(ring.next_id),
            at_ms: DecimalU64(now_ms),
            kind: draft.kind,
            batch_id: draft.batch_id,
            seq: draft.seq.map(DecimalU64),
            method: draft.method,
            error_code: draft.error_code,
            latency_ms: draft.latency_ms,
            units: draft.units,
            remaining: draft.remaining,
            request_bytes: draft.request_bytes,
            response_bytes: draft.response_bytes,
            observed_ip: draft.observed.ip,
            ip_attribution: draft.observed.attribution,
            proxy_hop: draft.observed.proxy_hop,
        };
        ring.next_id = ring.next_id.saturating_add(1);
        ring.events.push_back(event.clone());
        self.prune(&mut ring, now_ms);
        self.counters.count(&event);
        // Send while the ring lock is held, so live order equals ID order.
        // An error means that there is no subscriber. That is not a failure.
        let _no_subscriber = self.live.send(event.clone());
        event
    }

    /// The retained events with an ID greater than `after`, and a live receiver.
    ///
    /// The receiver gets only events after the returned list, because both come from the same
    /// lock section.
    pub fn subscribe(&self, after: u64) -> (Vec<GatewayEvent>, broadcast::Receiver<GatewayEvent>) {
        let now_ms = self.clock.now_ms();
        let mut ring = self.lock();
        self.prune(&mut ring, now_ms);
        let receiver = self.live.subscribe();
        let backlog = ring
            .events
            .iter()
            .filter(|e| e.id.0 > after)
            .cloned()
            .collect();
        (backlog, receiver)
    }

    /// The newest `limit` retained events, oldest first.
    pub fn recent(&self, limit: usize) -> Vec<GatewayEvent> {
        let now_ms = self.clock.now_ms();
        let mut ring = self.lock();
        self.prune(&mut ring, now_ms);
        let skip = ring.events.len().saturating_sub(limit);
        ring.events.iter().skip(skip).cloned().collect()
    }

    /// Counters since start.
    pub fn counters(&self) -> EventCounters {
        self.counters.snapshot()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::ManualClock;

    fn bus(max_events: usize) -> (Arc<ManualClock>, EventBus) {
        let clock = Arc::new(ManualClock::at_unix(1_000));
        let bus = EventBus::with_retention(clock.clone(), max_events, MAX_EVENT_AGE_MS);
        (clock, bus)
    }

    #[test]
    fn ids_are_monotonic_and_ring_is_bounded() {
        let (_clock, bus) = bus(3);
        for _ in 0..5 {
            bus.publish(EventDraft::new(
                EventKind::RpcReceived,
                &Observed::unavailable(),
            ));
        }
        let ids: Vec<u64> = bus.recent(10).iter().map(|e| e.id.0).collect();
        assert_eq!(ids, vec![3, 4, 5]);
        assert_eq!(bus.counters().rpc_received, DecimalU64(5));
    }

    #[test]
    fn old_events_leave_the_ring() {
        let (clock, bus) = bus(100);
        bus.publish(EventDraft::new(
            EventKind::OpenReceived,
            &Observed::unavailable(),
        ));
        clock.advance_secs(31 * 60);
        bus.publish(EventDraft::new(
            EventKind::OpenReceived,
            &Observed::unavailable(),
        ));
        let ids: Vec<u64> = bus.recent(10).iter().map(|e| e.id.0).collect();
        assert_eq!(ids, vec![2]);
    }

    #[test]
    fn subscribe_returns_backlog_after_id_then_live() {
        let (_clock, bus) = bus(100);
        for _ in 0..3 {
            bus.publish(EventDraft::new(
                EventKind::RpcReceived,
                &Observed::unavailable(),
            ));
        }
        let (backlog, mut live) = bus.subscribe(1);
        assert_eq!(
            backlog.iter().map(|e| e.id.0).collect::<Vec<_>>(),
            vec![2, 3]
        );
        bus.publish(EventDraft::new(
            EventKind::RpcReceived,
            &Observed::unavailable(),
        ));
        assert_eq!(live.try_recv().map(|e| e.id.0).ok(), Some(4));
    }

    #[test]
    fn units_are_counted_on_completed_debits() {
        let (_clock, bus) = bus(100);
        bus.publish(
            EventDraft::new(EventKind::RpcCompleted, &Observed::unavailable()).units(2, 98),
        );
        assert_eq!(bus.counters().units_charged, DecimalU64(2));
        assert_eq!(bus.counters().rpc_completed, DecimalU64(1));
    }
}

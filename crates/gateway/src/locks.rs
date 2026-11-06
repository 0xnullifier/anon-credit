//! Per-batch locks (Architecture.md section 5.2, step 2).
//!
//! One spend request per batch runs at a time. A second request for the same batch waits up
//! to the configured time, then gets `busy`. Different batches run at the same time.
//! The lock is per process; one gateway process owns the database.

use anon_credit_protocol::Bytes32;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

type LockMap = Mutex<HashMap<Bytes32, Arc<AsyncMutex<()>>>>;

/// Locks of all batches with a request in progress.
#[derive(Debug, Default, Clone)]
pub struct BatchLocks {
    map: Arc<LockMap>,
}

/// Held lock of one batch. Drop it to release the lock.
#[derive(Debug)]
pub struct BatchGuard {
    guard: Option<OwnedMutexGuard<()>>,
    key: Bytes32,
    map: Arc<LockMap>,
}

impl Drop for BatchGuard {
    fn drop(&mut self) {
        drop(self.guard.take());
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        // Remove the entry if no other request holds or waits for it.
        if map
            .get(&self.key)
            .is_some_and(|entry| Arc::strong_count(entry) == 1)
        {
            map.remove(&self.key);
        }
    }
}

impl BatchLocks {
    /// Make an empty lock table.
    pub fn new() -> Self {
        Self::default()
    }

    /// Lock `batch_id`. Return `None` if the lock is not free within `wait`.
    pub async fn acquire(&self, batch_id: Bytes32, wait: Duration) -> Option<BatchGuard> {
        let entry = {
            let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
            Arc::clone(map.entry(batch_id).or_default())
        };
        let guard = tokio::time::timeout(wait, entry.lock_owned()).await.ok()?;
        Some(BatchGuard {
            guard: Some(guard),
            key: batch_id,
            map: Arc::clone(&self.map),
        })
    }

    /// Number of batches in the table. Only for tests.
    pub fn len(&self) -> usize {
        self.map.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    /// `true` if no batch is in the table.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn second_request_waits_then_times_out() {
        let locks = BatchLocks::new();
        let id = Bytes32([1; 32]);
        let held = locks.acquire(id, Duration::from_millis(10)).await;
        assert!(held.is_some());
        assert!(locks.acquire(id, Duration::from_millis(20)).await.is_none());
        // Another batch is free.
        assert!(
            locks
                .acquire(Bytes32([2; 32]), Duration::from_millis(10))
                .await
                .is_some()
        );
        drop(held);
        assert!(locks.acquire(id, Duration::from_millis(10)).await.is_some());
        assert!(locks.is_empty());
    }
}

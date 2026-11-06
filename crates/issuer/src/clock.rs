//! Clock and epoch arithmetic.
//!
//! `epoch = floor(unix_seconds / epoch_seconds)` (implementation.md section 6). The service
//! reads the time through [`Clock`], so that tests can set the time.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

/// Source of the current Unix time in seconds.
pub trait Clock: Send + Sync + 'static {
    /// Current Unix time in seconds.
    fn now_unix(&self) -> u64;
}

/// The system clock.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_unix(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }
}

/// A clock that changes only when the caller sets it. For tests.
#[derive(Debug, Clone, Default)]
pub struct ManualClock(Arc<AtomicU64>);

impl ManualClock {
    /// A clock at `unix_seconds`.
    pub fn new(unix_seconds: u64) -> Self {
        Self(Arc::new(AtomicU64::new(unix_seconds)))
    }

    /// Set the time.
    pub fn set(&self, unix_seconds: u64) {
        self.0.store(unix_seconds, Ordering::SeqCst);
    }

    /// Move the time forward by `seconds`.
    pub fn advance(&self, seconds: u64) {
        self.0.fetch_add(seconds, Ordering::SeqCst);
    }
}

impl Clock for ManualClock {
    fn now_unix(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

/// Epoch arithmetic for one epoch length.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Epochs {
    seconds: u64,
}

impl Epochs {
    /// Epochs of `seconds` seconds. Zero is changed to one, so that no division by zero occurs.
    /// The settings reject zero before this point.
    pub fn new(seconds: u32) -> Self {
        Self {
            seconds: u64::from(seconds.max(1)),
        }
    }

    /// Epoch length in seconds.
    pub fn seconds(&self) -> u64 {
        self.seconds
    }

    /// Epoch of a Unix time.
    pub fn epoch_of(&self, unix_seconds: u64) -> u64 {
        unix_seconds / self.seconds
    }

    /// Seconds from `unix_seconds` to the start of the next epoch (1 to the epoch length).
    pub fn seconds_until_next(&self, unix_seconds: u64) -> u64 {
        self.seconds - unix_seconds % self.seconds
    }

    /// Unix time at which `epoch` closes: `(epoch + 1) * seconds`. `None` on overflow.
    pub fn close_time(&self, epoch: u64) -> Option<u64> {
        epoch.checked_add(1)?.checked_mul(self.seconds)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch_arithmetic() {
        let epochs = Epochs::new(30);
        assert_eq!(epochs.epoch_of(0), 0);
        assert_eq!(epochs.epoch_of(29), 0);
        assert_eq!(epochs.epoch_of(30), 1);
        assert_eq!(epochs.seconds_until_next(30), 30);
        assert_eq!(epochs.seconds_until_next(59), 1);
        assert_eq!(epochs.close_time(1), Some(60));
        assert_eq!(epochs.close_time(u64::MAX), None);
    }

    #[test]
    fn manual_clock_moves_only_when_set() {
        let clock = ManualClock::new(100);
        assert_eq!(clock.now_unix(), 100);
        clock.advance(5);
        assert_eq!(clock.now_unix(), 105);
        clock.set(7);
        assert_eq!(clock.now_unix(), 7);
    }
}

//! Wall clock for epochs, deadlines, and response retention.
//!
//! The gateway reads time only through [`Clock`]. Tests use [`ManualClock`] to move time.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Source of the current time.
pub trait Clock: Send + Sync + 'static {
    /// Current Unix time in milliseconds.
    fn now_ms(&self) -> u64;

    /// Current Unix time in seconds.
    fn now_unix(&self) -> u64 {
        self.now_ms() / 1000
    }
}

/// The system clock.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        // A system time before 1970 gives zero. Then every epoch check fails safely.
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
            .unwrap_or(0)
    }
}

/// A clock that moves only when a test moves it.
#[derive(Debug, Default)]
pub struct ManualClock {
    now_ms: AtomicU64,
}

impl ManualClock {
    /// Make a clock at `unix` seconds.
    pub fn at_unix(unix: u64) -> Self {
        Self {
            now_ms: AtomicU64::new(unix.saturating_mul(1000)),
        }
    }

    /// Set the time to `unix` seconds.
    pub fn set_unix(&self, unix: u64) {
        self.now_ms
            .store(unix.saturating_mul(1000), Ordering::SeqCst);
    }

    /// Move the time forward by `seconds`.
    pub fn advance_secs(&self, seconds: u64) {
        self.now_ms
            .fetch_add(seconds.saturating_mul(1000), Ordering::SeqCst);
    }
}

impl Clock for ManualClock {
    fn now_ms(&self) -> u64 {
        self.now_ms.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_clock_moves_only_on_request() {
        let clock = ManualClock::at_unix(100);
        assert_eq!(clock.now_unix(), 100);
        clock.advance_secs(61);
        assert_eq!(clock.now_unix(), 161);
        clock.set_unix(5);
        assert_eq!(clock.now_ms(), 5000);
    }
}

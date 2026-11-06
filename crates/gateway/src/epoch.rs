//! Epoch rules (implementation.md section 6).
//!
//! - `epoch = floor(unix_seconds / epoch_seconds)`.
//! - A proof epoch is fresh if it is the current or the previous epoch.
//! - A root is accepted if its source epoch is in the last [`ROOT_WINDOW_EPOCHS`] epochs:
//!   `source_epoch <= current` and `current - source_epoch < 96`.
//! - A session can spend through `deadline_epoch = open_epoch + SESSION_LIFETIME_EPOCHS`.
//! - The gateway keeps a session row (the spent marker) through `deadline_epoch +
//!   PROOF_EPOCH_GRACE`. After that epoch, no fresh proof for the batch can exist.
//!
//! All arithmetic is checked. An overflow gives `None`.

/// Number of source epochs for which the gateway accepts a root.
pub const ROOT_WINDOW_EPOCHS: u64 = 96;

/// Session lifetime in epochs.
pub const SESSION_LIFETIME_EPOCHS: u64 = 35_040;

/// Epochs of grace for a proof epoch: the previous epoch is accepted.
pub const PROOF_EPOCH_GRACE: u64 = 1;

/// The epoch of a Unix time. Returns `None` if `epoch_seconds` is zero.
pub fn epoch_of(unix_seconds: u64, epoch_seconds: u32) -> Option<u64> {
    unix_seconds.checked_div(u64::from(epoch_seconds))
}

/// Tell if `proof_epoch` is the current or the previous epoch.
pub fn proof_epoch_is_fresh(proof_epoch: u64, current: u64) -> bool {
    proof_epoch <= current && current - proof_epoch <= PROOF_EPOCH_GRACE
}

/// Tell if a root of `source_epoch` is in the acceptance window at `current`.
pub fn root_in_window(source_epoch: u64, current: u64) -> bool {
    source_epoch <= current && current - source_epoch < ROOT_WINDOW_EPOCHS
}

/// The first source epoch in the acceptance window at `current`.
pub fn window_start(current: u64) -> u64 {
    current.saturating_sub(ROOT_WINDOW_EPOCHS - 1)
}

/// The session deadline of a session opened in `open_epoch`.
pub fn session_deadline(open_epoch: u64) -> Option<u64> {
    open_epoch.checked_add(SESSION_LIFETIME_EPOCHS)
}

/// The last epoch in which the gateway must keep the session row.
pub fn retain_through(deadline_epoch: u64) -> Option<u64> {
    deadline_epoch.checked_add(PROOF_EPOCH_GRACE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch_is_floor_division() {
        assert_eq!(epoch_of(0, 30), Some(0));
        assert_eq!(epoch_of(29, 30), Some(0));
        assert_eq!(epoch_of(30, 30), Some(1));
        assert_eq!(epoch_of(u64::MAX, 900), Some(u64::MAX / 900));
        assert_eq!(epoch_of(10, 0), None);
    }

    #[test]
    fn proof_epoch_accepts_current_and_previous_only() {
        assert!(proof_epoch_is_fresh(10, 10));
        assert!(proof_epoch_is_fresh(9, 10));
        assert!(!proof_epoch_is_fresh(8, 10));
        assert!(!proof_epoch_is_fresh(11, 10));
        assert!(proof_epoch_is_fresh(0, 0));
        assert!(proof_epoch_is_fresh(u64::MAX, u64::MAX));
    }

    #[test]
    fn root_window_has_96_epochs() {
        assert!(root_in_window(100, 100));
        assert!(root_in_window(5, 100));
        assert!(!root_in_window(4, 100));
        assert!(!root_in_window(101, 100));
        assert_eq!(window_start(100), 5);
        assert_eq!(window_start(3), 0);
        assert!(root_in_window(window_start(100), 100));
    }

    #[test]
    fn deadline_and_retention_reject_overflow() {
        assert_eq!(session_deadline(1000), Some(36_040));
        assert_eq!(
            session_deadline(u64::MAX - SESSION_LIFETIME_EPOCHS),
            Some(u64::MAX)
        );
        assert_eq!(
            session_deadline(u64::MAX - SESSION_LIFETIME_EPOCHS + 1),
            None
        );
        assert_eq!(retain_through(36_040), Some(36_041));
        assert_eq!(retain_through(u64::MAX), None);
    }
}

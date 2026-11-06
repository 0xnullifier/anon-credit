//! Keccak-256 helper.

use sha3::{Digest, Keccak256};

/// Length of a Keccak-256 digest in bytes.
pub const KECCAK256_LEN: usize = 32;

/// Calculate the Keccak-256 digest of `data`.
///
/// This is the Ethereum Keccak-256. It is not NIST SHA3-256. The padding is different.
pub fn keccak256(data: &[u8]) -> [u8; KECCAK256_LEN] {
    Keccak256::digest(data).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_matches_known_vector() {
        assert_eq!(
            hex::encode(keccak256(b"")),
            "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
        );
    }

    #[test]
    fn abc_matches_known_vector() {
        assert_eq!(
            hex::encode(keccak256(b"abc")),
            "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"
        );
    }
}

//! SHA-256 digests of pinned artifacts.

use std::fmt;

use sha2::{Digest, Sha256};

use crate::error::LoadError;

/// A SHA-256 digest. The text form is 64 lowercase hex digits, with no `0x` prefix.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct Sha256Digest([u8; 32]);

impl Sha256Digest {
    /// Makes a digest from its 32 bytes.
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    /// Calculates the digest of `data`.
    pub fn of(data: &[u8]) -> Self {
        Self(Sha256::digest(data).into())
    }

    /// Parses 64 lowercase hex digits. A `0x` prefix and uppercase digits are rejected.
    pub fn from_hex(text: &str) -> Result<Self, LoadError> {
        let valid = text.len() == 64
            && text
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
        if !valid {
            return Err(LoadError::DigestFormat);
        }
        let mut bytes = [0_u8; 32];
        hex::decode_to_slice(text, &mut bytes).map_err(|_| LoadError::DigestFormat)?;
        Ok(Self(bytes))
    }

    /// Returns the 32 digest bytes.
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl fmt::Display for Sha256Digest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&hex::encode(self.0))
    }
}

impl fmt::Debug for Sha256Digest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Sha256Digest({self})")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_round_trip() {
        let digest = Sha256Digest::of(b"abc");
        assert_eq!(
            digest.to_string(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(Sha256Digest::from_hex(&digest.to_string()).unwrap(), digest);
    }

    #[test]
    fn rejects_bad_hex() {
        let upper = "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD";
        assert!(Sha256Digest::from_hex(upper).is_err());
        assert!(Sha256Digest::from_hex("0xba7816bf").is_err());
        assert!(Sha256Digest::from_hex("").is_err());
    }
}

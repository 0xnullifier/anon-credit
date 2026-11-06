//! Fixed-size byte values with a canonical hex encoding.
//!
//! The canonical form is `0x` followed by lowercase hex digits, with the exact length.
//! Decoding rejects uppercase digits, a missing prefix, and a wrong length.

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Failure to decode canonical hex.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum HexError {
    /// The text does not start with `0x`.
    #[error("hex value must start with 0x")]
    MissingPrefix,
    /// The text has the wrong number of digits.
    #[error("hex value must have {expected} digits, found {found}")]
    WrongLength {
        /// Expected digit count.
        expected: usize,
        /// Digit count in the input.
        found: usize,
    },
    /// The text has a character that is not a lowercase hex digit.
    #[error("hex value must use only lowercase hex digits")]
    NonCanonicalDigit,
}

/// Decode canonical hex into exactly `N` bytes.
pub fn decode_fixed<const N: usize>(text: &str) -> Result<[u8; N], HexError> {
    let digits = text.strip_prefix("0x").ok_or(HexError::MissingPrefix)?;
    if digits.len() != N * 2 {
        return Err(HexError::WrongLength {
            expected: N * 2,
            found: digits.len(),
        });
    }
    if !digits
        .bytes()
        .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(HexError::NonCanonicalDigit);
    }
    let mut out = [0u8; N];
    hex::decode_to_slice(digits, &mut out).map_err(|_| HexError::NonCanonicalDigit)?;
    Ok(out)
}

/// Encode bytes as canonical hex.
pub fn encode(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

macro_rules! fixed_bytes {
    ($(#[$meta:meta])* $name:ident, $len:expr) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Default)]
        pub struct $name(pub [u8; $len]);

        impl $name {
            /// Length in bytes.
            pub const LEN: usize = $len;

            /// The all-zero value. Templates use it as a placeholder.
            pub const ZERO: Self = Self([0u8; $len]);

            /// Tell if all bytes are zero.
            pub fn is_zero(&self) -> bool {
                self.0.iter().all(|b| *b == 0)
            }

            /// Decode canonical hex.
            pub fn from_hex(text: &str) -> Result<Self, HexError> {
                decode_fixed::<$len>(text).map(Self)
            }

            /// Encode as canonical hex.
            pub fn to_hex(&self) -> String {
                encode(&self.0)
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.to_hex())
            }
        }

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(&self.to_hex())
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let text = String::deserialize(deserializer)?;
                Self::from_hex(&text).map_err(serde::de::Error::custom)
            }
        }
    };
}

fixed_bytes!(
    /// A 32-byte value: an ID, a digest, or a key.
    Bytes32,
    32
);

fixed_bytes!(
    /// A 20-byte EVM address. The canonical form is lowercase. EIP-55 checksums are not accepted.
    Address,
    20
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let value = Bytes32([0xab; 32]);
        assert_eq!(Bytes32::from_hex(&value.to_hex()), Ok(value));
    }

    #[test]
    fn rejects_non_canonical_forms() {
        let lower = format!("0x{}", "ab".repeat(20));
        assert!(Address::from_hex(&lower).is_ok());
        assert_eq!(
            Address::from_hex(&lower.to_uppercase().replacen("0X", "0x", 1)),
            Err(HexError::NonCanonicalDigit)
        );
        assert_eq!(
            Address::from_hex(&"ab".repeat(20)),
            Err(HexError::MissingPrefix)
        );
        assert_eq!(
            Address::from_hex("0xabcd"),
            Err(HexError::WrongLength {
                expected: 40,
                found: 4
            })
        );
        assert_eq!(
            Address::from_hex(&format!("0x{}", "zz".repeat(20))),
            Err(HexError::NonCanonicalDigit)
        );
    }
}

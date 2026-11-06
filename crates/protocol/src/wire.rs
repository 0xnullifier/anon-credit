//! Wire value encodings for the JSON envelopes.
//!
//! - [`Base64Bytes`]: canonical base64 (standard alphabet, with padding). Decoding rejects
//!   any other form, for example missing padding, the URL-safe alphabet, white space, or
//!   non-zero padding bits.
//! - [`Signature64`]: an Ed25519 signature in canonical base64. It must decode to 64 bytes.
//! - [`DecimalU64`]: an unsigned 64-bit integer as a decimal string without leading zeros.
//!   JavaScript cannot represent all `u64` values as numbers, so the wire uses strings.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Failure to decode a wire value.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum WireError {
    /// The text is not canonical base64.
    #[error("value is not canonical base64")]
    NonCanonicalBase64,
    /// The decoded value has the wrong length.
    #[error("value must have {expected} bytes, found {found}")]
    WrongLength {
        /// Expected length in bytes.
        expected: usize,
        /// Decoded length in bytes.
        found: usize,
    },
    /// The text is not a canonical decimal `u64`.
    #[error("value must be a decimal integer without leading zeros, at most 2^64 - 1")]
    NonCanonicalDecimal,
}

/// Decode canonical base64. Reject every non-canonical form.
pub fn decode_base64(text: &str) -> Result<Vec<u8>, WireError> {
    let bytes = STANDARD
        .decode(text)
        .map_err(|_| WireError::NonCanonicalBase64)?;
    // The decoder accepts some non-zero trailing bits. A round trip finds them.
    if STANDARD.encode(&bytes) != text {
        return Err(WireError::NonCanonicalBase64);
    }
    Ok(bytes)
}

/// Encode bytes as canonical base64.
pub fn encode_base64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

/// Decode a canonical decimal `u64` string.
pub fn decode_decimal_u64(text: &str) -> Result<u64, WireError> {
    let canonical = match text.as_bytes() {
        [b'0'] => true,
        [first, rest @ ..] => {
            (b'1'..=b'9').contains(first) && rest.iter().all(|b| b.is_ascii_digit())
        }
        [] => false,
    };
    if !canonical {
        return Err(WireError::NonCanonicalDecimal);
    }
    text.parse::<u64>()
        .map_err(|_| WireError::NonCanonicalDecimal)
}

/// Bytes in canonical base64 on the wire.
#[derive(Clone, PartialEq, Eq, Default)]
pub struct Base64Bytes(pub Vec<u8>);

impl std::fmt::Debug for Base64Bytes {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Do not print the contents. They can be a proof or RPC parameters.
        write!(f, "Base64Bytes({} bytes)", self.0.len())
    }
}

impl Serialize for Base64Bytes {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&encode_base64(&self.0))
    }
}

impl<'de> Deserialize<'de> for Base64Bytes {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        decode_base64(&text)
            .map(Self)
            .map_err(serde::de::Error::custom)
    }
}

/// An Ed25519 signature (64 bytes) in canonical base64 on the wire.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Signature64(pub [u8; 64]);

impl std::fmt::Debug for Signature64 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Signature64(..)")
    }
}

impl Serialize for Signature64 {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&encode_base64(&self.0))
    }
}

impl<'de> Deserialize<'de> for Signature64 {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        let bytes = decode_base64(&text).map_err(serde::de::Error::custom)?;
        let found = bytes.len();
        <[u8; 64]>::try_from(bytes).map(Self).map_err(|_| {
            serde::de::Error::custom(WireError::WrongLength {
                expected: 64,
                found,
            })
        })
    }
}

/// An unsigned 64-bit integer as a canonical decimal string on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Default)]
pub struct DecimalU64(pub u64);

impl Serialize for DecimalU64 {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0.to_string())
    }
}

impl<'de> Deserialize<'de> for DecimalU64 {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        decode_decimal_u64(&text)
            .map(Self)
            .map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_round_trip_and_rejects_non_canonical() {
        assert_eq!(decode_base64("AQID"), Ok(vec![1, 2, 3]));
        assert_eq!(decode_base64("AQ=="), Ok(vec![1]));
        assert_eq!(decode_base64(""), Ok(vec![]));
        // Missing padding.
        assert!(decode_base64("AQ").is_err());
        // Non-zero padding bits.
        assert!(decode_base64("AR==").is_err());
        // URL-safe alphabet.
        assert!(decode_base64("-_-_").is_err());
        // White space.
        assert!(decode_base64("AQID\n").is_err());
    }

    #[test]
    fn decimal_is_strict() {
        assert_eq!(decode_decimal_u64("0"), Ok(0));
        assert_eq!(decode_decimal_u64("18446744073709551615"), Ok(u64::MAX));
        for bad in [
            "",
            "00",
            "01",
            "-1",
            "+1",
            "1.0",
            "18446744073709551616",
            " 1",
        ] {
            assert!(decode_decimal_u64(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn signature_needs_64_bytes() {
        let ok = format!("\"{}\"", encode_base64(&[7u8; 64]));
        assert!(serde_json::from_str::<Signature64>(&ok).is_ok());
        let short = format!("\"{}\"", encode_base64(&[7u8; 63]));
        assert!(serde_json::from_str::<Signature64>(&short).is_err());
    }
}

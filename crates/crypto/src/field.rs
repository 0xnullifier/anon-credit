//! BN254 scalar field elements and the byte-to-field encoding.
//!
//! Rules (implementation.md section 8):
//!
//! - The field is the BN254 scalar field. The modulus `p` is
//!   `0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001`.
//! - A field output on the wire is 32 bytes, big-endian, canonical. Decoding rejects a value
//!   that is not less than `p`. The value is never reduced.
//! - An arbitrary 32-byte value (an ID, a key, a secret) goes into the circuit as two limbs of
//!   128 bits: `hi` is bytes 0..16 big-endian and `lo` is bytes 16..32 big-endian.
//!   Each limb is less than `2^128`, so the limbs are never reduced.

use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Length of the canonical field encoding in bytes.
pub const FIELD_BYTES: usize = 32;

/// Failure to decode a field element.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FieldError {
    /// The value is not less than the field modulus.
    #[error("field value is not less than the BN254 scalar field modulus")]
    OutOfRange,
    /// The text is not `0x` and 64 lowercase hex digits.
    #[error("field value must be 0x and 64 lowercase hex digits")]
    BadHex,
}

/// One element of the BN254 scalar field.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct FieldElement(Fr);

impl FieldElement {
    /// The zero element. Unused circuit slots have this value.
    pub const ZERO: Self = Self(ark_ff::MontFp!("0"));

    /// Make an element from an arkworks value. Only for constants in this crate.
    pub(crate) const fn from_fr(value: Fr) -> Self {
        Self(value)
    }

    /// The arkworks value.
    pub(crate) fn fr(self) -> Fr {
        self.0
    }

    /// Make an element from an unsigned integer.
    pub fn from_u64(value: u64) -> Self {
        Self(Fr::from(value))
    }

    /// Make an element from an unsigned 128-bit integer. The value is less than `p`.
    pub fn from_u128(value: u128) -> Self {
        Self(Fr::from(value))
    }

    /// Decode the canonical 32-byte big-endian form. Reject a value that is not less than `p`.
    pub fn from_bytes_be(bytes: &[u8; FIELD_BYTES]) -> Result<Self, FieldError> {
        let value = Fr::from_be_bytes_mod_order(bytes);
        let element = Self(value);
        // Reduction changes a value that is not less than p. Thus a round trip finds it.
        if element.to_bytes_be() == *bytes {
            Ok(element)
        } else {
            Err(FieldError::OutOfRange)
        }
    }

    /// The canonical 32-byte big-endian form.
    pub fn to_bytes_be(&self) -> [u8; FIELD_BYTES] {
        let mut out = [0u8; FIELD_BYTES];
        let bytes = self.0.into_bigint().to_bytes_be();
        // The big integer has exactly 32 bytes for this field.
        let start = FIELD_BYTES.saturating_sub(bytes.len());
        out[start..].copy_from_slice(&bytes[bytes.len().saturating_sub(FIELD_BYTES)..]);
        out
    }

    /// Decode `0x` and 64 lowercase hex digits. Reject a value that is not less than `p`.
    pub fn from_hex(text: &str) -> Result<Self, FieldError> {
        let digits = text.strip_prefix("0x").ok_or(FieldError::BadHex)?;
        if digits.len() != FIELD_BYTES * 2
            || !digits
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        {
            return Err(FieldError::BadHex);
        }
        let mut bytes = [0u8; FIELD_BYTES];
        hex::decode_to_slice(digits, &mut bytes).map_err(|_| FieldError::BadHex)?;
        Self::from_bytes_be(&bytes)
    }

    /// Encode as `0x` and 64 lowercase hex digits.
    pub fn to_hex(&self) -> String {
        format!("0x{}", hex::encode(self.to_bytes_be()))
    }
}

impl std::fmt::Debug for FieldElement {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.to_hex())
    }
}

impl std::fmt::Display for FieldElement {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.to_hex())
    }
}

impl Serialize for FieldElement {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_hex())
    }
}

impl<'de> Deserialize<'de> for FieldElement {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        Self::from_hex(&text).map_err(serde::de::Error::custom)
    }
}

/// Two 128-bit limbs of a 32-byte value: `[hi, lo]`.
///
/// `hi` is the big-endian integer of bytes 0..16. `lo` is the big-endian integer of bytes 16..32.
pub fn bytes32_to_limbs(bytes: &[u8; 32]) -> [FieldElement; 2] {
    let mut hi = [0u8; 16];
    let mut lo = [0u8; 16];
    hi.copy_from_slice(&bytes[..16]);
    lo.copy_from_slice(&bytes[16..]);
    [
        FieldElement::from_u128(u128::from_be_bytes(hi)),
        FieldElement::from_u128(u128::from_be_bytes(lo)),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    const MODULUS_HEX: &str = "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001";
    const MODULUS_MINUS_ONE_HEX: &str =
        "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000000";

    #[test]
    fn canonical_round_trip() {
        let value = FieldElement::from_hex(MODULUS_MINUS_ONE_HEX);
        assert!(value.is_ok());
        let value = value.unwrap_or_default();
        assert_eq!(value.to_hex(), MODULUS_MINUS_ONE_HEX);
        assert_eq!(FieldElement::from_u64(7).to_hex(), format!("0x{:064x}", 7));
    }

    #[test]
    fn rejects_out_of_range_and_bad_hex() {
        assert_eq!(
            FieldElement::from_hex(MODULUS_HEX),
            Err(FieldError::OutOfRange)
        );
        assert_eq!(
            FieldElement::from_bytes_be(&[0xff; 32]),
            Err(FieldError::OutOfRange)
        );
        assert_eq!(
            FieldElement::from_hex(&MODULUS_MINUS_ONE_HEX.to_uppercase().replacen("0X", "0x", 1)),
            Err(FieldError::BadHex)
        );
        assert_eq!(FieldElement::from_hex("0x01"), Err(FieldError::BadHex));
        assert_eq!(
            FieldElement::from_hex(&MODULUS_MINUS_ONE_HEX[2..]),
            Err(FieldError::BadHex)
        );
    }

    #[test]
    fn limbs_are_not_reduced() {
        let [hi, lo] = bytes32_to_limbs(&[0xff; 32]);
        assert_eq!(hi, FieldElement::from_u128(u128::MAX));
        assert_eq!(lo, FieldElement::from_u128(u128::MAX));
        let mut bytes = [0u8; 32];
        bytes[0] = 1;
        bytes[31] = 2;
        let [hi, lo] = bytes32_to_limbs(&bytes);
        assert_eq!(hi, FieldElement::from_u128(1u128 << 120));
        assert_eq!(lo, FieldElement::from_u64(2));
    }
}

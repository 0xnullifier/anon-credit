//! Public inputs as canonical BN254 scalar field elements.

use std::fmt;

use ark_ff::{BigInt, PrimeField};
use provekit_backend_bn254::FieldElement;

use crate::error::PublicInputError;

/// One public input: a BN254 scalar field element in canonical big-endian form.
///
/// The value is always less than the field modulus. The text form is `0x` and 64 lowercase
/// hex digits.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct PublicInput([u8; 32]);

impl PublicInput {
    /// Makes a public input from 32 big-endian bytes.
    /// It rejects a value that is not less than the field modulus.
    pub fn from_be_bytes(bytes: [u8; 32]) -> Result<Self, PublicInputError> {
        to_field(&bytes).ok_or(PublicInputError::OutOfRange)?;
        Ok(Self(bytes))
    }

    /// Makes a public input from an unsigned integer.
    pub fn from_u64(value: u64) -> Self {
        let mut bytes = [0_u8; 32];
        bytes[24..].copy_from_slice(&value.to_be_bytes());
        Self(bytes)
    }

    /// Parses `0x` and 1 to 64 lowercase hex digits. Shorter values get zero padding on
    /// the left. It rejects a value that is not less than the field modulus.
    pub fn from_hex(text: &str) -> Result<Self, PublicInputError> {
        let digits = text.strip_prefix("0x").ok_or(PublicInputError::Format)?;
        let valid = !digits.is_empty()
            && digits.len() <= 64
            && digits
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
        if !valid {
            return Err(PublicInputError::Format);
        }
        let padded = format!("{digits:0>64}");
        let mut bytes = [0_u8; 32];
        hex::decode_to_slice(padded, &mut bytes).map_err(|_| PublicInputError::Format)?;
        Self::from_be_bytes(bytes)
    }

    /// Returns the 32 big-endian bytes.
    pub const fn to_be_bytes(&self) -> [u8; 32] {
        self.0
    }

    pub(crate) fn from_field(value: &FieldElement) -> Self {
        let limbs = value.into_bigint().0;
        let mut bytes = [0_u8; 32];
        for (index, limb) in limbs.iter().enumerate() {
            let end = 32 - 8 * index;
            bytes[end - 8..end].copy_from_slice(&limb.to_be_bytes());
        }
        Self(bytes)
    }
}

fn to_field(bytes: &[u8; 32]) -> Option<FieldElement> {
    let mut limbs = [0_u64; 4];
    for (index, limb) in limbs.iter_mut().enumerate() {
        let end = 32 - 8 * index;
        let mut word = [0_u8; 8];
        word.copy_from_slice(&bytes[end - 8..end]);
        *limb = u64::from_be_bytes(word);
    }
    FieldElement::from_bigint(BigInt(limbs))
}

impl fmt::Display for PublicInput {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "0x{}", hex::encode(self.0))
    }
}

impl fmt::Debug for PublicInput {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "PublicInput({self})")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MODULUS: &str = "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001";
    const MODULUS_MINUS_ONE: &str =
        "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000000";

    #[test]
    fn parses_and_formats() {
        let value = PublicInput::from_hex("0x3e7").unwrap();
        assert_eq!(value, PublicInput::from_u64(999));
        assert_eq!(
            value.to_string(),
            "0x00000000000000000000000000000000000000000000000000000000000003e7"
        );
    }

    #[test]
    fn rejects_modulus_and_accepts_modulus_minus_one() {
        assert_eq!(
            PublicInput::from_hex(MODULUS),
            Err(PublicInputError::OutOfRange)
        );
        let max = PublicInput::from_hex(MODULUS_MINUS_ONE).unwrap();
        let field = to_field(&max.to_be_bytes()).unwrap();
        assert_eq!(PublicInput::from_field(&field), max);
    }

    #[test]
    fn rejects_bad_text() {
        for text in [
            "3e7",
            "0x",
            "0x3E7",
            "0xg",
            &format!("0x{}", "0".repeat(65)),
        ] {
            assert_eq!(
                PublicInput::from_hex(text),
                Err(PublicInputError::Format),
                "{text}"
            );
        }
    }
}

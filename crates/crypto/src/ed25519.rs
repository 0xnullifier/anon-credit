//! Ed25519 signature verification helper.

use ed25519_dalek::{Signature, VerifyingKey};

/// Length of an Ed25519 public key in bytes.
pub const ED25519_PUBLIC_KEY_LEN: usize = 32;

/// Length of an Ed25519 signature in bytes.
pub const ED25519_SIGNATURE_LEN: usize = 64;

/// Failure of an Ed25519 check.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Ed25519Error {
    /// The public key bytes do not decode to a valid curve point.
    #[error("public key is not a valid Ed25519 point")]
    InvalidPublicKey,
    /// The signature does not verify under the public key and message.
    #[error("signature does not verify")]
    InvalidSignature,
}

/// Verify an Ed25519 signature over `message`.
///
/// Use strict verification. This rejects weak (small-order) public keys and
/// non-canonical signature encodings.
pub fn verify_ed25519(
    public_key: &[u8; ED25519_PUBLIC_KEY_LEN],
    message: &[u8],
    signature: &[u8; ED25519_SIGNATURE_LEN],
) -> Result<(), Ed25519Error> {
    let key = VerifyingKey::from_bytes(public_key).map_err(|_| Ed25519Error::InvalidPublicKey)?;
    let signature = Signature::from_bytes(signature);
    key.verify_strict(message, &signature)
        .map_err(|_| Ed25519Error::InvalidSignature)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn fixed_key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    #[test]
    fn accepts_valid_signature() {
        let key = fixed_key();
        let signature = key.sign(b"message");
        let result = verify_ed25519(
            &key.verifying_key().to_bytes(),
            b"message",
            &signature.to_bytes(),
        );
        assert_eq!(result, Ok(()));
    }

    #[test]
    fn rejects_changed_message() {
        let key = fixed_key();
        let signature = key.sign(b"message");
        let result = verify_ed25519(
            &key.verifying_key().to_bytes(),
            b"messagf",
            &signature.to_bytes(),
        );
        assert_eq!(result, Err(Ed25519Error::InvalidSignature));
    }

    #[test]
    fn rejects_changed_signature() {
        let key = fixed_key();
        let mut signature = key.sign(b"message").to_bytes();
        signature[0] ^= 1;
        let result = verify_ed25519(&key.verifying_key().to_bytes(), b"message", &signature);
        assert_eq!(result, Err(Ed25519Error::InvalidSignature));
    }

    #[test]
    fn rejects_small_order_public_key() {
        // The identity point is a small-order point. Strict verification must reject it.
        let mut identity = [0u8; 32];
        identity[0] = 1;
        let result = verify_ed25519(&identity, b"message", &[0u8; 64]);
        assert!(result.is_err());
    }

    #[test]
    fn matches_rfc8032_test_1() {
        // RFC 8032 section 7.1, TEST 1 (empty message).
        let public_key: [u8; 32] =
            hex::decode("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
                .unwrap()
                .try_into()
                .unwrap();
        let signature: [u8; 64] = hex::decode(concat!(
            "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155",
            "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
        ))
        .unwrap()
        .try_into()
        .unwrap();
        assert_eq!(verify_ed25519(&public_key, b"", &signature), Ok(()));
    }
}

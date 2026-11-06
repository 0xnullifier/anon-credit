//! Open signing message.
//!
//! The client signs `keccak256(message)` with the session Ed25519 key. The signature proves
//! possession of the session key. The proof separately proves ownership of the credit.
//! Neither check replaces the other.
//!
//! All integers are big-endian. All IDs have a fixed size. The message has no variable part.
//!
//! | Offset | Size | Field                               |
//! |-------:|-----:|-------------------------------------|
//! |      0 |   32 | operation domain ([`domain::OPEN`]) |
//! |     32 |    2 | protocol version (`u16`)            |
//! |     34 |   32 | `deployment_id`                     |
//! |     66 |   32 | `gateway_id`                        |
//! |     98 |   32 | `batch_id` (field element)          |
//! |    130 |   32 | `root` (field element)              |
//! |    162 |    4 | `leaf_count` (`u32`)                |
//! |    166 |    8 | `proof_epoch` (`u64`)               |
//! |    174 |   32 | `session_pub` (Ed25519 public key)  |
//! |    206 |   32 | `price_table_hash`                  |

use crate::domain;
use crate::hex_bytes::Bytes32;
use crate::version::PROTOCOL_VERSION;
use anon_credit_crypto::keccak256;

/// Length of the open message in bytes.
pub const OPEN_MESSAGE_LEN: usize = 238;

/// Fields of one open signing message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpenMessage {
    /// Digest of the deployment configuration.
    pub deployment_id: Bytes32,
    /// Random gateway identity from the deployment.
    pub gateway_id: Bytes32,
    /// Public batch ID of the proof (canonical field element).
    pub batch_id: Bytes32,
    /// Selected published MMR root (canonical field element).
    pub root: Bytes32,
    /// Leaf count of the selected root.
    pub leaf_count: u32,
    /// Epoch of the proof.
    pub proof_epoch: u64,
    /// Session Ed25519 public key.
    pub session_pub: Bytes32,
    /// Hash of the price table that the session freezes.
    pub price_table_hash: Bytes32,
}

impl OpenMessage {
    /// Encode the message bytes.
    pub fn encode(&self) -> [u8; OPEN_MESSAGE_LEN] {
        let mut out = [0u8; OPEN_MESSAGE_LEN];
        let parts: [&[u8]; 10] = [
            domain::OPEN.as_bytes(),
            &PROTOCOL_VERSION.to_be_bytes(),
            &self.deployment_id.0,
            &self.gateway_id.0,
            &self.batch_id.0,
            &self.root.0,
            &self.leaf_count.to_be_bytes(),
            &self.proof_epoch.to_be_bytes(),
            &self.session_pub.0,
            &self.price_table_hash.0,
        ];
        let mut offset = 0;
        for part in parts {
            out[offset..offset + part.len()].copy_from_slice(part);
            offset += part.len();
        }
        out
    }

    /// Calculate the digest that the session key signs: `keccak256(encode())`.
    pub fn digest(&self) -> Bytes32 {
        Bytes32(keccak256(&self.encode()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> OpenMessage {
        OpenMessage {
            deployment_id: Bytes32([1; 32]),
            gateway_id: Bytes32([2; 32]),
            batch_id: Bytes32([3; 32]),
            root: Bytes32([4; 32]),
            leaf_count: 0x0102_0304,
            proof_epoch: 0x1112_1314_1516_1718,
            session_pub: Bytes32([5; 32]),
            price_table_hash: Bytes32([6; 32]),
        }
    }

    #[test]
    fn layout_has_fixed_offsets() {
        let bytes = sample().encode();
        assert_eq!(&bytes[0..32], domain::OPEN.as_bytes());
        assert_eq!(&bytes[32..34], &PROTOCOL_VERSION.to_be_bytes());
        assert_eq!(&bytes[34..66], &[1; 32]);
        assert_eq!(&bytes[66..98], &[2; 32]);
        assert_eq!(&bytes[98..130], &[3; 32]);
        assert_eq!(&bytes[130..162], &[4; 32]);
        assert_eq!(&bytes[162..166], &[1, 2, 3, 4]);
        assert_eq!(
            &bytes[166..174],
            &[0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18]
        );
        assert_eq!(&bytes[174..206], &[5; 32]);
        assert_eq!(&bytes[206..238], &[6; 32]);
    }

    #[test]
    fn each_field_changes_the_digest() {
        let base = sample().digest();
        let changes: [fn(&mut OpenMessage); 8] = [
            |m| m.deployment_id.0[0] ^= 1,
            |m| m.gateway_id.0[0] ^= 1,
            |m| m.batch_id.0[0] ^= 1,
            |m| m.root.0[0] ^= 1,
            |m| m.leaf_count ^= 1,
            |m| m.proof_epoch ^= 1,
            |m| m.session_pub.0[0] ^= 1,
            |m| m.price_table_hash.0[0] ^= 1,
        ];
        for change in changes {
            let mut message = sample();
            change(&mut message);
            assert_ne!(message.digest(), base);
        }
    }
}

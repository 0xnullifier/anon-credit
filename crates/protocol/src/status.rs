//! Session status signing message.
//!
//! The client signs `keccak256(message)` with the session Ed25519 key. The gateway returns
//! the session state and echoes the nonce. The nonce is random, so a recorded signature does
//! not match a new status request of the client.
//!
//! All IDs have a fixed size. The message has no variable part.
//!
//! | Offset | Size | Field                                 |
//! |-------:|-----:|---------------------------------------|
//! |      0 |   32 | operation domain ([`domain::STATUS`]) |
//! |     32 |    2 | protocol version (`u16`)              |
//! |     34 |   32 | `deployment_id`                       |
//! |     66 |   32 | `gateway_id`                          |
//! |     98 |   32 | `batch_id`                            |
//! |    130 |   32 | `nonce` (32 random bytes)             |

use crate::domain;
use crate::hex_bytes::Bytes32;
use crate::version::PROTOCOL_VERSION;
use anon_credit_crypto::keccak256;

/// Length of the status message in bytes.
pub const STATUS_MESSAGE_LEN: usize = 162;

/// Fields of one status signing message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StatusMessage {
    /// Digest of the deployment configuration.
    pub deployment_id: Bytes32,
    /// Random gateway identity from the deployment.
    pub gateway_id: Bytes32,
    /// Public batch ID of the session.
    pub batch_id: Bytes32,
    /// Random client nonce.
    pub nonce: Bytes32,
}

impl StatusMessage {
    /// Encode the message bytes.
    pub fn encode(&self) -> [u8; STATUS_MESSAGE_LEN] {
        let mut out = [0u8; STATUS_MESSAGE_LEN];
        let parts: [&[u8]; 6] = [
            domain::STATUS.as_bytes(),
            &PROTOCOL_VERSION.to_be_bytes(),
            &self.deployment_id.0,
            &self.gateway_id.0,
            &self.batch_id.0,
            &self.nonce.0,
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

    #[test]
    fn layout_has_fixed_offsets() {
        let message = StatusMessage {
            deployment_id: Bytes32([1; 32]),
            gateway_id: Bytes32([2; 32]),
            batch_id: Bytes32([3; 32]),
            nonce: Bytes32([4; 32]),
        };
        let bytes = message.encode();
        assert_eq!(&bytes[0..32], domain::STATUS.as_bytes());
        assert_eq!(&bytes[32..34], &PROTOCOL_VERSION.to_be_bytes());
        assert_eq!(&bytes[34..66], &[1; 32]);
        assert_eq!(&bytes[66..98], &[2; 32]);
        assert_eq!(&bytes[98..130], &[3; 32]);
        assert_eq!(&bytes[130..162], &[4; 32]);
    }

    #[test]
    fn domain_differs_from_open_and_spend() {
        assert_ne!(domain::STATUS, domain::OPEN);
        assert_ne!(domain::STATUS, domain::SPEND);
    }
}

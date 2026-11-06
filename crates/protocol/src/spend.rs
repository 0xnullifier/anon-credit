//! Spend signing message.
//!
//! The client signs `keccak256(message)` with the session Ed25519 key.
//! All integers are big-endian. All IDs have a fixed size.
//!
//! | Offset | Size | Field                                |
//! |-------:|-----:|--------------------------------------|
//! |      0 |   32 | operation domain ([`domain::SPEND`]) |
//! |     32 |    2 | protocol version (`u16`)             |
//! |     34 |   32 | `deployment_id`                      |
//! |     66 |   32 | `gateway_id`                         |
//! |     98 |   32 | `batch_id`                           |
//! |    130 |   32 | `price_table_hash`                   |
//! |    162 |    8 | `seq` (`u64`)                        |
//! |    170 |    8 | `units_total` (`u64`)                |
//! |    178 |    4 | `rpc_byte_length` (`u32`)            |
//! |    182 |    n | `rpc_bytes`                          |

use crate::domain;
use crate::hex_bytes::Bytes32;
use crate::version::PROTOCOL_VERSION;
use anon_credit_crypto::keccak256;

/// Length of the fixed part of the spend message, before the RPC bytes.
pub const SPEND_MESSAGE_HEADER_LEN: usize = 182;

/// Failure to encode a spend message.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SpendMessageError {
    /// The RPC bytes are longer than a `u32` length field can hold.
    #[error("rpc bytes are too long: {len} bytes")]
    RpcTooLong {
        /// Length of the RPC bytes.
        len: usize,
    },
}

/// Fields of one spend signing message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpendMessage<'a> {
    /// Digest of the deployment configuration.
    pub deployment_id: Bytes32,
    /// Random gateway identity from the deployment.
    pub gateway_id: Bytes32,
    /// Public batch ID from the open proof.
    pub batch_id: Bytes32,
    /// Hash of the price table frozen at open.
    pub price_table_hash: Bytes32,
    /// Sequence number. The first request has sequence zero.
    pub seq: u64,
    /// Cumulative units charged, including this request.
    pub units_total: u64,
    /// Exact UTF-8 bytes of one JSON-RPC object.
    pub rpc_bytes: &'a [u8],
}

impl SpendMessage<'_> {
    /// Encode the message bytes.
    pub fn encode(&self) -> Result<Vec<u8>, SpendMessageError> {
        let rpc_len =
            u32::try_from(self.rpc_bytes.len()).map_err(|_| SpendMessageError::RpcTooLong {
                len: self.rpc_bytes.len(),
            })?;
        let mut out = Vec::with_capacity(SPEND_MESSAGE_HEADER_LEN + self.rpc_bytes.len());
        out.extend_from_slice(domain::SPEND.as_bytes());
        out.extend_from_slice(&PROTOCOL_VERSION.to_be_bytes());
        out.extend_from_slice(&self.deployment_id.0);
        out.extend_from_slice(&self.gateway_id.0);
        out.extend_from_slice(&self.batch_id.0);
        out.extend_from_slice(&self.price_table_hash.0);
        out.extend_from_slice(&self.seq.to_be_bytes());
        out.extend_from_slice(&self.units_total.to_be_bytes());
        out.extend_from_slice(&rpc_len.to_be_bytes());
        out.extend_from_slice(self.rpc_bytes);
        Ok(out)
    }

    /// Calculate the digest that the session key signs: `keccak256(encode())`.
    pub fn digest(&self) -> Result<Bytes32, SpendMessageError> {
        self.encode().map(|bytes| Bytes32(keccak256(&bytes)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(rpc: &[u8]) -> SpendMessage<'_> {
        SpendMessage {
            deployment_id: Bytes32([1; 32]),
            gateway_id: Bytes32([2; 32]),
            batch_id: Bytes32([3; 32]),
            price_table_hash: Bytes32([4; 32]),
            seq: 0x0102_0304_0506_0708,
            units_total: 0x1112_1314_1516_1718,
            rpc_bytes: rpc,
        }
    }

    #[test]
    fn layout_has_fixed_offsets() {
        let rpc = b"{}";
        let bytes = sample(rpc).encode().unwrap();
        assert_eq!(bytes.len(), SPEND_MESSAGE_HEADER_LEN + rpc.len());
        assert_eq!(&bytes[0..32], domain::SPEND.as_bytes());
        assert_eq!(&bytes[32..34], &PROTOCOL_VERSION.to_be_bytes());
        assert_eq!(&bytes[34..66], &[1; 32]);
        assert_eq!(&bytes[66..98], &[2; 32]);
        assert_eq!(&bytes[98..130], &[3; 32]);
        assert_eq!(&bytes[130..162], &[4; 32]);
        assert_eq!(&bytes[162..170], &[1, 2, 3, 4, 5, 6, 7, 8]);
        assert_eq!(
            &bytes[170..178],
            &[0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18]
        );
        assert_eq!(&bytes[178..182], &[0, 0, 0, 2]);
        assert_eq!(&bytes[182..], rpc);
    }

    #[test]
    fn empty_rpc_has_zero_length() {
        let bytes = sample(b"").encode().unwrap();
        assert_eq!(bytes.len(), SPEND_MESSAGE_HEADER_LEN);
        assert_eq!(&bytes[178..182], &[0, 0, 0, 0]);
    }

    #[test]
    fn each_field_changes_the_digest() {
        let rpc = b"{\"id\":1}";
        let base = sample(rpc).digest().unwrap();
        let mut changed = sample(rpc);
        changed.seq += 1;
        assert_ne!(changed.digest().unwrap(), base);
        let mut changed = sample(rpc);
        changed.units_total += 1;
        assert_ne!(changed.digest().unwrap(), base);
        let mut changed = sample(rpc);
        changed.gateway_id.0[31] ^= 1;
        assert_ne!(changed.digest().unwrap(), base);
        let mut changed = sample(rpc);
        changed.deployment_id.0[0] ^= 1;
        assert_ne!(changed.digest().unwrap(), base);
        let mut changed = sample(rpc);
        changed.batch_id.0[0] ^= 1;
        assert_ne!(changed.digest().unwrap(), base);
        let mut changed = sample(rpc);
        changed.price_table_hash.0[0] ^= 1;
        assert_ne!(changed.digest().unwrap(), base);
        assert_ne!(sample(b"{\"id\":2}").digest().unwrap(), base);
    }
}

//! Batch constructions of the batch-open statement.
//!
//! `H` is [`crate::poseidon2::hash`]. `[hi, lo]` is [`crate::field::bytes32_to_limbs`].
//!
//! ```text
//! c        = H(DOM_COMMITMENT, deployment_id_hi, deployment_id_lo, k_hi, k_lo)
//! leaf     = H(DOM_LEAF, c, K, expiry)                     K = 100
//! batch_id = H(DOM_BATCH_ID, deployment_id_hi, deployment_id_lo, k_hi, k_lo)
//! binding  = H(DOM_BINDING, gateway_id_hi, gateway_id_lo, session_pub_hi, session_pub_lo)
//! ```
//!
//! The deployment ID is in `c` and `batch_id`. Thus credit of one deployment does not open in a
//! different deployment. The issuer knows `c` and `leaf`, but not `k`, so it cannot calculate
//! `batch_id`. The gateway knows `batch_id`, but not `k`, so it cannot calculate `c`.

use crate::constants::{BATCH_UNITS_K, DOM_BATCH_ID, DOM_BINDING, DOM_COMMITMENT, DOM_LEAF};
use crate::field::{FieldElement, bytes32_to_limbs};
use crate::poseidon2::hash;

/// Length of the batch secret `k` in bytes.
pub const BATCH_SECRET_LEN: usize = 32;

fn tagged_pair(tag: FieldElement, a: &[u8; 32], b: &[u8; 32]) -> FieldElement {
    let [a_hi, a_lo] = bytes32_to_limbs(a);
    let [b_hi, b_lo] = bytes32_to_limbs(b);
    hash(&[tag, a_hi, a_lo, b_hi, b_lo])
}

/// Purchase commitment `c`. The client sends it to the sale contract.
pub fn commitment(deployment_id: &[u8; 32], k: &[u8; BATCH_SECRET_LEN]) -> FieldElement {
    tagged_pair(DOM_COMMITMENT, deployment_id, k)
}

/// Tree leaf. The issuer calculates it from the commitment and its own expiry epoch.
pub fn leaf(commitment: FieldElement, expiry: u64) -> FieldElement {
    hash(&[
        DOM_LEAF,
        commitment,
        FieldElement::from_u64(BATCH_UNITS_K),
        FieldElement::from_u64(expiry),
    ])
}

/// Public batch ID. The client reveals it to the gateway at open.
pub fn batch_id(deployment_id: &[u8; 32], k: &[u8; BATCH_SECRET_LEN]) -> FieldElement {
    tagged_pair(DOM_BATCH_ID, deployment_id, k)
}

/// Public session binding. The gateway calculates it from its ID and the received session key.
pub fn session_binding(gateway_id: &[u8; 32], session_pub: &[u8; 32]) -> FieldElement {
    tagged_pair(DOM_BINDING, gateway_id, session_pub)
}

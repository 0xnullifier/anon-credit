//! Public inputs of the batch-open circuit.
//!
//! The circuit `circuits/batch-open` has these public inputs, in this order:
//!
//! | Index | Value |
//! |---|---|
//! | 0 | `CIRCUIT_ID` (protocol version 1, batch-open statement) |
//! | 1, 2 | `deployment_id` as `[hi, lo]` limbs |
//! | 3, 4 | `gateway_id` as `[hi, lo]` limbs |
//! | 5 | MMR `root` |
//! | 6 | `leaf_count` (less than `2^32`) |
//! | 7 | `proof_epoch` (less than `2^64`) |
//! | 8 | `batch_id` |
//! | 9 | session `binding` |
//!
//! The gateway does not accept public inputs from the client. It builds them from the open
//! request, its configuration, and the root record, with [`BatchOpenPublicInputs::for_open`].

use crate::batch::session_binding;
use crate::constants::CIRCUIT_ID;
use crate::field::{FieldElement, bytes32_to_limbs};

/// Number of public inputs of the batch-open circuit.
pub const PUBLIC_INPUT_COUNT: usize = 10;

/// The public inputs of one batch-open proof.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BatchOpenPublicInputs {
    /// Deployment ID (Keccak-256 of the deployment encoding).
    pub deployment_id: [u8; 32],
    /// Gateway ID.
    pub gateway_id: [u8; 32],
    /// Selected published MMR root.
    pub root: FieldElement,
    /// Leaf count of the selected root.
    pub leaf_count: u32,
    /// Epoch of the proof.
    pub proof_epoch: u64,
    /// Batch ID.
    pub batch_id: FieldElement,
    /// Session binding.
    pub binding: FieldElement,
}

impl BatchOpenPublicInputs {
    /// Build the public inputs for an open request. Calculate the binding from `session_pub`.
    pub fn for_open(
        deployment_id: [u8; 32],
        gateway_id: [u8; 32],
        root: FieldElement,
        leaf_count: u32,
        proof_epoch: u64,
        batch_id: FieldElement,
        session_pub: &[u8; 32],
    ) -> Self {
        Self {
            deployment_id,
            gateway_id,
            root,
            leaf_count,
            proof_epoch,
            batch_id,
            binding: session_binding(&gateway_id, session_pub),
        }
    }

    /// The public-input vector in circuit order.
    pub fn to_fields(&self) -> [FieldElement; PUBLIC_INPUT_COUNT] {
        let [deployment_hi, deployment_lo] = bytes32_to_limbs(&self.deployment_id);
        let [gateway_hi, gateway_lo] = bytes32_to_limbs(&self.gateway_id);
        [
            CIRCUIT_ID,
            deployment_hi,
            deployment_lo,
            gateway_hi,
            gateway_lo,
            self.root,
            FieldElement::from_u64(u64::from(self.leaf_count)),
            FieldElement::from_u64(self.proof_epoch),
            self.batch_id,
            self.binding,
        ]
    }
}

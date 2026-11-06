//! Full input set of the batch-open circuit.
//!
//! [`BatchOpenWitness`] has one field for each parameter of `main` in
//! `circuits/batch-open/src/main.nr`, with the same names. [`BatchOpenWitness::to_prover_toml`]
//! writes the `Prover.toml` form that `nargo execute` reads.
//!
//! Fixed-size path layout:
//!
//! - `siblings[j]` (`j < 32`) is the sibling at level `j` for `j < h`, where `h` is the peak
//!   height of the leaf. The slots `j >= h` are zero.
//! - `peaks[h]` (`h < 32`) is the peak of height `h` if bit `h` of `leaf_count` is 1, else zero.

use crate::mmr::{Mmr, MmrError};
use crate::proof::{MembershipProof, ProofError, check_proof};
use crate::store::MmrStore;
use anon_credit_crypto::batch::{batch_id, commitment, leaf};
use anon_credit_crypto::constants::{CIRCUIT_ID, MAX_HEIGHT, MAX_PEAKS};
use anon_credit_crypto::mmr_hash::peak_slots;
use anon_credit_crypto::{
    BatchOpenPublicInputs, FieldElement, PUBLIC_INPUT_COUNT, bytes32_to_limbs,
};
use serde::{Deserialize, Serialize};

/// The secret and public values that a client has for one batch open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpenSecrets {
    /// Deployment ID.
    pub deployment_id: [u8; 32],
    /// Gateway ID.
    pub gateway_id: [u8; 32],
    /// Batch secret `k`.
    pub k: [u8; 32],
    /// Ed25519 session public key.
    pub session_pub: [u8; 32],
    /// Activation expiry epoch of the leaf. The issuer set it at insertion.
    pub expiry: u64,
    /// Epoch of the proof.
    pub proof_epoch: u64,
}

/// Failure to build a witness from a membership proof.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum WitnessError {
    /// The membership proof is not valid for the leaf of these secrets.
    #[error("membership proof is not valid for this leaf: {0}")]
    Proof(ProofError),
    /// The proof epoch is after the expiry epoch.
    #[error("proof epoch {proof_epoch} is after expiry {expiry}")]
    Expired {
        /// Proof epoch.
        proof_epoch: u64,
        /// Expiry epoch.
        expiry: u64,
    },
}

/// Failure to build a witness from the tree state.
#[derive(Debug, thiserror::Error)]
pub enum MmrWitnessError<E: std::error::Error + 'static> {
    /// The MMR failed.
    #[error(transparent)]
    Mmr(#[from] MmrError<E>),
    /// The witness is not valid.
    #[error(transparent)]
    Witness(#[from] WitnessError),
}

mod decimal_u64 {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        let text = String::deserialize(deserializer)?;
        let canonical = text == "0" || (!text.starts_with('0') && !text.is_empty());
        if !canonical || !text.bytes().all(|b| b.is_ascii_digit()) {
            return Err(serde::de::Error::custom(
                "expected a canonical decimal integer",
            ));
        }
        text.parse().map_err(serde::de::Error::custom)
    }
}

/// All inputs of the batch-open circuit. The field names are the parameter names of `main`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BatchOpenWitness {
    /// Public: circuit ID.
    pub circuit_id: FieldElement,
    /// Public: deployment ID limbs `[hi, lo]`.
    pub deployment_id: [FieldElement; 2],
    /// Public: gateway ID limbs `[hi, lo]`.
    pub gateway_id: [FieldElement; 2],
    /// Public: MMR root of the selected snapshot.
    pub root: FieldElement,
    /// Public: leaf count of the selected snapshot.
    pub leaf_count: u32,
    /// Public: proof epoch. A decimal string in JSON.
    #[serde(with = "decimal_u64")]
    pub proof_epoch: u64,
    /// Public: batch ID.
    pub batch_id: FieldElement,
    /// Public: session binding.
    pub binding: FieldElement,
    /// Private: batch secret limbs `[hi, lo]`.
    pub k: [FieldElement; 2],
    /// Private: expiry epoch. A decimal string in JSON.
    #[serde(with = "decimal_u64")]
    pub expiry: u64,
    /// Private: leaf index.
    pub leaf_index: u32,
    /// Private: sibling slots, zero above the peak height.
    pub siblings: [FieldElement; MAX_HEIGHT],
    /// Private: height-indexed peak slots.
    pub peaks: [FieldElement; MAX_PEAKS],
    /// Private: session public key limbs `[hi, lo]`.
    pub session_pub: [FieldElement; 2],
}

impl BatchOpenWitness {
    /// Build the witness from a membership proof that the client fetched for a selected root.
    ///
    /// The function checks the proof against `root` and the leaf of `secrets`, and checks
    /// that the proof epoch is not after the expiry. Thus a returned witness satisfies the circuit.
    pub fn from_proof(
        secrets: &OpenSecrets,
        root: FieldElement,
        proof: &MembershipProof,
    ) -> Result<Self, WitnessError> {
        if secrets.proof_epoch > secrets.expiry {
            return Err(WitnessError::Expired {
                proof_epoch: secrets.proof_epoch,
                expiry: secrets.expiry,
            });
        }
        let leaf_value = leaf(
            commitment(&secrets.deployment_id, &secrets.k),
            secrets.expiry,
        );
        check_proof(root, proof, leaf_value).map_err(WitnessError::Proof)?;
        let mut siblings = [FieldElement::ZERO; MAX_HEIGHT];
        siblings[..proof.siblings.len()].copy_from_slice(&proof.siblings);
        // check_proof accepted the peak count, so peak_slots does not fail here.
        let peaks = peak_slots(proof.leaf_count, &proof.peaks)
            .map_err(|_| WitnessError::Proof(ProofError::WrongPeakCount))?;
        let public = BatchOpenPublicInputs::for_open(
            secrets.deployment_id,
            secrets.gateway_id,
            root,
            proof.leaf_count,
            secrets.proof_epoch,
            batch_id(&secrets.deployment_id, &secrets.k),
            &secrets.session_pub,
        );
        Ok(Self {
            circuit_id: CIRCUIT_ID,
            deployment_id: bytes32_to_limbs(&secrets.deployment_id),
            gateway_id: bytes32_to_limbs(&secrets.gateway_id),
            root,
            leaf_count: proof.leaf_count,
            proof_epoch: secrets.proof_epoch,
            batch_id: public.batch_id,
            binding: public.binding,
            k: bytes32_to_limbs(&secrets.k),
            expiry: secrets.expiry,
            leaf_index: proof.leaf_index,
            siblings,
            peaks,
            session_pub: bytes32_to_limbs(&secrets.session_pub),
        })
    }

    /// Build the witness from the tree state at the snapshot with `leaf_count` leaves.
    pub fn from_mmr<S: MmrStore>(
        mmr: &Mmr<S>,
        leaf_count: u32,
        leaf_index: u32,
        secrets: &OpenSecrets,
    ) -> Result<Self, MmrWitnessError<S::Error>> {
        let root = mmr.root_at(leaf_count)?;
        let proof = mmr.membership_proof_at(leaf_index, leaf_count)?;
        Ok(Self::from_proof(secrets, root, &proof)?)
    }

    /// The public-input vector in circuit order. The gateway builds the same vector from the
    /// open request with [`BatchOpenPublicInputs::for_open`].
    pub fn public_inputs(&self) -> [FieldElement; PUBLIC_INPUT_COUNT] {
        [
            self.circuit_id,
            self.deployment_id[0],
            self.deployment_id[1],
            self.gateway_id[0],
            self.gateway_id[1],
            self.root,
            FieldElement::from_u64(u64::from(self.leaf_count)),
            FieldElement::from_u64(self.proof_epoch),
            self.batch_id,
            self.binding,
        ]
    }

    /// The `Prover.toml` text for `nargo execute`.
    pub fn to_prover_toml(&self) -> String {
        fn field(name: &str, value: &FieldElement) -> String {
            format!("{name} = \"{value}\"\n")
        }
        fn list(name: &str, values: &[FieldElement]) -> String {
            let items: Vec<String> = values.iter().map(|v| format!("\"{v}\"")).collect();
            format!("{name} = [{}]\n", items.join(", "))
        }
        let mut out = String::new();
        out.push_str(&field("circuit_id", &self.circuit_id));
        out.push_str(&list("deployment_id", &self.deployment_id));
        out.push_str(&list("gateway_id", &self.gateway_id));
        out.push_str(&field("root", &self.root));
        out.push_str(&format!("leaf_count = \"{}\"\n", self.leaf_count));
        out.push_str(&format!("proof_epoch = \"{}\"\n", self.proof_epoch));
        out.push_str(&field("batch_id", &self.batch_id));
        out.push_str(&field("binding", &self.binding));
        out.push_str(&list("k", &self.k));
        out.push_str(&format!("expiry = \"{}\"\n", self.expiry));
        out.push_str(&format!("leaf_index = \"{}\"\n", self.leaf_index));
        out.push_str(&list("siblings", &self.siblings));
        out.push_str(&list("peaks", &self.peaks));
        out.push_str(&list("session_pub", &self.session_pub));
        out
    }
}

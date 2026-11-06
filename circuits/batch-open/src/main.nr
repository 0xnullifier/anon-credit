// Batch-open circuit (implementation.md section 8, Architecture.md section 3).
//
// Statement: the prover knows a batch secret k such that
//   c        = H(DOM_COMMITMENT, deployment_id_hi, deployment_id_lo, k_hi, k_lo)
//   leaf     = H(DOM_LEAF, c, K, expiry)                     K = 100
//   leaf is in the MMR with the public root and leaf_count, at the private leaf_index
//   batch_id = H(DOM_BATCH_ID, deployment_id_hi, deployment_id_lo, k_hi, k_lo)
//   binding  = H(DOM_BINDING, gateway_id_hi, gateway_id_lo, session_pub_hi, session_pub_lo)
//   proof_epoch <= expiry
//
// H is the Poseidon2 sponge in hash.nr. A 32-byte value is two 128-bit limbs [hi, lo].
// The domain tags are in constants.nr, generated from fixtures/protocol/domains.json.
//
// Public inputs, in order (anon_credit_crypto::public_inputs has the same order):
//   circuit_id, deployment_id[2], gateway_id[2], root, leaf_count, proof_epoch, batch_id, binding

mod constants;
mod hash;
mod mmr;
mod hash_vectors;
mod witness_vectors;
mod tests;

use constants::{
    BATCH_UNITS_K, CIRCUIT_ID, DOM_BATCH_ID, DOM_BINDING, DOM_COMMITMENT, DOM_LEAF, MAX_HEIGHT,
    MAX_PEAKS,
};
use hash::hash;
use mmr::membership_root;

// Constrain a limb to be less than 2^128.
fn assert_limbs(limbs: [Field; 2]) {
    limbs[0].assert_max_bit_size::<128>();
    limbs[1].assert_max_bit_size::<128>();
}

fn main(
    circuit_id: pub Field,
    deployment_id: pub [Field; 2],
    gateway_id: pub [Field; 2],
    root: pub Field,
    leaf_count: pub Field,
    proof_epoch: pub u64,
    batch_id: pub Field,
    binding: pub Field,
    k: [Field; 2],
    expiry: u64,
    leaf_index: Field,
    siblings: [Field; MAX_HEIGHT],
    peaks: [Field; MAX_PEAKS],
    session_pub: [Field; 2],
) {
    assert(circuit_id == CIRCUIT_ID, "circuit id mismatch");
    assert_limbs(deployment_id);
    assert_limbs(gateway_id);
    assert_limbs(k);
    assert_limbs(session_pub);

    let c = hash(
        [DOM_COMMITMENT, deployment_id[0], deployment_id[1], k[0], k[1]],
    );
    let leaf = hash([DOM_LEAF, c, BATCH_UNITS_K, expiry as Field]);
    let calculated_id = hash(
        [DOM_BATCH_ID, deployment_id[0], deployment_id[1], k[0], k[1]],
    );
    assert(calculated_id == batch_id, "batch id mismatch");
    let calculated_binding = hash([
        DOM_BINDING,
        gateway_id[0],
        gateway_id[1],
        session_pub[0],
        session_pub[1],
    ]);
    assert(calculated_binding == binding, "binding mismatch");
    assert(proof_epoch <= expiry, "batch expired");
    assert(membership_root(leaf, leaf_index, leaf_count, siblings, peaks) == root, "root mismatch");
}

// Reference vectors for the circuit hash.
//
// This package uses `poseidon::poseidon2::Poseidon2::hash` from noir-lang/poseidon v0.2.0.
// That sponge is the same code as `std::hash::poseidon2::Poseidon2::hash` in the Noir standard
// library. It does not use the sponge of circuits/batch-open, so the vectors are independent.
//
// Each test prints lines of this form:
//   vector|<kind>|<name>|<inputs>|<output>
// packages/crypto/scripts/collect-noir-vectors.ts reads the lines and writes
// fixtures/protocol/poseidon2.json.

mod constants;

use constants::{DOM_BATCH_ID, DOM_BINDING, DOM_COMMITMENT, DOM_LEAF, DOM_MMR_LEAF, DOM_MMR_NODE, DOM_MMR_ROOT, BATCH_UNITS_K};
use poseidon::poseidon2::Poseidon2;

global P_MINUS_ONE: Field = -1;
global TWO_POW_32: Field = 0x100000000;
global LIMB_MAX: Field = 0xffffffffffffffffffffffffffffffff;

fn h<let N: u32>(inputs: [Field; N]) -> Field {
    Poseidon2::hash(inputs, N)
}

fn emit<let N: u32, let A: u32, let B: u32>(kind: str<A>, name: str<B>, inputs: [Field; N], output: Field) {
    println(f"vector|{kind}|{name}|{inputs}|{output}");
}

fn emit_permutation<let B: u32>(name: str<B>, inputs: [Field; 4]) {
    let output = std::hash::poseidon2_permutation(inputs, 4);
    println(f"vector|permutation|{name}|{inputs}|{output}");
}

fn emit_hash<let N: u32, let B: u32>(name: str<B>, inputs: [Field; N]) {
    emit("hash", name, inputs, h(inputs));
}

#[test]
fn permutation_vectors() {
    emit_permutation("zero", [0, 0, 0, 0]);
    emit_permutation("one_to_four", [1, 2, 3, 4]);
    emit_permutation("p_minus_one", [P_MINUS_ONE, P_MINUS_ONE, P_MINUS_ONE, P_MINUS_ONE]);
}

#[test]
fn hash_vectors() {
    emit_hash("len_1", [1]);
    emit_hash("len_2", [1, 2]);
    emit_hash("len_3", [1, 2, 3]);
    emit_hash("len_4", [1, 2, 3, 4]);
    emit_hash("len_5", [1, 2, 3, 4, 5]);
    emit_hash("len_6", [1, 2, 3, 4, 5, 6]);
    emit_hash("len_7", [1, 2, 3, 4, 5, 6, 7]);
    let mut wide = [0; 34];
    for i in 0..34 {
        wide[i] = (i * 7 + 1) as Field;
    }
    emit_hash("len_34", wide);
    emit_hash("zero_1", [0]);
    emit_hash("p_minus_one_3", [P_MINUS_ONE, P_MINUS_ONE, P_MINUS_ONE]);
    emit_hash("limb_max_2", [LIMB_MAX, LIMB_MAX]);
}

// One batch case. All 32-byte values are given as [hi, lo] limbs.
fn emit_batch<let B: u32>(
    name: str<B>,
    deployment_id: [Field; 2],
    gateway_id: [Field; 2],
    k: [Field; 2],
    session_pub: [Field; 2],
    expiry: Field,
) {
    let c_in = [DOM_COMMITMENT, deployment_id[0], deployment_id[1], k[0], k[1]];
    let c = h(c_in);
    emit("commitment", name, c_in, c);
    let leaf_in = [DOM_LEAF, c, BATCH_UNITS_K, expiry];
    let leaf = h(leaf_in);
    emit("leaf", name, leaf_in, leaf);
    let id_in = [DOM_BATCH_ID, deployment_id[0], deployment_id[1], k[0], k[1]];
    emit("batch_id", name, id_in, h(id_in));
    let bind_in = [DOM_BINDING, gateway_id[0], gateway_id[1], session_pub[0], session_pub[1]];
    emit("binding", name, bind_in, h(bind_in));
    let leaf_node_in = [DOM_MMR_LEAF, leaf];
    emit("mmr_leaf", name, leaf_node_in, h(leaf_node_in));
}

#[test]
fn batch_vectors() {
    emit_batch(
        "case_a",
        [0x9f1c7b2e4d6a8053c1e2f3a4b5c6d7e8, 0x0123456789abcdeffedcba9876543210],
        [0xa1a2a3a4a5a6a7a8a9aaabacadaeafb0, 0xb1b2b3b4b5b6b7b8b9babbbcbdbebfc0],
        [0x5b0e3c2d1f4a6978e8d7c6b5a4938271, 0x00ff11ee22dd33cc44bb55aa66997788],
        // RFC 8032 test 1 public key.
        [0xd75a980182b10ab7d54bfed3c964073a, 0x0ee172f3daa62325af021a68f707511a],
        47385,
    );
    emit_batch(
        "all_ones",
        [LIMB_MAX, LIMB_MAX],
        [LIMB_MAX, LIMB_MAX],
        [LIMB_MAX, LIMB_MAX],
        [LIMB_MAX, LIMB_MAX],
        0xffffffffffffffff,
    );
    emit_batch("all_zero", [0, 0], [0, 0], [0, 0], [0, 0], 0);
}

#[test]
fn mmr_vectors() {
    let node_1_in = [DOM_MMR_NODE * TWO_POW_32 + 1, 11, 22];
    emit("mmr_node", "height_1", node_1_in, h(node_1_in));
    let node_31_in = [DOM_MMR_NODE * TWO_POW_32 + 31, P_MINUS_ONE, 0];
    emit("mmr_node", "height_31", node_31_in, h(node_31_in));
    // Root of leaf_count 5: slots of height 2 and height 0 are occupied.
    let mut root_in = [0; 34];
    root_in[0] = DOM_MMR_ROOT;
    root_in[1] = 5;
    // Input 2 + (31 - h) holds slot h.
    root_in[2 + 31 - 2] = 0x1234;
    root_in[2 + 31 - 0] = 0x5678;
    emit("mmr_root", "leaf_count_5", root_in, h(root_in));
}

// Tests of the batch-open statement.
//
// witness_vectors.nr has valid witnesses that crates/registry made from real MMRs of 1, 2, 3, 7,
// 8, and 100 leaves. Each negative test changes one value and expects the circuit to fail.

use crate::main;
use crate::witness_vectors::{
    TestWitness, tree_100_index_37, tree_1_index_0, tree_2_index_0, tree_3_index_2, tree_7_index_4,
    tree_8_index_5,
};

fn run(w: TestWitness) {
    main(
        w.circuit_id,
        w.deployment_id,
        w.gateway_id,
        w.root,
        w.leaf_count,
        w.proof_epoch,
        w.batch_id,
        w.binding,
        w.k,
        w.expiry,
        w.leaf_index,
        w.siblings,
        w.peaks,
        w.session_pub,
    );
}

// Valid witnesses.

#[test]
fn accepts_tree_of_1() {
    run(tree_1_index_0());
}

#[test]
fn accepts_tree_of_2() {
    run(tree_2_index_0());
}

#[test]
fn accepts_tree_of_3() {
    run(tree_3_index_2());
}

#[test]
fn accepts_tree_of_7() {
    run(tree_7_index_4());
}

#[test]
fn accepts_tree_of_8() {
    run(tree_8_index_5());
}

#[test]
fn accepts_tree_of_100() {
    run(tree_100_index_37());
}

#[test]
fn accepts_proof_epoch_equal_to_expiry() {
    let mut w = tree_7_index_4();
    w.proof_epoch = w.expiry;
    run(w);
}

// Changed public inputs.

#[test(should_fail_with = "root mismatch")]
fn rejects_wrong_root() {
    let mut w = tree_100_index_37();
    w.root += 1;
    run(w);
}

#[test(should_fail_with = "batch expired")]
fn rejects_expired_batch() {
    let mut w = tree_7_index_4();
    w.proof_epoch = w.expiry + 1;
    run(w);
}

#[test(should_fail_with = "batch id mismatch")]
fn rejects_wrong_batch_id() {
    let mut w = tree_7_index_4();
    w.batch_id += 1;
    run(w);
}

#[test(should_fail_with = "binding mismatch")]
fn rejects_wrong_binding() {
    let mut w = tree_7_index_4();
    w.binding += 1;
    run(w);
}

#[test(should_fail_with = "binding mismatch")]
fn rejects_binding_of_other_gateway() {
    let mut w = tree_7_index_4();
    w.gateway_id[1] += 1;
    run(w);
}

#[test(should_fail_with = "binding mismatch")]
fn rejects_other_session_key() {
    let mut w = tree_7_index_4();
    w.session_pub[0] += 1;
    run(w);
}

#[test(should_fail_with = "batch id mismatch")]
fn rejects_other_deployment() {
    let mut w = tree_7_index_4();
    w.deployment_id[0] += 1;
    run(w);
}

#[test(should_fail_with = "circuit id mismatch")]
fn rejects_wrong_circuit_id() {
    let mut w = tree_7_index_4();
    w.circuit_id += 1;
    run(w);
}

#[test(should_fail_with = "empty peak slot not zero")]
fn rejects_wrong_leaf_count() {
    let mut w = tree_7_index_4();
    w.leaf_count = 6;
    run(w);
}

#[test(should_fail_with = "root mismatch")]
fn rejects_wrong_leaf_count_with_same_peak() {
    // Leaf 5 of 8 is under the peak of height 3. Leaf count 12 also has that peak, and its
    // other occupied slot (height 2) is zero in the witness. Only the root check fails.
    let mut w = tree_8_index_5();
    w.leaf_count = 12;
    run(w);
}

#[test(should_fail)]
fn rejects_leaf_count_of_33_bits() {
    let mut w = tree_7_index_4();
    w.leaf_count += 0x100000000;
    run(w);
}

// Changed private inputs.

#[test(should_fail_with = "peak mismatch")]
fn rejects_wrong_leaf_index() {
    let mut w = tree_100_index_37();
    w.leaf_index = 36;
    run(w);
}

#[test(should_fail_with = "sibling padding not zero")]
fn rejects_wrong_leaf_index_in_other_peak() {
    let mut w = tree_7_index_4();
    w.leaf_index = 6;
    run(w);
}

#[test(should_fail_with = "leaf index not below leaf count")]
fn rejects_leaf_index_equal_to_leaf_count() {
    let mut w = tree_1_index_0();
    w.leaf_index = 1;
    run(w);
}

#[test(should_fail_with = "leaf index not below leaf count")]
fn rejects_leaf_index_above_leaf_count() {
    // Index 13 in a tree of 8: the highest different bit is 1 in the index, not in the count.
    let mut w = tree_8_index_5();
    w.leaf_index = 13;
    run(w);
}

#[test(should_fail)]
fn rejects_leaf_index_of_33_bits() {
    let mut w = tree_7_index_4();
    w.leaf_index += 0x100000000;
    run(w);
}

#[test(should_fail_with = "batch id mismatch")]
fn rejects_wrong_secret() {
    let mut w = tree_7_index_4();
    w.k[1] += 1;
    run(w);
}

#[test(should_fail_with = "peak mismatch")]
fn rejects_wrong_expiry() {
    let mut w = tree_7_index_4();
    w.expiry += 1;
    run(w);
}

#[test(should_fail_with = "peak mismatch")]
fn rejects_changed_sibling() {
    let mut w = tree_100_index_37();
    w.siblings[3] += 1;
    run(w);
}

#[test(should_fail_with = "sibling padding not zero")]
fn rejects_nonzero_sibling_padding() {
    let mut w = tree_7_index_4();
    // The leaf is under the peak of height 2. Slot 2 is padding.
    w.siblings[2] = 1;
    run(w);
}

#[test(should_fail_with = "sibling padding not zero")]
fn rejects_nonzero_last_sibling_slot() {
    let mut w = tree_100_index_37();
    w.siblings[31] = 1;
    run(w);
}

#[test(should_fail_with = "empty peak slot not zero")]
fn rejects_nonzero_empty_peak_slot() {
    let mut w = tree_7_index_4();
    // Bit 3 of 7 is 0, so slot 3 must be zero.
    w.peaks[3] = 1;
    run(w);
}

#[test(should_fail_with = "root mismatch")]
fn rejects_changed_other_peak() {
    let mut w = tree_7_index_4();
    w.peaks[0] += 1;
    run(w);
}

#[test(should_fail)]
fn rejects_limb_of_129_bits() {
    let mut w = tree_7_index_4();
    w.k[0] += 0x100000000000000000000000000000000;
    run(w);
}

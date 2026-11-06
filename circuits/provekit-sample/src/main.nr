// ProveKit feasibility sample. This is a proxy for the batch-open statement shape.
// It is not the protocol circuit. Phase 1B owns circuits/batch-open/.
//
// Statement:
// 1. The prover knows a private secret.
// 2. The public batch ID is H(TAG_ID, secret, 0).
// 3. The leaf H(TAG_LEAF, H(TAG_COMMIT, secret, 0), expiry) is in a binary Merkle tree
//    of depth DEPTH under the public root. The leaf index is private.
// 4. The public epoch is less than the private expiry.
//
// The hash H is one Poseidon2 permutation (BN254, state width 4) from the Noir standard
// library. The input state is [tag, a, b, 0]. The output is lane 0. The domain tags and
// this compression rule are sample values only. Phase 1B fixes the protocol hash rules.

global DEPTH: u32 = 16;

global TAG_COMMIT: Field = 1;
global TAG_LEAF: Field = 2;
global TAG_ID: Field = 3;
global TAG_NODE: Field = 4;

fn h(tag: Field, a: Field, b: Field) -> Field {
    let state = std::hash::poseidon2_permutation([tag, a, b, 0]);
    state[0]
}

fn leaf_of(secret: Field, expiry: u64) -> Field {
    let commitment = h(TAG_COMMIT, secret, 0);
    h(TAG_LEAF, commitment, expiry as Field)
}

fn root_of(leaf: Field, leaf_index: u32, siblings: [Field; DEPTH]) -> Field {
    // The index bits select the side at each level. The bits come from the private index,
    // so the circuit constrains the path selection.
    let bits: [bool; DEPTH] = (leaf_index as Field).to_le_bits();
    let mut node = leaf;
    for level in 0..DEPTH {
        let sibling = siblings[level];
        let is_right = bits[level];
        let (left, right) = if is_right { (sibling, node) } else { (node, sibling) };
        node = h(TAG_NODE, left, right);
    }
    node
}

fn main(
    secret: Field,
    expiry: u64,
    leaf_index: u32,
    siblings: [Field; DEPTH],
    root: pub Field,
    batch_id: pub Field,
    epoch: pub u64,
) {
    assert(h(TAG_ID, secret, 0) == batch_id, "batch id mismatch");
    let leaf = leaf_of(secret, expiry);
    assert(root_of(leaf, leaf_index, siblings) == root, "root mismatch");
    assert(epoch < expiry, "batch expired");
}

// Sample witness values. `Prover.toml` contains the same values.
global SAMPLE_SECRET: Field = 0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd;
global SAMPLE_EXPIRY: u64 = 1000;
global SAMPLE_INDEX: u32 = 0xa5c3;
global SAMPLE_EPOCH: u64 = 999;

fn sample_siblings() -> [Field; DEPTH] {
    let mut siblings = [0; DEPTH];
    for level in 0..DEPTH {
        siblings[level] = (level as Field) + 100;
    }
    siblings
}

#[test]
fn print_sample_public_inputs() {
    let siblings = sample_siblings();
    let root = root_of(leaf_of(SAMPLE_SECRET, SAMPLE_EXPIRY), SAMPLE_INDEX, siblings);
    let batch_id = h(TAG_ID, SAMPLE_SECRET, 0);
    println(root);
    println(batch_id);
    main(SAMPLE_SECRET, SAMPLE_EXPIRY, SAMPLE_INDEX, siblings, root, batch_id, SAMPLE_EPOCH);
}

#[test(should_fail_with = "batch expired")]
fn rejects_expired_batch() {
    let siblings = sample_siblings();
    let root = root_of(leaf_of(SAMPLE_SECRET, SAMPLE_EXPIRY), SAMPLE_INDEX, siblings);
    let batch_id = h(TAG_ID, SAMPLE_SECRET, 0);
    main(SAMPLE_SECRET, SAMPLE_EXPIRY, SAMPLE_INDEX, siblings, root, batch_id, SAMPLE_EXPIRY);
}

#[test(should_fail_with = "root mismatch")]
fn rejects_wrong_index() {
    let siblings = sample_siblings();
    let root = root_of(leaf_of(SAMPLE_SECRET, SAMPLE_EXPIRY), SAMPLE_INDEX, siblings);
    let batch_id = h(TAG_ID, SAMPLE_SECRET, 0);
    main(SAMPLE_SECRET, SAMPLE_EXPIRY, SAMPLE_INDEX + 1, siblings, root, batch_id, SAMPLE_EPOCH);
}

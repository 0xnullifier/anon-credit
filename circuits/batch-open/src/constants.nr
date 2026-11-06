// Generated from fixtures/protocol/domains.json and fixtures/protocol/poseidon2-params.json.
// Do not edit. Run `node packages/crypto/scripts/generate-constants.ts`.
// The Poseidon2 round constants are not here: std::hash::poseidon2_permutation has them.

// Domain tag "anon-credit/v1/commitment". Use: c = H(DOM_COMMITMENT, deployment_id_hi, deployment_id_lo, k_hi, k_lo)
pub global DOM_COMMITMENT: Field = 0x00000000000000616e6f6e2d6372656469742f76312f636f6d6d69746d656e74;

// Domain tag "anon-credit/v1/leaf". Use: leaf = H(DOM_LEAF, c, K, expiry)
pub global DOM_LEAF: Field = 0x00000000000000000000000000616e6f6e2d6372656469742f76312f6c656166;

// Domain tag "anon-credit/v1/batch-id". Use: batch_id = H(DOM_BATCH_ID, deployment_id_hi, deployment_id_lo, k_hi, k_lo)
pub global DOM_BATCH_ID: Field = 0x000000000000000000616e6f6e2d6372656469742f76312f62617463682d6964;

// Domain tag "anon-credit/v1/binding". Use: binding = H(DOM_BINDING, gateway_id_hi, gateway_id_lo, session_pub_hi, session_pub_lo)
pub global DOM_BINDING: Field = 0x00000000000000000000616e6f6e2d6372656469742f76312f62696e64696e67;

// Domain tag "anon-credit/v1/mmr-leaf". Use: leaf_node = H(DOM_MMR_LEAF, leaf)
pub global DOM_MMR_LEAF: Field = 0x000000000000000000616e6f6e2d6372656469742f76312f6d6d722d6c656166;

// Domain tag "anon-credit/v1/mmr-node". Use: node = H(DOM_MMR_NODE * 2^32 + height, left, right); height is the parent height
pub global DOM_MMR_NODE: Field = 0x000000000000000000616e6f6e2d6372656469742f76312f6d6d722d6e6f6465;

// Domain tag "anon-credit/v1/mmr-root". Use: root = H(DOM_MMR_ROOT, leaf_count, slot[31], slot[30], ..., slot[0])
pub global DOM_MMR_ROOT: Field = 0x000000000000000000616e6f6e2d6372656469742f76312f6d6d722d726f6f74;

// Circuit ID "anon-credit/v1/batch-open".
pub global CIRCUIT_ID: Field = 0x00000000000000616e6f6e2d6372656469742f76312f62617463682d6f70656e;

// Units in one batch (K).
pub global BATCH_UNITS_K: Field = 100;

// Sibling slots in the membership witness.
pub global MAX_HEIGHT: u32 = 32;

// Peak slots in the root witness. Slot h holds the peak of height h.
pub global MAX_PEAKS: u32 = 32;

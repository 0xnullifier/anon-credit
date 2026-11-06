// Poseidon2 circuit hash over the BN254 scalar field.
//
// `hash` is the same function as `Poseidon2::hash(inputs, N)` of the Noir standard library
// sponge (in Noir 1.0.0-beta.26 the sponge is private to the standard library; the public copy
// is the package noir-lang/poseidon v0.4.0). hash_vectors.nr checks it against the
// reference vectors in fixtures/protocol/poseidon2.json.
//
// Sponge: state [0, 0, 0, N * 2^64], rate 3, capacity 1. Absorb the inputs into a cache of 3.
// When the cache is full and one more input comes, add the cache to state words 0..3 and
// apply the permutation. To squeeze, add the (zero-padded) cache, apply the permutation, and
// return word 0.

global TWO_POW_64: Field = 18446744073709551616;

// The width-4 Poseidon2 permutation. This is the only call to the black box.
// In Noir 1.0.0-beta.26 the black box takes only the state. The compiler checks that the
// length is the state size of the backend (4 for BN254).
// If a later Noir version changes the black-box signature, change only this function.
pub fn permute(state: [Field; 4]) -> [Field; 4] {
    std::hash::poseidon2_permutation(state)
}

// Fixed-length Poseidon2 sponge hash of N inputs.
pub fn hash<let N: u32>(inputs: [Field; N]) -> Field {
    let mut state: [Field; 4] = [0, 0, 0, (N as Field) * TWO_POW_64];
    let mut cache: [Field; 3] = [0, 0, 0];
    let mut cache_size: u32 = 0;
    for i in 0..N {
        if cache_size == 3 {
            for j in 0..3 {
                state[j] += cache[j];
            }
            state = permute(state);
            cache = [inputs[i], 0, 0];
            cache_size = 1;
        } else {
            cache[cache_size] = inputs[i];
            cache_size += 1;
        }
    }
    // The cache words at or above cache_size are zero. Thus this adds the zero-padded cache.
    for j in 0..3 {
        state[j] += cache[j];
    }
    permute(state)[0]
}

//! Poseidon2 circuit hash over the BN254 scalar field.
//!
//! This is the same hash as the Noir function `Poseidon2::hash(inputs, inputs.len())` in the
//! Noir standard library (`std::hash::poseidon2`, now in the package `noir-lang/poseidon`).
//! ProveKit compiles Noir, so this is the hash that the circuit uses.
//!
//! Permutation (`poseidon2_permutation`, width `t = 4`):
//!
//! - S-box `x^5`. 8 full rounds (4 before and 4 after) and 56 partial rounds.
//! - External matrix: the 4x4 matrix of the Poseidon2 paper (Barretenberg form).
//! - Internal matrix: `diag(D) + J`. `D` is the internal matrix diagonal.
//! - The constants are in `constants.rs`. They come from `fixtures/protocol/poseidon2-params.json`,
//!   which is a copy of the Noir ACVM black-box solver constants (Noir v1.0.0-beta.12).
//!
//! Sponge (`hash`, fixed length `n`):
//!
//! - State `[0, 0, 0, n * 2^64]`. Rate 3, capacity 1.
//! - Absorb the inputs in order into a cache of 3. When the cache is full and one more input
//!   comes, add the cache to state words 0..3 and apply the permutation.
//! - Squeeze: add the cache (zero-padded) to the state, apply the permutation, and return word 0.
//!
//! Thus a hash of `n` inputs uses `max(1, ceil(n / 3))` permutations.

use crate::constants::{INTERNAL_MATRIX_DIAGONAL, ROUND_CONSTANTS};
use crate::field::FieldElement;
use ark_bn254::Fr;
use ark_ff::{AdditiveGroup, Field};

/// Permutation width.
pub const WIDTH: usize = 4;
/// Sponge rate.
pub const RATE: usize = 3;
const ROUNDS_F: usize = 8;
const ROUNDS_P: usize = 56;

fn sbox(x: Fr) -> Fr {
    let x2 = x.square();
    x2.square() * x
}

/// External 4x4 matrix. The same addition chain as Barretenberg and the Noir solver.
fn external_matrix(s: &mut [Fr; WIDTH]) {
    let t0 = s[0] + s[1];
    let t1 = s[2] + s[3];
    let t2 = s[1].double() + t1;
    let t3 = s[3].double() + t0;
    let t4 = t1.double().double() + t3;
    let t5 = t0.double().double() + t2;
    let t6 = t3 + t5;
    let t7 = t2 + t4;
    *s = [t6, t5, t7, t4];
}

fn internal_matrix(s: &mut [Fr; WIDTH]) {
    let sum = s[0] + s[1] + s[2] + s[3];
    for (value, diagonal) in s.iter_mut().zip(INTERNAL_MATRIX_DIAGONAL) {
        *value = *value * diagonal + sum;
    }
}

fn permute_fr(state: &mut [Fr; WIDTH]) {
    external_matrix(state);
    let half = ROUNDS_F / 2;
    for constants in &ROUND_CONSTANTS[..half] {
        for (value, constant) in state.iter_mut().zip(constants) {
            *value = sbox(*value + constant);
        }
        external_matrix(state);
    }
    for constants in &ROUND_CONSTANTS[half..half + ROUNDS_P] {
        state[0] = sbox(state[0] + constants[0]);
        internal_matrix(state);
    }
    for constants in &ROUND_CONSTANTS[half + ROUNDS_P..] {
        for (value, constant) in state.iter_mut().zip(constants) {
            *value = sbox(*value + constant);
        }
        external_matrix(state);
    }
}

/// The Poseidon2 permutation of width 4. Equal to Noir `std::hash::poseidon2_permutation(state, 4)`.
pub fn permutation(state: [FieldElement; WIDTH]) -> [FieldElement; WIDTH] {
    let mut inner = state.map(FieldElement::fr);
    permute_fr(&mut inner);
    inner.map(FieldElement::from_fr)
}

/// Poseidon2 sponge hash of a fixed-length input. Equal to Noir `Poseidon2::hash(inputs, n)`.
pub fn hash(inputs: &[FieldElement]) -> FieldElement {
    let two_pow_64 = Fr::from(1u128 << 64);
    let length = Fr::from(inputs.len() as u64);
    let mut state = [
        Fr::from(0u64),
        Fr::from(0u64),
        Fr::from(0u64),
        length * two_pow_64,
    ];
    let mut cache = [Fr::from(0u64); RATE];
    let mut cache_size = 0usize;
    for input in inputs {
        if cache_size == RATE {
            for (value, cached) in state.iter_mut().zip(cache) {
                *value += cached;
            }
            permute_fr(&mut state);
            cache = [input.fr(), Fr::from(0u64), Fr::from(0u64)];
            cache_size = 1;
        } else {
            cache[cache_size] = input.fr();
            cache_size += 1;
        }
    }
    // Words of the cache at or above cache_size are zero, so this adds the zero-padded cache.
    for (value, cached) in state.iter_mut().zip(cache) {
        *value += cached;
    }
    permute_fr(&mut state);
    FieldElement::from_fr(state[0])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fe(text: &str) -> FieldElement {
        FieldElement::from_hex(text).unwrap_or_default()
    }

    #[test]
    fn constants_match_params_fixture() {
        #[derive(serde::Deserialize)]
        struct Params {
            rounds_f: usize,
            rounds_p: usize,
            internal_matrix_diagonal: [FieldElement; 4],
            round_constants: Vec<[FieldElement; 4]>,
        }
        let text = include_str!("../../../fixtures/protocol/poseidon2-params.json");
        let params: Result<Params, _> = serde_json::from_str(text);
        assert!(params.is_ok());
        let Ok(params) = params else { return };
        assert_eq!((params.rounds_f, params.rounds_p), (ROUNDS_F, ROUNDS_P));
        assert_eq!(
            params.internal_matrix_diagonal,
            INTERNAL_MATRIX_DIAGONAL.map(FieldElement::from_fr)
        );
        let constants: Vec<[FieldElement; 4]> = ROUND_CONSTANTS
            .iter()
            .map(|row| row.map(FieldElement::from_fr))
            .collect();
        assert_eq!(params.round_constants, constants);
    }

    #[test]
    fn permutation_of_zero_matches_noir_solver_vector() {
        let out = permutation([FieldElement::ZERO; 4]);
        assert_eq!(
            out,
            [
                fe("0x18dfb8dc9b82229cff974efefc8df78b1ce96d9d844236b496785c698bc6732e"),
                fe("0x095c230d1d37a246e8d2d5a63b165fe0fade040d442f61e25f0590e5fb76f839"),
                fe("0x0bb9545846e1afa4fa3c97414a60a20fc4949f537a68cceca34c5ce71e28aa59"),
                fe("0x18a4f34c9c6f99335ff7638b82aeed9018026618358873c982bbdde265b2ed6d"),
            ]
        );
    }

    #[test]
    fn hash_of_one_to_four_matches_noir_solver_vector() {
        let inputs = [1u64, 2, 3, 4].map(FieldElement::from_u64);
        assert_eq!(
            hash(&inputs),
            fe("0x130bf204a32cac1f0ace56c78b731aa3809f06df2731ebcf6b3464a15788b1b9")
        );
    }
}

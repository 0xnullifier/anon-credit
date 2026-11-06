// Poseidon2 circuit hash over the BN254 scalar field.
//
// The same hash as the Noir function Poseidon2::hash(inputs, inputs.length) and as
// crates/crypto/src/poseidon2.rs. See that file for the full definition.
// Permutation: width 4, S-box x^5, 8 full rounds and 56 partial rounds. The constants are in
// constants.generated.ts, generated from fixtures/protocol/poseidon2-params.json.
// Sponge: state [0, 0, 0, n * 2^64], rate 3. Squeeze returns state word 0.

import { INTERNAL_MATRIX_DIAGONAL, ROUND_CONSTANTS } from "./constants.generated.ts";
import { FIELD_MODULUS, fieldAdd, fieldMul, requireField } from "./field.ts";

export type State = [bigint, bigint, bigint, bigint];

const ROUNDS_F = 8;
const ROUNDS_P = 56;
const TWO_POW_64 = 1n << 64n;

function sbox(x: bigint): bigint {
  const x2 = fieldMul(x, x);
  return fieldMul(fieldMul(x2, x2), x);
}

function externalMatrix(s: State): State {
  const t0 = fieldAdd(s[0], s[1]);
  const t1 = fieldAdd(s[2], s[3]);
  const t2 = fieldAdd(fieldAdd(s[1], s[1]), t1);
  const t3 = fieldAdd(fieldAdd(s[3], s[3]), t0);
  const t4 = (4n * t1 + t3) % FIELD_MODULUS;
  const t5 = (4n * t0 + t2) % FIELD_MODULUS;
  const t6 = fieldAdd(t3, t5);
  const t7 = fieldAdd(t2, t4);
  return [t6, t5, t7, t4];
}

function diagonal(index: number): bigint {
  const value = INTERNAL_MATRIX_DIAGONAL[index];
  if (value === undefined) {
    throw new RangeError("internal matrix diagonal is incomplete");
  }
  return value;
}

function internalMatrix(s: State): State {
  const sum = (s[0] + s[1] + s[2] + s[3]) % FIELD_MODULUS;
  return [
    fieldAdd(fieldMul(s[0], diagonal(0)), sum),
    fieldAdd(fieldMul(s[1], diagonal(1)), sum),
    fieldAdd(fieldMul(s[2], diagonal(2)), sum),
    fieldAdd(fieldMul(s[3], diagonal(3)), sum),
  ];
}

function roundConstants(round: number): readonly bigint[] {
  const row = ROUND_CONSTANTS[round];
  if (row === undefined || row.length !== 4) {
    throw new RangeError("round constants are incomplete");
  }
  return row;
}

function constant(row: readonly bigint[], index: number): bigint {
  return row[index] ?? 0n;
}

function fullRound(s: State, round: number): State {
  const c = roundConstants(round);
  return externalMatrix([
    sbox(fieldAdd(s[0], constant(c, 0))),
    sbox(fieldAdd(s[1], constant(c, 1))),
    sbox(fieldAdd(s[2], constant(c, 2))),
    sbox(fieldAdd(s[3], constant(c, 3))),
  ]);
}

// The Poseidon2 permutation of width 4. Equal to Noir std::hash::poseidon2_permutation(state, 4).
export function permutation(input: readonly [bigint, bigint, bigint, bigint]): State {
  for (const value of input) {
    requireField(value, "permutation input");
  }
  let s = externalMatrix([input[0], input[1], input[2], input[3]]);
  const half = ROUNDS_F / 2;
  for (let round = 0; round < half; round += 1) {
    s = fullRound(s, round);
  }
  for (let round = half; round < half + ROUNDS_P; round += 1) {
    s = internalMatrix([sbox(fieldAdd(s[0], constant(roundConstants(round), 0))), s[1], s[2], s[3]]);
  }
  for (let round = half + ROUNDS_P; round < ROUNDS_F + ROUNDS_P; round += 1) {
    s = fullRound(s, round);
  }
  return s;
}

// Poseidon2 sponge hash of a fixed-length input. Equal to Noir Poseidon2::hash(inputs, n).
export function hash(inputs: readonly bigint[]): bigint {
  let state: State = [0n, 0n, 0n, (BigInt(inputs.length) * TWO_POW_64) % FIELD_MODULUS];
  let cache: [bigint, bigint, bigint] = [0n, 0n, 0n];
  let cacheSize = 0;
  for (const input of inputs) {
    requireField(input, "hash input");
    if (cacheSize === 3) {
      state = permutation([
        fieldAdd(state[0], cache[0]),
        fieldAdd(state[1], cache[1]),
        fieldAdd(state[2], cache[2]),
        state[3],
      ]);
      cache = [input, 0n, 0n];
      cacheSize = 1;
    } else {
      cache[cacheSize] = input;
      cacheSize += 1;
    }
  }
  // Words of the cache at or above cacheSize are zero, so this adds the zero-padded cache.
  return permutation([fieldAdd(state[0], cache[0]), fieldAdd(state[1], cache[1]), fieldAdd(state[2], cache[2]), state[3]])[0];
}

// Read the reference vectors that fixtures/protocol/noir-vectors prints, and render
// fixtures/protocol/poseidon2.json and the circuit hash test file from them.

import { z } from "zod";
import { fieldHexText } from "./fixtures.ts";
import { FixtureError } from "./constants.ts";

export const POSEIDON2_FIXTURE_PATH = "fixtures/protocol/poseidon2.json";
export const CIRCUIT_HASH_TESTS_PATH = "circuits/batch-open/src/hash_vectors.nr";

const BN254_MODULUS = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;

export interface RawVector {
  readonly kind: string;
  readonly name: string;
  readonly inputs: readonly bigint[];
  readonly outputs: readonly bigint[];
}

function parseFieldList(text: string): bigint[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((part) => parseField(part));
  }
  return [parseField(trimmed)];
}

function parseField(text: string): bigint {
  const trimmed = text.trim();
  if (!/^0x[0-9a-f]+$/.test(trimmed)) {
    throw new FixtureError(`not a Noir field print: ${trimmed}`);
  }
  const value = BigInt(trimmed);
  if (value >= BN254_MODULUS) {
    throw new FixtureError(`field value out of range: ${trimmed}`);
  }
  return value;
}

// Parse the lines `vector|<kind>|<name>|<inputs>|<output>` of `nargo test --show-output`.
export function parseNargoOutput(output: string): RawVector[] {
  const vectors: RawVector[] = [];
  for (const line of output.split("\n")) {
    if (!line.startsWith("vector|")) {
      continue;
    }
    const parts = line.split("|");
    const [, kind, name, inputs, outputs] = parts;
    if (parts.length !== 5 || kind === undefined || name === undefined || inputs === undefined || outputs === undefined) {
      throw new FixtureError(`bad vector line: ${line}`);
    }
    vectors.push({ kind, name, inputs: parseFieldList(inputs), outputs: parseFieldList(outputs) });
  }
  return vectors;
}

export function fieldHex(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function limbHex(value: bigint): string {
  return value.toString(16).padStart(32, "0");
}

function bytes32Hex(hi: bigint, lo: bigint): string {
  return `0x${limbHex(hi)}${limbHex(lo)}`;
}

const vectorSchema = z.strictObject({ name: z.string(), inputs: z.array(fieldHexText), output: fieldHexText });

export const poseidon2FixtureSchema = z.strictObject({
  description: z.string(),
  generated_by: z.string(),
  permutation: z.array(
    z.strictObject({ name: z.string(), input: z.array(fieldHexText).length(4), output: z.array(fieldHexText).length(4) }),
  ),
  hash: z.array(vectorSchema).min(1),
  constructions: z.array(z.strictObject({ kind: z.string(), name: z.string(), inputs: z.array(fieldHexText), output: fieldHexText })),
  batch_cases: z.array(
    z.strictObject({
      name: z.string(),
      deployment_id: z.string().regex(/^0x[0-9a-f]{64}$/),
      gateway_id: z.string().regex(/^0x[0-9a-f]{64}$/),
      k: z.string().regex(/^0x[0-9a-f]{64}$/),
      session_pub: z.string().regex(/^0x[0-9a-f]{64}$/),
      expiry: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
      expected: z.strictObject({
        commitment: fieldHexText,
        leaf: fieldHexText,
        batch_id: fieldHexText,
        binding: fieldHexText,
        mmr_leaf_node: fieldHexText,
      }),
    }),
  ),
  encoding: z.strictObject({
    limbs: z.array(z.strictObject({ bytes: z.string(), hi: fieldHexText, lo: fieldHexText })),
    field_accept: z.array(z.strictObject({ wire: z.string(), value: z.string() })),
    field_reject: z.array(z.strictObject({ wire: z.string(), reason: z.string() })),
  }),
});

export type Poseidon2Fixture = z.infer<typeof poseidon2FixtureSchema>;

function single(vectors: readonly RawVector[], kind: string, name: string): RawVector {
  const found = vectors.filter((vector) => vector.kind === kind && vector.name === name);
  const [first] = found;
  if (found.length !== 1 || first === undefined) {
    throw new FixtureError(`expected one ${kind} vector named ${name}, found ${found.length}`);
  }
  return first;
}

function at(values: readonly bigint[], index: number): bigint {
  const value = values[index];
  if (value === undefined) {
    throw new FixtureError(`missing input ${index}`);
  }
  return value;
}

function onlyOutput(vector: RawVector): string {
  const [first] = vector.outputs;
  if (vector.outputs.length !== 1 || first === undefined) {
    throw new FixtureError(`${vector.kind} ${vector.name} must have one output`);
  }
  return fieldHex(first);
}

const CONSTRUCTION_KINDS = ["commitment", "leaf", "batch_id", "binding", "mmr_leaf", "mmr_node", "mmr_root"];

// Encoding cases. The expected values follow directly from the rules in
// implementation.md section 8: two big-endian 128-bit limbs, and canonical big-endian fields.
function encodingCases(): Poseidon2Fixture["encoding"] {
  const limbBytes = [
    "0x0000000000000000000000000000000000000000000000000000000000000000",
    "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    "0x0100000000000000000000000000000000000000000000000000000000000002",
    "0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
  ];
  return {
    limbs: limbBytes.map((bytes) => ({
      bytes,
      hi: fieldHex(BigInt(`0x${bytes.slice(2, 34)}`)),
      lo: fieldHex(BigInt(`0x${bytes.slice(34)}`)),
    })),
    field_accept: [
      { wire: fieldHex(0n), value: "0" },
      { wire: fieldHex(BN254_MODULUS - 1n), value: (BN254_MODULUS - 1n).toString() },
    ],
    field_reject: [
      { wire: fieldHex(BN254_MODULUS), reason: "out_of_range" },
      { wire: fieldHex((1n << 256n) - 1n), reason: "out_of_range" },
      { wire: "0x30644E72E131A029B85045B68181585D2833E84879B9709143E1F593F0000000", reason: "bad_hex" },
      { wire: "0x01", reason: "bad_hex" },
      { wire: "30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000000", reason: "bad_hex" },
    ],
  };
}

export function buildFixture(vectors: readonly RawVector[]): Poseidon2Fixture {
  const permutation = vectors
    .filter((vector) => vector.kind === "permutation")
    .map((vector) => ({ name: vector.name, input: vector.inputs.map(fieldHex), output: vector.outputs.map(fieldHex) }));
  const hash = vectors
    .filter((vector) => vector.kind === "hash")
    .map((vector) => ({ name: vector.name, inputs: vector.inputs.map(fieldHex), output: onlyOutput(vector) }));
  const constructions = CONSTRUCTION_KINDS.flatMap((kind) =>
    vectors
      .filter((vector) => vector.kind === kind)
      .map((vector) => ({ kind, name: vector.name, inputs: vector.inputs.map(fieldHex), output: onlyOutput(vector) })),
  );
  const caseNames = vectors.filter((vector) => vector.kind === "commitment").map((vector) => vector.name);
  const batchCases = caseNames.map((name) => {
    const commitment = single(vectors, "commitment", name);
    const leaf = single(vectors, "leaf", name);
    const binding = single(vectors, "binding", name);
    return {
      name,
      deployment_id: bytes32Hex(at(commitment.inputs, 1), at(commitment.inputs, 2)),
      gateway_id: bytes32Hex(at(binding.inputs, 1), at(binding.inputs, 2)),
      k: bytes32Hex(at(commitment.inputs, 3), at(commitment.inputs, 4)),
      session_pub: bytes32Hex(at(binding.inputs, 3), at(binding.inputs, 4)),
      expiry: at(leaf.inputs, 3).toString(10),
      expected: {
        commitment: onlyOutput(commitment),
        leaf: onlyOutput(leaf),
        batch_id: onlyOutput(single(vectors, "batch_id", name)),
        binding: onlyOutput(binding),
        mmr_leaf_node: onlyOutput(single(vectors, "mmr_leaf", name)),
      },
    };
  });
  return poseidon2FixtureSchema.parse({
    description:
      "Poseidon2 (BN254, t = 4, rate 3) reference vectors. Outputs come from Noir: nargo test --show-output in fixtures/protocol/noir-vectors, which uses Poseidon2::hash of noir-lang/poseidon v0.4.0 (the public copy of the Noir standard library sponge) and std::hash::poseidon2_permutation. Rust, TypeScript, and the batch-open circuit check these values. Byte values are big-endian. 32-byte values enter the circuit as [hi, lo] 128-bit limbs.",
    generated_by: "node packages/crypto/scripts/collect-noir-vectors.ts (nargo 1.0.0-beta.26)",
    permutation,
    hash,
    constructions,
    batch_cases: batchCases,
    encoding: encodingCases(),
  });
}

function noirArray(values: readonly string[]): string {
  return `[${values.join(", ")}]`;
}

// Render the circuit test file. Each test checks the circuit sponge against one reference vector.
export function renderCircuitHashTests(fixture: Poseidon2Fixture): string {
  const lines: string[] = [];
  lines.push(`// Generated from ${POSEIDON2_FIXTURE_PATH}.`);
  lines.push("// Do not edit. Run `node packages/crypto/scripts/collect-noir-vectors.ts`.");
  lines.push("// These tests check the circuit sponge against the reference Noir vectors.");
  lines.push("");
  lines.push("use crate::hash::{hash, permute};");
  lines.push("");
  for (const vector of fixture.permutation) {
    lines.push("#[test]");
    lines.push(`fn permutation_${vector.name}() {`);
    lines.push(`    assert(permute(${noirArray(vector.input)}) == ${noirArray(vector.output)});`);
    lines.push("}");
    lines.push("");
  }
  const hashVectors = [
    ...fixture.hash.map((vector) => ({ name: `hash_${vector.name}`, inputs: vector.inputs, output: vector.output })),
    ...fixture.constructions.map((vector) => ({
      name: `${vector.kind}_${vector.name}`,
      inputs: vector.inputs,
      output: vector.output,
    })),
  ];
  for (const vector of hashVectors) {
    lines.push("#[test]");
    lines.push(`fn ${vector.name}() {`);
    lines.push(`    assert(hash(${noirArray(vector.inputs)}) == ${vector.output});`);
    lines.push("}");
    lines.push("");
  }
  return lines.join("\n");
}

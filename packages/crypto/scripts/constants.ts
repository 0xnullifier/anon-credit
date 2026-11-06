// Generator of the circuit constant files for Rust, TypeScript, and Noir.
//
// Input: fixtures/protocol/domains.json and fixtures/protocol/poseidon2-params.json.
// Output: one constants file for each language. The files have a "generated" header.
//
// Run `node packages/crypto/scripts/generate-constants.ts` to write the files.
// The test constants.test.ts renders the files again and compares them with the files on disk.

import { readFileSync } from "node:fs";
import { asciiToBigInt, domainsSchema, poseidon2ParamsSchema } from "./fixtures.ts";
import type { Domains, Poseidon2Params } from "./fixtures.ts";

// Repository root, from the location of this file.
export const REPO_ROOT = new URL("../../../", import.meta.url);

export const OUTPUT_PATHS: {
  readonly rust: string;
  readonly typescript: string;
  readonly noirCircuit: string;
  readonly noirVectors: string;
} = {
  rust: "crates/crypto/src/constants.rs",
  typescript: "packages/crypto/src/constants.generated.ts",
  noirCircuit: "circuits/batch-open/src/constants.nr",
  noirVectors: "fixtures/protocol/noir-vectors/src/constants.nr",
};

const HEADER_SOURCE = "fixtures/protocol/domains.json and fixtures/protocol/poseidon2-params.json";

export function readRepoFile(path: string): string {
  return readFileSync(new URL(path, REPO_ROOT), "utf8");
}

export function loadDomains(): Domains {
  return domainsSchema.parse(JSON.parse(readRepoFile("fixtures/protocol/domains.json")));
}

export function loadParams(): Poseidon2Params {
  return poseidon2ParamsSchema.parse(JSON.parse(readRepoFile("fixtures/protocol/poseidon2-params.json")));
}

// Error for a fixture that breaks a rule of the encoding.
export class FixtureError extends Error {
  override readonly name = "FixtureError";
}

const BN254_MODULUS = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;

// Check the rules that the schemas cannot express.
export function checkFixtures(domains: Domains, params: Poseidon2Params): void {
  if (BigInt(domains.field_modulus) !== BN254_MODULUS || BigInt(params.field_modulus) !== BN254_MODULUS) {
    throw new FixtureError("field modulus is not the BN254 scalar field modulus");
  }
  const names = new Set<string>();
  const values = new Set<bigint>();
  for (const tag of domains.tags) {
    if (BigInt(tag.value) !== asciiToBigInt(tag.text)) {
      throw new FixtureError(`tag ${tag.name}: value is not the big-endian integer of its text`);
    }
    names.add(tag.name);
    values.add(BigInt(tag.value));
  }
  if (names.size !== domains.tags.length || values.size !== domains.tags.length) {
    throw new FixtureError("tag names and tag values must be distinct");
  }
  if (BigInt(domains.circuit_id.value) !== asciiToBigInt(domains.circuit_id.text)) {
    throw new FixtureError("circuit_id value is not the big-endian integer of its text");
  }
  for (const row of params.round_constants) {
    for (const value of row) {
      if (BigInt(value) >= BN254_MODULUS) {
        throw new FixtureError("round constant is not less than the field modulus");
      }
    }
  }
}

function tagConstName(name: string): string {
  return `DOM_${name.toUpperCase()}`;
}

function decimal(hex: string): string {
  return BigInt(hex).toString(10);
}

export function renderRust(domains: Domains, params: Poseidon2Params): string {
  const lines: string[] = [];
  lines.push(`//! Generated from ${HEADER_SOURCE}.`);
  lines.push("//! Do not edit. Run `node packages/crypto/scripts/generate-constants.ts`.");
  lines.push("");
  lines.push("use crate::field::FieldElement;");
  lines.push("use ark_bn254::Fr;");
  lines.push("use ark_ff::MontFp;");
  lines.push("");
  lines.push("/// Poseidon2 internal matrix diagonal (width 4).");
  lines.push("pub(crate) const INTERNAL_MATRIX_DIAGONAL: [Fr; 4] = [");
  for (const value of params.internal_matrix_diagonal) {
    lines.push(`    MontFp!("${decimal(value)}"),`);
  }
  lines.push("];");
  lines.push("");
  lines.push("/// Poseidon2 round constants: 8 full rounds and 56 partial rounds, 4 values each.");
  lines.push("pub(crate) const ROUND_CONSTANTS: [[Fr; 4]; 64] = [");
  for (const row of params.round_constants) {
    lines.push("    [");
    for (const value of row) {
      lines.push(`        MontFp!("${decimal(value)}"),`);
    }
    lines.push("    ],");
  }
  lines.push("];");
  lines.push("");
  for (const tag of domains.tags) {
    lines.push(`/// Domain tag \`${tag.text}\`. Use: \`${tag.use}\`.`);
    lines.push(`pub const ${tagConstName(tag.name)}: FieldElement = FieldElement::from_fr(MontFp!("${decimal(tag.value)}"));`);
    lines.push("");
  }
  lines.push(`/// Circuit ID \`${domains.circuit_id.text}\`. ${domains.circuit_id.use}`);
  lines.push(`pub const CIRCUIT_ID: FieldElement = FieldElement::from_fr(MontFp!("${decimal(domains.circuit_id.value)}"));`);
  lines.push("");
  lines.push("/// All domain tags as (name, text, value), in fixture order.");
  lines.push(`pub const DOMAIN_TAGS: [(&str, &str, FieldElement); ${domains.tags.length}] = [`);
  for (const tag of domains.tags) {
    lines.push(`    ("${tag.name}", "${tag.text}", ${tagConstName(tag.name)}),`);
  }
  lines.push("];");
  lines.push("");
  lines.push("/// Units in one batch (`K`). The circuit has the same constant.");
  lines.push(`pub const BATCH_UNITS_K: u64 = ${domains.constants.batch_units_k};`);
  lines.push("");
  lines.push("/// Sibling slots in the circuit membership witness.");
  lines.push(`pub const MAX_HEIGHT: usize = ${domains.constants.max_height};`);
  lines.push("");
  lines.push("/// Peak slots in the circuit root witness. Slot `h` holds the peak of height `h`.");
  lines.push(`pub const MAX_PEAKS: usize = ${domains.constants.max_peaks};`);
  lines.push("");
  lines.push("/// Maximum leaf count of one MMR (`2^32 - 1`).");
  lines.push(`pub const MAX_LEAVES: u32 = ${domains.constants.max_leaves};`);
  lines.push("");
  return lines.join("\n");
}

export function renderTypeScript(domains: Domains, params: Poseidon2Params): string {
  const lines: string[] = [];
  lines.push(`// Generated from ${HEADER_SOURCE}.`);
  lines.push("// Do not edit. Run `node packages/crypto/scripts/generate-constants.ts`.");
  lines.push("");
  lines.push("// Poseidon2 internal matrix diagonal (width 4).");
  lines.push("export const INTERNAL_MATRIX_DIAGONAL: readonly bigint[] = [");
  for (const value of params.internal_matrix_diagonal) {
    lines.push(`  ${value}n,`);
  }
  lines.push("];");
  lines.push("");
  lines.push("// Poseidon2 round constants: 8 full rounds and 56 partial rounds, 4 values each.");
  lines.push("export const ROUND_CONSTANTS: readonly (readonly bigint[])[] = [");
  for (const row of params.round_constants) {
    lines.push(`  [${row.map((value) => `${value}n`).join(", ")}],`);
  }
  lines.push("];");
  lines.push("");
  for (const tag of domains.tags) {
    lines.push(`// Domain tag "${tag.text}". Use: ${tag.use}`);
    lines.push(`export const ${tagConstName(tag.name)} = ${tag.value}n;`);
    lines.push("");
  }
  lines.push(`// Circuit ID "${domains.circuit_id.text}". ${domains.circuit_id.use}`);
  lines.push(`export const CIRCUIT_ID = ${domains.circuit_id.value}n;`);
  lines.push("");
  lines.push("// All domain tags as (name, text, value), in fixture order.");
  lines.push("export const DOMAIN_TAGS: readonly { readonly name: string; readonly text: string; readonly value: bigint }[] = [");
  for (const tag of domains.tags) {
    lines.push(`  { name: "${tag.name}", text: "${tag.text}", value: ${tagConstName(tag.name)} },`);
  }
  lines.push("];");
  lines.push("");
  lines.push("// Units in one batch (K). The circuit has the same constant.");
  lines.push(`export const BATCH_UNITS_K = ${domains.constants.batch_units_k}n;`);
  lines.push("// Sibling slots in the circuit membership witness.");
  lines.push(`export const MAX_HEIGHT = ${domains.constants.max_height};`);
  lines.push("// Peak slots in the circuit root witness. Slot h holds the peak of height h.");
  lines.push(`export const MAX_PEAKS = ${domains.constants.max_peaks};`);
  lines.push("// Maximum leaf count of one MMR (2^32 - 1).");
  lines.push(`export const MAX_LEAVES = ${domains.constants.max_leaves};`);
  lines.push("");
  return lines.join("\n");
}

export function renderNoir(domains: Domains): string {
  const lines: string[] = [];
  lines.push(`// Generated from ${HEADER_SOURCE}.`);
  lines.push("// Do not edit. Run `node packages/crypto/scripts/generate-constants.ts`.");
  lines.push("// The Poseidon2 round constants are not here: std::hash::poseidon2_permutation has them.");
  lines.push("");
  for (const tag of domains.tags) {
    lines.push(`// Domain tag "${tag.text}". Use: ${tag.use}`);
    lines.push(`pub global ${tagConstName(tag.name)}: Field = ${tag.value};`);
    lines.push("");
  }
  lines.push(`// Circuit ID "${domains.circuit_id.text}".`);
  lines.push(`pub global CIRCUIT_ID: Field = ${domains.circuit_id.value};`);
  lines.push("");
  lines.push("// Units in one batch (K).");
  lines.push(`pub global BATCH_UNITS_K: Field = ${domains.constants.batch_units_k};`);
  lines.push("");
  lines.push("// Sibling slots in the membership witness.");
  lines.push(`pub global MAX_HEIGHT: u32 = ${domains.constants.max_height};`);
  lines.push("");
  lines.push("// Peak slots in the root witness. Slot h holds the peak of height h.");
  lines.push(`pub global MAX_PEAKS: u32 = ${domains.constants.max_peaks};`);
  lines.push("");
  return lines.join("\n");
}

// Render all output files. Key: repository-relative path. Value: file text.
export function renderAll(): Map<string, string> {
  const domains = loadDomains();
  const params = loadParams();
  checkFixtures(domains, params);
  const noir = renderNoir(domains);
  return new Map<string, string>([
    [OUTPUT_PATHS.rust, renderRust(domains, params)],
    [OUTPUT_PATHS.typescript, renderTypeScript(domains, params)],
    [OUTPUT_PATHS.noirCircuit, noir],
    [OUTPUT_PATHS.noirVectors, noir],
  ]);
}

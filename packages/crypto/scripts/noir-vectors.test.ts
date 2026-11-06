// Check that the Poseidon2 fixture is valid and that the circuit hash test file agrees with it.

import { describe, expect, it } from "vitest";
import { readRepoFile } from "./constants.ts";
import { CIRCUIT_HASH_TESTS_PATH, POSEIDON2_FIXTURE_PATH, poseidon2FixtureSchema, renderCircuitHashTests } from "./noir-vectors.ts";

describe("poseidon2 reference fixture", () => {
  const fixture = poseidon2FixtureSchema.parse(JSON.parse(readRepoFile(POSEIDON2_FIXTURE_PATH)));

  it("has vectors of each kind", () => {
    expect(fixture.permutation.length).toBeGreaterThan(0);
    expect(fixture.batch_cases.map((entry) => entry.name)).toContain("case_a");
    const kinds = new Set(fixture.constructions.map((entry) => entry.kind));
    expect([...kinds].sort()).toEqual(["batch_id", "binding", "commitment", "leaf", "mmr_leaf", "mmr_node", "mmr_root"]);
  });

  it(`${CIRCUIT_HASH_TESTS_PATH} is up to date`, () => {
    expect(readRepoFile(CIRCUIT_HASH_TESTS_PATH)).toBe(renderCircuitHashTests(fixture));
  });
});

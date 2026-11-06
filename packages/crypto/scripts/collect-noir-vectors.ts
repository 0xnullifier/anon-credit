// Run the Noir reference vector package and write fixtures/protocol/poseidon2.json and the
// circuit hash test file.
// Usage: node packages/crypto/scripts/collect-noir-vectors.ts
// Needs nargo on PATH or at ~/.nargo/bin/nargo.

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { REPO_ROOT } from "./constants.ts";
import {
  CIRCUIT_HASH_TESTS_PATH,
  POSEIDON2_FIXTURE_PATH,
  buildFixture,
  parseNargoOutput,
  renderCircuitHashTests,
} from "./noir-vectors.ts";

function nargoPath(): string {
  const fallback = `${process.env["HOME"] ?? ""}/.nargo/bin/nargo`;
  return existsSync(fallback) ? fallback : "nargo";
}

const output = execFileSync(nargoPath(), ["test", "--show-output"], {
  cwd: new URL("fixtures/protocol/noir-vectors/", REPO_ROOT),
  encoding: "utf8",
});
const fixture = buildFixture(parseNargoOutput(output));
writeFileSync(new URL(POSEIDON2_FIXTURE_PATH, REPO_ROOT), `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${POSEIDON2_FIXTURE_PATH}`);
writeFileSync(new URL(CIRCUIT_HASH_TESTS_PATH, REPO_ROOT), renderCircuitHashTests(fixture));
console.log(`wrote ${CIRCUIT_HASH_TESTS_PATH}`);

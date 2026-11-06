// Run the Noir reference vector package and write fixtures/protocol/poseidon2.json and the
// circuit hash test file.
// Usage: node packages/crypto/scripts/collect-noir-vectors.ts
// Needs nargo 1.0.0-beta.26 (the Noir version of the project). The script uses $NARGO, else
// ~/dev/noir-1.0.0-beta.26/bin/nargo. tooling/provekit/install.sh installs it there.

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

const NOIR_VERSION = "1.0.0-beta.26";

function nargoPath(): string {
  const configured = process.env["NARGO"];
  const path = configured ?? `${process.env["HOME"] ?? ""}/dev/noir-${NOIR_VERSION}/bin/nargo`;
  if (!existsSync(path)) {
    throw new Error(`nargo ${NOIR_VERSION} not found at ${path}; run tooling/provekit/install.sh`);
  }
  const version = execFileSync(path, ["--version"], { encoding: "utf8" });
  if (!version.includes(`nargo version = ${NOIR_VERSION}`)) {
    throw new Error(`${path} is not nargo ${NOIR_VERSION}: ${version}`);
  }
  return path;
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

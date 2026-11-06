// Write the generated constant files for Rust, TypeScript, and Noir.
// Usage: node packages/crypto/scripts/generate-constants.ts

import { writeFileSync } from "node:fs";
import { REPO_ROOT, renderAll } from "./constants.ts";

for (const [path, text] of renderAll()) {
  writeFileSync(new URL(path, REPO_ROOT), text);
  console.log(`wrote ${path}`);
}

// Sepolia end-to-end example (implementation.md section 15).
//
//   pnpm example:e2e             full run: purchase, finality waits, proofs, Nox, assertions
//   pnpm example:e2e --dry-run   settings and connectivity checks only; no transaction
//
// Settings come from the environment (README "Sepolia example"). The runner holds only the test
// payer key and operational settings. It never receives batch secrets or session private keys.
// It refuses a localhost or private gateway or issuer URL: the Nox exit cannot reach it.

import { runSepolia } from "./src/sepolia-run.ts";

process.exitCode = await runSepolia(process.argv.slice(2), process.env);

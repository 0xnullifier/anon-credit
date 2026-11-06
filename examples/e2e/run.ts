// Sepolia end-to-end example (implementation.md section 15).
//
//   pnpm example:e2e             full run: purchase, finality waits, proofs, Nox, assertions
//   pnpm example:e2e --dry-run   settings and connectivity checks only; no transaction
//
// Settings come from the environment (README "Sepolia example", RUNBOOK.md). The runner holds
// only the test payer key and operational settings. It never receives batch secrets or session
// private keys. It refuses a localhost or private gateway or issuer URL: the Nox exit cannot
// reach it.
//
// Step 15 writes the admin view of the three batches (remaining units, cumulative units, next
// seq, receipt count) and the gateway counters into the result. The runner prints the
// dashboard URL at the start and at the end. It never prints the admin token.

import { z } from "zod";
import { runSepolia } from "./src/sepolia-run.ts";

const dashboardEnvSchema = z.object({
  DASHBOARD_PORT: z.coerce.number().int().min(1).max(65_535).default(5174),
  E2E_ADMIN_URL: z.preprocess((value) => (value === "" ? undefined : value), z.url().optional()),
  E2E_GATEWAY_URL: z.preprocess((value) => (value === "" ? undefined : value), z.url().optional()),
  GATEWAY_ADMIN_TOKEN: z.string().optional(),
});

// Print where the operator opens the dashboard. Never print the token value.
function printDashboardHint(when: "start" | "end"): void {
  const parsed = dashboardEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    return;
  }
  const env = parsed.data;
  const token = env.GATEWAY_ADMIN_TOKEN === undefined || env.GATEWAY_ADMIN_TOKEN === "" ? "not set" : "set";
  const lines = [
    `dashboard (${when}): http://localhost:${env.DASHBOARD_PORT} (start it with: pnpm dashboard:dev)`,
    `  sign in with GATEWAY_ADMIN_TOKEN (${token} in this shell; the runner does not print it)`,
    `  admin API URL: ${env.E2E_ADMIN_URL ?? "http://127.0.0.1:8082 (keep it private: SSH tunnel or loopback)"}`,
    `  public gateway URL for the direct probe: ${env.E2E_GATEWAY_URL === undefined ? "the HTTPS gateway URL" : new URL(env.E2E_GATEWAY_URL).origin}`,
    "  the Demo comparison panel shows the direct probe next to the newest session_opened event and its spends",
  ];
  for (const line of lines) {
    console.log(`[e2e] ${line}`);
  }
}

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
if (!dryRun) {
  printDashboardHint("start");
}
process.exitCode = await runSepolia(argv, process.env);
if (!dryRun) {
  printDashboardHint("end");
}

// Sepolia end-to-end runner. Phase 4 implements the steps.
//
// Plan (implementation.md section 15):
// 1. Check deployment identities, chain IDs, circuit artifacts, connectivity, and admin access.
// 2. Start Chromium with playwright-core. Load browser/index.html.
// 3. Buy three batches with the test payer key. Wait for finality and an eligible root.
// 4. Prove, open, and spend through Nox. Assert balances and sequence numbers.
// 5. Save a sanitized result. Exit nonzero on a failed assertion or a timeout.
//
// The runner holds only the test payment key and operational settings.
// It never receives batch secrets or session private keys.

import { PROTOCOL_VERSION } from "@anon-credit/protocol";
import { z } from "zod";

// Exit code for "not implemented". A placeholder run must not report a pass.
const EXIT_NOT_IMPLEMENTED = 2;

const settingsSchema = z.object({
  E2E_ISSUER_URL: z.url().optional(),
  E2E_GATEWAY_URL: z.url().optional(),
  E2E_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(7200),
  E2E_PAGE_PORT: z.coerce.number().int().min(1).max(65_535).default(5173),
});

const result = settingsSchema.safeParse(process.env);
switch (result.success) {
  case false:
    console.error(`invalid settings: ${result.error.message}`);
    process.exit(1);
    break;
  case true:
    console.log(`anon-credit e2e runner, protocol version ${PROTOCOL_VERSION}`);
    console.log(`timeout: ${result.data.E2E_TIMEOUT_SECONDS} s, page port: ${result.data.E2E_PAGE_PORT}`);
    console.log("not implemented until phase 4");
    process.exit(EXIT_NOT_IMPLEMENTED);
}

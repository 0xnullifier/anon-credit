// The machine-readable result of a run. It has step outcomes, timings, proof size, and public
// deployment settings. It never has keys, secrets, passphrases, or RPC URLs.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

export const jsonSchema = z.json();
export type Json = z.infer<typeof jsonSchema>;

export const stepStatusSchema = z.enum(["pass", "fail", "skip", "not_run"]);

export const stepResultSchema = z.strictObject({
  id: z.number().int(),
  name: z.string(),
  status: stepStatusSchema,
  ms: z.number(),
  details: z.record(z.string(), jsonSchema),
  error: z.string().nullable(),
});
export type StepResult = z.infer<typeof stepResultSchema>;

export const runResultSchema = z.strictObject({
  format: z.literal("anon-credit/e2e-result/v1"),
  profile: z.enum(["local-anvil", "sepolia"]),
  status: z.enum(["pass", "fail"]),
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number(),
  transport: z.enum(["anon", "direct"]),
  deployment: z.record(z.string(), jsonSchema),
  environment: z.record(z.string(), jsonSchema),
  steps: z.array(stepResultSchema),
  error: z.string().nullable(),
});
export type RunResult = z.infer<typeof runResultSchema>;

// JSON keys that must not be in a result file.
const FORBIDDEN_KEYS = /"(?:private_?key|payer_?key|passphrase|session_secret|k|admin_?token|rpc_?url)"\s*:/i;

// Write the result. `secrets` are values that must not be in the file (keys, tokens, the
// passphrase, private RPC URLs). A match fails the write, so a leak cannot reach the disk.
export function writeResult(path: string, result: RunResult, secrets: readonly string[]): void {
  const text = `${JSON.stringify(runResultSchema.parse(result), null, 2)}\n`;
  if (FORBIDDEN_KEYS.test(text)) throw new Error("the result has a forbidden key; it is not written");
  for (const secret of secrets) {
    if (secret.length >= 8 && text.toLowerCase().includes(secret.toLowerCase())) {
      throw new Error("the result has a secret value; it is not written");
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

// Remove the query and the path of a URL, so that an API key in the URL is not kept.
export function originOnly(url: string): string {
  return new URL(url).origin;
}

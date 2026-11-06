// Step 15: compare the gateway admin view with the committed balances, and list the source
// addresses that the gateway observed for the paid session events (demo profile only).
//
// The admin API is private. The runner reads it only with the admin token. The token is never
// in a URL and never in the result.

import { adminSnapshotSchema, sessionDetailSchema } from "@anon-credit/protocol";
import type { z } from "zod";
import type { Json } from "./result.ts";

export interface AdminAccess {
  // Admin base URL without a trailing slash.
  readonly adminUrl: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
}

async function getAdmin<S extends z.ZodType>(access: AdminAccess, path: string, schema: S): Promise<z.output<S>> {
  const fetchFn = access.fetch ?? globalThis.fetch.bind(globalThis);
  const response = await fetchFn(`${access.adminUrl}${path}`, { headers: { authorization: `Bearer ${access.token}` } });
  if (!response.ok) throw new Error(`admin GET ${path} returned ${response.status}`);
  return schema.parse(await response.json());
}

// Check that each batch has the expected remaining units in the admin view. Return the
// receipt counts and the observed source addresses of the session events.
export async function adminCheck(access: AdminAccess, batches: readonly string[], expected: readonly number[]): Promise<Record<string, Json>> {
  const details: Record<string, Json> = {};
  for (const [index, batchId] of batches.entries()) {
    const detail = await getAdmin(access, `/admin/v1/sessions/${batchId}`, sessionDetailSchema);
    const want = expected[index];
    if (detail.summary.session.remaining !== want) {
      throw new Error(`admin view of batch ${index + 1}: remaining ${detail.summary.session.remaining}, expected ${String(want)}`);
    }
    details[`batch${index + 1}`] = { remaining: detail.summary.session.remaining, receipts: detail.receipts.length };
  }
  const snapshot = await getAdmin(access, "/admin/v1/snapshot", adminSnapshotSchema);
  const ours = snapshot.recent_events.filter((event) => event.batch_id !== null && batches.includes(event.batch_id));
  details["demoIpLogging"] = snapshot.demo_ip_logging;
  details["sessionEventsSeen"] = ours.length;
  details["observedSourceIps"] = [...new Set(ours.map((event) => event.observed_ip))];
  details["ipAttribution"] = [...new Set(ours.map((event) => event.ip_attribution))];
  return details;
}

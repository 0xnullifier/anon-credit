// Check which response headers reach the page through the Nox worker of the Anon-RPC harness.
//
// The probe loads the e2e page in headless Chromium, starts the Nox transport (the same code
// as the SDK uses), and sends one GET to a public echo URL that sets the three X-Anon-*
// headers. It runs one time on a cross-origin isolated page (COOP/COEP, as the e2e run uses)
// and one time on a page without isolation. It needs internet access (the Nox network and
// the public Sepolia bootstrap RPC). It never contacts the gateway.
//
// Usage: node examples/e2e/nox-probe.ts [--url <echo URL>]
// Env: NOX_PROBE_POST_SIZES=16000,65536 (POST body sizes), NOX_PROBE_SKIP_GET=1,
//      NOX_PROBE_BODY_KIND=stream (send the POST body as a ReadableStream).
// Result: examples/e2e/results/nox-header-probe.json

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { HEADER_NEXT_SEQ, HEADER_REMAINING, HEADER_REPLAYED } from "@anon-credit/protocol";
import { findChromium } from "./src/chromium.ts";
import { transportProbeValueSchema } from "./src/page-api.ts";
import { PageCallError, pageCaller } from "./src/page-driver.ts";
import { REPO_ROOT, startPageServer } from "./src/page-server.ts";
import { freePort } from "./src/processes.ts";

const urlIndex = process.argv.indexOf("--url");
const echoUrl =
  (urlIndex >= 0 ? process.argv[urlIndex + 1] : undefined) ??
  `https://httpbin.org/response-headers?${HEADER_REMAINING}=99&${HEADER_NEXT_SEQ}=1&${HEADER_REPLAYED}=false`;

function log(line: string): void {
  console.log(`[nox-probe] ${line}`);
}

interface ProbeRun {
  readonly isolated: boolean;
  readonly method: "GET" | "POST";
  readonly requestBodyBytes: number;
  readonly bodyKind: string;
  readonly ok: boolean;
  readonly readyMs: number | null;
  readonly fetchMs: number | null;
  readonly status: number | null;
  readonly xAnonHeaders: Record<string, string | null>;
  readonly headerNames: string[];
  readonly error: string | null;
}

const postUrl = "https://httpbin.org/status/200";

const bodyKind = process.env["NOX_PROBE_BODY_KIND"] === "stream" ? "stream" : "text";

async function probe(isolated: boolean, method: "GET" | "POST", bodyBytes: number): Promise<ProbeRun> {
  const port = await freePort();
  const server = await startPageServer(port, isolated);
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const tab = await browser.newPage();
    tab.on("console", (message) => {
      if (message.text().startsWith("[e2e")) log(message.text());
    });
    await tab.goto(server.url);
    await tab.waitForSelector("body[data-ready=true]", { timeout: 60_000 });
    const value = await pageCaller(tab)(
      {
        op: "transportProbe",
        transport: "anon",
        readyTimeoutMs: 120_000,
        url: method === "GET" ? echoUrl : postUrl,
        isolationKey: "header-probe",
        method,
        bodyBytes,
        bodyKind,
      },
      transportProbeValueSchema,
    );
    const headers = new Map(value.headers.map(([name, text]) => [name.toLowerCase(), text]));
    return {
      isolated,
      method,
      requestBodyBytes: bodyBytes,
      bodyKind,
      ok: true,
      readyMs: Math.round(value.readyMs),
      fetchMs: Math.round(value.fetchMs),
      status: value.status,
      xAnonHeaders: {
        [HEADER_REMAINING]: headers.get(HEADER_REMAINING) ?? null,
        [HEADER_NEXT_SEQ]: headers.get(HEADER_NEXT_SEQ) ?? null,
        [HEADER_REPLAYED]: headers.get(HEADER_REPLAYED) ?? null,
      },
      headerNames: [...headers.keys()].sort(),
      error: null,
    };
  } catch (error) {
    const message = error instanceof PageCallError || error instanceof Error ? error.message : String(error);
    return { isolated, method, requestBodyBytes: bodyBytes, bodyKind, ok: false, readyMs: null, fetchMs: null, status: null, xAnonHeaders: {}, headerNames: [], error: message };
  } finally {
    await browser.close();
    await server.close();
  }
}

// GET with the X-Anon-* echo (isolated and not isolated), then a POST of the size of an open
// request with a proof (the spend and status bodies are much smaller).
// NOX_PROBE_POST_SIZES: comma-separated POST body sizes in bytes (default 700000).
const postSizes = (process.env["NOX_PROBE_POST_SIZES"] ?? "700000").split(",").map(Number).filter((size) => size >= 0);
const skipGet = process.env["NOX_PROBE_SKIP_GET"] === "1";
const runs: ProbeRun[] = skipGet ? [] : [await probe(true, "GET", 0), await probe(false, "GET", 0)];
for (const size of postSizes) runs.push(await probe(true, "POST", size));
const survived = runs.some((run) => run.method === "GET" && run.ok && Object.values(run.xAnonHeaders).every((value) => value !== null));
const result = {
  format: "anon-credit/nox-header-probe/v1",
  at: new Date().toISOString(),
  echoUrl: new URL(echoUrl).origin,
  worker: "nox",
  xAnonHeadersSurvive: survived,
  runs,
};
const path = join(REPO_ROOT, "examples/e2e/results/nox-header-probe.json");
mkdirSync(join(REPO_ROOT, "examples/e2e/results"), { recursive: true });
writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
for (const run of runs) {
  log(`${run.method} ${run.requestBodyBytes} B ${run.bodyKind} isolated=${run.isolated} ok=${run.ok} status=${run.status} ready=${run.readyMs} ms fetch=${run.fetchMs} ms x-anon=${JSON.stringify(run.xAnonHeaders)} ${run.error ?? ""}`);
}
log(`X-Anon-* headers survive: ${survived}; written to ${path}`);
process.exitCode = runs.every((run) => run.ok) ? 0 : 1;

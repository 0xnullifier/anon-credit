// Check which response headers reach the page through the Nox worker of the Anon-RPC harness.
//
// The probe loads the e2e page in headless Chromium, starts the Nox transport (the same code
// as the SDK uses), and sends one GET to a public echo URL that sets the three X-Anon-*
// headers. It runs one time on a cross-origin isolated page (COOP/COEP, as the e2e run uses)
// and one time on a page without isolation. It needs internet access (the Nox network and
// the public Sepolia bootstrap RPC). It never contacts the gateway.
//
// Usage: node examples/e2e/nox-probe.ts [--url <echo URL>]
//        node examples/e2e/nox-probe.ts --chunks [--url <echo URL>] [--direct]
// Env: NOX_PROBE_POST_SIZES=16000,65536 (POST body sizes), NOX_PROBE_SKIP_GET=1,
//      NOX_PROBE_BODY_KIND=stream (send the POST body as a ReadableStream),
//      NOX_PROBE_CHUNK_METHOD=PUT|POST, NOX_PROBE_PARALLEL=8,4,1 (one run for each value, at
//      most 12 runs), NOX_PROBE_CHUNK_BYTES=40000 (raw bytes of one chunk, at most 40,000),
//      NOX_BOOTSTRAP_RPC_URL (Sepolia RPC for the Nox specifier; default: the SDK default).
// Result: examples/e2e/results/nox-header-probe.json
//
// --chunks: the chunked open upload. The runner gzips the real browser proof
// (artifacts/batch-open/proof.browser.json), plans the raw chunks with the SDK code in the page
// (40,000 bytes, 8 chunks), and sends each one as an application/octet-stream PUT through Nox
// to a public echo URL (default https://httpbingo.org/anything; httpbin.org answers 429 to 8
// requests at the same time) + the chunk path: first
// `parallel` in flight on one isolation key, then the failed ones one at a time. It records
// the time of each chunk and checks that the echo has the chunk bytes unchanged.
// Result: examples/e2e/results/nox-chunk-probe.json

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright-core";
import { HEADER_NEXT_SEQ, HEADER_REMAINING, HEADER_REPLAYED, OPEN_CHUNK_MAX_BYTES } from "@anon-credit/protocol";
import { z } from "zod";
import { findChromium } from "./src/chromium.ts";
import { chunkProbeValueSchema, transportProbeValueSchema, type ChunkRun } from "./src/page-api.ts";
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
const bootstrapRpcUrl = z.url().optional().parse(process.env["NOX_BOOTSTRAP_RPC_URL"] || undefined);
const bootstrapOption = bootstrapRpcUrl === undefined ? {} : { bootstrapRpcUrl };

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
        ...bootstrapOption,
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

async function headerProbe(): Promise<void> {
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
}

interface ChunkSummary {
  readonly parallel: number;
  readonly ok: boolean;
  // Chunks delivered in the parallel pass / chunks.
  readonly firstPassSuccess: string;
  readonly fellBack: boolean;
  readonly totalMs: number;
  readonly parallelPassMs: number;
  readonly sequentialPassMs: number;
  readonly failedFirstPass: number;
  readonly echoedAll: boolean;
  readonly chunkMs: { readonly min: number; readonly median: number; readonly max: number };
}

function summarize(run: ChunkRun, count: number): ChunkSummary {
  const okSends = run.sends.filter((send) => send.ok);
  const times = okSends.map((send) => send.ms).sort((a, b) => a - b);
  const pick = (q: number): number => Math.round(times[Math.min(times.length - 1, Math.floor(q * times.length))] ?? 0);
  const delivered = new Set(okSends.map((send) => send.index));
  const firstPass = run.sends.filter((send) => send.phase === "parallel");
  return {
    parallel: run.parallel,
    ok: run.allDelivered && delivered.size === count,
    firstPassSuccess: `${firstPass.filter((send) => send.ok).length}/${firstPass.length}`,
    fellBack: run.fellBack,
    totalMs: Math.round(run.totalMs),
    parallelPassMs: Math.round(run.parallelPassMs),
    sequentialPassMs: Math.round(run.sequentialPassMs),
    failedFirstPass: run.sends.filter((send) => send.phase === "parallel" && !send.ok).length,
    echoedAll: okSends.length > 0 && okSends.every((send) => send.echoed),
    chunkMs: { min: Math.round(times[0] ?? 0), median: pick(0.5), max: Math.round(times.at(-1) ?? 0) },
  };
}

// The chunked open upload with the real proof bytes through Nox.
async function chunkProbe(): Promise<void> {
  const url = (urlIndex >= 0 ? process.argv[urlIndex + 1] : undefined) ?? "https://httpbingo.org/anything";
  const method = process.env["NOX_PROBE_CHUNK_METHOD"] === "POST" ? "POST" : "PUT";
  const parallelRuns = (process.env["NOX_PROBE_PARALLEL"] ?? "8,4,1").split(",").map(Number).filter((value) => value >= 1);
  const chunkBytes = Number(process.env["NOX_PROBE_CHUNK_BYTES"] ?? OPEN_CHUNK_MAX_BYTES);
  const transport = process.argv.includes("--direct") ? "direct" : "anon";
  const proof = new Uint8Array(readFileSync(join(REPO_ROOT, "artifacts/batch-open/proof.browser.json")));
  const gzip = new Uint8Array(gzipSync(proof));
  const count = Math.ceil(gzip.byteLength / chunkBytes);
  log(`proof ${proof.byteLength} B JSON, ${gzip.byteLength} B gzip, ${count} chunks`);
  const port = await freePort();
  const server = await startPageServer(port, true);
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  let value;
  let failure: string | null = null;
  try {
    const tab = await browser.newPage();
    tab.on("console", (message) => {
      if (message.text().startsWith("[e2e")) log(message.text());
    });
    await tab.goto(server.url);
    await tab.waitForSelector("body[data-ready=true]", { timeout: 60_000 });
    value = await pageCaller(tab)(
      {
        op: "chunkProbe",
        transport,
        ...(transport === "anon" ? bootstrapOption : {}),
        readyTimeoutMs: 180_000,
        url,
        method,
        isolationKey: "chunk-probe",
        // Any canonical field element works as the batch ID; the echo URL does not check it.
        batchId: `0x${"0a".repeat(31)}01`,
        upload: Buffer.from(gzip).toString("base64"),
        chunkBytes,
        parallelRuns,
      },
      chunkProbeValueSchema,
    );
  } catch (error) {
    failure = error instanceof PageCallError || error instanceof Error ? error.message : String(error);
  } finally {
    await browser.close();
    await server.close();
  }
  const summaries = value === undefined ? [] : value.runs.map((run) => summarize(run, count));
  const result = {
    format: "anon-credit/nox-chunk-probe/v2",
    at: new Date().toISOString(),
    transport,
    echoUrl: url,
    method,
    proofJsonBytes: proof.byteLength,
    uploadBytes: gzip.byteLength,
    chunks: value?.chunks ?? count,
    chunkBytes: value?.chunkBytes ?? chunkBytes,
    largestBodyBytes: value?.largestBodyBytes ?? null,
    largestPathBytes: value?.largestPathBytes ?? null,
    readyMs: value === undefined ? null : Math.round(value.readyMs),
    summaries,
    runs: value?.runs ?? [],
    error: failure,
  };
  const path = join(REPO_ROOT, "examples/e2e/results/nox-chunk-probe.json");
  mkdirSync(join(REPO_ROOT, "examples/e2e/results"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
  for (const summary of summaries) log(JSON.stringify(summary));
  if (failure !== null) log(`failed: ${failure}`);
  log(`written to ${path}`);
  process.exitCode = failure === null && summaries.some((summary) => summary.ok) ? 0 : 1;
}

if (process.argv.includes("--chunks")) await chunkProbe();
else await headerProbe();

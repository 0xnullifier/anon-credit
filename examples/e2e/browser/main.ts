// The end-to-end page. The Node runner calls window.anonE2E(requestJson) for each step.
//
// The page generates batch secrets and session keys (in the SDK), runs the ProveKit prover in
// a worker, and sends every gateway and issuer request through the selected transport:
// - "anon": the Nox worker of @anon-rpc/browser-harness (the Sepolia run).
// - "direct": a plain fetch (the local integration harness only; Nox cannot reach localhost).
//
// The page returns only public values. It writes progress lines to the console with the
// prefix "[e2e]"; they never have secrets.

import { createAnonTransport, directTransport, type Transport } from "@anon-credit/anon-transport";
import { OPEN_CHUNK_MAX_BYTES, decodeBase64, encodeBase64, openChunkPath, type InlineOpenRequest, type SpendRequest } from "@anon-credit/protocol";
import { createBatchOpenProver, type BatchOpenProver } from "@anon-credit/prover";
import {
  SdkError,
  ServiceError,
  createClient,
  indexedDbStorage,
  planUpload,
  type Client,
  type OpenChunk,
  type OpenUploadMode,
  type PreparedOpen,
  type SelectedRoot,
} from "@anon-credit/sdk";
import { z } from "zod";
import { pageRequestSchema, type ChunkRun, type ChunkSend, type PageError, type SetupRequest } from "../src/page-api.ts";

declare global {
  interface Window {
    anonE2E: (requestJson: string) => Promise<string>;
  }
}

type Json = z.infer<ReturnType<typeof z.json>>;

interface PageState {
  client: Client;
  transport: Transport;
  prover: BatchOpenProver;
  setup: SetupRequest;
  roots: Map<string, SelectedRoot>;
  prepared: Map<string, PreparedOpen>;
  remembered: Map<string, { readonly request: SpendRequest; readonly body: string }>;
}

let state: PageState | undefined;
const logElement = document.getElementById("log");
const started = performance.now();

function progress(text: string): void {
  const line = `[e2e +${Math.round(performance.now() - started)} ms] ${text}`;
  console.log(line);
  if (logElement !== null) logElement.textContent = `${logElement.textContent ?? ""}${line}\n`;
}

function short(id: string): string {
  return `${id.slice(0, 10)}...`;
}

function requireState(): PageState {
  if (state === undefined) throw new Error("setup has not run");
  return state;
}

// Change one hex digit inside the proof JSON. The JSON stays valid, so the verifier rejects
// the proof on its values, not on its format.
function tamper(proof: string): string {
  const bytes = new Uint8Array(decodeBase64(proof));
  const digits = "0123456789abcdef";
  for (let index = Math.floor(bytes.length / 2); index < bytes.length; index += 1) {
    const char = String.fromCharCode(bytes[index] ?? 0);
    const position = digits.indexOf(char);
    if (position >= 0) {
      bytes[index] = digits.charCodeAt((position + 1) % 16);
      return encodeBase64(bytes);
    }
  }
  throw new Error("the proof has no hex digit to change");
}

function flipSignature(request: SpendRequest): SpendRequest {
  const signature = new Uint8Array(decodeBase64(request.signature));
  signature[0] = (signature[0] ?? 0) ^ 0x01;
  return { ...request, signature: encodeBase64(signature) };
}

async function setupPage(setup: SetupRequest): Promise<Json> {
  const transportStart = performance.now();
  let transport: Transport;
  switch (setup.transport) {
    case "anon":
      progress("starting the Nox worker (Anon-RPC harness)");
      transport = await createAnonTransport({
        readyTimeoutMs: setup.readyTimeoutMs,
        ...(setup.bootstrapRpcUrl === undefined ? {} : { bootstrapRpcUrl: setup.bootstrapRpcUrl }),
        onLog: (line) => {
          if (line.level !== "debug") progress(`transport: ${line.text}`);
        },
      });
      break;
    case "direct":
      progress("direct transport: requests are NOT anonymized (local harness only)");
      transport = directTransport();
      break;
  }
  const transportReadyMs = performance.now() - transportStart;
  const mode = setup.proverMode === "auto" ? (crossOriginIsolated ? "threaded" : "scalar") : setup.proverMode;
  progress(`loading the ProveKit prover (${mode}, crossOriginIsolated=${crossOriginIsolated})`);
  const prover = await createBatchOpenProver({
    manifestUrl: setup.manifestUrl,
    manifestSha256: setup.manifestSha256.slice(2),
    mode,
  });
  const storage = await indexedDbStorage({ name: `anon-credit-e2e-${Date.now()}` });
  const client = await createClient({
    gatewayUrl: setup.gatewayUrl,
    issuerUrl: setup.issuerUrl,
    transport,
    allowDirectTransport: setup.transport === "direct",
    prover,
    storage,
    passphrase: setup.passphrase,
    proverManifestSha256: setup.manifestSha256,
    firstUseDelayEpochs: setup.firstUseDelayEpochs,
    pollMs: setup.pollMs,
    eligibleTimeoutMs: setup.eligibleTimeoutMs,
    onOpenProgress: (item) =>
      progress(`batch ${short(item.batchId)}: waiting (${item.phase}), epoch ${item.currentEpoch}, open epoch ${item.targetEpoch}`),
  });
  state = { client, transport, prover, setup, roots: new Map(), prepared: new Map(), remembered: new Map() };
  progress(`ready: deployment ${short(client.deployment.deployment_id)}, epoch ${client.deployment.epoch_seconds} s`);
  return {
    transportKind: transport.kind,
    crossOriginIsolated,
    proverMode: prover.info.mode,
    proverLoadMs: prover.info.loadMs,
    proverThreads: prover.info.threads,
    proverDownloadBytes: prover.info.downloadBytes,
    deploymentId: client.deployment.deployment_id,
    gatewayId: client.deployment.gateway_id,
    epochSeconds: client.deployment.epoch_seconds,
    paymentChainId: client.deployment.payment_chain_id,
    saleAddress: client.deployment.sale_address,
    transportReadyMs,
  };
}

async function submit(page: PageState, batchId: string, request: InlineOpenRequest, upload: OpenUploadMode): Promise<Json> {
  const start = performance.now();
  let reprepared = false;
  let outcome;
  try {
    outcome = await page.client.submitOpen(batchId, request, { upload });
  } catch (error) {
    const root = page.roots.get(batchId);
    if (!(error instanceof ServiceError && error.serviceCode === "proof_epoch_stale" && root !== undefined)) throw error;
    progress(`batch ${short(batchId)}: proof epoch is stale; prove again`);
    const prepared = await page.client.prepareOpen(batchId, root);
    page.prepared.set(batchId, prepared);
    reprepared = true;
    outcome = await page.client.submitOpen(batchId, prepared.request, { upload });
  }
  const response = outcome.response;
  const stats = outcome.upload;
  if (stats !== null) {
    progress(
      `batch ${short(batchId)}: proof upload ${stats.uploadBytes} bytes (${stats.encoding}) in ${stats.chunks} chunks, ` +
        `${stats.parallel} in flight, fallback ${stats.fellBack}, ${Math.round(stats.totalMs)} ms`,
    );
  }
  return {
    existing: response.existing,
    remaining: response.session.remaining,
    nextSeq: response.session.next_seq,
    reprepared,
    openMs: performance.now() - start,
    upload: stats === null ? null : { ...stats, chunkMs: [...stats.chunkMs] },
  };
}

// Send each raw chunk once with `parallel` requests in flight, then the failed ones one at a
// time with up to 3 attempts. The URL is `base` + the chunk path.
async function chunkRun(transport: Transport, base: string, method: "PUT" | "POST", isolationKey: string, chunks: readonly OpenChunk[], parallel: number): Promise<ChunkRun> {
  const sends: ChunkSend[] = [];
  const sendOne = async (index: number, phase: ChunkSend["phase"], attempt: number): Promise<boolean> => {
    const chunk = chunks[index];
    if (chunk === undefined) throw new Error(`chunk ${index} does not exist`);
    // httpbin.org echoes standard base64, httpbingo.org echoes base64url. Accept both.
    const standard = encodeBase64(chunk.data);
    const urlSafe = standard.replaceAll("+", "-").replaceAll("/", "_");
    const sent = performance.now();
    try {
      const response = await transport.fetch(
        `${base}${openChunkPath(chunk.path)}`,
        { method, headers: { "content-type": "application/octet-stream" }, body: chunk.data },
        { isolationKey },
      );
      const text = await response.text();
      const ok = response.ok;
      sends.push({ index, phase, attempt, ok, status: response.status, ms: performance.now() - sent, bodyBytes: chunk.data.byteLength, echoed: text.includes(standard) || text.includes(urlSafe), error: null });
      return ok;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sends.push({ index, phase, attempt, ok: false, status: null, ms: performance.now() - sent, bodyBytes: chunk.data.byteLength, echoed: false, error: message });
      return false;
    }
  };
  const start = performance.now();
  const failed: number[] = [];
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < chunks.length) {
      const index = next;
      next += 1;
      if (!(await sendOne(index, "parallel", 1))) failed.push(index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, chunks.length) }, lane));
  const parallelPassMs = performance.now() - start;
  const sequentialStart = performance.now();
  let delivered = chunks.length - failed.length;
  for (const index of [...failed].sort((a, b) => a - b)) {
    for (let attempt = 2; attempt <= 4; attempt += 1) {
      if (await sendOne(index, "sequential", attempt)) {
        delivered += 1;
        break;
      }
    }
  }
  const sequentialPassMs = performance.now() - sequentialStart;
  progress(`chunk run (${parallel} in flight): ${delivered} of ${chunks.length} delivered in ${Math.round(performance.now() - start)} ms`);
  return {
    parallel,
    sends,
    parallelPassMs,
    sequentialPassMs,
    totalMs: performance.now() - start,
    fellBack: failed.length > 0,
    allDelivered: delivered === chunks.length,
  };
}

async function handle(text: string): Promise<Json> {
  const request = pageRequestSchema.parse(JSON.parse(text));
  switch (request.op) {
    case "setup":
      return setupPage(request.setup);
    case "createBatches": {
      const batches = await requireState().client.createBatches(request.n);
      progress(`made ${batches.length} batch secrets and session keys`);
      return { batches };
    }
    case "attachIssuance":
      return { matched: await requireState().client.attachIssuance(request.issuance) };
    case "waitEligible": {
      const page = requireState();
      const start = performance.now();
      const root = await page.client.waitForEligibleRoot(request.batchId);
      page.roots.set(request.batchId, root);
      const summary = (await page.client.batches()).find((batch) => batch.batchId === request.batchId);
      progress(`batch ${short(request.batchId)}: root of epoch ${root.sourceEpoch} is eligible`);
      return {
        sourceEpoch: root.sourceEpoch.toString(10),
        leafCount: root.leafCount,
        waitedMs: performance.now() - start,
        delayEpochs: summary?.delayEpochs ?? -1,
      };
    }
    case "prepareOpen": {
      const page = requireState();
      const root = page.roots.get(request.batchId);
      const start = performance.now();
      const prepared = await page.client.prepareOpen(request.batchId, root);
      page.prepared.set(request.batchId, prepared);
      progress(`batch ${short(request.batchId)}: path checked, proof ${prepared.proofBytes} bytes in ${Math.round(prepared.proveMs)} ms`);
      return {
        proofEpoch: prepared.request.proof_epoch,
        rootEpoch: prepared.root.sourceEpoch.toString(10),
        leafCount: prepared.root.leafCount,
        publicInputCount: prepared.publicInputs.length,
        pathChecked: true,
        proofBytes: prepared.proofBytes,
        proveMs: prepared.proveMs,
        witnessMs: prepared.witnessMs,
        wasmMemoryBytes: prepared.wasmMemoryBytes,
        prepareMs: performance.now() - start,
      };
    }
    case "submitOpen": {
      const page = requireState();
      const prepared = page.prepared.get(request.batchId);
      if (prepared === undefined) throw new Error("prepareOpen has not run for this batch");
      const openRequest = request.tamper ? { ...prepared.request, proof: tamper(prepared.request.proof) } : prepared.request;
      return submit(page, request.batchId, openRequest, request.upload);
    }
    case "rpc": {
      const page = requireState();
      const start = performance.now();
      const outcome = await (await page.client.session(request.batchId)).rpc(request.method, request.params);
      if (request.label !== undefined) page.remembered.set(request.label, { request: outcome.request, body: outcome.body });
      return {
        seq: outcome.seq.toString(10),
        remaining: outcome.remaining,
        nextSeq: outcome.nextSeq.toString(10),
        replayed: outcome.replayed,
        stateSource: outcome.stateSource,
        attempts: outcome.attempts,
        hasResult: "result" in outcome.response,
        ms: performance.now() - start,
      };
    }
    case "replay": {
      const page = requireState();
      const stored = page.remembered.get(request.label);
      if (stored === undefined) throw new Error(`no request with label ${request.label}`);
      const raw = await (await page.client.session(request.batchId)).sendRaw(stored.request);
      return {
        httpStatus: raw.httpStatus,
        sameBody: raw.body === stored.body,
        replayed: raw.headers?.replayed ?? null,
        remaining: raw.headers?.remaining ?? null,
        errorCode: raw.errorCode,
      };
    }
    case "probe": {
      const session = await requireState().client.session(request.batchId);
      const next = BigInt(session.state.next_seq);
      const total = BigInt(session.state.units_total);
      let probe: SpendRequest;
      switch (request.kind) {
        case "conflict":
          // Sequence 0 again with a different body (the first request was eth_chainId).
          probe = session.buildRequest(0n, 1n, "eth_blockNumber", []);
          break;
        case "bad_signature":
          probe = flipSignature(session.buildRequest(next, total + 1n, "eth_chainId", []));
          break;
        case "gap":
          probe = session.buildRequest(next + 5n, total + 1n, "eth_chainId", []);
          break;
      }
      const raw = await session.sendRaw(probe);
      return { httpStatus: raw.httpStatus, errorCode: raw.errorCode };
    }
    case "status": {
      const status = await requireState().client.status(request.batchId);
      return {
        remaining: status.session.remaining,
        nextSeq: status.session.next_seq,
        unitsTotal: status.session.units_total,
        state: status.session.state,
      };
    }
    case "drain": {
      const session = await requireState().client.session(request.batchId);
      const start = performance.now();
      const sources: Record<string, number> = {};
      let requests = 0;
      while (session.state.remaining > 0) {
        const outcome = await session.rpc(request.method, []);
        sources[outcome.stateSource] = (sources[outcome.stateSource] ?? 0) + 1;
        requests += 1;
        if (requests % 16 === 0) progress(`batch ${short(request.batchId)}: ${outcome.remaining} units left`);
      }
      return {
        requests,
        remaining: session.state.remaining,
        nextSeq: session.state.next_seq,
        stateSources: sources,
        ms: performance.now() - start,
      };
    }
    case "transportInfo": {
      const page = requireState();
      return { kind: page.transport.kind, isolationKeys: [...page.transport.isolationKeys()], logLines: page.transport.logs.length };
    }
    case "peerProbe": {
      // The explicit direct comparison of implementation.md section 14. It carries no batch
      // or purchase identifier.
      const page = requireState();
      const response = await fetch(`${page.setup.gatewayUrl.replace(/\/+$/, "")}/v1/demo/peer`, { credentials: "omit", cache: "no-store" });
      const body = z.object({ observed_ip: z.string(), attribution: z.string() }).parse(await response.json());
      return { observedIp: body.observed_ip, attribution: body.attribution };
    }
    case "transportProbe": {
      const readyStart = performance.now();
      const transport =
        request.transport === "anon"
          ? await createAnonTransport({
              readyTimeoutMs: request.readyTimeoutMs,
              ...(request.bootstrapRpcUrl === undefined ? {} : { bootstrapRpcUrl: request.bootstrapRpcUrl }),
              onLog: (line) => {
                if (line.level !== "debug") progress(`transport: ${line.text}`);
              },
            })
          : directTransport();
      const readyMs = performance.now() - readyStart;
      try {
        const fetchStart = performance.now();
        const text = JSON.stringify({ pad: "a".repeat(request.bodyBytes) });
        const requestBody = request.bodyKind === "text" ? text : new Blob([text]).stream();
        const init =
          request.method === "GET"
            ? { method: request.method }
            : { method: request.method, headers: { "content-type": "application/json" }, body: requestBody };
        const response = await transport.fetch(request.url, init, { isolationKey: request.isolationKey });
        const body = await response.arrayBuffer();
        const headers: [string, string][] = [];
        response.headers.forEach((value, name) => headers.push([name, value]));
        return { readyMs, fetchMs: performance.now() - fetchStart, status: response.status, headers, bodyBytes: body.byteLength };
      } finally {
        transport.close();
      }
    }
    case "chunkProbe": {
      const readyStart = performance.now();
      const transport =
        request.transport === "anon"
          ? await createAnonTransport({
              readyTimeoutMs: request.readyTimeoutMs,
              ...(request.bootstrapRpcUrl === undefined ? {} : { bootstrapRpcUrl: request.bootstrapRpcUrl }),
              onLog: (line) => {
                if (line.level !== "debug") progress(`transport: ${line.text}`);
              },
            })
          : directTransport();
      const readyMs = performance.now() - readyStart;
      try {
        const chunkBytes = request.chunkBytes ?? OPEN_CHUNK_MAX_BYTES;
        const plan = planUpload(request.batchId, { bytes: decodeBase64(request.upload), encoding: "json+gzip" }, chunkBytes);
        const base = request.url.replace(/\/+$/, "");
        const runs: ChunkRun[] = [];
        for (const parallel of request.parallelRuns) {
          runs.push(await chunkRun(transport, base, request.method, request.isolationKey, plan.chunks, parallel));
        }
        return {
          readyMs,
          chunks: plan.chunks.length,
          chunkBytes,
          largestBodyBytes: Math.max(...plan.chunks.map((chunk) => chunk.data.byteLength)),
          largestPathBytes: Math.max(...plan.chunks.map((chunk) => `${base}${openChunkPath(chunk.path)}`.length)),
          runs,
        };
      } finally {
        transport.close();
      }
    }
    case "close": {
      const page = requireState();
      page.transport.close();
      page.prover.dispose();
      return {};
    }
  }
}

function pageError(error: {} | null | undefined): PageError {
  return {
    name: error instanceof Error ? error.name : "Error",
    code: error instanceof SdkError ? error.code : null,
    serviceCode: error instanceof ServiceError ? error.serviceCode : null,
    message: error instanceof Error ? error.message : String(error),
  };
}

window.anonE2E = async (requestJson) => {
  try {
    return JSON.stringify({ ok: true, value: await handle(requestJson) });
  } catch (error) {
    const failure = pageError(error);
    progress(`error: ${failure.code ?? failure.name}: ${failure.serviceCode ?? ""} ${failure.message}`);
    return JSON.stringify({ ok: false, error: failure });
  }
};
document.body.dataset["ready"] = "true";
progress("page ready");

// Anon-RPC browser demo.
// This page makes an AnonRpcWorker, waits for it to become ready, sends
// eth_blockNumber two times through the anonymized fetch, and closes it.
import { AnonRpcWorker, RpcError } from "@anon-rpc/browser-harness";

// The worker networks from adopters.json5 (ethereum/anon-rpc, main).
// "chainId" is the chain of the specifier contract. The bootstrap RPC must
// read the contract from that chain. It is not the chain that the
// anonymized fetch can reach.
const WORKERS = {
  passthrough: {
    specifier: "0x4fd77be300f31c5fe6ab266d35d27750a3478d27",
    chainId: 1,
    anonymizes: false,
    config: undefined,
  },
  nox: {
    specifier: "0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A",
    chainId: 11155111,
    anonymizes: true,
    config: undefined,
  },
  nym: {
    specifier: "0x3aCD9742C68F6d993066Ae25533e09b9e1f60eD0",
    chainId: 1,
    anonymizes: true,
    config: undefined,
  },
  "tor-js": {
    specifier: "0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e",
    chainId: 1,
    anonymizes: true,
    // This is the demonstration gateway from adopters.json5. It can go away at any time.
    config: { gateways: ["152.236.3.22:12298:uEiCH0VdbhryzJcMtCfB0vLA4sOvHdQ4hq5w7CopcwU59bQ"] },
  },
};

// Public bootstrap RPCs, one for each specifier chain. They have no API key.
const BOOTSTRAP_RPC = {
  1: "https://ethereum-rpc.publicnode.com",
  11155111: "https://ethereum-sepolia-rpc.publicnode.com",
};

const READY_TIMEOUT_MS = 120_000;

const logEl = document.getElementById("log");
const t0 = performance.now();

function ms(start) {
  return `${Math.round(performance.now() - start)} ms`;
}

// Write one line to the page and to the console.
function log(kind, text) {
  const line = `[+${ms(t0)}] ${text}`;
  const div = document.createElement("div");
  div.className = kind;
  div.textContent = line;
  logEl.append(div);
  console.log(`[${kind}] ${line}`);
}

// A minimal EIP-1193 provider over plain fetch. The harness uses it one time
// to read the specifier contract.
function makeBootstrapProvider(url) {
  let nextId = 1;
  return {
    async request({ method, params }) {
      if (method === "eth_call" && Array.isArray(params) && params[0]) {
        log("stage", `resolving specifier: eth_call to ${params[0].to} via ${url}`);
      }
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params: params ?? [] }),
      });
      const json = await res.json();
      if (json.error) throw new Error(`bootstrap RPC error: ${json.error.message}`);
      return json.result;
    },
  };
}

// Tell the operator what an RpcError code means. Logic branches on code, never on message (SPEC §12).
function explainError(err) {
  if (!(err instanceof RpcError)) return `${err.name}: ${err.message}`;
  switch (err.code) {
    case "timeout":
      return `timeout: the worker did not answer in time (${err.message}). Mixnets can need more time to bootstrap. Try again.`;
    case "network-error":
      return `network-error: the worker could not reach its network or the RPC (${err.message}).`;
    case "bad-config":
      return `bad-config: the worker refused its config (${err.message}).`;
    case "unsupported":
    case "unsupported-platform":
      return `${err.code}: this browser does not supply a capability that the worker needs (${err.message}).`;
    case "permission-denied":
      return `permission-denied: ${err.message}`;
    case "cancelled":
    case "closed":
      return `${err.code}: the worker was closed or the call was aborted (${err.message}).`;
    case undefined:
      return `${err.name} (no code): ${err.message}`;
    default:
      return `${err.code}: ${err.message}`;
  }
}

// Make a timeout that rejects with an RpcError, so that the same switch handles it.
function rejectAfter(timeoutMs, what) {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new RpcError({ name: "TimeoutError", message: `${what} after ${timeoutMs} ms`, code: "timeout" })), timeoutMs);
  });
}

// Copy the worker's own log lines to the page until the worker closes.
async function pumpWorkerLogs(worker) {
  for (;;) {
    try {
      const { level, args } = await worker.acceptLog();
      log("worker", `worker ${level}: ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`);
    } catch {
      return;
    }
  }
}

async function callBlockNumber(worker, rpcUrl, label, anonOptions) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] });
  const start = performance.now();
  log("stage", `request sent (${label}): eth_blockNumber -> ${rpcUrl}${anonOptions ? ` anonOptions=${JSON.stringify(anonOptions)}` : ""}`);
  const res = await worker.fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    anonOptions,
  });
  const json = await res.json();
  if (json.error) throw new Error(`RPC error: ${json.error.message}`);
  log("ok", `response (${label}): HTTP ${res.status}, block ${Number.parseInt(json.result, 16)} (${json.result}) in ${ms(start)}`);
}

async function main() {
  const serverConfig = await (await fetch("/config.json")).json();
  const query = new URLSearchParams(location.search);
  const workerId = query.get("worker") ?? serverConfig.worker;
  const entry = WORKERS[workerId];
  if (!entry) throw new Error(`unknown worker "${workerId}". Use one of: ${Object.keys(WORKERS).join(", ")}`);
  const rpcUrl = query.get("rpc") ?? serverConfig.rpcUrl;
  const bootstrapUrl = query.get("bootstrap") || serverConfig.bootstrapRpcUrl || BOOTSTRAP_RPC[entry.chainId];

  log("stage", `worker=${workerId} specifier=${entry.specifier} specifierChain=${entry.chainId} bootstrap=${bootstrapUrl}`);
  if (!entry.anonymizes) log("err", "NOTE: the passthrough worker does NOT anonymize. It only shows the sandbox and hash pinning.");

  const provider = makeBootstrapProvider(bootstrapUrl);
  const chainId = Number.parseInt(await provider.request({ method: "eth_chainId", params: [] }), 16);
  if (chainId !== entry.chainId) {
    throw new Error(`bootstrap RPC is on chain ${chainId}, but the specifier is on chain ${entry.chainId}`);
  }

  // The harness adds its sandboxed iframe only after keccak256(bundle) == workerHash().
  // So the iframe shows that the bundle was verified.
  const bootStart = performance.now();
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (node instanceof HTMLIFrameElement && node.getAttribute("sandbox") === "allow-scripts") {
          log("stage", `bundle verified (keccak256 == workerHash), sandbox iframe created after ${ms(bootStart)}`);
          observer.disconnect();
        }
      }
    }
  });
  observer.observe(document.body, { childList: true });

  const worker = new AnonRpcWorker({
    address: entry.specifier,
    config: entry.config,
    preExisting: { rpcProvider: { request: ({ method, params }) => provider.request({ method, params }) } },
  });
  pumpWorkerLogs(worker);

  try {
    await Promise.race([worker.ready, rejectAfter(READY_TIMEOUT_MS, "worker.ready")]);
    log("ok", `ready after ${ms(bootStart)}`);
    await callBlockNumber(worker, rpcUrl, "call 1", undefined);
    await callBlockNumber(worker, rpcUrl, "call 2", { isolationKey: "demo-account-2" });
    log("ok", "DONE: all calls succeeded");
    document.body.dataset.status = "done";
  } finally {
    observer.disconnect();
    worker.close();
    log("stage", "worker closed");
  }
}

main().catch((err) => {
  log("err", `FAILED: ${explainError(err)}`);
  document.body.dataset.status = "failed";
});

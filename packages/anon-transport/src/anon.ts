// Anonymous transport over @anon-rpc/browser-harness. The same integration as
// anon-rpc-demo/src/app.js:
//
// 1. Check that the bootstrap RPC is on the specifier chain (LEARNINGS.md entry 8).
// 2. Make an AnonRpcWorker with preExisting.rpcProvider. The harness checks
//    keccak256(bundle) == workerHash() before it starts the worker.
// 3. Collect the worker logs with acceptLog (entry 13: the harness then stops the console echo).
// 4. Wait for worker.ready with a timeout (entry 14: use ready, not log lines, for control flow).
// 5. Send each request with anonOptions.isolationKey.
//
// The harness needs document.body (entry 6). Make the transport after the body exists.

import { AnonRpcWorker, RpcError, type LogEntry } from "@anon-rpc/browser-harness";
import { z } from "zod";
import { bootstrapChainId, makeBootstrapProvider, type BootstrapProvider } from "./bootstrap.ts";
import { TransportError, explainTransportError } from "./errors.ts";
import { isolationKeySchema, keyRecorder, pushLog, type Transport, type TransportLogEntry } from "./transport.ts";
import { BOOTSTRAP_RPC_URLS, DEFAULT_WORKER, WORKERS, workerIdSchema, type WorkerId } from "./workers.ts";

// The part of AnonRpcWorker that the transport uses. Tests give a fake.
export interface HarnessWorker {
  readonly ready: Promise<void>;
  fetch(input: string, init: RequestInit & { anonOptions?: { isolationKey?: string } }): Promise<Response>;
  acceptLog(): Promise<LogEntry>;
  close(): void;
}

export type HarnessFactory = (init: { readonly address: string; readonly provider: BootstrapProvider }) => HarnessWorker;

export interface AnonTransportOptions {
  // Anon-RPC worker. Default: nox.
  readonly worker?: WorkerId;
  // RPC on the specifier chain. Default: a public Sepolia RPC for Nox.
  readonly bootstrapRpcUrl?: string;
  // Time to wait for worker.ready. Default: 120 s (Nox is ready in about 4 s).
  readonly readyTimeoutMs?: number;
  // Fetch for the bootstrap RPC only. Default: globalThis.fetch.
  readonly bootstrapFetch?: typeof fetch;
  // Make the harness worker. Default: new AnonRpcWorker(...).
  readonly createWorker?: HarnessFactory;
  // Receives each log line as it arrives. Default: none. Never print secrets here.
  readonly onLog?: (entry: TransportLogEntry) => void;
}

const optionsSchema = z.object({
  worker: workerIdSchema.default(DEFAULT_WORKER),
  bootstrapRpcUrl: z.url().optional(),
  readyTimeoutMs: z.number().int().positive().default(120_000),
});

const defaultFactory: HarnessFactory = (init) =>
  new AnonRpcWorker({ address: init.address, config: undefined, preExisting: { rpcProvider: init.provider } });

// Reject after `timeoutMs` with an RpcError of code "timeout", so that one switch handles it.
function rejectAfter(timeoutMs: number, what: string): { readonly promise: Promise<never>; readonly cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new RpcError({ name: "TimeoutError", message: `${what} after ${timeoutMs} ms`, code: "timeout" })),
      timeoutMs,
    );
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

function renderArg(arg: LogEntry["args"][number]): string {
  switch (true) {
    case typeof arg === "string":
      return arg;
    case arg instanceof Uint8Array:
      return `<${arg.byteLength} bytes>`;
    default:
      return JSON.stringify(arg) ?? "undefined";
  }
}

// Start the worker and return a ready transport. Throw TransportError if it does not start.
export async function createAnonTransport(options: AnonTransportOptions = {}): Promise<Transport> {
  const parsed = optionsSchema.parse({
    worker: options.worker,
    bootstrapRpcUrl: options.bootstrapRpcUrl,
    readyTimeoutMs: options.readyTimeoutMs,
  });
  const entry = WORKERS[parsed.worker];
  const bootstrapUrl = parsed.bootstrapRpcUrl ?? BOOTSTRAP_RPC_URLS[entry.chainId];
  if (bootstrapUrl === undefined) {
    throw new TransportError("bad_config", `no bootstrap RPC for specifier chain ${entry.chainId}`);
  }
  const logs: TransportLogEntry[] = [];
  const start = Date.now();
  const log = (level: TransportLogEntry["level"], text: string): void => {
    const line = { atMs: Date.now() - start, level, text };
    pushLog(logs, line);
    options.onLog?.(line);
  };

  const provider = makeBootstrapProvider(bootstrapUrl, options.bootstrapFetch ?? globalThis.fetch.bind(globalThis), (text) =>
    log("info", text),
  );
  let chainId: number;
  try {
    chainId = await bootstrapChainId(provider);
  } catch (error) {
    throw new TransportError("boot_failed", `bootstrap RPC check failed: ${explainTransportError(error).message}`);
  }
  if (chainId !== entry.chainId) {
    throw new TransportError(
      "wrong_bootstrap_chain",
      `bootstrap RPC is on chain ${chainId}, but the ${parsed.worker} specifier is on chain ${entry.chainId}`,
    );
  }
  log("info", `worker=${parsed.worker} specifier=${entry.specifier} specifierChain=${entry.chainId}`);

  const worker = (options.createWorker ?? defaultFactory)({ address: entry.specifier, provider });
  let closed = false;
  const pumpLogs = async (): Promise<void> => {
    for (;;) {
      try {
        const { level, args } = await worker.acceptLog();
        log(level, `worker: ${args.map(renderArg).join(" ")}`);
      } catch {
        return;
      }
    }
  };
  pumpLogs().catch(() => undefined);

  const timeout = rejectAfter(parsed.readyTimeoutMs, "worker.ready");
  try {
    await Promise.race([worker.ready, timeout.promise]);
  } catch (error) {
    closed = true;
    worker.close();
    const failure = explainTransportError(error);
    log("error", `worker did not start: ${failure.code}: ${failure.message}`);
    throw failure;
  } finally {
    timeout.cancel();
  }
  log("info", `worker ready after ${Date.now() - start} ms`);

  const keys = keyRecorder();
  return {
    kind: "anon",
    logs,
    isolationKeys: keys.keys,
    close: () => {
      if (closed) return;
      closed = true;
      worker.close();
      log("info", "worker closed");
    },
    fetch: async (url, init, fetchOptions) => {
      if (closed) throw new TransportError("closed", "the anonymous transport is closed");
      const key = isolationKeySchema.safeParse(fetchOptions.isolationKey);
      if (!key.success) throw new TransportError("invalid_request", key.error.message);
      keys.record(key.data);
      try {
        return await worker.fetch(url, {
          method: init.method,
          ...(init.headers === undefined ? {} : { headers: { ...init.headers } }),
          ...(init.body === undefined ? {} : { body: init.body }),
          anonOptions: { isolationKey: key.data },
        });
      } catch (error) {
        // Fail the request. Do not fall back to a direct fetch.
        throw explainTransportError(error);
      }
    },
  };
}

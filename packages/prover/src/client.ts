// Page-side prover client. It owns one dedicated worker and sends it validated messages.

import type { InputMap } from "@noir-lang/noir_js";
import { ProverError } from "./errors.ts";
import {
  workerResponseSchema,
  type ProofResult,
  type ProverInfo,
  type ThreadMode,
  type WorkerRequest,
  type WorkerResponse,
} from "./messages.ts";

// The batch-open prover. Keep it separate from batch storage and request signing.
export interface BatchOpenProver {
  readonly info: ProverInfo;
  // Make one proof. The inputs are the circuit inputs by ABI parameter name.
  readonly prove: (inputs: InputMap) => Promise<ProofResult>;
  // Stop the worker. Later calls fail with the code "disposed".
  readonly dispose: () => void;
}

// The part of the DOM Worker that the client uses. Tests give a fake worker.
export interface WorkerLike {
  postMessage(message: WorkerRequest): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  terminate(): void;
}

export interface ProverOptions {
  // URL of the prover manifest.
  readonly manifestUrl: string;
  // The pinned SHA-256 digest of the manifest bytes, from the client configuration.
  readonly manifestSha256: string;
  // "scalar" works everywhere. "threaded" needs a cross-origin isolated page.
  readonly mode: ThreadMode;
  // Number of worker threads for the threaded build. Default: hardwareConcurrency, at most 8.
  readonly threads?: number;
  // Create the worker. Default: the module worker in worker.ts.
  readonly createWorker?: () => WorkerLike;
}

function defaultWorker(): WorkerLike {
  return new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "provekit-prover" });
}

function defaultThreads(): number {
  const cores = typeof navigator === "undefined" ? 1 : navigator.hardwareConcurrency;
  return Math.max(1, Math.min(8, cores));
}

interface Pending {
  readonly resolve: (result: ProofResult) => void;
  readonly reject: (error: ProverError) => void;
}

// Start a worker, load and check the artifacts, and return a ready prover.
export function createBatchOpenProver(options: ProverOptions): Promise<BatchOpenProver> {
  const worker = (options.createWorker ?? defaultWorker)();
  const pending = new Map<number, Pending>();
  let nextId = 0;
  let disposed = false;
  let ready: { resolve: (info: ProverInfo) => void; reject: (error: ProverError) => void } | undefined;

  const failAll = (error: ProverError): void => {
    ready?.reject(error);
    ready = undefined;
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };

  const handle = (response: WorkerResponse): void => {
    switch (response.type) {
      case "ready":
        ready?.resolve(response.info);
        ready = undefined;
        return;
      case "proof": {
        const entry = pending.get(response.id);
        pending.delete(response.id);
        entry?.resolve(response.result);
        return;
      }
      case "error": {
        const error = new ProverError(response.code, response.message);
        switch (response.id) {
          case null:
            failAll(error);
            return;
          default: {
            const entry = pending.get(response.id);
            pending.delete(response.id);
            entry?.reject(error);
            return;
          }
        }
      }
    }
  };

  worker.onmessage = (event) => {
    const response = workerResponseSchema.safeParse(event.data);
    switch (response.success) {
      case true:
        handle(response.data);
        return;
      case false:
        failAll(new ProverError("worker_failed", `worker message is not valid: ${response.error.message}`));
        return;
    }
  };
  worker.onerror = (event) => {
    event.preventDefault();
    failAll(new ProverError("worker_failed", `worker error: ${event.message}`));
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    worker.terminate();
    failAll(new ProverError("disposed", "the prover was disposed"));
  };

  const prove = (inputs: InputMap): Promise<ProofResult> => {
    if (disposed) return Promise.reject(new ProverError("disposed", "the prover was disposed"));
    const id = nextId;
    nextId += 1;
    return new Promise<ProofResult>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ type: "prove", id, inputs });
    });
  };

  return new Promise<ProverInfo>((resolve, reject) => {
    ready = { resolve, reject };
    worker.postMessage({
      type: "init",
      manifestUrl: new URL(options.manifestUrl, globalThis.location?.href).href,
      manifestSha256: options.manifestSha256,
      mode: options.mode,
      threads: options.threads ?? defaultThreads(),
    });
  }).then(
    (info) => ({ info, prove, dispose }),
    (error) => {
      dispose();
      throw error;
    },
  );
}

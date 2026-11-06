import { describe, expect, it } from "vitest";
import { createBatchOpenProver, type ProverOptions, type WorkerLike } from "./client.ts";
import { ProverError } from "./errors.ts";
import type { ProverInfo, WorkerRequest, WorkerResponse } from "./messages.ts";

const info: ProverInfo = {
  circuit: "provekit_sample",
  mode: "scalar",
  threads: 1,
  downloadBytes: 100,
  loadMs: 1,
  numConstraints: 10,
  numWitnesses: 20,
  numPublicInputs: 3,
};

// A fake worker. `reply` decides the responses to each request.
class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  readonly requests: WorkerRequest[] = [];
  readonly reply: (request: WorkerRequest) => object[];

  constructor(reply: (request: WorkerRequest) => object[]) {
    this.reply = reply;
  }

  postMessage(message: WorkerRequest): void {
    this.requests.push(message);
    for (const data of this.reply(message)) {
      queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data })));
    }
  }

  terminate(): void {
    this.terminated = true;
  }
}

function proofFor(request: WorkerRequest): WorkerResponse[] {
  switch (request.type) {
    case "init":
      return [{ type: "ready", info }];
    case "prove":
      return [
        {
          type: "proof",
          id: request.id,
          result: { proof: new Uint8Array([1, 2]), durationMs: 5, witnessMs: 1, provingMs: 4, wasmMemoryBytes: 65536 },
        },
      ];
  }
}

const options: ProverOptions = {
  manifestUrl: "https://example.test/manifest.json",
  manifestSha256: "a".repeat(64),
  mode: "scalar",
};

describe("createBatchOpenProver", () => {
  it("sends init, then returns proofs by request id", async () => {
    const worker = new FakeWorker(proofFor);
    const prover = await createBatchOpenProver({ ...options, createWorker: () => worker });
    expect(prover.info).toEqual(info);
    const [first, second] = await Promise.all([prover.prove({ x: "1" }), prover.prove({ x: "2" })]);
    expect(Array.from(first.proof)).toEqual([1, 2]);
    expect(second.wasmMemoryBytes).toBe(65536);
    expect(worker.requests.map((request) => request.type)).toEqual(["init", "prove", "prove"]);
    expect(worker.requests[0]).toMatchObject({ type: "init", mode: "scalar", threads: expect.any(Number) });
  });

  it("rejects with the worker error code and stops the worker on an init error", async () => {
    const worker = new FakeWorker(() => [{ type: "error", id: null, code: "artifact_digest_mismatch", message: "bad" }]);
    const result = createBatchOpenProver({ ...options, createWorker: () => worker });
    await expect(result).rejects.toMatchObject({ code: "artifact_digest_mismatch" });
    expect(worker.terminated).toBe(true);
  });

  it("rejects one proof with its error and keeps the prover", async () => {
    const worker = new FakeWorker((request) =>
      request.type === "init"
        ? [{ type: "ready", info }]
        : [{ type: "error", id: request.id, code: "witness_failed", message: "batch expired" }],
    );
    const prover = await createBatchOpenProver({ ...options, createWorker: () => worker });
    await expect(prover.prove({ x: "1" })).rejects.toMatchObject({ code: "witness_failed" });
    expect(worker.terminated).toBe(false);
  });

  it("rejects a worker message that is not valid", async () => {
    const worker = new FakeWorker(() => [{ type: "ready", info: { circuit: 1 } }]);
    await expect(createBatchOpenProver({ ...options, createWorker: () => worker })).rejects.toMatchObject({
      code: "worker_failed",
    });
  });

  it("fails after dispose", async () => {
    const worker = new FakeWorker(proofFor);
    const prover = await createBatchOpenProver({ ...options, createWorker: () => worker });
    prover.dispose();
    expect(worker.terminated).toBe(true);
    await expect(prover.prove({ x: "1" })).rejects.toBeInstanceOf(ProverError);
    await expect(prover.prove({ x: "1" })).rejects.toMatchObject({ code: "disposed" });
  });
});

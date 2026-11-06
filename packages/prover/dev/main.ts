// Test page for the ProveKit browser adapter. It proves the sample circuit and writes the
// result as JSON into #result. dev/gate.ts drives this page in headless Chromium.
//
// Query parameters: manifest (URL), sha256 (pinned manifest digest), mode (scalar or
// threaded), threads, runs (number of proofs; the first proof is cold).

import { createBatchOpenProver, ProverError, threadModeSchema, type ProofResult } from "../src/index.ts";

// The sample witness. These are the values in circuits/provekit-sample/Prover.toml.
// They are test values, not secrets.
const SAMPLE_INPUTS = {
  secret: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd",
  expiry: "1000",
  leaf_index: "42435",
  siblings: Array.from({ length: 16 }, (_, level) => String(100 + level)),
  root: "0x2defe77ad67d41ed53118ca13e97d82c88a0796fc3adb8858509598d115eccb1",
  batch_id: "0x00292c827d85a6f524c3dc038c7d1fef7c3a63d666fc46b710ff5c98eeed772e",
  epoch: "999",
};

const params = new URL(location.href).searchParams;
const output = document.getElementById("result");

function report(status: "done" | "error", body: object): void {
  if (output !== null) output.textContent = JSON.stringify(body);
  document.body.dataset["status"] = status;
}

function summary(result: ProofResult): object {
  return {
    durationMs: result.durationMs,
    witnessMs: result.witnessMs,
    provingMs: result.provingMs,
    proofBytes: result.proof.byteLength,
    wasmMemoryBytes: result.wasmMemoryBytes,
  };
}

async function run(): Promise<void> {
  const mode = threadModeSchema.parse(params.get("mode") ?? "scalar");
  const runs = Math.max(1, Number(params.get("runs") ?? "2"));
  const threadsParam = params.get("threads");
  const start = performance.now();
  const prover = await createBatchOpenProver({
    manifestUrl: params.get("manifest") ?? "/provekit-sample/prover-manifest.json",
    manifestSha256: params.get("sha256") ?? "",
    mode,
    ...(threadsParam === null ? {} : { threads: Number(threadsParam) }),
  });
  const results: ProofResult[] = [];
  let coldMs = 0;
  try {
    for (let index = 0; index < runs; index += 1) {
      results.push(await prover.prove(SAMPLE_INPUTS));
      if (index === 0) coldMs = performance.now() - start;
    }
  } finally {
    prover.dispose();
  }
  const first = results[0];
  report("done", {
    info: prover.info,
    crossOriginIsolated,
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    // Page start to the first proof: worker start, downloads, checks, init, and one proof.
    coldMs,
    runs: results.map(summary),
    proofText: first === undefined ? "" : new TextDecoder().decode(first.proof),
  });
}

run().catch((error) => {
  report("error", {
    code: error instanceof ProverError ? error.code : "page_error",
    message: error instanceof Error ? error.message : String(error),
  });
});

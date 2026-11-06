// The dedicated prover worker. It runs ProveKit WASM and Noir witness generation off the
// main thread. Private inputs stay in this worker and in the page. The worker sends no
// network request except the artifact downloads in the manifest.
//
// Messages: see messages.ts. The page must send "init" once, then "prove" any number of times.

import { Noir, acvm, type CompiledCircuit, type InputMap } from "@noir-lang/noir_js";
import { z } from "zod";
import { fetchVerified, type FetchFunction } from "./artifacts.ts";
import { BATCH_OPEN_CIRCUIT, BATCH_OPEN_PUBLIC_INPUT_COUNT, checkBatchOpenAbi } from "./batch-open.ts";
import { ProverError, type ProverErrorCode } from "./errors.ts";
import { parseCircuit } from "./inputs.ts";
import { loadManifest, type FileEntry, type ProverManifest } from "./manifest.ts";
import { workerRequestSchema, type ProverInfo, type ThreadMode, type WorkerResponse } from "./messages.ts";

// The wasm-bindgen API of tooling/provekit-wasm at the pinned ProveKit commit.
interface WasmProver {
  getCircuit(): Uint8Array;
  getNumConstraints(): number;
  getNumWitnesses(): number;
  // Consumes the prover. The proof is the JSON encoding of the native ProveKit proof.
  proveBytes(witness: Map<number, string>): Uint8Array;
  free(): void;
}
type WasmProverConstructor = new (proverKey: Uint8Array) => WasmProver;
type WasmInit = (input: { module_or_path: BufferSource }) => Promise<object>;

const glueSchema = z.object({
  default: z.custom<WasmInit>((value) => typeof value === "function"),
  Prover: z.custom<WasmProverConstructor>((value) => typeof value === "function"),
  initPanicHook: z.custom<() => void>((value) => typeof value === "function"),
  initThreadPool: z
    .custom<(threads: number) => Promise<object>>((value) => typeof value === "function")
    .optional(),
});
type Glue = z.infer<typeof glueSchema>;

const initOutputSchema = z.object({ memory: z.instanceof(WebAssembly.Memory) });

interface Loaded {
  readonly glue: Glue;
  readonly proverKey: Uint8Array<ArrayBuffer>;
  readonly noir: Noir;
  readonly memory: WebAssembly.Memory;
}

let loaded: Promise<Loaded> | undefined;

const fetchFn: FetchFunction = (url) => fetch(url, { credentials: "omit", cache: "no-store" });

function post(response: WorkerResponse, transfer: Transferable[] = []): void {
  postMessage(response, { transfer });
}

function fail(id: number | null, error: Error | string | object): void {
  const code: ProverErrorCode = error instanceof ProverError ? error.code : "worker_failed";
  const message = error instanceof Error ? error.message : String(error);
  post({ type: "error", id, code, message });
}

// Import the glue module. For the scalar build, import the verified bytes from a blob URL,
// so the code that runs is the code that was checked. The threaded glue imports its worker
// helper by a relative path, so it is imported by URL after the digest check of both files.
async function importGlue(mode: ThreadMode, bytes: Uint8Array<ArrayBuffer>, url: URL): Promise<Glue> {
  let module: Record<string, object>;
  switch (mode) {
    case "scalar": {
      const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "text/javascript" }));
      try {
        module = await import(/* @vite-ignore */ blobUrl);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
      break;
    }
    case "threaded":
      module = await import(/* @vite-ignore */ url.href);
      break;
  }
  const parsed = glueSchema.safeParse(module);
  if (!parsed.success) {
    throw new ProverError("wasm_invalid", `ProveKit glue module is not valid: ${parsed.error.message}`);
  }
  return parsed.data;
}

interface Variant {
  readonly glue: FileEntry;
  readonly binary: FileEntry;
  readonly helper: FileEntry | undefined;
}

function selectVariant(manifest: ProverManifest, mode: ThreadMode): Variant {
  switch (mode) {
    case "scalar":
      return { ...manifest.wasm.scalar, helper: undefined };
    case "threaded": {
      const threaded = manifest.wasm.threaded;
      if (threaded === undefined) {
        throw new ProverError("threads_unavailable", "the manifest has no threaded build");
      }
      if (!crossOriginIsolated || typeof SharedArrayBuffer === "undefined") {
        throw new ProverError(
          "threads_unavailable",
          "the threaded build needs a cross-origin isolated page (COOP same-origin, COEP require-corp)",
        );
      }
      return threaded;
    }
  }
}

// A manifest that names a known circuit must carry the prover key of that circuit.
function checkCircuit(manifest: ProverManifest, circuit: CompiledCircuit): void {
  switch (manifest.circuit) {
    case BATCH_OPEN_CIRCUIT:
      checkBatchOpenAbi(circuit.abi);
      if (manifest.numPublicInputs !== BATCH_OPEN_PUBLIC_INPUT_COUNT) {
        throw new ProverError("circuit_mismatch", `the batch-open manifest has ${manifest.numPublicInputs} public inputs`);
      }
      return;
    default:
      return;
  }
}

async function load(
  manifestUrl: URL,
  manifestSha256: string,
  mode: ThreadMode,
  threads: number,
): Promise<{ loaded: Loaded; info: ProverInfo }> {
  const start = performance.now();
  const manifest = await loadManifest(fetchFn, manifestUrl, manifestSha256);
  const variant = selectVariant(manifest, mode);
  const [glueBytes, wasmBytes, proverKey] = await Promise.all([
    fetchVerified(fetchFn, manifestUrl, variant.glue),
    fetchVerified(fetchFn, manifestUrl, variant.binary),
    fetchVerified(fetchFn, manifestUrl, manifest.pkp),
  ]);
  const helperBytes = variant.helper === undefined ? 0 : (await fetchVerified(fetchFn, manifestUrl, variant.helper)).byteLength;

  const glue = await importGlue(mode, glueBytes, new URL(variant.glue.path, manifestUrl));
  const output = initOutputSchema.safeParse(await glue.default({ module_or_path: wasmBytes }));
  if (!output.success) {
    throw new ProverError("wasm_invalid", "ProveKit WASM init did not return its memory");
  }
  glue.initPanicHook();
  switch (mode) {
    case "scalar":
      break;
    case "threaded": {
      if (glue.initThreadPool === undefined) {
        throw new ProverError("threads_unavailable", "the threaded glue has no initThreadPool");
      }
      await glue.initThreadPool(threads);
      break;
    }
  }

  const probe = new glue.Prover(proverKey);
  let circuit: CompiledCircuit;
  let numConstraints: number;
  let numWitnesses: number;
  try {
    circuit = parseCircuit(new TextDecoder().decode(probe.getCircuit()));
    numConstraints = probe.getNumConstraints();
    numWitnesses = probe.getNumWitnesses();
  } finally {
    probe.free();
  }
  checkCircuit(manifest, circuit);
  const noir = new Noir(circuit);
  await noir.init();

  const info: ProverInfo = {
    circuit: manifest.circuit,
    mode,
    threads: mode === "scalar" ? 1 : threads,
    downloadBytes: glueBytes.byteLength + wasmBytes.byteLength + proverKey.byteLength + helperBytes,
    loadMs: performance.now() - start,
    numConstraints,
    numWitnesses,
    numPublicInputs: manifest.numPublicInputs,
  };
  return { loaded: { glue, proverKey, noir, memory: output.data.memory }, info };
}

async function prove(id: number, inputs: InputMap): Promise<void> {
  if (loaded === undefined) {
    throw new ProverError("worker_failed", "prove before init");
  }
  const { glue, proverKey, noir, memory } = await loaded;
  const start = performance.now();
  let witness: Map<number, string>;
  try {
    const executed = await noir.execute(inputs);
    const main = acvm.decompressWitnessStack(executed.witness)[0];
    if (main === undefined) {
      throw new ProverError("witness_failed", "the witness stack is empty");
    }
    witness = main.witness;
  } catch (error) {
    throw error instanceof ProverError
      ? error
      : new ProverError("witness_failed", error instanceof Error ? error.message : "witness generation failed");
  }
  const witnessDone = performance.now();
  // The WASM prover is consumed by one proof. Decode the prover key again for each proof.
  const prover = new glue.Prover(proverKey);
  let proof: Uint8Array;
  try {
    proof = prover.proveBytes(witness);
  } catch (error) {
    throw new ProverError("proving_failed", error instanceof Error ? error.message : "proving failed");
  } finally {
    prover.free();
  }
  const end = performance.now();
  const copy = new Uint8Array(proof);
  post(
    {
      type: "proof",
      id,
      result: {
        proof: copy,
        durationMs: end - start,
        witnessMs: witnessDone - start,
        provingMs: end - witnessDone,
        wasmMemoryBytes: memory.buffer.byteLength,
      },
    },
    [copy.buffer],
  );
}

addEventListener("message", (event: MessageEvent) => {
  const request = workerRequestSchema.safeParse(event.data);
  if (!request.success) {
    fail(null, new ProverError("worker_failed", `request is not valid: ${request.error.message}`));
    return;
  }
  const message = request.data;
  switch (message.type) {
    case "init": {
      if (loaded !== undefined) {
        fail(null, new ProverError("worker_failed", "init was already sent"));
        return;
      }
      const started = load(new URL(message.manifestUrl), message.manifestSha256, message.mode, message.threads);
      loaded = started.then((result) => result.loaded);
      // The "ready" or "error" message below reports the init result. A later prove
      // awaits `loaded` again and reports its own error.
      loaded.catch(() => undefined);
      started.then(
        (result) => post({ type: "ready", info: result.info }),
        (error) => fail(null, error),
      );
      return;
    }
    case "prove":
      prove(message.id, message.inputs).catch((error) => fail(message.id, error));
      return;
  }
});

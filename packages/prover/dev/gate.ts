// Phase 1 ProveKit gate: the browser proves a circuit and the Rust verifier verifies the
// browser proof.
//
// Circuits: --circuit sample (circuits/provekit-sample, the default) or --circuit batch-open
// (circuits/batch-open with the real 100-leaf gate witness).
//
// Steps:
// 1. Write the prover manifest of the circuit with the size and SHA-256 digest of every
//    artifact. The manifest digest is the pin that the page receives.
// 2. Serve the test page with Vite: one server without and one with COOP/COEP headers.
// 3. In headless Chromium, prove with the scalar build (no isolation) and the threaded
//    build (isolated). Each page makes `runs` proofs; the first is cold.
// 4. Verify each browser proof with crates/prover (release build). Check that a tampered
//    proof is rejected, and, for each public input one at a time, that a wrong expected value
//    and an altered value in the proof are rejected.
// 5. Write the results file. With GATE_WRITE_FIXTURE=1, also replace the checked-in Rust test
//    fixture proof.browser.json of the circuit. Proofs are randomized, so each run gives
//    different proof bytes.
//
// Needs: tooling/provekit/prepare-sample.sh or prepare-batch-open.sh, build-wasm.sh outputs,
// the nightly toolchain for crates/prover, and Chromium (CHROMIUM_PATH or the Playwright cache).
// Usage: node packages/prover/dev/gate.ts [--circuit sample|batch-open]

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, homedir, platform, release, tmpdir, totalmem } from "node:os";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";
import { z } from "zod";

const repo = new URL("../../../", import.meta.url).pathname;
const artifacts = join(repo, "artifacts");
const wasmDir = join(artifacts, "provekit-wasm");
const pins = readFileSync(join(repo, "tooling/provekit/pins.env"), "utf8");
const runs = Number(process.env["GATE_RUNS"] ?? "3");
const timeoutMs = Number(process.env["GATE_TIMEOUT_MS"] ?? "300000");
const writeFixture = process.env["GATE_WRITE_FIXTURE"] === "1";

// One circuit of the gate.
interface CircuitConfig {
  // The page parameter and the name in the results.
  readonly name: "sample" | "batch-open";
  // The manifest `circuit` value (the Noir package name).
  readonly manifestCircuit: string;
  // The artifact directory and the key files in it.
  readonly dir: string;
  readonly pkp: string;
  readonly pkv: string;
  // The expected public inputs, in circuit order.
  readonly publicInputs: readonly string[];
  readonly publicInputNames: readonly string[];
  readonly prepareScript: string;
  readonly resultsFile: string;
}

const contractSchema = z.object({
  order: z.array(z.object({ index: z.number(), name: z.string() })),
  gate_case: z.object({ name: z.string(), public_inputs: z.array(z.string()) }),
});

function circuitConfig(name: string): CircuitConfig {
  switch (name) {
    case "sample":
      return {
        name,
        manifestCircuit: "provekit_sample",
        dir: join(artifacts, "provekit-sample"),
        pkp: "sample.pkp",
        pkv: "sample.pkv",
        publicInputs: [
          "0x2defe77ad67d41ed53118ca13e97d82c88a0796fc3adb8858509598d115eccb1",
          "0x292c827d85a6f524c3dc038c7d1fef7c3a63d666fc46b710ff5c98eeed772e",
          "0x3e7",
        ],
        publicInputNames: ["root", "batch_id", "epoch"],
        prepareScript: "tooling/provekit/prepare-sample.sh",
        resultsFile: join(artifacts, "provekit-sample-results.json"),
      };
    case "batch-open": {
      // The order contract is the source of the expected public inputs.
      const contract = contractSchema.parse(
        JSON.parse(readFileSync(join(repo, "fixtures/protocol/batch-open-public-inputs.json"), "utf8")),
      );
      return {
        name,
        manifestCircuit: "batch_open",
        dir: join(artifacts, "batch-open"),
        pkp: "batch-open.pkp",
        pkv: "batch-open.pkv",
        publicInputs: contract.gate_case.public_inputs,
        publicInputNames: contract.order.map((entry) => entry.name),
        prepareScript: "tooling/provekit/prepare-batch-open.sh",
        resultsFile: join(artifacts, "batch-open-results.json"),
      };
    }
    default:
      throw new Error(`unknown circuit ${name}; use sample or batch-open`);
  }
}

function circuitArgument(): string {
  const index = process.argv.indexOf("--circuit");
  switch (index) {
    case -1:
      return "sample";
    default:
      return process.argv[index + 1] ?? "";
  }
}

const config = circuitConfig(circuitArgument());

function pin(name: string): string {
  const match = new RegExp(`^${name}=(.+)$`, "m").exec(pins);
  if (match?.[1] === undefined) throw new Error(`pins.env has no ${name}`);
  return match[1];
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// A manifest entry. The path is relative to the manifest file.
function entry(path: string): { path: string; sha256: string; bytes: number } {
  if (!existsSync(path)) {
    throw new Error(`${relative(repo, path)} is missing. Run ${config.prepareScript} and build-wasm.sh.`);
  }
  const bytes = readFileSync(path);
  return { path: relative(config.dir, path), sha256: sha256(bytes), bytes: bytes.byteLength };
}

function helperPath(): string {
  const snippets = join(wasmDir, "threaded/snippets");
  const dir = readdirSync(snippets).find((name) => name.startsWith("wasm-bindgen-rayon-"));
  if (dir === undefined) throw new Error("threaded build has no wasm-bindgen-rayon snippet");
  return join(snippets, dir, "src/workerHelpers.js");
}

function writeManifest(): { path: string; sha256: string; manifest: object } {
  const manifest = {
    format: "anon-credit/prover-manifest/v1",
    circuit: config.manifestCircuit,
    provekit: {
      repo: pin("PROVEKIT_REPO"),
      rev: pin("PROVEKIT_REV"),
      witnessMode: pin("PROVEKIT_WITNESS_MODE"),
      hash: pin("PROVEKIT_HASH"),
    },
    noir: pin("NOIR_VERSION"),
    numPublicInputs: config.publicInputs.length,
    pkp: entry(join(config.dir, config.pkp)),
    pkv: entry(join(config.dir, config.pkv)),
    wasm: {
      scalar: {
        glue: entry(join(wasmDir, "scalar/provekit_wasm.js")),
        binary: entry(join(wasmDir, "scalar/provekit_wasm_bg.wasm")),
      },
      threaded: {
        glue: entry(join(wasmDir, "threaded/provekit_wasm.js")),
        binary: entry(join(wasmDir, "threaded/provekit_wasm_bg.wasm")),
        helper: entry(helperPath()),
      },
    },
  };
  const path = join(config.dir, "prover-manifest.json");
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(path, text);
  return { path, sha256: sha256(Buffer.from(text)), manifest };
}

// Find Chromium: CHROMIUM_PATH, the Playwright default, then the newest cached Chromium.
function findChromium(): string {
  const configured = process.env["CHROMIUM_PATH"];
  if (configured !== undefined) return configured;
  const fallback = chromium.executablePath();
  if (existsSync(fallback)) return fallback;
  const cache =
    platform() === "darwin" ? join(homedir(), "Library/Caches/ms-playwright") : join(homedir(), ".cache/ms-playwright");
  const dirs = existsSync(cache)
    ? readdirSync(cache)
        .filter((dir) => /^chromium-\d+$/.test(dir))
        .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
    : [];
  for (const dir of dirs) {
    for (const rel of [
      "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
      "chrome-linux/chrome",
      "chrome-linux64/chrome",
    ]) {
      const path = join(cache, dir, rel);
      if (existsSync(path)) return path;
    }
  }
  throw new Error("no Chromium found. Run `npx playwright-core install chromium` or set CHROMIUM_PATH.");
}

async function startServer(port: number, isolated: boolean): Promise<ViteDevServer> {
  process.env["PROVER_DEV_PORT"] = String(port);
  process.env["PROVER_ISOLATED"] = isolated ? "1" : "0";
  const server = await createServer({
    configFile: new URL("./vite.config.ts", import.meta.url).pathname,
    logLevel: "warn",
  });
  await server.listen();
  return server;
}

const runSchema = z.object({
  durationMs: z.number(),
  witnessMs: z.number(),
  provingMs: z.number(),
  proofBytes: z.number(),
  wasmMemoryBytes: z.number().nullable(),
});
const pageResultSchema = z.object({
  circuit: z.string(),
  info: z.object({
    mode: z.string(),
    threads: z.number(),
    downloadBytes: z.number(),
    loadMs: z.number(),
    numConstraints: z.number(),
    numWitnesses: z.number(),
  }),
  crossOriginIsolated: z.boolean(),
  userAgent: z.string(),
  hardwareConcurrency: z.number(),
  coldMs: z.number(),
  runs: z.array(runSchema),
  proofText: z.string().min(1),
});
type PageResult = z.infer<typeof pageResultSchema>;

async function provePage(browserPath: string, url: string): Promise<PageResult> {
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  try {
    const page = await browser.newPage();
    page.on("pageerror", (error) => console.log(`page error> ${error.message}`));
    await page.goto(url);
    await page.waitForFunction(() => document.body.dataset["status"] !== undefined, null, { timeout: timeoutMs });
    const status = await page.evaluate(() => document.body.dataset["status"]);
    const text = (await page.textContent("#result")) ?? "";
    if (status !== "done") throw new Error(`page status ${status}: ${text}`);
    return pageResultSchema.parse(JSON.parse(text));
  } finally {
    await browser.close();
  }
}

const verifyOutputSchema = z.object({ result: z.literal("valid"), proof_bytes: z.number(), verify_ms: z.number() });
const benchOutputSchema = z.object({
  result: z.literal("valid"),
  verify_ms: z.object({ min: z.number(), median: z.number(), mean: z.number(), max: z.number() }),
});

const proverCli = join(repo, "crates/prover/target/release/anon-credit-prover");

function rustArgs(command: string, proof: string, publicInputs: readonly string[], pkvSha256: string): string[] {
  return [
    command,
    "--pkv",
    join(config.dir, config.pkv),
    "--pkv-sha256",
    pkvSha256,
    "--proof",
    proof,
    ...publicInputs.flatMap((input) => ["--public-input", input]),
  ];
}

function rustVerify(proof: string, publicInputs: readonly string[], pkvSha256: string): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(proverCli, rustArgs("verify", proof, publicInputs, pkvSha256), { encoding: "utf8" });
  return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
}

function rustBench(proof: string, pkvSha256: string, threads: string): z.infer<typeof benchOutputSchema> {
  const out = execFileSync(proverCli, [...rustArgs("bench", proof, config.publicInputs, pkvSha256), "--iterations", "50"], {
    encoding: "utf8",
    env: { ...process.env, RAYON_NUM_THREADS: threads },
  });
  return benchOutputSchema.parse(JSON.parse(out));
}

// Replace public input `index` in a JSON proof. The JSON form is little-endian hex.
function withPublicInput(proofText: string, index: number, value: bigint): string {
  const proof = z.object({ public_inputs: z.array(z.string()) }).loose().parse(JSON.parse(proofText));
  const bigEndian = value.toString(16).padStart(64, "0");
  const littleEndian = (bigEndian.match(/../g) ?? []).reverse().join("");
  proof.public_inputs[index] = littleEndian;
  return JSON.stringify(proof);
}

// The value plus one. No expected value is p - 1, so the result is a field element.
function plusOne(text: string): bigint {
  return BigInt(text) + 1n;
}

function hex64(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

// Change one character in the middle of narg_string. The JSON stays valid.
function tamper(proofText: string): string {
  const proof = z.object({ whir_r1cs_proof: z.object({ narg_string: z.string() }).loose() }).loose().parse(JSON.parse(proofText));
  const text = proof.whir_r1cs_proof.narg_string;
  const index = Math.floor(text.length / 2);
  const replacement = text[index] === "A" ? "B" : "A";
  proof.whir_r1cs_proof.narg_string = `${text.slice(0, index)}${replacement}${text.slice(index + 1)}`;
  return JSON.stringify(proof);
}

// The negative checks of one browser proof. Each must be rejected by the Rust verifier.
function negativeChecks(name: string, proofText: string, proofPath: string, scratch: string, pkvSha256: string): object {
  const tamperedPath = join(scratch, `${name}-tampered.json`);
  writeFileSync(tamperedPath, tamper(proofText));
  const tampered = rustVerify(tamperedPath, config.publicInputs, pkvSha256);
  if (tampered.ok) throw new Error(`GATE FAILED: Rust accepted a tampered ${name} proof`);
  const perInput: Record<string, object> = {};
  config.publicInputs.forEach((value, index) => {
    const input = config.publicInputNames[index] ?? String(index);
    const altered = plusOne(value);
    const wrongInputs = config.publicInputs.map((original, position) => (position === index ? hex64(altered) : original));
    // The gateway expects a different value than the proof has.
    const wrong = rustVerify(proofPath, wrongInputs, pkvSha256);
    if (wrong.ok) throw new Error(`GATE FAILED: Rust accepted the ${name} proof with a wrong expected ${input}`);
    // The proof and the expected values agree on the altered value, but the prover bound the original.
    const alteredPath = join(scratch, `${name}-altered-${index}.json`);
    writeFileSync(alteredPath, withPublicInput(proofText, index, altered));
    const alteredResult = rustVerify(alteredPath, wrongInputs, pkvSha256);
    if (alteredResult.ok) throw new Error(`GATE FAILED: Rust accepted a ${name} proof with an altered ${input}`);
    perInput[input] = {
      wrongExpectedValueRejected: wrong.stderr.trim(),
      alteredProofValueRejected: alteredResult.stderr.trim(),
    };
  });
  return { tamperedRejected: tampered.stderr.trim(), perPublicInput: perInput };
}

async function main(): Promise<void> {
  console.log(`circuit: ${config.name}`);
  const { sha256: manifestSha256, manifest } = writeManifest();
  console.log(`manifest sha256 ${manifestSha256}`);
  const pkvBytes = readFileSync(join(config.dir, config.pkv));
  const pkvSha256 = sha256(pkvBytes);

  console.log("build crates/prover (release)");
  execFileSync("cargo", ["build", "--release", "--quiet"], { cwd: join(repo, "crates/prover"), stdio: "inherit" });

  const browserPath = findChromium();
  const plain = await startServer(5181, false);
  const isolated = await startServer(5182, true);
  const scenarios = [
    { name: "scalar", port: 5181, mode: "scalar" },
    { name: "threaded", port: 5182, mode: "threaded" },
  ];
  const pages: Record<string, PageResult> = {};
  try {
    for (const scenario of scenarios) {
      const url = `http://localhost:${scenario.port}/?circuit=${config.name}&mode=${scenario.mode}&runs=${runs}&sha256=${manifestSha256}`;
      console.log(`prove in Chromium: ${scenario.name}`);
      pages[scenario.name] = await provePage(browserPath, url);
    }
  } finally {
    await plain.close();
    await isolated.close();
  }

  const scratch = mkdtempSync(join(tmpdir(), "provekit-gate-"));
  let browserProof = "";
  const verification: Record<string, object> = {};
  for (const [name, page] of Object.entries(pages)) {
    const proofPath = join(scratch, `${name}.json`);
    writeFileSync(proofPath, page.proofText);
    if (name === "scalar") browserProof = proofPath;
    const valid = rustVerify(proofPath, config.publicInputs, pkvSha256);
    if (!valid.ok) throw new Error(`GATE FAILED: Rust rejected the ${name} browser proof: ${valid.stderr}`);
    verification[name] = {
      valid: verifyOutputSchema.parse(JSON.parse(valid.stdout)),
      ...negativeChecks(name, page.proofText, proofPath, scratch, pkvSha256),
    };
    console.log(
      `Rust verify ${name}: valid; tampered proof rejected; each of ${config.publicInputs.length} public inputs rejected when wrong or altered`,
    );
  }

  if (writeFixture) {
    writeFileSync(join(config.dir, "proof.browser.json"), readFileSync(browserProof));
    console.log(`wrote ${relative(repo, join(config.dir, "proof.browser.json"))}`);
  }
  const nativeProof = join(config.dir, "proof.np");
  const wasmScalar = readFileSync(join(wasmDir, "scalar/provekit_wasm_bg.wasm"));
  const wasmThreaded = readFileSync(join(wasmDir, "threaded/provekit_wasm_bg.wasm"));
  const pkp = readFileSync(join(config.dir, config.pkp));
  const browserProofBytes = readFileSync(browserProof);
  const results = {
    gate: "browser proves, Rust verifies",
    status: "passed",
    date: new Date().toISOString(),
    machine: {
      os: `${platform()} ${release()}`,
      cpu: cpus()[0]?.model ?? "unknown",
      cores: cpus().length,
      memoryBytes: totalmem(),
    },
    versions: {
      provekitRev: pin("PROVEKIT_REV"),
      provekitRustToolchain: pin("PROVEKIT_RUST_TOOLCHAIN"),
      noir: pin("NOIR_VERSION"),
      wasmBindgen: pin("WASM_BINDGEN_VERSION"),
      noirJs: "1.0.0-beta.26",
      chromium: pages["scalar"]?.userAgent ?? "unknown",
    },
    proofSystem: { hash: pin("PROVEKIT_HASH"), witnessMode: pin("PROVEKIT_WITNESS_MODE") },
    circuit: {
      name: config.manifestCircuit,
      numConstraints: pages["scalar"]?.info.numConstraints,
      numWitnesses: pages["scalar"]?.info.numWitnesses,
      numPublicInputs: config.publicInputs.length,
      publicInputNames: config.publicInputNames,
    },
    manifestSha256,
    pkvSha256,
    manifest,
    artifactSize: {
      pkpBytes: pkp.byteLength,
      pkpGzipBytes: gzipSync(pkp).byteLength,
      pkvBytes: pkvBytes.byteLength,
      wasmScalarBytes: wasmScalar.byteLength,
      wasmThreadedBytes: wasmThreaded.byteLength,
    },
    proofSize: {
      browserJsonBytes: browserProofBytes.byteLength,
      browserJsonGzipBytes: gzipSync(browserProofBytes).byteLength,
      nativeBinaryBytes: readFileSync(nativeProof).byteLength,
    },
    artifactDownload: {
      scalar: {
        rawBytes: pages["scalar"]?.info.downloadBytes,
        gzipBytes: gzipSync(wasmScalar).byteLength + gzipSync(pkp).byteLength,
      },
      threaded: {
        rawBytes: pages["threaded"]?.info.downloadBytes,
        gzipBytes: gzipSync(wasmThreaded).byteLength + gzipSync(pkp).byteLength,
      },
      noirJsWasmBytes: "bundled by the page, not in the manifest",
    },
    browser: Object.fromEntries(
      Object.entries(pages).map(([name, page]) => [
        name,
        {
          crossOriginIsolated: page.crossOriginIsolated,
          threads: page.info.threads,
          hardwareConcurrency: page.hardwareConcurrency,
          loadMs: page.info.loadMs,
          coldFirstProofMs: page.coldMs,
          runs: page.runs,
        },
      ]),
    ),
    rustVerify: {
      perProof: verification,
      benchBrowserProofOneThread: rustBench(browserProof, pkvSha256, "1"),
      benchBrowserProofAllThreads: rustBench(browserProof, pkvSha256, String(cpus().length)),
    },
  };
  writeFileSync(config.resultsFile, `${JSON.stringify(results, null, 2)}\n`);
  console.log("GATE PASSED: browser proofs verified by the Rust verifier");
  console.log(`results: ${relative(repo, config.resultsFile)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

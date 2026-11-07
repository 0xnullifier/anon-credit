// Local stack for the customer app: anvil, the contracts, the verifier sidecar, the issuer, the
// gateway, and the Vite dev server of the app. The same bring-up as examples/e2e/integration.ts,
// with fixed ports and the demo block tag, so a person can drive the page in a real browser.
//
//   pnpm app:dev            (from the repository root)
//   node dev/stack.ts       (from packages/app)
//
// Settings (environment, optional):
//   APP_STACK_EPOCH_SECONDS   epoch length (default 30, the testnet demo value)
//   APP_STACK_BLOCK_TAG       finalized, safe, or latest (default latest: no finality wait)
//   APP_PORT                  Vite port (default 5175)
//   APP_STACK_SKIP_BUILD      1: use the binaries that exist
//
// Nox cannot reach localhost: the page uses the direct transport against this stack. The page
// gets the anvil test payer key (public, local test ETH only) as the development payer.
// It stops only the processes that it started. Logs go to a temporary directory (printed).

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, getContractAddress, http, toHex } from "viem";
import { mnemonicToAccount } from "viem/accounts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ANVIL_CHAIN_ID = 31_337;
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
const BATCH_PRICE_WEI = 100_000_000_000_000n;
const VERIFIER_PKV_SHA256 = "c8b4fb4722bb6d926d73112223865bd2756413f6f8085e549a90dd16a8aef6d4";
const MANIFEST_PATH = "batch-open/prover-manifest.json";

const PORTS = { anvil: 8545, issuer: 8080, gateway: 8081, admin: 8082, sidecar: 8083 };
const appPort = Number(process.env["APP_PORT"] ?? "5175");
const epochSeconds = Number(process.env["APP_STACK_EPOCH_SECONDS"] ?? "30");
const blockTag = process.env["APP_STACK_BLOCK_TAG"] ?? "latest";
const skipBuild = process.env["APP_STACK_SKIP_BUILD"] === "1";

const foundryBin = join(homedir(), ".foundry/bin");
const tool = (name: string): string => (existsSync(join(foundryBin, name)) ? join(foundryBin, name) : name);

function log(line: string): void {
  console.log(`[app-stack ${new Date().toISOString().slice(11, 19)}] ${line}`);
}

type Hex = `0x${string}`;

function anvilKey(index: number): { readonly key: string; readonly address: Hex } {
  const account = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index });
  const key = account.getHdKey().privateKey;
  if (key === null) throw new Error("anvil key derivation failed");
  return { key: toHex(key), address: `0x${account.address.slice(2).toLowerCase()}` };
}

const started: { readonly name: string; readonly child: ChildProcess }[] = [];

function start(name: string, command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, logDir: string): ChildProcess {
  const out = createWriteStream(join(logDir, `${name}.log`));
  const child = spawn(command, [...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.pipe(out);
  child.stderr?.pipe(out);
  child.once("exit", (code) => log(`${name} exited with code ${String(code)}; see ${join(logDir, `${name}.log`)}`));
  started.push({ name, child });
  return child;
}

async function stopAll(): Promise<void> {
  const running = started.filter((entry) => entry.child.exitCode === null && entry.child.signalCode === null);
  await Promise.all(
    running.map(
      (entry) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            entry.child.kill("SIGKILL");
            resolve();
          }, 5000);
          entry.child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
          entry.child.kill("SIGTERM");
        }),
    ),
  );
}

function run(name: string, command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, logDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(join(logDir, `${name}.log`));
    const child = spawn(command, [...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(out);
    child.stderr.pipe(out);
    child.once("error", reject);
    child.once("exit", (code) => {
      switch (code) {
        case 0:
          resolve();
          return;
        default:
          reject(new Error(`${name} failed with exit code ${String(code)}; see ${join(logDir, `${name}.log`)}`));
      }
    });
  });
}

async function waitFor(what: string, timeoutMs: number, probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await probe()) return;
    } catch {
      // Not ready yet.
    }
    if (Date.now() > deadline) throw new Error(`${what} did not become ready in ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function main(): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), "anon-credit-app-stack-"));
  log(`work directory (logs, databases): ${workDir}`);
  const env = { ...process.env, PATH: `${foundryBin}:${process.env["PATH"] ?? ""}`, RUST_LOG: "info", BLOCK_TAG: blockTag };

  if (!existsSync(join(REPO_ROOT, "artifacts/provekit-wasm/scalar/provekit_wasm_bg.wasm"))) {
    log("prover WASM is missing; running tooling/provekit/build-wasm.sh");
    await run("build-wasm", join(REPO_ROOT, "tooling/provekit/build-wasm.sh"), [], REPO_ROOT, env, workDir);
  }
  const manifestSha = `0x${createHash("sha256").update(readFileSync(join(REPO_ROOT, "artifacts", MANIFEST_PATH))).digest("hex")}`;
  if (!skipBuild) {
    log("building the issuer, the gateway, and the verifier sidecar");
    await run("cargo-build", "cargo", ["build", "--bin", "issuer", "--bin", "gateway"], REPO_ROOT, env, workDir);
    await run("sidecar-build", "cargo", ["build", "--release"], join(REPO_ROOT, "crates/prover"), env, workDir);
  }

  const anvilUrl = `http://127.0.0.1:${PORTS.anvil}`;
  const issuerUrl = `http://127.0.0.1:${PORTS.issuer}`;
  const gatewayUrl = `http://127.0.0.1:${PORTS.gateway}`;
  const appOrigins = [`http://localhost:${appPort}`, `http://127.0.0.1:${appPort}`];

  log(`starting anvil on ${anvilUrl} (1 s blocks, chain ${ANVIL_CHAIN_ID})`);
  start("anvil", tool("anvil"), ["--block-time", "1", "--port", String(PORTS.anvil), "--slots-in-an-epoch", "1", "--chain-id", String(ANVIL_CHAIN_ID)], workDir, env, workDir);
  const chain = createPublicClient({ transport: http(anvilUrl) });
  await waitFor("anvil", 30_000, async () => (await chain.getChainId()) === ANVIL_CHAIN_ID);

  const deployer = anvilKey(0);
  const issuer = anvilKey(1);
  const payer = anvilKey(2);
  const nonce = await chain.getTransactionCount({ address: deployer.address });
  const saleAddress = getContractAddress({ from: deployer.address, nonce: BigInt(nonce) }).toLowerCase();
  const registryAddress = getContractAddress({ from: deployer.address, nonce: BigInt(nonce + 1) }).toLowerCase();
  log("deploying CreditSale and RootRegistry");
  await run(
    "forge-deploy",
    tool("forge"),
    ["script", "script/Deploy.s.sol:Deploy", "--rpc-url", anvilUrl, "--broadcast", "--private-key", deployer.key],
    join(REPO_ROOT, "contracts"),
    { ...env, ISSUER_ADDRESS: issuer.address, BATCH_PRICE_WEI: BATCH_PRICE_WEI.toString(), EPOCH_SECONDS: String(epochSeconds) },
    workDir,
  );
  const startBlock = await chain.getBlockNumber();

  const deploymentPath = join(workDir, "deployment.toml");
  writeFileSync(
    deploymentPath,
    [
      "# Written by packages/app/dev/stack.ts for one local run.",
      "protocol_version = 1",
      `payment_chain_id = ${ANVIL_CHAIN_ID}`,
      `sale_address = "${saleAddress}"`,
      `root_registry_address = "${registryAddress}"`,
      `issuer_address = "${issuer.address}"`,
      `gateway_id = "0x${randomBytes(32).toString("hex")}"`,
      "batch_size = 100",
      `epoch_seconds = ${epochSeconds}`,
      "credit_lifetime_epochs = 35040",
      'circuit_id = "0x00000000000000616e6f6e2d6372656469742f76312f62617463682d6f70656e"',
      `verifier_artifact_hash = "0x${VERIFIER_PKV_SHA256}"`,
      `prover_manifest_hash = "${manifestSha}"`,
      "",
    ].join("\n"),
  );

  log("starting the verifier sidecar");
  start(
    "sidecar",
    join(REPO_ROOT, "crates/prover/target/release/anon-credit-prover"),
    ["serve", "--pkv", join(REPO_ROOT, "artifacts/batch-open/batch-open.pkv"), "--pkv-sha256", VERIFIER_PKV_SHA256, "--port", String(PORTS.sidecar)],
    REPO_ROOT,
    env,
    workDir,
  );
  await waitFor("sidecar", 60_000, async () => (await fetch(`http://127.0.0.1:${PORTS.sidecar}/health`)).ok);

  log(`starting the issuer on ${issuerUrl} (${epochSeconds} s epochs, block tag ${blockTag})`);
  start("issuer", join(REPO_ROOT, "target/debug/issuer"), [], workDir, {
    ...env,
    DEPLOYMENT_CONFIG: deploymentPath,
    EPOCH_SECONDS: String(epochSeconds),
    ISSUER_BIND: `127.0.0.1:${PORTS.issuer}`,
    ISSUER_DB_PATH: join(workDir, "issuer.db"),
    SEPOLIA_RPC_URL: anvilUrl,
    ISSUER_PRIVATE_KEY: issuer.key,
    ISSUER_START_BLOCK: startBlock.toString(),
    ISSUER_INDEX_POLL_SECONDS: "1",
    ISSUER_PUBLISH_POLL_SECONDS: "1",
  }, workDir);
  await waitFor("issuer", 60_000, async () => (await fetch(`${issuerUrl}/v1/config`)).ok);

  log(`starting the gateway on ${gatewayUrl} (CORS for ${appOrigins.join(", ")})`);
  start("gateway", join(REPO_ROOT, "target/debug/gateway"), [], workDir, {
    ...env,
    DEPLOYMENT_CONFIG: deploymentPath,
    EPOCH_SECONDS: String(epochSeconds),
    GATEWAY_PUBLIC_BIND: `127.0.0.1:${PORTS.gateway}`,
    GATEWAY_ADMIN_BIND: `127.0.0.1:${PORTS.admin}`,
    GATEWAY_DATABASE_PATH: join(workDir, "gateway.db"),
    GATEWAY_UPSTREAM_RPC_URL: anvilUrl,
    GATEWAY_ROOT_SOURCE: "contract",
    GATEWAY_ROOT_RPC_URL: anvilUrl,
    GATEWAY_ROOT_POLL_SECONDS: "1",
    GATEWAY_ADMIN_TOKEN: randomBytes(24).toString("hex"),
    GATEWAY_VERIFIER_URL: `http://127.0.0.1:${PORTS.sidecar}`,
    GATEWAY_CORS_ORIGINS: appOrigins.join(","),
    DEMO_IP_LOGGING: "true",
  }, workDir);
  await waitFor("gateway", 60_000, async () => (await fetch(`${gatewayUrl}/v1/config`)).ok);

  // The page: Vite with the service URLs and the development payer as VITE_* variables.
  process.env["VITE_GATEWAY_URL"] = gatewayUrl;
  process.env["VITE_ISSUER_URL"] = issuerUrl;
  process.env["VITE_DEV_PAYER_KEY"] = payer.key;
  process.env["VITE_DEV_RPC_URL"] = anvilUrl;
  const { createServer } = await import("vite");
  const server = await createServer({ root: APP_ROOT, configFile: join(APP_ROOT, "vite.config.ts"), server: { port: appPort, strictPort: true } });
  await server.listen();
  console.log("");
  log("stack is ready");
  console.log(`  app            http://localhost:${appPort}`);
  console.log(`  gateway        ${gatewayUrl}  (admin on 127.0.0.1:${PORTS.admin}, token in the gateway environment only)`);
  console.log(`  issuer         ${issuerUrl}`);
  console.log(`  anvil          ${anvilUrl}  (chain ${ANVIL_CHAIN_ID}, payer ${payer.address})`);
  console.log(`  epoch          ${epochSeconds} s, block tag ${blockTag}`);
  console.log(`  logs           ${workDir}`);
  console.log("  transport      direct (Nox cannot reach localhost); the page labels it as not private");
  console.log("");

  const stop = (): void => {
    log("stopping");
    Promise.all([server.close(), stopAll()]).finally(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  await stopAll();
  process.exit(1);
});

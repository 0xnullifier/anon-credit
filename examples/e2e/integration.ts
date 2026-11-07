// Local integration harness for phase 4 (not the Sepolia example).
//
// It starts anvil (1 s blocks), deploys CreditSale and RootRegistry with the Foundry script,
// starts the verifier sidecar, the issuer (5 s epochs), the gateway (contract root source), and
// the Vite page, and then runs the step list of implementation.md section 15 in headless
// Chromium with the DIRECT transport (Nox cannot reach localhost).
//
// Block tag: the harness uses the testnet demo profile. The issuer and the gateway read the
// chain at BLOCK_TAG=latest, and the client has no first-use delay (maxFirstUseDelayEpochs 0).
// Thus the epoch cadence (5 s) is the only pacing. The finalized default of production is
// covered by the Rust settings tests (crates/protocol/src/settings.rs).
//
// The harness stops only the child processes that it started. It writes
// examples/e2e/results/integration-result.json and exits nonzero on a failed step.
//
// Usage: node examples/e2e/integration.ts   (or: pnpm test:integration)
// Needs: ~/.foundry/bin/anvil and forge, cargo, the ProveKit nightly toolchain (for the sidecar
// build), Chromium (CHROMIUM_PATH or the Playwright cache).

import { randomBytes, createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, homedir, platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { createPublicClient, getContractAddress, http, toHex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { z } from "zod";
import { gatewayConfigResponseSchema, issuerConfigResponseSchema, type BlockTag } from "@anon-credit/protocol";
import { checkFunding, registerTopup, submitPurchase, waitForIssuance } from "@anon-credit/sdk/purchase";
import { adminCheck } from "./src/admin-check.ts";
import { findChromium } from "./src/chromium.ts";
import { MANIFEST_PATH, REPO_ROOT, startPageServer, type PageServer } from "./src/page-server.ts";
import { pageCaller } from "./src/page-driver.ts";
import { children, freePort, runCommand, waitFor } from "./src/processes.ts";
import { writeResult, type Json, type RunResult } from "./src/result.ts";
import { runScenario } from "./src/scenario.ts";

const EPOCH_SECONDS = 5;
// The testnet demo profile: read the chain at the latest block. Reorg safety is traded for speed.
const BLOCK_TAG: BlockTag = "latest";
const BATCH_PRICE_WEI = 100_000_000_000_000n;
const ANVIL_CHAIN_ID = 31_337;
// The public anvil test mnemonic. Its keys hold only local test ETH.
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
// A fixed public address that is not the payer (implementation.md section 15, step 9).
const TEST_ADDRESS = "0x000000000000000000000000000000000000dead";
const VERIFIER_PKV_SHA256 = "c8b4fb4722bb6d926d73112223865bd2756413f6f8085e549a90dd16a8aef6d4";
const RESULT_PATH = join(REPO_ROOT, "examples/e2e/results/integration-result.json");
const TIMEOUT_MS = Number(process.env["INTEGRATION_TIMEOUT_MS"] ?? "1200000");

const foundryBin = join(homedir(), ".foundry/bin");
const tool = (name: string): string => (existsSync(join(foundryBin, name)) ? join(foundryBin, name) : name);

function log(line: string): void {
  console.log(`[integration ${new Date().toISOString().slice(11, 19)}] ${line}`);
}

type Hex = `0x${string}`;

// Lowercase hex with the 0x type of viem.
function lowerHex(text: string): Hex {
  return `0x${text.slice(2).toLowerCase()}`;
}

function anvilKey(index: number): { readonly key: string; readonly address: Hex } {
  const account = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index });
  const key = account.getHdKey().privateKey;
  if (key === null) throw new Error("anvil key derivation failed");
  return { key: toHex(key), address: lowerHex(account.address) };
}

function sha256File(path: string): string {
  return `0x${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

async function getJson<S extends z.ZodType>(url: string, schema: S, headers: Record<string, string> = {}): Promise<z.output<S>> {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`GET ${url} returned ${response.status}`);
  return schema.parse(await response.json());
}

async function main(): Promise<number> {
  const startedAt = new Date();
  const workDir = mkdtempSync(join(tmpdir(), "anon-credit-integration-"));
  log(`work directory (logs, databases): ${workDir}`);
  const procs = children(workDir);
  let browser: Browser | undefined;
  let page: PageServer | undefined;
  const env = { ...process.env, PATH: `${foundryBin}:${process.env["PATH"] ?? ""}`, RUST_LOG: "info" };
  let deployment: Record<string, Json> = {};
  // Values that must never be in the result file.
  const secrets: string[] = [];

  const finish = async (): Promise<void> => {
    await browser?.close().catch(() => undefined);
    await page?.close().catch(() => undefined);
    await procs.stopAll();
  };
  process.once("SIGINT", () => {
    finish().finally(() => process.exit(130));
  });

  try {
    // Tools and artifacts.
    const chromiumPath = findChromium();
    if (!existsSync(join(REPO_ROOT, "artifacts/provekit-wasm/scalar/provekit_wasm_bg.wasm"))) {
      log("prover WASM is missing; run tooling/provekit/build-wasm.sh");
      await runCommand("build-wasm", join(REPO_ROOT, "tooling/provekit/build-wasm.sh"), [], { cwd: REPO_ROOT, env, logDir: workDir });
    }
    const manifestFile = join(REPO_ROOT, "artifacts", MANIFEST_PATH);
    const manifestSha = sha256File(manifestFile);
    log("building the issuer, the gateway, and the verifier sidecar");
    await runCommand("cargo-build", "cargo", ["build", "--bin", "issuer", "--bin", "gateway"], { cwd: REPO_ROOT, env, logDir: workDir });
    await runCommand("sidecar-build", "cargo", ["build", "--release"], { cwd: join(REPO_ROOT, "crates/prover"), env, logDir: workDir });

    const [anvilPort, issuerPort, gatewayPort, adminPort, sidecarPort, pagePort] = [
      await freePort(),
      await freePort(),
      await freePort(),
      await freePort(),
      await freePort(),
      await freePort(),
    ];
    const anvilUrl = `http://127.0.0.1:${anvilPort}`;
    const issuerUrl = `http://127.0.0.1:${issuerPort}`;
    const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
    const adminUrl = `http://127.0.0.1:${adminPort}`;
    const pageOrigin = `http://127.0.0.1:${pagePort}`;

    // Chain.
    log(`starting anvil on ${anvilUrl} (1 s blocks; the services read at the ${BLOCK_TAG} tag)`);
    procs.start("anvil", tool("anvil"), ["--block-time", "1", "--port", String(anvilPort), "--chain-id", String(ANVIL_CHAIN_ID)], {
      cwd: workDir,
      env,
    });
    const chain = createPublicClient({ transport: http(anvilUrl) });
    await waitFor("anvil", 30_000, async () => (await chain.getChainId()) === ANVIL_CHAIN_ID);

    // Contracts.
    const deployer = anvilKey(0);
    const issuer = anvilKey(1);
    const payer = anvilKey(2);
    const nonce = await chain.getTransactionCount({ address: deployer.address });
    const saleAddress = getContractAddress({ from: deployer.address, nonce: BigInt(nonce) }).toLowerCase();
    const registryAddress = getContractAddress({ from: deployer.address, nonce: BigInt(nonce + 1) }).toLowerCase();
    log("deploying CreditSale and RootRegistry with contracts/script/Deploy.s.sol");
    await runCommand(
      "forge-deploy",
      tool("forge"),
      ["script", "script/Deploy.s.sol:Deploy", "--rpc-url", anvilUrl, "--broadcast", "--private-key", deployer.key],
      {
        cwd: join(REPO_ROOT, "contracts"),
        env: { ...env, ISSUER_ADDRESS: issuer.address, BATCH_PRICE_WEI: BATCH_PRICE_WEI.toString(), EPOCH_SECONDS: String(EPOCH_SECONDS) },
        logDir: workDir,
      },
    );
    for (const address of [saleAddress, registryAddress]) {
      const code = await chain.getCode({ address: lowerHex(address) });
      if (code === undefined || code === "0x") throw new Error(`no contract at ${address}`);
    }
    const startBlock = await chain.getBlockNumber();

    // Deployment file. It must match the issuer EPOCH_SECONDS.
    const gatewayId = `0x${randomBytes(32).toString("hex")}`;
    const deploymentPath = join(workDir, "deployment.toml");
    writeFileSync(
      deploymentPath,
      [
        "# Written by examples/e2e/integration.ts for one local run.",
        "protocol_version = 1",
        `payment_chain_id = ${ANVIL_CHAIN_ID}`,
        `sale_address = "${saleAddress}"`,
        `root_registry_address = "${registryAddress}"`,
        `issuer_address = "${issuer.address}"`,
        `gateway_id = "${gatewayId}"`,
        "batch_size = 100",
        `epoch_seconds = ${EPOCH_SECONDS}`,
        "credit_lifetime_epochs = 35040",
        'circuit_id = "0x00000000000000616e6f6e2d6372656469742f76312f62617463682d6f70656e"',
        `verifier_artifact_hash = "0x${VERIFIER_PKV_SHA256}"`,
        `prover_manifest_hash = "${manifestSha}"`,
        "",
      ].join("\n"),
    );
    deployment = { chainId: ANVIL_CHAIN_ID, saleAddress, registryAddress, epochSeconds: EPOCH_SECONDS, proverManifestHash: manifestSha };

    // Verifier sidecar.
    log("starting the verifier sidecar");
    procs.start(
      "sidecar",
      join(REPO_ROOT, "crates/prover/target/release/anon-credit-prover"),
      ["serve", "--pkv", join(REPO_ROOT, "artifacts/batch-open/batch-open.pkv"), "--pkv-sha256", VERIFIER_PKV_SHA256, "--port", String(sidecarPort)],
      { cwd: REPO_ROOT, env },
    );
    await waitFor("sidecar", 60_000, async () => (await fetch(`http://127.0.0.1:${sidecarPort}/health`)).ok);

    // Issuer.
    log(`starting the issuer on ${issuerUrl} (${EPOCH_SECONDS} s epochs, block tag ${BLOCK_TAG})`);
    procs.start("issuer", join(REPO_ROOT, "target/debug/issuer"), [], {
      cwd: workDir,
      env: {
        ...env,
        DEPLOYMENT_CONFIG: deploymentPath,
        EPOCH_SECONDS: String(EPOCH_SECONDS),
        BLOCK_TAG,
        ISSUER_BIND: `127.0.0.1:${issuerPort}`,
        ISSUER_DB_PATH: join(workDir, "issuer.db"),
        SEPOLIA_RPC_URL: anvilUrl,
        ISSUER_PRIVATE_KEY: issuer.key,
        ISSUER_START_BLOCK: startBlock.toString(),
        ISSUER_INDEX_POLL_SECONDS: "1",
        ISSUER_PUBLISH_POLL_SECONDS: "1",
      },
    });
    await waitFor("issuer", 60_000, async () => (await fetch(`${issuerUrl}/v1/config`)).ok);

    // Gateway.
    const adminToken = randomBytes(24).toString("hex");
    const passphrase = randomBytes(18).toString("base64");
    secrets.push(adminToken, passphrase, deployer.key.slice(2), issuer.key.slice(2), payer.key.slice(2));
    log(`starting the gateway on ${gatewayUrl} (root source: contract at the ${BLOCK_TAG} tag)`);
    procs.start("gateway", join(REPO_ROOT, "target/debug/gateway"), [], {
      cwd: workDir,
      env: {
        ...env,
        DEPLOYMENT_CONFIG: deploymentPath,
        EPOCH_SECONDS: String(EPOCH_SECONDS),
        BLOCK_TAG,
        GATEWAY_PUBLIC_BIND: `127.0.0.1:${gatewayPort}`,
        GATEWAY_ADMIN_BIND: `127.0.0.1:${adminPort}`,
        GATEWAY_DATABASE_PATH: join(workDir, "gateway.db"),
        GATEWAY_UPSTREAM_RPC_URL: anvilUrl,
        GATEWAY_ROOT_SOURCE: "contract",
        GATEWAY_ROOT_RPC_URL: anvilUrl,
        GATEWAY_ROOT_POLL_SECONDS: "1",
        GATEWAY_ADMIN_TOKEN: adminToken,
        GATEWAY_VERIFIER_URL: `http://127.0.0.1:${sidecarPort}`,
        GATEWAY_CORS_ORIGINS: pageOrigin,
        DEMO_IP_LOGGING: "true",
      },
    });
    await waitFor("gateway", 60_000, async () => (await fetch(`${gatewayUrl}/v1/config`)).ok);

    // Page and browser.
    page = await startPageServer(pagePort, true);
    log(`page on ${page.url} (COOP/COEP on)`);
    browser = await chromium.launch({ executablePath: chromiumPath, headless: true });
    const context = await browser.newContext();
    const tab = await context.newPage();
    tab.on("console", (message) => {
      if (message.text().startsWith("[e2e")) log(`page ${message.text()}`);
    });
    tab.on("pageerror", (error) => log(`page error: ${error.message}`));
    await tab.goto(page.url);
    await tab.waitForSelector("body[data-ready=true]", { timeout: 120_000 });
    const call = pageCaller(tab);
    const authorization = { authorization: `Bearer ${adminToken}` };

    const scenario = runScenario({
      call,
      log,
      testAddress: TEST_ADDRESS,
      sale: { address: saleAddress, batchPriceWei: BATCH_PRICE_WEI },
      rootWait: `expected in at most one epoch (${EPOCH_SECONDS} s) plus about 2 s of chain latency (block tag ${BLOCK_TAG}, no first-use delay)`,
      setup: {
        gatewayUrl,
        issuerUrl,
        transport: "direct",
        readyTimeoutMs: 120_000,
        manifestUrl: MANIFEST_PATH,
        manifestSha256: manifestSha,
        proverMode: "auto",
        passphrase,
        firstUseDelayEpochs: "random",
        maxFirstUseDelayEpochs: 0,
        pollMs: 1000,
        eligibleTimeoutMs: 300_000,
      },
      preflight: async () => {
        const gatewayConfig = await getJson(`${gatewayUrl}/v1/config`, gatewayConfigResponseSchema);
        const issuerConfig = await getJson(`${issuerUrl}/v1/config`, issuerConfigResponseSchema);
        const health = await getJson(`http://127.0.0.1:${sidecarPort}/health`, z.object({ pkv_sha256: z.string(), witness_mode: z.string() }));
        const admin = await fetch(`${adminUrl}/admin/v1/snapshot`, { headers: authorization });
        const checks: Record<string, boolean> = {
          deploymentIdsAgree: gatewayConfig.deployment_id === issuerConfig.deployment_id,
          gatewayIdAgrees: gatewayConfig.gateway_id === gatewayId,
          paymentChain: issuerConfig.deployment.payment_chain_id === (await chain.getChainId()),
          upstreamChain: gatewayConfig.upstream_chain_id === ANVIL_CHAIN_ID,
          manifestPinned: issuerConfig.deployment.prover_manifest_hash === manifestSha,
          verifierPinned: health.pkv_sha256 === VERIFIER_PKV_SHA256 && health.witness_mode === "zk",
          blockTags: issuerConfig.block_tag === BLOCK_TAG && gatewayConfig.block_tag === BLOCK_TAG,
          adminAccess: admin.ok,
        };
        const failedChecks = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
        if (failedChecks.length > 0) throw new Error(`preflight checks failed: ${failedChecks.join(", ")}`);
        deployment = { ...deployment, deploymentId: gatewayConfig.deployment_id };
        return { ...checks, deploymentId: gatewayConfig.deployment_id };
      },
      purchase: async (commitments) => {
        const purchaseChain = { rpcUrl: anvilUrl, chainId: ANVIL_CHAIN_ID, saleAddress };
        const funding = await checkFunding(purchaseChain, payer.key, commitments);
        if (!funding.ok) throw new Error("the payer cannot pay for the purchase");
        const result = await submitPurchase(purchaseChain, payer.key, commitments, funding.priceWei);
        log(`purchase ${result.txHash} log ${result.logIndex} in block ${result.blockNumber}`);
        return { txHash: result.txHash, logIndex: result.logIndex, blockNumber: result.blockNumber.toString() };
      },
      waitIssuance: async (purchase) => {
        const issuerHttp = { issuerUrl };
        const first = await registerTopup(issuerHttp, purchase.txHash, purchase.logIndex);
        log(`topup registered: ${first.status}${first.pending_reason === null ? "" : ` (${first.pending_reason})`}`);
        return waitForIssuance(issuerHttp, purchase.txHash, purchase.logIndex, {
          pollMs: 1000,
          timeoutMs: 120_000,
          onProgress: (topup) => log(`topup: ${topup.status}${topup.pending_reason === null ? "" : ` (${topup.pending_reason})`}`),
        });
      },
      dashboardCheck: (batches, expected) => adminCheck({ adminUrl, token: adminToken }, batches, expected),
    });
    const timeout = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`the run did not end in ${TIMEOUT_MS} ms`)), TIMEOUT_MS).unref();
    });
    const outcome = await Promise.race([scenario, timeout]);
    const finishedAt = new Date();
    const result: RunResult = {
      format: "anon-credit/e2e-result/v1",
      profile: "local-anvil",
      status: outcome.passed ? "pass" : "fail",
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      transport: "direct",
      deployment,
      environment: {
        platform: `${platform()} ${release()}`,
        cpu: cpus()[0]?.model ?? "unknown",
        cores: cpus().length,
        node: process.version,
        chromium: browser.version(),
        rootSource: `contract (anvil ${BLOCK_TAG} tag)`,
        note: "local harness with the direct transport; the Sepolia run uses Nox",
      },
      steps: outcome.steps,
      error: null,
    };
    writeResult(RESULT_PATH, result, secrets);
    log(`result: ${result.status}; written to ${RESULT_PATH}`);
    for (const stepResult of outcome.steps) log(`  ${String(stepResult.id).padStart(2)} ${stepResult.status.padEnd(7)} ${stepResult.name}`);
    return outcome.passed ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`FAILED: ${message}`);
    const finishedAt = new Date();
    writeResult(RESULT_PATH, {
      format: "anon-credit/e2e-result/v1",
      profile: "local-anvil",
      status: "fail",
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      transport: "direct",
      deployment,
      environment: {},
      steps: [],
      error: message,
    }, secrets);
    return 1;
  } finally {
    await finish();
  }
}

process.exitCode = await main();

// The Sepolia end-to-end run (implementation.md section 15) and its --dry-run.
//
// The full run: preflight (step 1); stop before the purchase if a check fails. Then the shared
// step list in headless Chromium with the Nox transport, a real Sepolia purchase from the
// runner's test wallet, the chain waits of the reported block tag with progress lines, and a
// sanitized result file. The run exits nonzero on a failed step or on the timeout (default
// two hours).
//
// The waits follow the block tag of GET /v1/config (src/pacing.ts). With BLOCK_TAG=latest (the
// testnet demo), the run has no finality wait and no first-use delay: a purchase opens after
// the current epoch closes plus chain latency. With finalized, each chain wait is about 13
// minutes.

import { randomBytes } from "node:crypto";
import { chromium, type Browser } from "playwright-core";
import { registerTopup, submitPurchase, waitForIssuance } from "@anon-credit/sdk/purchase";
import { adminCheck } from "./admin-check.ts";
import { findChromium } from "./chromium.ts";
import { pageCaller } from "./page-driver.ts";
import { MANIFEST_PATH, startPageServer, type PageServer } from "./page-server.ts";
import { writeResult, type Json, type RunResult } from "./result.ts";
import { pacingFor } from "./pacing.ts";
import { runScenario } from "./scenario.ts";
import { ConfigError, defaultPreflightDeps, preflight, readSepoliaConfig, type PreflightDeps, type PreflightReport } from "./sepolia.ts";

export interface SepoliaRunDeps {
  readonly preflight: PreflightDeps;
  readonly log: (line: string) => void;
}

export const defaultSepoliaRunDeps: SepoliaRunDeps = {
  preflight: defaultPreflightDeps,
  log: (line) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}] ${line}`),
};

function printReport(report: PreflightReport, log: (line: string) => void): void {
  for (const check of report.checks) log(`  ${check.ok ? "ok  " : "FAIL"} ${check.name}: ${check.detail}`);
}

// Run the example. Return the process exit code.
export async function runSepolia(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, deps: SepoliaRunDeps = defaultSepoliaRunDeps): Promise<number> {
  const { log } = deps;
  const dryRun = argv.includes("--dry-run");
  let config;
  try {
    config = readSepoliaConfig(env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    log(`refused: ${error.message}`);
    return 2;
  }
  log(`${dryRun ? "dry run" : "run"}: gateway ${new URL(config.gatewayUrl).origin}, issuer ${new URL(config.issuerUrl).origin}`);
  log("step 1 preflight: identities, chain IDs, artifacts, connectivity, funding, admin access");
  const report = await preflight(config, deps.preflight);
  printReport(report, log);
  if (dryRun) {
    log(report.ok ? "dry run: all checks passed; no transaction was sent" : "dry run: a check failed");
    return report.ok ? 0 : 1;
  }
  if (!report.ok) {
    log("a preflight check failed; stop before the purchase");
    return 1;
  }
  const issuer = report.issuerConfig;
  if (issuer === null) return 1;
  const pacing = pacingFor(issuer.block_tag, issuer.deployment.epoch_seconds);
  log(`block tag ${pacing.blockTag}${pacing.blockTag === "latest" ? " (testnet demo: reorg safety traded for speed)" : ""}; expected waits:`);
  log(`  ${pacing.issuanceWait}`);
  log(`  ${pacing.rootWait}`);

  const startedAt = new Date();
  const passphrase = randomBytes(18).toString("base64");
  const secrets = [config.payerKey.slice(2), passphrase, config.paymentRpcUrl, config.admin?.token ?? ""];
  let browser: Browser | undefined;
  let page: PageServer | undefined;
  const deadline = Date.now() + config.timeoutMs;
  const remaining = (): number => Math.max(1000, deadline - Date.now());
  try {
    page = await startPageServer(config.pagePort, true);
    browser = await chromium.launch({ executablePath: findChromium(), headless: true });
    // No tracing, no HAR capture. Only "[e2e" progress lines leave the page.
    const tab = await (await browser.newContext()).newPage();
    tab.on("console", (message) => {
      if (message.text().startsWith("[e2e")) log(`page ${message.text()}`);
    });
    await tab.goto(page.url);
    await tab.waitForSelector("body[data-ready=true]", { timeout: 120_000 });
    const purchaseChain = { rpcUrl: config.paymentRpcUrl, chainId: issuer.deployment.payment_chain_id, saleAddress: issuer.deployment.sale_address };
    const admin = config.admin;

    const scenario = runScenario({
      call: pageCaller(tab),
      log,
      testAddress: config.testAddress,
      rootWait: pacing.rootWait,
      setup: {
        gatewayUrl: config.gatewayUrl,
        issuerUrl: config.issuerUrl,
        transport: "anon",
        ...(config.bootstrapRpcUrl === undefined ? {} : { bootstrapRpcUrl: config.bootstrapRpcUrl }),
        readyTimeoutMs: 180_000,
        manifestUrl: MANIFEST_PATH,
        manifestSha256: report.manifestSha256,
        proverMode: config.proverMode,
        passphrase,
        firstUseDelayEpochs: "random",
        maxFirstUseDelayEpochs: pacing.maxFirstUseDelayEpochs,
        pollMs: pacing.eligiblePollMs,
        eligibleTimeoutMs: remaining(),
      },
      preflight: async () => {
        const details: Record<string, Json> = {};
        for (const check of report.checks) details[check.name] = check.ok;
        return details;
      },
      purchase: async (commitments) => {
        log(`sending CreditSale.buy for ${commitments.length} batches (${issuer.batch_price_wei} wei each)`);
        const result = await submitPurchase(purchaseChain, config.payerKey, commitments, BigInt(issuer.batch_price_wei));
        log(`purchase ${result.txHash} log ${result.logIndex} in block ${result.blockNumber}`);
        return { txHash: result.txHash, logIndex: result.logIndex, blockNumber: result.blockNumber.toString() };
      },
      waitIssuance: async (purchase) => {
        const issuerHttp = { issuerUrl: config.issuerUrl };
        await registerTopup(issuerHttp, purchase.txHash, purchase.logIndex);
        log(`waiting for the issuance; ${pacing.issuanceWait}`);
        return waitForIssuance(issuerHttp, purchase.txHash, purchase.logIndex, {
          pollMs: pacing.issuancePollMs,
          timeoutMs: remaining(),
          onProgress: (topup) =>
            log(`topup ${topup.status}${topup.pending_reason === null ? "" : ` (${topup.pending_reason})`}, block ${topup.block_number ?? "?"}, finalized ${topup.finalized_block ?? "?"}`),
        });
      },
      ...(admin === undefined ? {} : { dashboardCheck: (batches: readonly string[], expected: readonly number[]) => adminCheck(admin, batches, expected) }),
    });
    const timeout = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`the run did not end in ${config.timeoutMs / 1000} s`)), config.timeoutMs).unref();
    });
    const outcome = await Promise.race([scenario, timeout]);
    const finishedAt = new Date();
    const result: RunResult = {
      format: "anon-credit/e2e-result/v1",
      profile: "sepolia",
      status: outcome.passed ? "pass" : "fail",
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      transport: "anon",
      deployment: report.deployment,
      environment: { node: process.version, chromium: browser.version(), worker: "nox" },
      steps: outcome.steps,
      error: null,
    };
    writeResult(config.resultPath, result, secrets);
    log(`result: ${result.status}; written to ${config.resultPath}`);
    return outcome.passed ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`FAILED: ${message}`);
    const finishedAt = new Date();
    writeResult(
      config.resultPath,
      {
        format: "anon-credit/e2e-result/v1",
        profile: "sepolia",
        status: "fail",
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        transport: "anon",
        deployment: report.deployment,
        environment: {},
        steps: [],
        error: secrets.some((secret) => secret.length >= 8 && message.includes(secret)) ? "error text withheld (it had a secret)" : message,
      },
      secrets,
    );
    return 1;
  } finally {
    await browser?.close().catch(() => undefined);
    await page?.close().catch(() => undefined);
  }
}

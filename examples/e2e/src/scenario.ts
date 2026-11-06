// The step list of implementation.md section 15, steps 1 to 15. The local integration
// harness and the Sepolia example run this same code. Only the transport, the endpoints, the
// purchase chain, and the timing differ.

import type { Issuance } from "@anon-credit/protocol";
import { z } from "zod";
import {
  attachValueSchema,
  batchesValueSchema,
  drainValueSchema,
  eligibleValueSchema,
  emptyValueSchema,
  openValueSchema,
  prepareValueSchema,
  probeValueSchema,
  replayValueSchema,
  rpcValueSchema,
  setupValueSchema,
  statusValueSchema,
  transportInfoValueSchema,
  type SetupRequest,
  type SetupValue,
} from "./page-api.ts";
import { expectPageError, type PageCall } from "./page-driver.ts";
import type { Json, StepResult } from "./result.ts";

export interface PurchaseOutcome {
  readonly txHash: string;
  readonly logIndex: number;
  readonly blockNumber: string;
}

export interface ScenarioOptions {
  readonly call: PageCall;
  readonly setup: SetupRequest;
  // Step 1: deployment identities, chain IDs, artifacts, connectivity, admin access.
  readonly preflight: () => Promise<Record<string, Json>>;
  // Step 3: pay for the commitments with the runner's test wallet.
  readonly purchase: (commitments: readonly string[]) => Promise<PurchaseOutcome>;
  // Step 4: register the payment at the issuer and wait for issuance.
  readonly waitIssuance: (purchase: PurchaseOutcome) => Promise<Issuance>;
  // Step 15: compare the gateway admin view with the committed balances. Undefined: skip.
  readonly dashboardCheck?: (batches: readonly string[], expected: readonly number[]) => Promise<Record<string, Json>>;
  // A fixed public test address that is not the payer.
  readonly testAddress: string;
  readonly log: (line: string) => void;
}

export interface ScenarioOutcome {
  readonly steps: StepResult[];
  readonly setup: SetupValue | null;
  readonly passed: boolean;
}

class AssertionFailure extends Error {
  override readonly name = "AssertionFailure";
}

// Thrown by a step body that cannot run in this profile. The step is "skip", not "fail".
class SkipStep extends Error {
  override readonly name = "SkipStep";
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new AssertionFailure(message);
}

function equal(actual: Json, expected: Json, what: string): void {
  check(JSON.stringify(actual) === JSON.stringify(expected), `${what}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`);
}

const STEP_NAMES: Readonly<Record<number, string>> = {
  1: "validate deployment identities, chain IDs, artifacts, connectivity",
  2: "start the browser prover and transport; make three batch secrets and session keys",
  3: "read the price and buy three batches with the runner wallet",
  4: "track the sale transaction through issuer confirmation and leaf insertion",
  5: "wait for an eligible root and the first-use delay",
  6: "fetch the membership path over the registry isolation key and check it locally",
  7: "generate the batch-open proof in the browser",
  8: "open the first batch: remaining 100, next_seq 0",
  9: "eth_chainId, eth_blockNumber, eth_getBalance: remaining 99, 98, 96; next_seq 1, 2, 3",
  10: "replay the first request (same response, no debit); same seq with another body is rejected",
  11: "invalid signature and sequence gap are rejected without a balance change",
  12: "spend the rest with one-unit reads; a further spend fails without a sequence change",
  13: "open the second batch on a new isolation key and make a read",
  14: "third batch: a modified proof is rejected with no session row; then the valid open succeeds",
  15: "gateway admin view matches the committed balances",
};

export async function runScenario(options: ScenarioOptions): Promise<ScenarioOutcome> {
  const steps: StepResult[] = [];
  let failed = false;
  const { call, log } = options;

  const step = async (id: number, body: () => Promise<Record<string, Json>>): Promise<void> => {
    const name = STEP_NAMES[id] ?? `step ${id}`;
    if (failed) {
      steps.push({ id, name, status: "not_run", ms: 0, details: {}, error: null });
      return;
    }
    log(`step ${id}: ${name}`);
    const start = performance.now();
    try {
      const details = await body();
      steps.push({ id, name, status: "pass", ms: Math.round(performance.now() - start), details, error: null });
      log(`step ${id}: pass`);
    } catch (error) {
      if (error instanceof SkipStep) {
        steps.push({ id, name, status: "skip", ms: 0, details: {}, error: error.message });
        log(`step ${id}: skip: ${error.message}`);
        return;
      }
      failed = true;
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      steps.push({ id, name, status: "fail", ms: Math.round(performance.now() - start), details: {}, error: message });
      log(`step ${id}: FAIL: ${message}`);
    }
  };

  let setup: SetupValue | null = null;
  let batchIds: string[] = [];
  let commitments: string[] = [];
  let purchase: PurchaseOutcome | null = null;
  const id = (index: number): string => {
    const value = batchIds[index];
    if (value === undefined) throw new AssertionFailure(`batch ${index} does not exist`);
    return value;
  };

  await step(1, options.preflight);

  await step(2, async () => {
    setup = await call({ op: "setup", setup: options.setup }, setupValueSchema);
    equal(setup.transportKind, options.setup.transport, "transport kind");
    const made = await call({ op: "createBatches", n: 3 }, batchesValueSchema);
    batchIds = made.batches.map((batch) => batch.batchId);
    commitments = made.batches.map((batch) => batch.commitment);
    check(new Set(batchIds).size === 3 && new Set(commitments).size === 3, "the three batches are not distinct");
    return {
      transport: setup.transportKind,
      transportReadyMs: Math.round(setup.transportReadyMs),
      crossOriginIsolated: setup.crossOriginIsolated,
      proverMode: setup.proverMode,
      proverThreads: setup.proverThreads,
      proverLoadMs: Math.round(setup.proverLoadMs),
      proverDownloadBytes: setup.proverDownloadBytes,
      batches: 3,
    };
  });

  await step(3, async () => {
    purchase = await options.purchase(commitments);
    return { txHash: purchase.txHash, logIndex: purchase.logIndex, blockNumber: purchase.blockNumber };
  });

  await step(4, async () => {
    if (purchase === null) throw new AssertionFailure("no purchase");
    const start = performance.now();
    const issuance = await options.waitIssuance(purchase);
    const attached = await call({ op: "attachIssuance", issuance }, attachValueSchema);
    equal(attached.matched.length, 3, "issued leaves that match the commitments");
    return {
      leafIndices: issuance.leaves.map((leaf) => leaf.leaf_index),
      insertionEpoch: issuance.insertion_epoch,
      eligibleEpoch: issuance.eligible_epoch,
      waitMs: Math.round(performance.now() - start),
    };
  });

  await step(5, async () => {
    const eligible = await call({ op: "waitEligible", batchId: id(0) }, eligibleValueSchema);
    return { rootSourceEpoch: eligible.sourceEpoch, leafCount: eligible.leafCount, delayEpochs: eligible.delayEpochs, waitMs: Math.round(eligible.waitedMs) };
  });

  let prepared: z.infer<typeof prepareValueSchema> | null = null;
  await step(6, async () => {
    prepared = await call({ op: "prepareOpen", batchId: id(0) }, prepareValueSchema);
    check(prepared.pathChecked, "the path was not checked locally");
    const info = await call({ op: "transportInfo" }, transportInfoValueSchema);
    check(info.isolationKeys.includes(`registry:${id(0)}`), "the path did not use the registry isolation key");
    return { rootEpoch: prepared.rootEpoch, leafCount: prepared.leafCount, registryKeyDistinct: true };
  });

  await step(7, async () => {
    if (prepared === null) throw new AssertionFailure("no prepared open");
    equal(prepared.publicInputCount, 10, "public input count");
    return {
      proofBytes: prepared.proofBytes,
      proveMs: Math.round(prepared.proveMs),
      witnessMs: Math.round(prepared.witnessMs),
      wasmMemoryBytes: prepared.wasmMemoryBytes,
      proofEpoch: prepared.proofEpoch,
    };
  });

  await step(8, async () => {
    const opened = await call({ op: "submitOpen", batchId: id(0), tamper: false }, openValueSchema);
    equal(opened.existing, false, "existing");
    equal(opened.remaining, 100, "remaining after open");
    equal(opened.nextSeq, "0", "next_seq after open");
    return { openMs: Math.round(opened.openMs), reprepared: opened.reprepared };
  });

  await step(9, async () => {
    const a = await call({ op: "rpc", batchId: id(0), method: "eth_chainId", params: [], label: "first" }, rpcValueSchema);
    const b = await call({ op: "rpc", batchId: id(0), method: "eth_blockNumber", params: [] }, rpcValueSchema);
    const c = await call({ op: "rpc", batchId: id(0), method: "eth_getBalance", params: [options.testAddress, "latest"] }, rpcValueSchema);
    equal([a.remaining, b.remaining, c.remaining], [99, 98, 96], "remaining");
    equal([a.nextSeq, b.nextSeq, c.nextSeq], ["1", "2", "3"], "next_seq");
    equal([a.seq, b.seq, c.seq], ["0", "1", "2"], "seq");
    check(a.hasResult && b.hasResult && c.hasResult, "a read returned a JSON-RPC error");
    return {
      remaining: [a.remaining, b.remaining, c.remaining],
      nextSeq: [a.nextSeq, b.nextSeq, c.nextSeq],
      stateSource: [a.stateSource, b.stateSource, c.stateSource],
      ms: [Math.round(a.ms), Math.round(b.ms), Math.round(c.ms)],
    };
  });

  await step(10, async () => {
    const replay = await call({ op: "replay", batchId: id(0), label: "first" }, replayValueSchema);
    equal(replay.httpStatus, 200, "replay status");
    check(replay.sameBody, "the replay body is not the first response");
    const status = await call({ op: "status", batchId: id(0) }, statusValueSchema);
    equal(status.remaining, 96, "remaining after replay");
    equal(status.nextSeq, "3", "next_seq after replay");
    const conflict = await call({ op: "probe", batchId: id(0), kind: "conflict" }, probeValueSchema);
    equal(conflict.errorCode, "sequence_conflict", "same seq with another body");
    return { replayed: replay.replayed, replayHeadersRemaining: replay.remaining, conflict: conflict.errorCode, conflictHttp: conflict.httpStatus };
  });

  await step(11, async () => {
    const bad = await call({ op: "probe", batchId: id(0), kind: "bad_signature" }, probeValueSchema);
    equal(bad.errorCode, "signature_invalid", "invalid signature");
    const gap = await call({ op: "probe", batchId: id(0), kind: "gap" }, probeValueSchema);
    equal(gap.errorCode, "sequence_gap", "sequence gap");
    const status = await call({ op: "status", batchId: id(0) }, statusValueSchema);
    equal([status.remaining, status.nextSeq, status.unitsTotal], [96, "3", "4"], "balance after rejections");
    return { badSignature: bad.httpStatus, gap: gap.httpStatus, remaining: status.remaining };
  });

  await step(12, async () => {
    const drained = await call({ op: "drain", batchId: id(0), method: "eth_chainId" }, drainValueSchema);
    equal(drained.requests, 96, "one-unit reads");
    equal(drained.remaining, 0, "remaining after drain");
    equal(drained.nextSeq, "99", "next_seq after drain");
    const code = await expectPageError(call, { op: "rpc", batchId: id(0), method: "eth_chainId", params: [] }, rpcValueSchema);
    equal(code, "insufficient_units", "spend after exhaustion");
    const status = await call({ op: "status", batchId: id(0) }, statusValueSchema);
    equal([status.remaining, status.nextSeq, status.state], [0, "99", "exhausted"], "state after the refused spend");
    return { requests: drained.requests, stateSources: drained.stateSources, ms: Math.round(drained.ms), refused: code };
  });

  await step(13, async () => {
    await call({ op: "waitEligible", batchId: id(1) }, eligibleValueSchema);
    await call({ op: "prepareOpen", batchId: id(1) }, prepareValueSchema);
    const opened = await call({ op: "submitOpen", batchId: id(1), tamper: false }, openValueSchema);
    equal(opened.remaining, 100, "remaining after the second open");
    const read = await call({ op: "rpc", batchId: id(1), method: "eth_blockNumber", params: [] }, rpcValueSchema);
    equal([read.remaining, read.nextSeq], [99, "1"], "second batch read");
    const info = await call({ op: "transportInfo" }, transportInfoValueSchema);
    check(info.isolationKeys.includes(id(0)) && info.isolationKeys.includes(id(1)), "batch isolation keys are missing");
    check(id(0) !== id(1), "the two batches have the same isolation key");
    return { isolationKeys: info.isolationKeys.length, distinctFromFirst: true, remaining: read.remaining };
  });

  await step(14, async () => {
    await call({ op: "waitEligible", batchId: id(2) }, eligibleValueSchema);
    await call({ op: "prepareOpen", batchId: id(2) }, prepareValueSchema);
    const tampered = await expectPageError(call, { op: "submitOpen", batchId: id(2), tamper: true }, openValueSchema);
    equal(tampered, "proof_invalid", "modified proof");
    const row = await expectPageError(call, { op: "status", batchId: id(2) }, statusValueSchema);
    equal(row, "not_found", "session row after the modified proof");
    const opened = await call({ op: "submitOpen", batchId: id(2), tamper: false }, openValueSchema);
    equal([opened.existing, opened.remaining, opened.nextSeq], [false, 100, "0"], "valid open of the third batch");
    return { tampered, sessionRow: row, reprepared: opened.reprepared };
  });

  await step(15, async () => {
    const dashboard = options.dashboardCheck;
    if (dashboard === undefined) throw new SkipStep("no admin access is configured");
    return dashboard(batchIds, [0, 99, 100]);
  });

  try {
    await call({ op: "close" }, emptyValueSchema);
  } catch (error) {
    log(`close failed: ${String(error)}`);
  }
  return { steps, setup, passed: !failed };
}

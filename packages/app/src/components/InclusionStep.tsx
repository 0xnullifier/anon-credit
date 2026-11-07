// Step 2: wait for inclusion. The tracker polls the issuer and the gateway every 2 s and shows
// what each answered. Nothing here advances without a response.

import {
  acceptedRootSchema,
  errorBodySchema,
  issuerPaths,
  issuerRootsResponseSchema,
  leafEventsResponseSchema,
  rootsResponseSchema,
  topupResponseSchema,
  type Issuance,
  type IssuerRootRecord,
} from "@anon-credit/protocol";
import { ServiceError, type SelectedRoot } from "@anon-credit/sdk";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { explainLine } from "../lib/explain.ts";
import { clock, explorerTx } from "../lib/format.ts";
import { eligibleEpochOf, epochOf, gatewayRootFor, postedRootFor, topupWords } from "../lib/inclusion.ts";
import { failStep, finishStep, noteStep, pendingStep, replaceStep, startStep, type StepRecord } from "../lib/tracker.ts";
import type { Workbench } from "../lib/workbench.ts";
import type { PurchaseRecord } from "./BuyStep.tsx";
import { EpochClock } from "./TopBar.tsx";
import { Hex, Kv, Section, StepLines, type SectionState } from "./primitives.tsx";

const IDS = { seen: "seen", leaf: "leaf", posted: "posted", visible: "visible", delay: "delay", eligible: "eligible" } as const;
const POLL_MS = 2000;

function initialSteps(): StepRecord[] {
  return [
    pendingStep(IDS.seen, "payment seen by the issuer"),
    pendingStep(IDS.leaf, "leaf appended to the Merkle Mountain Range"),
    pendingStep(IDS.posted, "root posted to RootRegistry"),
    pendingStep(IDS.visible, "root visible at the gateway"),
    pendingStep(IDS.delay, "first-use delay (chosen in the browser)"),
    pendingStep(IDS.eligible, "eligible root selected"),
  ];
}

export interface InclusionResult {
  readonly batchId: string;
  readonly issuance: Issuance;
  readonly root: SelectedRoot;
}

function trim(url: string): string {
  return url.replace(/\/+$/, "");
}

// A GET through the transport with a schema. A 404 of the issuer is returned as null.
async function getJson<S extends z.ZodType>(workbench: Workbench, url: string, schema: S, isolationKey: string): Promise<z.output<S> | null> {
  const response = await workbench.transport.fetch(url, { method: "GET" }, { isolationKey });
  if (response.status === 404) return null;
  if (!response.ok) {
    const body = errorBodySchema.safeParse(await response.json());
    if (body.success) throw new ServiceError(body.data.code, response.status, body.data.message, body.data.retryable);
    throw new Error(`GET ${url} answered HTTP ${response.status}`);
  }
  return schema.parse(await response.json());
}

function rootWords(record: IssuerRootRecord): string {
  return `epoch ${record.epoch}: ${record.status}, ${record.leaf_count} leaves, root ${record.root.slice(0, 14)}…${record.tx_hash === null ? "" : `, tx ${record.tx_hash.slice(0, 14)}…`}`;
}

function sectionState(steps: readonly StepRecord[]): SectionState {
  switch (true) {
    case steps.some((step) => step.state === "failed"):
      return "failed";
    case steps.every((step) => step.state === "done"):
      return "done";
    case steps.some((step) => step.state === "running"):
      return "running";
    default:
      return "idle";
  }
}

export function InclusionStep({
  workbench,
  purchase,
  now,
  onEligible,
}: {
  readonly workbench: Workbench | null;
  readonly purchase: PurchaseRecord | null;
  readonly now: number;
  readonly onEligible: (result: InclusionResult) => void;
}) {
  const [steps, setSteps] = useState<StepRecord[]>(initialSteps);
  const [issuance, setIssuance] = useState<Issuance | null>(null);
  const [polls, setPolls] = useState(0);
  const [delayEpochs, setDelayEpochs] = useState<number | null>(null);
  const done = useRef(false);

  // Reset for a new purchase.
  useEffect(() => {
    setSteps(initialSteps());
    setIssuance(null);
    setPolls(0);
    setDelayEpochs(null);
    done.current = false;
  }, [purchase?.txHash]);

  useEffect(() => {
    if (workbench === null || purchase === null) return;
    const batchId = purchase.batches[0]?.batchId;
    if (batchId === undefined) return;
    const issuer = trim(workbench.settings.issuerUrl);
    const gateway = trim(workbench.settings.gatewayUrl);
    const purchaseKey = `purchase:${purchase.txHash.slice(2, 18)}`;
    const registryKey = `registry:${batchId}`;
    let stopped = false;
    let current = initialSteps();
    let issued: Issuance | null = null;
    const set = (next: StepRecord): void => {
      current = replaceStep(current, next);
      setSteps(current);
    };
    const get = (id: string): StepRecord => current.find((step) => step.id === id) ?? pendingStep(id, id);

    const tick = async (): Promise<boolean> => {
      const epochSeconds = workbench.client.deployment.epoch_seconds;
      // a. The payment at the issuer.
      if (issued === null) {
        const seen = get(IDS.seen);
        if (seen.state !== "running") set(startStep(seen, Date.now(), [`GET ${issuerPaths.topup(purchase.txHash, purchase.logIndex)}`]));
        const topup = await getJson(workbench, `${issuer}${issuerPaths.topup(purchase.txHash, purchase.logIndex)}`, topupResponseSchema, purchaseKey);
        switch (topup) {
          case null:
            set(noteStep(get(IDS.seen), [`issuer answers 404 not_found: the indexer has not read block ${purchase.blockNumber} yet (${clock(Date.now())})`]));
            return false;
          default:
            switch (topup.status) {
              case "pending":
                set(noteStep(get(IDS.seen), [`issuer: ${topupWords(topup)} (${clock(Date.now())})`]));
                return false;
              case "rejected":
                set(failStep(get(IDS.seen), Date.now(), `payment_invalid: ${topupWords(topup)}`));
                return true;
              case "issued": {
                if (topup.issuance === null) return false;
                issued = topup.issuance;
                setIssuance(issued);
                set(finishStep(get(IDS.seen), Date.now(), [`issuer: ${topupWords(topup)}, purchase id ${issued.purchase_id}`]));
                // b. The leaves.
                const leaf = get(IDS.leaf);
                set(startStep(leaf, Date.now()));
                try {
                  const matched = await workbench.client.attachIssuance(issued);
                  const first = issued.leaves[0];
                  const events =
                    first === undefined
                      ? null
                      : await getJson(workbench, `${issuer}${issuerPaths.leafEvents(first.leaf_index, issued.leaves.length)}`, leafEventsResponseSchema, registryKey);
                  const confirmed = events === null ? 0 : issued.leaves.filter((item) => events.events.some((event) => event.index === item.leaf_index && event.leaf === item.leaf)).length;
                  set(
                    finishStep(get(IDS.leaf), Date.now(), [
                      `leaf ${issued.leaves.map((item) => item.leaf_index).join(", ")} of ${events?.leaf_count ?? "?"}; insertion epoch ${issued.insertion_epoch}, eligible from epoch ${issued.eligible_epoch}, expiry epoch ${issued.expiry}`,
                      `${confirmed} of ${issued.leaves.length} LeafAppended events match the leaf H(DOM_LEAF, c, 100, expiry); ${matched.length} stored locally`,
                    ]),
                  );
                } catch (error) {
                  set(failStep(get(IDS.leaf), Date.now(), explainLine(error)));
                  return true;
                }
                const summary = (await workbench.client.batches()).find((batch) => batch.batchId === batchId);
                setDelayEpochs(summary?.delayEpochs ?? null);
              }
            }
        }
      }
      if (issued === null) return false;
      const eligible = eligibleEpochOf(issued);
      const leafIndex = issued.leaves[0]?.leaf_index ?? 0;
      // c. The root publication at the issuer.
      const posted = get(IDS.posted);
      if (posted.state !== "done") {
        if (posted.state !== "running") set(startStep(posted, Date.now()));
        const roots = await getJson(workbench, `${issuer}${issuerPaths.roots()}`, issuerRootsResponseSchema, registryKey);
        const record = roots === null ? null : postedRootFor(roots.roots, eligible, leafIndex);
        switch (record?.status) {
          case undefined:
            set(noteStep(get(IDS.posted), [`no publication for epoch ${eligible} or later yet; the publisher posts after the epoch closes (${clock(Date.now())})`]));
            return false;
          case "pending":
          case "submitted":
            set(noteStep(get(IDS.posted), [rootWords(record)]));
            return false;
          case "failed":
          case "skipped":
            set(noteStep(get(IDS.posted), [`${rootWords(record)}; the next epoch replaces it`]));
            return false;
          case "included":
          case "finalized":
            set(finishStep(get(IDS.posted), Date.now(), [rootWords(record), `block ${record.block_number ?? "?"}; confirmed block ${roots?.finalized_block ?? "?"}`]));
        }
      }
      // d. The root at the gateway.
      const visible = get(IDS.visible);
      if (visible.state !== "done") {
        if (visible.state !== "running") set(startStep(visible, Date.now()));
        const accepted = await getJson(workbench, `${gateway}/v1/roots`, rootsResponseSchema, batchId);
        const root = accepted === null ? null : gatewayRootFor(accepted.roots, eligible, leafIndex);
        if (root === null) {
          set(noteStep(get(IDS.visible), [`gateway accepts ${accepted?.roots.length ?? 0} roots; none from epoch ${eligible} or later with ${leafIndex + 1}+ leaves (${clock(Date.now())})`]));
          return false;
        }
        acceptedRootSchema.parse(root);
        set(finishStep(get(IDS.visible), Date.now(), [`gateway accepts the root of epoch ${root.source_epoch} with ${root.leaf_count} leaves: ${root.root.slice(0, 14)}…`]));
      }
      // e. The first-use delay.
      const delay = get(IDS.delay);
      const summary = (await workbench.client.batches()).find((batch) => batch.batchId === batchId);
      const openEpoch = summary?.openEpoch === null || summary?.openEpoch === undefined ? eligible : BigInt(summary.openEpoch);
      const nowEpoch = epochOf(Date.now(), epochSeconds);
      if (delay.state !== "done") {
        if (delay.state !== "running") set(startStep(delay, Date.now()));
        if (nowEpoch < openEpoch) {
          set(noteStep(get(IDS.delay), [`${summary?.delayEpochs ?? "?"} epoch(s): open from epoch ${openEpoch}, now ${nowEpoch}`]));
          return false;
        }
        set(finishStep(get(IDS.delay), Date.now(), [`${summary?.delayEpochs ?? 0} epoch(s); open epoch ${openEpoch} reached`]));
      }
      // f. The SDK selects the root (gateway and issuer agree, the leaf is under it).
      const eligibleStep = get(IDS.eligible);
      set(startStep(eligibleStep, Date.now()));
      try {
        const selected = await workbench.client.waitForEligibleRoot(batchId);
        set(finishStep(get(IDS.eligible), Date.now(), [`root of epoch ${selected.sourceEpoch}, ${selected.leafCount} leaves, agreed by the issuer and the gateway`]));
        done.current = true;
        onEligible({ batchId, issuance: issued, root: selected });
        return true;
      } catch (error) {
        set(failStep(get(IDS.eligible), Date.now(), explainLine(error)));
        return true;
      }
    };

    const loop = async (): Promise<void> => {
      while (!stopped) {
        try {
          if (await tick()) return;
        } catch (error) {
          const running = current.find((step) => step.state === "running");
          if (running !== undefined) set(noteStep(running, [`request failed: ${explainLine(error)} (${clock(Date.now())}); next try in ${POLL_MS / 1000} s`]));
        }
        setPolls((n) => n + 1);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    };
    loop();
    return () => {
      stopped = true;
    };
  }, [workbench, purchase, onEligible]);

  if (workbench === null || purchase === null) {
    return (
      <Section n={2} title="wait for inclusion" state="locked">
        <p className="note">Starts after a purchase.</p>
      </Section>
    );
  }
  const tag = workbench.gatewayConfig.block_tag;
  const link = explorerTx(purchase.chainId, purchase.txHash);
  return (
    <Section n={2} title="wait for inclusion" state={sectionState(steps)}>
      <p className="note">
        The issuer reads the chain at the <strong>{tag}</strong> block tag
        {tag === "finalized" ? ", so a payment counts after Sepolia finality (about 13 minutes)." : ` (demo: no finality wait; a reorg can undo it).`}{" "}
        A leaf inserted in epoch e opens from epoch e+1. The issuer posts one root per epoch; the gateway reads it from the contract.
      </p>
      <div className="row">
        <EpochClock epochSeconds={workbench.client.deployment.epoch_seconds} now={now} />
        <span className="badge">polls every {POLL_MS / 1000} s · {polls} so far</span>
        <span className={`badge ${tag === "finalized" ? "" : "warn"}`}>block tag: {tag}{tag === "finalized" ? "" : " (demo)"}</span>
      </div>
      <StepLines steps={steps} now={now} />
      <Kv
        rows={[
          { k: "payment", v: link === null ? <Hex value={purchase.txHash} /> : <a href={link} target="_blank" rel="noreferrer">{purchase.txHash}</a> },
          { k: "batch", v: <Hex value={purchase.batches[0]?.batchId ?? ""} /> },
          ...(issuance === null ? [] : [{ k: "payer (issuer record)", v: <Hex value={issuance.payer} full /> }]),
          ...(delayEpochs === null ? [] : [{ k: "first-use delay", v: `${delayEpochs} epoch(s), random, chosen once per batch in this browser` }]),
        ]}
      />
    </Section>
  );
}

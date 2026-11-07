// Step 1: connect a wallet and buy N batches. The commitments are made in the browser; the
// transaction carries only them.

import { useState } from "react";
import { explainLine } from "../lib/explain.ts";
import { chainName, eth, explorerTx } from "../lib/format.ts";
import { devPayer } from "../lib/settings.ts";
import { failStep, finishStep, noteStep, pendingStep, replaceStep, startStep, type StepRecord } from "../lib/tracker.ts";
import { connectDevKey, connectInjected, readBalance, readBatchPrice, sendBuy, waitForPurchase, type Payer, type PayerKind } from "../lib/wallet.ts";
import type { Workbench } from "../lib/workbench.ts";
import { Hex, Kv, Section, StepLines, type SectionState } from "./primitives.tsx";

export interface PurchaseRecord {
  readonly txHash: string;
  readonly logIndex: number;
  readonly blockNumber: string;
  readonly payer: string;
  readonly chainId: number;
  readonly batches: readonly { readonly batchId: string; readonly commitment: string }[];
}

const STEP_IDS = { commit: "commit", sign: "sign", mine: "mine" } as const;

function initialSteps(): StepRecord[] {
  return [
    pendingStep(STEP_IDS.commit, "make batch secrets and commitments in the browser"),
    pendingStep(STEP_IDS.sign, "wallet signs CreditSale.buy(commitments)"),
    pendingStep(STEP_IDS.mine, "transaction mined, Purchased event read"),
  ];
}

function sectionState(steps: readonly StepRecord[]): SectionState {
  switch (true) {
    case steps.some((step) => step.state === "failed"):
      return "failed";
    case steps.some((step) => step.state === "running"):
      return "running";
    case steps.every((step) => step.state === "done"):
      return "done";
    default:
      return "idle";
  }
}

export function BuyStep({
  workbench,
  now,
  onPurchase,
}: {
  readonly workbench: Workbench | null;
  readonly now: number;
  readonly onPurchase: (purchase: PurchaseRecord) => void;
}) {
  const dev = devPayer();
  const [kind, setKind] = useState<PayerKind>("injected");
  const [payer, setPayer] = useState<Payer | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [price, setPrice] = useState<bigint | null>(null);
  const [connectError, setConnectError] = useState("");
  const [count, setCount] = useState(1);
  const [steps, setSteps] = useState<StepRecord[]>(initialSteps);
  const [commitments, setCommitments] = useState<readonly { readonly batchId: string; readonly commitment: string }[]>([]);
  const [txHash, setTxHash] = useState<string | null>(null);
  const busy = steps.some((step) => step.state === "running");

  if (workbench === null) {
    return (
      <Section n={1} title="buy credit" state="locked">
        <p className="note">Connect first.</p>
      </Section>
    );
  }
  const deployment = workbench.client.deployment;

  const connect = async (): Promise<void> => {
    setConnectError("");
    try {
      let next: Payer;
      switch (kind) {
        case "injected":
          next = await connectInjected(deployment.payment_chain_id);
          break;
        case "dev-key":
          if (dev === null) throw new Error("this build has no development payer");
          next = await connectDevKey(dev.privateKey, dev.rpcUrl, deployment.payment_chain_id);
          break;
      }
      setPayer(next);
      setBalance(await readBalance(next));
      setPrice(await readBatchPrice(next, deployment.sale_address));
    } catch (error) {
      setPayer(null);
      setConnectError(explainLine(error));
    }
  };

  const update = (next: StepRecord): void => setSteps((list) => replaceStep(list, next));

  const buy = async (): Promise<void> => {
    if (payer === null || price === null) return;
    const fresh = initialSteps();
    setSteps(fresh);
    setTxHash(null);
    const [commit, sign, mine] = fresh;
    if (commit === undefined || sign === undefined || mine === undefined) return;
    let made: readonly { readonly batchId: string; readonly commitment: string }[];
    try {
      update(startStep(commit, Date.now()));
      made = await workbench.client.createBatches(count);
      setCommitments(made);
      update(
        finishStep(commit, Date.now(), [
          `${made.length} secret${made.length === 1 ? "" : "s"} k (32 random bytes each) in the encrypted store`,
          ...made.map((batch) => `c = H(k) = ${batch.commitment}`),
        ]),
      );
    } catch (error) {
      update(failStep(commit, Date.now(), explainLine(error)));
      return;
    }
    let hash: `0x${string}`;
    try {
      update(startStep(sign, Date.now(), [`value ${eth(price * BigInt(made.length))} to ${deployment.sale_address}`]));
      hash = await sendBuy(payer, deployment.sale_address, made.map((batch) => batch.commitment), price);
      setTxHash(hash);
      update(finishStep(sign, Date.now(), [`tx ${hash}`]));
    } catch (error) {
      update(failStep(sign, Date.now(), explainLine(error)));
      return;
    }
    try {
      update(startStep(mine, Date.now(), ["waiting for the receipt"]));
      const purchase = await waitForPurchase(payer, deployment.sale_address, hash);
      update(
        finishStep(mine, Date.now(), [
          `block ${purchase.blockNumber}, log index ${purchase.logIndex}, purchase id ${purchase.purchaseId}, amount ${eth(purchase.amountWei)}`,
        ]),
      );
      setBalance(await readBalance(payer));
      onPurchase({
        txHash: purchase.txHash,
        logIndex: purchase.logIndex,
        blockNumber: purchase.blockNumber.toString(10),
        payer: payer.address,
        chainId: payer.chainId,
        batches: made,
      });
    } catch (error) {
      update(noteStep(failStep(mine, Date.now(), explainLine(error)), [`tx ${hash}`]));
    }
  };

  const link = txHash === null ? null : explorerTx(deployment.payment_chain_id, txHash);
  const total = price === null ? null : price * BigInt(count);
  return (
    <Section n={1} title="buy credit" state={sectionState(steps)}>
      <p className="note">
        One batch is {deployment.batch_size} units. The wallet pays the sale contract on {chainName(deployment.payment_chain_id)} and sends only the
        commitments. The secret never leaves the browser.
      </p>
      <div className="row">
        <span className="toggle" role="group" aria-label="payer">
          <button type="button" aria-pressed={kind === "injected"} onClick={() => setKind("injected")} disabled={payer !== null}>
            injected wallet
          </button>
          {dev === null ? null : (
            <button type="button" aria-pressed={kind === "dev-key"} onClick={() => setKind("dev-key")} disabled={payer !== null}>
              anvil test key (dev)
            </button>
          )}
        </span>
        {payer === null ? (
          <button type="button" className="primary" onClick={connect}>
            connect wallet
          </button>
        ) : (
          <button type="button" onClick={() => setPayer(null)} disabled={busy}>
            disconnect wallet
          </button>
        )}
      </div>
      {connectError === "" ? null : <p className="note bad">{connectError}</p>}
      {payer === null ? null : (
        <>
          <Kv
            rows={[
              { k: "payer", v: <Hex value={payer.address} full /> },
              { k: "chain", v: chainName(payer.chainId) },
              { k: "balance", v: balance === null ? "…" : eth(balance) },
              { k: "batch price", v: price === null ? "…" : eth(price) },
            ]}
          />
          <div className="row">
            <label className="short">
              batches (1 to 100)
              <input
                type="number"
                min={1}
                max={100}
                value={count}
                disabled={busy}
                onChange={(event) => setCount(Math.max(1, Math.min(100, Math.trunc(Number(event.target.value) || 1))))}
              />
            </label>
            <span className="actions">
              <button type="button" className="primary" onClick={buy} disabled={busy || price === null}>
                buy {count} batch{count === 1 ? "" : "es"}
                {total === null ? "" : ` for ${eth(total)}`}
              </button>
            </span>
          </div>
        </>
      )}
      <StepLines steps={steps} now={now} />
      {txHash === null ? null : (
        <Kv
          rows={[
            {
              k: "transaction",
              v:
                link === null ? (
                  <Hex value={txHash} full />
                ) : (
                  <a href={link} target="_blank" rel="noreferrer">
                    {txHash}
                  </a>
                ),
            },
            { k: "batch ids", v: commitments.map((batch) => batch.batchId).join(", ") , tone: "dim" },
          ]}
        />
      )}
    </Section>
  );
}

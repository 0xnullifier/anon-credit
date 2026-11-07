// Step 1: buy N batches with the connected signer. The commitments are made in the browser; the
// transaction carries only them. The buy button stays off while the balance is short, with the
// exact shortfall from the last balance and gas price reads.

import { useEffect, useState } from "react";
import { explainLine } from "../lib/explain.ts";
import { chainName, eth, explorerTx } from "../lib/format.ts";
import { purchaseCost, shortfallWei } from "../lib/funding.ts";
import { failStep, finishStep, noteStep, pendingStep, replaceStep, startStep, type StepRecord } from "../lib/tracker.ts";
import { readBatchPrice, readGasPrice, sendBuy, waitForPurchase, type Signer } from "../lib/wallet.ts";
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
    pendingStep(STEP_IDS.sign, "signer signs CreditSale.buy(commitments)"),
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

function signWords(signer: Signer): string {
  switch (signer.kind) {
    case "injected":
      return `${signer.name} signs with eth_sendTransaction`;
    case "local":
      return "the local key signs in this browser and broadcasts over the configured RPC";
    case "dev":
      return "the dev key signs in this browser and broadcasts over the configured RPC";
  }
}

export function BuyStep({
  workbench,
  signer,
  balance,
  now,
  onOpenWallet,
  onPurchase,
  onBalanceChange,
}: {
  readonly workbench: Workbench | null;
  readonly signer: Signer | null;
  readonly balance: bigint | null;
  readonly now: number;
  readonly onOpenWallet: () => void;
  readonly onPurchase: (purchase: PurchaseRecord) => void;
  // Ask for a new balance read (after a purchase).
  readonly onBalanceChange: () => void;
}) {
  const [price, setPrice] = useState<bigint | null>(null);
  const [gasPrice, setGasPrice] = useState<bigint | null>(null);
  const [readError, setReadError] = useState("");
  const [count, setCount] = useState(1);
  const [steps, setSteps] = useState<StepRecord[]>(initialSteps);
  const [commitments, setCommitments] = useState<readonly { readonly batchId: string; readonly commitment: string }[]>([]);
  const [txHash, setTxHash] = useState<string | null>(null);
  const busy = steps.some((step) => step.state === "running");

  // Price and gas price through the signer's RPC; the gas price again every 10 s.
  useEffect(() => {
    setPrice(null);
    setGasPrice(null);
    setReadError("");
    if (workbench === null || signer === null) return;
    let stopped = false;
    const sale = workbench.client.deployment.sale_address;
    readBatchPrice(signer, sale).then(
      (value) => {
        if (!stopped) setPrice(value);
      },
      (error) => {
        if (!stopped) setReadError(explainLine(error));
      },
    );
    const readGas = (): void => {
      readGasPrice(signer).then(
        (value) => {
          if (!stopped) setGasPrice(value);
        },
        (error) => {
          if (!stopped) setReadError(explainLine(error));
        },
      );
    };
    readGas();
    const timer = setInterval(readGas, 10_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [workbench, signer]);

  if (workbench === null) {
    return (
      <Section n={1} title="buy credit" state="locked">
        <p className="note">Connect first.</p>
      </Section>
    );
  }
  const deployment = workbench.client.deployment;

  const update = (next: StepRecord): void => setSteps((list) => replaceStep(list, next));

  const buy = async (): Promise<void> => {
    if (signer === null || price === null) return;
    const fresh = initialSteps();
    setSteps(fresh);
    setTxHash(null);
    let [commit, sign, mine] = fresh;
    if (commit === undefined || sign === undefined || mine === undefined) return;
    let made: readonly { readonly batchId: string; readonly commitment: string }[];
    try {
      commit = startStep(commit, Date.now());
      update(commit);
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
      sign = startStep(sign, Date.now(), [`value ${eth(price * BigInt(made.length))} to ${deployment.sale_address}`, signWords(signer)]);
      update(sign);
      hash = await sendBuy(signer, deployment.sale_address, made.map((batch) => batch.commitment), price);
      setTxHash(hash);
      update(finishStep(sign, Date.now(), [`tx ${hash}`]));
    } catch (error) {
      update(failStep(sign, Date.now(), explainLine(error)));
      return;
    }
    try {
      mine = startStep(mine, Date.now(), ["waiting for the receipt"]);
      update(mine);
      const purchase = await waitForPurchase(signer, deployment.sale_address, hash);
      update(
        finishStep(mine, Date.now(), [
          `block ${purchase.blockNumber}, log index ${purchase.logIndex}, purchase id ${purchase.purchaseId}, amount ${eth(purchase.amountWei)}`,
        ]),
      );
      onBalanceChange();
      onPurchase({
        txHash: purchase.txHash,
        logIndex: purchase.logIndex,
        blockNumber: purchase.blockNumber.toString(10),
        payer: signer.address,
        chainId: signer.chainId,
        batches: made,
      });
    } catch (error) {
      update(noteStep(failStep(mine, Date.now(), explainLine(error)), [`tx ${hash}`]));
    }
  };

  const link = txHash === null ? null : explorerTx(deployment.payment_chain_id, txHash);
  const cost = price === null || gasPrice === null ? null : purchaseCost(price, count, gasPrice);
  const missing = cost === null || balance === null ? null : shortfallWei(balance, cost);
  const canBuy = !busy && cost !== null && missing === 0n;
  return (
    <Section n={1} title="buy credit" state={sectionState(steps)}>
      <p className="note">
        One batch is {deployment.batch_size} units. The signer pays the sale contract on {chainName(deployment.payment_chain_id)} and sends only the
        commitments. The secret never leaves the browser.
      </p>
      {signer === null ? (
        <div className="row">
          <button type="button" className="primary" onClick={onOpenWallet}>
            connect wallet
          </button>
          <span className="note">an injected wallet, a local key pair, or the dev key</span>
        </div>
      ) : (
        <>
          <Kv
            rows={[
              { k: "signer", v: `${signer.name} (${signer.kind})` },
              { k: "address", v: <Hex value={signer.address} full /> },
              { k: "chain", v: chainName(signer.chainId) },
              { k: "balance", v: balance === null ? "reading…" : eth(balance) },
              { k: "batch price", v: price === null ? "reading…" : eth(price) },
              { k: "gas estimate", v: cost === null ? "reading…" : `${eth(cost.gasWei)} (2x margin at the current gas price)` },
            ]}
          />
          {readError === "" ? null : <p className="note bad">{readError}</p>}
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
              <button type="button" className="primary" onClick={buy} disabled={!canBuy}>
                {buyWords(count, cost, missing, busy)}
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
            { k: "batch ids", v: commitments.map((batch) => batch.batchId).join(", "), tone: "dim" },
          ]}
        />
      )}
    </Section>
  );
}

function buyWords(count: number, cost: ReturnType<typeof purchaseCost> | null, missing: bigint | null, busy: boolean): string {
  const batches = `${count} batch${count === 1 ? "" : "es"}`;
  if (busy) return "buying…";
  if (cost === null) return `buy ${batches} (reading the price)`;
  if (missing === null) return `buy ${batches} (reading the balance)`;
  if (missing > 0n) return `balance short by ${eth(missing)} for ${batches} (${eth(cost.paymentWei)} + ${eth(cost.gasWei)} gas)`;
  return `buy ${batches} for ${eth(cost.paymentWei)}`;
}

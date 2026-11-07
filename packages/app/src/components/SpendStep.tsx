// Step 4: the JSON-RPC console. One signed request at a time; the stage of the request in
// flight comes from the transport events; the result comes from the SDK outcome.

import type { JsonValue, Session } from "@anon-credit/sdk";
import { z } from "zod";
import { useEffect, useRef, useState } from "react";
import { explain } from "../lib/explain.ts";
import { clock, duration, oneLine } from "../lib/format.ts";
import type { RequestEvent } from "../lib/observe.ts";
import { TEST_ADDRESS } from "../lib/settings.ts";
import type { Workbench } from "../lib/workbench.ts";
import { Kv, Section, type SectionState } from "./primitives.tsx";

type Stage = "idle" | "signing" | "sent" | "answered" | "received";

const STAGES: readonly { readonly id: Stage; readonly words: (kind: string) => string }[] = [
  { id: "signing", words: () => "signing (Ed25519 over the exact bytes)" },
  { id: "sent", words: (kind) => (kind === "anon" ? "sent through Nox" : "sent directly (not private)") },
  { id: "answered", words: () => "gateway answered" },
  { id: "received", words: () => "received, state saved" },
];

const STAGE_ORDER: readonly Stage[] = ["idle", "signing", "sent", "answered", "received"];

function stageIndex(stage: Stage): number {
  return STAGE_ORDER.indexOf(stage);
}

export interface ConsoleEntry {
  readonly at: number;
  readonly method: string;
  readonly params: string;
  readonly seq: string | null;
  readonly units: number | null;
  readonly remaining: number | null;
  readonly nextSeq: string | null;
  readonly rttMs: number;
  readonly replayed: boolean | null;
  readonly stateSource: string | null;
  readonly attempts: number | null;
  readonly body: string;
  readonly error: string | null;
}

function defaultParams(method: string, saleAddress: string, purchaseTx: string | null): string {
  switch (method) {
    case "eth_getBalance":
      return JSON.stringify([TEST_ADDRESS, "latest"]);
    case "eth_call":
      // CreditSale.batchPriceWei(): the price of one batch, read from the sale contract.
      return JSON.stringify([{ to: saleAddress, data: "0x11b2d3c6" }, "latest"]);
    case "eth_getTransactionReceipt":
      return JSON.stringify([purchaseTx ?? `0x${"0".repeat(64)}`]);
    default:
      return "[]";
  }
}

function parseParams(text: string): readonly JsonValue[] {
  const parsed = z.array(z.json()).safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error("params must be a JSON array");
  return parsed.data;
}

// Class of one stage marker: the current stage while a request runs, the stages before it.
function stageClass(index: number, current: number, busy: boolean): string {
  switch (true) {
    case index === current && busy:
      return "active";
    case index <= current:
      return "past";
    default:
      return "";
  }
}

export function SpendStep({
  workbench,
  batchId,
  now,
  purchaseTx,
  onSpent,
}: {
  readonly workbench: Workbench | null;
  readonly batchId: string | null;
  readonly now: number;
  // Transaction hash of the last purchase: the default parameter of eth_getTransactionReceipt.
  readonly purchaseTx: string | null;
  readonly onSpent: () => void;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionError, setSessionError] = useState("");
  const [method, setMethod] = useState("eth_blockNumber");
  const [params, setParams] = useState("[]");
  const [stage, setStage] = useState<Stage>("idle");
  const [stageAt, setStageAt] = useState(0);
  const [entries, setEntries] = useState<ConsoleEntry[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    setSession(null);
    setSessionError("");
    if (workbench === null || batchId === null) return;
    workbench.client.session(batchId).then(
      (next) => setSession(next),
      (error) => setSessionError(explain(error).text),
    );
  }, [workbench, batchId]);

  useEffect(() => {
    if (workbench === null) return;
    return workbench.transport.subscribe((event: RequestEvent) => {
      if (!inFlight.current || event.kind !== "spend") return;
      switch (event.phase) {
        case "sent":
          setStage("sent");
          setStageAt(event.atMs);
          return;
        case "answered":
          setStage("answered");
          setStageAt(event.atMs);
          return;
        case "failed":
          return;
      }
    });
  }, [workbench]);

  if (workbench === null || batchId === null || session === null) {
    return (
      <Section n={4} title="spend" state="locked">
        <p className="note">{sessionError === "" ? "Starts when a session is open." : sessionError}</p>
      </Section>
    );
  }
  const prices = workbench.client.priceTable.units;
  const units = prices[method] ?? null;
  const remaining = session.state.remaining;
  const busy = stage !== "idle" && stage !== "received";

  const send = async (): Promise<void> => {
    if (busy) return;
    let parsed: readonly JsonValue[];
    try {
      parsed = parseParams(params);
    } catch (error) {
      setEntries((list) => [{ at: Date.now(), method, params, seq: null, units: null, remaining: null, nextSeq: null, rttMs: 0, replayed: null, stateSource: null, attempts: null, body: "", error: explain(error).text }, ...list]);
      return;
    }
    const started = performance.now();
    const startedAt = Date.now();
    inFlight.current = true;
    setStage("signing");
    setStageAt(startedAt);
    try {
      const outcome = await session.rpc(method, parsed);
      const rttMs = performance.now() - started;
      setStage("received");
      setStageAt(Date.now());
      setEntries((list) => [
        {
          at: startedAt,
          method,
          params,
          seq: outcome.seq.toString(10),
          units: outcome.units,
          remaining: outcome.remaining,
          nextSeq: outcome.nextSeq.toString(10),
          rttMs,
          replayed: outcome.replayed,
          stateSource: outcome.stateSource,
          attempts: outcome.attempts,
          body: outcome.body,
          error: null,
        },
        ...list,
      ]);
    } catch (error) {
      const explained = explain(error);
      setStage("idle");
      setEntries((list) => [
        { at: startedAt, method, params, seq: null, units: null, remaining: session.state.remaining, nextSeq: session.state.next_seq, rttMs: performance.now() - started, replayed: null, stateSource: null, attempts: null, body: "", error: `${explained.code}: ${explained.text}` },
        ...list,
      ]);
    } finally {
      inFlight.current = false;
      onSpent();
    }
  };

  const state: SectionState = busy ? "running" : "idle";
  return (
    <Section n={4} title="spend" state={state}>
      <p className="note">
        Each request is one signed debit: batch id, sequence, cumulative units, the exact JSON-RPC bytes, Ed25519 signature. The gateway
        forwards the bytes upstream and debits only when it stores the response.
      </p>
      <Kv
        rows={[
          { k: "units remaining", v: `${remaining} of ${workbench.client.deployment.batch_size}` },
          { k: "next sequence", v: session.state.next_seq },
          { k: "units spent", v: session.state.units_total },
          { k: "session state", v: session.state.state },
        ]}
      />
      <div className="console">
        <div className="compose">
          <select
            value={method}
            disabled={busy}
            onChange={(event) => {
              setMethod(event.target.value);
              setParams(defaultParams(event.target.value, workbench?.client.deployment.sale_address ?? "", purchaseTx));
            }}
          >
            {Object.entries(prices).map(([name, cost]) => (
              <option key={name} value={name}>
                {name} ({cost} unit{cost === 1 ? "" : "s"})
              </option>
            ))}
          </select>
          <input value={params} disabled={busy} onChange={(event) => setParams(event.target.value)} aria-label="params (JSON array)" spellCheck={false} />
          <button type="button" className="primary" onClick={send} disabled={busy || units === null || remaining < (units ?? 0)}>
            send ({units ?? "?"} unit{units === 1 ? "" : "s"})
          </button>
        </div>
        <div className="stages" aria-live="polite">
          {STAGES.map((item) => {
            const index = stageIndex(item.id);
            const current = stageIndex(stage);
            return (
              <span key={item.id} className={`stage ${stageClass(index, current, busy)}`}>
                {item.words(workbench.transport.kind)}
                {index === current && busy ? ` ${duration(now - stageAt)}` : ""}
              </span>
            );
          })}
        </div>
        <ul className="entries">
          {entries.length === 0 ? <li className="empty">No request sent yet.</li> : null}
          {entries.map((entry, index) => (
            <li key={`${entry.at}-${index}`}>
              <div className="head">
                <span>{clock(entry.at)}</span>
                <span className="seq">{entry.seq === null ? "—" : `seq ${entry.seq}`}</span>
                <span>{entry.method}</span>
                {entry.error === null ? (
                  <>
                    <span>-{entry.units} unit{entry.units === 1 ? "" : "s"}</span>
                    <span>{entry.remaining} left</span>
                    <span>next {entry.nextSeq}</span>
                    <span>{duration(entry.rttMs)}</span>
                    {entry.replayed === true ? <span>replayed, no charge</span> : null}
                    {entry.stateSource === "status" ? <span>state from the signed status call</span> : null}
                    {entry.attempts !== null && entry.attempts > 1 ? <span>{entry.attempts} sends</span> : null}
                  </>
                ) : (
                  <span className="bad">{entry.error}</span>
                )}
                {entry.body === "" ? null : (
                  <button type="button" className="quiet" onClick={() => setOpen(open === index ? null : index)}>
                    {open === index ? "less" : "more"}
                  </button>
                )}
              </div>
              {entry.body === "" ? null : <div className="body">{open === index ? entry.body : oneLine(entry.body)}</div>}
              {open === index ? <div className="body">params {entry.params}</div> : null}
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}

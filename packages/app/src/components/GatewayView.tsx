// Step 6: what the gateway sees. Left: the values the gateway holds for the session, from its
// own responses. Right: the values that exist only in this browser, the issuer, or the chain.

import { demoPeerResponseSchema, type DemoPeerResponse, type StatusResponse } from "@anon-credit/protocol";
import type { BatchSummary } from "@anon-credit/sdk";
import { useState } from "react";
import { explainLine } from "../lib/explain.ts";
import { bytes, clock } from "../lib/format.ts";
import type { Workbench } from "../lib/workbench.ts";
import type { PurchaseRecord } from "./BuyStep.tsx";
import type { OpenResult } from "./OpenStep.tsx";
import { Hex, Kv, Section, type KvRow } from "./primitives.tsx";

interface Probe {
  readonly at: number;
  readonly result: DemoPeerResponse | null;
  readonly error: string;
}

function statusWords(status: StatusResponse | null, error: string): string {
  switch (true) {
    case error !== "":
      return error;
    case status === null:
      return "values from the open response";
    default:
      return `values from POST /v1/session/status at epoch ${status?.current_epoch ?? "?"}`;
  }
}

export function GatewayView({
  workbench,
  purchase,
  opened,
  batch,
}: {
  readonly workbench: Workbench | null;
  readonly purchase: PurchaseRecord | null;
  readonly opened: OpenResult | null;
  readonly batch: BatchSummary | null;
}) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusError, setStatusError] = useState("");
  const [sessionProbe, setSessionProbe] = useState<Probe | null>(null);
  const [directProbe, setDirectProbe] = useState<Probe | null>(null);

  if (workbench === null || opened === null) {
    return (
      <Section n={6} title="what the gateway sees" state="locked">
        <p className="note">Shows the open session.</p>
      </Section>
    );
  }
  const gateway = workbench.settings.gatewayUrl.replace(/\/+$/, "");
  const session = status?.session ?? opened.response.session;
  const demoPeer = workbench.gatewayConfig.demo_peer_enabled;

  const refresh = async (): Promise<void> => {
    setStatusError("");
    try {
      setStatus(await workbench.client.status(opened.batchId));
    } catch (error) {
      setStatusError(explainLine(error));
    }
  };

  // The observed source address of a request on this session's isolation key, through the
  // transport in use. The request carries no batch or purchase identifier.
  const probeSession = async (): Promise<void> => {
    try {
      const response = await workbench.transport.fetch(`${gateway}/v1/demo/peer`, { method: "GET" }, { isolationKey: opened.batchId });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setSessionProbe({ at: Date.now(), result: demoPeerResponseSchema.parse(await response.json()), error: "" });
    } catch (error) {
      setSessionProbe({ at: Date.now(), result: null, error: explainLine(error) });
    }
  };

  // The same probe with a plain fetch from this browser: what the gateway sees without Nox.
  const probeDirect = async (): Promise<void> => {
    try {
      const response = await fetch(`${gateway}/v1/demo/peer`, { credentials: "omit", cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setDirectProbe({ at: Date.now(), result: demoPeerResponseSchema.parse(await response.json()), error: "" });
    } catch (error) {
      setDirectProbe({ at: Date.now(), result: null, error: explainLine(error) });
    }
  };

  const probeWords = (probe: Probe | null): string => {
    if (probe === null) return "not probed";
    const result = probe.result;
    if (result === null) return probe.error;
    return `${result.observed_ip} (${result.attribution}${result.proxy_hop === null ? "" : `, via proxy ${result.proxy_hop}`}) at ${clock(probe.at)}`;
  };

  const holds: KvRow[] = [
    { k: "batch id", v: <Hex value={session.batch_id} full /> },
    { k: "session public key", v: <Hex value={session.session_pub} full /> },
    { k: "units remaining", v: `${session.remaining}` },
    { k: "units spent", v: session.units_total },
    { k: "next sequence", v: session.next_seq },
    { k: "open epoch", v: session.open_epoch },
    { k: "deadline epoch", v: session.deadline_epoch },
    { k: "price table hash", v: <Hex value={session.price_table_hash} /> },
    { k: "proof", v: `${bytes(opened.prepared.proofBytes)}, verified once at open` },
    { k: "root used", v: `epoch ${opened.prepared.root.sourceEpoch}, ${opened.prepared.root.leafCount} leaves (the anonymity set)` },
    {
      k: "source address of this session",
      v: demoPeer ? (
        <>
          {probeWords(sessionProbe)}{" "}
          <button type="button" className="quiet" onClick={probeSession}>
            probe through {workbench.transport.kind === "anon" ? "Nox" : "the direct transport"}
          </button>
        </>
      ) : (
        "not recorded: DEMO_IP_LOGGING is off at this gateway"
      ),
      ...(workbench.transport.kind === "direct" ? { tone: "bad" as const } : {}),
    },
  ];

  const doesNotHold: KvRow[] = [
    { k: "payer address", v: purchase === null ? "in this browser and on the chain" : <Hex value={purchase.payer} full />, tone: "dim" },
    { k: "payment transaction", v: purchase === null ? "on the chain" : <Hex value={purchase.txHash} />, tone: "dim" },
    { k: "commitment c", v: batch === null ? "in this browser and the issuer" : <Hex value={batch.commitment} />, tone: "dim" },
    { k: "leaf index", v: batch?.leafIndex === null || batch?.leafIndex === undefined ? "in this browser and the issuer" : `${batch.leafIndex} (in this browser and the issuer)`, tone: "dim" },
    { k: "batch secret k", v: "in the encrypted store of this browser only", tone: "dim" },
    { k: "session secret key", v: "in the encrypted store of this browser only", tone: "dim" },
    { k: "your IP address", v: workbench.transport.kind === "anon" ? "behind the mixnet exit" : "visible: the direct transport is not private", ...(workbench.transport.kind === "anon" ? { tone: "dim" as const } : { tone: "bad" as const }) },
    {
      k: "your IP, direct probe",
      v: demoPeer ? (
        <>
          {probeWords(directProbe)}{" "}
          <button type="button" className="quiet" onClick={probeDirect}>
            probe directly
          </button>
        </>
      ) : (
        "not recorded at this gateway"
      ),
    },
  ];

  return (
    <Section n={6} title="what the gateway sees" state="idle">
      <p className="note">
        Left: the row the gateway keeps for this session and the address it observed, from its own public API. Right: the values that
        would link the session to a person, and where they live. Different observed addresses are evidence of routing, not proof against
        timing or content analysis.
      </p>
      <div className="row">
        <button type="button" onClick={refresh}>
          read signed status
        </button>
        <span className="note">{statusWords(status, statusError)}</span>
      </div>
      <div className="ledger">
        <div>
          <h3>
            gateway holds <span>(from its responses)</span>
          </h3>
          <Kv rows={holds} />
        </div>
        <div>
          <h3>
            gateway does not hold <span>(and where it is)</span>
          </h3>
          <Kv rows={doesNotHold} />
        </div>
      </div>
    </Section>
  );
}

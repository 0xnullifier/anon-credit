// Demo comparison (implementation.md section 14, MVP.md section 4).
//
// Column (a): the direct probe. The browser of the operator calls GET /v1/demo/peer on the
// PUBLIC gateway, with no token and no batch or purchase data.
// Column (b): the newest session_opened event and the spend outcomes of the same batch, with
// the address that the gateway observed for each. In the demo, this traffic comes through Nox.
//
// The label is "Observed source IP". The dashboard does not say that a user is anonymous:
// different addresses are evidence of routing only. The panel says this next to the result.

import type { DemoPeerResponse, GatewayEvent } from "@anon-credit/protocol";
import type { ChangeEvent } from "react";
import {
  attribution,
  compareObservedAll,
  distinctObservedIps,
  eventResult,
  latestOpenedSession,
  type Comparison,
  type SessionObservation,
} from "../lib/events-model.ts";
import { utcFromMs } from "../lib/format.ts";
import { AttributionRows, IpCaptureOff, ROUTING_STATEMENT } from "./DiagnosticsPanel.tsx";
import { Field, HexId, Panel, Pill, type Load } from "./common.tsx";

export interface ProbeResult {
  readonly peer: DemoPeerResponse;
  readonly atMs: number;
}

function comparisonText(comparison: Comparison): string {
  switch (comparison) {
    case "different":
      return "The observed addresses are different. This is evidence that the session traffic reached the gateway on a different route than the direct probe from this browser.";
    case "same":
      return "An observed address of the session is the same as the direct probe address. The session traffic and the direct probe came from the same observed address.";
    case "incomplete":
      return "No comparison yet. Run the direct probe and wait for a session_opened event.";
  }
}

function ProbeColumn(props: { readonly probe: Load<ProbeResult> }) {
  const { probe } = props;
  switch (probe.state) {
    case "idle":
      return <p className="muted">Not run.</p>;
    case "loading":
      return <p className="muted">Probing…</p>;
    case "failed":
      return <p className="tone-error">{probe.error}</p>;
    case "ready": {
      const { peer, atMs } = probe.value;
      return (
        <dl className="kv">
          <AttributionRows view={attribution(peer.observed_ip, peer.attribution, peer.proxy_hop)} proxyHop={peer.proxy_hop} />
          <Field label="Observed at (UTC)">{utcFromMs(String(atMs))}</Field>
        </dl>
      );
    }
  }
}

function SpendRows(props: { readonly spends: readonly GatewayEvent[] }) {
  const { spends } = props;
  if (spends.length === 0) {
    return <p className="muted">No spend of this session yet.</p>;
  }
  return (
    <div className="table-wrap">
      <table className="dense compact">
        <thead>
          <tr>
            <th>Time (UTC)</th>
            <th className="num">Seq</th>
            <th>Method</th>
            <th>Result</th>
            <th>Observed source IP</th>
            <th>Proxy hop</th>
          </tr>
        </thead>
        <tbody>
          {spends.map((event) => {
            const result = eventResult(event);
            return (
              <tr key={event.id}>
                <td className="mono">{utcFromMs(event.at_ms).slice(11)}</td>
                <td className="num">{event.seq ?? "–"}</td>
                <td className="mono">{event.method ?? "–"}</td>
                <td>
                  <Pill tone={result.tone}>{result.label}</Pill>
                </td>
                <td className="mono">{event.observed_ip}</td>
                <td className="mono">{event.proxy_hop ?? "none"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SessionColumn(props: { readonly observation: SessionObservation | null; readonly onSelectBatch: (batchId: string) => void }) {
  const { observation } = props;
  if (observation === null) {
    return <p className="muted">No session_opened event in the received events yet.</p>;
  }
  const { opened, spends } = observation;
  const ips = distinctObservedIps([opened, ...spends]);
  return (
    <>
      <dl className="kv">
        <AttributionRows view={attribution(opened.observed_ip, opened.ip_attribution, opened.proxy_hop)} proxyHop={opened.proxy_hop} />
        <Field label="Opened at (UTC)">{utcFromMs(opened.at_ms)}</Field>
        <Field label="Batch ID">{opened.batch_id === null ? "–" : <HexId value={opened.batch_id} onSelect={props.onSelectBatch} />}</Field>
        <Field label="Spends after the open">{spends.length}</Field>
        <Field label="Distinct observed addresses">{ips.length === 0 ? "none" : ips.join(", ")}</Field>
      </dl>
      <SpendRows spends={spends} />
    </>
  );
}

export interface DemoComparisonPanelProps {
  // demo_ip_logging of the snapshot.
  readonly ipLogging: boolean;
  // The received events, oldest first.
  readonly events: readonly GatewayEvent[];
  readonly probe: Load<ProbeResult>;
  readonly gatewayUrl: string;
  readonly onGatewayUrl: (url: string) => void;
  readonly onProbe: () => void;
  readonly onSelectBatch: (batchId: string) => void;
}

export function DemoComparisonPanel(props: DemoComparisonPanelProps) {
  const { ipLogging, events, probe, gatewayUrl } = props;
  if (!ipLogging) {
    return (
      <Panel id="demo" title="Demo comparison" className="demo">
        <IpCaptureOff />
        <p className="statement">{ROUTING_STATEMENT}</p>
      </Panel>
    );
  }
  const observation = latestOpenedSession(events);
  const sessionIps = observation === null ? [] : distinctObservedIps([observation.opened, ...observation.spends]);
  const probeIp = probe.state === "ready" ? probe.value.peer.observed_ip : null;
  const comparison = compareObservedAll(probeIp, sessionIps);
  const onUrl = (change: ChangeEvent<HTMLInputElement>): void => props.onGatewayUrl(change.target.value);
  return (
    <Panel id="demo" title="Demo comparison" className="demo">
      <form
        className="probe-form"
        onSubmit={(submit) => {
          submit.preventDefault();
          props.onProbe();
        }}
      >
        <label>
          Public gateway URL <input type="url" value={gatewayUrl} onChange={onUrl} spellCheck={false} />
        </label>
        <button type="submit" disabled={probe.state === "loading"}>
          Direct probe
        </button>
      </form>
      <p className="note">
        The probe calls <code>GET /v1/demo/peer</code> on the public gateway from this browser. It sends no token and no
        batch or purchase data. Use the public HTTPS URL of the gateway, so that the probe goes through the same ingress as
        the paid traffic.
      </p>
      <div className="side-by-side">
        <div>
          <h4>(a) Direct probe (this browser)</h4>
          <ProbeColumn probe={probe} />
        </div>
        <div>
          <h4>(b) Most recent session_opened and its spends</h4>
          <SessionColumn observation={observation} onSelectBatch={props.onSelectBatch} />
        </div>
      </div>
      <p className={`comparison comparison-${comparison}`}>{comparisonText(comparison)}</p>
      <p className="statement">{ROUTING_STATEMENT}</p>
    </Panel>
  );
}

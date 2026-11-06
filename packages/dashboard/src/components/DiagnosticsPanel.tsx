// View 4: connection diagnostics and the direct probe.
//
// The direct probe calls GET /v1/demo/peer on the PUBLIC gateway from this browser, with no
// token and no session data. The result is shown next to the address that the gateway saw for
// the most recent anonymous session event. The label is "Observed source IP". The dashboard
// does not say that a user is anonymous: different addresses are evidence of routing only.

import type { DemoPeerResponse, GatewayEvent } from "@anon-credit/protocol";
import type { ChangeEvent } from "react";
import { attribution, compareObserved, type Attribution, type Comparison } from "../lib/events-model.ts";
import { utcFromMs } from "../lib/format.ts";
import { Field, HexId, Panel, type Load } from "./common.tsx";

export const ROUTING_STATEMENT =
  "Different observed addresses are evidence of routing. They are not proof of protection against timing analysis or content identification.";

export interface ProbeResult {
  readonly peer: DemoPeerResponse;
  readonly atMs: number;
}

function AttributionRows(props: { readonly view: Attribution | null; readonly proxyHop: string | null }) {
  const { view } = props;
  if (view === null) {
    return (
      <>
        <Field label="Observed source IP">
          <span className="muted">no observation</span>
        </Field>
      </>
    );
  }
  return (
    <>
      <Field label="Observed source IP">
        <strong className="mono">{view.observed}</strong>
      </Field>
      <Field label="Attribution source">{view.source}</Field>
      <Field label="Socket peer IP">
        <span className="mono">{view.socketPeer}</span>
      </Field>
      <Field label="Effective source IP">
        <span className="mono">{view.effective}</span>
      </Field>
      <Field label="Proxy hop">
        <span className="mono">{props.proxyHop ?? "none"}</span>
      </Field>
    </>
  );
}

function comparisonText(comparison: Comparison): string {
  switch (comparison) {
    case "different":
      return "The observed addresses are different. This is evidence that the session traffic reached the gateway on a different route than the direct probe from this browser.";
    case "same":
      return "The observed addresses are the same. The session traffic and the direct probe came from the same observed address.";
    case "incomplete":
      return "No comparison yet. Run the direct probe and wait for an event of an anonymous session.";
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

function SessionColumn(props: { readonly event: GatewayEvent | null }) {
  const { event } = props;
  if (event === null) {
    return <p className="muted">No event of an anonymous session yet.</p>;
  }
  return (
    <dl className="kv">
      <AttributionRows view={attribution(event.observed_ip, event.ip_attribution, event.proxy_hop)} proxyHop={event.proxy_hop} />
      <Field label="Observed at (UTC)">{utcFromMs(event.at_ms)}</Field>
      <Field label="Event">
        #{event.id} {event.kind}
      </Field>
      <Field label="Batch ID">{event.batch_id === null ? "–" : <HexId value={event.batch_id} />}</Field>
    </dl>
  );
}

export interface DiagnosticsPanelProps {
  // demo_ip_logging of the snapshot.
  readonly ipLogging: boolean;
  // The newest received event, any kind.
  readonly latestEvent: GatewayEvent | null;
  // The newest received event with a batch ID.
  readonly sessionEvent: GatewayEvent | null;
  readonly probe: Load<ProbeResult>;
  readonly gatewayUrl: string;
  readonly onGatewayUrl: (url: string) => void;
  readonly onProbe: () => void;
}

export function DiagnosticsPanel(props: DiagnosticsPanelProps) {
  const { ipLogging, latestEvent, sessionEvent, probe, gatewayUrl } = props;
  if (!ipLogging) {
    return (
      <Panel id="diagnostics" title="Connection diagnostics" className="diagnostics">
        <dl className="kv">
          <Field label="Observed source IP">
            <strong>unavailable</strong>
          </Field>
        </dl>
        <p className="note">
          This gateway profile has IP capture off (<code>DEMO_IP_LOGGING=false</code>). The gateway does not read peer
          addresses or forwarding headers, so no address is available. The direct probe endpoint{" "}
          <code>/v1/demo/peer</code> is also off in this profile.
        </p>
        <p className="statement">{ROUTING_STATEMENT}</p>
      </Panel>
    );
  }
  const probeIp = probe.state === "ready" ? probe.value.peer.observed_ip : null;
  const comparison = compareObserved(probeIp, sessionEvent?.observed_ip ?? null);
  const onUrl = (change: ChangeEvent<HTMLInputElement>): void => props.onGatewayUrl(change.target.value);
  return (
    <Panel id="diagnostics" title="Connection diagnostics" className="diagnostics">
      <h3>Newest event</h3>
      <dl className="kv">
        <AttributionRows
          view={latestEvent === null ? null : attribution(latestEvent.observed_ip, latestEvent.ip_attribution, latestEvent.proxy_hop)}
          proxyHop={latestEvent?.proxy_hop ?? null}
        />
      </dl>
      <h3>Direct probe and anonymous session</h3>
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
        batch or purchase data.
      </p>
      <div className="side-by-side">
        <div>
          <h4>Direct probe (this browser)</h4>
          <ProbeColumn probe={probe} />
        </div>
        <div>
          <h4>Most recent anonymous session</h4>
          <SessionColumn event={sessionEvent} />
        </div>
      </div>
      <p className={`comparison comparison-${comparison}`}>{comparisonText(comparison)}</p>
      <p className="statement">{ROUTING_STATEMENT}</p>
    </Panel>
  );
}

// View 4: connection diagnostics of the newest event.
//
// The view shows the socket peer IP, the effective source IP (trusted proxy), and the source of
// that attribution. The label is "Observed source IP". The dashboard does not say that a user
// is anonymous: different addresses are evidence of routing only. The direct probe and the
// comparison with a paid session are in the demo comparison panel.

import type { GatewayEvent } from "@anon-credit/protocol";
import { attribution, type Attribution } from "../lib/events-model.ts";
import { utcFromMs } from "../lib/format.ts";
import { Field, Panel } from "./common.tsx";

export const ROUTING_STATEMENT =
  "Different observed addresses are evidence of routing. They are not proof of protection against timing analysis or content identification.";

// The rows of one observation (event or direct probe).
export function AttributionRows(props: { readonly view: Attribution | null; readonly proxyHop: string | null }) {
  const { view } = props;
  if (view === null) {
    return (
      <Field label="Observed source IP">
        <span className="muted">no observation</span>
      </Field>
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

// The note of the normal profile: no address is available.
export function IpCaptureOff() {
  return (
    <>
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
    </>
  );
}

export interface DiagnosticsPanelProps {
  // demo_ip_logging of the snapshot.
  readonly ipLogging: boolean;
  // The newest received event, any kind.
  readonly latestEvent: GatewayEvent | null;
}

export function DiagnosticsPanel(props: DiagnosticsPanelProps) {
  const { ipLogging, latestEvent } = props;
  if (!ipLogging) {
    return (
      <Panel id="diagnostics" title="Connection diagnostics" className="diagnostics">
        <IpCaptureOff />
        <p className="statement">{ROUTING_STATEMENT}</p>
      </Panel>
    );
  }
  return (
    <Panel id="diagnostics" title="Connection diagnostics" className="diagnostics">
      <h3>Newest event</h3>
      <dl className="kv">
        <AttributionRows
          view={latestEvent === null ? null : attribution(latestEvent.observed_ip, latestEvent.ip_attribution, latestEvent.proxy_hop)}
          proxyHop={latestEvent?.proxy_hop ?? null}
        />
        {latestEvent === null ? null : (
          <>
            <Field label="Observed at (UTC)">{utcFromMs(latestEvent.at_ms)}</Field>
            <Field label="Event">
              #{latestEvent.id} {latestEvent.kind}
            </Field>
          </>
        )}
      </dl>
      <p className="note">
        Behind a trusted reverse proxy (<code>GATEWAY_TRUSTED_PROXY_ADDRS</code>), the socket peer is the proxy hop and the
        effective source IP comes from the forwarding header. From any other peer, the gateway ignores forwarding headers.
        The direct probe and the comparison with a paid session are in the demo comparison panel.
      </p>
      <p className="statement">{ROUTING_STATEMENT}</p>
    </Panel>
  );
}

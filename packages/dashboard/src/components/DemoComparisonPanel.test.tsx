// Rendering tests of the demo comparison: the direct probe next to the newest session_opened
// event and its spends, and the "unavailable" view of the normal profile.

import type { EventKind, GatewayEvent } from "@anon-credit/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { makeEvent, sharedDemoPeer } from "../testing/shared.ts";
import type { Load } from "./common.tsx";
import { DemoComparisonPanel, type ProbeResult } from "./DemoComparisonPanel.tsx";
import { ROUTING_STATEMENT } from "./DiagnosticsPanel.tsx";

const noop = (): void => {};
const BATCH = `0x${"0a".repeat(32)}`;
const NOX = "198.51.100.23";

function ev(id: number, kind: EventKind, batch: string | null, ip = NOX, seq: string | null = null): GatewayEvent {
  return makeEvent(id, { kind, batch_id: batch, observed_ip: ip, ip_attribution: "socket", proxy_hop: null, seq });
}

const sessionEvents = [
  ev(1, "open_received", null),
  ev(2, "open_verified", BATCH),
  ev(3, "session_opened", BATCH),
  ev(4, "rpc_received", BATCH, NOX, "0"),
  ev(5, "rpc_completed", BATCH, NOX, "0"),
  ev(6, "rpc_received", BATCH, "198.51.100.99", "1"),
  ev(7, "rpc_completed", BATCH, "198.51.100.99", "1"),
];

const probeReady: Load<ProbeResult> = { state: "ready", value: { peer: sharedDemoPeer, atMs: 1_800_000_000_000 }, at: 1 };

function render(ipLogging: boolean, probe: Load<ProbeResult>, events: readonly GatewayEvent[] = sessionEvents): string {
  return renderToStaticMarkup(
    <DemoComparisonPanel
      ipLogging={ipLogging}
      events={events}
      probe={probe}
      gatewayUrl="https://rpc.example.org"
      onGatewayUrl={noop}
      onProbe={noop}
      onSelectBatch={noop}
    />,
  );
}

// Text of the markup without tags.
function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

describe("DemoComparisonPanel", () => {
  it("shows the probe and the opened session with its spends side by side and says that they differ", () => {
    const html = render(true, probeReady);
    const plain = text(html);
    expect(plain).toContain("Demo comparison");
    expect(plain).toContain("(a) Direct probe (this browser)");
    expect(plain).toContain("(b) Most recent session_opened and its spends");
    expect(plain).toContain("203.0.113.7");
    expect(plain).toContain(NOX);
    expect(plain).toContain("198.51.100.99");
    expect(plain).toMatch(/Spends after the open 2/);
    expect(plain).toMatch(/Distinct observed addresses 198\.51\.100\.23, 198\.51\.100\.99/);
    expect(html).toContain("comparison-different");
    expect(plain).toContain("evidence that the session traffic reached the gateway on a different route");
    expect(plain).toContain(ROUTING_STATEMENT);
    // Probe, session, and the spend table column.
    expect(plain.match(/Observed source IP/g)?.length).toBe(3);
  });

  it("says when a session address is the probe address", () => {
    const events = [...sessionEvents, ev(8, "rpc_received", BATCH, "203.0.113.7", "2"), ev(9, "rpc_completed", BATCH, "203.0.113.7", "2")];
    expect(render(true, probeReady, events)).toContain("comparison-same");
  });

  it("waits for the probe and a session_opened event", () => {
    const plain = text(render(true, { state: "idle" }, sessionEvents.slice(0, 2)));
    expect(plain).toContain("Not run.");
    expect(plain).toContain("No session_opened event");
    expect(plain).toContain("No comparison yet");
  });

  it("shows a probe failure without a comparison", () => {
    const html = render(true, { state: "failed", error: "direct probe: not found (404)" });
    expect(text(html)).toContain("direct probe: not found (404)");
    expect(html).toContain("comparison-incomplete");
  });

  it("shows unavailable and no probe when IP capture is off", () => {
    const plain = text(render(false, { state: "idle" }));
    expect(plain).toMatch(/Observed source IP unavailable/);
    expect(plain).toContain("DEMO_IP_LOGGING=false");
    expect(plain).not.toContain("Direct probe");
    expect(plain).not.toContain(NOX);
  });

  it("never claims that a user is anonymous or verified", () => {
    for (const html of [render(true, probeReady), render(false, { state: "idle" })]) {
      expect(html.toLowerCase()).not.toContain("verified anonymous");
      expect(html.toLowerCase()).not.toContain("anonymous user");
    }
  });
});

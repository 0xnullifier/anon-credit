// Rendering tests of the connection diagnostics: probe and session comparison, and the
// "unavailable" view of the normal profile.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { makeEvent, sharedDemoEvent, sharedDemoPeer } from "../testing/shared.ts";
import type { Load } from "./common.tsx";
import { DiagnosticsPanel, ROUTING_STATEMENT, type ProbeResult } from "./DiagnosticsPanel.tsx";

const noop = (): void => {};
const sessionEvent = makeEvent(41, { observed_ip: "198.51.100.23", ip_attribution: "socket", proxy_hop: null });

function render(ipLogging: boolean, probe: Load<ProbeResult>, session = sessionEvent): string {
  return renderToStaticMarkup(
    <DiagnosticsPanel
      ipLogging={ipLogging}
      latestEvent={sharedDemoEvent}
      sessionEvent={session}
      probe={probe}
      gatewayUrl="http://127.0.0.1:8081"
      onGatewayUrl={noop}
      onProbe={noop}
    />,
  );
}

// Text of the markup without tags.
function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

describe("DiagnosticsPanel", () => {
  it("shows the probe and the session addresses side by side and says that they differ", () => {
    const html = render(true, { state: "ready", value: { peer: sharedDemoPeer, atMs: 1_800_000_000_000 }, at: 1 });
    const plain = text(html);
    expect(plain).toContain("Direct probe (this browser)");
    expect(plain).toContain("Most recent anonymous session");
    expect(plain).toContain("203.0.113.7");
    expect(plain).toContain("198.51.100.23");
    expect(html).toContain("comparison-different");
    expect(plain).toContain("evidence that the session traffic reached the gateway on a different route");
    expect(plain).toContain(ROUTING_STATEMENT);
    expect(plain.match(/Observed source IP/g)?.length).toBe(3);
  });

  it("says when the addresses are the same", () => {
    const same = makeEvent(42, { observed_ip: "203.0.113.7", ip_attribution: "socket", proxy_hop: null });
    const html = render(true, { state: "ready", value: { peer: sharedDemoPeer, atMs: 1 }, at: 1 }, same);
    expect(html).toContain("comparison-same");
  });

  it("shows the trusted proxy hop as the socket peer and the forwarded address as the effective source", () => {
    const plain = text(render(true, { state: "idle" }));
    expect(plain).toContain("forwarding header from a trusted proxy");
    expect(plain).toMatch(/Socket peer IP 10\.0\.0\.1/);
    expect(plain).toMatch(/Effective source IP 203\.0\.113\.7/);
    expect(plain).toContain("Not run.");
    expect(plain).toContain("No comparison yet");
  });

  it("shows a probe failure without a comparison", () => {
    const html = render(true, { state: "failed", error: "direct probe: not found (404)" });
    expect(text(html)).toContain("direct probe: not found (404)");
    expect(html).toContain("comparison-incomplete");
  });

  it("shows unavailable and a note when IP capture is off, and no probe button", () => {
    const html = render(false, { state: "idle" }, makeEvent(43));
    const plain = text(html);
    expect(plain).toMatch(/Observed source IP unavailable/);
    expect(plain).toContain("DEMO_IP_LOGGING=false");
    expect(plain).toContain(ROUTING_STATEMENT);
    expect(plain).not.toContain("Direct probe");
    expect(plain).not.toContain("198.51.100.23");
  });

  it("never claims that a user is anonymous or verified", () => {
    for (const html of [
      render(true, { state: "ready", value: { peer: sharedDemoPeer, atMs: 1 }, at: 1 }),
      render(false, { state: "idle" }),
    ]) {
      expect(html.toLowerCase()).not.toContain("verified anonymous");
      expect(html.toLowerCase()).not.toContain("anonymous user");
    }
  });
});

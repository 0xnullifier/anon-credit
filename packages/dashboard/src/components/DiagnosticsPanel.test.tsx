// Rendering tests of the connection diagnostics: the newest event, the trusted proxy hop, and
// the "unavailable" view of the normal profile.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { makeEvent, sharedDemoEvent } from "../testing/shared.ts";
import { DiagnosticsPanel, ROUTING_STATEMENT } from "./DiagnosticsPanel.tsx";

// Text of the markup without tags.
function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

describe("DiagnosticsPanel", () => {
  it("shows the trusted proxy hop as the socket peer and the forwarded address as the effective source", () => {
    const plain = text(renderToStaticMarkup(<DiagnosticsPanel ipLogging latestEvent={sharedDemoEvent} />));
    expect(plain).toContain("forwarding header from a trusted proxy");
    expect(plain).toMatch(/Socket peer IP 10\.0\.0\.1/);
    expect(plain).toMatch(/Effective source IP 203\.0\.113\.7/);
    expect(plain).toMatch(/Observed source IP 203\.0\.113\.7/);
    expect(plain).toContain(ROUTING_STATEMENT);
  });

  it("shows the socket peer when no trusted proxy forwarded the request", () => {
    const event = makeEvent(41, { observed_ip: "198.51.100.23", ip_attribution: "socket", proxy_hop: null });
    const plain = text(renderToStaticMarkup(<DiagnosticsPanel ipLogging latestEvent={event} />));
    expect(plain).toContain("socket peer (no trusted proxy)");
    expect(plain).toMatch(/Proxy hop none/);
  });

  it("says no observation before the first event", () => {
    expect(text(renderToStaticMarkup(<DiagnosticsPanel ipLogging latestEvent={null} />))).toContain("no observation");
  });

  it("shows unavailable and a note when IP capture is off", () => {
    const plain = text(renderToStaticMarkup(<DiagnosticsPanel ipLogging={false} latestEvent={makeEvent(43)} />));
    expect(plain).toMatch(/Observed source IP unavailable/);
    expect(plain).toContain("DEMO_IP_LOGGING=false");
    expect(plain).toContain(ROUTING_STATEMENT);
    expect(plain).not.toContain("Direct probe");
  });
});

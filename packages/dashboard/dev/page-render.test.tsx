// Render all dashboard views with the state of the mock gateway after one replay round.
// The event table must have exactly one row for each received event, and no claim of
// anonymity.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DiagnosticsPanel } from "../src/components/DiagnosticsPanel.tsx";
import { EventList } from "../src/components/EventList.tsx";
import { HealthPanel } from "../src/components/HealthPanel.tsx";
import { PrivacyPanel } from "../src/components/PrivacyPanel.tsx";
import { SessionPanel } from "../src/components/SessionPanel.tsx";
import { latestSessionEvent } from "../src/lib/events-model.ts";
import { INITIAL_LIVE } from "../src/lib/live-state.ts";
import { loadFixture, MockGateway } from "./mock-server.ts";

function renderPage(ipLogging: boolean): { html: string; eventCount: number } {
  const fixture = loadFixture();
  const gateway = new MockGateway(fixture, ipLogging);
  for (const entry of fixture.script) {
    gateway.publish(entry);
  }
  const snapshot = gateway.snapshot();
  const events = snapshot.recent_events;
  const batchId = snapshot.recent_sessions[0]?.session.batch_id ?? "";
  const detail = gateway.session(batchId);
  const noop = (): void => {};
  const html = renderToStaticMarkup(
    <>
      <HealthPanel snapshot={snapshot} events={events} stream={{ ...INITIAL_LIVE.stream, state: "open", invalid: 1 }} />
      <EventList events={events} filter={{ kind: "all", batch: "" }} onFilter={noop} onSelectBatch={noop} />
      <SessionPanel
        snapshot={snapshot}
        selected={batchId}
        detail={detail === null ? { state: "failed", error: "missing" } : { state: "ready", value: detail, at: 1 }}
        onSelect={noop}
        onRefresh={noop}
      />
      <DiagnosticsPanel
        ipLogging={snapshot.demo_ip_logging}
        latestEvent={events.at(-1) ?? null}
        sessionEvent={latestSessionEvent(events)}
        probe={{ state: "idle" }}
        gatewayUrl="http://127.0.0.1:8081"
        onGatewayUrl={noop}
        onProbe={noop}
      />
      <PrivacyPanel
        snapshot={snapshot}
        prices={{ state: "ready", value: fixture.prices, at: 1 }}
        roots={{ state: "ready", value: gateway.roots(), at: 1 }}
        onReload={noop}
      />
    </>,
  );
  return { html, eventCount: events.length };
}

describe("dashboard page", () => {
  it("renders every view from the mock state with one row for each real event", () => {
    const { html, eventCount } = renderPage(true);
    const eventTable = html.slice(html.indexOf('aria-labelledby="events-title"'), html.indexOf('aria-labelledby="sessions-title"'));
    const rows = eventTable.match(/<tr>/g)?.length ?? 0;
    // One header row and one row for each event. The malformed fixture entry is not an event.
    expect(eventCount).toBe(loadFixture().script.length - 1);
    expect(rows).toBe(eventCount + 1);
    expect(html).toContain("Observed source IP");
    expect(html).toContain("198.51.100.23");
    expect(html).toContain("Recent receipts");
    expect(html).toContain("matches the canonical encoding");
    expect(html.toLowerCase()).not.toContain("verified anonymous");
  });

  it("renders no addresses in the normal profile", () => {
    const { html } = renderPage(false);
    expect(html).not.toMatch(/198\.51\.100\.|203\.0\.113\.|10\.0\.0\.1/);
    expect(html).toContain("DEMO_IP_LOGGING=false");
  });
});

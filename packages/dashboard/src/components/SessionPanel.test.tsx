// Rendering tests of the session panel: deadline time in UTC, the receipt count, and the
// timeline of the selected batch.

import type { EventKind, GatewayEvent } from "@anon-credit/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { makeEvent, sharedSessionDetail, sharedSnapshot } from "../testing/shared.ts";
import { receiptCountText, SessionPanel } from "./SessionPanel.tsx";

const noop = (): void => {};
const batch = sharedSessionDetail.summary.session.batch_id;

function ev(id: number, kind: EventKind, batchId: string | null, atMs: number): GatewayEvent {
  return makeEvent(id, { kind, batch_id: batchId, at_ms: String(atMs), observed_ip: "198.51.100.23", ip_attribution: "socket", proxy_hop: null });
}

// Text of the markup without tags.
function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

function render(events: readonly GatewayEvent[]): string {
  return renderToStaticMarkup(
    <SessionPanel
      snapshot={sharedSnapshot}
      events={events}
      selected={batch}
      detail={{ state: "ready", value: sharedSessionDetail, at: 1 }}
      onSelect={noop}
      onRefresh={noop}
    />,
  );
}

describe("SessionPanel", () => {
  it("shows the deadline as a UTC time from the snapshot epoch length", () => {
    const { deadline_epoch: deadline } = sharedSessionDetail.summary.session;
    const end = new Date((Number(deadline) + 1) * sharedSnapshot.epoch_seconds * 1000).toISOString().replace("T", " ").slice(0, 19);
    const plain = text(render([]));
    expect(plain).toContain(`Can spend until (UTC) ${end}`);
    expect(plain).toContain("No event of this batch in the received events.");
  });

  it("shows the receipt count", () => {
    expect(receiptCountText(3, "3")).toBe("3 receipts (all)");
    expect(receiptCountText(200, "250")).toBe("newest 200 of 250 receipts");
    expect(text(render([]))).toMatch(/\d+ receipts \(all\)|newest \d+ of \d+ receipts/);
  });

  it("shows the timeline of the selected batch in order with the inferred open_received", () => {
    const events = [
      ev(1, "open_received", null, 1000),
      ev(2, "open_verified", batch, 1250),
      ev(3, "session_opened", batch, 1260),
      ev(4, "rpc_received", batch, 2000),
      ev(5, "rpc_completed", batch, 2030),
    ];
    const html = render(events);
    const plain = text(html);
    const order = ["open_received *", "open_verified", "session_opened", "rpc_received", "rpc_completed"].map((kind) => plain.indexOf(kind));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('class="inferred"');
    expect(plain).toContain("open_received before it reads the batch ID");
  });
});

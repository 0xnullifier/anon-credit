// Tests of the demo comparison and the session timeline functions.

import type { EventKind } from "@anon-credit/protocol";
import { describe, expect, it } from "vitest";
import { makeEvent } from "../testing/shared.ts";
import { compareObservedAll, distinctObservedIps, latestOpenedSession, sessionTimeline } from "./events-model.ts";
import { epochEndUtc, epochStartUtc } from "./format.ts";

const BATCH_A = `0x${"0a".repeat(32)}`;
const BATCH_B = `0x${"0b".repeat(32)}`;
const NOX_A = "198.51.100.23";
const NOX_B = "198.51.100.41";

function ev(id: number, kind: EventKind, batch: string | null, ip: string, atMs: number) {
  return makeEvent(id, { kind, batch_id: batch, observed_ip: ip, ip_attribution: "socket", proxy_hop: null, at_ms: String(atMs) });
}

const events = [
  ev(1, "open_received", null, NOX_A, 1000),
  ev(2, "open_verified", BATCH_A, NOX_A, 1300),
  ev(3, "session_opened", BATCH_A, NOX_A, 1310),
  ev(4, "rpc_received", BATCH_A, NOX_A, 2000),
  ev(5, "rpc_completed", BATCH_A, NOX_A, 2020),
  ev(6, "open_received", null, NOX_B, 3000),
  ev(7, "open_received", null, NOX_A, 3100),
  ev(8, "open_verified", BATCH_B, NOX_B, 3400),
  ev(9, "session_opened", BATCH_B, NOX_B, 3410),
  ev(10, "rpc_received", BATCH_B, NOX_B, 4000),
  ev(11, "rpc_completed", BATCH_B, NOX_B, 4020),
  ev(12, "rpc_received", BATCH_B, NOX_A, 4500),
  ev(13, "rpc_replayed", BATCH_B, NOX_A, 4510),
  ev(14, "rpc_completed", BATCH_A, NOX_A, 5000),
];

describe("demo comparison model", () => {
  it("finds the newest opened session and the spend outcomes of its batch", () => {
    const observation = latestOpenedSession(events);
    expect(observation?.opened.id).toBe("9");
    expect(observation?.spends.map((event) => event.id)).toEqual(["11", "13"]);
    expect(latestOpenedSession(events.slice(0, 2))).toBeNull();
  });

  it("lists distinct observed addresses without unavailable", () => {
    const list = [...events, makeEvent(20, { observed_ip: "unavailable", ip_attribution: "unavailable" })];
    expect(distinctObservedIps(list)).toEqual([NOX_A, NOX_B]);
  });

  it("compares the probe with all the session addresses", () => {
    expect(compareObservedAll("203.0.113.7", [NOX_A, NOX_B])).toBe("different");
    expect(compareObservedAll(NOX_B, [NOX_A, NOX_B])).toBe("same");
    expect(compareObservedAll(null, [NOX_A])).toBe("incomplete");
    expect(compareObservedAll("unavailable", [NOX_A])).toBe("incomplete");
    expect(compareObservedAll("203.0.113.7", [])).toBe("incomplete");
  });
});

describe("session timeline", () => {
  it("puts open_received, open_verified, session_opened, and the rpc events in order", () => {
    const timeline = sessionTimeline(events, BATCH_B);
    expect(timeline.map((entry) => [entry.event.id, entry.event.kind, entry.match])).toEqual([
      ["6", "open_received", "order"],
      ["8", "open_verified", "batch"],
      ["9", "session_opened", "batch"],
      ["10", "rpc_received", "batch"],
      ["11", "rpc_completed", "batch"],
      ["12", "rpc_received", "batch"],
      ["13", "rpc_replayed", "batch"],
    ]);
    expect(timeline.map((entry) => entry.offsetMs)).toEqual([0, 400, 410, 1000, 1020, 1500, 1510]);
  });

  it("uses only an open_received from the same observed address", () => {
    const timeline = sessionTimeline(events, BATCH_A);
    expect(timeline[0]?.event.id).toBe("1");
    expect(timeline.at(-1)?.event.id).toBe("14");
  });

  it("adds no open_received when the open events are not in the view", () => {
    const timeline = sessionTimeline(events.slice(9), BATCH_B);
    expect(timeline.map((entry) => entry.match)).toEqual(["batch", "batch", "batch", "batch"]);
    expect(sessionTimeline(events, `0x${"0c".repeat(32)}`)).toEqual([]);
  });
});

describe("epoch times", () => {
  it("gives the start and the end of an epoch in UTC", () => {
    expect(epochStartUtc("60000000", 30)).toBe("2027-01-15 08:00:00");
    expect(epochEndUtc("60000000", 30)).toBe("2027-01-15 08:00:30");
    expect(epochEndUtc("bad", 30)).toBe("bad");
  });
});

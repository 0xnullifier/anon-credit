// Tests of the pure event functions.

import { describe, expect, it } from "vitest";
import { makeEvent, sharedDemoEvent } from "../testing/shared.ts";
import {
  attribution,
  compareObserved,
  eventResult,
  filterEvents,
  isNewOpen,
  isSpend,
  latencyStats,
  latestSessionEvent,
  mergeEvents,
} from "./events-model.ts";
import { bytes, count, duration, shortHex, utcFromMs, utcFromSeconds } from "./format.ts";

const BATCH_A = `0x${"0a".repeat(32)}`;
const BATCH_B = `0x${"0b".repeat(32)}`;

describe("events model", () => {
  it("merges by ID in numeric order, removes repeats, and keeps the newest", () => {
    const merged = mergeEvents([makeEvent(10), makeEvent(9)], [makeEvent(10), makeEvent(100), makeEvent(11)], 3);
    expect(merged.map((event) => event.id)).toEqual(["10", "11", "100"]);
  });

  it("filters by kind and by part of the batch ID", () => {
    const events = [
      makeEvent(1, { kind: "open_received", batch_id: null }),
      makeEvent(2, { kind: "rpc_completed", batch_id: BATCH_A }),
      makeEvent(3, { kind: "rpc_rejected", batch_id: BATCH_B, error_code: "sequence_gap", units: null, remaining: null }),
    ];
    expect(filterEvents(events, { kind: "all", batch: "" }).map((e) => e.id)).toEqual(["1", "2", "3"]);
    expect(filterEvents(events, { kind: "rpc_rejected", batch: "" }).map((e) => e.id)).toEqual(["3"]);
    expect(filterEvents(events, { kind: "all", batch: " 0A0A " }).map((e) => e.id)).toEqual(["2"]);
  });

  it("finds the newest event of an anonymous session", () => {
    const events = [makeEvent(1, { batch_id: BATCH_A, observed_ip: "198.51.100.9" }), makeEvent(2, { batch_id: null })];
    expect(latestSessionEvent(events)?.observed_ip).toBe("198.51.100.9");
    expect(latestSessionEvent([makeEvent(3, { batch_id: null })])).toBeNull();
  });

  it("maps kinds and error codes to results", () => {
    expect(eventResult(makeEvent(1)).label).toBe("charged");
    expect(eventResult(sharedDemoEvent)).toEqual({ label: "sequence_gap", tone: "warn" });
    expect(eventResult(makeEvent(2, { kind: "session_opened", units: null })).label).toBe("exact retry");
    expect(eventResult(makeEvent(3, { kind: "upstream_failed", error_code: "upstream_failed" })).tone).toBe("error");
  });

  it("shows the socket peer and the effective source address", () => {
    expect(attribution("203.0.113.7", "trusted_proxy", "10.0.0.1")).toMatchObject({ socketPeer: "10.0.0.1", effective: "203.0.113.7" });
    expect(attribution("198.51.100.9", "socket", null)).toMatchObject({ socketPeer: "198.51.100.9", effective: "198.51.100.9" });
    expect(attribution("unavailable", "unavailable", null).observed).toBe("unavailable");
  });

  it("compares the probe and the session addresses", () => {
    expect(compareObserved("203.0.113.7", "198.51.100.9")).toBe("different");
    expect(compareObserved("203.0.113.7", "203.0.113.7")).toBe("same");
    expect(compareObserved(null, "203.0.113.7")).toBe("incomplete");
    expect(compareObserved("203.0.113.7", "unavailable")).toBe("incomplete");
  });

  it("calculates median and p95 latency of real events only", () => {
    const events = [1, 2, 3, 4, 100].map((ms, i) => makeEvent(i + 1, { latency_ms: ms }));
    expect(latencyStats(events, isSpend)).toEqual({ count: 5, median: 3, p95: 100 });
    expect(latencyStats(events, isNewOpen)).toBeNull();
  });
});

describe("format", () => {
  it("formats UTC times, IDs, sizes, and counts", () => {
    expect(utcFromMs("1800000000123")).toBe("2027-01-15 08:00:00.123");
    expect(utcFromSeconds("1800000000")).toBe("2027-01-15 08:00:00");
    expect(shortHex(BATCH_A)).toBe("0x0a0a0a…0a0a");
    expect(bytes(300000)).toBe("293.0 KiB");
    expect(count("18446744073709551615")).toBe("18,446,744,073,709,551,615");
    expect(duration(3725)).toBe("1h 2m");
  });
});

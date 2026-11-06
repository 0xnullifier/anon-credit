// Pure functions over the events that the gateway sent. Nothing here makes an event.

import type { EventKind, GatewayEvent, IpAttribution } from "@anon-credit/protocol";

// Largest number of events that the dashboard keeps.
export const MAX_EVENTS = 2000;

// Order of two decimal event IDs.
export function compareIds(a: string, b: string): number {
  const delta = BigInt(a) - BigInt(b);
  switch (true) {
    case delta < 0n:
      return -1;
    case delta > 0n:
      return 1;
    default:
      return 0;
  }
}

// Merge events by ID, oldest first. Keep the newest MAX_EVENTS.
export function mergeEvents(current: readonly GatewayEvent[], incoming: readonly GatewayEvent[], limit = MAX_EVENTS): GatewayEvent[] {
  const byId = new Map<string, GatewayEvent>();
  for (const event of current) {
    byId.set(event.id, event);
  }
  for (const event of incoming) {
    byId.set(event.id, event);
  }
  const merged = [...byId.values()].sort((a, b) => compareIds(a.id, b.id));
  return merged.slice(Math.max(0, merged.length - limit));
}

export interface EventFilter {
  readonly kind: EventKind | "all";
  readonly batch: string;
}

// Events that match the filter. The batch text matches any part of the batch ID.
export function filterEvents(events: readonly GatewayEvent[], filter: EventFilter): GatewayEvent[] {
  const batch = filter.batch.trim().toLowerCase();
  return events.filter(
    (event) =>
      (filter.kind === "all" || event.kind === filter.kind) &&
      (batch === "" || (event.batch_id !== null && event.batch_id.includes(batch))),
  );
}

// The newest event of an anonymous session: an event with a batch ID.
export function latestSessionEvent(events: readonly GatewayEvent[]): GatewayEvent | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event !== undefined && event.batch_id !== null) {
      return event;
    }
  }
  return null;
}

export type Tone = "ok" | "warn" | "error" | "info";

export interface EventResult {
  readonly label: string;
  readonly tone: Tone;
}

// The result column of an event, from its kind and error code.
export function eventResult(event: GatewayEvent): EventResult {
  switch (event.kind) {
    case "open_received":
    case "rpc_received":
      return { label: "received", tone: "info" };
    case "open_verified":
      return { label: "proof verified", tone: "ok" };
    case "session_opened":
      return event.units === null ? { label: "exact retry", tone: "info" } : { label: "opened", tone: "ok" };
    case "rpc_completed":
      return { label: "charged", tone: "ok" };
    case "rpc_replayed":
      return { label: "replayed, no charge", tone: "info" };
    case "open_rejected":
    case "rpc_rejected":
      return { label: event.error_code ?? "rejected", tone: "warn" };
    case "upstream_failed":
    case "storage_failed":
      return { label: event.error_code ?? event.kind, tone: "error" };
  }
}

export interface Attribution {
  readonly observed: string;
  readonly socketPeer: string;
  readonly effective: string;
  readonly source: string;
}

// The connection diagnostics of one observation (event or direct probe).
export function attribution(observedIp: string, kind: IpAttribution, proxyHop: string | null): Attribution {
  switch (kind) {
    case "socket":
      return { observed: observedIp, socketPeer: observedIp, effective: observedIp, source: "socket peer (no trusted proxy)" };
    case "trusted_proxy":
      return {
        observed: observedIp,
        socketPeer: proxyHop ?? "not reported",
        effective: observedIp,
        source: "forwarding header from a trusted proxy",
      };
    case "unavailable":
      return { observed: "unavailable", socketPeer: "unavailable", effective: "unavailable", source: "IP capture is off" };
  }
}

export type Comparison = "different" | "same" | "incomplete";

// Compare the direct probe address with the session address.
export function compareObserved(probeIp: string | null, sessionIp: string | null): Comparison {
  switch (true) {
    case probeIp === null || sessionIp === null || probeIp === "unavailable" || sessionIp === "unavailable":
      return "incomplete";
    case probeIp === sessionIp:
      return "same";
    default:
      return "different";
  }
}

export interface LatencyStats {
  readonly count: number;
  readonly median: number;
  readonly p95: number;
}

// Nearest-rank percentile of sorted values.
function percentile(sorted: readonly number[], fraction: number): number {
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1] ?? 0;
}

// Median and p95 of latency_ms of the events that the predicate selects.
export function latencyStats(events: readonly GatewayEvent[], select: (event: GatewayEvent) => boolean): LatencyStats | null {
  const values: number[] = [];
  for (const event of events) {
    if (select(event) && event.latency_ms !== null) {
      values.push(event.latency_ms);
    }
  }
  if (values.length === 0) {
    return null;
  }
  values.sort((a, b) => a - b);
  return { count: values.length, median: percentile(values, 0.5), p95: percentile(values, 0.95) };
}

// Spend latency: committed debits.
export const isSpend = (event: GatewayEvent): boolean => event.kind === "rpc_completed";
// Open latency: new sessions (an exact retry has no units).
export const isNewOpen = (event: GatewayEvent): boolean => event.kind === "session_opened" && event.units !== null;
// Proof verification time at the sidecar.
export const isVerify = (event: GatewayEvent): boolean => event.kind === "open_verified";

// The outcome events of a spend request. rpc_received is not an outcome.
function isSpendOutcome(event: GatewayEvent): boolean {
  switch (event.kind) {
    case "rpc_completed":
    case "rpc_replayed":
    case "rpc_rejected":
    case "upstream_failed":
    case "storage_failed":
      return true;
    default:
      return false;
  }
}

export interface SessionObservation {
  // The newest session_opened event.
  readonly opened: GatewayEvent;
  // The spend outcome events of the same batch after the open, oldest first.
  readonly spends: readonly GatewayEvent[];
}

// The newest session_opened event and the spend outcomes of its batch. Null if no session
// opened in the received events.
export function latestOpenedSession(events: readonly GatewayEvent[]): SessionObservation | null {
  let opened: GatewayEvent | null = null;
  for (let i = events.length - 1; i >= 0 && opened === null; i -= 1) {
    const event = events[i];
    if (event !== undefined && event.kind === "session_opened" && event.batch_id !== null) {
      opened = event;
    }
  }
  if (opened === null) {
    return null;
  }
  const batch = opened.batch_id;
  const after = opened.id;
  const spends = events.filter((event) => event.batch_id === batch && isSpendOutcome(event) && compareIds(event.id, after) > 0);
  return { opened, spends };
}

// The observed addresses of events, without repeats and without "unavailable", in order.
export function distinctObservedIps(events: readonly GatewayEvent[]): string[] {
  const seen = new Set<string>();
  for (const event of events) {
    if (event.observed_ip !== "unavailable") {
      seen.add(event.observed_ip);
    }
  }
  return [...seen];
}

// Compare the direct probe address with all the addresses of one session.
// "same" if one session address is the probe address.
export function compareObservedAll(probeIp: string | null, sessionIps: readonly string[]): Comparison {
  switch (true) {
    case probeIp === null || probeIp === "unavailable" || sessionIps.length === 0:
      return "incomplete";
    case sessionIps.includes(probeIp ?? ""):
      return "same";
    default:
      return "different";
  }
}

// How a timeline entry belongs to the batch.
// "batch": the event has the batch ID.
// "order": an open_received event. The gateway sends open_received before it parses the body,
// so the event has no batch ID. The timeline uses the newest open_received from the same
// observed address before the first open event of the batch.
export type TimelineMatch = "batch" | "order";

export interface TimelineEntry {
  readonly event: GatewayEvent;
  readonly match: TimelineMatch;
  // Milliseconds after the first entry of the timeline.
  readonly offsetMs: number;
}

// Events of the open path that have a batch ID.
function isOpenStep(event: GatewayEvent): boolean {
  switch (event.kind) {
    case "open_verified":
    case "open_rejected":
    case "session_opened":
      return true;
    default:
      return false;
  }
}

// The timeline of one batch: open_received -> open_verified -> session_opened -> rpc_*.
// The events must be oldest first.
export function sessionTimeline(events: readonly GatewayEvent[], batchId: string): TimelineEntry[] {
  const own = events.filter((event) => event.batch_id === batchId);
  const first = own[0];
  const picked: { readonly event: GatewayEvent; readonly match: TimelineMatch }[] = [];
  if (first !== undefined && isOpenStep(first)) {
    let received: GatewayEvent | null = null;
    for (const event of events) {
      if (compareIds(event.id, first.id) >= 0) {
        break;
      }
      if (event.kind === "open_received" && event.batch_id === null && event.observed_ip === first.observed_ip) {
        received = event;
      }
    }
    if (received !== null) {
      picked.push({ event: received, match: "order" });
    }
  }
  for (const event of own) {
    picked.push({ event, match: "batch" });
  }
  const start = Number(picked[0]?.event.at_ms ?? "0");
  return picked.map(({ event, match }) => ({ event, match, offsetMs: Number(event.at_ms) - start }));
}

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

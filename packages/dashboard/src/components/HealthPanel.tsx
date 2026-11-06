// View 1: health and counters, from the admin snapshot and the received events.

import type { AdminSnapshot, GatewayEvent } from "@anon-credit/protocol";
import type { ReactNode } from "react";
import type { StreamState } from "../lib/event-stream.ts";
import { isNewOpen, isSpend, isVerify, latencyStats, type LatencyStats, type Tone } from "../lib/events-model.ts";
import { bytes, chainName, count, duration, utcFromSeconds } from "../lib/format.ts";
import type { StreamStatus } from "../lib/live-state.ts";
import { Field, Panel, Pill } from "./common.tsx";

function streamTone(state: StreamState): Tone {
  switch (state) {
    case "open":
      return "ok";
    case "connecting":
    case "retrying":
      return "warn";
    case "unauthorized":
    case "stopped":
      return "error";
  }
}

// Tone of a failure counter: error if it is not zero.
function failureTone(decimal: string): Tone | undefined {
  return decimal === "0" ? undefined : "error";
}

function Latency(props: { readonly stats: LatencyStats | null }) {
  const { stats } = props;
  return stats === null ? (
    <span className="muted">no events</span>
  ) : (
    <span>
      {stats.median} ms / {stats.p95} ms <span className="muted">(n={stats.count})</span>
    </span>
  );
}

// Median of numbers, or null for none.
function median(values: readonly number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? null : (sorted[Math.floor((sorted.length - 1) / 2)] ?? null);
}

// A titled group of fields.
function Group(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <div className="stat-group">
      <h3>{props.title}</h3>
      <dl>{props.children}</dl>
    </div>
  );
}

export interface HealthPanelProps {
  readonly snapshot: AdminSnapshot;
  readonly events: readonly GatewayEvent[];
  readonly stream: StreamStatus;
}

export function HealthPanel(props: HealthPanelProps) {
  const { snapshot, stream, events } = props;
  const { counters, roots, sessions } = snapshot;
  const uptime = Number(BigInt(snapshot.now) - BigInt(snapshot.started_at));
  const rootAge = roots.latest_age_epochs;
  const proofSize = median(snapshot.recent_sessions.map((s) => s.proof_size));
  const verifyMs = median(snapshot.recent_sessions.map((s) => s.verify_ms));
  return (
    <Panel id="health" title="Health and counters" className="health">
      <div className="stat-groups">
        <Group title="Gateway">
          <Field label="Status">
            <Pill tone={snapshot.status === "ok" ? "ok" : "warn"}>{snapshot.status}</Pill>
          </Field>
          <Field label="Upstream chain">
            {chainName(snapshot.upstream_chain_id)} ({snapshot.upstream_chain_id})
          </Field>
          <Field label="Current epoch">{snapshot.current_epoch}</Field>
          <Field label="Up time">{duration(uptime)}</Field>
          <Field label="Snapshot time (UTC)">{utcFromSeconds(snapshot.now)}</Field>
        </Group>
        <Group title="Accepted roots">
          <Field label="Roots in window">{roots.accepted}</Field>
          <Field label="Newest source epoch">{roots.latest_source_epoch ?? "none"}</Field>
          <Field label="Accepted root age" tone={rootAge === null ? "warn" : undefined}>
            {rootAge === null ? "no accepted root" : `${rootAge} epochs`}
          </Field>
          <Field label="Last refresh (UTC)">{roots.last_refresh_at === null ? "never" : utcFromSeconds(roots.last_refresh_at)}</Field>
          {roots.last_error === null ? null : (
            <Field label="Last refresh error" tone="error">
              {roots.last_error}
            </Field>
          )}
        </Group>
        <Group title="Sessions">
          <Field label="Open (active)">{count(sessions.active)}</Field>
          <Field label="At zero units">{count(sessions.exhausted)}</Field>
          <Field label="Expired">{count(sessions.expired)}</Field>
          <Field label="Units charged, retained sessions">{count(sessions.units_charged)}</Field>
          <Field label="Median proof size">{proofSize === null ? "no sessions" : bytes(proofSize)}</Field>
          <Field label="Median verification">{verifyMs === null ? "no sessions" : `${verifyMs} ms`}</Field>
        </Group>
        <Group title="Requests since start">
          <Field label="Opens received">{count(counters.open_received)}</Field>
          <Field label="Sessions opened">{count(counters.sessions_opened)}</Field>
          <Field label="RPC received">{count(counters.rpc_received)}</Field>
          <Field label="RPC charged">{count(counters.rpc_completed)}</Field>
          <Field label="RPC replayed">{count(counters.rpc_replayed)}</Field>
          <Field label="Units charged">{count(counters.units_charged)}</Field>
        </Group>
        <Group title="Failures since start">
          <Field label="Opens rejected" tone={failureTone(counters.open_rejected)}>
            {count(counters.open_rejected)}
          </Field>
          <Field label="RPC rejected" tone={failureTone(counters.rpc_rejected)}>
            {count(counters.rpc_rejected)}
          </Field>
          <Field label="Upstream failed" tone={failureTone(counters.upstream_failed)}>
            {count(counters.upstream_failed)}
          </Field>
          <Field label="Storage failed" tone={failureTone(counters.storage_failed)}>
            {count(counters.storage_failed)}
          </Field>
        </Group>
        <Group title="Latency, median / p95">
          <Field label="Spend (charged RPC)">
            <Latency stats={latencyStats(events, isSpend)} />
          </Field>
          <Field label="Open (new session)">
            <Latency stats={latencyStats(events, isNewOpen)} />
          </Field>
          <Field label="Proof verification">
            <Latency stats={latencyStats(events, isVerify)} />
          </Field>
          <Field label="Source">{events.length} events in this view</Field>
        </Group>
        <Group title="Event stream">
          <Field label="State">
            <Pill tone={streamTone(stream.state)}>{stream.state}</Pill>
          </Field>
          {stream.detail === null ? null : <Field label="Detail">{stream.detail}</Field>}
          <Field label="Last event ID">{stream.lastEventId ?? "none"}</Field>
          <Field label="Events received">{stream.received}</Field>
          <Field label="Invalid, discarded" tone={stream.invalid === 0 ? undefined : "warn"}>
            {stream.invalid}
          </Field>
          {stream.lastInvalid === null ? null : <Field label="Last invalid">{stream.lastInvalid}</Field>}
          <Field label="Repeated IDs, discarded">{stream.duplicates}</Field>
        </Group>
      </div>
    </Panel>
  );
}

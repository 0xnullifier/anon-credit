// View 2: live event list. It shows only events that the gateway sent and that passed the
// schema check. It never makes an event.

import { eventKindSchema, type EventKind, type GatewayEvent } from "@anon-credit/protocol";
import type { ChangeEvent } from "react";
import { eventResult, filterEvents, type EventFilter } from "../lib/events-model.ts";
import { utcFromMs } from "../lib/format.ts";
import { HexId, Panel, Pill } from "./common.tsx";

// Largest number of rows on the page.
export const MAX_ROWS = 300;

const KINDS: readonly EventKind[] = eventKindSchema.options;

// Read the kind filter from the select value.
function kindFilter(value: string): EventKind | "all" {
  const parsed = eventKindSchema.safeParse(value);
  return parsed.success ? parsed.data : "all";
}

function units(event: GatewayEvent): string {
  switch (true) {
    case event.units !== null && event.remaining !== null:
      return `${event.units} / ${event.remaining}`;
    case event.remaining !== null:
      return `– / ${event.remaining}`;
    default:
      return "";
  }
}

export interface EventListProps {
  readonly events: readonly GatewayEvent[];
  readonly filter: EventFilter;
  readonly onFilter: (filter: EventFilter) => void;
  readonly onSelectBatch: (batchId: string) => void;
}

export function EventList(props: EventListProps) {
  const { events, filter, onFilter, onSelectBatch } = props;
  const matching = filterEvents(events, filter);
  const rows = matching.slice(-MAX_ROWS).reverse();
  const onKind = (change: ChangeEvent<HTMLSelectElement>): void => onFilter({ ...filter, kind: kindFilter(change.target.value) });
  const onBatch = (change: ChangeEvent<HTMLInputElement>): void => onFilter({ ...filter, batch: change.target.value });
  return (
    <Panel
      id="events"
      title="Live events"
      className="events"
      actions={
        <form className="filters" onSubmit={(submit) => submit.preventDefault()}>
          <label>
            Kind{" "}
            <select value={filter.kind} onChange={onKind}>
              <option value="all">all</option>
              {KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
          </label>
          <label>
            Batch ID{" "}
            <input type="search" placeholder="0x… (part)" value={filter.batch} onChange={onBatch} spellCheck={false} />
          </label>
          <button type="button" onClick={() => onFilter({ kind: "all", batch: "" })}>
            Clear
          </button>
        </form>
      }
    >
      <p className="note">
        Showing {rows.length} of {matching.length} matching events ({events.length} kept). Newest first. Events are
        diagnostics in gateway memory, not the receipt ledger.
      </p>
      <div className="table-wrap">
        <table className="dense">
          <thead>
            <tr>
              <th>ID</th>
              <th>Time (UTC)</th>
              <th>Kind</th>
              <th>Batch ID</th>
              <th>Seq</th>
              <th>Method</th>
              <th>Result</th>
              <th className="num">Latency</th>
              <th className="num">Units / left</th>
              <th>Observed source IP</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={10} className="muted">
                  No events yet.
                </td>
              </tr>
            ) : (
              rows.map((event) => {
                const result = eventResult(event);
                return (
                  <tr key={event.id}>
                    <td className="num muted">{event.id}</td>
                    <td className="mono">{utcFromMs(event.at_ms)}</td>
                    <td className="mono">{event.kind}</td>
                    <td>{event.batch_id === null ? <span className="muted">–</span> : <HexId value={event.batch_id} onSelect={onSelectBatch} />}</td>
                    <td className="num">{event.seq ?? ""}</td>
                    <td className="mono">{event.method ?? ""}</td>
                    <td>
                      <Pill tone={result.tone}>{result.label}</Pill>
                    </td>
                    <td className="num">{event.latency_ms === null ? "" : `${event.latency_ms} ms`}</td>
                    <td className="num">{units(event)}</td>
                    <td className="mono" title={event.proxy_hop === null ? event.ip_attribution : `${event.ip_attribution} via ${event.proxy_hop}`}>
                      {event.observed_ip}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

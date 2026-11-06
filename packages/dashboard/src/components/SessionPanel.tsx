// View 3: session details from GET /admin/v1/sessions/{batch_id}, the timeline of the
// selected batch from the received events, and the recent sessions of the snapshot. The
// gateway has no buyer identity for a batch; this view shows none.

import type { AdminSnapshot, GatewayEvent, SessionDetail, SessionStatus } from "@anon-credit/protocol";
import { eventResult, sessionTimeline, type Tone } from "../lib/events-model.ts";
import { bytes, difference, epochEndUtc, epochStartUtc, shortHex, utcFromMs, utcFromSeconds } from "../lib/format.ts";
import { Field, HexId, LoadNote, Panel, Pill, type Load } from "./common.tsx";

function stateTone(state: SessionStatus): Tone {
  switch (state) {
    case "active":
      return "ok";
    case "exhausted":
      return "info";
    case "expired":
      return "warn";
  }
}

function deadlineText(deadline: string, current: string): string {
  const left = difference(deadline, current);
  switch (true) {
    case left === null:
      return deadline;
    case left !== null && left < 0:
      return `${deadline} (passed)`;
    default:
      return `${deadline} (${left} epochs left)`;
  }
}

// The receipt count text. The admin API lists up to 200 receipts, newest first. A session has
// one receipt for each committed seq, so next_seq is the number of receipts.
export function receiptCountText(shown: number, nextSeq: string): string {
  const total = /^(?:0|[1-9][0-9]*)$/.test(nextSeq) ? Number(nextSeq) : null;
  switch (true) {
    case total === null || shown >= (total ?? 0):
      return `${shown} receipts (all)`;
    default:
      return `newest ${shown} of ${String(total)} receipts`;
  }
}

function Detail(props: { readonly detail: SessionDetail; readonly currentEpoch: string; readonly epochSeconds: number }) {
  const { summary, receipts } = props.detail;
  const { session } = summary;
  const { epochSeconds } = props;
  return (
    <div className="session-detail">
      <dl className="kv">
        <Field label="Batch ID">
          <HexId value={session.batch_id} />
        </Field>
        <Field label="State">
          <Pill tone={stateTone(session.state)}>{session.state}</Pill>
        </Field>
        <Field label="Remaining units">{session.remaining}</Field>
        <Field label="Cumulative units">{session.units_total}</Field>
        <Field label="Next seq">{session.next_seq}</Field>
        <Field label="Open epoch">
          {session.open_epoch} <span className="muted">(starts {epochStartUtc(session.open_epoch, epochSeconds)} UTC)</span>
        </Field>
        <Field label="Deadline epoch">{deadlineText(session.deadline_epoch, props.currentEpoch)}</Field>
        <Field label="Can spend until (UTC)">{epochEndUtc(session.deadline_epoch, epochSeconds)}</Field>
        <Field label="Opened (UTC)">{utcFromSeconds(summary.opened_at)}</Field>
        <Field label="Open proof size">
          {bytes(summary.proof_size)} <span className="muted">({summary.proof_size} B)</span>
        </Field>
        <Field label="Verification duration">{summary.verify_ms} ms</Field>
        <Field label="Session key">
          <HexId value={session.session_pub} />
        </Field>
        <Field label="Price table hash">
          <HexId value={session.price_table_hash} />
        </Field>
      </dl>
      <h3>Recent receipts</h3>
      <p className="note">{receiptCountText(receipts.length, session.next_seq)}</p>
      <div className="table-wrap">
        <table className="dense">
          <thead>
            <tr>
              <th className="num">Seq</th>
              <th>Method</th>
              <th className="num">Units</th>
              <th className="num">Cumulative</th>
              <th>Committed (UTC)</th>
              <th>Response kept</th>
              <th>Request digest</th>
            </tr>
          </thead>
          <tbody>
            {receipts.length === 0 ? (
              <tr>
                <td colSpan={7} className="muted">
                  No receipts.
                </td>
              </tr>
            ) : (
              receipts.map(({ receipt, method }) => (
                <tr key={receipt.seq}>
                  <td className="num">{receipt.seq}</td>
                  <td className="mono">{method}</td>
                  <td className="num">{receipt.units}</td>
                  <td className="num">{receipt.units_total}</td>
                  <td className="mono">{utcFromSeconds(receipt.committed_at)}</td>
                  <td>{receipt.response_retained ? "yes" : "no (expired)"}</td>
                  <td className="mono" title={receipt.request_digest}>
                    {shortHex(receipt.request_digest)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// The timeline of the selected batch: open_received -> open_verified -> session_opened -> rpc_*.
export function SessionTimeline(props: { readonly events: readonly GatewayEvent[]; readonly batchId: string }) {
  const timeline = sessionTimeline(props.events, props.batchId);
  if (timeline.length === 0) {
    return <p className="muted">No event of this batch in the received events.</p>;
  }
  const inferred = timeline.some((entry) => entry.match === "order");
  return (
    <>
      <div className="table-wrap">
        <table className="dense timeline">
          <thead>
            <tr>
              <th>Time (UTC)</th>
              <th className="num">+ms</th>
              <th>Kind</th>
              <th className="num">Seq</th>
              <th>Method</th>
              <th>Result</th>
              <th className="num">Latency</th>
              <th className="num">Remaining</th>
              <th>Observed source IP</th>
            </tr>
          </thead>
          <tbody>
            {timeline.map(({ event, match, offsetMs }) => {
              const result = eventResult(event);
              return (
                <tr key={event.id} className={match === "order" ? "inferred" : undefined}>
                  <td className="mono">{utcFromMs(event.at_ms).slice(11)}</td>
                  <td className="num">{offsetMs}</td>
                  <td className="mono">
                    {event.kind}
                    {match === "order" ? " *" : null}
                  </td>
                  <td className="num">{event.seq ?? "–"}</td>
                  <td className="mono">{event.method ?? "–"}</td>
                  <td>
                    <Pill tone={result.tone}>{result.label}</Pill>
                  </td>
                  <td className="num">{event.latency_ms === null ? "–" : `${event.latency_ms} ms`}</td>
                  <td className="num">{event.remaining ?? "–"}</td>
                  <td className="mono">{event.observed_ip}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {inferred ? (
        <p className="note">
          * The gateway sends open_received before it reads the batch ID, so this event has no batch ID. The timeline shows
          the newest open_received from the same observed address before the first open event of the batch.
        </p>
      ) : null}
    </>
  );
}

// The detail of the selected session, or a note.
function SelectedSession(props: {
  readonly selected: string | null;
  readonly detail: Load<SessionDetail>;
  readonly currentEpoch: string;
  readonly epochSeconds: number;
}) {
  const { selected, detail } = props;
  if (selected === null) {
    return <p className="muted">Select a batch ID in the event list or in the table below.</p>;
  }
  switch (detail.state) {
    case "ready":
      return <Detail detail={detail.value} currentEpoch={props.currentEpoch} epochSeconds={props.epochSeconds} />;
    case "idle":
    case "loading":
    case "failed":
      return <LoadNote load={detail} what={`Session ${shortHex(selected)}`} />;
  }
}

export interface SessionPanelProps {
  readonly snapshot: AdminSnapshot;
  // The received events, oldest first. The timeline of the selected batch comes from them.
  readonly events: readonly GatewayEvent[];
  readonly selected: string | null;
  readonly detail: Load<SessionDetail>;
  readonly onSelect: (batchId: string) => void;
  readonly onRefresh: () => void;
}

export function SessionPanel(props: SessionPanelProps) {
  const { snapshot, selected, detail, onSelect, onRefresh, events } = props;
  return (
    <Panel
      id="sessions"
      title="Sessions"
      className="sessions"
      actions={
        selected === null ? null : (
          <button type="button" onClick={onRefresh}>
            Refresh
          </button>
        )
      }
    >
      <SelectedSession selected={selected} detail={detail} currentEpoch={snapshot.current_epoch} epochSeconds={snapshot.epoch_seconds} />
      {selected === null ? null : (
        <>
          <h3>Timeline of the selected batch</h3>
          <SessionTimeline events={events} batchId={selected} />
        </>
      )}
      <h3>Recent sessions</h3>
      <div className="table-wrap">
        <table className="dense">
          <thead>
            <tr>
              <th>Batch ID</th>
              <th>State</th>
              <th className="num">Remaining</th>
              <th className="num">Cumulative</th>
              <th className="num">Next seq</th>
              <th>Opened (UTC)</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.recent_sessions.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  No sessions.
                </td>
              </tr>
            ) : (
              snapshot.recent_sessions.map(({ session, opened_at }) => (
                <tr key={session.batch_id} className={session.batch_id === selected ? "selected" : undefined}>
                  <td>
                    <HexId value={session.batch_id} onSelect={onSelect} />
                  </td>
                  <td>
                    <Pill tone={stateTone(session.state)}>{session.state}</Pill>
                  </td>
                  <td className="num">{session.remaining}</td>
                  <td className="num">{session.units_total}</td>
                  <td className="num">{session.next_seq}</td>
                  <td className="mono">{utcFromSeconds(opened_at)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

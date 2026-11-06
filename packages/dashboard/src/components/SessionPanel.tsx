// View 3: session details from GET /admin/v1/sessions/{batch_id}, and the recent sessions of
// the snapshot. The gateway has no buyer identity for a batch; this view shows none.

import type { AdminSnapshot, SessionDetail, SessionStatus } from "@anon-credit/protocol";
import type { Tone } from "../lib/events-model.ts";
import { bytes, difference, shortHex, utcFromSeconds } from "../lib/format.ts";
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

function Detail(props: { readonly detail: SessionDetail; readonly currentEpoch: string }) {
  const { summary, receipts } = props.detail;
  const { session } = summary;
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
        <Field label="Open epoch">{session.open_epoch}</Field>
        <Field label="Deadline epoch">{deadlineText(session.deadline_epoch, props.currentEpoch)}</Field>
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

// The detail of the selected session, or a note.
function SelectedSession(props: { readonly selected: string | null; readonly detail: Load<SessionDetail>; readonly currentEpoch: string }) {
  const { selected, detail } = props;
  if (selected === null) {
    return <p className="muted">Select a batch ID in the event list or in the table below.</p>;
  }
  switch (detail.state) {
    case "ready":
      return <Detail detail={detail.value} currentEpoch={props.currentEpoch} />;
    case "idle":
    case "loading":
    case "failed":
      return <LoadNote load={detail} what={`Session ${shortHex(selected)}`} />;
  }
}

export interface SessionPanelProps {
  readonly snapshot: AdminSnapshot;
  readonly selected: string | null;
  readonly detail: Load<SessionDetail>;
  readonly onSelect: (batchId: string) => void;
  readonly onRefresh: () => void;
}

export function SessionPanel(props: SessionPanelProps) {
  const { snapshot, selected, detail, onSelect, onRefresh } = props;
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
      <SelectedSession selected={selected} detail={detail} currentEpoch={snapshot.current_epoch} />
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

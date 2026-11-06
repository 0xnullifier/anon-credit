// Proof and privacy panel: the circuit and verifier digests from the admin snapshot, and the
// price table and accepted roots from the public gateway API (GET /v1/prices, GET /v1/roots).
// The admin snapshot has no price table and no root list, so the dashboard reads the public
// endpoints that clients also read.

import { encodeHex, priceTableHash, type AdminSnapshot, type PricesResponse, type RootsResponse } from "@anon-credit/protocol";
import { shortHex, utcFromSeconds } from "../lib/format.ts";
import { Field, HexId, LoadNote, Panel, Pill, type Load } from "./common.tsx";
import { ROUTING_STATEMENT } from "./DiagnosticsPanel.tsx";

// True if price_table_hash is keccak256 of the canonical encoding of the table.
export function priceHashMatches(prices: PricesResponse): boolean {
  try {
    return encodeHex(priceTableHash(prices.price_table)) === prices.price_table_hash;
  } catch {
    return false;
  }
}

function Prices(props: { readonly load: Load<PricesResponse> }) {
  const { load } = props;
  if (load.state !== "ready") {
    return <LoadNote load={load} what="Price table" />;
  }
  const prices = load.value;
  const matches = priceHashMatches(prices);
  return (
    <>
      <dl className="kv">
        <Field label="Price table version">{prices.price_table.version}</Field>
        <Field label="Price table hash">
          <HexId value={prices.price_table_hash} />
        </Field>
        <Field label="Hash check">
          <Pill tone={matches ? "ok" : "error"}>{matches ? "matches the canonical encoding" : "does not match"}</Pill>
        </Field>
      </dl>
      <table className="dense compact">
        <thead>
          <tr>
            <th>Method</th>
            <th className="num">Units</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(prices.price_table.units).map(([method, units]) => (
            <tr key={method}>
              <td className="mono">{method}</td>
              <td className="num">{units}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Roots(props: { readonly load: Load<RootsResponse> }) {
  const { load } = props;
  if (load.state !== "ready") {
    return <LoadNote load={load} what="Accepted roots" />;
  }
  const { roots, root_window_epochs: window } = load.value;
  return (
    <>
      <p className="note">
        {roots.length} accepted roots in a window of {window} source epochs, newest first.
      </p>
      <table className="dense compact">
        <thead>
          <tr>
            <th className="num">Source epoch</th>
            <th>Root</th>
            <th className="num">Leaves</th>
          </tr>
        </thead>
        <tbody>
          {roots.slice(0, 12).map((root) => (
            <tr key={root.source_epoch}>
              <td className="num">{root.source_epoch}</td>
              <td className="mono" title={root.root}>
                {shortHex(root.root)}
              </td>
              <td className="num">{root.leaf_count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export interface PrivacyPanelProps {
  readonly snapshot: AdminSnapshot;
  readonly prices: Load<PricesResponse>;
  readonly roots: Load<RootsResponse>;
  readonly onReload: () => void;
}

export function PrivacyPanel(props: PrivacyPanelProps) {
  const { snapshot, prices, roots } = props;
  const { verifier } = snapshot;
  return (
    <Panel
      id="privacy"
      title="Proof and privacy"
      className="privacy"
      actions={
        <button type="button" onClick={props.onReload}>
          Reload public data
        </button>
      }
    >
      <dl className="kv">
        <Field label="Circuit ID">
          <HexId value={verifier.circuit_id} />
        </Field>
        <Field label="Verifier key SHA-256">
          <HexId value={verifier.pkv_sha256} />
        </Field>
        <Field label="Witness mode">{verifier.witness_mode}</Field>
        <Field label="Deployment ID">
          <HexId value={snapshot.deployment_id} />
        </Field>
        <Field label="Gateway ID">
          <HexId value={snapshot.gateway_id} />
        </Field>
        <Field label="Last root refresh (UTC)">
          {snapshot.roots.last_refresh_at === null ? "never" : utcFromSeconds(snapshot.roots.last_refresh_at)}
        </Field>
      </dl>
      <div className="side-by-side">
        <div>
          <h3>Current price table</h3>
          <Prices load={prices} />
        </div>
        <div>
          <h3>Accepted roots</h3>
          <Roots load={roots} />
        </div>
      </div>
      <p className="statement">
        The gateway sees a batch ID, a session key, and request metadata. It has no buyer identity for a batch.{" "}
        {ROUTING_STATEMENT}
      </p>
    </Panel>
  );
}

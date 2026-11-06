// Proof and privacy panel. The source is the admin snapshot: the deployment digests, the
// verifier status, the IP capture profile, the current price table, and the accepted roots.
// The public gateway API (GET /v1/prices, GET /v1/roots) is a cross-check: clients read these
// endpoints, so the panel shows if they agree with the snapshot. If a public read fails, the
// panel still shows the snapshot values.

import {
  encodeHex,
  priceTableHash,
  type AcceptedRoot,
  type AdminSnapshot,
  type PricesResponse,
  type RootsResponse,
} from "@anon-credit/protocol";
import { shortHex, utcFromSeconds } from "../lib/format.ts";
import { Field, HexId, LoadNote, Panel, Pill, type Load } from "./common.tsx";
import { ROUTING_STATEMENT } from "./DiagnosticsPanel.tsx";

// A price table with its hash: the snapshot and GET /v1/prices have the same two fields.
type HashedPrices = Pick<PricesResponse, "price_table" | "price_table_hash">;

// True if price_table_hash is keccak256 of the canonical encoding of the table.
export function priceHashMatches(prices: HashedPrices): boolean {
  try {
    return encodeHex(priceTableHash(prices.price_table)) === prices.price_table_hash;
  } catch {
    return false;
  }
}

// True if the sidecar verifier key is the key that the deployment pins. The sidecar reports
// the digest without 0x.
export function verifierKeyMatches(snapshot: AdminSnapshot): boolean {
  return `0x${snapshot.verifier.pkv_sha256.replace(/^0x/, "")}` === snapshot.verifier_artifact_hash;
}

// True if two root lists have the same entries in the same order.
export function sameRoots(a: readonly AcceptedRoot[], b: readonly AcceptedRoot[]): boolean {
  return a.length === b.length && a.every((root, i) => root.source_epoch === b[i]?.source_epoch && root.root === b[i]?.root && root.leaf_count === b[i]?.leaf_count);
}

// A cross-check of a public read against the snapshot.
function PublicCheck(props: { readonly load: Load<object>; readonly what: string; readonly agrees: boolean | null }) {
  const { load, agrees } = props;
  if (load.state !== "ready" || agrees === null) {
    return <LoadNote load={load} what={props.what} />;
  }
  return (
    <p className="note">
      {props.what}:{" "}
      <Pill tone={agrees ? "ok" : "warn"}>{agrees ? "agrees with the snapshot" : "differs from the snapshot (it can be newer or older)"}</Pill>
    </p>
  );
}

function Prices(props: { readonly snapshot: AdminSnapshot; readonly publicLoad: Load<PricesResponse> }) {
  const { snapshot, publicLoad } = props;
  const matches = priceHashMatches(snapshot);
  const agrees = publicLoad.state === "ready" ? publicLoad.value.price_table_hash === snapshot.price_table_hash && priceHashMatches(publicLoad.value) : null;
  return (
    <>
      <dl className="kv">
        <Field label="Price table version">{snapshot.price_table.version}</Field>
        <Field label="Price table hash">
          <HexId value={snapshot.price_table_hash} />
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
          {Object.entries(snapshot.price_table.units).map(([method, units]) => (
            <tr key={method}>
              <td className="mono">{method}</td>
              <td className="num">{units}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <PublicCheck load={publicLoad} what="Public GET /v1/prices" agrees={agrees} />
    </>
  );
}

function Roots(props: { readonly snapshot: AdminSnapshot; readonly publicLoad: Load<RootsResponse> }) {
  const { snapshot, publicLoad } = props;
  const roots = snapshot.accepted_roots;
  const agrees = publicLoad.state === "ready" ? sameRoots(publicLoad.value.roots, roots) : null;
  return (
    <>
      <p className="note">
        {roots.length} accepted roots in a window of {snapshot.root_window_epochs} source epochs, newest first.
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
      <PublicCheck load={publicLoad} what="Public GET /v1/roots" agrees={agrees} />
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
  const keyMatches = verifierKeyMatches(snapshot);
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
        <Field label="Deployment ID">
          <HexId value={snapshot.deployment_id} />
        </Field>
        <Field label="Gateway ID">
          <HexId value={snapshot.gateway_id} />
        </Field>
        <Field label="Circuit ID">
          <HexId value={snapshot.circuit_id} />
        </Field>
        <Field label="Verifier key pin (deployment)">
          <HexId value={snapshot.verifier_artifact_hash} />
        </Field>
        <Field label="Verifier key SHA-256 (sidecar)">
          <HexId value={verifier.pkv_sha256} />{" "}
          <Pill tone={keyMatches ? "ok" : "error"}>{keyMatches ? "equals the pin" : "differs from the pin"}</Pill>
        </Field>
        <Field label="Witness mode">{verifier.witness_mode}</Field>
        <Field label="Epoch length">{snapshot.epoch_seconds} s</Field>
        <Field label="IP capture">
          {snapshot.demo_ip_logging ? (
            <Pill tone="warn">on (demo profile, DEMO_IP_LOGGING=true)</Pill>
          ) : (
            <Pill tone="ok">off (DEMO_IP_LOGGING=false)</Pill>
          )}
        </Field>
        <Field label="Last root refresh (UTC)">
          {snapshot.roots.last_refresh_at === null ? "never" : utcFromSeconds(snapshot.roots.last_refresh_at)}
        </Field>
      </dl>
      <div className="side-by-side">
        <div>
          <h3>Current price table</h3>
          <Prices snapshot={snapshot} publicLoad={prices} />
        </div>
        <div>
          <h3>Accepted roots</h3>
          <Roots snapshot={snapshot} publicLoad={roots} />
        </div>
      </div>
      <p className="statement">
        The gateway sees a batch ID, a session key, and request metadata. It has no buyer identity for a batch.{" "}
        {ROUTING_STATEMENT}
      </p>
    </Panel>
  );
}

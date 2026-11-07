// Connect: service URLs, prover build, passphrase of the encrypted store. The build steps are
// listed as they happen.

import { useState } from "react";
import { chainName, duration } from "../lib/format.ts";
import type { ProverChoice, Settings } from "../lib/settings.ts";
import type { Workbench } from "../lib/workbench.ts";
import { Hex, Kv } from "./primitives.tsx";

function proverChoice(text: string): ProverChoice {
  switch (text) {
    case "scalar":
      return "scalar";
    case "threaded":
      return "threaded";
    default:
      return "auto";
  }
}

// Delete the IndexedDB store of this browser. The page reloads with an empty store. A wrong
// passphrase cannot open an existing store: this is the way out when the passphrase is lost.
function resetStore(name: string): void {
  const request = indexedDB.deleteDatabase(name);
  request.onsuccess = () => window.location.reload();
  request.onerror = () => window.location.reload();
  request.onblocked = () => window.location.reload();
}

function setupState(connecting: boolean, workbench: Workbench | null): string {
  switch (true) {
    case connecting:
      return "running";
    case workbench !== null:
      return "done";
    default:
      return "";
  }
}

function setupWords(connecting: boolean, workbench: Workbench | null): string {
  switch (true) {
    case connecting:
      return "in progress";
    case workbench !== null:
      return "connected";
    default:
      return "ready";
  }
}

export interface SetupLine {
  readonly atMs: number;
  readonly text: string;
}

export function Setup({
  settings,
  onSettings,
  onConnect,
  onDisconnect,
  workbench,
  connecting,
  log,
  error,
}: {
  readonly settings: Settings;
  readonly onSettings: (next: Settings) => void;
  readonly onConnect: (passphrase: string) => void;
  readonly onDisconnect: () => void;
  readonly workbench: Workbench | null;
  readonly connecting: boolean;
  readonly log: readonly SetupLine[];
  readonly error: string;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [resetArmed, setResetArmed] = useState(false);
  const locked = workbench !== null || connecting;
  const canConnect = passphrase.length >= 8 && !locked;
  return (
    <section className="step" id="setup">
      <header>
        <span className="n">0</span>
        <h2>connect</h2>
        <span className={`state ${setupState(connecting, workbench)}`}>{setupWords(connecting, workbench)}</span>
      </header>
      <p className="note">
        The passphrase encrypts the batch secrets and session keys in this browser (AES-256-GCM, PBKDF2). It stays in memory. There is no
        account.
      </p>
      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          if (canConnect) onConnect(passphrase);
        }}
      >
        <label>
          gateway
          <input value={settings.gatewayUrl} disabled={locked} onChange={(event) => onSettings({ ...settings, gatewayUrl: event.target.value })} />
        </label>
        <label>
          issuer
          <input value={settings.issuerUrl} disabled={locked} onChange={(event) => onSettings({ ...settings, issuerUrl: event.target.value })} />
        </label>
        <label className="short">
          prover
          <select
            value={settings.prover}
            disabled={locked}
            onChange={(event) => {
              onSettings({ ...settings, prover: proverChoice(event.target.value) });
            }}
          >
            <option value="auto">auto</option>
            <option value="scalar">scalar</option>
            <option value="threaded">threaded</option>
          </select>
        </label>
        <label>
          passphrase (8+ characters)
          <input type="password" autoComplete="off" value={passphrase} disabled={locked} onChange={(event) => setPassphrase(event.target.value)} />
        </label>
        <span className="actions">
          {workbench === null ? (
            <>
              <button type="submit" className="primary" disabled={!canConnect}>
                {connecting ? "connecting…" : "unlock and connect"}
              </button>
              <button
                type="button"
                disabled={connecting}
                title="Delete the encrypted store of this browser. Batches that are not backed up are lost."
                onClick={() => {
                  if (resetArmed) {
                    resetStore(settings.storageName);
                    setResetArmed(false);
                    return;
                  }
                  setResetArmed(true);
                }}
              >
                {resetArmed ? "confirm: delete the local store" : "reset local store"}
              </button>
            </>
          ) : (
            <button type="button" onClick={onDisconnect}>
              disconnect
            </button>
          )}
        </span>
      </form>
      {log.length === 0 ? null : (
        <pre className="log">
          {log.map((line) => `${new Date(line.atMs).toISOString().slice(11, 23)}  ${line.text}`).join("\n")}
        </pre>
      )}
      {error === "" ? null : <p className="note bad">{error}</p>}
      {workbench === null ? null : <Connected workbench={workbench} />}
    </section>
  );
}

function Connected({ workbench }: { readonly workbench: Workbench }) {
  const deployment = workbench.client.deployment;
  const pinOk = workbench.manifestSha256 === deployment.prover_manifest_hash;
  return (
    <Kv
      rows={[
        { k: "payment chain", v: chainName(deployment.payment_chain_id) },
        { k: "sale contract", v: <Hex value={deployment.sale_address} full /> },
        { k: "gateway id", v: <Hex value={deployment.gateway_id} /> },
        { k: "epoch", v: `${deployment.epoch_seconds} s` },
        { k: "batch", v: `${deployment.batch_size} units` },
        {
          k: "prover",
          v: `${workbench.prover.info.mode}, ${workbench.prover.info.threads} thread${workbench.prover.info.threads === 1 ? "" : "s"}, ${workbench.prover.info.numConstraints.toLocaleString("en-US")} constraints, loaded in ${duration(workbench.prover.info.loadMs)}`,
        },
        {
          k: "manifest pin",
          v: pinOk ? `served manifest = deployment pin (${workbench.manifestSha256.slice(0, 18)}…)` : "served manifest differs from the deployment pin",
          ...(pinOk ? {} : { tone: "bad" as const }),
        },
        { k: "transport", v: `${workbench.transport.kind}, ready in ${duration(workbench.transportReadyMs)}` },
        { k: "price table", v: Object.entries(workbench.client.priceTable.units).map(([method, units]) => `${method}=${units}`).join("  ") },
      ]}
    />
  );
}

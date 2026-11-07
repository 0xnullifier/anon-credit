// The top bar: name, deployment identity, the epoch clock, the block tag, the connected signer
// with its balance, and the transport toggle.

import { epochOf, secondsUntilNextEpoch } from "../lib/inclusion.ts";
import { eth, shortHex } from "../lib/format.ts";
import type { TransportChoice } from "../lib/settings.ts";
import type { Signer } from "../lib/wallet.ts";
import type { Workbench } from "../lib/workbench.ts";

const BAR_CELLS = 10;

export function EpochClock({ epochSeconds, now }: { readonly epochSeconds: number; readonly now: number }) {
  const left = secondsUntilNextEpoch(now, epochSeconds);
  const on = Math.min(BAR_CELLS, Math.round(((epochSeconds - left) / epochSeconds) * BAR_CELLS));
  return (
    <span className="epoch" title={`epoch = floor(unix seconds / ${epochSeconds})`}>
      epoch {epochOf(now, epochSeconds).toString(10)}{" "}
      <span className="bar">
        {"▮".repeat(on)}
        <span className="off">{"▯".repeat(BAR_CELLS - on)}</span>
      </span>{" "}
      {String(left).padStart(2, " ")} s
    </span>
  );
}

export function TopBar({
  workbench,
  now,
  transport,
  onTransport,
  busy,
  signer,
  balance,
  onDisconnectSigner,
}: {
  readonly workbench: Workbench | null;
  readonly now: number;
  readonly transport: TransportChoice;
  readonly onTransport: (choice: TransportChoice) => void;
  readonly busy: boolean;
  readonly signer: Signer | null;
  // The last balance read of the signer, or null before the first read.
  readonly balance: bigint | null;
  readonly onDisconnectSigner: () => void;
}) {
  const tag = workbench?.gatewayConfig.block_tag;
  return (
    <div className="top">
      <span className="name">anon-credit</span>
      {workbench === null ? (
        <span className="badge">not connected</span>
      ) : (
        <>
          <span title="deployment_id">deployment {shortHex(workbench.client.deployment.deployment_id, 8, 4)}</span>
          <EpochClock epochSeconds={workbench.client.deployment.epoch_seconds} now={now} />
          <span className={`badge ${tag === "finalized" ? "" : "warn"}`} title="block tag of the issuer and the gateway (GET /v1/config)">
            block tag {tag}
            {tag === "finalized" ? "" : " (demo)"}
          </span>
        </>
      )}
      <span className="spacer" />
      {signer === null ? null : (
        <span className="signer" title={`${signer.name}: ${signer.address}`}>
          {signer.kind === "injected" ? signer.name : signer.name} {shortHex(signer.address, 6, 4)} {balance === null ? "…" : eth(balance)}{" "}
          <button type="button" className="quiet" onClick={onDisconnectSigner}>
            disconnect
          </button>
        </span>
      )}
      <span className="toggle" role="group" aria-label="transport">
        <button type="button" aria-pressed={transport === "nox"} onClick={() => onTransport("nox")} disabled={busy}>
          nox
        </button>
        <button type="button" aria-pressed={transport === "direct"} onClick={() => onTransport("direct")} disabled={busy}>
          direct
        </button>
      </span>
      {transport === "direct" ? <span className="badge warn">direct: not private</span> : <span className="badge live">mixnet</span>}
    </div>
  );
}

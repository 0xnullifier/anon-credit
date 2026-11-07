// The top bar: name, deployment identity, the epoch clock, the block tag, and the transport.

import { epochOf, secondsUntilNextEpoch } from "../lib/inclusion.ts";
import { shortHex } from "../lib/format.ts";
import type { TransportChoice } from "../lib/settings.ts";
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
}: {
  readonly workbench: Workbench | null;
  readonly now: number;
  readonly transport: TransportChoice;
  readonly onTransport: (choice: TransportChoice) => void;
  readonly busy: boolean;
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

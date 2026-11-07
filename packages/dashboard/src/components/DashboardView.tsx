// The dashboard page: the four views, the demo comparison, and the proof and privacy panel
// on one page.

import type { BlockTag } from "@anon-credit/protocol";
import type { Connection } from "../lib/api.ts";
import type { FetchLike } from "../lib/http.ts";
import { useDashboard } from "../useDashboard.ts";
import { DemoComparisonPanel } from "./DemoComparisonPanel.tsx";
import { DiagnosticsPanel } from "./DiagnosticsPanel.tsx";
import { EventList } from "./EventList.tsx";
import { HealthPanel } from "./HealthPanel.tsx";
import { Pill } from "./common.tsx";
import { PrivacyPanel } from "./PrivacyPanel.tsx";
import { SessionPanel } from "./SessionPanel.tsx";

export interface DashboardViewProps {
  readonly connection: Connection;
  readonly fetchFn: FetchLike;
  readonly onSignOut: () => void;
  readonly onGatewayUrl: (url: string) => void;
}

// A visible marker when the gateway does not read roots at the finalized tag (the testnet demo).
export function BlockTagMarker(props: { readonly blockTag: BlockTag | null }) {
  switch (props.blockTag) {
    case null:
    case "finalized":
      return null;
    case "safe":
    case "latest":
      return <Pill tone="warn">block tag: {props.blockTag} (demo)</Pill>;
  }
}

export function DashboardView(props: DashboardViewProps) {
  const { connection } = props;
  const board = useDashboard(connection, props.fetchFn, props.onGatewayUrl);
  const snapshot = board.snapshot.value;
  const events = board.live.events;
  return (
    <div className="page">
      <header className="top">
        <h1>Gateway dashboard</h1>
        <span className="muted mono">{connection.adminUrl}</span>
        <BlockTagMarker blockTag={board.config.state === "ready" ? board.config.value.block_tag : null} />
        <button type="button" onClick={props.onSignOut}>
          Sign out
        </button>
      </header>
      {board.snapshot.error === null ? null : (
        <p className="banner tone-error" role="alert">
          {board.snapshot.error}
          {board.snapshot.unauthorized ? " Sign out and enter the correct token." : null}
          {snapshot === null ? null : " The views show the last good snapshot."}
        </p>
      )}
      {snapshot === null ? (
        <p className="muted">{board.snapshot.error === null ? "Loading the snapshot…" : "No snapshot."}</p>
      ) : (
        <div className="grid">
          <HealthPanel snapshot={snapshot} events={events} stream={board.live.stream} />
          <EventList events={events} filter={board.filter} onFilter={board.setFilter} onSelectBatch={board.select} />
          <SessionPanel
            snapshot={snapshot}
            events={events}
            selected={board.selected}
            detail={board.detail}
            onSelect={board.select}
            onRefresh={board.refreshDetail}
          />
          <DiagnosticsPanel ipLogging={snapshot.demo_ip_logging} latestEvent={events.at(-1) ?? null} />
          <DemoComparisonPanel
            ipLogging={snapshot.demo_ip_logging}
            events={events}
            probe={board.probe}
            gatewayUrl={board.gatewayUrl}
            onGatewayUrl={board.setGatewayUrl}
            onProbe={board.runProbe}
            onSelectBatch={board.select}
          />
          <PrivacyPanel snapshot={snapshot} prices={board.prices} roots={board.roots} onReload={board.loadPublic} />
        </div>
      )}
    </div>
  );
}

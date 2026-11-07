// State of the dashboard for one connection.
//
// Order of operations:
// 1. Get the snapshot. Add its recent events to the event list.
// 2. Start the event stream after the newest snapshot event (Last-Event-ID).
// 3. Get the snapshot again every POLL_MS, and soon after new events, so that the counters
//    show committed state.
// 4. Get the selected session when it is selected and when one of its events arrives.

import type { AdminSnapshot, GatewayConfigResponse, GatewayEvent, PricesResponse, RootsResponse, SessionDetail } from "@anon-credit/protocol";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { IDLE, type Load } from "./components/common.tsx";
import type { ProbeResult } from "./components/DemoComparisonPanel.tsx";
import { fetchConfig, fetchPrices, fetchRoots, fetchSession, fetchSnapshot, probePeer, type Connection } from "./lib/api.ts";
import { runEventStream } from "./lib/event-stream.ts";
import type { EventFilter } from "./lib/events-model.ts";
import { RequestFailure, type FetchLike } from "./lib/http.ts";
import { INITIAL_LIVE, liveReducer, type LiveState } from "./lib/live-state.ts";

// Time between snapshot requests.
export const POLL_MS = 5000;
// Wait after new events before the next snapshot request.
const EVENT_REFRESH_MS = 1000;
// Time that the dashboard collects stream events before it renders them.
const FLUSH_MS = 150;

// Text of a failed request.
function failureText(error: Error | null): string {
  return error === null ? "request failed" : error.message;
}

export interface SnapshotState {
  readonly value: AdminSnapshot | null;
  readonly error: string | null;
  readonly unauthorized: boolean;
}

export interface Dashboard {
  readonly snapshot: SnapshotState;
  readonly live: LiveState;
  readonly filter: EventFilter;
  readonly setFilter: (filter: EventFilter) => void;
  readonly selected: string | null;
  readonly select: (batchId: string) => void;
  readonly detail: Load<SessionDetail>;
  readonly refreshDetail: () => void;
  readonly gatewayUrl: string;
  readonly setGatewayUrl: (url: string) => void;
  readonly probe: Load<ProbeResult>;
  readonly runProbe: () => void;
  readonly prices: Load<PricesResponse>;
  readonly roots: Load<RootsResponse>;
  // The public gateway configuration (the block tag for the demo marker).
  readonly config: Load<GatewayConfigResponse>;
  readonly loadPublic: () => void;
}

export function useDashboard(connection: Connection, fetchFn: FetchLike, onGatewayUrl: (url: string) => void): Dashboard {
  const [snapshot, setSnapshot] = useState<SnapshotState>({ value: null, error: null, unauthorized: false });
  const [live, dispatch] = useReducer(liveReducer, INITIAL_LIVE);
  const [filter, setFilter] = useState<EventFilter>({ kind: "all", batch: "" });
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Load<SessionDetail>>(IDLE);
  const [gatewayUrl, setGatewayUrl] = useState(connection.gatewayUrl);
  const [probe, setProbe] = useState<Load<ProbeResult>>(IDLE);
  const [prices, setPrices] = useState<Load<PricesResponse>>(IDLE);
  const [roots, setRoots] = useState<Load<RootsResponse>>(IDLE);
  const [config, setConfig] = useState<Load<GatewayConfigResponse>>(IDLE);

  const detailAbort = useRef<AbortController | null>(null);
  const selectedRef = useRef<string | null>(null);

  const loadDetail = useCallback(
    (batchId: string, keep: boolean): void => {
      detailAbort.current?.abort();
      const controller = new AbortController();
      detailAbort.current = controller;
      if (!keep) {
        setDetail({ state: "loading" });
      }
      fetchSession(fetchFn, connection, batchId, controller.signal).then(
        (value) => {
          if (!controller.signal.aborted) {
            setDetail({ state: "ready", value, at: Date.now() });
          }
        },
        (error) => {
          if (!controller.signal.aborted) {
            setDetail({ state: "failed", error: failureText(error instanceof Error ? error : null) });
          }
        },
      );
    },
    [connection, fetchFn],
  );

  // Snapshot polling and the event stream. They stop when the connection changes.
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let loading = false;
    let streamStarted = false;
    let pending: GatewayEvent[] = [];
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;

    const startStream = (lastEventId: string | null): void => {
      runEventStream(
        { fetchFn, connection, signal, lastEventId },
        {
          onEvent: (event) => {
            pending.push(event);
            flushTimer ??= setTimeout(flush, FLUSH_MS);
          },
          onInvalid: (reason) => dispatch({ type: "invalid", reason }),
          onDuplicate: () => dispatch({ type: "duplicate" }),
          onState: (state, detailText) => dispatch({ type: "stream", state, detail: detailText }),
        },
      ).catch((error) => dispatch({ type: "stream", state: "stopped", detail: failureText(error instanceof Error ? error : null) }));
    };

    const load = async (): Promise<void> => {
      if (loading || signal.aborted) {
        return;
      }
      loading = true;
      try {
        const value = await fetchSnapshot(fetchFn, connection, signal);
        setSnapshot({ value, error: null, unauthorized: false });
        dispatch({ type: "seed", events: value.recent_events });
        if (!streamStarted) {
          streamStarted = true;
          startStream(value.recent_events.at(-1)?.id ?? null);
        }
      } catch (error) {
        if (!signal.aborted) {
          const unauthorized = error instanceof RequestFailure && error.kind === "unauthorized";
          const text = failureText(error instanceof Error ? error : null);
          setSnapshot((previous) => ({ value: previous.value, error: text, unauthorized }));
        }
      } finally {
        loading = false;
      }
    };

    const poll = (): void => {
      load().finally(() => {
        if (!signal.aborted) {
          pollTimer = setTimeout(poll, POLL_MS);
        }
      });
    };

    const flush = (): void => {
      flushTimer = undefined;
      const batch = pending;
      pending = [];
      dispatch({ type: "events", events: batch });
      const current = selectedRef.current;
      if (current !== null && batch.some((event) => event.batch_id === current)) {
        loadDetail(current, true);
      }
      refreshTimer ??= setTimeout(() => {
        refreshTimer = undefined;
        load().catch(() => {});
      }, EVENT_REFRESH_MS);
    };

    poll();
    return () => {
      controller.abort();
      clearTimeout(pollTimer);
      clearTimeout(refreshTimer);
      clearTimeout(flushTimer);
    };
  }, [connection, fetchFn, loadDetail]);

  useEffect(() => () => detailAbort.current?.abort(), []);

  const select = useCallback(
    (batchId: string): void => {
      selectedRef.current = batchId;
      setSelected(batchId);
      loadDetail(batchId, false);
    },
    [loadDetail],
  );

  const refreshDetail = useCallback((): void => {
    const current = selectedRef.current;
    if (current !== null) {
      loadDetail(current, true);
    }
  }, [loadDetail]);

  const changeGatewayUrl = useCallback(
    (url: string): void => {
      setGatewayUrl(url);
      onGatewayUrl(url);
    },
    [onGatewayUrl],
  );

  const runProbe = useCallback((): void => {
    setProbe({ state: "loading" });
    probePeer(fetchFn, gatewayUrl).then(
      (peer) => setProbe({ state: "ready", value: { peer, atMs: Date.now() }, at: Date.now() }),
      (error) => setProbe({ state: "failed", error: failureText(error instanceof Error ? error : null) }),
    );
  }, [fetchFn, gatewayUrl]);

  const loadPublic = useCallback((): void => {
    setPrices({ state: "loading" });
    setRoots({ state: "loading" });
    fetchPrices(fetchFn, gatewayUrl).then(
      (value) => setPrices({ state: "ready", value, at: Date.now() }),
      (error) => setPrices({ state: "failed", error: failureText(error instanceof Error ? error : null) }),
    );
    fetchRoots(fetchFn, gatewayUrl).then(
      (value) => setRoots({ state: "ready", value, at: Date.now() }),
      (error) => setRoots({ state: "failed", error: failureText(error instanceof Error ? error : null) }),
    );
    fetchConfig(fetchFn, gatewayUrl).then(
      (value) => setConfig({ state: "ready", value, at: Date.now() }),
      (error) => setConfig({ state: "failed", error: failureText(error instanceof Error ? error : null) }),
    );
  }, [fetchFn, gatewayUrl]);

  // Read the public price table and roots once for each connection.
  const loadPublicRef = useRef(loadPublic);
  useEffect(() => {
    loadPublicRef.current = loadPublic;
  });
  useEffect(() => {
    loadPublicRef.current();
  }, [connection]);

  return {
    snapshot,
    live,
    filter,
    setFilter,
    selected,
    select,
    detail,
    refreshDetail,
    gatewayUrl,
    setGatewayUrl: changeGatewayUrl,
    probe,
    runProbe,
    prices,
    roots,
    config,
    loadPublic,
  };
}

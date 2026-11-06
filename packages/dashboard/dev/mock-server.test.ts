// Integration tests: the dashboard clients against the mock admin server over real HTTP.
// They cover the stream with reconnect and Last-Event-ID, the invalid event counter, the
// token placement, and the normal profile without IP capture.

import type { GatewayEvent } from "@anon-credit/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { fetchSession, fetchSnapshot, probePeer, type Connection } from "../src/lib/api.ts";
import { runEventStream, type StreamState } from "../src/lib/event-stream.ts";
import { browserFetch, RequestFailure } from "../src/lib/http.ts";
import { loadFixture, startMock, type RunningMock } from "./mock-server.ts";

let running: RunningMock | null = null;

afterEach(async () => {
  await running?.close();
  running = null;
});

async function start(ipLogging = true): Promise<{ mock: RunningMock; connection: Connection }> {
  const mock = await startMock({ adminPort: 0, publicPort: 0, autoplay: false, ipLogging, token: "integration-token-0123456789" });
  running = mock;
  return { mock, connection: { adminUrl: mock.adminUrl, gatewayUrl: mock.publicUrl, token: mock.token } };
}

function steps(mock: RunningMock, count: number): void {
  for (let i = 0; i < count; i += 1) {
    mock.step();
  }
}

// Collect stream events until the predicate is true.
interface Collector {
  readonly events: GatewayEvent[];
  readonly invalid: string[];
  readonly states: StreamState[];
  until(done: () => boolean): Promise<void>;
  stop(): Promise<void>;
}

function collect(connection: Connection, lastEventId: string | null): Collector {
  const controller = new AbortController();
  const events: GatewayEvent[] = [];
  const invalid: string[] = [];
  const states: StreamState[] = [];
  let wake: () => void = () => {};
  const changed = (): void => wake();
  const finished = runEventStream(
    { fetchFn: browserFetch, connection, signal: controller.signal, lastEventId, retryMs: 20 },
    {
      onEvent: (event) => {
        events.push(event);
        changed();
      },
      onInvalid: (reason) => {
        invalid.push(reason);
        changed();
      },
      onDuplicate: () => {},
      onState: (state) => {
        states.push(state);
        changed();
      },
    },
  );
  return {
    events,
    invalid,
    states,
    async until(done) {
      const deadline = Date.now() + 5000;
      while (!done()) {
        if (Date.now() > deadline) {
          throw new Error("timeout");
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, 50);
        });
      }
    },
    async stop() {
      controller.abort();
      await finished;
    },
  };
}

describe("mock admin fixture", () => {
  it("has only schema-valid events except the one raw entry", () => {
    const fixture = loadFixture();
    const raw = fixture.script.filter((entry) => "raw" in entry);
    expect(raw).toHaveLength(1);
    expect(fixture.script.length).toBeGreaterThan(20);
  });
});

describe("dashboard clients against the mock admin server", () => {
  it("streams events, counts the invalid one, and resumes after Last-Event-ID", async () => {
    const { mock, connection } = await start();
    steps(mock, 3);
    const first = collect(connection, null);
    await first.until(() => first.events.length === 3);
    steps(mock, 2);
    await first.until(() => first.events.length === 5);
    await first.stop();
    const lastId = first.events.at(-1)?.id ?? null;
    expect(first.events.map((event) => event.id)).toEqual(["1", "2", "3", "4", "5"]);

    // Events that the gateway publishes while the dashboard is away come after the reconnect.
    steps(mock, 12);
    const second = collect(connection, lastId);
    await second.until(() => second.events.length + second.invalid.length === 12);
    await second.stop();
    expect(second.events[0]?.id).toBe("6");
    expect(second.invalid).toHaveLength(1);
    expect(second.invalid[0]).toContain("protocol schema");
    // The server removes a subscriber when the client closes the connection.
    const deadline = Date.now() + 2000;
    while (mock.gateway.subscriberCount > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(mock.gateway.subscriberCount).toBe(0);
  });

  it("reflects committed debits in the snapshot and the session view", async () => {
    const { mock, connection } = await start();
    steps(mock, 9);
    const snapshot = await fetchSnapshot(browserFetch, connection);
    expect(snapshot.counters.sessions_opened).toBe("1");
    expect(snapshot.counters.rpc_completed).toBe("3");
    expect(snapshot.counters.units_charged).toBe("4");
    expect(snapshot.recent_events).toHaveLength(9);
    const batchId = snapshot.recent_sessions[0]?.session.batch_id ?? "";
    const detail = await fetchSession(browserFetch, connection, batchId);
    expect(detail.summary.session.remaining).toBe(96);
    expect(detail.summary.session.next_seq).toBe("3");
    expect(detail.receipts.map((r) => r.method)).toEqual(["eth_getBalance", "eth_blockNumber", "eth_chainId"]);
  });

  it("rejects a wrong token and never sees the token in a request path", async () => {
    const { mock, connection } = await start();
    steps(mock, 2);
    await fetchSnapshot(browserFetch, connection);
    const stream = collect(connection, null);
    await stream.until(() => stream.events.length === 2);
    await stream.stop();
    await probePeer(browserFetch, connection.gatewayUrl);
    let failure: RequestFailure | null = null;
    try {
      await fetchSnapshot(browserFetch, { ...connection, token: "wrong-token-0123456789abc" });
    } catch (error) {
      failure = error instanceof RequestFailure ? error : null;
    }
    expect(failure?.kind).toBe("unauthorized");
    const wrong = collect({ ...connection, token: "wrong-token-0123456789abc" }, null);
    await wrong.until(() => wrong.states.includes("unauthorized"));
    await wrong.stop();
    expect(mock.gateway.requestPaths.length).toBeGreaterThanOrEqual(5);
    for (const path of mock.gateway.requestPaths) {
      expect(path).not.toContain(connection.token);
      expect(path).not.toContain("wrong-token");
    }
  });

  it("shows the real socket peer in the direct probe", async () => {
    const { connection } = await start();
    const peer = await probePeer(browserFetch, connection.gatewayUrl);
    expect(peer).toEqual({ observed_ip: "127.0.0.1", attribution: "socket", proxy_hop: null });
  });

  it("reports unavailable addresses and has no probe in the normal profile", async () => {
    const { mock, connection } = await start(false);
    steps(mock, 4);
    const snapshot = await fetchSnapshot(browserFetch, connection);
    expect(snapshot.demo_ip_logging).toBe(false);
    for (const event of snapshot.recent_events) {
      expect(event.observed_ip).toBe("unavailable");
      expect(event.ip_attribution).toBe("unavailable");
      expect(event.proxy_hop).toBeNull();
    }
    let failure: RequestFailure | null = null;
    try {
      await probePeer(browserFetch, connection.gatewayUrl);
    } catch (error) {
      failure = error instanceof RequestFailure ? error : null;
    }
    expect(failure?.kind).toBe("not_found");
  });
});

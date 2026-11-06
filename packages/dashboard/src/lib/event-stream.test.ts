// Tests of the authenticated event stream: reconnect, Last-Event-ID, and discarded events.

import type { GatewayEvent } from "@anon-credit/protocol";
import { describe, expect, it } from "vitest";
import { makeEvent, sseText, streamResponse, type RecordedRequest } from "../testing/shared.ts";
import type { Connection } from "./api.ts";
import { runEventStream, type StreamState } from "./event-stream.ts";
import type { FetchLike } from "./http.ts";

const TOKEN = "secret-admin-token-0123456789";
const connection: Connection = { adminUrl: "http://127.0.0.1:8082/", gatewayUrl: "http://127.0.0.1:8081", token: TOKEN };

interface Run {
  readonly requests: RecordedRequest[];
  readonly events: GatewayEvent[];
  readonly invalid: string[];
  readonly duplicates: string[];
  readonly states: StreamState[];
}

// Run the stream against fake responses. The run ends after the last response.
async function run(responses: readonly (() => Response)[], lastEventId: string | null = null): Promise<Run> {
  const controller = new AbortController();
  const out: Run = { requests: [], events: [], invalid: [], duplicates: [], states: [] };
  let index = 0;
  const fetchFn: FetchLike = async (url, init) => {
    out.requests.push({ url, headers: new Headers(init.headers) });
    const next = responses[index];
    index += 1;
    if (next === undefined) {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    }
    return next();
  };
  await runEventStream(
    { fetchFn, connection, signal: controller.signal, lastEventId, sleep: async () => {} },
    {
      onEvent: (event) => out.events.push(event),
      onInvalid: (reason) => out.invalid.push(reason),
      onDuplicate: (id) => out.duplicates.push(id),
      onState: (state) => out.states.push(state),
    },
  );
  return out;
}

describe("runEventStream", () => {
  it("sends the token only in the Authorization header and reconnects with Last-Event-ID", async () => {
    const first = sseText([makeEvent(1), makeEvent(2)]);
    const second = sseText([makeEvent(3)]);
    const result = await run([() => streamResponse([first.slice(0, 20), first.slice(20)]), () => streamResponse([second])]);

    expect(result.events.map((event) => event.id)).toEqual(["1", "2", "3"]);
    expect(result.requests).toHaveLength(3);
    for (const request of result.requests) {
      expect(request.url).toBe("http://127.0.0.1:8082/admin/v1/events");
      expect(request.url).not.toContain(TOKEN);
      expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    }
    expect(result.requests.map((request) => request.headers.get("last-event-id"))).toEqual([null, "2", "3"]);
    expect(result.states).toEqual(["connecting", "open", "retrying", "connecting", "open", "retrying", "connecting", "stopped"]);
  });

  it("starts after a given Last-Event-ID", async () => {
    const result = await run([() => streamResponse([sseText([makeEvent(8)])])], "7");
    expect(result.requests[0]?.headers.get("last-event-id")).toBe("7");
    expect(result.events.map((event) => event.id)).toEqual(["8"]);
  });

  it("discards and counts events that are not JSON, that fail the schema, or that repeat an ID", async () => {
    const good = makeEvent(4);
    const badKind = { ...makeEvent(5), kind: "rpc_teleported" };
    const extraField = { ...makeEvent(6), proof: "AAAA" };
    const chunks = [
      sseText([good]),
      "id: 5\ndata: not json\n\n",
      `id: 5\ndata: ${JSON.stringify(badKind)}\n\n`,
      `id: 6\ndata: ${JSON.stringify(extraField)}\n\n`,
      // The JSON id must be the SSE id.
      `id: 7\ndata: ${JSON.stringify(makeEvent(70))}\n\n`,
      // A repeated ID is a duplicate, not a new event.
      sseText([makeEvent(4)]),
      sseText([makeEvent(9)]),
    ];
    const result = await run([() => streamResponse(chunks)]);
    expect(result.events.map((event) => event.id)).toEqual(["4", "9"]);
    expect(result.invalid).toHaveLength(4);
    expect(result.invalid[0]).toContain("not JSON");
    expect(result.invalid[1]).toContain("kind");
    expect(result.invalid[2]).toContain("protocol schema");
    expect(result.invalid[3]).toContain("not the stream id");
    expect(result.duplicates).toEqual(["4"]);
  });

  it("reconnects after the last SSE id, also when that event was discarded", async () => {
    const result = await run([
      () => streamResponse([sseText([makeEvent(1)]), "id: 2\ndata: {}\n\n"]),
      () => streamResponse([sseText([makeEvent(3)])]),
    ]);
    expect(result.invalid).toHaveLength(1);
    expect(result.requests[1]?.headers.get("last-event-id")).toBe("2");
    expect(result.events.map((event) => event.id)).toEqual(["1", "3"]);
  });

  it("retries after an HTTP error and a network error, and stops on 401", async () => {
    const result = await run([
      () => new Response("busy", { status: 503 }),
      () => {
        throw new TypeError("Failed to fetch");
      },
      () => streamResponse([sseText([makeEvent(1)])]),
      () => new Response("", { status: 401 }),
    ]);
    expect(result.events.map((event) => event.id)).toEqual(["1"]);
    expect(result.requests).toHaveLength(4);
    expect(result.requests[3]?.headers.get("last-event-id")).toBe("1");
    expect(result.states.at(-1)).toBe("unauthorized");
  });
});

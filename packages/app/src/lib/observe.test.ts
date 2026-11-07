import type { Transport } from "@anon-credit/anon-transport";
import { describe, expect, it } from "vitest";
import { applyChunkEvent, classify, observeTransport, type RequestEvent } from "./observe.ts";

const BATCH = `0x${"ab".repeat(32)}`;
const SHA = `0x${"cd".repeat(32)}`;

function fakeTransport(status: number, body: string): Transport {
  return {
    kind: "direct",
    maxBodyBytes: Number.POSITIVE_INFINITY,
    logs: [],
    isolationKeys: () => [],
    close: () => undefined,
    fetch: async () => new Response(body, { status, headers: { "content-type": "application/json" } }),
  };
}

describe("classify", () => {
  it("names the request kinds", () => {
    expect(classify(`/v1/open/chunks/${BATCH}/${SHA}/100/2/1`)).toBe("chunk");
    expect(classify("/v1/open")).toBe("open");
    expect(classify("/v1/rpc")).toBe("spend");
    expect(classify("/v1/session/status")).toBe("status");
    expect(classify("/v1/roots")).toBe("roots");
    expect(classify("/v1/tree/path/3")).toBe("path");
    expect(classify("/v1/config")).toBe("config");
    expect(classify(`/v1/topups/${BATCH}/0`)).toBe("topup");
    expect(classify("/v1/demo/peer")).toBe("other");
  });
});

describe("observeTransport", () => {
  it("emits sent and answered for a chunk with its index and completion", async () => {
    const events: RequestEvent[] = [];
    const observed = observeTransport(fakeTransport(200, JSON.stringify({ received_chunks: 2, complete: true })));
    observed.subscribe((event) => events.push(event));
    const response = await observed.fetch(
      `http://gw/v1/open/chunks/${BATCH}/${SHA}/100/2/1`,
      { method: "PUT", body: new Uint8Array(50) },
      { isolationKey: BATCH },
    );
    expect(response.status).toBe(200);
    // The response body is still readable by the caller.
    expect(JSON.parse(await response.text()).complete).toBe(true);
    expect(events.map((event) => event.phase)).toEqual(["sent", "answered"]);
    expect(events[0]?.chunkIndex).toBe(1);
    expect(events[0]?.chunkCount).toBe(2);
    expect(events[0]?.bodyBytes).toBe(50);
    expect(events[1]?.complete).toBe(true);
    expect(events[0]?.requestId).toBe(events[1]?.requestId);
  });

  it("emits failed when the inner transport throws", async () => {
    const events: RequestEvent[] = [];
    const failing: Transport = { ...fakeTransport(200, "{}"), fetch: async () => Promise.reject(new Error("tunnel closed")) };
    const observed = observeTransport(failing);
    observed.subscribe((event) => events.push(event));
    await expect(observed.fetch("http://gw/v1/rpc", { method: "POST", body: "{}" }, { isolationKey: BATCH })).rejects.toThrow("tunnel closed");
    expect(events.map((event) => event.phase)).toEqual(["sent", "failed"]);
    expect(events[1]?.error).toBe("tunnel closed");
    expect(events[1]?.kind).toBe("spend");
  });
});

describe("applyChunkEvent", () => {
  const base = { kind: "chunk" as const, method: "PUT", path: "/v1/open/chunks/x", isolationKey: BATCH, chunkCount: 3, bodyBytes: 40_000, complete: null, error: null };
  it("tracks sent, sent again, acknowledged, and failed", () => {
    const sentAt = new Map<number, number>();
    let chunks = applyChunkEvent([], { ...base, phase: "sent", chunkIndex: 0, httpStatus: null, atMs: 100, requestId: 1 }, sentAt);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.state).toBe("sent");
    expect(chunks[1]?.state).toBe("waiting");
    chunks = applyChunkEvent(chunks, { ...base, phase: "failed", chunkIndex: 0, httpStatus: null, atMs: 150, requestId: 1, error: "x" }, sentAt);
    expect(chunks[0]?.state).toBe("failed");
    chunks = applyChunkEvent(chunks, { ...base, phase: "sent", chunkIndex: 0, httpStatus: null, atMs: 700, requestId: 2 }, sentAt);
    expect(chunks[0]?.sends).toBe(2);
    chunks = applyChunkEvent(chunks, { ...base, phase: "answered", chunkIndex: 0, httpStatus: 200, atMs: 900, requestId: 2, complete: false }, sentAt);
    expect(chunks[0]?.state).toBe("acknowledged");
    expect(chunks[0]?.ms).toBe(200);
    chunks = applyChunkEvent(chunks, { ...base, phase: "answered", chunkIndex: 2, httpStatus: 400, atMs: 950, requestId: 3 }, sentAt);
    expect(chunks[2]?.state).toBe("failed");
    expect(chunks[2]?.httpStatus).toBe(400);
  });
});

// Tests of the Server-Sent Events parser.

import { describe, expect, it } from "vitest";
import { SseParser } from "./sse-parser.ts";

describe("SseParser", () => {
  it("parses the axum event format with ids and keep-alive comments", () => {
    const parser = new SseParser();
    const messages = parser.push('id: 1\ndata: {"a":1}\n\n:\n\nid: 2\ndata: {"a":2}\n\n');
    expect(messages).toEqual([
      { id: "1", event: "message", data: '{"a":1}' },
      { id: "2", event: "message", data: '{"a":2}' },
    ]);
    expect(parser.lastEventId).toBe("2");
  });

  it("joins a message that is split over many chunks", () => {
    const parser = new SseParser();
    const text = 'id: 17\ndata: {"kind":"rpc_completed"}\n\n';
    const out = [];
    for (const char of text) {
      out.push(...parser.push(char));
    }
    expect(out).toEqual([{ id: "17", event: "message", data: '{"kind":"rpc_completed"}' }]);
  });

  it("accepts CRLF, CR, and LF line ends, also a CRLF split between chunks", () => {
    const parser = new SseParser();
    const first = parser.push("id: 1\r\ndata: a\r");
    const second = parser.push("\n\r\nid: 2\rdata: b\r\r");
    expect([...first, ...second]).toEqual([
      { id: "1", event: "message", data: "a" },
      { id: "2", event: "message", data: "b" },
    ]);
  });

  it("removes one byte order mark, joins data lines, and reads the event type", () => {
    const parser = new SseParser();
    const messages = parser.push("\uFEFFevent: custom\ndata: one\ndata:two\n\n");
    expect(messages).toEqual([{ id: null, event: "custom", data: "one\ntwo" }]);
  });

  it("keeps the id for later messages and does not dispatch a message with no data", () => {
    const parser = new SseParser("9");
    expect(parser.push("id: 10\n\n")).toEqual([]);
    expect(parser.lastEventId).toBe("10");
    expect(parser.push("data: x\n\n")).toEqual([{ id: "10", event: "message", data: "x" }]);
  });

  it("reads retry only when it has digits only, and ignores an id with NUL", () => {
    const parser = new SseParser();
    parser.push("retry: 2500\nretry: 1x\nid: a\u0000b\n\n");
    expect(parser.retryMs).toBe(2500);
    expect(parser.lastEventId).toBeNull();
  });

  it("keeps a partial line until the line ends", () => {
    const parser = new SseParser();
    expect(parser.push("data: par")).toEqual([]);
    expect(parser.push("tial\n")).toEqual([]);
    expect(parser.push("\n")).toEqual([{ id: null, event: "message", data: "partial" }]);
  });
});

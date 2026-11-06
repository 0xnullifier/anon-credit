// Incremental parser of a Server-Sent Events stream (WHATWG HTML, "event stream
// interpretation").
//
// Rules:
// - A line ends with CRLF, LF, or CR. A CR at the end of a chunk can be the first half of a
//   CRLF. The parser keeps that state between chunks.
// - A UTF-8 byte order mark at the start of the stream is removed once.
// - A line that starts with ":" is a comment (the gateway keep-alive).
// - An empty line dispatches the message. A message with no data is not dispatched.
// - The "id" field sets the last event ID. The ID stays for the next messages.
// - The "retry" field sets the reconnection time if the value has only ASCII digits.

export interface SseMessage {
  // The last event ID when the message was dispatched, or null if the stream gave none.
  readonly id: string | null;
  // The event type. The default is "message".
  readonly event: string;
  // The data lines, joined with LF.
  readonly data: string;
}

const BOM = "﻿";
const DIGITS = /^[0-9]+$/;

export class SseParser {
  #buffer = "";
  #afterCr = false;
  #started = false;
  #data: string[] = [];
  #event = "";
  #lastEventId: string | null = null;
  #retryMs: number | null = null;

  // Start the parser from a known last event ID (a reconnect).
  constructor(lastEventId: string | null = null) {
    this.#lastEventId = lastEventId;
  }

  // The last event ID that the stream set.
  get lastEventId(): string | null {
    return this.#lastEventId;
  }

  // The reconnection time that the stream set, or null.
  get retryMs(): number | null {
    return this.#retryMs;
  }

  // Add decoded text. Return the messages that are complete.
  push(chunk: string): SseMessage[] {
    let text = chunk;
    if (!this.#started && text.length > 0) {
      this.#started = true;
      if (text.startsWith(BOM)) {
        text = text.slice(BOM.length);
      }
    }
    if (this.#afterCr && text.startsWith("\n")) {
      text = text.slice(1);
    }
    this.#afterCr = false;
    const messages: SseMessage[] = [];
    this.#buffer += text;
    let start = 0;
    for (let i = 0; i < this.#buffer.length; i += 1) {
      const char = this.#buffer.charAt(i);
      switch (char) {
        case "\r":
        case "\n": {
          const line = this.#buffer.slice(start, i);
          if (char === "\r") {
            if (i + 1 === this.#buffer.length) {
              this.#afterCr = true;
            } else if (this.#buffer.charAt(i + 1) === "\n") {
              i += 1;
            }
          }
          start = i + 1;
          const message = this.#line(line);
          if (message !== null) {
            messages.push(message);
          }
          break;
        }
        default:
          break;
      }
    }
    this.#buffer = this.#buffer.slice(start);
    return messages;
  }

  // Process one line. Return a message if the line dispatches one.
  #line(line: string): SseMessage | null {
    if (line.length === 0) {
      return this.#dispatch();
    }
    if (line.startsWith(":")) {
      return null;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    switch (field) {
      case "data":
        this.#data.push(value);
        break;
      case "event":
        this.#event = value;
        break;
      case "id":
        if (!value.includes("\u0000")) {
          this.#lastEventId = value;
        }
        break;
      case "retry":
        if (DIGITS.test(value)) {
          this.#retryMs = Number(value);
        }
        break;
      default:
        break;
    }
    return null;
  }

  #dispatch(): SseMessage | null {
    const data = this.#data;
    const event = this.#event;
    this.#data = [];
    this.#event = "";
    if (data.length === 0) {
      return null;
    }
    return { id: this.#lastEventId, event: event === "" ? "message" : event, data: data.join("\n") };
  }
}

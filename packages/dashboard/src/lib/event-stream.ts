// Authenticated event stream: GET /admin/v1/events over fetch.
//
// EventSource cannot send an Authorization header, and the token must not be in a URL.
// Thus this client uses fetch, parses the stream with SseParser, and reconnects with the
// Last-Event-ID header. The gateway then sends the retained events after that ID.
//
// Each event goes through gatewayEventSchema. An event that is not JSON, that does not match
// the schema, or whose JSON id is not the SSE id is discarded and counted. An event with an ID
// that is not larger than the last accepted ID is a duplicate; it is discarded and counted.

import { gatewayEventSchema, type GatewayEvent } from "@anon-credit/protocol";
import { EVENTS_PATH, type Connection } from "./api.ts";
import { issueText, joinUrl, parseJson, type FetchLike } from "./http.ts";
import { SseParser, type SseMessage } from "./sse-parser.ts";

export type StreamState = "connecting" | "open" | "retrying" | "unauthorized" | "stopped";

export interface StreamHandlers {
  onEvent(event: GatewayEvent): void;
  onInvalid(reason: string): void;
  onDuplicate(id: string): void;
  onState(state: StreamState, detail: string | null): void;
}

export interface StreamOptions {
  readonly fetchFn: FetchLike;
  readonly connection: Connection;
  readonly signal: AbortSignal;
  // Start after this event ID. Null: the gateway sends all retained events.
  readonly lastEventId: string | null;
  // First wait before a reconnect. The stream "retry" field replaces it.
  readonly retryMs?: number;
  // Largest wait before a reconnect.
  readonly maxRetryMs?: number;
  // Wait function. Tests give a fast one.
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const DECIMAL_ID = /^(?:0|[1-9][0-9]*)$/;

// Wait ms milliseconds, or less if the signal aborts.
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}

// Check one SSE message. Return the event, or the reason to discard it.
export function readEventMessage(message: SseMessage): { ok: true; event: GatewayEvent } | { ok: false; reason: string } {
  const body = parseJson(message.data);
  if (!body.ok) {
    return { ok: false, reason: "event data is not JSON" };
  }
  const result = gatewayEventSchema.safeParse(body.value);
  if (!result.success) {
    return { ok: false, reason: `event does not match the protocol schema (${issueText(result.error.issues)})` };
  }
  if (message.id !== result.data.id) {
    return { ok: false, reason: `event id ${result.data.id} is not the stream id ${message.id ?? "(none)"}` };
  }
  return { ok: true, event: result.data };
}

// Read the stream until the signal aborts or the gateway rejects the token.
export async function runEventStream(options: StreamOptions, handlers: StreamHandlers): Promise<void> {
  const { fetchFn, connection, signal } = options;
  const sleep = options.sleep ?? abortableSleep;
  const baseRetry = options.retryMs ?? 1000;
  const maxRetry = options.maxRetryMs ?? 15000;
  let retry = baseRetry;
  let lastEventId = options.lastEventId;
  let lastAccepted = lastEventId !== null && DECIMAL_ID.test(lastEventId) ? BigInt(lastEventId) : -1n;
  const url = joinUrl(connection.adminUrl, EVENTS_PATH);

  while (!signal.aborted) {
    handlers.onState("connecting", null);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${connection.token}`,
      Accept: "text/event-stream",
    };
    if (lastEventId !== null) {
      headers["Last-Event-ID"] = lastEventId;
    }
    let detail = "stream ended";
    try {
      const response = await fetchFn(url, { method: "GET", headers, signal, cache: "no-store", credentials: "omit" });
      switch (true) {
        case response.status === 401:
          handlers.onState("unauthorized", "the gateway rejected the admin token (401)");
          return;
        case !response.ok:
          detail = `HTTP ${response.status}`;
          break;
        case response.body === null:
          detail = "response has no body";
          break;
        default: {
          handlers.onState("open", null);
          const parser = new SseParser(lastEventId);
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) {
              break;
            }
            for (const message of parser.push(chunk.value)) {
              const read = readEventMessage(message);
              switch (read.ok) {
                case true: {
                  const id = BigInt(read.event.id);
                  if (id <= lastAccepted) {
                    handlers.onDuplicate(read.event.id);
                    break;
                  }
                  lastAccepted = id;
                  retry = baseRetry;
                  handlers.onEvent(read.event);
                  break;
                }
                case false:
                  handlers.onInvalid(read.reason);
                  break;
              }
            }
            // The SSE id field is the reconnect point, also for a discarded event.
            const parsedId = parser.lastEventId;
            if (parsedId !== null && DECIMAL_ID.test(parsedId)) {
              lastEventId = parsedId;
            }
            if (parser.retryMs !== null) {
              retry = parser.retryMs;
            }
          }
        }
      }
    } catch (error) {
      if (signal.aborted) {
        break;
      }
      detail = error instanceof Error ? error.message : "network error";
    }
    if (signal.aborted) {
      break;
    }
    handlers.onState("retrying", detail);
    await sleep(retry, signal);
    retry = Math.min(maxRetry, retry * 2);
  }
  handlers.onState("stopped", null);
}

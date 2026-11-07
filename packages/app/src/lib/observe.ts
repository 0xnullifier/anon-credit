// A transport wrapper that reports each request as it happens. The SDK sends every gateway
// and issuer request through transport.fetch, so the wrapper sees the real sequence: a proof
// chunk goes out, a chunk is sent again, the gateway acknowledges it, a spend request is in
// flight, the gateway answers. The wrapper changes no request and no response.

import type { Transport, TransportFetchOptions, TransportRequestInit } from "@anon-credit/anon-transport";
import { parseOpenChunkPath } from "@anon-credit/protocol";

export type RequestKind = "chunk" | "open" | "spend" | "status" | "roots" | "path" | "config" | "topup" | "other";

export interface RequestEvent {
  // "sent": transport.fetch was called. "answered": the response arrived (status known).
  // "failed": the transport threw.
  readonly phase: "sent" | "answered" | "failed";
  readonly kind: RequestKind;
  readonly method: string;
  readonly path: string;
  readonly isolationKey: string;
  // Chunk index and count for a chunk request; null for the others.
  readonly chunkIndex: number | null;
  readonly chunkCount: number | null;
  // Request body size in bytes, if known.
  readonly bodyBytes: number | null;
  readonly httpStatus: number | null;
  // true if the gateway reported the upload as complete (chunk requests only).
  readonly complete: boolean | null;
  readonly atMs: number;
  // The error text of a transport failure.
  readonly error: string | null;
  // A number that is the same for the "sent" and the "answered" or "failed" event of one request.
  readonly requestId: number;
}

export type RequestListener = (event: RequestEvent) => void;

export function classify(path: string): RequestKind {
  switch (true) {
    case path.startsWith("/v1/open/chunks/"):
      return "chunk";
    case path === "/v1/open":
      return "open";
    case path === "/v1/rpc":
      return "spend";
    case path === "/v1/session/status":
      return "status";
    case path === "/v1/roots":
      return "roots";
    case path.startsWith("/v1/tree/path/"):
      return "path";
    case path === "/v1/config" || path === "/v1/prices" || path === "/v1/epoch":
      return "config";
    case path.startsWith("/v1/topups"):
      return "topup";
    default:
      return "other";
  }
}

function sizeOf(body: TransportRequestInit["body"]): number | null {
  switch (true) {
    case typeof body === "string":
      return new TextEncoder().encode(body).byteLength;
    case body instanceof Uint8Array:
      return body.byteLength;
    default:
      return null;
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

// The {received_chunks, complete} body of a chunk response, read from a clone.
async function chunkComplete(response: Response): Promise<boolean | null> {
  try {
    const text = await response.clone().text();
    const json: { complete?: boolean } = JSON.parse(text);
    return typeof json.complete === "boolean" ? json.complete : null;
  } catch {
    return null;
  }
}

export interface ObservedTransport extends Transport {
  readonly inner: Transport;
  readonly subscribe: (listener: RequestListener) => () => void;
}

export function observeTransport(inner: Transport): ObservedTransport {
  const listeners = new Set<RequestListener>();
  let nextId = 0;
  const emit = (event: RequestEvent): void => {
    for (const listener of listeners) listener(event);
  };
  const fetch = async (url: string, init: TransportRequestInit, options: TransportFetchOptions): Promise<Response> => {
    const path = pathOf(url);
    const kind = classify(path);
    const chunk = kind === "chunk" ? parseOpenChunkPath(path) : null;
    const requestId = nextId;
    nextId += 1;
    const base = {
      kind,
      method: init.method,
      path,
      isolationKey: options.isolationKey,
      chunkIndex: chunk?.chunk_index ?? null,
      chunkCount: chunk?.chunk_count ?? null,
      bodyBytes: sizeOf(init.body),
      requestId,
    };
    emit({ ...base, phase: "sent", httpStatus: null, complete: null, atMs: Date.now(), error: null });
    let response: Response;
    try {
      response = await inner.fetch(url, init, options);
    } catch (error) {
      emit({
        ...base,
        phase: "failed",
        httpStatus: null,
        complete: null,
        atMs: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    const complete = kind === "chunk" && response.ok ? await chunkComplete(response) : null;
    emit({ ...base, phase: "answered", httpStatus: response.status, complete, atMs: Date.now(), error: null });
    return response;
  };
  return {
    inner,
    kind: inner.kind,
    maxBodyBytes: inner.maxBodyBytes,
    logs: inner.logs,
    isolationKeys: inner.isolationKeys,
    close: inner.close,
    fetch,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// State of one chunk of a proof upload, built from the request events.
export interface ChunkView {
  readonly index: number;
  readonly state: "waiting" | "sent" | "acknowledged" | "failed";
  readonly sends: number;
  readonly bytes: number | null;
  readonly ms: number | null;
  readonly httpStatus: number | null;
}

// Apply one chunk event to the chunk list. The list is created from the first event.
export function applyChunkEvent(chunks: readonly ChunkView[], event: RequestEvent, sentAt: Map<number, number>): ChunkView[] {
  if (event.kind !== "chunk" || event.chunkIndex === null || event.chunkCount === null) return [...chunks];
  const count = event.chunkCount;
  const list: ChunkView[] =
    chunks.length === count
      ? [...chunks]
      : Array.from({ length: count }, (_item, index) => ({ index, state: "waiting", sends: 0, bytes: null, ms: null, httpStatus: null }));
  const current = list[event.chunkIndex];
  if (current === undefined) return list;
  switch (event.phase) {
    case "sent":
      sentAt.set(event.requestId, event.atMs);
      list[event.chunkIndex] = { ...current, state: "sent", sends: current.sends + 1, bytes: event.bodyBytes };
      return list;
    case "answered": {
      const started = sentAt.get(event.requestId) ?? event.atMs;
      const ok = event.httpStatus !== null && event.httpStatus >= 200 && event.httpStatus < 300;
      list[event.chunkIndex] = { ...current, state: ok ? "acknowledged" : "failed", ms: event.atMs - started, httpStatus: event.httpStatus };
      return list;
    }
    case "failed": {
      const started = sentAt.get(event.requestId) ?? event.atMs;
      list[event.chunkIndex] = { ...current, state: "failed", ms: event.atMs - started, httpStatus: null };
      return list;
    }
  }
}

// The transport interface that the SDK uses.

import { z } from "zod";

// "anon": requests go through the Anon-RPC worker. "direct": a plain fetch (tests only).
export type TransportKind = "anon" | "direct";

export interface TransportRequestInit {
  readonly method: "GET" | "POST" | "PUT";
  readonly headers?: Readonly<Record<string, string>>;
  // JSON text. The SDK keeps the exact bytes of signed values inside the JSON envelope.
  // A stream body is also accepted (the harness transfers it to the worker as a stream).
  readonly body?: string | ReadableStream<Uint8Array>;
}

export interface TransportFetchOptions {
  // One key per batch for open, spend, and status. A distinct key for registry paths.
  readonly isolationKey: string;
}

export interface TransportLogEntry {
  // Milliseconds since the transport started.
  readonly atMs: number;
  readonly level: "debug" | "info" | "warn" | "error";
  readonly text: string;
}

export interface Transport {
  readonly kind: TransportKind;
  // Largest request body that the transport can carry, in bytes. The SDK splits a larger
  // open request into chunks (PUT /v1/open/chunks). Nox: 40,000. Direct: Infinity.
  readonly maxBodyBytes: number;
  // Send one request. Fail on a transport failure. Never fall back to another transport.
  readonly fetch: (url: string, init: TransportRequestInit, options: TransportFetchOptions) => Promise<Response>;
  // Close the worker. Later requests fail with the code "closed".
  readonly close: () => void;
  // Worker and transport log lines. They have no request bodies and no secrets.
  readonly logs: readonly TransportLogEntry[];
  // The isolation keys that requests used, in first-use order.
  readonly isolationKeys: () => readonly string[];
}

// An isolation key: 1 to 128 printable ASCII characters.
export const isolationKeySchema = z.string().regex(/^[\x21-\x7e]{1,128}$/, "isolation key must be 1 to 128 printable ASCII characters");

// The largest number of log lines that a transport keeps. Older lines are removed.
export const MAX_LOG_LINES = 1000;

// Add a log line and remove the oldest line if the list is full.
export function pushLog(logs: TransportLogEntry[], entry: TransportLogEntry): void {
  logs.push(entry);
  if (logs.length > MAX_LOG_LINES) logs.shift();
}

// Record the first use of each isolation key.
export function keyRecorder(): { readonly record: (key: string) => void; readonly keys: () => readonly string[] } {
  const seen: string[] = [];
  return {
    record: (key) => {
      if (!seen.includes(key)) seen.push(key);
    },
    keys: () => [...seen],
  };
}

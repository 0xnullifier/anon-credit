// Plain fetch transport. It does not anonymize anything.
//
// Use it only in tests, in the local integration harness (no Nox on localhost), and for the
// explicit demo peer probe. The SDK refuses it unless the caller allows it by name.

import { isolationKeySchema, keyRecorder, pushLog, type Transport, type TransportLogEntry } from "./transport.ts";

export interface DirectTransportOptions {
  // Fetch function. Default: globalThis.fetch.
  readonly fetch?: typeof fetch;
  // Largest request body. Default: Infinity (no limit).
  readonly maxBodyBytes?: number;
}

export function directTransport(options: DirectTransportOptions = {}): Transport {
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const logs: TransportLogEntry[] = [];
  const keys = keyRecorder();
  const start = Date.now();
  let closed = false;
  pushLog(logs, { atMs: 0, level: "warn", text: "direct transport: requests are NOT anonymized" });
  return {
    kind: "direct",
    maxBodyBytes: options.maxBodyBytes ?? Number.POSITIVE_INFINITY,
    logs,
    isolationKeys: keys.keys,
    close: () => {
      closed = true;
    },
    fetch: async (url, init, fetchOptions) => {
      if (closed) throw new Error("the direct transport is closed");
      keys.record(isolationKeySchema.parse(fetchOptions.isolationKey));
      pushLog(logs, { atMs: Date.now() - start, level: "debug", text: `${init.method} ${new URL(url).pathname}` });
      // A plain fetch needs a buffered body; read a stream body first. Send bytes as they are.
      const body = init.body instanceof ReadableStream ? await new Response(init.body).arrayBuffer() : init.body;
      return fetchFn(url, {
        method: init.method,
        ...(init.headers === undefined ? {} : { headers: { ...init.headers } }),
        ...(body === undefined ? {} : { body }),
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
    },
  };
}

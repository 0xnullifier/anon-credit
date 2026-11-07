// Tests of the anonymous transport with a fake harness worker and a fake bootstrap RPC.

import { RpcError, type LogEntry } from "@anon-rpc/browser-harness";
import { describe, expect, it } from "vitest";
import { createAnonTransport, type HarnessFactory, type HarnessWorker } from "./anon.ts";
import { directTransport } from "./direct.ts";
import { TransportError, explainTransportError } from "./errors.ts";
import { NOX_MAX_REQUEST_BODY_BYTES, NOX_MEASURED_MAX_BODY_BYTES, NOX_SPECIFIER } from "./workers.ts";

interface SentCall {
  readonly url: string;
  readonly method: string | undefined;
  readonly isolationKey: string | undefined;
  readonly body: string | undefined;
  readonly bytes: Uint8Array | undefined;
  readonly contentType: string | undefined;
}

// A fake bootstrap RPC on the given chain.
function bootstrapFetch(chainHex: string, seen: string[]): typeof fetch {
  return async (_input, init) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    seen.push(body.method);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: chainHex }), {
      headers: { "content-type": "application/json" },
    });
  };
}

interface FakeOptions {
  readonly ready?: Promise<void>;
  readonly fail?: RpcError | Error;
  readonly logs?: LogEntry[];
}

function fakeFactory(sent: SentCall[], state: { closed: boolean; address: string }, options: FakeOptions = {}): HarnessFactory {
  return (init) => {
    state.address = init.address;
    const logs = [...(options.logs ?? [])];
    const worker: HarnessWorker = {
      ready: options.ready ?? Promise.resolve(),
      async fetch(input, requestInit) {
        if (options.fail !== undefined) throw options.fail;
        sent.push({
          url: input,
          method: requestInit.method,
          isolationKey: requestInit.anonOptions?.isolationKey,
          body: typeof requestInit.body === "string" ? requestInit.body : undefined,
          bytes: requestInit.body instanceof Uint8Array ? requestInit.body : undefined,
          contentType: new Headers(requestInit.headers).get("content-type") ?? undefined,
        });
        return new Response("{}", { status: 200, headers: { "x-anon-remaining": "99", "x-anon-next-seq": "1" } });
      },
      acceptLog() {
        const next = logs.shift();
        return next === undefined ? new Promise<LogEntry>(() => undefined) : Promise.resolve(next);
      },
      close() {
        state.closed = true;
      },
    };
    return worker;
  };
}

describe("createAnonTransport", () => {
  it("checks the bootstrap chain, waits for ready, and sends the isolation key", async () => {
    const sent: SentCall[] = [];
    const methods: string[] = [];
    const state = { closed: false, address: "" };
    const transport = await createAnonTransport({
      bootstrapFetch: bootstrapFetch("0xaa36a7", methods),
      createWorker: fakeFactory(sent, state, { logs: [{ level: "info", args: ["nox-worker", "ready", 3] }] }),
    });
    expect(transport.kind).toBe("anon");
    expect(transport.maxBodyBytes).toBe(NOX_MAX_REQUEST_BODY_BYTES);
    expect(NOX_MAX_REQUEST_BODY_BYTES).toBeLessThan(NOX_MEASURED_MAX_BODY_BYTES);
    expect(state.address).toBe(NOX_SPECIFIER);
    expect(methods).toEqual(["eth_chainId"]);

    const response = await transport.fetch(
      "https://gateway.example/v1/rpc",
      { method: "POST", body: "{}" },
      { isolationKey: "batch-a" },
    );
    // The harness copies all worker headers into the Response.
    expect(response.headers.get("x-anon-remaining")).toBe("99");
    await transport.fetch("https://gateway.example/v1/rpc", { method: "POST", body: "{}" }, { isolationKey: "batch-b" });
    await transport.fetch("https://gateway.example/v1/rpc", { method: "POST", body: "{}" }, { isolationKey: "batch-a" });
    // A binary body with a custom content type reaches the worker unchanged.
    const chunk = new Uint8Array([0, 1, 2, 255]);
    await transport.fetch(
      "https://gateway.example/v1/open/chunks/0x01/0x02/4/1/0",
      { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: chunk },
      { isolationKey: "batch-a" },
    );
    expect(sent.map((call) => call.isolationKey)).toEqual(["batch-a", "batch-b", "batch-a", "batch-a"]);
    expect(sent.at(-1)?.method).toBe("PUT");
    expect(sent.at(-1)?.bytes).toEqual(chunk);
    expect(sent.at(-1)?.contentType).toBe("application/octet-stream");
    expect(transport.isolationKeys()).toEqual(["batch-a", "batch-b"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transport.logs.some((line) => line.text.includes("nox-worker ready 3"))).toBe(true);

    transport.close();
    expect(state.closed).toBe(true);
    await expect(
      transport.fetch("https://gateway.example/v1/rpc", { method: "POST" }, { isolationKey: "batch-a" }),
    ).rejects.toMatchObject({ code: "closed" });
  });

  it("refuses a bootstrap RPC on a different chain", async () => {
    const sent: SentCall[] = [];
    await expect(
      createAnonTransport({
        bootstrapFetch: bootstrapFetch("0x1", []),
        createWorker: fakeFactory(sent, { closed: false, address: "" }),
      }),
    ).rejects.toMatchObject({ code: "wrong_bootstrap_chain" });
  });

  it("fails with timeout when ready does not settle, and closes the worker", async () => {
    const state = { closed: false, address: "" };
    await expect(
      createAnonTransport({
        readyTimeoutMs: 20,
        bootstrapFetch: bootstrapFetch("0xaa36a7", []),
        createWorker: fakeFactory([], state, { ready: new Promise<void>(() => undefined) }),
      }),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(state.closed).toBe(true);
  });

  it("fails a request on a worker error and never falls back", async () => {
    const realFetch = globalThis.fetch;
    let directCalls = 0;
    globalThis.fetch = async () => {
      directCalls += 1;
      return new Response("direct");
    };
    try {
      const transport = await createAnonTransport({
        bootstrapFetch: bootstrapFetch("0xaa36a7", []),
        createWorker: fakeFactory([], { closed: false, address: "" }, {
          fail: new RpcError({ name: "Error", message: "exit unreachable", code: "network-error" }),
        }),
      });
      await expect(
        transport.fetch("https://gateway.example/v1/open", { method: "POST" }, { isolationKey: "k" }),
      ).rejects.toMatchObject({ code: "network_error", workerCode: "network-error" });
      expect(directCalls).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("rejects an empty isolation key", async () => {
    const transport = await createAnonTransport({
      bootstrapFetch: bootstrapFetch("0xaa36a7", []),
      createWorker: fakeFactory([], { closed: false, address: "" }),
    });
    await expect(
      transport.fetch("https://gateway.example/v1/rpc", { method: "POST" }, { isolationKey: "" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("explainTransportError", () => {
  it("maps each worker code with the switch", () => {
    const cases: readonly [string | undefined, string][] = [
      ["timeout", "timeout"],
      ["network-error", "network_error"],
      ["bad-config", "bad_config"],
      ["unsupported", "unsupported_platform"],
      ["unsupported-platform", "unsupported_platform"],
      ["permission-denied", "permission_denied"],
      ["cancelled", "closed"],
      ["closed", "closed"],
      [undefined, "worker_error"],
      ["queue-full", "worker_error"],
    ];
    for (const [workerCode, code] of cases) {
      const error = new RpcError({ name: "Error", message: "m", ...(workerCode === undefined ? {} : { code: workerCode }) });
      expect(explainTransportError(error).code).toBe(code);
    }
    expect(explainTransportError(new Error("hash mismatch")).code).toBe("boot_failed");
    const own = new TransportError("closed", "x");
    expect(explainTransportError(own)).toBe(own);
  });
});

describe("directTransport", () => {
  it("sends a plain fetch without credentials and records keys", async () => {
    const seen: RequestInit[] = [];
    const transport = directTransport({
      fetch: async (_input, init) => {
        seen.push(init ?? {});
        return new Response("ok");
      },
    });
    expect(transport.kind).toBe("direct");
    expect(transport.maxBodyBytes).toBe(Number.POSITIVE_INFINITY);
    expect(directTransport({ maxBodyBytes: 1000 }).maxBodyBytes).toBe(1000);
    await transport.fetch("http://127.0.0.1:1/v1/config", { method: "GET" }, { isolationKey: "registry" });
    expect(seen[0]?.credentials).toBe("omit");
    const chunk = new Uint8Array([9, 8, 7]);
    await transport.fetch("http://127.0.0.1:1/v1/open/chunks/x", { method: "PUT", body: chunk }, { isolationKey: "registry" });
    expect(seen[1]?.body).toBe(chunk);
    expect(transport.isolationKeys()).toEqual(["registry"]);
    expect(transport.logs[0]?.text).toContain("NOT anonymized");
  });
});

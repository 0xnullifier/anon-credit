// A minimal EIP-1193 provider over plain fetch. The harness uses it to read the specifier
// contract (two eth_call requests, LEARNINGS.md entry 3). It is not used after boot.
//
// This fetch is direct, but it only reads a public contract on a public RPC. It does not send
// any credit, batch, or session data.

import type { WorkerInit } from "@anon-rpc/browser-harness";
import { z } from "zod";

export type BootstrapProvider = NonNullable<NonNullable<WorkerInit["preExisting"]>["rpcProvider"]>;

const responseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.number(),
  result: z.string().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

const callSchema = z.object({ to: z.string() });

// Make the provider. `log` receives one line for each specifier read.
export function makeBootstrapProvider(
  url: string,
  fetchFn: typeof fetch,
  log: (text: string) => void,
): BootstrapProvider {
  let nextId = 1;
  return {
    async request(args) {
      const call = callSchema.safeParse(args.params?.[0]);
      if (args.method === "eth_call" && call.success) {
        log(`resolving specifier: eth_call to ${call.data.to}`);
      }
      const id = nextId;
      nextId += 1;
      const response = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method: args.method, params: args.params ?? [] }),
        credentials: "omit",
      });
      if (!response.ok) throw new Error(`bootstrap RPC returned HTTP ${response.status}`);
      const body = responseSchema.parse(await response.json());
      if (body.error !== undefined) throw new Error(`bootstrap RPC error ${body.error.code}: ${body.error.message}`);
      if (body.result === undefined) throw new Error("bootstrap RPC response has no result");
      return body.result;
    },
  };
}

// Read eth_chainId of the bootstrap RPC.
export async function bootstrapChainId(provider: BootstrapProvider): Promise<number> {
  const result = z.string().regex(/^0x[0-9a-fA-F]+$/).parse(await provider.request({ method: "eth_chainId", params: [] }));
  return Number.parseInt(result, 16);
}

// The Sepolia example --dry-run path against fake services. No network, no browser.

import { CURRENT_PRICE_TABLE, deploymentConfigSchema, deploymentId, encodeHex, priceTableHash } from "@anon-credit/protocol";
import type { FundingCheck } from "@anon-credit/sdk/purchase";
import { describe, expect, it } from "vitest";
import { isNonPublicIp, publicHttpsProblems, type PreflightDeps } from "./sepolia.ts";
import { runSepolia } from "./sepolia-run.ts";

const MANIFEST = `0x${"ab".repeat(32)}`;
const deploymentText = {
  protocol_version: 1,
  payment_chain_id: 11_155_111,
  sale_address: `0x${"11".repeat(20)}`,
  root_registry_address: `0x${"22".repeat(20)}`,
  issuer_address: `0x${"33".repeat(20)}`,
  gateway_id: `0x${"44".repeat(32)}`,
  batch_size: 100,
  epoch_seconds: 30,
  credit_lifetime_epochs: 35_040,
  circuit_id: "0x00000000000000616e6f6e2d6372656469742f76312f62617463682d6f70656e",
  verifier_artifact_hash: `0x${"55".repeat(32)}`,
  prover_manifest_hash: MANIFEST,
};
const DEPLOYMENT_ID = encodeHex(deploymentId(deploymentConfigSchema.parse(deploymentText)));
const PRICE_HASH = encodeHex(priceTableHash(CURRENT_PRICE_TABLE));

const env = {
  E2E_ISSUER_URL: "https://issuer.example.org",
  E2E_GATEWAY_URL: "https://gateway.example.org/",
  E2E_PAYER_KEY: `0x${"12".repeat(32)}`,
  E2E_PAYMENT_RPC_URL: "https://rpc.example.org/key-abcdef",
  E2E_TIMEOUT_SECONDS: "60",
};

function json(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeFetch(seen: string[]): typeof fetch {
  return async (input) => {
    const url = new URL(String(input));
    seen.push(`${url.origin}${url.pathname}`);
    switch (`${url.origin}${url.pathname}`) {
      case "https://issuer.example.org/v1/config":
        return json({ deployment: deploymentText, deployment_id: DEPLOYMENT_ID, batch_price_wei: "100000000000000", max_batches_per_purchase: 100, root_window_epochs: 96, block_tag: "latest" });
      case "https://gateway.example.org/v1/config":
        return json({
          protocol_version: 1,
          deployment_id: DEPLOYMENT_ID,
          gateway_id: deploymentText.gateway_id,
          circuit_id: deploymentText.circuit_id,
          verifier_artifact_hash: deploymentText.verifier_artifact_hash,
          payment_chain_id: 11_155_111,
          upstream_chain_id: 11_155_111,
          root_registry_address: deploymentText.root_registry_address,
          epoch_seconds: 30,
          current_epoch: "1000",
          root_window_epochs: 96,
          session_lifetime_epochs: 35_040,
          batch_size: 100,
          price_table_hash: PRICE_HASH,
          limits: {
            open_body_bytes: 16_777_216,
            spend_body_bytes: 65_536,
            upstream_response_bytes: 1_048_576,
            upstream_timeout_ms: 15_000,
            proof_verify_concurrency: 2,
            proof_queue_depth: 8,
            response_retention_seconds: 60,
            batch_lock_wait_ms: 5000,
            open_upload_max_bytes: 4_194_304,
            open_upload_chunk_bytes: 40_000,
            open_upload_chunk_body_bytes: 40_000,
            open_upload_max_chunks: 256,
            open_upload_ttl_seconds: 600,
            open_upload_max_pending: 1000,
            open_upload_max_pending_bytes: 536_870_912,
          },
          demo_peer_enabled: true,
          block_tag: "latest",
        });
      case "https://gateway.example.org/v1/prices":
        return json({ price_table_hash: PRICE_HASH, price_table: CURRENT_PRICE_TABLE });
      case "https://ethereum-sepolia-rpc.publicnode.com/":
        return json({ jsonrpc: "2.0", id: 1, result: "0xaa36a7" });
      default:
        return json({ code: "not_found", message: "x", retryable: false }, 404);
    }
  };
}

function deps(overrides: Partial<PreflightDeps> = {}, fundingOk = true): PreflightDeps {
  return {
    fetch: fakeFetch([]),
    resolve: async () => ["93.184.216.34"],
    funding: async (): Promise<FundingCheck> => ({
      payer: `0x${"77".repeat(20)}`,
      chainId: 11_155_111,
      balanceWei: fundingOk ? 10n ** 18n : 1n,
      priceWei: 100_000_000_000_000n,
      paymentWei: 300_000_000_000_000n,
      gasWei: 1_000_000n,
      ok: fundingOk,
    }),
    manifestSha256: () => MANIFEST,
    ...overrides,
  };
}

async function dryRun(environment: Record<string, string>, preflightDeps: PreflightDeps): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await runSepolia(["--dry-run"], environment, { preflight: preflightDeps, log: (line) => lines.push(line) });
  return { code, lines };
}

describe("Sepolia --dry-run", () => {
  it("passes with consistent services and funds, and never prints the key or the RPC URL", async () => {
    const { code, lines } = await dryRun(env, deps());
    expect(code).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("no transaction was sent");
    expect(text).not.toContain("12".repeat(32));
    expect(text).not.toContain("key-abcdef");
  });

  it("refuses a localhost or private gateway URL before any request", async () => {
    const seen: string[] = [];
    for (const url of ["https://localhost:8081", "http://gateway.example.org", "https://10.1.2.3", "https://192.168.1.10", "https://[::1]:8081"]) {
      const { code, lines } = await dryRun({ ...env, E2E_GATEWAY_URL: url }, deps({ fetch: fakeFetch(seen) }));
      expect(code).toBe(2);
      expect(lines.join("\n")).toContain("refused");
    }
    expect(seen).toEqual([]);
  });

  it("fails when a host resolves to a private address", async () => {
    const { code } = await dryRun(env, deps({ resolve: async () => ["10.0.0.7"] }));
    expect(code).toBe(1);
  });

  it("fails on a manifest that the deployment does not pin, and on missing funds", async () => {
    expect((await dryRun(env, deps({ manifestSha256: () => `0x${"cd".repeat(32)}` }))).code).toBe(1);
    expect((await dryRun(env, deps({}, false))).code).toBe(1);
  });

  it("refuses incomplete settings", async () => {
    const { E2E_PAYER_KEY: _key, ...withoutKey } = env;
    expect((await dryRun(withoutKey, deps())).code).toBe(2);
    expect((await dryRun({ ...env, E2E_PAYMENT_RPC_URL: "" }, deps())).code).toBe(2);
    expect((await dryRun({ ...env, E2E_ADMIN_URL: "https://admin.example.org" }, deps())).code).toBe(2);
  });
});

describe("URL policy", () => {
  it("classifies addresses", () => {
    for (const address of ["127.0.0.1", "10.0.0.1", "172.20.1.1", "192.168.0.1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
      expect(isNonPublicIp(address)).toBe(true);
    }
    for (const address of ["93.184.216.34", "172.32.0.1", "2001:db8::1", "8.8.8.8"]) {
      expect(isNonPublicIp(address)).toBe(false);
    }
    expect(publicHttpsProblems("X", "https://gateway.example.org")).toEqual([]);
    expect(publicHttpsProblems("X", "https://user:pw@gateway.example.org")).toHaveLength(1);
    expect(publicHttpsProblems("X", "https://foo.localhost")).toHaveLength(1);
  });
});

// Settings and preflight checks of the Sepolia example (implementation.md section 15, step 1).
//
// The run uses deployed Sepolia contracts, public HTTPS issuer and gateway URLs, and the Nox
// worker. Nox exits to the public internet, so the gateway and the issuer must be reachable
// from there: a localhost, private, link-local, or loopback URL is refused.
//
// dryRun validates the settings and the connectivity only. It sends no transaction.

import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import {
  SEPOLIA_CHAIN_ID,
  deploymentFromIssuerConfig,
  deploymentId,
  encodeHex,
  gatewayConfigResponseSchema,
  issuerConfigResponseSchema,
  pricesResponseSchema,
  type GatewayConfigResponse,
  type IssuerConfigResponse,
} from "@anon-credit/protocol";
import { checkFunding, type FundingCheck, type PurchaseChain } from "@anon-credit/sdk/purchase";
import { z } from "zod";
import { MANIFEST_PATH, REPO_ROOT } from "./page-server.ts";
import type { Json } from "./result.ts";

const emptyToUndefined = (value: string | undefined): string | undefined => (value === "" ? undefined : value);

export const sepoliaEnvSchema = z.object({
  E2E_ISSUER_URL: z.url(),
  E2E_GATEWAY_URL: z.url(),
  // Secret: testnet funds only. Never print it.
  E2E_PAYER_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "E2E_PAYER_KEY must be 0x and 64 hex digits"),
  // Payer RPC for the purchase and the funding check. Secret if it has a key.
  E2E_PAYMENT_RPC_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  SEPOLIA_RPC_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  NOX_BOOTSTRAP_RPC_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  E2E_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(7200),
  E2E_PAGE_PORT: z.coerce.number().int().min(1).max(65_535).default(5173),
  E2E_DEPLOYMENT_ID: z.preprocess(emptyToUndefined, z.string().regex(/^0x[0-9a-f]{64}$/).optional()),
  E2E_ADMIN_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  GATEWAY_ADMIN_TOKEN: z.preprocess(emptyToUndefined, z.string().min(16).optional()),
  E2E_TEST_ADDRESS: z.string().regex(/^0x[0-9a-f]{40}$/).default("0x000000000000000000000000000000000000dead"),
  E2E_PROVER_MODE: z.enum(["auto", "scalar", "threaded"]).default("auto"),
  E2E_RESULT_PATH: z.preprocess(emptyToUndefined, z.string().optional()),
});
export type SepoliaEnv = z.infer<typeof sepoliaEnvSchema>;

export interface SepoliaConfig {
  readonly issuerUrl: string;
  readonly gatewayUrl: string;
  readonly payerKey: string;
  readonly paymentRpcUrl: string;
  readonly bootstrapRpcUrl: string | undefined;
  readonly timeoutMs: number;
  readonly pagePort: number;
  readonly deploymentId: string | undefined;
  readonly admin: { readonly adminUrl: string; readonly token: string } | undefined;
  readonly testAddress: string;
  readonly proverMode: "auto" | "scalar" | "threaded";
  readonly resultPath: string;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

// Parse the environment. Throw ConfigError with every problem. Never put a value in a message.
export function readSepoliaConfig(env: Readonly<Record<string, string | undefined>>): SepoliaConfig {
  const parsed = sepoliaEnvSchema.safeParse(env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new ConfigError(`invalid settings: ${names.join("; ")}`);
  }
  const value = parsed.data;
  const paymentRpcUrl = value.E2E_PAYMENT_RPC_URL ?? value.SEPOLIA_RPC_URL;
  if (paymentRpcUrl === undefined) throw new ConfigError("set E2E_PAYMENT_RPC_URL (or SEPOLIA_RPC_URL) for the purchase");
  const problems = [
    ...publicHttpsProblems("E2E_GATEWAY_URL", value.E2E_GATEWAY_URL),
    ...publicHttpsProblems("E2E_ISSUER_URL", value.E2E_ISSUER_URL),
  ];
  if (problems.length > 0) throw new ConfigError(problems.join("; "));
  const adminUrl = value.E2E_ADMIN_URL;
  const token = value.GATEWAY_ADMIN_TOKEN;
  if ((adminUrl === undefined) !== (token === undefined)) {
    throw new ConfigError("set both E2E_ADMIN_URL and GATEWAY_ADMIN_TOKEN, or neither");
  }
  return {
    issuerUrl: trimSlash(value.E2E_ISSUER_URL),
    gatewayUrl: trimSlash(value.E2E_GATEWAY_URL),
    payerKey: value.E2E_PAYER_KEY,
    paymentRpcUrl,
    bootstrapRpcUrl: value.NOX_BOOTSTRAP_RPC_URL,
    timeoutMs: value.E2E_TIMEOUT_SECONDS * 1000,
    pagePort: value.E2E_PAGE_PORT,
    deploymentId: value.E2E_DEPLOYMENT_ID,
    admin: adminUrl === undefined || token === undefined ? undefined : { adminUrl: trimSlash(adminUrl), token },
    testAddress: value.E2E_TEST_ADDRESS,
    proverMode: value.E2E_PROVER_MODE,
    resultPath: value.E2E_RESULT_PATH ?? join(REPO_ROOT, "examples/e2e/results/sepolia-result.json"),
  };
}

// Tell if an IP address is loopback, private, link-local, shared (CGNAT), or unspecified.
export function isNonPublicIp(address: string): boolean {
  switch (isIP(address)) {
    case 4: {
      const [a = 0, b = 0] = address.split(".").map(Number);
      switch (true) {
        case a === 0:
        case a === 10:
        case a === 127:
        case a === 169 && b === 254:
        case a === 172 && b >= 16 && b <= 31:
        case a === 192 && b === 168:
        case a === 100 && b >= 64 && b <= 127:
          return true;
        default:
          return false;
      }
    }
    case 6: {
      const lower = address.toLowerCase();
      const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
      switch (true) {
        case mapped?.[1] !== undefined:
          return isNonPublicIp(mapped?.[1] ?? "");
        case lower === "::" || lower === "::1":
        case /^f[cd]/.test(lower):
        case /^fe[89ab]/.test(lower):
          return true;
        default:
          return false;
      }
    }
    default:
      return false;
  }
}

// Problems of a URL that Nox must reach: HTTPS, and not localhost or a non-public address.
export function publicHttpsProblems(name: string, text: string): string[] {
  const url = new URL(text);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const problems: string[] = [];
  if (url.protocol !== "https:") problems.push(`${name} must use https (Nox needs end-to-end TLS to the service)`);
  switch (true) {
    case host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal"):
    case isNonPublicIp(host):
      problems.push(`${name} is a localhost or private address; the Nox exit cannot reach it`);
      break;
    default:
      break;
  }
  if (url.username !== "" || url.password !== "") problems.push(`${name} must not have credentials`);
  return problems;
}

export interface PreflightCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface PreflightReport {
  readonly ok: boolean;
  readonly checks: PreflightCheck[];
  readonly deployment: Record<string, Json>;
  readonly manifestSha256: string;
  readonly issuerConfig: IssuerConfigResponse | null;
  readonly gatewayConfig: GatewayConfigResponse | null;
}

export interface PreflightDeps {
  readonly fetch: typeof fetch;
  // Resolve a host name to its addresses.
  readonly resolve: (host: string) => Promise<string[]>;
  readonly funding: (chain: PurchaseChain, payerKey: string, commitments: readonly string[]) => Promise<FundingCheck>;
  // SHA-256 of the local prover manifest (0x hex).
  readonly manifestSha256: () => string;
}

export const defaultPreflightDeps: PreflightDeps = {
  fetch: globalThis.fetch.bind(globalThis),
  resolve: async (host) => (await lookup(host, { all: true })).map((entry) => entry.address),
  funding: checkFunding,
  manifestSha256: () => `0x${createHash("sha256").update(readFileSync(join(REPO_ROOT, "artifacts", MANIFEST_PATH))).digest("hex")}`,
};

async function getJson<S extends z.ZodType>(fetchFn: typeof fetch, url: string, schema: S, headers: Record<string, string> = {}): Promise<z.output<S>> {
  const response = await fetchFn(url, { headers });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return schema.parse(await response.json());
}

function failureText(error: {} | null | undefined): string {
  return error instanceof Error ? error.message : String(error);
}

// The batches of one run. The funding check uses this count.
export const RUN_BATCHES = 3;

// Step 1 and --dry-run: settings, identities, chain IDs, artifacts, connectivity, funding,
// and admin access. It sends no transaction and no paid request.
export async function preflight(config: SepoliaConfig, deps: PreflightDeps = defaultPreflightDeps): Promise<PreflightReport> {
  const checks: PreflightCheck[] = [];
  const add = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };
  const attempt = async (name: string, body: () => Promise<string>): Promise<void> => {
    try {
      add(name, true, await body());
    } catch (error) {
      add(name, false, failureText(error));
    }
  };

  const tryGet = async <S extends z.ZodType>(name: string, url: string, schema: S, describe: (value: z.output<S>) => string): Promise<z.output<S> | null> => {
    try {
      const value = await getJson(deps.fetch, url, schema);
      add(name, true, describe(value));
      return value;
    } catch (error) {
      add(name, false, failureText(error));
      return null;
    }
  };

  for (const service of [
    { name: "gateway", url: config.gatewayUrl },
    { name: "issuer", url: config.issuerUrl },
  ]) {
    await attempt(`${service.name} host resolves to public addresses`, async () => {
      const addresses = await deps.resolve(new URL(service.url).hostname);
      const bad = addresses.filter(isNonPublicIp);
      if (addresses.length === 0) throw new Error("no address");
      if (bad.length > 0) throw new Error(`resolves to a non-public address; the Nox exit cannot reach it`);
      return `${addresses.length} public address(es)`;
    });
  }

  const manifestSha256 = deps.manifestSha256();
  const issuer = await tryGet("issuer GET /v1/config", `${config.issuerUrl}/v1/config`, issuerConfigResponseSchema, (value) => `deployment ${value.deployment_id}`);
  const gateway = await tryGet("gateway GET /v1/config", `${config.gatewayUrl}/v1/config`, gatewayConfigResponseSchema, (value) => `deployment ${value.deployment_id}`);
  await tryGet("gateway GET /v1/prices", `${config.gatewayUrl}/v1/prices`, pricesResponseSchema, (value) => `price table hash ${value.price_table_hash}`);
  let deployment: Record<string, Json> = {};
  if (issuer !== null && gateway !== null) {
    const recomputed = encodeHex(deploymentId(deploymentFromIssuerConfig(issuer)));
    add("issuer deployment_id is keccak256 of its deployment", recomputed === issuer.deployment_id, recomputed);
    add("gateway and issuer deployment_id agree", gateway.deployment_id === issuer.deployment_id, gateway.deployment_id);
    add("gateway and issuer gateway_id agree", gateway.gateway_id === issuer.deployment.gateway_id, gateway.gateway_id);
    add("deployment pins the circuit, verifier, and epoch of the gateway",
      gateway.circuit_id === issuer.deployment.circuit_id &&
        gateway.verifier_artifact_hash === issuer.deployment.verifier_artifact_hash &&
        gateway.epoch_seconds === issuer.deployment.epoch_seconds,
      `epoch ${gateway.epoch_seconds} s`);
    add("payment chain is Sepolia", issuer.deployment.payment_chain_id === SEPOLIA_CHAIN_ID, String(issuer.deployment.payment_chain_id));
    add("gateway upstream chain is Sepolia", gateway.upstream_chain_id === SEPOLIA_CHAIN_ID, String(gateway.upstream_chain_id));
    add("local prover manifest is the pinned manifest", issuer.deployment.prover_manifest_hash === manifestSha256, manifestSha256);
    add("deployment_id is the pinned E2E_DEPLOYMENT_ID",
      config.deploymentId === undefined || config.deploymentId === issuer.deployment_id,
      config.deploymentId === undefined ? "not pinned" : config.deploymentId);
    deployment = {
      deploymentId: issuer.deployment_id,
      paymentChainId: issuer.deployment.payment_chain_id,
      saleAddress: issuer.deployment.sale_address,
      rootRegistryAddress: issuer.deployment.root_registry_address,
      epochSeconds: issuer.deployment.epoch_seconds,
      batchPriceWei: issuer.batch_price_wei,
      proverManifestHash: issuer.deployment.prover_manifest_hash,
      gatewayUrl: new URL(config.gatewayUrl).origin,
      issuerUrl: new URL(config.issuerUrl).origin,
    };
    const sale = issuer.deployment.sale_address;
    const chainId = issuer.deployment.payment_chain_id;
    await attempt("payer funds cover three batches and gas", async () => {
      const funding = await deps.funding(
        { rpcUrl: config.paymentRpcUrl, chainId, saleAddress: sale },
        config.payerKey,
        Array.from({ length: RUN_BATCHES }, (_, index) => `0x${(index + 1).toString(16).padStart(64, "0")}`),
      );
      if (funding.priceWei.toString(10) !== issuer.batch_price_wei) throw new Error("CreditSale price is not the issuer price");
      if (!funding.ok) throw new Error(`payer ${funding.payer} has ${funding.balanceWei} wei; needs ${funding.paymentWei + funding.gasWei} wei`);
      return `payer ${funding.payer}: ${funding.balanceWei} wei, needs about ${funding.paymentWei + funding.gasWei} wei`;
    });
  }

  await attempt("Nox bootstrap RPC is on Sepolia", async () => {
    const url = config.bootstrapRpcUrl ?? "https://ethereum-sepolia-rpc.publicnode.com";
    const response = await deps.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    const body = z.object({ result: z.string() }).parse(await response.json());
    if (Number.parseInt(body.result, 16) !== SEPOLIA_CHAIN_ID) throw new Error(`chain ${body.result}`);
    return "chain 11155111";
  });

  const admin = config.admin;
  switch (admin) {
    case undefined:
      add("admin access", true, "not configured; step 15 is skipped");
      break;
    default:
      await attempt("admin access", async () => {
        const response = await deps.fetch(`${admin.adminUrl}/admin/v1/snapshot`, { headers: { authorization: `Bearer ${admin.token}` } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return "snapshot readable";
      });
  }

  return { ok: checks.every((check) => check.ok), checks, deployment, manifestSha256, issuerConfig: issuer, gatewayConfig: gateway };
}

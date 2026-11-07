// Settings of the app. Defaults come from VITE_* variables at build time; the setup panel can
// change the URLs and the transport. Secrets never come from here: the passphrase is typed.

import { z } from "zod";

export type TransportChoice = "nox" | "direct";
export type ProverChoice = "auto" | "scalar" | "threaded";

export interface Settings {
  readonly gatewayUrl: string;
  readonly issuerUrl: string;
  readonly transport: TransportChoice;
  readonly prover: ProverChoice;
  // Sepolia RPC that reads the Nox specifier. Empty: the transport default.
  readonly bootstrapRpcUrl: string;
  // Largest first-use delay in epochs (0 to 3). The demo profile uses 1.
  readonly maxFirstUseDelayEpochs: number;
  // IndexedDB database of the encrypted client state.
  readonly storageName: string;
}

// A local development payer: the anvil test key and its RPC. Only the dev stack sets them.
export interface DevPayer {
  readonly privateKey: string;
  readonly rpcUrl: string;
}

const env = import.meta.env;

function text(value: string | boolean | undefined, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

function isLocal(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

function storeFromQuery(): string | null {
  try {
    const name = new URLSearchParams(window.location.search).get("store");
    return name !== null && /^[a-z0-9-]{1,64}$/.test(name) ? name : null;
  } catch {
    return null;
  }
}

export function defaultSettings(): Settings {
  const gatewayUrl = text(env["VITE_GATEWAY_URL"], "http://127.0.0.1:8081");
  return {
    gatewayUrl,
    issuerUrl: text(env["VITE_ISSUER_URL"], "http://127.0.0.1:8080"),
    // Nox cannot reach localhost. A local gateway gets the direct transport by default.
    transport: isLocal(gatewayUrl) ? "direct" : "nox",
    prover: "auto",
    bootstrapRpcUrl: text(env["VITE_NOX_BOOTSTRAP_RPC_URL"], ""),
    maxFirstUseDelayEpochs: z.coerce.number().int().min(0).max(3).catch(1).parse(text(env["VITE_MAX_FIRST_USE_DELAY_EPOCHS"], "1")),
    // ?store=<name> selects another IndexedDB database: a second customer in the same browser.
    storageName: storeFromQuery() ?? text(env["VITE_STORAGE_NAME"], "anon-credit-app"),
  };
}

// The development payer, or null if the build has none.
export function devPayer(): DevPayer | null {
  const privateKey = text(env["VITE_DEV_PAYER_KEY"], "");
  const rpcUrl = text(env["VITE_DEV_RPC_URL"], "");
  if (privateKey === "" || rpcUrl === "") return null;
  return { privateKey, rpcUrl };
}

// The HTTP RPC that a local key pair uses to read the chain and to broadcast. Null if the
// build has none; then only an injected wallet can pay.
export function localRpcUrl(): string | null {
  const rpcUrl = text(env["VITE_DEV_RPC_URL"], "");
  return rpcUrl === "" ? null : rpcUrl;
}

// A fixed public address for eth_getBalance that is not the payer.
export const TEST_ADDRESS = text(env["VITE_TEST_ADDRESS"], "0x000000000000000000000000000000000000dead");

// Path of the prover manifest on this origin (Vite serves the repository artifacts/ directory).
export const MANIFEST_PATH = "/batch-open/prover-manifest.json";

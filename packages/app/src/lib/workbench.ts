// The workbench: transport, prover, encrypted storage, and the SDK client of one browser.
// It is built once per unlock, and again when the transport changes. Every step of the build
// is reported as it happens.

import { createAnonTransport, directTransport, type Transport } from "@anon-credit/anon-transport";
import { gatewayConfigResponseSchema, issuerConfigResponseSchema, type GatewayConfigResponse, type IssuerConfigResponse } from "@anon-credit/protocol";
import { createBatchOpenProver, sha256Hex, type BatchOpenProver } from "@anon-credit/prover";
import { CONFIG_ISOLATION_KEY, createClient, indexedDbStorage, type Client, type OpenProgress, type StorageAdapter } from "@anon-credit/sdk";
import type { z } from "zod";
import { observeTransport, type ObservedTransport } from "./observe.ts";
import { MANIFEST_PATH, type Settings } from "./settings.ts";

export interface Workbench {
  readonly settings: Settings;
  readonly client: Client;
  readonly transport: ObservedTransport;
  readonly prover: BatchOpenProver;
  readonly storage: StorageAdapter;
  readonly gatewayConfig: GatewayConfigResponse;
  readonly issuerConfig: IssuerConfigResponse;
  // SHA-256 of the manifest bytes that this origin serves (0x hex).
  readonly manifestSha256: string;
  readonly transportReadyMs: number;
  readonly close: () => void;
}

export interface BuildHooks {
  // A line about the current build step. It never has a secret.
  readonly onPhase: (text: string) => void;
  readonly onOpenProgress: (progress: OpenProgress) => void;
  // Transport log lines (Nox worker output).
  readonly onTransportLog: (text: string) => void;
}

function trim(url: string): string {
  return url.replace(/\/+$/, "");
}

async function readJson<S extends z.ZodType>(transport: Transport, url: string, schema: S): Promise<z.output<S>> {
  const response = await transport.fetch(url, { method: "GET" }, { isolationKey: CONFIG_ISOLATION_KEY });
  if (!response.ok) throw new Error(`GET ${url} answered HTTP ${response.status}`);
  return schema.parse(await response.json());
}

// Read the manifest that this origin serves and return its digest. The SDK checks the digest
// against the deployment pin at createClient.
export async function servedManifestSha256(): Promise<string> {
  const response = await fetch(MANIFEST_PATH, { cache: "no-store" });
  if (!response.ok) throw new Error(`GET ${MANIFEST_PATH} answered HTTP ${response.status}`);
  return `0x${await sha256Hex(new Uint8Array(await response.arrayBuffer()))}`;
}

export async function createTransport(settings: Settings, hooks: BuildHooks): Promise<Transport> {
  switch (settings.transport) {
    case "nox":
      hooks.onPhase("starting the Nox worker (Anon-RPC harness)");
      return createAnonTransport({
        readyTimeoutMs: 180_000,
        ...(settings.bootstrapRpcUrl === "" ? {} : { bootstrapRpcUrl: settings.bootstrapRpcUrl }),
        onLog: (line) => {
          if (line.level !== "debug") hooks.onTransportLog(line.text);
        },
      });
    case "direct":
      hooks.onPhase("direct transport: requests are not anonymized");
      return directTransport();
  }
}

// Build the workbench. The passphrase unlocks the encrypted store; it is not kept here.
export async function buildWorkbench(settings: Settings, passphrase: string, hooks: BuildHooks): Promise<Workbench> {
  const transportStart = performance.now();
  const transport = observeTransport(await createTransport(settings, hooks));
  const transportReadyMs = performance.now() - transportStart;
  try {
    hooks.onPhase("reading the gateway and the issuer configuration");
    const gatewayConfig = await readJson(transport, `${trim(settings.gatewayUrl)}/v1/config`, gatewayConfigResponseSchema);
    const issuerConfig = await readJson(transport, `${trim(settings.issuerUrl)}/v1/config`, issuerConfigResponseSchema);
    hooks.onPhase("hashing the served prover manifest");
    const manifestSha256 = await servedManifestSha256();
    const mode = settings.prover === "auto" ? (crossOriginIsolated ? "threaded" : "scalar") : settings.prover;
    hooks.onPhase(`loading the ProveKit prover (${mode}, crossOriginIsolated=${String(crossOriginIsolated)})`);
    const prover = await createBatchOpenProver({ manifestUrl: MANIFEST_PATH, manifestSha256: manifestSha256.slice(2), mode });
    try {
      hooks.onPhase("unlocking the encrypted store and checking the deployment");
      const storage = await indexedDbStorage({ name: settings.storageName });
      const client = await createClient({
        gatewayUrl: settings.gatewayUrl,
        issuerUrl: settings.issuerUrl,
        transport,
        allowDirectTransport: settings.transport === "direct",
        prover,
        storage,
        passphrase,
        proverManifestSha256: manifestSha256,
        maxFirstUseDelayEpochs: settings.maxFirstUseDelayEpochs,
        pollMs: 2000,
        onOpenProgress: hooks.onOpenProgress,
      });
      return {
        settings,
        client,
        transport,
        prover,
        storage,
        gatewayConfig,
        issuerConfig,
        manifestSha256,
        transportReadyMs,
        close: () => {
          prover.dispose();
          transport.close();
        },
      };
    } catch (error) {
      prover.dispose();
      throw error;
    }
  } catch (error) {
    transport.close();
    throw error;
  }
}

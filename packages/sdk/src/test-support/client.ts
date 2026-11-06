// Test helpers: a fake prover, a manual clock, and a client on the fake services.

import { batchLeaf } from "@anon-credit/crypto";
import type { ProofResult } from "@anon-credit/prover";
import { createClient, type Client, type ClientConfig } from "../client.ts";
import type { ProverLike } from "../open.ts";
import type { Clock } from "../random.ts";
import { memoryStorage, type StorageAdapter } from "../storage.ts";
import { EPOCH_SECONDS, GATEWAY_URL, ISSUER_URL, MANIFEST_SHA, fakeServices, type FakeServices } from "./fake-services.ts";
import type { BatchOpenInputs } from "@anon-credit/prover";

export interface ManualClock extends Clock {
  readonly set: (ms: number) => void;
  readonly sleeps: number[];
}

// A clock that moves forward only when the code sleeps.
export function manualClock(startMs: number): ManualClock {
  let now = startMs;
  const sleeps: number[] = [];
  return {
    sleeps,
    nowMs: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    set: (ms) => {
      now = ms;
    },
  };
}

export function fakeProver(seen: BatchOpenInputs[] = []): ProverLike {
  return {
    prove: async (inputs): Promise<ProofResult> => {
      seen.push(inputs);
      return { proof: new TextEncoder().encode("proof"), durationMs: 5, witnessMs: 1, provingMs: 4, wasmMemoryBytes: null };
    },
  };
}

export const EPOCH_MS = EPOCH_SECONDS * 1000;

export interface TestSetup {
  readonly fake: FakeServices;
  readonly storage: StorageAdapter;
  readonly clock: ManualClock;
  readonly client: Client;
}

export async function testClient(overrides: Partial<ClientConfig> = {}, fake: FakeServices = fakeServices()): Promise<TestSetup> {
  const storage = overrides.storage ?? memoryStorage();
  const clock = manualClock(1001 * EPOCH_MS);
  const client = await createClient({
    gatewayUrl: GATEWAY_URL,
    issuerUrl: `${ISSUER_URL}/`,
    transport: fake.transport,
    prover: fakeProver(),
    storage,
    passphrase: "test passphrase",
    kdfIterations: 1000,
    proverManifestSha256: MANIFEST_SHA,
    firstUseDelayEpochs: 0,
    clock,
    retry: { attempts: 3, delayMs: 10 },
    pollMs: EPOCH_MS,
    ...overrides,
  });
  return { fake, storage, clock, client };
}

// Make n batches, issue them with a finalized root at epoch 1001, and open the first one.
export async function issued(setup: TestSetup, n: number): Promise<string[]> {
  const batches = await setup.client.createBatches(n);
  const expiry = 1000n + 35_040n;
  const issuance = setup.fake.issue(
    batches.map((batch) => BigInt(batch.commitment)),
    (commitment) => batchLeaf(commitment, expiry),
    1001n,
  );
  await setup.client.attachIssuance(issuance);
  return batches.map((batch) => batch.batchId);
}

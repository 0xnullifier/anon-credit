// createClient: the top-level SDK API (Architecture.md section 6.4).
//
//   const client = await createClient({ gatewayUrl, issuerUrl, transport, prover, storage, passphrase, proverManifestSha256 });
//   const batches = await client.createBatches(3);       // commitments for the purchase
//   await client.attachIssuance(issuance);                // leaf metadata from the issuer
//   await client.rpc("eth_blockNumber", []);              // opens sessions as needed
//   client.batches();                                     // remaining batches and units
//   await client.rotate();                                // leave the current batch
//   await client.exportBackup();                          // one string
//
// The client refuses a direct transport unless allowDirectTransport is true. With an anonymous
// transport, a transport failure fails the request; the SDK never sends it directly.

import type { Transport } from "@anon-credit/anon-transport";
import {
  deploymentFromIssuerConfig,
  deploymentId,
  encodeHex,
  issuanceSchema,
  type Issuance,
  type OpenRequest,
  type OpenResponse,
  type PriceTable,
  type StatusResponse,
} from "@anon-credit/protocol";
import { decodeBackup, encodeBackup } from "./backup.ts";
import { SdkError, ServiceError } from "./errors.ts";
import { buildStatusRequest, gatewayClient, type GatewayClient } from "./gateway.ts";
import { batchValues, createBatchSecret, createSessionKey, hexOf, sessionKeyFromSecret, bytes32 } from "./keys.ts";
import {
  prepareOpen,
  requireLeaf,
  submitOpen,
  waitForEligibleRoot,
  type OpenContext,
  type OpenProgress,
  type PreparedOpen,
  type ProverLike,
  type SelectedRoot,
} from "./open.ts";
import { systemClock, webCryptoRandom, type Clock, type RandomSource } from "./random.ts";
import { expectedLeaf, registryClient, type RegistryClient } from "./registry.ts";
import { DEFAULT_RETRY, Session, type RetryPolicy, type RpcOptions, type RpcOutcome, type SessionContext } from "./session.ts";
import type { JsonValue } from "./spend.ts";
import {
  BATCH_PREFIX,
  DEPLOYMENT_KEY,
  batchKey,
  batchRecordSchema,
  deploymentRecordSchema,
  type BatchRecord,
  type DeploymentRecord,
} from "./state.ts";
import { openEncryptedStore, type EncryptedStore, type StorageAdapter } from "./storage.ts";

export interface ClientConfig {
  // Gateway and issuer base URLs (HTTPS for the testnet run).
  readonly gatewayUrl: string;
  readonly issuerUrl: string;
  readonly transport: Transport;
  // Allow a direct (not anonymous) transport. Only for tests and the local integration harness.
  readonly allowDirectTransport?: boolean;
  readonly prover: ProverLike;
  readonly storage: StorageAdapter;
  // Unlock passphrase of the encrypted storage. Never print it.
  readonly passphrase: string;
  // PBKDF2 iterations for a new store. Default: 600,000.
  readonly kdfIterations?: number;
  // The pinned SHA-256 of the prover manifest (0x hex). The deployment must have this value.
  readonly proverManifestSha256: string;
  // Optional pinned deployment ID. If set, the services must report it.
  readonly deploymentId?: string;
  // First-use delay in epochs for new batches: a fixed value 0..3, or "random" (default).
  readonly firstUseDelayEpochs?: number | "random";
  // Random value in [0, 1) for the first-use delay. Default: WebCrypto.
  readonly delayRandom?: () => number;
  readonly random?: RandomSource;
  readonly clock?: Clock;
  readonly retry?: RetryPolicy;
  // Time between eligibility checks. Default: 5000 ms.
  readonly pollMs?: number;
  // Wait limit for an eligible root. Default: 2 hours.
  readonly eligibleTimeoutMs?: number;
  readonly onOpenProgress?: (progress: OpenProgress) => void;
}

export interface BatchSummary {
  readonly batchId: string;
  readonly commitment: string;
  readonly leafIndex: number | null;
  readonly eligibleEpoch: string | null;
  readonly openEpoch: string | null;
  readonly delayEpochs: number;
  // new: no leaf. issued: leaf, no session. active, exhausted, expired: session state.
  readonly state: "new" | "issued" | "active" | "exhausted" | "expired";
  readonly remaining: number | null;
  readonly nextSeq: string | null;
  readonly pending: boolean;
  readonly retired: boolean;
}

export interface Client {
  readonly deployment: DeploymentRecord;
  readonly priceTable: PriceTable;
  readonly transport: Transport;
  // Make n batch secrets and session keys. Return only public values.
  readonly createBatches: (n: number) => Promise<{ readonly batchId: string; readonly commitment: string }[]>;
  // Store the leaf metadata of an issuance for the batches with these commitments.
  readonly attachIssuance: (issuance: Issuance) => Promise<string[]>;
  readonly batches: () => Promise<BatchSummary[]>;
  readonly waitForEligibleRoot: (batchId: string) => Promise<SelectedRoot>;
  readonly prepareOpen: (batchId: string, root?: SelectedRoot) => Promise<PreparedOpen>;
  readonly submitOpen: (batchId: string, request: OpenRequest) => Promise<OpenResponse>;
  // Wait, prove, and open. Make a new proof one time if the proof epoch is stale.
  readonly open: (batchId: string) => Promise<OpenResponse>;
  readonly session: (batchId: string) => Promise<Session>;
  // Signed status of any batch (also one without a session: the gateway answers not_found).
  readonly status: (batchId: string) => Promise<StatusResponse>;
  // Pay for one request with the current batch. Open the next batch when needed.
  readonly rpc: (method: string, params: readonly JsonValue[], options?: RpcOptions) => Promise<RpcOutcome>;
  // Leave the current batch. The next rpc() uses or opens the next batch.
  readonly rotate: () => Promise<string | null>;
  // Send every pending request of the journal again. Return the outcomes.
  readonly resumePending: () => Promise<RpcOutcome[]>;
  readonly exportBackup: () => Promise<string>;
}

function requireTransport(config: ClientConfig): void {
  switch (config.transport.kind) {
    case "anon":
      return;
    case "direct":
      if (config.allowDirectTransport === true) return;
      throw new SdkError(
        "direct_transport_refused",
        "the transport is direct (not anonymous); set allowDirectTransport only for tests and the local harness",
      );
  }
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

// Check the services against each other and against the pinned values.
async function checkDeployment(
  config: ClientConfig,
  gateway: GatewayClient,
  registry: RegistryClient,
): Promise<{ readonly deployment: DeploymentRecord; readonly priceTable: PriceTable; readonly priceTableHash: string }> {
  const [gatewayConfig, prices, issuerConfig] = [await gateway.config(), await gateway.prices(), await registry.config()];
  const issuerDeployment = issuerConfig.deployment;
  const recomputed = encodeHex(deploymentId(deploymentFromIssuerConfig(issuerConfig)));
  const mismatches: string[] = [];
  const expect = (what: string, ok: boolean): void => {
    if (!ok) mismatches.push(what);
  };
  expect("issuer deployment_id is not keccak256 of its deployment", recomputed === issuerConfig.deployment_id);
  expect("gateway and issuer deployment_id differ", gatewayConfig.deployment_id === issuerConfig.deployment_id);
  expect("gateway and issuer gateway_id differ", gatewayConfig.gateway_id === issuerDeployment.gateway_id);
  expect("gateway and issuer circuit_id differ", gatewayConfig.circuit_id === issuerDeployment.circuit_id);
  expect("gateway and issuer verifier_artifact_hash differ", gatewayConfig.verifier_artifact_hash === issuerDeployment.verifier_artifact_hash);
  expect("gateway and issuer epoch_seconds differ", gatewayConfig.epoch_seconds === issuerDeployment.epoch_seconds);
  expect("prover_manifest_hash is not the pinned manifest digest", issuerDeployment.prover_manifest_hash === config.proverManifestSha256);
  expect("price table hash of /v1/prices is not the config value", prices.price_table_hash === gatewayConfig.price_table_hash);
  expect("deployment_id is not the pinned value", config.deploymentId === undefined || config.deploymentId === issuerConfig.deployment_id);
  if (mismatches.length > 0) throw new SdkError("deployment_mismatch", mismatches.join("; "));
  return {
    deployment: {
      deployment_id: issuerConfig.deployment_id,
      gateway_id: issuerDeployment.gateway_id,
      circuit_id: issuerDeployment.circuit_id,
      prover_manifest_hash: issuerDeployment.prover_manifest_hash,
      verifier_artifact_hash: issuerDeployment.verifier_artifact_hash,
      payment_chain_id: issuerDeployment.payment_chain_id,
      sale_address: issuerDeployment.sale_address,
      root_registry_address: issuerDeployment.root_registry_address,
      epoch_seconds: issuerDeployment.epoch_seconds,
      batch_size: issuerDeployment.batch_size,
    },
    priceTable: prices.price_table,
    priceTableHash: prices.price_table_hash,
  };
}

async function readBatches(store: EncryptedStore): Promise<BatchRecord[]> {
  const out: BatchRecord[] = [];
  for (const key of await store.keys(BATCH_PREFIX)) {
    const record = await store.read(key, batchRecordSchema);
    if (record !== undefined) out.push(record);
  }
  return out.sort((a, b) => a.order - b.order);
}

function summary(record: BatchRecord): BatchSummary {
  const state: BatchSummary["state"] = record.session?.state ?? (record.leaf === null ? "new" : "issued");
  return {
    batchId: record.batch_id,
    commitment: record.commitment,
    leafIndex: record.leaf?.leaf_index ?? null,
    eligibleEpoch: record.leaf?.eligible_epoch ?? null,
    openEpoch: record.leaf === null ? null : (BigInt(record.leaf.eligible_epoch) + BigInt(record.delay_epochs)).toString(10),
    delayEpochs: record.delay_epochs,
    state,
    remaining: record.session?.remaining ?? null,
    nextSeq: record.session?.next_seq ?? null,
    pending: record.pending !== null,
    retired: record.retired,
  };
}

function randomUnit(random: RandomSource): number {
  const bytes = random(4);
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false) / 2 ** 32;
}

export async function createClient(config: ClientConfig): Promise<Client> {
  requireTransport(config);
  const random = config.random ?? webCryptoRandom;
  const clock = config.clock ?? systemClock;
  const gateway = gatewayClient({ transport: config.transport, baseUrl: trimSlash(config.gatewayUrl) });
  const registry = registryClient({ transport: config.transport, baseUrl: trimSlash(config.issuerUrl) });
  const store = await openEncryptedStore(config.storage, {
    passphrase: config.passphrase,
    random,
    ...(config.kdfIterations === undefined ? {} : { iterations: config.kdfIterations }),
  });
  const checked = await checkDeployment(config, gateway, registry);
  const stored = await store.read(DEPLOYMENT_KEY, deploymentRecordSchema);
  switch (stored) {
    case undefined:
      await store.write(DEPLOYMENT_KEY, checked.deployment);
      break;
    default:
      if (stored.deployment_id !== checked.deployment.deployment_id) {
        throw new SdkError("deployment_mismatch", "the storage belongs to a different deployment");
      }
  }
  const deployment = checked.deployment;
  const sessionContext: SessionContext = { store, gateway, deployment, random, clock, retry: config.retry ?? DEFAULT_RETRY };
  const openContext: OpenContext = {
    store,
    gateway,
    registry,
    deployment,
    prover: config.prover,
    clock,
    priceTable: checked.priceTable,
    priceTableHash: checked.priceTableHash,
    pollMs: config.pollMs ?? 5000,
    ...(config.onOpenProgress === undefined ? {} : { onProgress: config.onOpenProgress }),
  };
  const sessions = new Map<string, Session>();

  const load = async (batchId: string): Promise<BatchRecord> => {
    const record = await store.read(batchKey(batchId), batchRecordSchema);
    if (record === undefined) throw new SdkError("batch_not_found", `batch ${batchId} is not in the storage`);
    return record;
  };

  const keyOf = (record: BatchRecord) => sessionKeyFromSecret(bytes32(record.session_secret));

  const session = async (batchId: string): Promise<Session> => {
    const known = sessions.get(batchId);
    if (known !== undefined) return known;
    const record = await load(batchId);
    if (record.session === null) throw new SdkError("session_not_open", `batch ${batchId} has no open session`);
    const created = new Session(record, keyOf(record), sessionContext);
    sessions.set(batchId, created);
    return created;
  };

  const delayFor = (): number => {
    const fixed = config.firstUseDelayEpochs ?? "random";
    switch (fixed) {
      case "random": {
        const unit = config.delayRandom?.() ?? randomUnit(random);
        return Math.max(0, Math.min(3, Math.floor(unit * 4)));
      }
      default:
        return Math.max(0, Math.min(3, Math.trunc(fixed)));
    }
  };

  const prepare = async (batchId: string, root?: SelectedRoot): Promise<PreparedOpen> => {
    const record = await load(batchId);
    const selected = root ?? (await waitForEligibleRoot(openContext, record, config.eligibleTimeoutMs ?? 7_200_000));
    return prepareOpen(openContext, await load(batchId), keyOf(record), selected);
  };

  const submit = async (batchId: string, request: OpenRequest): Promise<OpenResponse> => {
    const result = await submitOpen(openContext, await load(batchId), request);
    sessions.delete(batchId);
    return result.response;
  };

  const open = async (batchId: string): Promise<OpenResponse> => {
    const prepared = await prepare(batchId);
    try {
      return await submit(batchId, prepared.request);
    } catch (error) {
      if (error instanceof ServiceError && error.serviceCode === "proof_epoch_stale") {
        return submit(batchId, (await prepare(batchId, prepared.root)).request);
      }
      throw error;
    }
  };

  // The batch that pays for the next request: an open, active, not retired batch with enough
  // units, else the next issued batch, which the client opens.
  const current = async (units: number): Promise<Session> => {
    const records = await readBatches(store);
    const usable = records.find((record) => !record.retired && record.session?.state === "active" && record.session.remaining >= units);
    if (usable !== undefined) return session(usable.batch_id);
    const next = records.find((record) => !record.retired && record.session === null && record.leaf !== null);
    if (next === undefined) throw new SdkError("batch_not_found", "no batch with enough units is left; buy more batches");
    await open(next.batch_id);
    return session(next.batch_id);
  };

  return {
    deployment,
    priceTable: checked.priceTable,
    transport: config.transport,
    createBatches: async (n) => {
      if (!Number.isInteger(n) || n < 1 || n > 100) throw new SdkError("batch_not_found", "make 1 to 100 batches at a time");
      const out: { batchId: string; commitment: string }[] = [];
      const existing = (await store.keys(BATCH_PREFIX)).length;
      for (let index = 0; index < n; index += 1) {
        const k = createBatchSecret(random);
        const key = createSessionKey(random);
        const values = batchValues(bytes32(deployment.deployment_id), k);
        const record: BatchRecord = {
          order: existing + index,
          batch_id: values.batchId,
          commitment: values.commitment,
          k: hexOf(k),
          session_secret: hexOf(key.secretKey),
          session_pub: hexOf(key.publicKey),
          delay_epochs: delayFor(),
          leaf: null,
          open_request: null,
          session: null,
          pending: null,
          retired: false,
        };
        await store.write(batchKey(record.batch_id), record);
        out.push({ batchId: values.batchId, commitment: values.commitment });
      }
      return out;
    },
    attachIssuance: async (input) => {
      const issuance = issuanceSchema.parse(input);
      const records = await readBatches(store);
      const matched: string[] = [];
      for (const leaf of issuance.leaves) {
        const record = records.find((item) => item.commitment === leaf.commitment);
        if (record === undefined) continue;
        if (expectedLeaf(record.commitment, BigInt(issuance.expiry)) !== leaf.leaf) {
          throw new SdkError("proof_check_failed", `issued leaf ${leaf.leaf_index} is not H(DOM_LEAF, c, K, expiry)`);
        }
        await store.write(batchKey(record.batch_id), {
          ...record,
          leaf: {
            leaf_index: leaf.leaf_index,
            leaf: leaf.leaf,
            insertion_epoch: issuance.insertion_epoch,
            eligible_epoch: issuance.eligible_epoch,
            expiry: issuance.expiry,
          },
        });
        matched.push(record.batch_id);
      }
      return matched;
    },
    batches: async () => (await readBatches(store)).map(summary),
    waitForEligibleRoot: async (batchId) => {
      const record = await load(batchId);
      requireLeaf(record);
      return waitForEligibleRoot(openContext, record, config.eligibleTimeoutMs ?? 7_200_000);
    },
    prepareOpen: prepare,
    submitOpen: submit,
    open,
    session,
    status: async (batchId) => {
      const record = await load(batchId);
      if (record.session !== null) return (await session(batchId)).status();
      const request = buildStatusRequest(
        { deploymentId: deployment.deployment_id, gatewayId: deployment.gateway_id, batchId },
        keyOf(record),
        random,
      );
      return gateway.status(request, batchId);
    },
    rpc: async (method, params, options) => {
      const units = checked.priceTable.units[method];
      if (units === undefined) throw new SdkError("method_not_priced", `the price table has no price for ${method}`);
      return (await current(units)).rpc(method, params, options ?? {});
    },
    rotate: async () => {
      const records = await readBatches(store);
      const active = records.find((record) => !record.retired && record.session !== null);
      if (active === undefined) return null;
      await store.write(batchKey(active.batch_id), { ...active, retired: true });
      sessions.delete(active.batch_id);
      return active.batch_id;
    },
    resumePending: async () => {
      const outcomes: RpcOutcome[] = [];
      for (const record of await readBatches(store)) {
        if (record.pending === null || record.session === null) continue;
        const outcome = await (await session(record.batch_id)).resume();
        if (outcome !== null) outcomes.push(outcome);
      }
      return outcomes;
    },
    exportBackup: async () => encodeBackup(deployment, await readBatches(store)),
  };
}

// Write the records of a backup into a storage. The storage must be empty or belong to the
// same deployment. Existing batches are not replaced.
export async function importBackup(
  storage: StorageAdapter,
  passphrase: string,
  text: string,
  options: { readonly kdfIterations?: number; readonly random?: RandomSource } = {},
): Promise<number> {
  const backup = decodeBackup(text);
  const store = await openEncryptedStore(storage, {
    passphrase,
    ...(options.kdfIterations === undefined ? {} : { iterations: options.kdfIterations }),
    ...(options.random === undefined ? {} : { random: options.random }),
  });
  const stored = await store.read(DEPLOYMENT_KEY, deploymentRecordSchema);
  if (stored !== undefined && stored.deployment_id !== backup.deployment.deployment_id) {
    throw new SdkError("deployment_mismatch", "the storage belongs to a different deployment");
  }
  if (stored === undefined) await store.write(DEPLOYMENT_KEY, backup.deployment);
  let added = 0;
  for (const record of backup.batches) {
    if ((await store.read(batchKey(record.batch_id), batchRecordSchema)) !== undefined) continue;
    await store.write(batchKey(record.batch_id), record);
    added += 1;
  }
  return added;
}

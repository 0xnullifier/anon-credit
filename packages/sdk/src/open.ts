// Open a batch: wait for an eligible root and the first-use delay, fetch and check the
// membership path, build the circuit inputs, prove, sign the open message, and post it.
// Through Nox (or for a request above transport.maxBodyBytes) the proof goes in chunks first;
// see upload.ts.

import {
  PUBLIC_INPUT_COUNT,
  batchOpenPublicInputs,
  buildBatchOpenWitness,
  fieldFromHex,
  fieldToHex,
  witnessPublicInputs,
  witnessToJson,
} from "@anon-credit/crypto";
import type { Transport } from "@anon-credit/anon-transport";
import {
  PROTOCOL_VERSION,
  decodeBase64,
  decodeFixedHex,
  encodeBase64,
  inlineOpenRequestSchema,
  openMessageDigest,
  uploadOpenRequestSchema,
  type AcceptedRoot,
  type InlineOpenRequest,
  type OpenRequest,
  type OpenResponse,
  type PriceTable,
} from "@anon-credit/protocol";
import { batchOpenInputsSchema, type BatchOpenInputs, type ProofResult } from "@anon-credit/prover";
import { SdkError } from "./errors.ts";
import type { GatewayClient } from "./gateway.ts";
import { signDigest, type SessionKey } from "./keys.ts";
import { epochAt, type Clock } from "./random.ts";
import { expectedLeaf, registryIsolationKey, type RegistryClient } from "./registry.ts";
import { batchKey, type BatchRecord, type DeploymentRecord, type LeafRecord } from "./state.ts";
import type { EncryptedStore } from "./storage.ts";
import { encodeProof, planUpload, sendChunks, type OpenUploadMode, type UploadPolicy, type UploadStats } from "./upload.ts";

// The part of the ProveKit prover that the SDK uses. BatchOpenProver from @anon-credit/prover
// has this shape. Tests give a fake.
export interface ProverLike {
  readonly prove: (inputs: BatchOpenInputs) => Promise<ProofResult>;
}

export interface OpenProgress {
  readonly batchId: string;
  // "delay": waiting for eligible_epoch + delay. "root": waiting for an accepted root.
  readonly phase: "delay" | "root";
  readonly currentEpoch: bigint;
  readonly targetEpoch: bigint;
}

export interface OpenContext {
  readonly store: EncryptedStore;
  readonly gateway: GatewayClient;
  readonly registry: RegistryClient;
  readonly deployment: DeploymentRecord;
  readonly prover: ProverLike;
  readonly clock: Clock;
  readonly priceTable: PriceTable;
  readonly priceTableHash: string;
  // Time between eligibility checks, in milliseconds.
  readonly pollMs: number;
  // The transport kind and body limit decide between an inline and a chunked proof.
  readonly transport: Pick<Transport, "kind" | "maxBodyBytes">;
  // Default upload mode of submitOpen.
  readonly openUpload: OpenUploadMode;
  // Chunk concurrency and retries. After a sequential fallback, later uploads of this client
  // use one chunk at a time (`parallel` becomes 1).
  readonly uploadPolicy: { policy: UploadPolicy };
  // Raw bytes of one chunk: the gateway chunk size of GET /v1/config, not above
  // transport.maxBodyBytes (uploadChunkBytes).
  readonly chunkBytes: number;
  readonly onProgress?: (progress: OpenProgress) => void;
}

export interface SelectedRoot {
  readonly root: string;
  readonly leafCount: number;
  readonly sourceEpoch: bigint;
}

export function requireLeaf(record: BatchRecord): LeafRecord {
  if (record.leaf === null) throw new SdkError("batch_not_issued", `batch ${record.batch_id} has no issued leaf`);
  return record.leaf;
}

// The epoch from which the client may open the batch: eligible_epoch + random delay.
export function openEpoch(record: BatchRecord): bigint {
  return BigInt(requireLeaf(record).eligible_epoch) + BigInt(record.delay_epochs);
}

// The newest gateway root that the issuer also reports as finalized, whose source epoch is at
// least the eligible epoch, and that has the leaf.
export function selectRoot(
  accepted: readonly AcceptedRoot[],
  finalized: readonly { readonly epoch: string; readonly root: string; readonly leaf_count: number }[],
  leaf: LeafRecord,
): SelectedRoot | null {
  const eligible = BigInt(leaf.eligible_epoch);
  const sorted = [...accepted].sort((a, b) => Number(BigInt(b.source_epoch) - BigInt(a.source_epoch)));
  for (const record of sorted) {
    if (BigInt(record.source_epoch) < eligible || record.leaf_count <= leaf.leaf_index) continue;
    const issuer = finalized.find((item) => item.epoch === record.source_epoch);
    if (issuer === undefined || issuer.root !== record.root || issuer.leaf_count !== record.leaf_count) continue;
    return { root: record.root, leafCount: record.leaf_count, sourceEpoch: BigInt(record.source_epoch) };
  }
  return null;
}

// Wait until the first-use delay passes and the gateway accepts a root with the leaf.
export async function waitForEligibleRoot(context: OpenContext, record: BatchRecord, timeoutMs: number): Promise<SelectedRoot> {
  const leaf = requireLeaf(record);
  const target = openEpoch(record);
  const deadline = context.clock.nowMs() + timeoutMs;
  for (;;) {
    const current = epochAt(context.clock.nowMs(), context.deployment.epoch_seconds);
    if (current >= target) {
      const accepted = await context.gateway.roots(record.batch_id);
      const finalized = await context.registry.finalizedRoots(registryIsolationKey(record.batch_id));
      const selected = selectRoot(accepted.roots, finalized, leaf);
      if (selected !== null) return selected;
    }
    context.onProgress?.({ batchId: record.batch_id, phase: current >= target ? "root" : "delay", currentEpoch: current, targetEpoch: target });
    if (context.clock.nowMs() >= deadline) {
      throw new SdkError("timeout", `no eligible root for batch ${record.batch_id} before the timeout`);
    }
    await context.clock.sleep(context.pollMs);
  }
}

export interface PreparedOpen {
  readonly request: InlineOpenRequest;
  readonly root: SelectedRoot;
  // Public inputs in circuit order. The gateway builds the same vector.
  readonly publicInputs: readonly string[];
  readonly proofBytes: number;
  readonly proveMs: number;
  readonly witnessMs: number;
  readonly wasmMemoryBytes: number | null;
}

// Fetch the path, check it, prove, and sign. The request is stored, so an exact retry after a
// restart sends the same signed request.
export async function prepareOpen(
  context: OpenContext,
  record: BatchRecord,
  key: SessionKey,
  root: SelectedRoot,
): Promise<PreparedOpen> {
  const leaf = requireLeaf(record);
  const deploymentId = decodeFixedHex(context.deployment.deployment_id, 32);
  const gatewayId = decodeFixedHex(context.deployment.gateway_id, 32);
  const expiry = BigInt(leaf.expiry);
  const leafValue = expectedLeaf(record.commitment, expiry);
  if (leafValue !== leaf.leaf) throw new SdkError("proof_check_failed", "the issued leaf is not H(DOM_LEAF, c, K, expiry)");
  const path = await context.registry.path(leaf.leaf_index, root.root, leafValue, registryIsolationKey(record.batch_id));
  if (path.proof.leafCount !== root.leafCount) throw new SdkError("proof_check_failed", "the path leaf count is not the root leaf count");

  const proofEpoch = epochAt(context.clock.nowMs(), context.deployment.epoch_seconds);
  const witness = buildBatchOpenWitness(
    { deploymentId, gatewayId, k: decodeFixedHex(record.k, 32), sessionPub: key.publicKey, expiry, proofEpoch },
    fieldFromHex(root.root),
    path.proof,
  );
  // The public inputs that the gateway builds must equal the witness public inputs.
  const expected = batchOpenPublicInputs({
    deploymentId,
    gatewayId,
    root: fieldFromHex(root.root),
    leafCount: root.leafCount,
    proofEpoch,
    batchId: fieldFromHex(record.batch_id),
    sessionPub: key.publicKey,
  });
  const actual = witnessPublicInputs(witness);
  if (expected.length !== PUBLIC_INPUT_COUNT || expected.some((value, index) => value !== actual[index])) {
    throw new SdkError("proof_check_failed", "the witness public inputs are not the gateway public inputs");
  }
  const inputs = batchOpenInputsSchema.parse(witnessToJson(witness));
  const result = await context.prover.prove(inputs);

  const message = {
    deploymentId,
    gatewayId,
    batchId: decodeFixedHex(record.batch_id, 32),
    root: decodeFixedHex(root.root, 32),
    leafCount: root.leafCount,
    proofEpoch,
    sessionPub: key.publicKey,
    priceTableHash: decodeFixedHex(context.priceTableHash, 32),
  };
  const request = inlineOpenRequestSchema.parse({
    protocol_version: PROTOCOL_VERSION,
    deployment_id: context.deployment.deployment_id,
    gateway_id: context.deployment.gateway_id,
    batch_id: record.batch_id,
    root: root.root,
    leaf_count: root.leafCount,
    proof_epoch: proofEpoch.toString(10),
    session_pub: record.session_pub,
    price_table_hash: context.priceTableHash,
    proof: encodeBase64(result.proof),
    signature: encodeBase64(signDigest(key, openMessageDigest(message))),
  });
  await context.store.write(batchKey(record.batch_id), { ...record, open_request: request });
  return {
    request,
    root,
    publicInputs: expected.map(fieldToHex),
    proofBytes: result.proof.byteLength,
    proveMs: result.durationMs,
    witnessMs: result.witnessMs,
    wasmMemoryBytes: result.wasmMemoryBytes,
  };
}

export interface SubmitOpenOptions {
  // Override the upload mode of the context for this request.
  readonly upload?: OpenUploadMode;
}

export interface SubmitOpenResult {
  readonly response: OpenResponse;
  readonly record: BatchRecord;
  // Measurements of the chunked upload, or null for an inline proof.
  readonly upload: UploadStats | null;
}

// true if the proof must go in chunks.
export function useChunkedUpload(mode: OpenUploadMode, transport: Pick<Transport, "kind" | "maxBodyBytes">, request: InlineOpenRequest): boolean {
  switch (mode) {
    case "chunked":
      return true;
    case "inline":
      return false;
    case "auto":
      // The request is ASCII JSON, so the string length is the body size.
      return transport.kind === "anon" || JSON.stringify(request).length > transport.maxBodyBytes;
  }
}

// Upload the proof of `request` in chunks on the batch isolation key. Return the open request
// with proof_upload in place of proof, and the measurements.
async function uploadProof(context: OpenContext, batchId: string, request: InlineOpenRequest): Promise<{ readonly wire: OpenRequest; readonly stats: UploadStats }> {
  const proof = decodeBase64(request.proof);
  const plan = planUpload(batchId, await encodeProof(proof), context.chunkBytes);
  const { proof: _inline, ...fields } = request;
  const wire = uploadOpenRequestSchema.parse({ ...fields, proof_upload: plan.reference });
  const holder = context.uploadPolicy;
  const stats = await sendChunks(
    plan,
    holder.policy,
    {
      send: (chunk) => context.gateway.openChunk(chunk, batchId),
      sleep: (ms) => context.clock.sleep(ms),
      now: () => performance.now(),
    },
    proof.byteLength,
  );
  if (stats.fellBack) holder.policy = { ...holder.policy, parallel: 1 };
  return { wire, stats };
}

// Post the open request. On success, store the session with the frozen price table.
// existing is true for an exact retry; the units and the sequence are not reset. An exact
// retry with a chunked proof sends the chunks again: the gateway deleted the upload.
export async function submitOpen(
  context: OpenContext,
  record: BatchRecord,
  request: InlineOpenRequest,
  options: SubmitOpenOptions = {},
): Promise<SubmitOpenResult> {
  let response: OpenResponse;
  let upload: UploadStats | null = null;
  switch (useChunkedUpload(options.upload ?? context.openUpload, context.transport, request)) {
    case true: {
      const uploaded = await uploadProof(context, record.batch_id, request);
      upload = uploaded.stats;
      response = await context.gateway.open(uploaded.wire, record.batch_id);
      break;
    }
    case false:
      response = await context.gateway.open(request, record.batch_id);
      break;
  }
  const session = response.session;
  if (session.batch_id !== record.batch_id || session.session_pub !== record.session_pub) {
    throw new SdkError("invalid_response", "the open response is for a different batch or session key");
  }
  if (session.price_table_hash !== context.priceTableHash) {
    throw new SdkError("invalid_response", "the session froze a different price table");
  }
  const updated: BatchRecord = {
    ...record,
    open_request: request,
    session: {
      remaining: session.remaining,
      units_total: session.units_total,
      next_seq: session.next_seq,
      state: session.state,
      open_epoch: session.open_epoch,
      deadline_epoch: session.deadline_epoch,
      price_table_hash: session.price_table_hash,
      price_table: context.priceTable,
    },
  };
  await context.store.write(batchKey(record.batch_id), updated);
  return { response, record: updated, upload };
}

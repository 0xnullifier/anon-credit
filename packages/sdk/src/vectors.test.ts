// Cross-language vectors: the SDK signs the shared open, status, and spend vectors with the
// RFC 8032 test key and gets the fixture signatures. The SDK open path builds the exact gate
// witness and the public-input vector of the order contract.

import { commitment, fieldFromHex, fieldToHex, peakHeightOf, peakHeights } from "@anon-credit/crypto";
import {
  INITIAL_PRICE_TABLE,
  decodeFixedHex,
  encodeBase64,
  encodeHex,
  openMessageDigest,
  priceTableHash,
} from "@anon-credit/protocol";
import type { BatchOpenInputs } from "@anon-credit/prover";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import gateWitness from "../../../artifacts/batch-open/gate-witness.json" with { type: "json" };
import publicInputsContract from "../../../fixtures/protocol/batch-open-public-inputs.json" with { type: "json" };
import openFixture from "../../../fixtures/protocol/open-message.json" with { type: "json" };
import spendFixture from "../../../fixtures/protocol/spend-message.json" with { type: "json" };
import statusFixture from "../../../fixtures/protocol/status-message.json" with { type: "json" };
import { buildStatusRequest } from "./gateway.ts";
import { sessionKeyFromSecret, signDigest } from "./keys.ts";
import { prepareOpen, type OpenContext } from "./open.ts";
import { expectedLeaf, verifyPath, type RegistryClient } from "./registry.ts";
import { signSpend } from "./spend.ts";
import type { BatchRecord, DeploymentRecord } from "./state.ts";
import { DEFAULT_UPLOAD_POLICY } from "./upload.ts";
import { memoryStorage, openEncryptedStore } from "./storage.ts";
import { fakeProver, manualClock } from "./test-support/client.ts";

const keySchema = z.object({ test_signing_key: z.object({ seed: z.string(), public_key: z.string() }) });
const seed = keySchema.parse(spendFixture).test_signing_key.seed;
const key = sessionKeyFromSecret(decodeFixedHex(seed, 32));

function hexToBase64(text: string): string {
  return encodeBase64(Uint8Array.from((text.slice(2).match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16))));
}

describe("signing vectors with the RFC 8032 test key", () => {
  it("derives the fixture public key", () => {
    expect(encodeHex(key.publicKey)).toBe(keySchema.parse(spendFixture).test_signing_key.public_key);
  });

  it("signs the spend vectors", () => {
    const cases = z
      .array(
        z.object({
          input: z.object({
            batch_id: z.string(),
            deployment_id: z.string(),
            gateway_id: z.string(),
            price_table_hash: z.string(),
            rpc_bytes: z.string(),
            seq: z.string(),
            units_total: z.string(),
          }),
          expected: z.object({ signature: z.string() }),
        }),
      )
      .parse(spendFixture.cases);
    for (const vector of cases) {
      const signature = signSpend(
        {
          deploymentId: vector.input.deployment_id,
          gatewayId: vector.input.gateway_id,
          batchId: vector.input.batch_id,
          priceTableHash: vector.input.price_table_hash,
        },
        key,
        {
          seq: BigInt(vector.input.seq),
          unitsTotal: BigInt(vector.input.units_total),
          rpcBytes: Uint8Array.from((vector.input.rpc_bytes.slice(2).match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16))),
        },
      );
      expect(signature).toBe(hexToBase64(vector.expected.signature));
    }
  });

  it("signs the open vectors", () => {
    const cases = z
      .array(
        z.object({
          input: z.object({
            deployment_id: z.string(),
            gateway_id: z.string(),
            batch_id: z.string(),
            root: z.string(),
            leaf_count: z.number(),
            proof_epoch: z.string(),
            session_pub: z.string(),
            price_table_hash: z.string(),
          }),
          expected: z.object({ signature: z.string() }),
        }),
      )
      .parse(openFixture.cases);
    for (const vector of cases) {
      const digest = openMessageDigest({
        deploymentId: decodeFixedHex(vector.input.deployment_id, 32),
        gatewayId: decodeFixedHex(vector.input.gateway_id, 32),
        batchId: decodeFixedHex(vector.input.batch_id, 32),
        root: decodeFixedHex(vector.input.root, 32),
        leafCount: vector.input.leaf_count,
        proofEpoch: BigInt(vector.input.proof_epoch),
        sessionPub: decodeFixedHex(vector.input.session_pub, 32),
        priceTableHash: decodeFixedHex(vector.input.price_table_hash, 32),
      });
      expect(encodeHex(signDigest(key, digest))).toBe(vector.expected.signature);
    }
  });

  it("signs the status vectors with the fixture nonce", () => {
    const cases = z
      .array(
        z.object({
          input: z.object({ deployment_id: z.string(), gateway_id: z.string(), batch_id: z.string(), nonce: z.string() }),
          expected: z.object({ signature: z.string() }),
        }),
      )
      .parse(statusFixture.cases);
    for (const vector of cases) {
      const request = buildStatusRequest(
        { deploymentId: vector.input.deployment_id, gatewayId: vector.input.gateway_id, batchId: vector.input.batch_id },
        key,
        () => new Uint8Array(decodeFixedHex(vector.input.nonce, 32)),
      );
      expect(request.nonce).toBe(vector.input.nonce);
      expect(request.signature).toBe(hexToBase64(vector.expected.signature));
    }
  });
});

const witnessSchema = z.object({
  deployment_id: z.tuple([z.string(), z.string()]),
  gateway_id: z.tuple([z.string(), z.string()]),
  root: z.string(),
  leaf_count: z.number(),
  proof_epoch: z.string(),
  batch_id: z.string(),
  k: z.tuple([z.string(), z.string()]),
  expiry: z.string(),
  leaf_index: z.number(),
  siblings: z.array(z.string()),
  peaks: z.array(z.string()),
});

// 32 bytes from two 128-bit limbs.
function fromLimbs(limbs: readonly [string, string]): string {
  return `0x${BigInt(limbs[0]).toString(16).padStart(32, "0")}${BigInt(limbs[1]).toString(16).padStart(32, "0")}`;
}

describe("open path against the gate witness and the public-input order contract", () => {
  it("builds the exact gate witness and the contract public inputs", async () => {
    const witness = witnessSchema.parse(gateWitness);
    const contract = z.object({ gate_case: z.object({ public_inputs: z.array(z.string()) }) }).parse(publicInputsContract);
    const deploymentId = fromLimbs(witness.deployment_id);
    const gatewayId = fromLimbs(witness.gateway_id);
    const k = fromLimbs(witness.k);
    const c = fieldToHex(commitment(decodeFixedHex(deploymentId, 32), decodeFixedHex(k, 32)));
    const leafValue = expectedLeaf(c, BigInt(witness.expiry));
    const height = peakHeightOf(witness.leaf_index, witness.leaf_count) ?? 0;
    const heights = peakHeights(witness.leaf_count);
    const proofJson = {
      leaf_index: witness.leaf_index,
      leaf_count: witness.leaf_count,
      peak_position: heights.indexOf(height),
      siblings: witness.siblings.slice(0, height),
      peaks: heights.map((h) => witness.peaks[h] ?? ""),
    };
    const registry: RegistryClient = {
      config: () => Promise.reject(new Error("not used")),
      finalizedRoots: () => Promise.resolve([]),
      path: async (leafIndex, root, expected) =>
        verifyPath(witness.root, "1", leafValue, proofJson, { leafIndex, root, expectedLeaf: expected }),
    };
    const deployment: DeploymentRecord = {
      deployment_id: deploymentId,
      gateway_id: gatewayId,
      circuit_id: "0x00000000000000616e6f6e2d6372656469742f76312f62617463682d6f70656e",
      prover_manifest_hash: `0x${"00".repeat(32)}`,
      verifier_artifact_hash: `0x${"00".repeat(32)}`,
      payment_chain_id: 11_155_111,
      sale_address: `0x${"00".repeat(20)}`,
      root_registry_address: `0x${"00".repeat(20)}`,
      epoch_seconds: 30,
      batch_size: 100,
    };
    const seen: BatchOpenInputs[] = [];
    const store = await openEncryptedStore(memoryStorage(), { passphrase: "p", iterations: 1000 });
    const context: OpenContext = {
      store,
      gateway: {
        config: () => Promise.reject(new Error("not used")),
        prices: () => Promise.reject(new Error("not used")),
        roots: () => Promise.reject(new Error("not used")),
        open: () => Promise.reject(new Error("not used")),
        openChunk: () => Promise.reject(new Error("not used")),
        spend: () => Promise.reject(new Error("not used")),
        status: () => Promise.reject(new Error("not used")),
      },
      registry,
      deployment,
      prover: fakeProver(seen),
      clock: manualClock(Number(BigInt(witness.proof_epoch) * 30_000n)),
      priceTable: INITIAL_PRICE_TABLE,
      priceTableHash: encodeHex(priceTableHash(INITIAL_PRICE_TABLE)),
      pollMs: 1,
      transport: { kind: "direct", maxBodyBytes: Number.POSITIVE_INFINITY },
      openUpload: "auto",
      uploadPolicy: { policy: DEFAULT_UPLOAD_POLICY },
    };
    const record: BatchRecord = {
      order: 0,
      batch_id: witness.batch_id,
      commitment: c,
      k,
      session_secret: seed,
      session_pub: encodeHex(key.publicKey),
      delay_epochs: 0,
      leaf: {
        leaf_index: witness.leaf_index,
        leaf: leafValue,
        insertion_epoch: "0",
        eligible_epoch: "1",
        expiry: witness.expiry,
      },
      open_request: null,
      session: null,
      pending: null,
      retired: false,
    };
    const prepared = await prepareOpen(context, record, key, {
      root: witness.root,
      leafCount: witness.leaf_count,
      sourceEpoch: 1n,
    });
    expect(prepared.publicInputs).toEqual(contract.gate_case.public_inputs);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(gateWitness);
    expect(prepared.request.proof_epoch).toBe(witness.proof_epoch);
    expect(fieldFromHex(prepared.request.batch_id)).toBe(fieldFromHex(witness.batch_id));
  });
});

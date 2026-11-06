// Check the TypeScript public-input and witness construction against the Rust registry vectors.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { bytes32Schema, u64DecimalSchema } from "@anon-credit/protocol";
import fixtureJson from "../../../fixtures/protocol/batch-open.json" with { type: "json" };
import { batchId } from "./batch.ts";
import { fieldHexSchema, fieldToHex } from "./field.ts";
import { membershipProofSchema } from "./mmr.ts";
import { PUBLIC_INPUT_COUNT, PUBLIC_INPUT_NAMES, batchOpenPublicInputs } from "./public-inputs.ts";
import { WitnessError, buildBatchOpenWitness, witnessPublicInputs, witnessToJson } from "./witness.ts";

const caseSchema = z.strictObject({
  name: z.string(),
  input: z.strictObject({
    deployment_id: bytes32Schema,
    gateway_id: bytes32Schema,
    k: bytes32Schema,
    session_pub: bytes32Schema,
    expiry: u64DecimalSchema,
    proof_epoch: u64DecimalSchema,
  }),
  leaf: fieldHexSchema,
  root: fieldHexSchema,
  proof: membershipProofSchema,
  public_inputs: z.array(z.string()).length(PUBLIC_INPUT_COUNT),
  // Compared as JSON text with the TypeScript output.
  witness: z.record(z.string(), z.json()),
});

const fixture = z.strictObject({ description: z.string(), cases: z.array(caseSchema).min(1) }).parse(fixtureJson);

describe("batch-open public inputs and witness", () => {
  for (const entry of fixture.cases) {
    const secrets = {
      deploymentId: entry.input.deployment_id,
      gatewayId: entry.input.gateway_id,
      k: entry.input.k,
      sessionPub: entry.input.session_pub,
      expiry: entry.input.expiry,
      proofEpoch: entry.input.proof_epoch,
    };

    it(`gateway public inputs match ${entry.name}`, () => {
      const inputs = batchOpenPublicInputs({
        deploymentId: secrets.deploymentId,
        gatewayId: secrets.gatewayId,
        root: entry.root,
        leafCount: entry.proof.leafCount,
        proofEpoch: secrets.proofEpoch,
        batchId: batchId(secrets.deploymentId, secrets.k),
        sessionPub: secrets.sessionPub,
      });
      expect(inputs.map(fieldToHex)).toEqual(entry.public_inputs);
    });

    it(`witness matches ${entry.name}`, () => {
      const witness = buildBatchOpenWitness(secrets, entry.root, entry.proof);
      expect(JSON.stringify(witnessToJson(witness))).toBe(JSON.stringify(entry.witness));
      expect(witnessPublicInputs(witness).map(fieldToHex)).toEqual(entry.public_inputs);
    });
  }

  const first = fixture.cases[0];
  it("rejects an expired batch", () => {
    if (first === undefined) {
      throw new RangeError("fixture has no cases");
    }
    const secrets = {
      deploymentId: first.input.deployment_id,
      gatewayId: first.input.gateway_id,
      k: first.input.k,
      sessionPub: first.input.session_pub,
      expiry: first.input.expiry,
      proofEpoch: first.input.expiry + 1n,
    };
    expect(() => buildBatchOpenWitness(secrets, first.root, first.proof)).toThrow(WitnessError);
  });

  it("rejects a secret of another batch", () => {
    if (first === undefined) {
      throw new RangeError("fixture has no cases");
    }
    const secrets = {
      deploymentId: first.input.deployment_id,
      gatewayId: first.input.gateway_id,
      k: new Uint8Array(32).fill(7),
      sessionPub: first.input.session_pub,
      expiry: first.input.expiry,
      proofEpoch: first.input.proof_epoch,
    };
    expect(() => buildBatchOpenWitness(secrets, first.root, first.proof)).toThrow(WitnessError);
  });
});

describe("public input layout", () => {
  it("has one name for each public input", () => {
    expect(PUBLIC_INPUT_NAMES.length).toBe(PUBLIC_INPUT_COUNT);
  });
});

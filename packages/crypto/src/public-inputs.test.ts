// Check the batch-open public-input order against the contract file
// fixtures/protocol/batch-open-public-inputs.json. The SDK (phase 4) builds the verifier input
// with batchOpenPublicInputs. These tests make sure that the vector has the order and the
// values of the contract.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { bytes32Schema, u64DecimalSchema } from "@anon-credit/protocol";
import contractJson from "../../../fixtures/protocol/batch-open-public-inputs.json" with { type: "json" };
import { CIRCUIT_ID } from "./constants.generated.ts";
import { fieldHexSchema, fieldToHex } from "./field.ts";
import { PUBLIC_INPUT_COUNT, PUBLIC_INPUT_NAMES, batchOpenPublicInputs } from "./public-inputs.ts";

const contractSchema = z.strictObject({
  description: z.string(),
  circuit: z.literal("circuits/batch-open"),
  encoding: z.string(),
  count: z.number().int(),
  order: z.array(
    z.strictObject({
      index: z.number().int().nonnegative(),
      name: z.string(),
      noir_parameter: z.string(),
      source: z.string(),
    }),
  ),
  circuit_id: fieldHexSchema,
  gate_case: z.strictObject({
    name: z.string(),
    input: z.strictObject({
      deployment_id: bytes32Schema,
      gateway_id: bytes32Schema,
      session_pub: bytes32Schema,
      root: fieldHexSchema,
      leaf_count: z.number().int().nonnegative(),
      proof_epoch: u64DecimalSchema,
      batch_id: fieldHexSchema,
    }),
    public_inputs: z.array(z.string()),
  }),
});

const contract = contractSchema.parse(contractJson);

describe("batch-open public-input contract", () => {
  it("has the names and the count of the contract", () => {
    expect(contract.count).toBe(PUBLIC_INPUT_COUNT);
    expect(contract.order.map((entry) => entry.index)).toEqual([...Array(PUBLIC_INPUT_COUNT).keys()]);
    expect(contract.order.map((entry) => entry.name)).toEqual(PUBLIC_INPUT_NAMES);
  });

  it("has the circuit id of the contract", () => {
    expect(contract.circuit_id).toBe(CIRCUIT_ID);
  });

  it("builds the vector of the contract", () => {
    const input = contract.gate_case.input;
    const vector = batchOpenPublicInputs({
      deploymentId: input.deployment_id,
      gatewayId: input.gateway_id,
      root: input.root,
      leafCount: input.leaf_count,
      proofEpoch: input.proof_epoch,
      batchId: input.batch_id,
      sessionPub: input.session_pub,
    });
    expect(vector.map(fieldToHex)).toEqual(contract.gate_case.public_inputs);
  });
});

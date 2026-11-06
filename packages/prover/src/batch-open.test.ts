// Check the batch-open ABI and input schema against the compiled circuit and the shared
// witnesses.

import type { AbiParameter, AbiType } from "@noir-lang/noirc_abi";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import abiJson from "../../../artifacts/batch-open/abi.json" with { type: "json" };
import gateWitnessJson from "../../../artifacts/batch-open/gate-witness.json" with { type: "json" };
import batchOpenJson from "../../../fixtures/protocol/batch-open.json" with { type: "json" };
import { batchOpenInputsSchema, checkBatchOpenAbi } from "./batch-open.ts";
import { ProverError } from "./errors.ts";
import { parseCircuit } from "./inputs.ts";

// The compiled ABI (nargo 1.0.0-beta.26), in the form that the worker reads from the prover key.
const abi = parseCircuit(JSON.stringify({ abi: abiJson, bytecode: "AA==" })).abi;

const witnessCases = z
  .object({ cases: z.array(z.object({ name: z.string(), witness: z.record(z.string(), z.json()) })) })
  .parse(batchOpenJson).cases;

function expectMismatch(run: () => void): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ProverError);
    expect(error instanceof ProverError ? error.code : "").toBe("circuit_mismatch");
    return;
  }
  throw new Error("expected circuit_mismatch");
}

describe("batch-open ABI", () => {
  it("accepts the compiled circuit ABI", () => {
    expect(() => checkBatchOpenAbi(abi)).not.toThrow();
  });

  it("rejects two parameters in a different order", () => {
    const [first, second, ...rest] = abi.parameters;
    if (first === undefined || second === undefined) throw new Error("ABI has fewer than two parameters");
    expectMismatch(() => checkBatchOpenAbi({ ...abi, parameters: [second, first, ...rest] }));
  });

  it("rejects a private input that became public", () => {
    const parameters = abi.parameters.map((parameter): AbiParameter => {
      switch (parameter.name) {
        case "k":
          return { ...parameter, visibility: "public" };
        default:
          return parameter;
      }
    });
    expectMismatch(() => checkBatchOpenAbi({ ...abi, parameters }));
  });

  it("rejects a shorter sibling array", () => {
    const short: AbiType = { kind: "array", length: 24, type: { kind: "field" } };
    const parameters = abi.parameters.map((parameter): AbiParameter => {
      switch (parameter.name) {
        case "siblings":
          return { ...parameter, type: short };
        default:
          return parameter;
      }
    });
    expectMismatch(() => checkBatchOpenAbi({ ...abi, parameters }));
  });
});

describe("batch-open inputs", () => {
  it("accepts the gate witness", () => {
    expect(batchOpenInputsSchema.parse(gateWitnessJson)).toEqual(gateWitnessJson);
  });

  for (const entry of witnessCases) {
    it(`accepts the registry witness ${entry.name}`, () => {
      expect(batchOpenInputsSchema.safeParse(entry.witness).success).toBe(true);
    });
  }

  const gate = batchOpenInputsSchema.parse(gateWitnessJson);
  const limit = `0x${"0".repeat(31)}1${"0".repeat(32)}`;
  const rejected: [string, object][] = [
    ["a limb of 129 bits", { ...gate, k: [limit, gate.k[1]] }],
    ["uppercase hex", { ...gate, root: gate.root.toUpperCase().replace("0X", "0x") }],
    ["a short field value", { ...gate, root: "0x01" }],
    ["the field modulus", { ...gate, batch_id: "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001" }],
    ["another circuit id", { ...gate, circuit_id: gate.root }],
    ["31 siblings", { ...gate, siblings: gate.siblings.slice(1) }],
    ["a leaf count above 2^32 - 1", { ...gate, leaf_count: 2 ** 32 }],
    ["a non-canonical epoch", { ...gate, proof_epoch: `0${gate.proof_epoch}` }],
    ["an epoch of 2^64", { ...gate, expiry: (2n ** 64n).toString() }],
    ["an unknown field", { ...gate, extra: "1" }],
  ];
  for (const [name, value] of rejected) {
    it(`rejects ${name}`, () => {
      expect(batchOpenInputsSchema.safeParse(value).success).toBe(false);
    });
  }

  it("rejects a missing input", () => {
    const { session_pub: _omitted, ...rest } = gate;
    expect(batchOpenInputsSchema.safeParse(rest).success).toBe(false);
  });
});

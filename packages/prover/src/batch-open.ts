// The batch-open circuit (circuits/batch-open) as the prover sees it: the expected Noir ABI and
// a runtime schema of its inputs.
//
// The worker checks the ABI of the prover key against BATCH_OPEN_ABI_PARAMETERS before it
// accepts a "batch_open" manifest. Thus a client cannot prove a different statement under a
// manifest that says "batch_open". The SDK validates the inputs with batchOpenInputsSchema
// before it sends them to the worker.

import type { Abi, AbiType } from "@noir-lang/noirc_abi";
import { CIRCUIT_ID, FIELD_MODULUS, MAX_HEIGHT, MAX_LEAVES, MAX_PEAKS } from "@anon-credit/crypto";
import { z } from "zod";
import { ProverError } from "./errors.ts";

// The manifest `circuit` value of the batch-open circuit (the Noir package name).
export const BATCH_OPEN_CIRCUIT = "batch_open";

// Number of public field elements: circuit_id, deployment_id[2], gateway_id[2], root,
// leaf_count, proof_epoch, batch_id, binding. fixtures/protocol/batch-open-public-inputs.json
// is the order contract.
export const BATCH_OPEN_PUBLIC_INPUT_COUNT = 10;

type Visibility = "public" | "private";

interface ExpectedParameter {
  readonly name: string;
  readonly type: string;
  readonly visibility: Visibility;
}

const FIELD = "field";
const U64 = "u64";
const limbs = "[field; 2]";

// The parameters of main in circuits/batch-open/src/main.nr, in order.
export const BATCH_OPEN_ABI_PARAMETERS: readonly ExpectedParameter[] = [
  { name: "circuit_id", type: FIELD, visibility: "public" },
  { name: "deployment_id", type: limbs, visibility: "public" },
  { name: "gateway_id", type: limbs, visibility: "public" },
  { name: "root", type: FIELD, visibility: "public" },
  { name: "leaf_count", type: FIELD, visibility: "public" },
  { name: "proof_epoch", type: U64, visibility: "public" },
  { name: "batch_id", type: FIELD, visibility: "public" },
  { name: "binding", type: FIELD, visibility: "public" },
  { name: "k", type: limbs, visibility: "private" },
  { name: "expiry", type: U64, visibility: "private" },
  { name: "leaf_index", type: FIELD, visibility: "private" },
  { name: "siblings", type: `[field; ${MAX_HEIGHT}]`, visibility: "private" },
  { name: "peaks", type: `[field; ${MAX_PEAKS}]`, visibility: "private" },
  { name: "session_pub", type: limbs, visibility: "private" },
];

// A short text form of an ABI type, for example "field", "u64", or "[field; 32]".
export function abiTypeText(type: AbiType): string {
  switch (type.kind) {
    case "field":
      return "field";
    case "boolean":
      return "bool";
    case "string":
      return `str<${type.length}>`;
    case "integer":
      return `${type.sign === "unsigned" ? "u" : "i"}${type.width}`;
    case "array":
      return `[${abiTypeText(type.type)}; ${type.length}]`;
    case "tuple":
      return `(${type.fields.map(abiTypeText).join(", ")})`;
    case "struct":
      return `${type.path} { ${type.fields.map((field) => `${field.name}: ${abiTypeText(field.type)}`).join(", ")} }`;
  }
}

// Throw circuit_mismatch if the ABI is not the batch-open ABI.
export function checkBatchOpenAbi(abi: Abi): void {
  const actual = abi.parameters.map((parameter) => ({
    name: parameter.name,
    type: abiTypeText(parameter.type),
    visibility: parameter.visibility,
  }));
  const expected = BATCH_OPEN_ABI_PARAMETERS.map((parameter) => `${parameter.visibility} ${parameter.name}: ${parameter.type}`);
  const found = actual.map((parameter) => `${parameter.visibility} ${parameter.name}: ${parameter.type}`);
  if (abi.return_type !== null || JSON.stringify(found) !== JSON.stringify(expected)) {
    throw new ProverError(
      "circuit_mismatch",
      `the prover key is not the batch-open circuit: found (${found.join(", ")}), expected (${expected.join(", ")})`,
    );
  }
}

const LIMB_BOUND = 1n << 128n;
const U64_BOUND = 1n << 64n;

// A canonical field value: 0x and 64 lowercase hex digits, less than the field modulus.
const fieldHexSchema = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/, "expected 0x and 64 lowercase hex digits")
  .refine((text) => BigInt(text) < FIELD_MODULUS, "value is not less than the field modulus");

// A 128-bit limb in the field form.
const limbHexSchema = fieldHexSchema.refine((text) => BigInt(text) < LIMB_BOUND, "limb is not less than 2^128");

const limbsSchema = z.tuple([limbHexSchema, limbHexSchema]);

const u32Schema = z.number().int().min(0).max(MAX_LEAVES);

// A u64 as a canonical decimal string.
const u64DecimalSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, "expected a canonical decimal integer")
  .refine((text) => BigInt(text) < U64_BOUND, "value is not less than 2^64");

const circuitIdHex = `0x${CIRCUIT_ID.toString(16).padStart(64, "0")}`;

// The inputs of the batch-open circuit by ABI name. This is the JSON form of
// anon_credit_registry::BatchOpenWitness and of witnessToJson in @anon-credit/crypto.
export const batchOpenInputsSchema = z.strictObject({
  circuit_id: z.literal(circuitIdHex),
  deployment_id: limbsSchema,
  gateway_id: limbsSchema,
  root: fieldHexSchema,
  leaf_count: u32Schema,
  proof_epoch: u64DecimalSchema,
  batch_id: fieldHexSchema,
  binding: fieldHexSchema,
  k: limbsSchema,
  expiry: u64DecimalSchema,
  leaf_index: u32Schema,
  siblings: z.array(fieldHexSchema).length(MAX_HEIGHT),
  peaks: z.array(fieldHexSchema).length(MAX_PEAKS),
  session_pub: limbsSchema,
});

export type BatchOpenInputs = z.infer<typeof batchOpenInputsSchema>;

// Circuit inputs in the Noir ABI form, and the circuit description from the ProveKit prover key.

import type { Abi, AbiType, InputMap, InputValue } from "@noir-lang/noirc_abi";
import type { CompiledCircuit } from "@noir-lang/noir_js";
import { z } from "zod";

// One Noir input value: a field as a decimal or 0x-hex string, a number, a boolean,
// an array, or a struct.
export const inputValueSchema: z.ZodType<InputValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.array(inputValueSchema), z.record(z.string(), inputValueSchema)]),
);

// The inputs of a circuit, by parameter name.
export const inputMapSchema: z.ZodType<InputMap> = z.record(z.string(), inputValueSchema);

const visibilitySchema = z.enum(["public", "private", "databus"]);

const abiTypeSchema: z.ZodType<AbiType> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("field") }),
    z.object({ kind: z.literal("boolean") }),
    z.object({ kind: z.literal("string"), length: z.number().int() }),
    z.object({ kind: z.literal("integer"), sign: z.enum(["unsigned", "signed"]), width: z.number().int() }),
    z.object({ kind: z.literal("array"), length: z.number().int(), type: abiTypeSchema }),
    z.object({ kind: z.literal("tuple"), fields: z.array(abiTypeSchema) }),
    z.object({
      kind: z.literal("struct"),
      path: z.string(),
      fields: z.array(z.object({ name: z.string(), type: abiTypeSchema })),
    }),
  ]),
);

const abiErrorTypeSchema = z.union([
  z.object({ error_kind: z.literal("string"), string: z.string() }),
  z.object({ error_kind: z.literal("fmtstring"), length: z.number().int(), item_types: z.array(abiTypeSchema) }),
  z.intersection(z.object({ error_kind: z.literal("custom") }), abiTypeSchema),
]);

const abiSchema: z.ZodType<Abi> = z.object({
  parameters: z.array(z.object({ name: z.string(), type: abiTypeSchema, visibility: visibilitySchema })),
  return_type: z.object({ abi_type: abiTypeSchema, visibility: visibilitySchema }).nullable(),
  error_types: z.record(z.string(), abiErrorTypeSchema),
});

// The JSON that `Prover.getCircuit()` returns: the ABI and the base64 ACIR program.
const provekitCircuitSchema = z.object({ abi: abiSchema, bytecode: z.string().min(1) });

// Parse the circuit JSON from the ProveKit prover key into the form that noir_js uses.
export function parseCircuit(json: string): CompiledCircuit {
  const circuit = provekitCircuitSchema.parse(JSON.parse(json));
  return { abi: circuit.abi, bytecode: circuit.bytecode, debug_symbols: "", file_map: {} };
}

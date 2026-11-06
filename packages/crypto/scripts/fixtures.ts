// Runtime schemas of the shared JSON fixtures that hold the circuit constants.
// fixtures/protocol/domains.json and fixtures/protocol/poseidon2-params.json are the only
// source of these values. The generator and the tests read them through these schemas.

import { z } from "zod";

const FIELD_HEX = /^0x[0-9a-f]{64}$/;

export const fieldHexText = z.string().regex(FIELD_HEX, "expected 0x and 64 lowercase hex digits");

export const domainsSchema = z.strictObject({
  description: z.string(),
  field_modulus: fieldHexText,
  tags: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[a-z][a-z0-9_]*$/),
        text: z.string().regex(/^[\x21-\x7e]{1,27}$/),
        value: fieldHexText,
        use: z.string(),
      }),
    )
    .min(1),
  circuit_id: z.strictObject({
    text: z.string().regex(/^[\x21-\x7e]{1,31}$/),
    value: fieldHexText,
    use: z.string(),
  }),
  constants: z.strictObject({
    batch_units_k: z.number().int().positive(),
    max_height: z.literal(32),
    max_peaks: z.literal(32),
    max_leaves: z.literal(4294967295),
  }),
});

export type Domains = z.infer<typeof domainsSchema>;

export const poseidon2ParamsSchema = z.strictObject({
  description: z.string(),
  source: z.string(),
  field_modulus: fieldHexText,
  t: z.literal(4),
  rate: z.literal(3),
  sbox_degree: z.literal(5),
  rounds_f: z.literal(8),
  rounds_p: z.literal(56),
  internal_matrix_diagonal: z.array(fieldHexText).length(4),
  round_constants: z.array(z.array(fieldHexText).length(4)).length(64),
});

export type Poseidon2Params = z.infer<typeof poseidon2ParamsSchema>;

// Big-endian integer of ASCII text. The domain tag value is this integer.
export function asciiToBigInt(text: string): bigint {
  let value = 0n;
  for (let i = 0; i < text.length; i += 1) {
    value = (value << 8n) | BigInt(text.charCodeAt(i));
  }
  return value;
}

// BN254 scalar field elements and the byte-to-field encoding.
//
// Rules (implementation.md section 8; the same as crates/crypto/src/field.rs):
// - A field value on the wire is 32 bytes, big-endian, canonical. Decoding rejects a value
//   that is not less than the modulus. The value is never reduced.
// - In JSON a field value is "0x" and 64 lowercase hex digits.
// - An arbitrary 32-byte value goes into the circuit as two 128-bit limbs [hi, lo]:
//   hi is bytes 0..16 big-endian and lo is bytes 16..32 big-endian.

import { z } from "zod";
import { encodeHex, requireLength } from "@anon-credit/protocol";

export const FIELD_MODULUS = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;
export const FIELD_BYTES = 32;

export type FieldErrorReason = "out_of_range" | "bad_hex";

// Error for a field value that is not canonical.
export class FieldError extends Error {
  override readonly name = "FieldError";
  readonly reason: FieldErrorReason;

  constructor(reason: FieldErrorReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

export function fieldAdd(a: bigint, b: bigint): bigint {
  const sum = a + b;
  return sum >= FIELD_MODULUS ? sum - FIELD_MODULUS : sum;
}

export function fieldMul(a: bigint, b: bigint): bigint {
  return (a * b) % FIELD_MODULUS;
}

// Check that `value` is a canonical field element.
export function requireField(value: bigint, field: string): void {
  if (value < 0n || value >= FIELD_MODULUS) {
    throw new FieldError("out_of_range", `${field} is not a canonical field element`);
  }
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

// Decode the canonical 32-byte big-endian form. Reject a value that is not less than the modulus.
export function fieldFromBytes(bytes: Uint8Array): bigint {
  if (bytes.length !== FIELD_BYTES) {
    throw new FieldError("bad_hex", `field value must have ${FIELD_BYTES} bytes, found ${bytes.length}`);
  }
  const value = bytesToBigInt(bytes);
  if (value >= FIELD_MODULUS) {
    throw new FieldError("out_of_range", "field value is not less than the BN254 scalar field modulus");
  }
  return value;
}

// The canonical 32-byte big-endian form.
export function fieldToBytes(value: bigint): Uint8Array {
  requireField(value, "field value");
  const out = new Uint8Array(FIELD_BYTES);
  let rest = value;
  for (let i = FIELD_BYTES - 1; i >= 0; i -= 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

const FIELD_HEX = /^0x[0-9a-f]{64}$/;

// Decode "0x" and 64 lowercase hex digits. Reject a value that is not less than the modulus.
export function fieldFromHex(text: string): bigint {
  if (!FIELD_HEX.test(text)) {
    throw new FieldError("bad_hex", "field value must be 0x and 64 lowercase hex digits");
  }
  const value = BigInt(text);
  if (value >= FIELD_MODULUS) {
    throw new FieldError("out_of_range", "field value is not less than the BN254 scalar field modulus");
  }
  return value;
}

// Encode as "0x" and 64 lowercase hex digits.
export function fieldToHex(value: bigint): string {
  return encodeHex(fieldToBytes(value));
}

// Schema: a canonical field value in JSON. Output: the bigint.
export const fieldHexSchema = z.string().transform((text, context) => {
  try {
    return fieldFromHex(text);
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "bad field value" });
    return z.NEVER;
  }
});

// Two 128-bit limbs [hi, lo] of a 32-byte value. The limbs are never reduced.
export function bytes32ToLimbs(bytes: Uint8Array): readonly [bigint, bigint] {
  requireLength(bytes, 32, "32-byte value");
  return [bytesToBigInt(bytes.subarray(0, 16)), bytesToBigInt(bytes.subarray(16, 32))];
}

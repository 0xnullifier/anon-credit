// Canonical byte encodings and runtime schemas for wire values.
// Hex form: "0x" and lowercase digits, with the exact length.
// Large integers: decimal strings without leading zeros.

import { z } from "zod";

export const MAX_U16 = 0xffff;
export const MAX_U32 = 0xffff_ffff;
export const MAX_U64 = 0xffff_ffff_ffff_ffffn;

// Error for a value that does not fit the wire format.
export class EncodingError extends Error {
  override readonly name = "EncodingError";
}

const HEX_TEXT = /^0x(?:[0-9a-f]{2})*$/;

// Decode canonical hex of any even length.
export function decodeHex(text: string): Uint8Array {
  if (!HEX_TEXT.test(text)) {
    throw new EncodingError("hex value must be 0x and an even count of lowercase digits");
  }
  const digits = text.slice(2);
  const out = new Uint8Array(digits.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(digits.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// Decode canonical hex of exactly `length` bytes.
export function decodeFixedHex(text: string, length: number): Uint8Array {
  const bytes = decodeHex(text);
  if (bytes.length !== length) {
    throw new EncodingError(`hex value must have ${length} bytes, found ${bytes.length}`);
  }
  return bytes;
}

// Encode bytes as canonical hex.
export function encodeHex(bytes: Uint8Array): string {
  let text = "0x";
  for (const byte of bytes) {
    text += byte.toString(16).padStart(2, "0");
  }
  return text;
}

// Check that `bytes` has exactly `length` bytes.
export function requireLength(bytes: Uint8Array, length: number, field: string): void {
  if (bytes.length !== length) {
    throw new EncodingError(`${field} must have ${length} bytes, found ${bytes.length}`);
  }
}

// Check that `value` is an unsigned 64-bit integer.
export function requireU64(value: bigint, field: string): void {
  if (value < 0n || value > MAX_U64) {
    throw new EncodingError(`${field} must be an unsigned 64-bit integer`);
  }
}

// Schema: canonical hex of exactly `length` bytes. Output: the bytes.
export function fixedHexSchema(length: number) {
  return z
    .string()
    .regex(new RegExp(`^0x[0-9a-f]{${length * 2}}$`), `expected 0x and ${length * 2} lowercase hex digits`)
    .transform((text) => decodeFixedHex(text, length));
}

// Schema: canonical hex of any even length. Output: the bytes.
export const hexBytesSchema = z
  .string()
  .regex(HEX_TEXT, "expected 0x and an even count of lowercase hex digits")
  .transform((text) => decodeHex(text));

export const bytes32Schema = fixedHexSchema(32);
export const addressSchema = fixedHexSchema(20);

// Schema: an unsigned 64-bit integer as a decimal string. Output: a bigint.
export const u64DecimalSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]*)$/, "expected a decimal integer without leading zeros")
  .transform((text) => BigInt(text))
  .refine((value) => value <= MAX_U64, "value is larger than 2^64 - 1");

// Concatenate byte arrays.
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) {
    length += part.length;
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

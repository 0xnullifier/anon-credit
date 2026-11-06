// Wire value encodings of the gateway JSON envelopes.
// - Canonical base64: standard alphabet with padding. Other forms are rejected.
// - Decimal u64: a decimal string without leading zeros, at most 2^64 - 1.
// The schemas in this file check the wire text. They do not change it.
// The same rules are in crates/protocol/src/wire.rs.

import { z } from "zod";
import { EncodingError, MAX_U64 } from "./bytes.ts";

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_TEXT = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const DECIMAL_TEXT = /^(?:0|[1-9][0-9]*)$/;

// Encode bytes as canonical base64.
export function encodeBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const triple = (a << 16) | (b << 8) | c;
    const left = bytes.length - i;
    text += BASE64_ALPHABET.charAt((triple >> 18) & 63);
    text += BASE64_ALPHABET.charAt((triple >> 12) & 63);
    text += left > 1 ? BASE64_ALPHABET.charAt((triple >> 6) & 63) : "=";
    text += left > 2 ? BASE64_ALPHABET.charAt(triple & 63) : "=";
  }
  return text;
}

// Count the "=" characters at the end of base64 text.
function paddingLength(text: string): number {
  switch (true) {
    case text.endsWith("=="):
      return 2;
    case text.endsWith("="):
      return 1;
    default:
      return 0;
  }
}

// Decode canonical base64. Throw EncodingError for every non-canonical form.
export function decodeBase64(text: string): Uint8Array {
  if (!BASE64_TEXT.test(text)) {
    throw new EncodingError("value is not canonical base64");
  }
  const padding = paddingLength(text);
  const out = new Uint8Array((text.length / 4) * 3 - padding);
  let offset = 0;
  for (let i = 0; i < text.length; i += 4) {
    let quad = 0;
    for (let j = 0; j < 4; j += 1) {
      const char = text.charAt(i + j);
      quad = (quad << 6) | (char === "=" ? 0 : BASE64_ALPHABET.indexOf(char));
    }
    const bytes = [(quad >> 16) & 255, (quad >> 8) & 255, quad & 255];
    for (const byte of bytes) {
      if (offset < out.length) {
        out[offset] = byte;
        offset += 1;
      }
    }
  }
  // Non-zero padding bits are not canonical. A round trip finds them.
  if (encodeBase64(out) !== text) {
    throw new EncodingError("value is not canonical base64");
  }
  return out;
}

// Tell if the text is canonical base64.
export function isCanonicalBase64(text: string): boolean {
  try {
    decodeBase64(text);
    return true;
  } catch {
    return false;
  }
}

// Schema: canonical base64 text.
export const base64TextSchema = z.string().refine(isCanonicalBase64, "expected canonical base64");

// Schema: canonical base64 text of exactly 64 bytes (an Ed25519 signature).
export const signatureTextSchema = base64TextSchema.refine(
  (text) => decodeBase64(text).length === 64,
  "expected a 64-byte signature in canonical base64",
);

// Schema: canonical lowercase hex text of exactly `length` bytes.
export function hexTextSchema(length: number) {
  return z
    .string()
    .regex(new RegExp(`^0x[0-9a-f]{${length * 2}}$`), `expected 0x and ${length * 2} lowercase hex digits`);
}

export const hex32TextSchema = hexTextSchema(32);
export const addressTextSchema = hexTextSchema(20);

// Schema: a u64 as canonical decimal text.
export const decimalU64TextSchema = z
  .string()
  .regex(DECIMAL_TEXT, "expected a decimal integer without leading zeros")
  .refine((text) => BigInt(text) <= MAX_U64, "value is larger than 2^64 - 1");

// Encode a u64 as canonical decimal text.
export function encodeDecimalU64(value: bigint): string {
  if (value < 0n || value > MAX_U64) {
    throw new EncodingError("value must be an unsigned 64-bit integer");
  }
  return value.toString(10);
}

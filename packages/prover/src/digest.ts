// SHA-256 digests for pinned artifacts. WebCrypto works in browsers, workers, and Node.

import { z } from "zod";

// 64 lowercase hex digits, no 0x prefix. This is the same text form as the Rust crate.
export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, "expected 64 lowercase hex digits");

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Artifact download with size and digest checks.

import { sha256Hex } from "./digest.ts";
import { ProverError } from "./errors.ts";
import type { FileEntry } from "./manifest.ts";

export type FetchFunction = (url: URL) => Promise<Response>;

// Fetch bytes. Reject a response that is not OK or that is larger than maxBytes.
export async function fetchBytes(fetchFn: FetchFunction, url: URL, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  let response: Response;
  try {
    response = await fetchFn(url);
  } catch (error) {
    throw new ProverError("artifact_fetch_failed", `request for ${url.href} failed`, { cause: error });
  }
  if (!response.ok) {
    throw new ProverError("artifact_fetch_failed", `request for ${url.href} returned ${response.status}`);
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    throw new ProverError("artifact_digest_mismatch", `${url.href} has ${declared} bytes, the limit is ${maxBytes}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new ProverError("artifact_digest_mismatch", `${url.href} has ${bytes.byteLength} bytes, the limit is ${maxBytes}`);
  }
  return bytes;
}

// Fetch one manifest entry. The bytes must have the exact size and SHA-256 digest of the entry.
// The caller gets the bytes only after both checks pass.
export async function fetchVerified(fetchFn: FetchFunction, base: URL, entry: FileEntry): Promise<Uint8Array<ArrayBuffer>> {
  const url = new URL(entry.path, base);
  const bytes = await fetchBytes(fetchFn, url, entry.bytes);
  if (bytes.byteLength !== entry.bytes) {
    throw new ProverError("artifact_digest_mismatch", `${url.href} has ${bytes.byteLength} bytes, expected ${entry.bytes}`);
  }
  const actual = await sha256Hex(bytes);
  if (actual !== entry.sha256) {
    throw new ProverError("artifact_digest_mismatch", `${url.href} digest ${actual} is not ${entry.sha256}`);
  }
  return bytes;
}

import { describe, expect, it } from "vitest";
import { fetchVerified, type FetchFunction } from "./artifacts.ts";
import { sha256Hex } from "./digest.ts";
import { ProverError } from "./errors.ts";

const base = new URL("https://example.test/artifacts/manifest.json");
const bytes = new TextEncoder().encode("prover key bytes");

async function codeOf(promise: Promise<object>): Promise<string> {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    return error instanceof ProverError ? error.code : "other";
  }
}

describe("fetchVerified", () => {
  it("returns bytes with the pinned size and digest, and resolves the path", async () => {
    const seen: string[] = [];
    const fetchFn: FetchFunction = async (url) => {
      seen.push(url.href);
      return new Response(bytes);
    };
    const entry = { path: "sample.pkp", sha256: await sha256Hex(bytes), bytes: bytes.byteLength };
    const result = await fetchVerified(fetchFn, base, entry);
    expect(Array.from(result)).toEqual(Array.from(bytes));
    expect(seen).toEqual(["https://example.test/artifacts/sample.pkp"]);
  });

  it("rejects a wrong digest", async () => {
    const entry = { path: "sample.pkp", sha256: "0".repeat(64), bytes: bytes.byteLength };
    expect(await codeOf(fetchVerified(async () => new Response(bytes), base, entry))).toBe("artifact_digest_mismatch");
  });

  it("rejects a wrong size", async () => {
    const entry = { path: "sample.pkp", sha256: await sha256Hex(bytes), bytes: bytes.byteLength + 1 };
    expect(await codeOf(fetchVerified(async () => new Response(bytes), base, entry))).toBe("artifact_digest_mismatch");
    const smaller = { ...entry, bytes: bytes.byteLength - 1 };
    expect(await codeOf(fetchVerified(async () => new Response(bytes), base, smaller))).toBe("artifact_digest_mismatch");
  });

  it("rejects an HTTP error and a network error", async () => {
    const entry = { path: "sample.pkp", sha256: await sha256Hex(bytes), bytes: bytes.byteLength };
    const notFound = await codeOf(fetchVerified(async () => new Response("", { status: 404 }), base, entry));
    expect(notFound).toBe("artifact_fetch_failed");
    const offline = await codeOf(
      fetchVerified(async () => Promise.reject(new TypeError("offline")), base, entry),
    );
    expect(offline).toBe("artifact_fetch_failed");
  });
});

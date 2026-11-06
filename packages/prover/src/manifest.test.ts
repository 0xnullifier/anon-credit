import { describe, expect, it } from "vitest";
import type { FetchFunction } from "./artifacts.ts";
import { sha256Hex } from "./digest.ts";
import { ProverError } from "./errors.ts";
import { loadManifest, MANIFEST_FORMAT, parseManifest } from "./manifest.ts";

const entry = (path: string) => ({ path, sha256: "a".repeat(64), bytes: 10 });

const manifest = {
  format: MANIFEST_FORMAT,
  circuit: "provekit_sample",
  provekit: {
    repo: "https://github.com/worldfnd/provekit",
    rev: "201b7b639f5dd5632c01561fcb2a96c2fc8851f3",
    witnessMode: "zk",
    hash: "skyscraper",
  },
  noir: "1.0.0-beta.26",
  numPublicInputs: 3,
  pkp: entry("sample.pkp"),
  pkv: entry("sample.pkv"),
  wasm: { scalar: { glue: entry("g.js"), binary: entry("g.wasm") } },
};

const encode = (value: object): Uint8Array<ArrayBuffer> => new TextEncoder().encode(JSON.stringify(value));

function serve(bytes: Uint8Array<ArrayBuffer>): FetchFunction {
  return async () => new Response(bytes);
}

async function codeOf(promise: Promise<object>): Promise<string> {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    return error instanceof ProverError ? error.code : "other";
  }
}

const url = new URL("https://example.test/artifacts/manifest.json");

describe("prover manifest", () => {
  it("loads a manifest with the pinned digest", async () => {
    const bytes = encode(manifest);
    const loaded = await loadManifest(serve(bytes), url, await sha256Hex(bytes));
    expect(loaded.circuit).toBe("provekit_sample");
  });

  it("rejects a manifest with another digest before it parses the JSON", async () => {
    const bytes = new TextEncoder().encode("not json");
    expect(await codeOf(loadManifest(serve(bytes), url, "b".repeat(64)))).toBe("manifest_invalid");
  });

  it("rejects a bad pinned digest", async () => {
    const bytes = encode(manifest);
    expect(await codeOf(loadManifest(serve(bytes), url, "B".repeat(64)))).toBe("manifest_invalid");
  });

  it("accepts only the hiding witness mode", () => {
    const standard = { ...manifest, provekit: { ...manifest.provekit, witnessMode: "standard" } };
    expect(() => parseManifest(encode(standard))).toThrow(ProverError);
  });

  it("rejects unknown fields", () => {
    expect(() => parseManifest(encode({ ...manifest, extra: 1 }))).toThrow(ProverError);
  });
});

// Chunked proof upload against the fake gateway.

import { OPEN_CHUNK_MAX_BYTES, OPEN_CHUNK_PATH_PREFIX, encodeBase64, encodeHex, openChunkPath, openRequestSchema, parseOpenChunkPath } from "@anon-credit/protocol";
import type { ProofResult } from "@anon-credit/prover";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import type { ClientConfig } from "./client.ts";
import { ServiceError } from "./errors.ts";
import type { ProverLike } from "./open.ts";
import { fakeServices, type CallRecord } from "./test-support/fake-services.ts";
import { issued, testClient } from "./test-support/client.ts";
import { DEFAULT_UPLOAD_POLICY, encodeProof, planUpload, sendChunks, uploadChunkBytes, type EncodedProof } from "./upload.ts";

// A JSON-like proof of about the size of a real ProveKit JSON proof part. It compresses less
// than a real proof, so it gives more chunks.
function bigProof(bytes: number): Uint8Array<ArrayBuffer> {
  let state = 7;
  let text = '{"proof":"';
  while (text.length < bytes - 2) {
    // xorshift32
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    text += "0123456789abcdef"[state % 16];
  }
  return new Uint8Array(new TextEncoder().encode(`${text}"}`));
}

function proverOf(proof: Uint8Array<ArrayBuffer>): ProverLike {
  return {
    prove: async (): Promise<ProofResult> => ({ proof, durationMs: 5, witnessMs: 1, provingMs: 4, wasmMemoryBytes: null }),
  };
}

function chunkCalls(calls: readonly CallRecord[]): CallRecord[] {
  return calls.filter((call) => call.path.startsWith(`${OPEN_CHUNK_PATH_PREFIX}/`));
}

function openBody(calls: readonly CallRecord[]): ReturnType<typeof openRequestSchema.parse> {
  const call = calls.filter((item) => item.path === "/v1/open").at(-1);
  return openRequestSchema.parse(JSON.parse(call?.body ?? ""));
}

describe("planUpload", () => {
  it("splits the bytes into raw chunks of at most 40,000 bytes with the SHA-256 of all bytes", async () => {
    const encoded: EncodedProof = { bytes: bigProof(100_000), encoding: "json" };
    const plan = planUpload(`0x${"01".repeat(32)}`, encoded);
    expect(plan.chunks.length).toBe(Math.ceil(100_000 / OPEN_CHUNK_MAX_BYTES));
    expect(plan.reference.proof_sha256).toBe(encodeHex(sha256(encoded.bytes)));
    expect(plan.reference.total_bytes).toBe(100_000);
    const joined = plan.chunks.flatMap((chunk) => [...chunk.data]);
    expect(Uint8Array.from(joined)).toEqual(encoded.bytes);
    plan.chunks.forEach((chunk, index) => {
      expect(chunk.data.byteLength).toBeLessThanOrEqual(OPEN_CHUNK_MAX_BYTES);
      // Each chunk has its own buffer, not a view of the full upload.
      expect(chunk.data.buffer.byteLength).toBe(chunk.data.byteLength);
      expect(chunk.path.chunk_count).toBe(plan.chunks.length);
      expect(chunk.path.chunk_index).toBe(index);
      expect(parseOpenChunkPath(openChunkPath(chunk.path))).toEqual(chunk.path);
    });
    expect(planUpload(`0x${"01".repeat(32)}`, encoded, 10_000).chunks.length).toBe(10);
    expect(() => planUpload(`0x${"01".repeat(32)}`, encoded, OPEN_CHUNK_MAX_BYTES + 1)).toThrow();
  });

  it("plans a 318,335-byte upload as 8 chunks", () => {
    const plan = planUpload(`0x${"01".repeat(32)}`, { bytes: new Uint8Array(318_335), encoding: "json+gzip" });
    expect(plan.chunks.length).toBe(8);
    expect(plan.chunks.at(-1)?.data.byteLength).toBe(318_335 - 7 * 40_000);
    expect(DEFAULT_UPLOAD_POLICY.parallel).toBe(8);
  });

  it("takes the chunk size from the gateway limits and the transport body limit", () => {
    const limits = { open_upload_chunk_bytes: 40_000, open_upload_chunk_body_bytes: 40_000 };
    expect(uploadChunkBytes(limits, Number.POSITIVE_INFINITY)).toBe(40_000);
    expect(uploadChunkBytes({ ...limits, open_upload_chunk_bytes: 24_576 }, Number.POSITIVE_INFINITY)).toBe(24_576);
    expect(uploadChunkBytes({ ...limits, open_upload_chunk_bytes: 100_000, open_upload_chunk_body_bytes: 100_000 }, 40_000)).toBe(40_000);
    expect(uploadChunkBytes(limits, 30_000)).toBe(30_000);
    expect(() => uploadChunkBytes({ ...limits, open_upload_chunk_bytes: 0 }, 40_000)).toThrow();
  });

  it("gzips the JSON proof", async () => {
    const proof = bigProof(50_000);
    const encoded = await encodeProof(proof);
    expect(encoded.encoding).toBe("json+gzip");
    expect(encoded.bytes.byteLength).toBeLessThan(proof.byteLength);
    const stream = new Blob([new Uint8Array(encoded.bytes)]).stream().pipeThrough(new DecompressionStream("gzip"));
    expect(new Uint8Array(await new Response(stream).arrayBuffer())).toEqual(proof);
  });
});

describe("submitOpen with a chunked proof", () => {
  it("uploads through the anonymous transport on the batch key, 8 at a time, then opens", async () => {
    const proof = bigProof(800_000);
    const fake = fakeServices("anon");
    fake.hooks.validProof = encodeBase64(proof);
    const setup = await testClient({ prover: proverOf(proof) }, fake);
    const [first] = await issued(setup, 1);
    if (first === undefined) throw new Error("no batch");
    const prepared = await setup.client.prepareOpen(first);
    const outcome = await setup.client.submitOpen(first, prepared.request);
    expect(outcome.response.session.remaining).toBe(100);
    const stats = outcome.upload;
    if (stats === null) throw new Error("no upload");
    expect(stats.encoding).toBe("json+gzip");
    expect(stats.proofBytes).toBe(800_000);
    expect(stats.chunks).toBeGreaterThan(8);
    expect(stats.parallel).toBe(8);
    expect(stats.fellBack).toBe(false);
    expect(stats.sends).toBe(stats.chunks);
    expect(stats.chunkMs.length).toBe(stats.chunks);
    expect(fake.chunkStats.maxInFlight).toBe(8);
    const chunks = chunkCalls(fake.calls);
    expect(chunks.length).toBe(stats.chunks);
    expect(chunks.every((call) => call.method === "PUT" && call.isolationKey === first)).toBe(true);
    // Raw bodies: no JSON text, at most 40,000 bytes, all full except the last.
    expect(chunks.every((call) => call.body === undefined && call.bytes !== undefined)).toBe(true);
    const sizes = chunks.map((call) => call.bytes?.byteLength ?? 0);
    expect(Math.max(...sizes)).toBe(40_000);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(stats.uploadBytes);
    const wire = openBody(fake.calls);
    expect("proof" in wire).toBe(false);
    expect("proof_upload" in wire && wire.proof_upload.total_bytes === stats.uploadBytes).toBe(true);
    expect(fake.chunkStats.pendingUploads()).toBe(0);

    // An exact retry uploads again and gets the existing session.
    const again = await setup.client.submitOpen(first, prepared.request);
    expect(again.response.existing).toBe(true);
    expect(fake.chunkStats.pendingUploads()).toBe(0);
  });

  it("falls back to one chunk at a time and keeps that for later uploads", async () => {
    const proof = bigProof(300_000);
    const fake = fakeServices("anon");
    fake.hooks.validProof = encodeBase64(proof);
    fake.hooks.refuseParallelChunks = true;
    const setup = await testClient({ prover: proverOf(proof) }, fake);
    const [first, second] = await issued(setup, 2);
    if (first === undefined || second === undefined) throw new Error("no batch");
    const outcome = await setup.client.submitOpen(first, (await setup.client.prepareOpen(first)).request);
    expect(outcome.upload?.fellBack).toBe(true);
    expect(outcome.response.session.remaining).toBe(100);
    const later = await setup.client.submitOpen(second, (await setup.client.prepareOpen(second)).request);
    expect(later.upload?.parallel).toBe(1);
    expect(later.upload?.fellBack).toBe(false);
  });

  it("retries a failed chunk with the same bytes, and fails after the last attempt", async () => {
    const fake = fakeServices("anon");
    const setup = await testClient({ uploadPolicy: { parallel: 1, attempts: 3, delayMs: 5 } }, fake);
    const [first, second] = await issued(setup, 2);
    if (first === undefined || second === undefined) throw new Error("no batch");
    fake.hooks.failChunks = 2;
    const outcome = await setup.client.submitOpen(first, (await setup.client.prepareOpen(first)).request);
    expect(outcome.upload?.sends).toBe(3);
    const sent = chunkCalls(fake.calls);
    expect(new Set(sent.map((call) => encodeHex(call.bytes ?? new Uint8Array()))).size).toBe(1);
    expect(new Set(sent.map((call) => call.path)).size).toBe(1);

    fake.hooks.failChunks = 10;
    await expect(setup.client.submitOpen(second, (await setup.client.prepareOpen(second)).request)).rejects.toMatchObject({
      code: "transport_failed",
    });
    expect(fake.sessions.has(second)).toBe(false);
  });

  it("a tampered proof is proof_invalid and the gateway keeps no upload", async () => {
    const setup = await testClient();
    const [first] = await issued(setup, 1);
    if (first === undefined) throw new Error("no batch");
    const prepared = await setup.client.prepareOpen(first);
    await expect(setup.client.submitOpen(first, { ...prepared.request, proof: "dGFtcGVyZWQ=" })).rejects.toMatchObject({
      serviceCode: "proof_invalid",
    });
    expect(setup.fake.chunkStats.pendingUploads()).toBe(0);
  });

  it("the direct transport sends the proof inline unless chunks are forced or the body is too large", async () => {
    const proof = bigProof(60_000);
    const cases: readonly { readonly options: Partial<ClientConfig>; readonly chunked: boolean }[] = [
      { options: {}, chunked: false },
      { options: { openUpload: "chunked" }, chunked: true },
    ];
    for (const { options, chunked } of cases) {
      const fake = fakeServices("direct");
      fake.hooks.validProof = encodeBase64(proof);
      const setup = await testClient({ allowDirectTransport: true, prover: proverOf(proof), ...options }, fake);
      const [first] = await issued(setup, 1);
      if (first === undefined) throw new Error("no batch");
      const outcome = await setup.client.submitOpen(first, (await setup.client.prepareOpen(first)).request);
      expect(outcome.upload !== null).toBe(chunked);
      expect("proof" in openBody(fake.calls)).toBe(!chunked);
    }
    // A per-call override.
    const fake = fakeServices("direct");
    fake.hooks.validProof = encodeBase64(proof);
    const setup = await testClient({ allowDirectTransport: true, prover: proverOf(proof) }, fake);
    const [first] = await issued(setup, 1);
    if (first === undefined) throw new Error("no batch");
    const outcome = await setup.client.submitOpen(first, (await setup.client.prepareOpen(first)).request, { upload: "chunked" });
    expect(outcome.upload?.chunks).toBeGreaterThan(0);
  });

  it("sendChunks stops on a request that is not retryable", async () => {
    const plan = planUpload(`0x${"01".repeat(32)}`, { bytes: bigProof(80_000), encoding: "json" });
    let sends = 0;
    await expect(
      sendChunks(
        plan,
        { parallel: 4, attempts: 3, delayMs: 0 },
        {
          send: async () => {
            sends += 1;
            throw new ServiceError("invalid_request", 400, "bad chunk", false);
          },
          sleep: async () => undefined,
          now: () => 0,
        },
        80_000,
      ),
    ).rejects.toMatchObject({ serviceCode: "invalid_request" });
    expect(sends).toBeLessThanOrEqual(4);
  });
});

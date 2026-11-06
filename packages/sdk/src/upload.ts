// Chunked proof upload (PUT /v1/open/chunks).
//
// The Nox worker refuses request bodies above about 48,000 bytes, and an open request with an
// inline proof is about 640 KB. Thus the SDK:
// 1. Encodes the JSON proof with gzip (CompressionStream), or sends the JSON as it is if the
//    runtime has no CompressionStream.
// 2. Splits the bytes into chunks of at most 24 KiB. Each chunk envelope is below 40,000 bytes.
// 3. Sends the chunks on the isolation key of the batch: first 4 at the same time with one
//    attempt each, then the failed chunks one at a time with retries. A retry sends the same
//    bytes. The gateway ignores a duplicate chunk with the same bytes.
// 4. Sends POST /v1/open with proof_upload in place of proof. The signature does not change.

import {
  OPEN_CHUNK_MAX_BYTES,
  encodeBase64,
  encodeHex,
  openChunkRequestSchema,
  proofUploadSchema,
  type OpenChunkRequest,
  type OpenChunkResponse,
  type ProofEncoding,
  type ProofUpload,
} from "@anon-credit/protocol";
import { sha256 } from "@noble/hashes/sha2.js";
import { SdkError, ServiceError, type Thrown } from "./errors.ts";

// When the SDK sends the proof in chunks.
// "auto": with an anonymous transport, or if the inline request is above transport.maxBodyBytes.
// "chunked": always. "inline": never (the request fails on a transport with a small limit).
export type OpenUploadMode = "auto" | "chunked" | "inline";

export interface UploadPolicy {
  // Chunks in flight at the same time in the first pass. 1 disables the parallel pass.
  readonly parallel: number;
  // Attempts of each chunk in the sequential pass.
  readonly attempts: number;
  // Wait between two attempts of a chunk, in milliseconds.
  readonly delayMs: number;
}

export const DEFAULT_UPLOAD_POLICY: UploadPolicy = { parallel: 4, attempts: 3, delayMs: 500 };

export interface EncodedProof {
  readonly bytes: Uint8Array;
  readonly encoding: ProofEncoding;
}

export interface UploadPlan {
  readonly reference: ProofUpload;
  readonly chunks: readonly OpenChunkRequest[];
}

export interface UploadStats {
  readonly encoding: ProofEncoding;
  // Proof bytes before the encoding.
  readonly proofBytes: number;
  // Uploaded bytes after the encoding.
  readonly uploadBytes: number;
  readonly chunks: number;
  // Concurrency of the first pass.
  readonly parallel: number;
  // true if one or more chunks failed in the first pass and the sequential pass sent them.
  readonly fellBack: boolean;
  // Number of PUT requests, retries included.
  readonly sends: number;
  // Time of the successful send of each chunk, in chunk order, in milliseconds.
  readonly chunkMs: readonly number[];
  readonly totalMs: number;
}

// Encode a JSON proof for the upload: gzip if the runtime has CompressionStream.
export async function encodeProof(proof: Uint8Array): Promise<EncodedProof> {
  if (typeof CompressionStream === "undefined") return { bytes: proof, encoding: "json" };
  const source = new Blob([new Uint8Array(proof)]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(source).arrayBuffer());
  return { bytes, encoding: "json+gzip" };
}

// Split encoded proof bytes into chunk envelopes for one batch.
export function planUpload(batchId: string, encoded: EncodedProof, chunkBytes: number = OPEN_CHUNK_MAX_BYTES): UploadPlan {
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > OPEN_CHUNK_MAX_BYTES) {
    throw new SdkError("invalid_response", `chunk size must be 1 to ${OPEN_CHUNK_MAX_BYTES} bytes`);
  }
  const total = encoded.bytes.byteLength;
  const reference = proofUploadSchema.parse({
    proof_sha256: encodeHex(sha256(encoded.bytes)),
    total_bytes: total,
    proof_encoding: encoded.encoding,
  });
  const count = Math.ceil(total / chunkBytes);
  const chunks: OpenChunkRequest[] = [];
  for (let index = 0; index < count; index += 1) {
    chunks.push(
      openChunkRequestSchema.parse({
        batch_id: batchId,
        proof_sha256: reference.proof_sha256,
        total_bytes: total,
        chunk_index: index,
        chunk_count: count,
        data: encodeBase64(encoded.bytes.subarray(index * chunkBytes, Math.min(total, (index + 1) * chunkBytes))),
      }),
    );
  }
  return { reference, chunks };
}

// A transport failure or a retryable gateway error (busy, storage_unavailable).
function retryable(error: Error): boolean {
  switch (true) {
    case error instanceof ServiceError:
      return error.retryable;
    case error instanceof SdkError:
      return error.code === "transport_failed";
    default:
      return false;
  }
}

function asError(error: Thrown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export interface UploadDeps {
  readonly send: (chunk: OpenChunkRequest) => Promise<OpenChunkResponse>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

// Send all chunks. Return the measurements. Throw the last error if a chunk cannot be sent.
export async function sendChunks(plan: UploadPlan, policy: UploadPolicy, deps: UploadDeps, proofBytes: number): Promise<UploadStats> {
  const start = deps.now();
  const count = plan.chunks.length;
  const chunkMs: number[] = new Array<number>(count).fill(0);
  let sends = 0;
  let complete = false;
  const sendOnce = async (index: number): Promise<void> => {
    const chunk = plan.chunks[index];
    if (chunk === undefined) throw new SdkError("invalid_response", `chunk ${index} does not exist`);
    const sent = deps.now();
    sends += 1;
    const reply = await deps.send(chunk);
    chunkMs[index] = deps.now() - sent;
    if (reply.complete) complete = true;
  };

  // First pass: `parallel` chunks in flight, one attempt each.
  const parallel = Math.max(1, Math.min(policy.parallel, count));
  const failed: number[] = [];
  let fatal: Error | undefined;
  let next = 0;
  const lane = async (): Promise<void> => {
    while (fatal === undefined && next < count) {
      const index = next;
      next += 1;
      try {
        await sendOnce(index);
      } catch (error) {
        const failure = asError(error);
        if (retryable(failure)) failed.push(index);
        else fatal = failure;
      }
    }
  };
  await Promise.all(Array.from({ length: parallel }, lane));
  if (fatal !== undefined) throw fatal;

  // Second pass: the failed chunks one at a time, with retries of the same bytes.
  const pending = [...failed].sort((a, b) => a - b);
  for (const index of pending) {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        await sendOnce(index);
        break;
      } catch (error) {
        const failure = asError(error);
        if (!retryable(failure) || attempt >= policy.attempts) throw failure;
        await deps.sleep(policy.delayMs);
      }
    }
  }
  if (!complete) throw new SdkError("invalid_response", "the gateway did not report a complete proof upload");
  return {
    encoding: plan.reference.proof_encoding,
    proofBytes,
    uploadBytes: plan.reference.total_bytes,
    chunks: count,
    parallel,
    fellBack: pending.length > 0,
    sends,
    chunkMs,
    totalMs: deps.now() - start,
  };
}

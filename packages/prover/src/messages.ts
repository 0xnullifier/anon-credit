// Messages between the page and the prover worker. Both sides validate every message.

import { z } from "zod";
import { sha256HexSchema } from "./digest.ts";
import { proverErrorCodeSchema } from "./errors.ts";
import { inputMapSchema } from "./inputs.ts";

// scalar: one thread, no SharedArrayBuffer. threaded: needs a cross-origin isolated page.
export const threadModeSchema = z.enum(["scalar", "threaded"]);
export type ThreadMode = z.infer<typeof threadModeSchema>;

export const workerRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("init"),
    manifestUrl: z.url(),
    manifestSha256: sha256HexSchema,
    mode: threadModeSchema,
    threads: z.number().int().positive(),
  }),
  z.object({ type: z.literal("prove"), id: z.number().int().nonnegative(), inputs: inputMapSchema }),
]);
export type WorkerRequest = z.infer<typeof workerRequestSchema>;

export const proverInfoSchema = z.object({
  circuit: z.string(),
  mode: threadModeSchema,
  threads: z.number().int().positive(),
  // Bytes of the prover key and the WASM files that the worker downloaded.
  downloadBytes: z.number().int().nonnegative(),
  // Time from the init request to a ready prover, in milliseconds.
  loadMs: z.number().nonnegative(),
  numConstraints: z.number().int().nonnegative(),
  numWitnesses: z.number().int().nonnegative(),
  numPublicInputs: z.number().int().nonnegative(),
});
export type ProverInfo = z.infer<typeof proverInfoSchema>;

export const proofResultSchema = z.object({
  // Serialized native ProveKit proof (JSON encoding of the WASM prover).
  proof: z.instanceof(Uint8Array),
  // Total time: witness generation, prover key decoding, and proving, in milliseconds.
  durationMs: z.number().nonnegative(),
  witnessMs: z.number().nonnegative(),
  provingMs: z.number().nonnegative(),
  // Size of the WASM linear memory after proving. Linear memory does not shrink, so this
  // is the peak WASM heap. null if the module does not expose its memory.
  wasmMemoryBytes: z.number().int().nonnegative().nullable(),
});
export type ProofResult = z.infer<typeof proofResultSchema>;

export const workerResponseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), info: proverInfoSchema }),
  z.object({ type: z.literal("proof"), id: z.number().int().nonnegative(), result: proofResultSchema }),
  z.object({
    type: z.literal("error"),
    // null for an init error.
    id: z.number().int().nonnegative().nullable(),
    code: proverErrorCodeSchema,
    message: z.string(),
  }),
]);
export type WorkerResponse = z.infer<typeof workerResponseSchema>;

// The API between the Node runner and the browser page. Both sides validate every message.
//
// The page exposes one function: window.anonE2E(requestJson) -> responseJson. The runner sends
// only public values and operational settings. The page never returns batch secrets, session
// private keys, or the storage passphrase.

import { issuanceSchema } from "@anon-credit/protocol";
import { z } from "zod";

export const transportChoiceSchema = z.enum(["anon", "direct"]);
export type TransportChoice = z.infer<typeof transportChoiceSchema>;

export const setupRequestSchema = z.strictObject({
  gatewayUrl: z.url(),
  issuerUrl: z.url(),
  transport: transportChoiceSchema,
  bootstrapRpcUrl: z.url().optional(),
  readyTimeoutMs: z.number().int().positive(),
  manifestUrl: z.string().min(1),
  manifestSha256: z.string().regex(/^0x[0-9a-f]{64}$/),
  proverMode: z.enum(["auto", "scalar", "threaded"]),
  passphrase: z.string().min(8),
  firstUseDelayEpochs: z.union([z.number().int().min(0).max(3), z.literal("random")]),
  pollMs: z.number().int().positive(),
  eligibleTimeoutMs: z.number().int().positive(),
});
export type SetupRequest = z.infer<typeof setupRequestSchema>;

export const probeKindSchema = z.enum(["conflict", "bad_signature", "gap"]);

export const pageRequestSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("setup"), setup: setupRequestSchema }),
  z.strictObject({ op: z.literal("createBatches"), n: z.number().int().min(1).max(100) }),
  z.strictObject({ op: z.literal("attachIssuance"), issuance: issuanceSchema }),
  z.strictObject({ op: z.literal("waitEligible"), batchId: z.string() }),
  z.strictObject({ op: z.literal("prepareOpen"), batchId: z.string() }),
  z.strictObject({ op: z.literal("submitOpen"), batchId: z.string(), tamper: z.boolean() }),
  z.strictObject({ op: z.literal("rpc"), batchId: z.string(), method: z.string(), params: z.array(z.json()), label: z.string().optional() }),
  z.strictObject({ op: z.literal("replay"), batchId: z.string(), label: z.string() }),
  z.strictObject({ op: z.literal("probe"), batchId: z.string(), kind: probeKindSchema }),
  z.strictObject({ op: z.literal("status"), batchId: z.string() }),
  z.strictObject({ op: z.literal("drain"), batchId: z.string(), method: z.string() }),
  z.strictObject({ op: z.literal("transportInfo") }),
  z.strictObject({ op: z.literal("peerProbe") }),
  z.strictObject({ op: z.literal("close") }),
]);
export type PageRequest = z.input<typeof pageRequestSchema>;

// An error inside the page. code is the SDK code, serviceCode the protocol code.
export const pageErrorSchema = z.strictObject({
  name: z.string(),
  code: z.string().nullable(),
  serviceCode: z.string().nullable(),
  message: z.string(),
});
export type PageError = z.infer<typeof pageErrorSchema>;

export const pageResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), value: z.json() }),
  z.strictObject({ ok: z.literal(false), error: pageErrorSchema }),
]);

// Values of the operations.
export const setupValueSchema = z.strictObject({
  transportKind: transportChoiceSchema,
  crossOriginIsolated: z.boolean(),
  proverMode: z.enum(["scalar", "threaded"]),
  proverLoadMs: z.number(),
  proverThreads: z.number(),
  proverDownloadBytes: z.number(),
  deploymentId: z.string(),
  gatewayId: z.string(),
  epochSeconds: z.number(),
  paymentChainId: z.number(),
  saleAddress: z.string(),
  transportReadyMs: z.number(),
});
export type SetupValue = z.infer<typeof setupValueSchema>;

export const batchesValueSchema = z.strictObject({
  batches: z.array(z.strictObject({ batchId: z.string(), commitment: z.string() })),
});

export const attachValueSchema = z.strictObject({ matched: z.array(z.string()) });

export const eligibleValueSchema = z.strictObject({
  sourceEpoch: z.string(),
  leafCount: z.number(),
  waitedMs: z.number(),
  delayEpochs: z.number(),
});

export const prepareValueSchema = z.strictObject({
  proofEpoch: z.string(),
  rootEpoch: z.string(),
  leafCount: z.number(),
  publicInputCount: z.number(),
  pathChecked: z.boolean(),
  proofBytes: z.number(),
  proveMs: z.number(),
  witnessMs: z.number(),
  wasmMemoryBytes: z.number().nullable(),
  prepareMs: z.number(),
});
export type PrepareValue = z.infer<typeof prepareValueSchema>;

export const openValueSchema = z.strictObject({
  existing: z.boolean(),
  remaining: z.number(),
  nextSeq: z.string(),
  reprepared: z.boolean(),
  openMs: z.number(),
});

export const rpcValueSchema = z.strictObject({
  seq: z.string(),
  remaining: z.number(),
  nextSeq: z.string(),
  replayed: z.boolean().nullable(),
  stateSource: z.enum(["headers", "status"]),
  attempts: z.number(),
  hasResult: z.boolean(),
  ms: z.number(),
});
export type RpcValue = z.infer<typeof rpcValueSchema>;

export const replayValueSchema = z.strictObject({
  httpStatus: z.number(),
  sameBody: z.boolean(),
  replayed: z.boolean().nullable(),
  remaining: z.number().nullable(),
  errorCode: z.string().nullable(),
});

export const probeValueSchema = z.strictObject({ httpStatus: z.number(), errorCode: z.string().nullable() });

export const statusValueSchema = z.strictObject({
  remaining: z.number(),
  nextSeq: z.string(),
  unitsTotal: z.string(),
  state: z.string(),
});

export const drainValueSchema = z.strictObject({
  requests: z.number(),
  remaining: z.number(),
  nextSeq: z.string(),
  stateSources: z.record(z.string(), z.number()),
  ms: z.number(),
});

export const transportInfoValueSchema = z.strictObject({
  kind: transportChoiceSchema,
  isolationKeys: z.array(z.string()),
  logLines: z.number(),
});

export const peerValueSchema = z.strictObject({ observedIp: z.string(), attribution: z.string() });

export const emptyValueSchema = z.strictObject({});

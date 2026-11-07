# What the app needs from the SDK

The app consumes the public API of `@anon-credit/sdk`, `@anon-credit/prover`, and
`@anon-credit/anon-transport` as it exists now. It does not edit those packages. This file lists
what it had to work around, with the signature it wants.

## 1. Prover progress hook

The prover gives timing only after the proof exists (`ProofResult.witnessMs`, `provingMs`,
`durationMs`). The app shows "proving" from the moment the issuer answers the path request
(a transport event) until `prepareOpen` returns, and the real split after. A hook would give the
witness and proving phases live.

```ts
// @anon-credit/prover
export type ProvePhase = "loading_key" | "witness" | "proving" | "serializing";
export interface ProveProgress { readonly phase: ProvePhase; readonly atMs: number }
export interface BatchOpenProver {
  readonly prove: (inputs: InputMap, options?: { readonly onProgress?: (p: ProveProgress) => void }) => Promise<ProofResult>;
}

// @anon-credit/sdk ClientConfig
readonly onProveProgress?: (progress: ProveProgress & { readonly batchId: string }) => void;
```

## 2. Chunk upload progress hook

`submitOpen` returns `UploadStats` after the whole upload. The app rebuilds the per-chunk view
(sent, sent again, acknowledged, failed) from the transport requests it observes
(`PUT /v1/open/chunks/...`). A hook in `sendChunks` would make the wrapper unnecessary.

```ts
// @anon-credit/sdk upload.ts
export interface ChunkProgress {
  readonly index: number;
  readonly count: number;
  readonly phase: "sent" | "acknowledged" | "retry" | "failed";
  readonly attempt: number;
  readonly atMs: number;
}
export interface UploadDeps { readonly onChunk?: (progress: ChunkProgress) => void }
// ClientConfig / SubmitOpenOptions
readonly onChunk?: (progress: ChunkProgress & { readonly batchId: string }) => void;
```

## 3. Open pipeline phases

`prepareOpen` does the path fetch, the local check, the witness, the proof, and the signature in
one call. The app separates "path" and "prove" by the transport event of the path request.

```ts
// @anon-credit/sdk open.ts
export type OpenPhase = "path" | "path_checked" | "witness" | "proving" | "signing" | "uploading" | "posting";
readonly onOpenPhase?: (phase: OpenPhase, batchId: string) => void;
```

## 4. Spend stages

`Session.rpc` signs, journals, sends, and saves in one call. The app shows "signing" from the
call until the transport event of `POST /v1/rpc`, "sent", "gateway answered", and "received"
from the transport events and the promise. A hook would also expose the journal write.

```ts
export type SpendPhase = "signing" | "journaled" | "sent" | "answered" | "saved";
readonly onSpendPhase?: (phase: SpendPhase, seq: bigint) => void;  // RpcOptions
```

## 5. Verify time in the open response

The gateway measures `verify_ms` but reports it only on the admin API. The public
`OpenResponse` could carry `verify_ms` so the customer sees the real verification time.

## 6. Issuer `POST /v1/topups` from a browser

The issuer allows CORS for `GET` only, so a browser cannot register a payment. The app polls
`GET /v1/topups/:tx/:log` (404 until the indexer reads the block), which works because the
indexer issues every purchase on its own. Either allow `POST /v1/topups` in CORS, or document
that registration is optional.

## 7. Block tag and limits on the client

`client.deployment` does not include `block_tag`, `demo_peer_enabled`, or `limits`. The app reads
`GET /v1/config` of both services itself through the transport. `Client` could expose
`gatewayConfig` and `issuerConfig` as read at `createClient`.

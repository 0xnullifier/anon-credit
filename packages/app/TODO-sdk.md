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

## 8. Price table version 2: two new methods

The gateway now serves price table version 2. The SDK has no method list; it reads the table
from `GET /v1/prices`. The method select of `SpendStep.tsx` builds its options from
`workbench.client.priceTable.units`, so the new methods show without a change. Only
`defaultParams` has no case for them: they start with `[]`, and the gateway rejects that with
`invalid_request`.

| Method | Units | Params |
|---|---:|---|
| `eth_chainId` | 1 | none |
| `eth_blockNumber` | 1 | none |
| `eth_getBalance` | 2 | `[address, block]` |
| `eth_call` | 3 | `[{to, from?, data or input?, value?, gas?, gasPrice?}, block]` |
| `eth_getTransactionReceipt` | 2 | `[transaction hash]` |

Canonical JSON: `{"units":{"eth_blockNumber":1,"eth_call":3,"eth_chainId":1,"eth_getBalance":2,"eth_getTransactionReceipt":2},"version":2}`.
`price_table_hash`: `0x5a43e7886a8b605be5873140f6682098b51d69af2c46f2ccc5ac6670a8408f08`.
`CURRENT_PRICE_TABLE` of `@anon-credit/protocol` is this table.

Rules of the gateway (`crates/gateway/src/rpc.rs`):

- `eth_call`: `to` (address) is necessary. `data` or `input` (hex bytes, at most 8 KiB), not
  both. `value`, `gasPrice`, `gas` are canonical hex quantities (`0x0`, or lowercase digits with
  no leading zero). Other members are rejected. The block is a tag or a canonical hex number.
- `eth_getTransactionReceipt`: `0x` and 64 hex digits.
- A response above `GATEWAY_UPSTREAM_RESPONSE_LIMIT_BYTES` is `upstream_failed` with no charge.

Suggested defaults:

```ts
case "eth_call":
  // CreditSale.batchPriceWei(); the sale address is client.deployment.sale_address.
  return JSON.stringify([{ to: saleAddress, data: "0x11b2d3c6" }, "latest"]);
case "eth_getTransactionReceipt":
  // The purchase transaction hash of the buy step.
  return JSON.stringify([purchaseTxHash]);
```

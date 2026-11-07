# Customer app (`packages/app`)

The customer web app of anon-credit. One page, React 19 and Vite 8. A person buys a batch of
100 RPC units with a wallet, waits for the leaf to enter the tree, proves ownership of the batch
in the browser, opens an anonymous session at the gateway, and spends with signed requests.

Every state on the page comes from a real request or a real event. The app does not simulate a
step, does not label a request anonymous because of a header, and shows nothing that it did not
read from a service, the chain, or the SDK.

The app consumes the public API of `@anon-credit/sdk`, `@anon-credit/prover`,
`@anon-credit/anon-transport`, and `@anon-credit/protocol`. It does not change those packages.
What it had to work around is in [TODO-sdk.md](TODO-sdk.md) and in section 11.

Contents:

1. The page and its steps
2. Connect (step 0)
3. Wallet
4. Buy credit (step 1)
5. Wait for inclusion (step 2)
6. Open a session (step 3)
7. Spend (step 4)
8. Backup and restore (step 5)
9. What the gateway sees (step 6)
10. Run it
11. Known gaps

Source map:

| Path | What |
|---|---|
| `src/App.tsx` | Page state, the batch strip, the transport log |
| `src/components/Setup.tsx` | Step 0: URLs, prover build, passphrase, reset, connected values |
| `src/components/TopBar.tsx` | Deployment id, epoch clock, block tag badge, signer, transport toggle |
| `src/components/WalletModal.tsx` | Wallet connector: injected wallets, local key pairs, dev key |
| `src/components/BuyStep.tsx` | Step 1 |
| `src/components/InclusionStep.tsx` | Step 2 |
| `src/components/OpenStep.tsx` | Step 3 |
| `src/components/SpendStep.tsx` | Step 4 |
| `src/components/BackupStep.tsx` | Step 5 |
| `src/components/GatewayView.tsx` | Step 6 |
| `src/components/primitives.tsx` | Step lines, key-value lists, hex with copy, section frame |
| `src/lib/workbench.ts` | Builds transport, prover, encrypted store, and SDK client |
| `src/lib/settings.ts` | `VITE_*` defaults, `?store=` query, dev payer |
| `src/lib/wallet.ts`, `src/lib/eip6963.ts`, `src/lib/key-store.ts`, `src/lib/funding.ts` | Signers, discovery, local keys, shortfall |
| `src/lib/inclusion.ts`, `src/lib/tracker.ts` | Root selection helpers, step state records |
| `src/lib/observe.ts` | Transport wrapper that reports each request as an event |
| `src/lib/explain.ts`, `src/lib/format.ts`, `src/lib/public-inputs.ts` | Error words, display formats, public input labels |
| `dev/stack.ts` | Local stack: anvil, contracts, sidecar, issuer, gateway, Vite |

## 1. The page and its steps

The page has a connect panel (numbered 0) and six numbered steps. Each step is a `Section` with a
state word in its header:

| State | Header text | When |
|---|---|---|
| `locked` | waits for the step before | The input of the step does not exist yet |
| `idle` | ready | The step can run |
| `running` | in progress | A request is in flight |
| `done` | done | The last request of the step answered |
| `failed` | failed | A request failed or a service rejected it |

Inside a step, a `StepRecord` line has a glyph (`[ ]` pending, `[~]` running, `[x]` done,
`[!]` failed), a label, a time column (elapsed time while running, end time and duration when
finished), and detail lines. A line becomes `running` only when a request goes out, and `done`
or `failed` only when the response arrives (`src/lib/tracker.ts`).

| Step | Title | Input that unlocks it | What drives its state |
|---|---|---|---|
| 0 | connect | A passphrase of 8 or more characters | The build of the workbench: Nox worker ready, `GET /v1/config` of the gateway and the issuer, manifest hash, prover load, store unlock, deployment check |
| 1 | buy credit | A connected workbench and a connected signer | `createBatches`, the signed `CreditSale.buy` transaction, the receipt and its `Purchased` log |
| 2 | wait for inclusion | A purchase record from step 1 | Polls every 2 s: issuer topup, leaf events, issuer roots, gateway roots; the first-use delay against the epoch clock; the SDK root selection |
| 3 | open a session | An eligible root from step 2 | The path request, the proof, each upload chunk, and `POST /v1/open`, from transport events and SDK results |
| 4 | spend | A batch with an open session | `POST /v1/rpc` of one signed request; the stage markers come from transport events; the result comes from the SDK outcome |
| 5 | backup and restore | An unlocked store | `exportBackup` and `importBackup` of the SDK |
| 6 | what the gateway sees | An open response from step 3 | The open response, `POST /v1/session/status`, and `GET /v1/demo/peer` |

Below step 0, a strip lists every batch in the store (`client.batches()`): the first 10 hex
characters of the batch id, its state (`new`, `issued`, `active`, `exhausted`, `expired`), and
the units left. A click selects the batch for step 6. The strip refreshes after a purchase, an
eligible root, an open, a spend, and a restore.

At the bottom, a `details` element shows the transport log (the Nox worker lines, or the lines
of the direct transport) and the isolation keys used so far. The footer shows the gateway id.

## 2. Connect (step 0)

### The passphrase and the encrypted store

The passphrase field needs 8 or more characters. The SDK needs a non-empty passphrase. The
passphrase stays in React state for the lifetime of the page. It is not written anywhere. The
app passes it to the SDK at connect and to `importBackup` at restore.

The store is the SDK construction `openEncryptedStore` over `indexedDbStorage`
(`packages/sdk/src/storage.ts`):

| Part | Value |
|---|---|
| Database | IndexedDB, name from the settings (default `anon-credit-app`), one object store `records`, version 1 |
| Key derivation | PBKDF2-HMAC-SHA-256, 16 random salt bytes, 600,000 iterations for a new store; an existing store keeps its own count |
| Cipher | AES-256-GCM, 12 random IV bytes in front of each value |
| Additional data | The record key. A value cannot move to another key |
| Meta record | Plain JSON under the key `meta`: `format` `anon-credit/encrypted-store/v1`, `kdf`, `iterations`, `salt`, and an encrypted `check` value |
| Durability | Each write is one IndexedDB transaction with `durability: "strict"`. The promise resolves after the transaction completes |

The check value is decrypted at unlock. A wrong passphrase fails there with `storage_locked`,
not at the first record read.

Records in the store:

| Key | Written by | Content |
|---|---|---|
| `deployment` | SDK | The deployment identity checked at connect: `deployment_id`, `gateway_id`, `circuit_id`, `prover_manifest_hash`, `verifier_artifact_hash`, `payment_chain_id`, `sale_address`, `root_registry_address`, `epoch_seconds`, `batch_size` |
| `batch/<batch_id>` | SDK | One batch: `order`, `batch_id`, `commitment`, the secret `k`, the Ed25519 `session_secret` and `session_pub`, `delay_epochs`, `leaf` (index, leaf, insertion, eligible, and expiry epochs), `open_request`, `session` (remaining, units total, next seq, state, open and deadline epochs, frozen price table and its hash), `pending` (the journaled spend request), `retired` |
| `app/local-key/<address>` | App | A local secp256k1 key pair: `address`, `private_key`, `created_at`, `origin` (`generated` or `imported`) |

The app opens the same store a second time with the same passphrase (`appStore` in the
workbench) for the `app/` records. The SDK reads only `batch/` and `deployment`. The backup
reads only `batch/`. Local key pairs are not in a backup.

A store belongs to one deployment. If the `deployment` record has another `deployment_id`, the
connect fails with `deployment_mismatch`.

### Reset

The button `reset local store` needs two clicks. The second click runs
`indexedDB.deleteDatabase(name)` and reloads the page. This is the way out when the passphrase of
an existing store is lost. Batches that are not backed up are lost with it.

### The `?store=` query

`?store=<name>` in the page URL selects another IndexedDB database. The name must match
`^[a-z0-9-]{1,64}$`. Each database has its own passphrase, batches, and local keys. This gives a
second customer in one browser. Without the query, the name is `VITE_STORAGE_NAME`, or
`anon-credit-app`.

### Transport toggle

The top bar has two buttons, `nox` and `direct`. The default is `direct` when the gateway URL
host is `localhost`, `127.0.0.1`, or `[::1]`, and `nox` otherwise.

| Choice | Construction | Badge | Body limit |
|---|---|---|---|
| `nox` | `createAnonTransport({ readyTimeoutMs: 180000, bootstrapRpcUrl? })` from `@anon-credit/anon-transport`: the stock Nox worker of `@anon-rpc/browser-harness`, with the Nox specifier read from a Sepolia bootstrap RPC | `mixnet` | 40,000 bytes (`NOX_MAX_REQUEST_BODY_BYTES`) |
| `direct` | `directTransport()`: a plain `fetch` from this browser | `direct: not private` | none |

The Nox exit nodes call the gateway and the issuer from the public internet. They cannot reach
`localhost` or a private LAN address. A run through Nox needs both services behind public
HTTPS host names. The local stack of section 10 uses the direct transport for this reason.

The SDK refuses a direct transport unless `allowDirectTransport` is true. The app sets it to
true only when the toggle is on `direct`. With the direct transport, the gateway sees the IP
address of this browser. The badge, step 4, and step 6 say so.

A change of the toggle after an unlock rebuilds the workbench with the same store and the same
passphrase. Batches, secrets, and sessions stay. The inclusion and open results of the page are
cleared, so a batch in progress starts its step again.

`VITE_NOX_BOOTSTRAP_RPC_URL` sets the bootstrap RPC. Empty: the transport default for the
specifier chain.

### Prover build

The `prover` select has `auto`, `scalar`, and `threaded`. `auto` picks `threaded` when
`crossOriginIsolated` is true, else `scalar`. The Vite dev server and the preview server send
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, so
the page is cross-origin isolated and the threaded build can use `SharedArrayBuffer`. A host
without those headers gets the scalar build. It works and is slower.

The prover is `createBatchOpenProver({ manifestUrl: "/batch-open/prover-manifest.json",
manifestSha256, mode })` from `@anon-credit/prover`. Vite serves the repository `artifacts/`
directory as its public directory, so the manifest and the WASM files that it pins come from the
page origin.

### Manifest hash check

Before the prover loads, the app fetches `/batch-open/prover-manifest.json` with
`cache: "no-store"` and computes its SHA-256. It passes the digest to the prover (which refuses a
manifest with another digest) and to `createClient` as `proverManifestSha256`. The SDK compares
it with `prover_manifest_hash` of the issuer deployment. A difference is a `deployment_mismatch`
and the connect fails. The connected panel repeats the comparison in the row `manifest pin`.

### What the connect does, in order

The setup log lists each phase as it happens:

1. `starting the Nox worker (Anon-RPC harness)` or `direct transport: requests are not anonymized`.
2. `reading the gateway and the issuer configuration`: `GET <gateway>/v1/config` and
   `GET <issuer>/v1/config` through the transport on the isolation key `config`.
3. `hashing the served prover manifest`.
4. `loading the ProveKit prover (<mode>, crossOriginIsolated=<bool>)`.
5. `unlocking the encrypted store and checking the deployment`: `indexedDbStorage`, then
   `createClient`. The SDK reads `GET /v1/config` and `GET /v1/prices` of the gateway and
   `GET /v1/config` of the issuer again, and checks: the issuer `deployment_id` is the keccak256
   of its deployment; gateway and issuer agree on `deployment_id`, `gateway_id`, `circuit_id`,
   `verifier_artifact_hash`, and `epoch_seconds`; the manifest pin; and the price table hash of
   `/v1/prices` equals the config value and the canonical encoding.
6. `ready: deployment <id>…, <n> s epochs, block tag <tag>`.

`createClient` gets `maxFirstUseDelayEpochs` from `VITE_MAX_FIRST_USE_DELAY_EPOCHS` (0 to 3,
default 1) and `pollMs: 2000`.

The connected panel then shows: payment chain, sale contract, gateway id, epoch length, batch
size, the prover (mode, threads, constraint count, load time), the manifest pin, the transport
(kind and ready time), and the price table as `method=units` pairs.

`disconnect` disposes the prover, closes the transport, and clears the page state. The store
stays.

## 3. Wallet

The `connect wallet` button of step 1 opens the wallet modal. The modal has three groups.

### Injected wallets (EIP-6963)

The modal adds a listener for `eip6963:announceProvider` and dispatches
`eip6963:requestProvider`. Each announcement is validated (`uuid`, `name`, a `data:` icon,
`rdns`, and a provider with a `request` function) and listed once by `uuid`. When no wallet
announces itself and `window.ethereum` exists, one row `window.ethereum` is offered instead.
With neither, the list says `no wallet extension found in this browser`.

A click runs `connectProvider`: a viem wallet client over the provider, `requestAddresses`,
then `ensureChain`. `ensureChain` reads the chain id and, when it differs from the deployment
`payment_chain_id`, calls `wallet_switchEthereumChain`. If the switch fails and the app knows an
RPC URL for the chain, it calls `wallet_addEthereumChain` and switches again. For Sepolia the
chain definition is viem's `sepolia`. For another chain id with no RPC URL, the switch error is
thrown as it is. A wallet that stays on another chain fails with
`the wallet is on chain <a>, the deployment needs <b>`.

An injected signer signs with `eth_sendTransaction`. Its balance is read through the provider.

### Local key pairs

A local key pair is a secp256k1 private key made in the browser with viem
(`generatePrivateKey`, `crypto.getRandomValues`). It is stored in the app store under
`app/local-key/<address>`, encrypted under the passphrase. A key that is already stored is
returned as it is.

| Control | What it does |
|---|---|
| `new key pair` | Makes and stores a key |
| `import a private key` | Normalizes the text (trim, lowercase, `0x` prefix), checks 64 hex digits, stores it with origin `imported` |
| `export` | Two clicks: the second reads the record and shows the private key until `hide` |
| `etherscan` | Address link on Sepolia and mainnet |
| Address button | Connects the key as signer: a viem wallet client with `http(VITE_DEV_RPC_URL)` |

A local key needs an HTTP RPC to read the chain and to broadcast. Without `VITE_DEV_RPC_URL`,
the group explains that and the address buttons are disabled. The RPC must be on the payment
chain: `connectPrivateKey` reads `eth_chainId` and refuses another chain.

The balance of each stored key is read every 10 s through that RPC and shown with the read
time. To buy, send Sepolia ETH to the address: one batch costs `batch_price_wei` (0.0001 ETH on
the testnet deployment) plus gas.

### The dev key

When the build has `VITE_DEV_PAYER_KEY` and `VITE_DEV_RPC_URL`, a third group `environment`
offers `dev key from the environment`. It is a private key signer like a local key pair. The
local stack sets it to the anvil test account index 2. It is a build-time value, not a wallet.

### Signer in the top bar

The connected signer shows its name, short address, and balance. The balance is read through
the signer's RPC every 10 s and once more after a purchase. `disconnect` next to it drops the
signer only. The workbench stays.

### Shortfall and gas estimate

Step 1 reads `CreditSale.batchPriceWei()` once per signer through the signer's RPC and
`eth_gasPrice` every 10 s. The cost of `n` batches is (`src/lib/funding.ts`, the same formula as
`checkFunding` in `packages/sdk/src/purchase.ts`):

```text
payment = batch_price_wei * n
gas     = (80,000 + 30,000 * n) * gas_price * 2
total   = payment + gas
missing = max(0, total - balance)
```

The row `gas estimate` shows `gas` as `<eth> (2x margin at the current gas price)`. A value
below 0.000001 ETH is shown in gwei. The buy button is disabled while `missing > 0` and its
label says `balance short by <missing> for <n> batches (<payment> + <gas> gas)`.

## 4. Buy credit (step 1)

The count field takes 1 to 100 batches. The step has three lines.

### `make batch secrets and commitments in the browser`

`client.createBatches(n)` makes, for each batch, 32 random bytes `k` from WebCrypto, an Ed25519
session key pair, and a random first-use delay (0 to `maxFirstUseDelayEpochs` epochs). It
computes with Poseidon2 (`@anon-credit/crypto`, domains in `fixtures/protocol/domains.json`):

```text
c        = H(DOM_COMMITMENT, deployment_id_hi, deployment_id_lo, k_hi, k_lo)
batch_id = H(DOM_BATCH_ID,   deployment_id_hi, deployment_id_lo, k_hi, k_lo)
```

The record goes to the store before the function returns. Only `batchId` and `commitment`
come back to the page. The detail lines show the count of secrets and each commitment.

### `signer signs CreditSale.buy(commitments)`

`sendBuy` sends one transaction to `sale_address` with the calldata of
`buy(bytes32[] commitments)` (`buyCalldata` of `@anon-credit/sdk/purchase`) and
`value = batch_price_wei * n`. The contract reverts on any other amount. The detail says who
signs: `<wallet> signs with eth_sendTransaction`, or `the local key signs in this browser and
broadcasts over the configured RPC`. The line finishes when the signer returns the transaction
hash. An Etherscan link appears for Sepolia.

### `transaction mined, Purchased event read`

`waitForPurchase` waits for the receipt (timeout 600 s). A reverted receipt fails the line. It
then finds the log of the sale contract that decodes as
`Purchased(address indexed payer, uint256 indexed purchaseId, bytes32[] commitments, uint256 amount)`
and shows block number, log index, purchase id, and amount. A receipt without that log fails.

The step then emits a `PurchaseRecord` (transaction hash, log index, block, payer, chain id,
batches) to the page. The first batch of the purchase becomes the selected batch and step 2
starts.

## 5. Wait for inclusion (step 2)

The tracker (`InclusionStep.tsx`) polls every 2 s. Each poll runs the six lines in order and
stops at the first one that is not done. Every detail line is text from a response, with the
UTC time of the read. A failed request on a running line adds
`request failed: <code>: <text>; next try in 2 s` and the loop continues.

| Line | Request | Isolation key | Done when |
|---|---|---|---|
| `payment seen by the issuer` | `GET /v1/topups/{tx_hash}/{log_index}` at the issuer | `purchase:<first 16 hex of tx hash>` | `status` is `issued` |
| `leaf appended to the Merkle Mountain Range` | `client.attachIssuance(issuance)`, then `GET /v1/events/leaves?from={first leaf index}&limit={n}` | `registry:<batch_id>` | The SDK stored the leaf and the events were read |
| `root posted to RootRegistry` | `GET /v1/roots` at the issuer | `registry:<batch_id>` | A record at or after the eligible epoch, with `leaf_count > leaf_index` and a `tx_hash`, has status `included` or `finalized` |
| `root visible at the gateway` | `GET /v1/roots` at the gateway | `<batch_id>` | A root with `source_epoch >= eligible_epoch` and `leaf_count > leaf_index` is in the list |
| `first-use delay (chosen in the browser)` | none; the epoch clock | | Current epoch `>= eligible_epoch + delay_epochs` |
| `eligible root selected` | `client.waitForEligibleRoot(batchId)` | gateway: `<batch_id>`; issuer: `registry:<batch_id>` | The SDK returns a root |

Details of each line:

- Topup. A 404 says `issuer answers 404 not_found: the indexer has not read block <n> yet`. The
  app does not call `POST /v1/topups`: the issuer allows CORS for `GET` only, and the indexer
  issues every purchase on its own. A `pending` status shows its reason: `awaiting_receipt`,
  `awaiting_finality` (with the payment block and the confirmed block), `finality_unavailable`,
  or `chain_unavailable`. A `rejected` status fails the line with `payment_invalid`.
- Leaf. `attachIssuance` matches each issued leaf to a stored commitment and checks
  `leaf = H(DOM_LEAF, c, K=100, expiry)`. A different leaf is `proof_check_failed`. The detail
  shows the leaf index, the leaf count, the insertion epoch, the eligible epoch, the expiry
  epoch, and how many `LeafAppended` events have the same index and leaf.
- Posted. The issuer record statuses are `pending`, `submitted`, `failed`, `skipped`,
  `included`, `finalized`. The detail shows the epoch, status, leaf count, root prefix, and
  transaction hash. For `failed` or `skipped`, the line says `the next epoch replaces it`.
- Visible. The detail shows how many roots the gateway accepts and, when found, the source
  epoch, leaf count, and root prefix.

### Eligible and the root selection rule

A leaf inserted in epoch `e` has `eligible_epoch = e + 1`. The issuer publishes the root of
epoch `e` after `e` closes, so that root carries the leaf and its source epoch is `e`.

The SDK rule (`selectRoot` in `packages/sdk/src/open.ts`): take the gateway roots, newest
source epoch first. Pick the first with `source_epoch >= insertion_epoch` and
`leaf_count > leaf_index` whose issuer record with status `finalized` has the same `root` and
`leaf_count`. The gateway and the issuer must agree. The detail says
`root of epoch <e>, <n> leaves, agreed by the issuer and the gateway`. The SDK polls every
2 s (`pollMs`) up to two hours.

The lines `posted` and `visible` of the app use `eligible_epoch` as the lower bound; the SDK
rule uses `insertion_epoch`. With one root per epoch both pick the same root.

### The epoch clock

`epoch = floor(unix seconds / epoch_seconds)`. The top bar and step 2 show the epoch number, a
ten-cell bar of the elapsed part, and the seconds until the next boundary. The clock ticks
every 250 ms from `Date.now()`.

### The block tag badge

`GET /v1/config` of the gateway reports `block_tag`. The badge says `block tag <tag>` and adds
`(demo)` with a warning color unless the tag is `finalized`. Step 2 explains: with `finalized`,
a payment counts after Sepolia finality (about 13 minutes); with `latest`, there is no finality
wait and a reorg can undo it.

### First-use delay

`delay_epochs` is chosen once per batch at `createBatches`, uniform in
`0..maxFirstUseDelayEpochs`. The app passes `VITE_MAX_FIRST_USE_DELAY_EPOCHS` (default 1). The
line shows `<d> epoch(s): open from epoch <e>, now <n>` while it waits, and the key-value list
shows `first-use delay: <d> epoch(s), random, chosen once per batch in this browser`.

## 6. Open a session (step 3)

The button `prove and open` runs two SDK calls, `prepareOpen` and `submitOpen`. The `upload`
select has `auto`, `chunked`, and `inline`. `auto` is chunked through Nox (the transport is
`anon`, or the inline request is above `transport.maxBodyBytes`) and inline on the direct
transport.

### `fetch the membership path and check it locally`

`prepareOpen` checks the stored leaf again, then requests
`GET /v1/tree/path/{leaf_index}?root={root}` at the issuer on `registry:<batch_id>`. It checks
the response locally with `@anon-credit/crypto`: the root and the leaf are the expected ones,
the proof has the leaf index, `checkMembershipProof` passes, and the proof leaf count equals the
root leaf count. The line finishes on the transport event of the answer.

### `prove in the browser (ProveKit, hiding witness)`

`proof_epoch` is the current epoch. The SDK builds the witness, compares its public inputs with
`batchOpenPublicInputs` (the vector the gateway builds), and calls the prover. The line runs
from the path answer until `prepareOpen` returns. Its detail shows
`witness <ms>, proving <ms>, total <ms>`, the proof size in bytes (JSON), the WASM memory when
known, and the proof epoch. The SDK then signs the open message (238 bytes: domain
`anon-credit/open`, version, `deployment_id`, `gateway_id`, `batch_id`, `root`, `leaf_count`,
`proof_epoch`, `session_pub`, `price_table_hash`) and stores the request as `open_request`.

### `upload the proof`

With a chunked upload the SDK (`packages/sdk/src/upload.ts`):

1. Compresses the JSON proof with `CompressionStream("gzip")`: encoding `json+gzip`, about
   318 KB from about 475 KB. Without `CompressionStream`, the encoding is `json`.
2. Picks the chunk size: the smallest of 40,000 (`OPEN_CHUNK_MAX_BYTES`),
   `limits.open_upload_chunk_bytes` and `limits.open_upload_chunk_body_bytes` of
   `GET /v1/config`, and `transport.maxBodyBytes`. A 318 KB proof gives 8 chunks.
3. Sends each chunk as `PUT /v1/open/chunks/{batch_id}/{proof_sha256}/{total_bytes}/{chunk_count}/{chunk_index}`
   with the raw bytes as `application/octet-stream`. The path carries the metadata; the body has
   no JSON and no base64. `proof_sha256` is the SHA-256 of the whole encoded upload.
4. First pass: 8 chunks in flight at the same time, one attempt each, on the isolation key of
   the batch. Second pass: the chunks that failed with a retryable error, one at a time, up to
   3 attempts 500 ms apart, with the same bytes. After a fallback, later uploads of this client
   use one chunk at a time. The gateway must report `complete: true` on the last chunk.

The chunk strip shows one cell per chunk: `·` waiting, `↑` sent, a number for the
acknowledgement time in ms, `!` failed, with a mark for a chunk sent more than once. The cells
are built from the transport events of the `PUT` requests (`src/lib/observe.ts`). The line
finishes when the open request goes out, with
`<encoding>: <proof> → <upload> in <n> chunks, <p> in flight, <s> PUT request(s)[, sequential fallback used], <time>`.
Inline: `the proof went inside POST /v1/open`.

### `gateway verifies the proof and opens the session`

`POST /v1/open` on the batch isolation key. With a chunked upload the body has `proof_upload`
(`proof_sha256`, `total_bytes`, `proof_encoding`) in place of `proof`; the signature does not
change. The detail shows the body size and the HTTP status, then
`proof verified, session opened: <remaining> units, next seq <n>, open epoch <e>, deadline epoch <d>`,
or `existing session returned (exact retry)` when the response has `existing: true`. The SDK
refuses a response for another batch or session key, or with another price table hash, and
stores the session with the frozen price table.

Below the lines: the session public key, the frozen price table hash, and the open round trip
(upload and `POST /v1/open`).

### The ten public inputs

After the proof exists, a table lists the public inputs in circuit order
(`fixtures/protocol/batch-open-public-inputs.json`). Everything else in the witness is private:
`k`, the leaf index, the path, the expiry.

| Index | Name | Meaning |
|---|---|---|
| 0 | `circuit_id` | Which statement was proven |
| 1 | `deployment_id hi` | Upper 16 bytes of the deployment identity |
| 2 | `deployment_id lo` | Lower 16 bytes |
| 3 | `gateway_id hi` | Upper 16 bytes of the gateway identity |
| 4 | `gateway_id lo` | Lower 16 bytes |
| 5 | `root` | MMR root that holds the leaf |
| 6 | `leaf_count` | Leaves under that root (the anonymity set) |
| 7 | `proof_epoch` | Epoch the proof was made for |
| 8 | `batch_id` | `H(DOM_BATCH_ID, deployment_id, k)`: the only value that names the batch |
| 9 | `binding` | `H(DOM_BINDING, gateway_id, session_pub)`: binds the session key to this gateway |

### `proof_epoch_stale`

The gateway accepts the current or the previous epoch. When `POST /v1/open` answers
`proof_epoch_stale`, the open line notes
`proof_epoch_stale: the gateway wants the current epoch; proving again`, the app calls
`prepareOpen` again with the same root, and submits again. An exact retry of a chunked open
sends the chunks again: the gateway removes an upload when it consumes it.

## 7. Spend (step 4)

Step 4 unlocks when a batch has an open session: the batch opened in step 3, or else the first
batch with state `active` in the store. `client.session(batchId)` gives the `Session`.

The key-value list shows `units remaining` (of `batch_size`), `next sequence`, `units spent`,
and `session state` from the stored session record.

### Price table and units

The method select is built from `client.priceTable.units` (`GET /v1/prices`, version 2). The
session freezes this table and its hash at open; new prices affect only new sessions.

| Method | Units | Default params in the app |
|---|---:|---|
| `eth_chainId` | 1 | `[]` |
| `eth_blockNumber` | 1 | `[]` |
| `eth_getBalance` | 2 | `[VITE_TEST_ADDRESS, "latest"]` (default `0x…dead`, not the payer) |
| `eth_call` | 3 | `[{ to: sale_address, data: "0x11b2d3c6" }, "latest"]`: `CreditSale.batchPriceWei()` |
| `eth_getTransactionReceipt` | 2 | `[<purchase tx hash>]`, or 64 zero digits without a purchase |

The params field is a JSON array; other text gives a local error entry. The send button shows
the units of the method and is disabled while `remaining < units`.

### How a request is signed

`Session.rpc(method, params)` (`packages/sdk/src/session.ts`, `spend.ts`):

1. `rpc_bytes` = UTF-8 of `{"jsonrpc":"2.0","id":<seq>,"method":...,"params":[...]}`. The id is
   the sequence number. The SDK keeps these exact bytes.
2. `seq` = `next_seq` of the session; `units_total` = stored `units_total` + units of the method.
3. The signature is Ed25519 with the session key over `keccak256` of the spend message:

| Offset | Size | Field |
|---:|---:|---|
| 0 | 32 | Operation domain `anon-credit/spend`, zero padded |
| 32 | 2 | Protocol version (u16) |
| 34 | 32 | `deployment_id` |
| 66 | 32 | `gateway_id` |
| 98 | 32 | `batch_id` |
| 130 | 32 | `price_table_hash` (frozen at open) |
| 162 | 8 | `seq` (u64) |
| 170 | 8 | `units_total` (u64, cumulative, this request included) |
| 178 | 4 | `rpc_byte_length` (u32) |
| 182 | n | `rpc_bytes` |

4. The signed request is written to the store as `pending` before it is sent (the journal).
5. `POST /v1/rpc` with `{ protocol_version, batch_id, seq, units_total, rpc (base64),
   signature (base64) }` on the batch isolation key.

### Stages

Four markers under the compose row: `signing (Ed25519 over the exact bytes)` from the click
until the transport event of `POST /v1/rpc`; `sent through Nox` or `sent directly (not
private)`; `gateway answered` on the response event; `received, state saved` when `rpc`
returns. The active marker shows its elapsed time.

### What the response carries

A successful response is the raw JSON-RPC body of the upstream and three headers:
`x-anon-remaining`, `x-anon-next-seq`, `x-anon-replayed`. The SDK reads them. When a transport
does not give the headers, the SDK makes a signed `POST /v1/session/status` call and takes the
state from it. Each console entry shows: time, `seq`, method, `-<units>`, `<remaining> left`,
`next <seq>`, round trip, `replayed, no charge` when `x-anon-replayed` was `true`,
`state from the signed status call` when the headers were absent, `<n> sends` when the SDK
sent more than once, and the body (`more` expands it and shows the params).

### Replay and sequence rules

- A transport failure, `busy`, `upstream_failed`, or `storage_unavailable` is not charged. The
  SDK sends the same bytes and the same signature again, 3 sends 1,000 ms apart. A request that
  still has no answer stays `pending`; the next `rpc` call fails with `pending_request` until
  `resume()` delivers it.
- The gateway keeps the response of a committed sequence for at least 60 s. A replay with the
  same bytes returns it with `x-anon-replayed: true` and no new charge. The same sequence with
  another body is `sequence_conflict`.
- On `sequence_conflict` or `sequence_gap`, the SDK reads the signed status, drops the pending
  request, and throws. Nothing was charged.
- On `response_expired`, the SDK reads the status. If the gateway is past the sequence, the
  request was charged and the result is lost: `lost_result`. The SDK does not send a new charged
  request on its own.
- Any other rejection (`signature_invalid`, `insufficient_units`, `method_not_allowed`,
  `session_expired`, `invalid_request`) happens before a charge. The pending request is dropped.
- A JSON-RPC error object with HTTP 200 (for example a revert of `eth_call`) is a completed call
  and is charged.

### Errors in plain words

The console shows `<code>: <sentence>` from `src/lib/explain.ts`. Service codes:

| Code | Sentence |
|---|---|
| `invalid_request` | The service rejected the request format. |
| `proof_invalid` | The gateway verified the proof and rejected it. |
| `root_not_accepted` | The gateway does not accept this root. It is too old or not yet visible. |
| `proof_epoch_stale` | The proof is for an older epoch. A new proof is necessary. |
| `session_conflict` | This batch already has a session with another key. |
| `signature_invalid` | The session signature does not verify. |
| `sequence_gap` | The sequence number is ahead of the gateway. |
| `sequence_conflict` | This sequence number was used with a different request. |
| `response_expired` | The gateway charged the request, but the response is no longer kept. |
| `insufficient_units` | The batch has no units left for this method. |
| `session_expired` | The session is past its deadline. |
| `method_not_allowed` | The gateway does not serve this method or these parameters. |
| `upstream_failed` | The upstream RPC did not answer. Nothing was charged. |
| `storage_unavailable` | The gateway could not store the result. Nothing was charged. |
| `busy` | The gateway is busy. Try again. |
| `not_found` | The service has no record of this item. |
| `payment_invalid` | The issuer rejected the payment. |

SDK codes: `direct_transport_refused`, `transport_failed`, `invalid_response`,
`deployment_mismatch`, `proof_check_failed`, `batch_not_found`, `batch_not_issued`,
`session_not_open`, `pending_request`, `lost_result`, `method_not_priced`, `timeout`,
`storage_locked`, `backup_invalid`. Transport and prover errors show as `Transport: <text>` and
`Prover: <text>` with their own codes.

## 8. Backup and restore (step 5)

`export backup` calls `client.exportBackup()` and shows the string in a read-only text area
with `<n> batch record(s), <length> characters, format anon-credit/backup/v1`.

Format (`packages/sdk/src/backup.ts`):

```text
"acb1." + base64( payload | checksum )
payload  = UTF-8 JSON { format: "anon-credit/backup/v1", deployment, batches }
checksum = first 4 bytes of keccak256(payload)
```

`batches` is the list of `batch/` records as stored: batch secret `k`, session secret and
public key, `delay_epochs`, leaf metadata, open request, session state, pending request,
`retired`. `deployment` is the `deployment` record. The string has secrets. Keep it like the
passphrase.

Not in the backup: membership paths (the client fetches them again), and the `app/local-key/`
records of the wallet modal.

`restore` is enabled when the text starts with `acb1.`. It calls
`importBackup(storage, passphrase, text)`: decode, check the checksum and the schema, open the
store with the page passphrase, refuse a store of another deployment, write the `deployment`
record when the store has none, and add each batch whose `batch/<batch_id>` key does not exist.
Batches that are already in the store are unchanged. The result says how many records were added
and the batch strip refreshes.

## 9. What the gateway sees (step 6)

The step unlocks with the open result of step 3. Two columns.

Left, `gateway holds (from its responses)`. Each row is a field of a gateway response:

| Row | Source |
|---|---|
| batch id, session public key, units remaining, units spent, next sequence, open epoch, deadline epoch, price table hash | `session` of the `POST /v1/open` response, or of the last `POST /v1/session/status` response after `read signed status` |
| proof | The proof size of `prepareOpen`, with the note `verified once at open` |
| root used | The source epoch and leaf count of the selected root (the anonymity set) |
| source address of this session | `GET /v1/demo/peer` through the transport in use on the batch isolation key: `observed_ip`, `attribution`, `proxy_hop`, and the probe time. Shown only when `GET /v1/config` reports `demo_peer_enabled`; otherwise `not recorded: DEMO_IP_LOGGING is off at this gateway` |

`read signed status` calls `client.status(batchId)`: a signed `POST /v1/session/status` with a
random 32-byte nonce (status message: domain `anon-credit/status`, version, `deployment_id`,
`gateway_id`, `batch_id`, nonce). The SDK checks the echoed nonce and the session key and updates
the local session record. The note then says
`values from POST /v1/session/status at epoch <current_epoch>`.

Right, `gateway does not hold (and where it is)`:

| Row | Value |
|---|---|
| payer address | From the purchase record of this page, and on the chain |
| payment transaction | The purchase hash; on the chain |
| commitment c | From the batch record; in this browser and the issuer |
| leaf index | From the batch record; in this browser and the issuer |
| batch secret k | `in the encrypted store of this browser only` |
| session secret key | `in the encrypted store of this browser only` |
| your IP address | `behind the mixnet exit` with Nox; `visible: the direct transport is not private` with direct |
| your IP, direct probe | `GET /v1/demo/peer` with a plain `fetch` from this browser (`credentials: "omit"`), when `demo_peer_enabled` |

The probe requests carry no batch or purchase identifier. The note on the step says: different
observed addresses are evidence of routing, not proof against timing or content analysis.

## 10. Run it

### Scripts

| Command | What |
|---|---|
| `pnpm app:dev` (repository root) | `node dev/stack.ts`: the local stack and the page |
| `pnpm --filter @anon-credit/app dev` | Vite only, port 5175, against the services of the `VITE_*` variables |
| `pnpm app:build` | `vite build` |
| `pnpm app:check` | `tsc` for `src/` and `dev/`, then `vitest` |

### Environment variables (build time, Vite)

| Variable | Default | Use |
|---|---|---|
| `VITE_GATEWAY_URL` | `http://127.0.0.1:8081` | Gateway base URL; editable in step 0 |
| `VITE_ISSUER_URL` | `http://127.0.0.1:8080` | Issuer base URL; editable in step 0 |
| `VITE_NOX_BOOTSTRAP_RPC_URL` | empty (transport default) | Sepolia RPC that reads the Nox specifier |
| `VITE_MAX_FIRST_USE_DELAY_EPOCHS` | `1` | Largest first-use delay, 0 to 3 |
| `VITE_STORAGE_NAME` | `anon-credit-app` | IndexedDB database name; `?store=` overrides it |
| `VITE_DEV_RPC_URL` | empty | HTTP RPC for local key pairs and the dev key. Without it only an injected wallet can pay |
| `VITE_DEV_PAYER_KEY` | empty | Private key of the dev key signer (local test funds only) |
| `VITE_TEST_ADDRESS` | `0x000000000000000000000000000000000000dead` | Default address of `eth_getBalance` |

The default transport follows `VITE_GATEWAY_URL`: direct for a local host, Nox otherwise.

### Against the local stack

```sh
pnpm app:dev
```

`dev/stack.ts` starts, in order: anvil (chain 31337, 1 s blocks, port 8545), the contracts with
`forge script script/Deploy.s.sol:Deploy` (issuer = anvil account 1), a deployment TOML in a
temporary directory with a random `gateway_id` and the SHA-256 of the served manifest, the
verifier sidecar (`crates/prover/target/release/anon-credit-prover serve`, port 8083), the
issuer (port 8080, `ISSUER_INDEX_POLL_SECONDS=1`, `ISSUER_PUBLISH_POLL_SECONDS=1`), the gateway
(public 8081, admin 8082, `GATEWAY_ROOT_SOURCE=contract`, `GATEWAY_ROOT_POLL_SECONDS=1`,
`DEMO_IP_LOGGING=true`, `GATEWAY_CORS_ORIGINS=http://localhost:5175,http://127.0.0.1:5175`),
and Vite on port 5175 with `VITE_GATEWAY_URL`, `VITE_ISSUER_URL`, `VITE_DEV_PAYER_KEY` (anvil
account 2), and `VITE_DEV_RPC_URL` set. It builds the Rust binaries first and the prover WASM if
it is missing. Logs and databases go to a temporary directory that it prints. It stops only the
processes it started.

| Variable | Default | Use |
|---|---|---|
| `APP_STACK_EPOCH_SECONDS` | `30` | Epoch length of the local deployment |
| `APP_STACK_BLOCK_TAG` | `latest` | `finalized`, `safe`, or `latest` |
| `APP_PORT` | `5175` | Vite port |
| `APP_STACK_SKIP_BUILD` | unset | `1`: use the binaries that exist |

The page opens on `http://localhost:5175` with the direct transport. Pick the dev key in the
wallet modal, buy, wait about one epoch, open, spend.

### Against Sepolia with the services

Deploy and run the services as in [RUNBOOK.md](../../RUNBOOK.md) sections 3 to 5. Then:

```sh
VITE_GATEWAY_URL=https://rpc.example.org \
VITE_ISSUER_URL=https://registry.example.org \
VITE_DEV_RPC_URL=https://<sepolia rpc> \
pnpm --filter @anon-credit/app dev
```

Requirements:

- `GATEWAY_CORS_ORIGINS` of the gateway must include the page origin, `http://localhost:5175`
  and `http://127.0.0.1:5175`. The default and `config/testnet-demo.env.example` list only the
  e2e page (5173) and the dashboard (5174). The issuer allows any origin for `GET`.
- The gateway and the issuer must be public HTTPS for the Nox transport. For a local test
  against remote services, switch the toggle to `direct` (not private).
- The prover manifest served by the page (`artifacts/batch-open/prover-manifest.json`) must have
  the SHA-256 that the deployment pins. Otherwise the connect fails with `deployment_mismatch`.
- A payer: an injected wallet on Sepolia, or a local key pair funded with Sepolia ETH
  (`VITE_DEV_RPC_URL` set).

### Troubleshooting

| Symptom | Cause and action |
|---|---|
| `storage_locked: The passphrase is wrong or the stored data is damaged.` at connect | The IndexedDB store exists and was made with another passphrase. The check value does not decrypt. Type the passphrase of that store, use `?store=<other-name>`, or `reset local store` (two clicks; batches that are not backed up are lost). |
| `unsupported_platform: ... the browser does not supply a capability that the worker needs` from the Nox transport | The Nox worker refused to start on this page. Nox needs the page and the services on public TLS hosts; a page on `http://localhost` with local services cannot use it. Use the `direct` toggle for a local run. |
| `TypeError: Failed to fetch` at connect or in step 2 | The browser could not reach a service, or the gateway refused the origin. Check that the services run (`curl <gateway>/v1/config`, `curl <issuer>/v1/config`) and that `GATEWAY_CORS_ORIGINS` has `http://localhost:5175` (and `http://127.0.0.1:5175`). Restart the gateway after a change. |
| Purchase fails with `nonce too low` | The payer key is also the issuer key. The issuer sends `postRoot` every epoch (30 s on the testnet) from that account, so its nonce moves under the wallet. Use a different key for the payer: a local key pair, an injected wallet, or another funded account. |
| `deployment_mismatch: ... prover_manifest_hash is not the pinned manifest digest` | The served `artifacts/batch-open/prover-manifest.json` is not the one the deployment pins. Serve the pinned artifacts or make a new deployment. |
| `deployment_mismatch: the storage belongs to a different deployment` | The store was made against another deployment (for example an earlier local stack with a new random `gateway_id`). Use `?store=<name>` or reset the store. |
| Step 2 stays at `root posted to RootRegistry` | The publisher has not sent `postRoot` (issuer key not funded, or RPC down). Check the issuer log. |
| Step 3 fails with `root_not_accepted` | The root aged out (96 epochs) or the gateway has not read it. Run step 2 again with a new purchase, or wait and prove again. |
| `method_not_allowed` or `invalid_request` in step 4 | The params do not follow the gateway rules: `eth_call` needs `to`, `data` or `input` (not both), canonical hex quantities; `eth_getTransactionReceipt` needs `0x` and 64 hex digits; a block is a tag or a canonical hex number. |
| The prover row says `scalar` although `threaded` was expected | The page is not cross-origin isolated. Serve it with the COOP and COEP headers (the Vite dev server does). |

## 11. Known gaps

From [TODO-sdk.md](TODO-sdk.md), what the app works around in the current SDK:

1. Prover progress. The prover gives timing only after the proof exists. The app shows
   `proving` from the path answer (a transport event) until `prepareOpen` returns, and the
   real witness and proving split after. A progress hook would show the phases live.
2. Chunk upload progress. `submitOpen` returns `UploadStats` after the whole upload. The app
   rebuilds the per-chunk view from the `PUT /v1/open/chunks/...` requests that
   `observeTransport` sees. A hook in `sendChunks` would make the wrapper unnecessary.
3. Open pipeline phases. `prepareOpen` does the path fetch, the local check, the witness, the
   proof, and the signature in one call. The app separates `path` and `prove` by the transport
   event of the path request.
4. Spend stages. `Session.rpc` signs, journals, sends, and saves in one call. The app shows the
   stages from the transport events and the promise; the journal write is not visible.
5. Verify time. The gateway measures `verify_ms` but reports it only on the admin API. The
   customer does not see the verification time of their own open.
6. `POST /v1/topups` from a browser. The issuer allows CORS for `GET` only, so the app cannot
   register a payment. It polls `GET /v1/topups/:tx/:log` (404 until the indexer reads the
   block). This works because the indexer issues every purchase on its own.
7. Block tag and limits. `client.deployment` has no `block_tag`, `demo_peer_enabled`, or
   `limits`. The app reads `GET /v1/config` of both services itself through the transport,
   before `createClient` reads them again.
8. Price table version 2. The method select is built from `client.priceTable.units`, so new
   methods appear without a change. Default params exist for `eth_getBalance`, `eth_call`, and
   `eth_getTransactionReceipt`; a method without a case starts with `[]`.

Other limits of the app as it is now:

- The `proof_epoch_stale` retry in step 3 proves again without a limit on the count. The SDK's
  own `client.open` retries once.
- The page state (purchase, inclusion, open result) lives in React state. A reload keeps the
  store but starts the steps from the batch strip: step 4 finds the first `active` batch; steps
  2 and 3 need a new purchase to show their lines again.
- One signer at a time. Disconnecting the signer does not stop a purchase in flight.

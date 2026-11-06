# Implementation plan

Status: Ready to start; proof parameters and deployment inputs have explicit gates below
Date: 2026-11-07
Scope: One issuer, one gateway, one end-to-end script, and a gateway dashboard
Companions: [PRD.md](PRD.md), [Architecture.md](Architecture.md), [PROVER.md](PROVER.md)

## 1. Outcome

Build an example that performs a real credit purchase, waits for the credit to become valid, generates a local ProveKit proof, opens an anonymous session, and makes paid JSON-RPC reads through Anon-RPC.

The example is a script with assertions and a machine-readable result. It is not a wallet product. A small browser page exists only to run the browser prover and Anon-RPC harness.

Build a simple gateway dashboard. It shows sessions, requests, debits, proof verification, failures, and the source IP observed by the gateway. This lets the demo compare a direct connection with an Anon-RPC connection.

The dashboard must use real gateway events. It must not manufacture data or label a request anonymous because the client sent a header saying so.

## 2. Decisions made for this implementation

The user selected ProveKit, the repository layout, and direct testnet operation. The other choices in this table are implementation defaults. They resolve the earlier draft alternatives for this first build.

| Area | Decision |
|---|---|
| Repository | Rust workspace in `crates/`, TypeScript workspace in `packages/`, runnable examples in `examples/`. |
| Service language | Rust. |
| Rust service stack | Tokio, Axum, Serde, SQLx with SQLite, Reqwest, tracing, and Alloy for EVM access. Pin compatible versions during workspace setup. |
| TypeScript workspace | pnpm, strict TypeScript, ESM. Commit the lockfile. |
| Dashboard | React and Vite in `packages/dashboard/`. Server-Sent Events for live events. |
| Proof system | Native ProveKit Spartan/WHIR proof. Hiding mode enabled. No Groth16 wrapper. |
| Circuit frontend | Noir for the first circuit. Mavros is an alternative Noir compiler, not a different circuit language. |
| Client proving | Browser WASM in a dedicated worker controlled by the example page. |
| Anonymity transport | Existing Nox worker through `@anon-rpc/browser-harness`. Reuse the current demo's verified integration. |
| Payment | Native test ETH paid to an issuer-owned sale contract. Exact whole batches only. |
| Payment and root chain | Sepolia, chain ID 11155111. Deploy contracts directly to testnet. No local chain or fork-based example. |
| Gateway upstream chain | Sepolia, chain ID 11155111. Validate the configured upstream with `eth_chainId`. |
| Tree | Append-only Merkle Mountain Range. Fetch complete membership proofs for selected roots in the first version. |
| Batch size | `K = 100` units, fixed in a deployment. |
| Batch price | Default testnet price: `100000000000000` wei per batch, fixed in the sale deployment. |
| Storage | Separate SQLite databases for issuer and gateway. WAL mode and durable transactions. One gateway process. |
| Session authorization | Ed25519 key pair per batch, generated locally. |
| RPC support | Read-only allowlist. One JSON-RPC object per request. No subscriptions or JSON-RPC request arrays. |
| IP diagnostics | Enabled for the requested demo dashboard. Disabled in the normal service profile. |
| Later scope | Dispenser service, custom combined Anon-RPC worker, refunds, fiat payments, and multiple gateways are deferred. |

SQLite replaces the RocksDB plus separate replay-cache proposal for this build. It lets the debit and recoverable response share one database transaction. This is not a claim that SQLite will meet the earlier high-load capacity targets.

Sources for integration details: [ProveKit](https://github.com/worldfnd/provekit), [ProveKit browser SDK](https://www.npmjs.com/package/@worldcoin/provekit), [SQLx SQLite](https://docs.rs/sqlx/latest/sqlx/sqlite/index.html), [Anon-RPC specification](https://github.com/ethereum/anon-rpc/blob/main/SPEC.md).

## 3. Remaining decisions and gates

No product name or visual design decision blocks the first build. Use `anon-credit` as an internal package prefix. The following items need evidence or deployment values, rather than an invented answer.

| Item | Working choice | How to close it | Blocks |
|---|---|---|---|
| ProveKit version | One pinned commit and compatible SDK, Noir compiler, and proof artifacts. | Compile the sample, prove in Chromium, verify in Rust, and reject a modified proof. Record every version. | Circuit integration. |
| Circuit hash | Poseidon2 over the field supported by the selected Noir/ProveKit stack. | Pin the exact permutation, sponge rules, constants, input encoding, and output width. Match Rust, WASM, and circuit vectors. | Protocol freeze. |
| Proof commitment hash | A supported hash-based ProveKit configuration. | Confirm hiding support, verifier compatibility, and security parameters for the pinned version. Keep this separate from the circuit hash. | Protocol freeze. |
| Security level | Post-quantum credential design; exact bit level not yet established. | Record classical and quantum bounds for hashes, commitments, and the proof transcript. Do not equate a library's classical parameter with quantum security. | Production security claim. |
| Proof resource limits | 16 MiB HTTP body limit for the prototype open endpoint. | Measure the actual proof and decoded memory cost; reduce the limit to a documented bound with margin. | Public service hardening. |
| Performance | Measure the existing 20 ms verification, 50 ms gateway-open, and 5 ms spend-overhead targets. | Benchmark the complete circuit and real gateway. Report failures to meet targets. | Performance claim, not the initial functional demo. |
| Public connectivity | Public HTTPS issuer and gateway endpoints; private admin access. | Supply hostname, certificate, host, upstream RPC, and funded Sepolia deployment. Verify reachability through Nox. | Live anonymity run. |
| Browser support | Chromium is required for the first end-to-end run. | Test scalar and threaded ProveKit builds. Extend browser support only after measurement. | Additional browser support. |

Do not silently replace ProveKit, remove hiding, or use a remote prover if a gate fails. Report the failed gate and revise the plan explicitly.

## 4. Repository layout

```text
Cargo.toml
Cargo.lock
rust-toolchain.toml
package.json
pnpm-workspace.yaml
pnpm-lock.yaml

crates/
  protocol/             Wire structures, signing bytes, errors, and configuration IDs
  crypto/               Hash encoding, Ed25519 checks, and shared cryptographic vectors
  registry/             MMR insertion, membership proofs, snapshots, and persistence
  prover/               ProveKit verifier adapter and native benchmark command
  issuer/               Sale indexing, credit issuance, root publication, and issuer HTTP API
  gateway/              Open, spend, recovery, upstream calls, events, and admin HTTP API

packages/
  protocol/             Runtime schemas, TypeScript types, byte encoding, and error codes
  crypto/               WASM interface to shared Rust hash and MMR operations
  prover/               ProveKit browser adapter, worker, artifact loading, and timing
  sdk/                  Purchase coordination, batch storage, sessions, and signed RPC fetch
  anon-transport/       Browser harness lifecycle, Nox configuration, and batch isolation
  dashboard/            Operator dashboard; consumes gateway admin API only

examples/
  e2e/
    run.ts              Node entry point; uses deployed testnet services and controls Chromium
    browser/            Minimal page that runs SDK, prover, and anonymous transport
    fixtures/           Test inputs and expected protocol results; no chain simulation
    README.md           Testnet command, funding, expected output, and required settings

circuits/
  batch-open/           Noir statement and circuit tests
contracts/
  src/                  CreditSale.sol and RootRegistry.sol
  test/                 Foundry contract tests
  script/               Sepolia deployment and verification scripts
config/                 Testnet deployment templates; no private keys
fixtures/
  protocol/             Shared encoding, hash, signature, and MMR vectors
artifacts/              Generated proof manifests and contracts; large binaries ignored
```

The existing `anon-rpc-demo/` remains a reference until its transport checks are covered by the new example. Do not delete it during workspace setup.

Dependencies flow from protocol and crypto into services and SDK. The gateway must not import issuer payment records. The dashboard must not depend on the client SDK or batch secrets.

Use runtime validation at all external boundaries. Follow the repository rules: no TypeScript casts, no `unknown`, and no `void` before calls. Use `switch` for multi-case state and error handling. Code comments use Simplified Technical English.

## 5. Deployment identity and proof artifacts

Define an immutable deployment configuration with protocol version, payment chain, sale address, root-registry address, issuer identity, gateway ID, batch size, epoch duration, credit lifetime, and circuit artifact hashes.

`deployment_id` is a digest of its fixed binary encoding. `gateway_id` is a separate random 32-byte value created at deployment. Neither is a customer identifier.

The gateway pins the verifier artifact and circuit ID. The client pins the matching prover manifest. A manifest fetched from the gateway does not establish its own trust; the example configuration must contain the expected digest.

Any change to circuit hash rules, `K`, tree rules, or epoch duration creates a new deployment. Do not accept proofs from the previous deployment under the new one.

## 6. Epochs, expiry, and root acceptance

Use integer Unix seconds and `epoch = floor(timestamp / epoch_seconds)`.

| Setting | Sepolia testnet deployment | Production |
|---|---:|---:|
| Epoch length | 30 seconds | 900 seconds |
| First-use random delay | 0 to 3 epochs | 0 to 3 epochs |
| Root window | 96 epochs (48 minutes) | 96 epochs (one day) |
| Credit activation lifetime | 35,040 epochs (about 12 days) | 35,040 epochs (one year) |
| Proof epoch acceptance | Current or previous epoch | Current or previous epoch |

The epoch length is a deployment setting, `EPOCH_SECONDS`. The testnet value of 30 seconds gives a fast demo. Epoch counts stay the same in both profiles, so the testnet root window and credit lifetime are shorter in wall-clock time. This is accepted for the demo.

A 30 second epoch does not shorten Sepolia finality. The issuer publishes one root per epoch, so the publisher sends about 2,880 root transactions per day and needs gas for them. A root record becomes acceptable only after its publication transaction is finalized, which takes about 13 minutes on Sepolia. Thus the first open after a purchase still waits for payment finality, root publication, and root finality. After that, each new epoch boundary passes in 30 seconds.

The example waits for actual Sepolia finality and epoch boundaries. It must not advance chain time, mine blocks, bypass confirmation, or use a faster local profile. Print progress while waiting. Payment finality, root publication finality, and the random delay can make the run take many minutes; use a configurable overall timeout with a two-hour default.

For this implementation, **credit expiry is the last epoch in which an unopened batch can be activated**. An activated session has its own public deadline: `open_epoch + 35,040`. It may spend through that deadline. This is an explicit semantic choice; it replaces the draft's ambiguous requirement to enforce a hidden expiry during spending.

The gateway can compute this deadline without learning the private credit expiry. It retains the spent marker at least until the session deadline plus the previous-epoch acceptance grace. Because issuance uses a fixed lifetime and open occurs after insertion, this retention extends beyond the batch's activation expiry. Test the boundary arithmetic and reject overflow.

If credit must instead stop spending at its original private expiry, change this policy before freezing the circuit. That requires a different deadline or renewal design; do not claim that the current row format enforces it.

A root record contains `source_epoch`, `leaf_count`, `root`, and the publication transaction. Leaves inserted in epoch `e` become eligible no earlier than `e + 1`, after root publication meets the chain policy. Accept roots from the last 96 source epochs, not merely the last 96 records. Late publication does not make a newer root valid for an earlier epoch.

The proof epoch is bound into the proof. A root may remain usable for 96 epochs while a proof made for one epoch becomes stale much sooner. Prepare paths and keys ahead of time; discard and regenerate stale proofs. Do not claim that precomputed proofs remain valid for a day.

## 7. Purchase and issuance

`CreditSale.buy(commitments[])` accepts an exact payment of `batch_price_wei * commitments.length`. It emits the payer, commitments, amount, and a purchase identifier. It rejects an empty purchase and duplicate commitments. Cap each purchase at 100 batches for the demo. Overpayments and underpayments revert; remainder balances are outside this build.

The contract sells credit for the issuer. It does not build the MMR or implement the later decentralized registry from FUTURE.md. Funds are custodial issuer revenue. Use an explicit issuer withdrawal function and test its authorization.

The issuer indexes successful sale events. It must verify the contract address, chain, event contents, receipt status, and canonical block. The client cannot assign commitments to an unrelated transfer.

Wait until the Sepolia transaction block is covered by the RPC's finalized block. If finality data is unavailable, issuance waits and reports the reason. Do not silently replace finality with a fixed number of blocks.

Key each payment by `(chain_id, tx_hash, log_index)`. In one issuer database transaction, record the payment and append each purchased leaf with issuer-computed insertion epoch and expiry. Retrying the same payment returns the existing issuance result. It never creates new leaves.

After an epoch closes, persist a pending root publication, submit it, and reconcile its receipt after restart. `RootRegistry` permits only the issuer to publish. It cannot overwrite a published epoch. The gateway reads finalized roots from that contract independently of the issuer HTTP response.

## 8. MMR and circuit statement

Keep the MMR, but remove the claim that new peaks alone always update an old membership path. The initial client fetches a complete proof against a selected published root. Incremental proof updates are deferred.

Specify a maximum of `2^32 - 1` leaves for the first deployment. Decompose `leaf_count` into peaks with descending heights. Hash leaf nodes and internal nodes under different domain tags. Include the parent height in each internal-node hash. The root commits to `leaf_count` and every occupied peak in its defined order.

The circuit uses fixed-size arrays for siblings and peak slots. It proves the selected peak and left/right path decisions from the private leaf index. Unused slots have a defined zero encoding. The root calculation and membership checks must constrain the peak height, index bounds, and padding. Do not accept a caller-selected path without these constraints.

The proof has these inputs:

| Public | Private |
|---|---|
| Protocol and circuit IDs | Batch secret `k` |
| Deployment ID and gateway ID | Private expiry |
| Root and leaf count | Leaf index and membership witness |
| Proof epoch | Session public key as a witness to the public binding |
| Batch ID | Other intermediate hash values |
| Session-key binding | |

Use a random 32-byte batch secret. Encode arbitrary 32-byte values as two bounded 128-bit limbs when mapping them into the circuit field; do not silently reduce arbitrary bytes modulo the field. Encode field outputs canonically and reject out-of-range wire values.

Retain the domain-separated commitment, leaf, and batch-ID construction. Include deployment identity in these domains so credit cannot move across deployments. Bind the session key and gateway ID through a constrained public binding. The gateway recomputes that binding from the received key and its configured identity.

The exact Poseidon2 parameter set and final domain-tag encoding are outputs of phase 1. They must be written into the protocol manifest and shared vectors before services issue credit. Do not invent constants separately in Rust, TypeScript, and Noir.

## 9. Request encoding and signatures

Use JSON envelopes with fixed schemas. Binary fields use lowercase hex for IDs and keys, and canonical base64 for proofs, signatures, and RPC bytes. Integers larger than the JavaScript safe range use decimal strings. Reject unknown envelope fields and invalid encodings.

Sign the exact RPC bytes, rather than a JSON object reserialized independently by Rust and TypeScript. The SDK encodes one UTF-8 JSON-RPC object and retains those bytes for retries. The gateway decodes and verifies those bytes, parses them with duplicate-key rejection, and forwards the same bytes upstream.

The spend signature is Ed25519 over a Keccak-256 digest of an unambiguous binary message containing:

```text
operation domain + protocol version
deployment_id + gateway_id + batch_id + price_table_hash
seq + units_total
rpc_byte_length + rpc_bytes
```

Use fixed-width big-endian integers and fixed-size IDs. Specify operation domains and field widths in `crates/protocol/`, with cross-language vectors. `seq` and `units_total` are unsigned 64-bit integers with checked arithmetic. Sequence numbers start at zero. `units_total` is the cumulative charge including the proposed request. It is not a future settlement mechanism in this build.

Open and status requests use separate signature domains. An open signature covers its public inputs and price-table hash, and proves possession of the session key. The proof separately establishes ownership of credit. Neither check replaces the other.

## 10. HTTP interfaces

All paths have a `/v1` prefix. Publish the runtime schemas with the protocol packages. Errors have a stable code, a safe message, and a retryable flag. Branch on codes, not message text.

### Issuer

| Endpoint | Purpose |
|---|---|
| `GET /v1/config` | Deployment settings, batch price, chain, contracts, and circuit ID. |
| `POST /v1/topups` | Register `{ tx_hash, log_index }` for tracking. Returns pending or the existing confirmed issuance. Does not mint from client claims. |
| `GET /v1/topups/:tx_hash/:log_index` | Read issuance status, leaf indices, expiry, and eligibility epoch. |
| `GET /v1/roots` | Published root records and chain confirmation status. |
| `GET /v1/tree/path/:leaf_index?root=...` | Complete MMR proof for one retained root snapshot. |
| `GET /v1/epoch` | Current epoch and seconds until the next boundary. |

Purchase tracking can use the payer connection. Fetch membership proofs through a separate anonymous connection before opening a spend session. Do not reuse a purchase request ID, cookie, or trace ID in gateway traffic.

### Gateway public API

| Endpoint | Purpose |
|---|---|
| `GET /v1/config` | Gateway identity, circuit ID, upstream chain, and resource limits. |
| `GET /v1/prices` | Versioned, content-addressed price table. |
| `GET /v1/roots` | Roots the gateway currently accepts. |
| `POST /v1/open` | Proof, public inputs, session key, price-table hash, and open signature. Returns session state. |
| `POST /v1/rpc` | Batch ID, sequence, cumulative units, exact RPC bytes, and signature. Returns the raw JSON-RPC response. |
| `POST /v1/session/status` | Signed batch ID and random nonce. Returns balance, next sequence, deadline, latest receipt metadata, and the echoed nonce. |
| `GET /v1/demo/peer` | Demo-only direct probe on the same public ingress. Returns the observed source address; accepts no batch or purchase identifier. Disabled in the normal profile. |

Successful RPC responses include balance, next-sequence, and replay indicators in response headers. Anon-RPC must preserve access to those headers. The client has authenticated status recovery if headers or responses are lost.

Error codes include `invalid_request`, `unsupported_version`, `proof_invalid`, `root_not_accepted`, `proof_epoch_stale`, `session_conflict`, `signature_invalid`, `sequence_gap`, `sequence_conflict`, `response_expired`, `insufficient_units`, `session_expired`, `method_not_allowed`, `upstream_failed`, `storage_unavailable`, and `busy`.

### Gateway admin API

Run the admin API on a separate listener, bound to loopback by default. Use a configured bearer token for snapshots and the authenticated streaming fetch used by the dashboard. Never put the token in a URL. The public RPC listener does not expose these routes.

| Endpoint | Purpose |
|---|---|
| `GET /admin/v1/snapshot` | Health, counters, root status, recent events, and session summaries. |
| `GET /admin/v1/events` | Server-Sent Events with monotonic event IDs and reconnect support. |
| `GET /admin/v1/sessions/:batch_id` | Session state and receipt metadata. No issuer payment lookup. |

## 11. Gateway state and transaction rules

### Open

Check body limits, schema, identities, price-table hash, proof freshness, root acceptance, open signature, and proof validity before inserting a session. Limit proof verification concurrency with a bounded queue.

Insert the session under a unique batch ID. A concurrent second insert cannot create another balance. Store the original open inputs and key.

An exact open retry with the same signed open request returns existing state, even if the proof epoch has since aged out. It must not reset units or sequence numbers. A request that tries to replace an existing session key returns `session_conflict`. Expired or spent state remains expired or spent.

### Spend

Serialize work per batch. One gateway process owns the database; multiple replicas are out of scope. After signature verification, hold the per-batch lock through sequence checking, upstream execution, and commit. Different batches may proceed concurrently.

For a new sequence, check session deadline, frozen prices, remaining balance, and cumulative units. Then call the configured upstream with a timeout. Do not hold a global SQLite write transaction while waiting for the upstream.

On a completed upstream response, commit the debit, next sequence, cumulative units, request digest, response bytes, and receipt in one durable transaction. Return success only after commit. If the commit fails, return `storage_unavailable`; never serve an uncommitted successful result.

A valid JSON-RPC result or error object returned with HTTP 200 counts as a completed RPC call and is charged. Connection errors, timeouts, non-200 HTTP status, malformed JSON-RPC, or an oversized response are upstream failures and are not charged. This distinguishes an RPC error from transport failure.

Read-only upstream work may run again after a crash before commit. The guarantee is one committed debit per sequence, not exactly-once upstream execution.

### Retry and recovery

Keep response bytes durably for at least 60 seconds after commit. Keep request digests and debit metadata through session retention. A replay with the same sequence and digest returns the stored response without another charge. A different digest returns `sequence_conflict`.

After response bytes expire, return `response_expired` with committed receipt metadata. The SDK checks authenticated session status before advancing. It reports the lost result; it does not silently create a new charged request unless the application asks to retry as a new operation.

Persist the client request bytes and signature before transmission. A restarted client resumes the pending operation. It never assigns the same sequence to a different request.

Back up the batch secret, session private key, deployment identity, leaf metadata, open request, and pending request state. Paths can be fetched again. Persistent client state uses encrypted IndexedDB; the example receives its unlock passphrase locally. Do not print it or include it in benchmark artifacts.

### Storage failure

Restore the gateway database before serving after data loss. Rotating the gateway ID does not restore spent markers and does not prevent the owner from making another proof. If state recovery is impossible, stop acceptance for that deployment.

## 12. RPC method table and limits

The initial table is fixed for an open session. New prices affect only new sessions.

| Method | Units |
|---|---:|
| `eth_chainId` | 1 |
| `eth_blockNumber` | 1 |
| `eth_getBalance` | 2 |

Validate method-specific parameter counts, addresses, and block selectors before forwarding. All other methods, notifications without IDs, and request arrays are rejected. Do not support `eth_call` or `eth_getLogs` until their execution and response-size limits are specified.

Prototype limits: 64 KiB spend envelope, 1 MiB upstream response, 15 second upstream timeout, and two concurrent proof verifications. Make these configured limits, publish them, and test rejection before expensive work. Benchmark memory before raising them.

## 13. Transport and browser execution

The Node runner controls Chromium through Playwright. The browser generates secrets, runs the prover, and sends requests. The Node runner holds only the test payment key and operational configuration; it receives commitments for the purchase, not batch secrets or session private keys.

Run the ProveKit worker alongside the Anon-RPC harness in the example page. Do not require the prover to run inside the Nox worker. Nox provides transport; it does not understand our credit protocol. Packaging both into a custom worker is later work.

Use one isolation key per batch for all open, spend, and status calls. Use a distinct isolation key for registry path retrieval. Await `worker.ready`. On transport failure, fail the anonymous run; do not fall back to direct fetch.

Use end-to-end HTTPS from the Nox worker to the gateway. The gateway must be reachable from the public exit network; `localhost` and a private LAN URL will not work for this run. The paid end-to-end flow always uses Nox. The separate demo peer probe is the only deliberate direct-connection comparison.

The existing demo uses a Sepolia bootstrap RPC to resolve the Nox specifier. Bootstrap, payment indexing, and gateway upstream access have separate configuration roles, even though all three use Sepolia in this implementation. Pin the chosen specifier and verify the bundle through the harness. Do not assume different isolation keys necessarily produce different exit IPs.

Disable browser tracing, HAR capture, and console dumps of private state in the end-to-end runner. The client sends only required protocol headers; it does not send payer identity, app identity, cookies, or purchase correlation IDs to the gateway.

## 14. Gateway dashboard and IP demonstration

The first dashboard has four simple views on one page:

1. Health and counters: gateway status, upstream chain, accepted root age, open sessions, request counts, units charged, and failure counts.
2. Live event list: UTC time, event kind, batch ID, sequence, RPC method, result status, latency, and observed source IP.
3. Session details: remaining units, cumulative units, next sequence, deadline, open proof size, verification duration, and recent receipts.
4. Connection diagnostics: socket peer IP, effective source IP when a trusted proxy is used, and the source of that attribution.

Events include `open_received`, `open_verified`, `open_rejected`, `session_opened`, `rpc_received`, `rpc_completed`, `rpc_replayed`, `rpc_rejected`, `upstream_failed`, and `storage_failed`. Emit successful debit events only after the transaction commits.

Use `DEMO_IP_LOGGING=true` for the demo. This explicitly overrides PRD R44 and the Architecture.md no-IP-log rule for the demo profile, as requested. Include IP in the in-memory dashboard event stream. Default retention is 10,000 events or 30 minutes, whichever is reached first. Diagnostic events are not the durable receipt ledger.

Use the actual socket peer address. Ignore `Forwarded` and `X-Forwarded-For` from arbitrary clients. If deployment uses a reverse proxy, accept the configured forwarding header only from an explicit trusted proxy address and validate the chain from the trusted end. Display the proxy hop separately. Configure proxy access logs consistently with the selected profile.

Show method names and byte counts. Do not log private keys, witnesses, full proof bytes, bearer tokens, cookies, or full RPC parameters and results. The gateway does not have a buyer identity to display for a batch. Do not add a hidden join from the example runner or issuer.

The operator can make a separate direct probe to `/v1/demo/peer` to obtain a baseline through the same public ingress. Do not use the private admin listener for this comparison: its socket may show only loopback or a private proxy. The anonymous paid session then shows the address observed for the Nox connection. Keep these observations separate from purchase data and session identifiers. Do not attach a common tracking token to direct and anonymous traffic. Configure CORS for the example and dashboard origins when they call the demo probe.

The dashboard must say "Observed source IP", not "Verified anonymous user". Different observed addresses are evidence of routing. They do not prove protection against timing analysis or content identification. The normal profile disables IP capture and reports the field as unavailable.

Use the admin token for dashboard access. Public deployment must keep the admin listener private or protect it behind authenticated HTTPS. No public unauthenticated stream of session activity.

## 15. End-to-end example

Planned commands, to be implemented:

```sh
pnpm example:e2e
pnpm dashboard:dev
```

`example:e2e` uses deployed Sepolia contracts, configured public HTTPS services, and the real Nox worker. It launches Chromium but does not start a chain or deploy contracts on every run. Deployments are a separate setup step. Supply funded testnet keys for the payer and issuer root publisher. The payer needs the purchase amount plus gas; the publisher needs gas for root updates. Stop before purchase if configuration or funding checks fail.

The browser runner and dashboard development server can run on the developer's machine. This does not introduce a local blockchain. There is one end-to-end network profile: Sepolia with Anon-RPC.

The script must:

1. Validate deployment identities, chain IDs, circuit artifacts, connectivity, and admin access.
2. Start the browser prover and transport. Generate three independent batch secrets and session keys in the browser.
3. Read the issuer price. Submit a purchase for the three commitments using the runner's test wallet.
4. Track the real sale transaction through issuer confirmation and leaf insertion.
5. Wait for a published eligible root and the configured first-use delay.
6. Fetch a complete membership proof over the registry transport and check it locally.
7. Generate the batch-open proof in the browser. Record duration, proof bytes, and available memory measurements.
8. Open the first batch through the selected transport. Assert `remaining = 100` and `next_seq = 0`.
9. Call `eth_chainId`, `eth_blockNumber`, and `eth_getBalance`. Use a fixed public test address unrelated to the payer. Assert remaining units `99`, `98`, and `96`, with next sequences `1`, `2`, and `3`.
10. Resend the exact first signed request within retention. Assert the same response and no new debit. Reuse its sequence with a different body and assert rejection.
11. Submit an invalid signature and a sequence gap. Assert no balance change.
12. Spend the remaining units of the first batch with one-unit reads. Assert a further spend fails and does not advance the sequence.
13. Open a second batch on a new isolation key and make a successful read.
14. For the third batch, try a modified proof before any valid open. Assert rejection and no session row. Then open the valid batch successfully.
15. Verify that dashboard events match committed balances and display actual connection observations in demo mode.
16. Save a sanitized result with step outcomes, timings, proof size, deployment settings, and a final pass/fail status. Exit nonzero on a failed assertion or timeout.

Use isolated service tests with injected storage, clock, and upstream adapters for database failures, upstream failure, lost responses, cache expiry, and restart recovery. These tests do not require a blockchain node. Do not expose fault-injection controls on deployed testnet services. The end-to-end script uses real testnet payments and published roots.

The runner's report can correlate its own steps for testing. That report is not evidence that issuer and gateway records are unlinkable, and it must not be ingested by the gateway dashboard. One test purchase also provides no meaningful anonymity set by itself.

Default service bind ports: issuer 8080, gateway public API 8081, gateway admin API 8082. Publish issuer and gateway APIs through HTTPS. Keep admin access private. Development browser-page and dashboard ports are 5173 and 5174. Allocate alternate development ports when occupied. Stop only child processes started by the runner; never stop deployed services on script exit.

## 16. Build order and completion checks

| Phase | Work | Completion check |
|---|---|---|
| 0. Workspace | Create Cargo and pnpm workspaces, package boundaries, configuration profiles, and checks. | Rust and TypeScript skeletons build; no secrets in tracked configuration. |
| 1. Proof feasibility | Pin ProveKit and Noir, build the full MMR batch-open statement, define hash encodings, and export compatible artifacts. | Browser proves, Rust verifies, all altered public inputs fail, and timing/size results are recorded. |
| 2. Credit issuance | Implement and deploy Sepolia sale/root contracts, issuer indexing, durable MMR snapshots, and publication recovery. | Real finalized Sepolia payment produces eligible leaves exactly once; unauthorized root writes and invalid payments fail. |
| 3. Gateway | Implement open, spend, receipt storage, status recovery, method pricing, and limits. | Replay, races, expiry boundaries, upstream failure, commit failure, and restart cases pass. |
| 4. SDK and testnet example | Implement browser state, request journal, proof adapter, Nox transport, and script assertions. Configure reachable HTTPS services. | Full Sepolia purchase-to-exhaustion run succeeds through Nox without mocked proofs or free credit. |
| 5. Dashboard | Implement admin snapshots, event stream, session views, and demo IP attribution. | UI reflects committed state; fake forwarding headers cannot replace the displayed source IP. |
| 6. Complete demo | Connect the testnet script to private dashboard access and verify source-IP attribution. | Script and dashboard demonstrate the same paid flow through Nox, with observed exit-side traffic and no direct fallback. |
| 7. Measurement | Run cold/warm proving, resource checks, and native gateway benchmarks. | Publish measured results with hardware, versions, parameters, and unmet targets. |

Required checks: Rust formatting, Clippy, Rust tests, TypeScript type checks, focused package tests, and Foundry contract tests in its in-process test EVM. These checks do not start a local network. The Sepolia end-to-end script is a separate required integration check because it depends on public network availability, finality, and funded testnet accounts. Do not replace it with a simulated purchase when the network is unavailable.

Security tests must cover the actual invariants: private-index path selection, domain separation, public-input binding, payment idempotency, cross-deployment rejection, exact retry handling, and debit durability. UI snapshot tests are not a substitute for these checks.

## 17. Changes from the earlier drafts

This plan governs the first implementation where the earlier drafts disagree:

- ProveKit replaces the generic STARK or local-sidecar choice.
- Rust replaces the Rust-or-Go option.
- All purchases, root publications, and example RPC reads use Sepolia directly. There is no local-network example.
- SQLite replaces RocksDB plus a separate replay cache.
- Whole-batch exact payments replace remainder accounting for the first example.
- Complete MMR proofs replace the unsupported peaks-only update rule.
- Expiry is explicitly an activation deadline, with a separate session deadline and conservative marker retention.
- Exact open retries return existing state. They do not create a second session.
- A successful response requires a durable debit commit.
- Client recovery includes session keys and pending signed requests.
- Demo IP logging is enabled for the requested dashboard; the normal profile keeps it disabled.
- The first example is a browser-driven script. The dispenser and custom worker are later work.
- FUTURE.md settlement and multiple-gateway rules are outside this implementation.

The protocol removes the billing identifier that connects a purchase to a spend session. Anon-RPC separately changes the network address observed at the gateway. The demo must present these as separate properties and must not claim that IP comparison proves cryptographic unlinkability.

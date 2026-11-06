# Architecture: Anonymous Prepaid RPC Gateway

Status: Draft 5
Date: 2026-11-06
Companion: PRD.md
Diagrams: https://claude.ai/artifact/CKBZnp4nn5WqizxGFhUEP1

## 1. Components

| Component | Runs where | Language | Responsibility |
|---|---|---|---|
| Registry service | Issuer server | Rust or Go | Sells batches, keeps the tree, posts roots, serves paths |
| Root contract | Any EVM chain | Solidity | Stores one root per epoch |
| Gateway | Operator server | Rust or Go | Verifies open proofs, tracks batch rows, serves JSON-RPC |
| Client SDK | Developer backend, or wallet | TypeScript | Batches, open proofs, sessions, signed requests |
| Prover | Next to the SDK | Rust, WASM later | Makes open proofs |
| Worker | Anon-RPC sandbox | TypeScript bundle | SDK packaged for the user-pays mode |

The registry and the gateway can be one operator or two.
The open proof carries a gateway id, so one registry can serve many gateways.

## 2. Data structures

All hashes are H with a domain tag. Keccak256 or Poseidon. Decide in D3.

### 2.1 Batch

```
k         random 32 bytes, made by the client, never shared
c         = H("c",    k)                 sent to the issuer at top-up
leaf      = H("leaf", c, K, expiry)      built by the issuer, appended to the tree
batch_id  = H("id",   k)                 revealed to the gateway at open
```

The issuer knows c and the leaf. It cannot compute batch_id, because that needs k.
The gateway knows batch_id. It cannot compute c or the leaf, because that needs k.
The two halves meet only inside the open proof.

### 2.2 Tree

- Append-only Merkle Mountain Range (MMR). Leaves are never changed or removed.
- The issuer stores every leaf and the peaks after every append.
- root(e) = bag of peaks at the end of epoch e. Posted onchain.
- Epoch length: 900 seconds. Epoch e = floor(unix_time / 900).
- A client stores its own path. Inside a completed subtree the siblings never change. Each epoch the client fetches the new peaks and recomputes the path to root(e). About 32 hashes per epoch.

### 2.3 Session key

Ed25519 key pair, made by the client per batch. The open proof binds to H(session_pub).
The private key lives in the client for the life of the session.

### 2.4 Open request

```
open {
  root:         bytes32      root of an epoch in the last 96
  epoch:        uint32       current epoch
  batch_id:     bytes32      H("id", k)
  session_pub:  bytes32      Ed25519 public key
  proof:        bytes        STARK, public inputs: root, epoch, batch_id, gateway_id, H(session_pub)
}
```

A STARK proof is 50 to 200 KB. It travels once per batch, in the request body.
There is no public-inputs field. The gateway builds the public inputs itself (5.1 step 4).

### 2.5 Spend request

```
spend {
  batch_id:  bytes32
  seq:       uint32          starts at 0, increases by one
  rpc:       object          JSON-RPC request
  sig:       bytes64         Ed25519 over H(batch_id, seq, gateway_id, rpc)
}
```

A few hundred bytes. No proof.

### 2.6 Gateway batch store

```
key:   batch_id (32 bytes)
value: remaining (4) | next_seq (4) | session_pub (32) | open_epoch (4)
```

RocksDB. 76 bytes per batch. 10 million batches = 760 MB.
Prune a row when open_epoch < now - session_lifetime, or when remaining = 0 and the replay cache has expired.
The gateway never learns the batch expiry. It is a private input of the open proof. The gateway keys pruning on its own open_epoch.

### 2.7 Replay cache

```
key:   (batch_id, seq)
value: response, expires in 60 seconds
```

In memory or Redis.

## 3. Open circuit

```
public:  root, epoch, batch_id, gateway_id, binding
private: k, expiry, path
checks:
  c = H("c", k)
  H("leaf", c, K, expiry) is in the tree under root via path      K is a circuit constant
  batch_id = H("id", k)
  epoch <= expiry
  binding = H(session_pub)                                        session_pub is a private witness
```

The gateway verifies this proof. It does not need the registry online.
Expiry is an opening deadline. The proof checks it at open. An opened batch stays usable until its units are spent or the gateway's session lifetime ends. Spend requests do not check expiry.
The proof system is a STARK over a hash-friendly field. Hash-based only, so the layer is post-quantum.
The verifier must run in less than 20 ms. The prover is open (PRD D1). Measure it first.

## 4. Flows

### 4.1 Top-up

1. The SDK makes N batch secrets k₁..kₙ and the commitments c₁..cₙ.
2. The customer pays the registry for N batches. Onchain: a transfer to the registry contract with the commitments in calldata. Offchain (v2): a payment with the commitments as the reference.
3. The registry waits for finality (4.1.1), builds leafᵢ = H("leaf", cᵢ, K, expiry) for each, and appends them.
4. The registry returns the leaf indices and the expiry. A remainder below one batch stays as a plain credit for the payer.
5. The SDK waits for the next epoch boundary.

The client never states K or the expiry. The issuer sets them.
A client that knows kᵢ can later open leafᵢ. A stolen commitment credits nobody.

#### 4.1.1 Payment finality and replay

- Onchain: credit after 12 blocks on mainnet, or the chain's finality rule.
- Onchain: key each credit by (chain id, tx hash, log index). A key already credited is rejected.
- Onchain: the commitments must appear in the calldata of the same transaction. A transfer without them is held and refunded by hand.
- Offchain (v2): key each credit by the provider's payment id. One credit per id.
- Offchain (v2): a payment with a chargeback window is credited after the window closes, or the operator prices in the risk. Open decision.

### 4.2 Sync

1. At the epoch boundary after insertion, the SDK fetches the path for each new leaf through Anon-RPC.
2. Each epoch after that, the SDK fetches the peaks for root(e) and recomputes its paths. About 1 KB.
3. On restore from backup, the SDK fetches paths once for every leaf it owns, through Anon-RPC.

### 4.3 Open

1. The SDK waits a random 0 to 3 epochs after the leaf became valid.
2. The SDK makes a session key pair and the open proof. Proofs are precomputed while idle, 3 ahead.
3. The SDK opens a fresh circuit (isolationKey = batch_id under Anon-RPC) and posts the open request.
4. The gateway runs the open pipeline (5.1) and stores the batch row.
5. The session is live. Up to K units.

### 4.4 Spend

1. The app calls fetch with a JSON-RPC request.
2. The SDK signs H(batch_id, seq, gateway_id, rpc) with the session key.
3. The SDK posts the spend request over the session's circuit.
4. The gateway runs the spend pipeline (5.2) and returns the JSON-RPC result.
5. The SDK advances seq.

### 4.5 Retry

1. A lost response is retried with the same seq and the same signature.
2. The gateway answers from the replay cache without a new debit.
3. After 60 seconds the cache entry is gone and the retry is rejected. The SDK treats the request as failed and moves on. Bounded loss: the units of one request.

### 4.6 Rotate and close

1. At zero units, or when the app asks for a fresh unlinkable window, the SDK drops the circuit.
2. The SDK opens the next batch over a new circuit (4.3).
3. The gateway keeps the old row until expiry so the batch id cannot be opened again, then prunes it.

### 4.7 Epoch boundary

1. The registry computes root(e) and posts it to the root contract.
2. The gateway reads the new root and keeps the last 96.
3. Leaves inserted in epoch e become valid.

### 4.8 Dispenser mode

1. The developer backend buys batches and runs 4.1 and 4.2.
2. A user session asks the backend for a batch.
3. The backend applies its own rate limit and returns one batch: k, leaf index, path, and a session key pair. Or it runs 4.3 itself and returns the live session key.
4. The browser SDK runs 4.3 and 4.4.

The backend sees its own users and which batch each got. The gateway sees none of them.

### 4.9 Worker mode

1. The wallet loads the gateway's worker through the Anon-RPC harness.
2. The worker holds the batches in scoped storage, encrypted with a passphrase.
3. The worker runs 4.2 to 4.6 by itself.
4. The worker reports remaining batches to the wallet through its log channel.

## 5. Gateway pipelines

The rule: verify everything, then write, then serve. No row is written before every check passes.

### 5.1 Open pipeline

| Step | Check | Cost | On fail |
|---|---|---|---|
| 1 | Body size and format | none | reject |
| 2 | root is in the last 96 roots, epoch is current or previous | map lookup | reject |
| 3 | batch_id is not in the batch store (read only) | Bloom + RocksDB read | reject |
| 4 | Build the public inputs locally: root and epoch from the request after step 2, batch_id from the request, gateway_id from the gateway's own configuration, binding = H(open.session_pub). Verify the STARK proof against exactly these values. | < 20 ms | reject |
| 5 | Insert the batch row. Compare-and-set on batch_id. | RocksDB write | reject, nothing written |

Step 4 never reads public inputs from the request body. The open request carries no public-inputs field. A proof captured from one open cannot be replayed with a different session key or at a different gateway, because the gateway recomputes the binding and the gateway id itself.
Step 5 is the only write. A race between two opens of one batch id leaves exactly one row.

### 5.2 Spend pipeline

| Step | Check | Cost | On fail |
|---|---|---|---|
| 1 | Body size and format | none | reject |
| 2 | Acquire the per-batch lock for batch_id. One active request per batch. A second request for the same batch waits, or is rejected after 5 s. | memory mutex | reject busy |
| 3 | Row lookup by batch_id | RocksDB read | release lock, reject |
| 4 | Ed25519 signature over H(batch_id, seq, gateway_id, rpc) with session_pub | ~50 µs | release lock, reject |
| 5 | seq == next_seq. If seq < next_seq: replay cache hit serves it, miss rejects. If seq > next_seq: reject. | memory | release lock, see cell |
| 6 | units = price[method]; remaining >= units | table | release lock, reject, row unchanged |
| 7 | Forward rpc to an upstream node | network | release lock, reject, row unchanged |
| 8 | On upstream success, in one write: remaining -= units, next_seq += 1, cache (batch_id, seq) -> response | RocksDB write | release lock, return an error, do not return the response |
| 9 | Release the lock. Return the response. | | |

Step 4 is the authorization check and runs before any state is touched.
Step 2 makes spending atomic. Two requests with the same seq cannot both pass step 5, because only one holds the lock at a time.
Step 8 is the only write. If the write fails the client gets an error and the row is unchanged, so the client retries the same seq. The upstream result is discarded. No service is given without a recorded debit.
Steps 6 to 8 keep the row unchanged on any failure.
The lock is per gateway process. A gateway that runs several processes shards batch ids across them so that one batch id always lands on one process.
The gateway does not log the IP address or the transport identifier at any step.

### 5.3 Why there is no global request-hash filter

Two sessions can send the same JSON-RPC body. They carry different batch ids. Replay protection comes from seq, never from the body.

## 6. Interfaces

### 6.1 Registry HTTP

```
POST /topup         { commitments[], payment_ref }   -> { leaf_indices[], expiry, epoch, remainder }
GET  /tree/root                                       -> { epoch, root }
GET  /tree/peaks?epoch=E                              -> [ peak ... ]
GET  /tree/path/:leaf_index                           -> [ sibling ... ]     reachable through Anon-RPC
GET  /tree/leaves?from=N                              -> [ leaf ... ]
GET  /epoch                                           -> { epoch, seconds_left }
```

### 6.2 Root contract

```
function postRoot(uint32 epoch, bytes32 root) external onlyIssuer;
function rootAt(uint32 epoch) external view returns (bytes32);
```

### 6.3 Gateway HTTP

```
POST /open          { root, epoch, batch_id, session_pub, proof }   -> { ok, remaining }
POST /rpc           { batch_id, seq, rpc, sig }                      -> JSON-RPC response
GET  /prices                                                         -> { method: units ... }
GET  /roots                                                          -> [ { epoch, root } ... ]
```

### 6.4 SDK

```ts
const client = createClient({ gateway, registry, prover });
await client.topUp(batches, payer);
const fetch = client.fetch;                     // drop-in fetch, opens sessions as needed
client.batches();                               // remaining batches and units
client.rotate();                                // close the session, open the next batch
client.exportBackup();                          // one string
```

Dispenser mode adds `client.issueBatch()` on the server and `createClientFromBatch(batch)` in the browser.

## 7. Transport

- The open proof and every request travel only inside TLS to the gateway. Never in a query string.
- The recommended Anon-RPC workers (Nox, tor-js) open TLS inside the sandbox, so exit nodes relay bytes they cannot read.
- One batch, one circuit. Requests inside a session are linkable by the gateway. Sessions are not.
- Hybrid post-quantum TLS is preferred when the stack supports it. It is not required, because the anonymity network's own layers are classical.

## 8. Storage and backup

- Worker mode: batches in Anon-RPC scoped storage (IndexedDB), encrypted with a passphrase.
- Backup string: one line per batch: k, leaf index, expiry. Base64 with a checksum. Paths are not backed up; they are refetched.
- Restore: import the string, fetch paths through Anon-RPC, continue.

## 9. Failure modes

| Failure | Effect | Handling |
|---|---|---|
| Registry down | No top-up, no new paths. Open sessions continue. Precomputed opens still work for 96 epochs. | Retry later |
| Root post late | New leaves wait one more epoch | Gateway keeps 96 roots, old batches still open |
| Gateway restarts | Batch store persists | No sessions lost. Replay cache is lost: in-flight retries fail once. |
| Batch store lost | Spent batches reopenable until rebuilt | Treat as an incident. Rotate gateway id. |
| Open proof rejected | Nothing written. Client-side bug or stale root. | Re-prove against a fresh root, log the reason |
| Response lost | Row unchanged or already advanced | Retry same seq. Cache answers, or the row shows the debit and the cache is gone: one request lost. |
| Upstream fails | Row unchanged | Retry same seq |
| Debit write fails after upstream success | Row unchanged, response discarded, client gets an error | Retry same seq. The upstream read runs again. |
| Two requests with one seq at once | Second waits on the per-batch lock, then fails the seq check or hits the cache | Client should not send concurrent requests on one batch |
| Session key leaked | Attacker can spend that one batch | Rotate. Scope is K units. |
| Proof queue empty | Next batch open waits for a proof | Warn the app. Raise the precompute target. Measure. |
| Anon-RPC worker fails | ready rejects | Fall back to a direct TLS connection with user consent, or fail |

## 10. Sizes and limits

| Item | Value |
|---|---|
| K | 100 units per batch |
| Epoch | 900 s |
| Roots kept by the gateway | 96 (one day) |
| Random first-use delay | 0 to 3 epochs |
| Opening deadline (batch expiry) | 35,040 epochs (one year) after insertion |
| Session lifetime after open | 2,880 epochs (30 days). Row pruned after this. |
| Per-batch lock wait | 5 s, then reject busy |
| Testnet epoch | 30 s, by configuration flag `EPOCH_SECONDS`. Production 900 s. |
| Open proofs precomputed | 3 |
| STARK open proof | 50 to 200 KB, once per batch |
| Spend request | a few hundred bytes |
| Open verify budget | 20 ms |
| Spend verify | about 50 µs |
| Batch row | 76 bytes |
| Replay cache entry life | 60 s |
| Per-epoch sync | about 32 hashes |

## 11. Capacity

| Load | Opens per second | Proof traffic | Open verify CPU |
|---|---|---|---|
| 1,000 rps, K = 100 | 10 | 1 to 2 MB/s | 0.2 core |
| 10,000 rps, K = 100 | 100 | 10 to 20 MB/s | 2 cores |

Spend throughput is bounded by upstream nodes, not by the gateway.

# Future scope: no issuer, many gateways

Status: Draft 2
Date: 2026-11-06
Companions: PRD.md, Architecture.md

## 1. Where the beta stops

The beta has two trusted parties.
The issuer builds leaves, posts roots, and holds the payer list.
One gateway holds every session and all prepaid funds.

Both are accepted for the beta. Neither is the end state.
This document describes the end state and what the beta must do now so that the move is a migration, not a rewrite.

## 2. End state in one paragraph

A registry contract replaces the issuer. A customer pays the contract and the contract appends the batch leaves. Any number of gateways register in a second contract with stake and a price table. A client opens a batch at the gateway of its choice. Each request inside a session doubles as a settlement receipt. A gateway claims payment per batch from the contract with the client's receipts. Nobody can build a false leaf, delay an insertion, censor a payer, or run away with more than one batch of prepaid credit.

## 3. Stage A: the registry moves onchain

### 3.1 What changes

| Beta | End state |
|---|---|
| Issuer builds leaf = H(c, K, expiry) and appends it | Contract function `buy(c[])` takes payment and appends the leaves. expiry = block time + lifetime. |
| Issuer waits for payment finality | The chain is the finality. The leaf exists when the transaction is final. |
| Issuer keys credits by tx hash | Not needed. One transaction, one set of leaves. |
| Issuer holds the remainder | Not needed. The contract takes exact multiples of the batch price. |
| Issuer posts one root per epoch | The contract keeps a ring of recent roots, one per append. Gateways read them directly. |
| Issuer serves paths and peaks | Any node, or any indexer, serves them from contract events. The client can also rebuild from events through Anon-RPC. |
| Epoch = 900 s posting cadence | Epoch becomes the root window only. The random first-use delay stays. |

### 3.2 What gets harder for an attacker

- No party can mint a leaf without payment. The rule is contract code, the same for everyone.
- No party can delay or refuse an insertion. A payer cannot be censored at the registry.
- No party holds a private payer list. The issuer-plus-gateway collusion vector from the beta threat model is gone.
- Roots cannot disagree. Every gateway and every client reads the same contract.

### 3.3 What gets worse, and the answer

- The payer address is public onchain, where the beta issuer kept it private. Answer: pay from a fresh address, or from a privacy pool. The payer-to-session link is still broken by the open proof. The payer-to-payment link is a separate problem and out of scope here.
- Each append costs gas: one hash per tree level, depth 32. Answer: deploy on an L2. One batch of 100 units must cost more than its append.
- A client must sync from events instead of one HTTP call. Answer: the Mountain Range shape already limits this to one path per leaf plus the peaks per epoch.

## 4. Stage B: many gateways

### 4.1 What changes

| Beta | End state |
|---|---|
| One gateway, hard-coded | A gateway registry contract: address, stake, price table, endpoint, KPS certificate hash |
| gateway_id is a constant | gateway_id is the registry entry. Already a public input of the open proof. |
| Client opens at the one gateway | Client picks a gateway by price, latency, and reputation, through Anon-RPC |
| Gateway keeps all revenue | Gateway claims per batch with receipts (4.2) |
| Operator exit loses all prepaid funds | Operator exit loses at most the open batches at that gateway |

### 4.2 Receipts and settlement

Every spend request is already signed by the session key over (batch_id, seq, gateway_id, rpc).
Add one field: units_total, the cumulative units spent in this session.
The latest signed request is then a receipt: "the holder of batch_id owes gateway_id units_total units".

Settlement:

1. The gateway posts a claim: batch_id, units_total, the session public key, and the signature.
2. The contract checks that batch_id was opened at this gateway. See 4.3.
3. The contract pays units_total times the unit price to the gateway and marks the batch claimed.
4. Claims are batched. One transaction can carry many batch ids with a Merkle root of claims.

The open proof is never verified onchain. STARK verification onchain is too expensive. The receipt is a signature, which is cheap.

### 4.3 Binding a batch to one gateway

The open proof already carries gateway_id as a public input.
To settle, the contract must know the session public key belongs to that batch id.
Two options:

- Option 1. The gateway posts (batch_id, session_pub, gateway_id) at open time. One small transaction per batch, or one Merkle root per epoch. The contract trusts the gateway for the binding and the client's receipt for the amount. A gateway that posts a false binding earns nothing, because it needs the client's signature to claim.
- Option 2. The client signs (batch_id, session_pub, gateway_id) with the session key at open. The gateway includes that signature in its claim. No transaction at open time. Preferred.

Double open: a client could open one batch at two gateways. The contract pays the first valid claim. The second gateway served for free. Bound: one batch. Mitigation: gateways check the claim state before accepting an open, and the loss is K units at most. Accepted.

### 4.4 Rotation between gateways

A client may close a session at one gateway and open the remaining units at another.
Not needed in the first end-state release. It needs a close receipt from the first gateway and a contract that credits the remainder to a new leaf. Deferred.

### 4.5 What gets harder for an attacker

- A gateway sees only the sessions that chose it. No single party sees all sessions.
- A gateway that stops serving loses future business and can claim only what was signed for. Exit risk is one batch per victim, not a balance.
- A censoring gateway is bypassed by choosing another. Any registered gateway serves any batch.
- Price is public and competitive. The price table is onchain, not in a dashboard.

### 4.6 What gets worse, and the answer

- Smaller per-gateway session sets. Answer: the anonymity set for the open proof is the global tree, not the gateway's share. Only the inside-session view shrinks, and that was never private.
- A malicious gateway can log content, as the beta gateway can. Unchanged.
- Reputation needs a signal. Answer: start with stake and uptime probes from clients through Anon-RPC. Full reputation is later work.

## 5. What the beta must do now

These are the compatibility rules. They cost nothing today and make the migration a migration.

- C1. Keep the leaf format H("leaf", c, K, expiry) and the batch id H("id", k). The contract will build the same leaf.
- C2. Keep gateway_id as a public input of the open proof. The registry entry will become its value.
- C3. Sign units_total inside every spend request, in addition to seq. Every request is then already a receipt.
- C4. At open, have the client sign (batch_id, session_pub, gateway_id) with the session key and send it with the proof. The gateway stores it. It is the settlement binding of 4.3.
- C5. Keep the tree as a Mountain Range and store leaf index with each batch. Event-based sync later needs nothing else.
- C6. Shape the issuer API like contract events: `LeafAppended(index, leaf)` and `RootUpdated(index, root)`. A client written against these does not change when the source becomes a contract.
- C7. Make the gateway read roots from a root source interface with two implementations: the issuer endpoint today, the contract later.
- C8. Keep expiry = insertion time + lifetime, computed by the inserter. Never by the client.
- C9. Keep the open circuit free of any issuer key or issuer signature. A leaf is valid because it is in the tree, not because the issuer signed it.

## 6. Order of work

1. Beta. One issuer, one gateway. C1 to C9 in place.
2. Registry contract on an L2. Issuer service retired. One gateway. Clients sync from events.
3. Gateway registry contract. Receipts and per-batch claims. Still one gateway in practice.
4. Second and third gateways. Client-side selection. Double-open check before open.
5. Rotation between gateways, reputation, and several K sizes, as demand shows.

## 7. zkAPI as a production route

The Ethereum Foundation and the Open Anonymity Project shipped zkAPI on mainnet on 2026-10-01.
It has the same shape as this credential layer: a vault contract, notes in a Merkle tree, a proof per session, nullifiers, a short-lived capped key, and signed usage receipts.
It also has what Stage A and Stage B describe: an onchain vault, trustless withdrawal, and a concession exit.

The MVP does not use it. The presentation names it as one production route.

| | This design | zkAPI |
|---|---|---|
| Proof system | STARK, hash-based, transparent setup | Groth16 on BN254, trusted setup (single-party dev keys at launch) |
| Post-quantum | yes, for the payer link | no |
| Amounts | fixed K per batch | variable per session, server learns the total |
| Onchain verification | not affordable, settlement by signature | cheap, enables trustless exit |
| Browser proving | immature, sidecar in the MVP | works today |
| Machinery | one proof, one row | signed state chain, challenge service, indexer, paymaster |
| Target | RPC gateway, Anon-RPC worker, dispenser | AI inference, RPC named as a use case |

The gateway, the price table, the worker, the dispenser, and the threat model do not depend on the credential layer.
A production deployment can run the gateway on zkAPI sessions, on this layer, or on both behind one verifier interface.
The choice is: post-quantum and transparent setup against trustless exit and browser proving today.

## 8. What never changes

- The gateway sees query content. No stage fixes that. A client that wants content privacy must change what it asks.
- Requests inside a session are linkable. K stays the privacy dial.
- The open proof is the only zero-knowledge step, and it is still off-chain. The chain holds leaves, roots, registry entries, and claims. It never verifies a STARK.

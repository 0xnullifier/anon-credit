# PRD: Anonymous Prepaid RPC Gateway

Status: Draft 6
Date: 2026-11-06
Owner: Utkarsh
Working name: TBD
Companion: Architecture.md

## 1. Summary

The product replaces the RPC API key with prepaid credit that has no identity.
A customer buys credit in batches of K units.
The client opens one anonymous session per batch with one zero-knowledge proof.
Inside the session, each request is a signed debit. No proof per request.
The gateway serves each request without an API key, a login, or the user's IP address.

The product has three parts:

1. The gateway. It verifies session-open proofs, tracks batch balances, and serves JSON-RPC.
2. The client SDK. A developer backend or a wallet embeds it. It buys batches, opens sessions, and signs requests.
3. The credential standard. It makes every gateway that uses it interchangeable.

The primary customer is a developer who buys credit today with an API key.
The secondary mode lets an end user buy credit inside a wallet.

## 2. Problem

An RPC provider sees the IP address and the wallet addresses of each request.
This is the normal state, not a breach.
Infura records the IP address and the wallet address on each MetaMask request.
A 2026 study of 85 wallet extensions found that the wallets leak enough data to track the users.

An anonymity network such as Tor or a mixnet hides the IP address.
The API key still travels inside the request.
The key is a stable identifier tied to a billing account, an email, and a card.
The provider then knows who asks, even if it does not know from where.

Nobody can pay for RPC without an identity.
That is the gap.

## 3. What the product does and does not hide

The product breaks one link: the link between the person who paid and the session that spends.

| Link | Broken by | What remains |
|---|---|---|
| Payer to session | this product | a batch id that matches no customer record |
| Network location to session | Anon-RPC, Tor, or a mixnet | an exit node address |
| Query content to person | nothing | whatever the questions reveal |

The honest claim: the provider cannot bill-link or IP-link a request.
The honest limit: a client whose queries identify it is still identified by content.

## 4. Users

| User | Need |
|---|---|
| dApp or wallet team | Replace the API key line with one that does not identify the app or its users |
| Privacy wallet team | Serve balances and history with no provider that can profile the user |
| End user | Pay once, use the app, never see a key or a proof |
| Gateway operator | Sell RPC capacity and receive payment without a billing identity |
| Anonymity network | A paid RPC endpoint that does not undo the anonymity the network provides |

## 5. Goals

- G1. A gateway must not learn the identity, the IP address, the app, or the purchase behind a session.
- G2. A request inside a session must not add more than 5 ms of latency at the gateway.
- G3. A session open must not add more than 50 ms at the gateway.
- G4. A developer must integrate the SDK with less than 20 lines of code.
- G5. Credit must be priced per call, in units, with the same economics as compute units today.
- G6. The credential layer must be post-quantum secure.
- G7. Any operator must be able to run a gateway with the open-source stack.
- G8. Time from payment finality to first request must not exceed one epoch plus the random delay.

## 6. Non-goals

- The product does not hide the content of a query from the gateway.
- The product does not hide that requests inside one session come from one client.
- The product does not protect against a gateway that stops service with prepaid funds. Version 1 accepts this risk.
- The product does not serve write transactions in version 1. Reads only.
- The product does not build its own anonymity network. It uses Anon-RPC workers.

## 7. Core concepts

- **Unit.** The price unit. Each JSON-RPC method costs a fixed number of units.
- **K.** The number of units in one batch. A public constant, default 100.
- **Batch.** One block of K units. The thing a customer buys and the thing a session spends.
- **Batch secret k.** A random 32-byte value the client makes per batch. Never shared.
- **Commitment c.** H(k) under the commitment domain. The client sends it at top-up.
- **Batch leaf.** H(c, K, expiry), built by the issuer and appended to the tree.
- **Batch id.** H(k) under the id domain. Revealed to the gateway at session open. Cannot be computed from c.
- **Session.** One open batch at one gateway. Identified by the batch id, authorized by a session key.
- **Session key.** An Ed25519 key pair the client makes per batch. The open proof binds to its public key.
- **Open proof.** One zero-knowledge proof per batch. It shows the leaf is in the tree, the batch is not expired, and the session key belongs to it.
- **Debit.** One signed request inside a session: batch id, sequence number, JSON-RPC body, signature.
- **Expiry.** The opening deadline of a batch. A batch must be opened before it. Once open, it stays usable until its units are spent or the gateway's session lifetime ends.
- **Epoch.** A fixed window of 900 seconds. The issuer posts one tree root per epoch. A leaf becomes usable in the next epoch. An epoch is not a session. Credit does not expire with it.
- **Registry.** The issuer's append-only Merkle tree of batch leaves. Public. One root per epoch goes onchain.
- **Dispenser.** A developer backend service that holds batches and hands one to each user session. It replaces the API key.
- **Worker.** Gateway client code pinned by hash and run in the Anon-RPC sandbox. Used only in the user-pays mode.

## 8. User stories

- As a developer, I buy 50 batches, swap the API key line for the dispenser line, and nothing else changes.
- As a developer, I set a per-user rate limit in the dispenser, as I did with my provider dashboard.
- As an end user of a privacy wallet, I top up inside the wallet. I never see a proof or a key.
- As an end user, I restore my credit on a new device from one backup string.
- As an operator, I run the gateway binary, set a price table, and receive funds per epoch.
- As a researcher, I verify that the root the gateway accepts matches the public root.

## 9. Functional requirements

### 9.1 Registry and credit

- R1. The issuer must sell credit in whole batches of K units.
- R2. The issuer must accept payment onchain from any wallet.
- R3. The issuer must accept offchain payment (card, UPI) in version 2.
- R4. The issuer must build each batch leaf itself: leaf = H(c, K, expiry). The client supplies c only. The client must not be able to set K or expiry.
- R5. The issuer must credit a payment only after finality: 12 blocks onchain, or the provider's settlement rule offchain.
- R6. The issuer must credit each payment reference one time. A reused transaction hash or payment id must be rejected.
- R7. A payment must carry the commitments c, so that only the client that knows the matching k values can use the batches.
- R8. The issuer must hold any payment remainder below one batch as a plain credit for that payer's next top-up.
- R9. The issuer must post the tree root to the chain one time per epoch.
- R10. A leaf inserted in epoch e must become valid in epoch e+1.
- R11. Each batch must have an opening deadline, default one year after insertion. The open proof must check it. Spend requests must not.
- R12. The issuer must keep the tree as an append-only Merkle Mountain Range and must publish the per-epoch frontier, so that a client never downloads the full tree.
- R13. The issuer must serve Merkle paths and the frontier over an endpoint that the client can reach through Anon-RPC.

### 9.2 Open proof

- R14. The proof must show that H(c, K, expiry) with c = H(k) is in the tree under a public root.
- R15. The proof must reveal the batch id H(k) under the id domain.
- R16. The proof must show that the current epoch is not after the expiry.
- R17. The proof must bind to the hash of the session public key.
- R18. The proof must not reveal k, c, the leaf index, or the expiry.
- R19. The proof system must use only hash-based primitives. STARK with keccak or Poseidon.

### 9.3 Client SDK

- R20. The SDK must generate k and the session key pair locally. No other party must see them.
- R21. The SDK must fetch its Merkle path at the epoch boundary after insertion, and the frontier each epoch after that.
- R22. The SDK must wait a random number of epochs, 0 to 3, before the first use of a batch.
- R23. The SDK must precompute open proofs during idle time and keep at least 3 ready.
- R24. The SDK must open each batch over a fresh connection or circuit. Under Anon-RPC it must set isolationKey to the batch id.
- R25. The SDK must sign each request with the session key and a sequence number that increases by one.
- R26. The SDK must send the open proof and every request only inside a TLS session to the gateway. Never in a query string.
- R27. The SDK must retry a lost response with the same sequence number and the same signature. It must not advance the sequence number for a retry.
- R28. The SDK must open the next batch when the current one reaches zero units, or earlier when the app asks for a fresh unlinkable window.
- R29. The SDK must report remaining batches and request a top-up at 10 percent.
- R30. Dispenser mode must hold batches on a server and hand one batch, with its k and session key, to each user session over the developer's own channel.
- R31. Worker mode must store batches in Anon-RPC scoped storage, encrypted, and export one backup string.

### 9.4 Gateway

- R32. The gateway must reject an open request by size and format before it verifies the proof.
- R33. The gateway must accept an open proof only against a root from the last 96 epochs.
- R34. The gateway must verify an open proof in less than 20 ms on one CPU core.
- R35. The gateway must reject an open for a batch id that is already open or spent.
- R35a. The gateway must build the open proof's public inputs itself: root and epoch from the request after the recency check, batch id from the request, gateway id from its own configuration, and binding from the hash of the supplied session key. It must not accept public inputs supplied with the proof.
- R36. The gateway must store one row per open batch: batch id, remaining units, session public key, next sequence number, open epoch.
- R37. The gateway must verify the session signature on every request before any other work on it.
- R37a. The gateway must process at most one request per batch at a time. Two requests with the same sequence number must not both succeed.
- R38. The gateway must accept a request only with the next sequence number. A lower number must be served from the replay cache or rejected. A higher number must be rejected.
- R39. The gateway must price each method from a published table and must reject a request that the remaining units do not cover.
- R40. The gateway must debit units and advance the sequence number only when it stores the upstream response. An upstream failure must leave both unchanged.
- R40a. The gateway must not return a successful response when recording the debit fails. It must return an error and leave the row unchanged.
- R41. The gateway must keep a 60 second replay cache keyed by batch id and sequence number.
- R42. The gateway must not reject a request because its body equals another request's body.
- R43. The gateway must keep a batch row for a session lifetime of 30 days after open, then prune it. The gateway never learns the batch's opening deadline.
- R44. The gateway must not log IP addresses or transport identifiers.
- R45. The gateway must publish a price table: units per method.
- R46. The gateway must serve HTTPS, and should offer hybrid post-quantum TLS when the stack supports it.

### 9.5 Transport

- R47. Worker mode must send all traffic through the Anon-RPC harness.
- R48. The recommended worker must open TLS to the gateway inside the sandbox. A worker that ends TLS at an exit node is not supported.
- R49. The gateway must not require a TLS client identity.

## 10. Threat model

| Party | Learns | Does not learn |
|---|---|---|
| Entry relay | the user's IP, packet sizes, timing | content, batch ids, destination |
| Exit relay | the gateway hostname, packet sizes | content, batch ids, the user's IP |
| Gateway | query content, batch ids, timing, all requests inside one session | IP, identity, app, which payment bought the batch |
| Issuer | who paid, how many batches, which leaves are theirs, when | batch ids, any request |
| Chain observer | one root per epoch, onchain payers | leaf contents, any request |
| Developer backend | its own users, as today, and which batch each got | nothing at the gateway |

Guarantee: payer-to-session unlinkability, and unlinkability between sessions.
Not guaranteed: unlinkability inside a session, or any protection when content identifies the client.
Anonymity set: every unexpired batch leaf under the root used.

Residual risks:

- Content links sessions that query the same address. Out of scope.
- A small anonymity set at launch. The set grows with every batch sold.
- Insertion-to-open timing. Mitigation: epoch delay and the random 0 to 3 epoch first-use delay.
- Issuer and gateway run by one operator. Mitigation: the proof, plus a large set. Early on this is a guess, not a proof.
- Session key theft. Scope: one batch. Mitigation: keys live only in the client.
- Spam with invalid proofs. Mitigation: size check first, then optional proof of work.
- Operator exit with prepaid funds. Accepted in version 1. Per-epoch unlock in version 2.
- Developer logs in dispenser mode. The developer can link batches to users. Out of our control.

## 11. Post-quantum posture

- Commitments and batch ids: keccak or Poseidon. Hash-based.
- Open proofs: STARK. No pairing-based wrapper.
- Session signatures: Ed25519. Classical by choice. A session key protects one batch for the life of one session. A quantum attacker who breaks it later finds a batch that is already spent.
- Transport: standard TLS inside the worker. Hybrid post-quantum TLS preferred when available.
- Onchain payment: ECDSA. Payment, not the privacy layer. Out of scope.

## 12. Economics

- Price per unit set by the operator. Each method has a unit cost.
- Credit is per call. A batch must be opened within one year of purchase. Once open it lasts until its units are spent or the 30 day session lifetime ends.
- Top-up granularity is one batch. K = 100 units is the default pack.
- K is the privacy dial. A smaller K gives shorter linkable windows and more proofs.
- Funds unlock to the operator per epoch in version 2.
- One registry can serve many gateways. A batch may be opened at one gateway only.

## 13. Capacity targets

| Load | Opens per second | Proof traffic | Verify CPU |
|---|---|---|---|
| 1,000 requests per second, K = 100 | 10 | 1 to 2 MB/s | 0.2 core |
| 10,000 requests per second, K = 100 | 100 | 10 to 20 MB/s | 2 cores |

Inside a session, one request costs one Ed25519 verify and one row update.

## 14. Success metrics

- M1. Median added latency inside a session under 5 ms. Median open under 50 ms.
- M2. Zero IP addresses in gateway logs, verified by audit.
- M3. One developer in production with the dispenser replacing their API key.
- M4. Anonymity set above 1,000 batch leaves.
- M5. The open-proof queue never empties under the target load. Measured, not assumed.

## 15. Milestones

### MVP

- Registry with onchain top-up, Mountain Range tree, and root posting on one testnet.
- Open circuit with a prover in a local sidecar.
- Gateway with the open pipeline and the spend pipeline.
- Client SDK in dispenser mode.
- Demo app with all reads through the SDK and an Anon-RPC worker.

### Version 1

- Worker mode with batches in scoped storage, backup string, restore.
- Browser prover or a hosted prover with a blind-proving design.
- Batch row pruning.
- Operator binary with a price table.

### Version 2

- Offchain payment rails.
- Per-epoch fund unlock.
- Multi-gateway registry.
- Several K sizes as separate pools, if demand asks for it.

## 16. Open decisions

- D1. Prover stack. STARK with browser proving is not mature. Options: a local sidecar, a hosted prover, or a non-PQ prover for the first release. Measure proving time first.
- D2. Chain for the root contract. Any EVM chain with low fees. 96 root posts per day.
- D3. Hash function. Keccak is conservative. Poseidon gives faster proofs.
- D4. K. One size at launch. Several sizes split the anonymity set.
- D5. Product name.

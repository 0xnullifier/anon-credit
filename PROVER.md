# Prover decision: ProveKit

Status: Selected for the first implementation; performance validation pending
Date: 2026-11-07
Companions: [PRD.md](PRD.md), [Architecture.md](Architecture.md)

## 1. Decision

Use **ProveKit** for the batch-open proof.
Write the proof program in Noir. Generate proofs locally in the browser with the ProveKit WASM SDK. Verify the native ProveKit proof at the gateway.

ProveKit uses a Spartan-based protocol with WHIR hash commitments. It is not a conventional AIR/FRI STARK. This decision changes the earlier plan to require a STARK specifically. The required properties remain:

- Zero knowledge: the proof must not reveal which purchase funded the session.
- Local proving: private inputs must stay on the client device.
- No trusted setup.
- A hash-based proof system with suitable post-quantum security parameters.
- One proof per batch, followed by signed requests inside the session.

Do not use the optional Groth16 wrapper. The gateway must verify the native hash-based proof. A Groth16 wrapper would introduce assumptions that are not post-quantum.

This selects the implementation path. It does not establish production security or confirm the latency targets.

## 2. Reasons for the choice

- ProveKit has a Noir frontend. We can express the batch-open statement without first writing a custom STARK constraint system.
- It has a first-party WASM and TypeScript browser SDK.
- The browser SDK provides threaded and scalar builds. Threaded mode requires a cross-origin-isolated page and SharedArrayBuffer. The scalar build provides a fallback.
- The current repository enables hiding witness commitments by default. The implementation must retain this property.
- Published tests include browser and phone proving. The tested claims produced proofs below 1 MB. These results establish a useful starting point, but they do not predict performance for our circuit.

Sources: [ProveKit repository](https://github.com/worldfnd/provekit), [browser SDK](https://www.npmjs.com/package/@worldcoin/provekit), [engineering report](https://world.org/blog/engineering/provekit-privacy-for-the-real-world).

## 3. Statement to prove

The proof must establish the complete batch-open statement from Architecture.md:

1. The client knows the batch secret `k`.
2. The purchase commitment is `c = H("c", k)`.
3. The leaf `H("leaf", c, K, expiry)` belongs to the registry under the accepted public root. `K` is fixed by the protocol.
4. The public batch ID is `H("id", k)`.
5. The batch has not expired at the public epoch.
6. The authorization is bound to the session public key and gateway ID.

The secret, commitment, leaf index, membership path, and expiry must remain private. Path selection must not reveal the leaf position. The gateway must check the expected public inputs, including the root, epoch, gateway ID, and session-key binding.

Select the hash function and its parameters before fixing the circuit. Poseidon2 is a candidate to measure. The circuit, registry, and SDK must use the same hash definition, domain tags, and byte-to-field encoding.

## 4. Alternatives considered

| System | Evidence and limitation | Decision |
|---|---|---|
| ProveKit | Browser SDK, Noir frontend, hash-based WHIR backend. Our proof size and verification cost are not measured. | Use for the first implementation. |
| Ligero / Ligetron | Browser proving through WebGPU. Published examples have multi-megabyte proofs. | Keep as a comparison candidate. |
| Plonky3 | Supports custom constraint systems and a hiding FRI backend. A complete zero-knowledge configuration needs review. | Consider if a custom STARK is needed to meet measured targets. |
| Winterfell | Supports WASM. Its README warns that the current privacy properties may be unsuitable for secret inputs. | Do not select its default configuration for this protocol. |
| Stwo | Strong native performance. This review did not establish a complete browser and zero-knowledge configuration for our statement. | Keep for later evaluation. |

Sources: [Ligero implementation](https://github.com/ligeroinc/ligero-prover), [Plonky3 architecture](https://github.com/Plonky3/Plonky3/blob/main/docs/architecture.md), [Winterfell](https://github.com/facebook/winterfell), [Stwo](https://github.com/starkware-libs/stwo).

## 5. Ligero: security and proof size

Ligero is designed for post-quantum security under its stated hash-based assumptions and suitable parameters. It uses coding-theoretic techniques and hash commitments, with no trusted setup.

Published results show a bandwidth tradeoff:

| Workload | Environment | Proving time | Proof size |
|---|---|---:|---:|
| Edit-distance example with tuned packing | Native M3 Pro | 351 ms | 2.55 MiB |
| Bitcoin ownership with ECDSA and SHA-256 | Chromium with WebGPU | 22 seconds | 4.2 MB |

The Bitcoin benchmark reports about 1.9 GB of memory and 4 seconds for browser verification. These are different workloads and environments. They are not estimates for our batch-open proof or server verifier.

For a batch that serves 100 one-unit requests, a 4.2 MB proof adds an average of 42 KB per request. Uploading that proof over a 10 Mbps link takes about 3.4 seconds before transport overhead. Precomputation removes proving time from the request path, but does not remove upload time.

Larger batches reduce the average proof cost per request. They also increase the number of requests that the gateway can link within one session. Thus, proof size is a product constraint, not only a prover constraint.

Sources: [Ligero protocol](https://docs.ligetron.com/docs/introduction/ligero-protocol/), [Ligero measurements](https://docs.ligetron.com/docs/introduction/performance/), [Blockstream Research benchmark](https://github.com/BlockstreamResearch/pq-p2pkh).

## 6. Zero knowledge is a separate requirement

A proof of correct execution does not necessarily hide the private inputs. Do not select a configuration only because it is called a STARK or has fast benchmarks.

Plonky3 documents that a hiding polynomial commitment scheme alone does not establish zero knowledge for the complete protocol. An open issue reports leakage through private lookups in its batched STARK path. This is a configuration-specific report, not a claim that every Plonky3 construction leaks.

For ProveKit, retain hiding mode and review the security assumptions for the exact version and parameters selected. Do not use a non-hiding mode to reduce proof size. Do not add public outputs that identify the leaf or purchase.

Sources: [Plonky3 architecture](https://github.com/Plonky3/Plonky3/blob/main/docs/architecture.md), [reported lookup issue](https://github.com/Plonky3/Plonky3/issues/2590).

## 7. Validation before fixing the protocol parameters

Benchmark the complete batch-open statement. An isolated hash benchmark is insufficient.

| Measurement | Purpose |
|---|---|
| Cold browser startup and artifact download size | Measure the first-use cost. |
| Cold and warm proof generation | Measure latency with and without cached artifacts. |
| Peak memory | Check use on devices with limited memory. |
| Serialized proof size | Measure the actual upload cost. |
| Upload through Anon-RPC | Measure session-open time over the intended transport. |
| Native gateway verification | Compare with the existing 20 ms target on one CPU core. |
| Threaded and scalar browser execution | Check supported browsers and fallback performance. |
| Proof generation inside the intended sandbox | Check compatibility with Anon-RPC worker isolation. |

Test realistic tree sizes and membership paths, including the MMR proof structure selected for the registry. Test the complete public-input binding and rejection of invalid proofs. Include wrong roots, expired batches, incorrect batch IDs, and altered gateway or session-key bindings.

The 50–200 KB proof size in Architecture.md remains an unverified target. The 20 ms verification and 50 ms gateway-open targets also remain unverified. Report proof generation, upload, and gateway processing separately.

## 8. Implementation rules

- Pin a ProveKit release or commit, Noir version, browser SDK, and compatible proof artifacts.
- Specify classical and quantum security targets separately. Record the parameters and assumptions used to support them.
- Keep private witnesses local. Sending them to an ordinary hosted prover would expose the purchase-to-session association to that prover.
- Use cryptographically secure randomness for proof generation.
- Keep the prover interface separate from batch storage and request signing, so the backend can change if measurements require it.
- Do not describe the entire application as post-quantum. The current session signatures use Ed25519, and other protocol layers have separate security assumptions.

Proceed with ProveKit. Reconsider the backend if the complete statement fails the browser memory, proof size, or gateway verification requirements.

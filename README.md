# anon-credit

Anonymous prepaid credit for JSON-RPC. A client buys credit on Sepolia, proves ownership of
one batch with a local ProveKit proof, opens an anonymous session at the gateway, and makes
signed, paid JSON-RPC reads through Anon-RPC.

Governing document: [implementation.md](implementation.md).
Background: [PRD.md](PRD.md), [Architecture.md](Architecture.md), [PROVER.md](PROVER.md).
Reference transport demo: [anon-rpc-demo/](anon-rpc-demo/README.md). Do not delete it.

## Status

| Phase | Work | Status |
|---|---|---|
| 0. Workspace | Cargo and pnpm workspaces, package boundaries, configuration profiles, checks | Done |
| 1. Proof feasibility | Pin ProveKit and Noir, batch-open circuit, hash encodings, artifacts | Done (1A gate, 1B statement, 1C real circuit in Chromium, verifier sidecar) |
| 2. Credit issuance | Sepolia contracts, issuer indexing, MMR snapshots, root publication | Not started |
| 3. Gateway | Open, spend, receipts, status recovery, pricing, limits | Not started |
| 4. SDK and testnet example | Browser state, request journal, prover adapter, Nox transport, script | Not started |
| 5. Dashboard | Admin snapshots, event stream, session views, demo IP attribution | Not started |
| 6. Complete demo | Script and dashboard on the same paid flow through Nox | Not started |
| 7. Measurement | Proving, resource, and gateway benchmarks | Not started |

Phase 0 contents:

- Rust protocol crate: error codes with retryable flags, protocol version, deployment
  configuration with `deployment_id`, operation domain tags, and the spend signing message encoder.
- Rust crypto crate: `keccak256` and strict Ed25519 verification. Poseidon2 is a documented TODO.
- TypeScript protocol package: the same error codes, deployment encoder, and spend encoder.
- Shared vectors in `fixtures/protocol/`. Rust and TypeScript tests both check them.
- Issuer and gateway binaries that read settings, print a summary without secrets, and exit.
- Stubs with doc comments where later phases plug in.

## Tools

| Tool | Version used | Install |
|---|---|---|
| Rust | `stable` (1.98.1), pinned by `rust-toolchain.toml` | `rustup` installs it on first use. |
| Node | 26.12.0 | Node 26 or later. Node runs `.ts` files directly (type stripping). |
| pnpm | 12.18.0 | `npm install -g pnpm`. Corepack is not in Node 26, so `corepack enable pnpm` does not work. |
| Foundry | forge 1.7.1 (`4072e48`) | `foundryup`. Installed at `~/.foundry/bin`, which is not on `PATH`. |
| Noir | nargo 1.0.0-beta.26 (`40d6574`), the version that ProveKit links | `tooling/provekit/install.sh`. Installed at `~/dev/noir-1.0.0-beta.26/bin`, which is not on `PATH`. `NARGO` overrides the path. The noirup nargo (`~/.nargo/bin`) is not used. |

Phase 0 does not need Foundry or Noir to build. `check.sh` runs Foundry if it finds it on
`PATH` or at the default install location. The circuit step needs nargo 1.0.0-beta.26: if it is
missing, the step fails and tells you to run `tooling/provekit/install.sh`.

Install the JavaScript dependencies:

```sh
pnpm install
```

pnpm 12 checks a minimum release age for new packages. It added `playwright-core@1.65.0` to
`minimumReleaseAgeExclude` in `pnpm-workspace.yaml` during setup.

## Checks

Run all checks:

```sh
./check.sh            # or: pnpm check
SKIP_OPTIONAL=1 ./check.sh   # skip Foundry, Noir, and ProveKit
PROVEKIT_GATE=1 ./check.sh   # also run both Chromium gates (sample and batch-open)
```

`check.sh` runs these commands in order and stops at the first failure:

| Step | Command |
|---|---|
| Rust format | `cargo fmt --all -- --check` |
| Clippy | `cargo clippy --workspace --all-targets -- -D warnings` |
| Rust tests | `cargo test --workspace` |
| JavaScript install | `pnpm install --frozen-lockfile` |
| Type checks | `pnpm -r typecheck` |
| TypeScript tests | `pnpm -r test` (Vitest) |
| Secret scan | Tracked configuration must have no secret values and no non-zero 32-byte hex values. |
| Contracts (optional) | `forge test` in `contracts/` (in-process EVM, no local network) |
| Circuits | `nargo test` (1.0.0-beta.26) in `circuits/batch-open/` and `circuits/provekit-sample/` |
| Prover (if the ProveKit toolchain is installed) | `cargo fmt --check`, `cargo clippy`, `cargo test` in `crates/prover/` |
| Browser gates (`PROVEKIT_GATE=1`) | `node packages/prover/dev/gate.ts --circuit sample`, then `--circuit batch-open` |

Other commands:

```sh
cargo run --bin issuer      # print issuer settings and exit
cargo run --bin gateway     # print gateway settings and exit
pnpm dashboard:dev          # dashboard on http://localhost:5174
pnpm example:e2e            # placeholder: prints settings, exits with code 2 until phase 4
```

## Repository layout

```text
Cargo.toml              Rust workspace and shared dependency versions
rust-toolchain.toml     Pins the stable toolchain
package.json            pnpm workspace root
pnpm-workspace.yaml
tsconfig.base.json      Strict TypeScript, ESM, NodeNext, no emit
check.sh                All checks

crates/
  protocol/             Wire structures, signing bytes, errors, configuration IDs, settings
  crypto/               Keccak-256, Ed25519 checks; Poseidon2 after phase 1
  registry/             MMR (phase 2)
  prover/               ProveKit verifier adapter and loopback verifier sidecar (separate nightly workspace)
  issuer/               Issuer service (phase 2); binary `issuer`
  gateway/              Gateway service (phase 3); binary `gateway`

packages/
  protocol/             @anon-credit/protocol: schemas, types, encoders, error codes
  crypto/               @anon-credit/crypto: WASM interface (phases 1-2)
  prover/               @anon-credit/prover: ProveKit browser adapter (phase 1)
  sdk/                  @anon-credit/sdk: client SDK (phase 4)
  anon-transport/       @anon-credit/anon-transport: Anon-RPC harness wrapper (phase 4)
  dashboard/            @anon-credit/dashboard: React and Vite operator dashboard (phase 5)

examples/e2e/           Sepolia end-to-end runner (phase 4): run.ts, browser/, fixtures/
circuits/batch-open/    Noir batch-open circuit (Noir 1.0.0-beta.26)
contracts/              Foundry project: src/, test/, script/ (phase 2)
config/                 Deployment template and environment profiles; no secrets
fixtures/protocol/      Shared vectors for Rust and TypeScript
artifacts/              Generated manifests and artifacts; large binaries are ignored
anon-rpc-demo/          Reference Anon-RPC demo
```

Dependency rules: protocol and crypto flow into the services and the SDK. The gateway does not
depend on the issuer crate. The dashboard does not depend on the SDK.

TypeScript packages export their `src/index.ts` directly. There is no build step for library
packages. Relative imports use the `.ts` extension.

## Configuration

Tracked files in `config/` have only public values:

| File | Use |
|---|---|
| `config/deployment.testnet.template.toml` | Deployment fields. All-zero values are placeholders. |
| `config/testnet-demo.env.example` | Environment for the Sepolia demo profile (30 s epochs, IP capture on). |
| `config/production.env.example` | Environment for the normal profile (900 s epochs, IP capture off). |

Copy an env example to `.env` (git ignores it) and fill in the values. Secrets come only from
the environment. The services print `set` or `not set` for secrets, never the value.

| Variable | Default | Use |
|---|---|---|
| `DEPLOYMENT_CONFIG` | not set | Path of the deployment TOML file. |
| `EPOCH_SECONDS` | `30` | Epoch length. Testnet 30, production 900. Must equal the deployment value if both are set. |
| `ISSUER_BIND` | `127.0.0.1:8080` | Issuer API listen address. |
| `ISSUER_DATABASE_PATH` | `data/issuer.db` | Issuer SQLite database. |
| `SEPOLIA_RPC_URL` | not set | Sepolia RPC for payment indexing and root publication. Secret if it has a key. |
| `ISSUER_PUBLISHER_KEY` | not set | Root publisher private key. Secret. |
| `GATEWAY_PUBLIC_BIND` | `127.0.0.1:8081` | Gateway public API listen address. |
| `GATEWAY_ADMIN_BIND` | `127.0.0.1:8082` | Gateway admin API listen address. Keep it private. |
| `GATEWAY_DATABASE_PATH` | `data/gateway.db` | Gateway SQLite database. |
| `GATEWAY_UPSTREAM_RPC_URL` | not set | Upstream Sepolia RPC for paid reads. Secret if it has a key. |
| `GATEWAY_ROOT_RPC_URL` | `SEPOLIA_RPC_URL` | RPC to read finalized roots from `RootRegistry`. |
| `GATEWAY_ADMIN_TOKEN` | not set | Admin API bearer token. Secret. |
| `DEMO_IP_LOGGING` | `false` | `true` only in the demo profile. Accepts only `true` or `false`. |
| `GATEWAY_TRUSTED_PROXY` | not set | IP address of a trusted reverse proxy. |
| `GATEWAY_CORS_ORIGINS` | `http://localhost:5173,http://localhost:5174` | Allowed origins. |
| `NOX_BOOTSTRAP_RPC_URL` | public Sepolia RPC | Reads the Nox specifier contract. |
| `E2E_PAYER_KEY` | not set | Test payer key for the example. Secret. Testnet funds only. |
| `E2E_ISSUER_URL`, `E2E_GATEWAY_URL` | not set | Public HTTPS URLs of the deployed services. |
| `E2E_TIMEOUT_SECONDS` | `7200` | Overall timeout of the example run. |
| `E2E_PAGE_PORT`, `DASHBOARD_PORT` | `5173`, `5174` | Development ports. |

## Protocol encodings (phase 0)

- Hex: `0x` and lowercase digits with the exact length. Uppercase and EIP-55 checksums are rejected.
- Integers above the JavaScript safe range: decimal strings. `payment_chain_id` is a JSON number
  and must be at most `2^53 - 1`.
- Domain tags: 32 bytes, ASCII name and zero padding: `anon-credit/deployment`,
  `anon-credit/open`, `anon-credit/status`, `anon-credit/spend`.
- `deployment_id = keccak256(242-byte fixed encoding)`. See `crates/protocol/src/deployment.rs`.
- Spend signature: Ed25519 over `keccak256(message)`. The message has a 182-byte fixed header and
  then the exact RPC bytes. See `crates/protocol/src/spend.rs`.
- Shared vectors: `fixtures/protocol/spend-message.json`, `deployment-id.json`,
  `error-codes.json`. The expected bytes come from an independent Python concatenation. The
  digests and signatures come from a separate Rust program. They do not come from the encoders
  under test. The signing key is the public RFC 8032 test key.

## Circuit hash, MMR, and batch-open statement (phase 1B)

This section is the reference for the hash rules. The circuit (`circuits/batch-open`), the
registry (`crates/registry`), the Rust helpers (`crates/crypto`), and the TypeScript package
(`packages/crypto`) use the same rules. Shared vectors prove that they agree.

### Hash definition

`H(x_1, ..., x_n)` is Poseidon2 over the BN254 scalar field
(`p = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001`). It is the same
function as Noir `Poseidon2::hash(inputs, n)` (in Noir 1.0.0-beta.26 the standard library sponge
is private; the public copy is `noir-lang/poseidon` `v0.4.0`):

- Permutation: `std::hash::poseidon2_permutation`, width 4, S-box `x^5`, 8 full rounds and
  56 partial rounds. The constants are in `fixtures/protocol/poseidon2-params.json`, copied from
  the Noir ACVM solver at `v1.0.0-beta.12`. `v1.0.0-beta.26` has the same 260 values in the same
  order. They are the standard BN254 set. Do not change them.
- Sponge: state `[0, 0, 0, n * 2^64]`, rate 3, capacity 1. Absorb in order. When the cache has
  3 values and one more value comes, add the cache to state words 0..3 and permute. Squeeze:
  add the zero-padded cache, permute, return word 0. Thus `n` inputs use `max(1, ceil(n / 3))`
  permutations.

### Encodings

- A field value on the wire is 32 bytes, big-endian, canonical. Decoders reject a value
  `>= p`. In JSON it is `0x` and 64 lowercase hex digits.
- A 32-byte value (`deployment_id`, `gateway_id`, `k`, `session_pub`) enters the circuit as two
  128-bit limbs `[hi, lo]`: `hi` = bytes 0..16, `lo` = bytes 16..32, both big-endian. The limbs
  are never reduced. The circuit constrains each limb to 128 bits.
- Epochs are `u64`. In JSON they are decimal strings. `leaf_count` and `leaf_index` are `u32`.

### Domain tags and constructions

The single source is `fixtures/protocol/domains.json`. A tag value is the big-endian integer of
its ASCII text (at most 27 bytes).

| Tag | Text | Field value |
|---|---|---|
| `DOM_COMMITMENT` | `anon-credit/v1/commitment` | `0x616e6f6e2d6372656469742f76312f636f6d6d69746d656e74` |
| `DOM_LEAF` | `anon-credit/v1/leaf` | `0x616e6f6e2d6372656469742f76312f6c656166` |
| `DOM_BATCH_ID` | `anon-credit/v1/batch-id` | `0x616e6f6e2d6372656469742f76312f62617463682d6964` |
| `DOM_BINDING` | `anon-credit/v1/binding` | `0x616e6f6e2d6372656469742f76312f62696e64696e67` |
| `DOM_MMR_LEAF` | `anon-credit/v1/mmr-leaf` | `0x616e6f6e2d6372656469742f76312f6d6d722d6c656166` |
| `DOM_MMR_NODE` | `anon-credit/v1/mmr-node` | `0x616e6f6e2d6372656469742f76312f6d6d722d6e6f6465` |
| `DOM_MMR_ROOT` | `anon-credit/v1/mmr-root` | `0x616e6f6e2d6372656469742f76312f6d6d722d726f6f74` |
| `CIRCUIT_ID` | `anon-credit/v1/batch-open` | `0x616e6f6e2d6372656469742f76312f62617463682d6f70656e` |

```text
c        = H(DOM_COMMITMENT, deployment_id_hi, deployment_id_lo, k_hi, k_lo)
leaf     = H(DOM_LEAF, c, K, expiry)                                  K = 100
batch_id = H(DOM_BATCH_ID, deployment_id_hi, deployment_id_lo, k_hi, k_lo)
binding  = H(DOM_BINDING, gateway_id_hi, gateway_id_lo, session_pub_hi, session_pub_lo)
```

The deployment ID is in `c` and `batch_id`, so credit does not move between deployments.

### MMR rules

- At most `2^32 - 1` leaves. The peaks are the 1 bits of `leaf_count`, in descending height
  order (left to right). A node of height `h` covers `2^h` leaves.
- `leaf_node = H(DOM_MMR_LEAF, leaf)`.
- `node = H(DOM_MMR_NODE * 2^32 + height, left, right)`. `height` is the parent height (1..31).
  The node domain is less than `2^248`, and it is never equal to a plain tag.
- Bagging rule: `root = H(DOM_MMR_ROOT, leaf_count, slot[31], slot[30], ..., slot[0])`.
  `slot[h]` is the peak of height `h` if bit `h` of `leaf_count` is 1, else zero. The empty MMR
  has root `H(DOM_MMR_ROOT, 0, 0, ..., 0)`.
- Path rule: leaf `i` of `n` is under the peak of height `h` = the highest bit in which `i` and
  `n` are different. At level `j < h`, bit `j` of `i` is 1 if the node is the right child.
- Proof (JSON, the same in Rust and TypeScript): `{leaf_index, leaf_count, peak_position,
  siblings[h], peaks[]}`. The verifier calculates the peak height and position and rejects a
  proof whose fields do not agree.
- `crates/registry`: `Mmr<S: MmrStore>` with `append`, `peaks`/`peaks_at`, `root`/`root_at`,
  `membership_proof`/`membership_proof_at` (snapshots at an earlier `leaf_count`), and
  `verify_proof`. `MemoryStore` is the in-memory store. Phase 2 adds a SQLite `MmrStore`; one
  `AppendUpdate` must be one transaction.

### Circuit layout

`circuits/batch-open/src/main.nr`. Public inputs, in order. The order contract is
`fixtures/protocol/batch-open-public-inputs.json` (see "Public-input order contract" below):

| Index | Input |
|---|---|
| 0 | `circuit_id` (must equal `CIRCUIT_ID`) |
| 1, 2 | `deployment_id` `[hi, lo]` |
| 3, 4 | `gateway_id` `[hi, lo]` |
| 5 | `root` |
| 6 | `leaf_count` |
| 7 | `proof_epoch` |
| 8 | `batch_id` |
| 9 | `binding` |

Private inputs: `k[2]`, `expiry`, `leaf_index`, `siblings[32]`, `peaks[32]`, `session_pub[2]`.
`siblings[j]` is zero for `j >= h`. `peaks[t]` is the peak of height `t`, or zero.

Constraints: the limbs are 128-bit; `c`, `leaf`, `batch_id`, `binding` as above;
`proof_epoch <= expiry`; `leaf_index` and `leaf_count` decompose into 32 bits; the peak height
and each left/right decision come from those bits (this also proves `leaf_index < leaf_count`);
sibling padding and empty peak slots are zero; the path node equals `peaks[h]`; the root of
`leaf_count` and `peaks` equals the public `root`.

Size: 819 ACIR opcodes (`nargo info`, nargo 1.0.0-beta.26; the same as beta.12), with 52
Poseidon2 permutation calls and 75 range checks. ProveKit R1CS: 14,416 constraints and 14,672
witnesses after its Gaussian elimination (15,031 constraints and 19,866 witnesses before).
`MAX_HEIGHT` and `MAX_PEAKS` stay 32.

Noir 1.0.0-beta.26 port: `std::hash::poseidon2_permutation` takes only the state (the compiler
checks the width), and `to_le_bits` returns `[bool; N]` (beta.26 removed `u1`). The 63 tests and
their failure messages did not change.

Witness helpers: `BatchOpenWitness::from_proof` and `BatchOpenWitness::from_mmr` in
`crates/registry/src/witness.rs` (serde JSON and `to_prover_toml`), and
`buildBatchOpenWitness` in `packages/crypto`. The gateway rebuilds the public inputs with
`BatchOpenPublicInputs::for_open` (Rust) or `batchOpenPublicInputs` (TypeScript).

### Commands

```sh
NARGO=~/dev/noir-1.0.0-beta.26/bin/nargo
(cd circuits/batch-open && $NARGO test)     # 63 tests: hash vectors, 7 valid witnesses, negative cases
(cd circuits/batch-open && $NARGO execute)  # solves Prover.toml (the gate witness: tree of 100 leaves, leaf 37)
(cd circuits/batch-open && $NARGO info)
cargo test -p anon-credit-crypto -p anon-credit-registry
pnpm --filter @anon-credit/crypto test
```

### Fixture regeneration

Run in this order after a change to the tags, the hash, or the MMR rules. The Rust and
TypeScript tests fail if a generated file is out of date.

```sh
node packages/crypto/scripts/generate-constants.ts       # domains.json, poseidon2-params.json ->
                                                          #   crates/crypto/src/constants.rs,
                                                          #   packages/crypto/src/constants.generated.ts,
                                                          #   circuits/batch-open/src/constants.nr,
                                                          #   fixtures/protocol/noir-vectors/src/constants.nr
node packages/crypto/scripts/collect-noir-vectors.ts     # runs nargo 1.0.0-beta.26 ($NARGO) in
                                                          #   fixtures/protocol/noir-vectors ->
                                                          #   fixtures/protocol/poseidon2.json,
                                                          #   circuits/batch-open/src/hash_vectors.nr
cargo run -p anon-credit-registry --example generate_fixtures
                                                          # -> fixtures/protocol/mmr.json, batch-open.json,
                                                          #   batch-open-public-inputs.json,
                                                          #   circuits/batch-open/src/witness_vectors.nr,
                                                          #   circuits/batch-open/Prover.toml,
                                                          #   artifacts/batch-open/gate-witness.json
```

`fixtures/protocol/noir-vectors` depends on `noir-lang/poseidon` `v0.4.0` (git; `v0.2.0` does not
compile with beta.26). The `v0.4.0` sponge absorbs in the same order with the same number of
permutations: all vectors in `poseidon2.json` are unchanged, and Rust and TypeScript still match
bit for bit. The batch-open circuit has no dependencies and keeps its own sponge copy, because
beta.26 does not export the standard library sponge. Do not run `nargo fmt` on the generated `.nr` files.

New dependency versions (local to the crate manifests): ark-bn254 0.5.0 and ark-ff 0.5.0 in
`anon-credit-crypto`, proptest 1.12.0 (dev) in `anon-credit-registry`, zod 4.6.7 in
`@anon-credit/crypto`.

## Pinned versions

Rust (`Cargo.lock` pins the full set): tokio 1.54.1, axum 0.8.9, serde 1.0.229,
serde_json 1.0.154, sqlx 0.9.0 (sqlite, runtime-tokio), reqwest 0.13.5 (rustls; the same version
as alloy), tracing 0.1.44, tracing-subscriber 0.3.23, alloy 2.5.0 (contract, provider-http,
rpc-types, sol-types), toml 1.2.1, thiserror 2.0.21, anyhow 1.0.104, ed25519-dalek 3.0.0,
sha3 0.12.0, hex 0.4.3, base64 0.22.1 (the same version as alloy), rand 0.10.3.

TypeScript (`pnpm-lock.yaml` pins the full set): typescript 7.0.2, vitest 5.1.0, zod 4.6.7,
@noble/hashes 2.4.0, @noble/curves 2.4.0 (tests only), react and react-dom 19.3.1, vite 8.3.6,
@vitejs/plugin-react 6.2.1, playwright-core 1.65.0, @anon-rpc/browser-harness 0.4.0,
@types/node 26.6.6.

## ProveKit (phase 1A)

Status: the gate passes. Headless Chromium proves the sample circuit with the ProveKit WASM
prover, and the Rust verifier in `crates/prover` verifies the browser proof. The Rust verifier
also rejects a tampered proof, a proof with a changed public input, and a wrong expected input.

### Pins

| Item | Pin |
|---|---|
| ProveKit | `worldfnd/provekit` main at `201b7b639f5dd5632c01561fcb2a96c2fc8851f3` (2026-11-04) |
| ProveKit Rust toolchain | `nightly-2026-03-04` (rustc 1.96.0-nightly `d9563937f`) |
| WHIR (from ProveKit) | `worldfnd/whir` at `d2b16529d0a4fad4f53d088281e9062898d35f5b` |
| Noir | 1.0.0-beta.26 (`40d6574`). ProveKit links this version. |
| noir_js, acvm_js, noirc_abi | 1.0.0-beta.26 (npm, exact) |
| wasm-bindgen-cli | 0.2.113 (equal to the crate version in ProveKit's `Cargo.lock`) |
| `prepare` options | `--hash skyscraper --witness-mode zk` |
| Artifact formats | PKP 3.0, PKV 3.0, binary proof 3.0 |

`tooling/provekit/pins.env` has these values. `artifacts/provekit-versions.json` records them
with provenance.

Noir: ProveKit compiles the circuit with its own Noir 1.0.0-beta.26 frontend. The nargo from
noirup (`~/.nargo/bin`, 1.0.0-beta.12) cannot compile code for this frontend: beta.26 removed
`u1` and keeps only `std::hash::poseidon2_permutation` (the sponge is private to the standard
library). `install.sh` puts nargo 1.0.0-beta.26 in `~/dev/noir-1.0.0-beta.26/bin` and does not
replace the noirup nargo. Move `circuits/batch-open` to beta.26 before it is prepared with ProveKit.

### Why not the published `@worldcoin/provekit` SDK

The latest SDK is 0.1.1. It comes from commit `11bfde0c` (branch
`codex/provekit-safari-scalar-wasm`, Noir 1.0.0-beta.20). At that commit the witness commitment
is not hiding: the ProveKit source says "Witness ZK is off ... WHIR openings leak witness
values". The SDK also rejects PKP/PKV 3.0 artifacts. No ProveKit branch has both the JS SDK and
the hiding witness mode. Thus `packages/prover` uses the first-party `tooling/provekit-wasm`
bindings, built from the pinned commit, with its own loader and worker. This is the same prover.
It is not a replacement prover.

The pinned commit has no single-thread feature in `tooling/provekit-wasm`. The patch
`tooling/provekit/patches/0001-provekit-wasm-optional-threads.patch` adds the optional
`threads` feature. The SDK branch has the same change.

ProveKit recommends the `v1` line for production. `v1.0.3` uses an always-on `whir_zk` witness
commitment. It has no single-thread WASM feature and no matching published SDK. The gate does
not use it. On the sample circuit, its native proof is 573 KB (the pinned commit: 294 KB),
and native proving and verification are slower. See `alternativeRelease` in `artifacts/provekit-versions.json`.

### Hiding mode

- `provekit-cli prepare --witness-mode zk` (the default at the pinned commit) makes a hiding
  witness commitment (WHIR "zook" commitment in `Mode::ZeroKnowledge`). The key records the
  mode. `prove` and `verify` need no flag.
- The Spartan sumcheck is always masked by a committed blinding polynomial.
- `PinnedVerifier` in `crates/prover` rejects a verifier key in `Mode::Standard`
  (`LoadError::NotHiding`). The test `non_hiding_key_is_rejected` uses a `--witness-mode standard` key.
- The prover manifest schema in `packages/prover` accepts only `"witnessMode": "zk"`.
- Each proof uses fresh randomness (`getrandom`, browser `crypto.getRandomValues`). Two proofs of
  the same witness have different bytes.
- Limit: the ProveKit source says that a hiding commitment alone is not full proof zero
  knowledge: "the alpha, public-input, and challenge evaluations are still sent in the clear".
  Phase 1 does not establish full zero knowledge for the batch-open statement. A review of this
  leakage for the full circuit is necessary before the protocol freeze.

### Layout

| Path | Contents |
|---|---|
| `tooling/provekit/` | `pins.env`, `install.sh` (CLI, nargo, wasm-bindgen), `build-wasm.sh`, `prepare-sample.sh`, the WASM patch |
| `circuits/provekit-sample/` | Sample circuit: Poseidon2 batch ID, depth-16 Merkle path with a private index, expiry check. 3 public inputs, 5136 constraints. |
| `crates/prover/` | `anon-credit-prover`: `PinnedVerifier`, `Proof`, `PublicInput`, `Sha256Digest`; binary `anon-credit-prover` (`verify`, `bench`, `inspect`) |
| `packages/prover/` | `@anon-credit/prover`: manifest and digest checks, worker, `createBatchOpenProver`; `dev/` test page and `dev/gate.ts` |
| `artifacts/provekit-sample/` | Checked in (1.5 MB): `sample.pkp`, `sample.pkv`, `sample-standard.pkv` (non-hiding, tests only), `proof.np`, `proof.native.json`, `proof.browser.json` |
| `artifacts/provekit-wasm/` | Built WASM (about 5 MB each). Git ignores it. |
| `artifacts/provekit-sample/prover-manifest.json` | Written by the gate. Git ignores it, because the WASM digests change with the build machine. |
| `artifacts/provekit-sample-results.json` | Measured gate results |

`crates/prover` is not a member of the root workspace. ProveKit needs nightly features
(`portable_simd`, `vec_split_at_spare`), and the root workspace uses stable Rust. The crate has
its own `rust-toolchain.toml` and `Cargo.lock`. The gateway does not depend on it yet. Phase 3
must select one of these: build the gateway with the ProveKit toolchain, or run the verifier in
a separate process.

In debug builds, the dependencies must have debug assertions off. With them on, WHIR expects a
transcript pattern that only debug provers write, and it panics on release proofs.
`crates/prover/Cargo.toml` sets this. The verifier also catches a panic and returns a rejection.

### Reproduce

```sh
export PATH="$HOME/.foundry/bin:$HOME/.nargo/bin:$PATH"
tooling/provekit/install.sh          # ProveKit CLI at the pin, nargo beta.26, wasm-bindgen-cli
tooling/provekit/prepare-sample.sh   # nargo test, prepare (zk), native prove and verify

# Native verify and bench with the Rust adapter
cd crates/prover
cargo run --release -- verify --pkv ../../artifacts/provekit-sample/sample.pkv \
  --pkv-sha256 2924a15365089797df27e664edb73d8db918b445b4a4cea02d5effc0ea8c5260 \
  --proof ../../artifacts/provekit-sample/proof.browser.json \
  --public-input 0x2defe77ad67d41ed53118ca13e97d82c88a0796fc3adb8858509598d115eccb1 \
  --public-input 0x292c827d85a6f524c3dc038c7d1fef7c3a63d666fc46b710ff5c98eeed772e \
  --public-input 0x3e7
cargo test                           # 13 integration tests, 5 unit tests
cd ../..

# Browser gate: scalar (no isolation) and threaded (COOP/COEP) proofs in headless Chromium,
# verified by the Rust adapter. Set CHROMIUM_PATH or use the Playwright cache.
tooling/provekit/build-wasm.sh
node packages/prover/dev/gate.ts     # GATE_WRITE_FIXTURE=1 also replaces proof.browser.json
PROVEKIT_GATE=1 ./check.sh           # all checks and the gate

pnpm --filter @anon-credit/prover dev   # test page on http://localhost:5180 (scalar)
```

The threaded build needs a cross-origin isolated page:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

All scripts, workers, and WASM files must be same-origin or send a compatible
`Cross-Origin-Resource-Policy`. The scalar build needs no special headers.

### Measured results (sample circuit, Apple M4 Pro, 12 cores, HeadlessChrome 149)

These numbers are for the 5136-constraint sample circuit. They do not predict the full
batch-open circuit.

| Measurement | Scalar WASM | Threaded WASM (8 threads) | Native CLI |
|---|---:|---:|---:|
| Warm proof (witness and proving) | 252 ms | 90 ms | 69 ms |
| Cold first proof (worker start, download, checks, init, proof) | 418 ms | 269 ms | |
| WASM linear memory after proving | 11.6 MiB | 27.8 MiB | 10.5 MB peak |
| Artifact download, raw (WASM, glue, PKP) | 5.34 MB | 5.51 MB | |
| Artifact download, gzip | 1.29 MB | 1.33 MB | |

| Proof and verification | Value |
|---|---:|
| Browser proof (JSON encoding) | 450 KB (299 KB gzip) |
| Native proof (binary `.np`, zstd) | 294 KB |
| Rust verify, browser proof, 1 thread (`RAYON_NUM_THREADS=1`) | 13.2 ms median |
| Rust verify, browser proof, 12 threads | 9.0 ms median |

The noir_js and ACVM WASM files (about 3.7 MB raw) are part of the page bundle, not of the
manifest. The download sizes above do not include them. `wasm-opt` was not run.

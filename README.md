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
| 2. Credit issuance | Sepolia contracts, issuer indexing, MMR snapshots, root publication | Done in code and tests; Sepolia deployment and a real finalized payment are open (the user deploys) |
| 3. Gateway | Open, spend, receipts, status recovery, pricing, limits | Done in code and tests; a live run needs the deployed contracts, the sidecar, and an upstream RPC |
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
cargo run --bin issuer -- --print-settings   # print issuer settings and exit
cargo run --bin issuer      # run the issuer (needs a deployment file and SEPOLIA_RPC_URL)
cargo run --bin gateway     # run the gateway (needs the sidecar; see "Gateway (phase 3)")
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
  registry/             MMR, proofs, witness builder, SQLite store and root snapshots
  prover/               ProveKit verifier adapter and loopback verifier sidecar (separate nightly workspace)
  issuer/               Issuer service: indexer, issuance, root publisher, /v1 API; binary `issuer`
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
| `ISSUER_BIND` | `0.0.0.0:8080` | Issuer API listen address. |
| `ISSUER_DB_PATH` | `data/issuer.db` | Issuer SQLite database. |
| `SEPOLIA_RPC_URL` | not set | Sepolia RPC for payment indexing and root publication. Secret if it has a key. |
| `ISSUER_PRIVATE_KEY` | not set | Root publisher private key (`issuer_address`). Secret. |
| `SALE_ADDRESS`, `ROOT_REGISTRY_ADDRESS` | deployment values | Optional. Must equal the deployment values if set. |
| `ISSUER_START_BLOCK` | `0` | First block of the sale indexer: the `CreditSale` deployment block. |
| `ISSUER_INDEX_POLL_SECONDS`, `ISSUER_PUBLISH_POLL_SECONDS` | `12`, `5` | Time between indexer and publisher passes. |
| `ISSUER_LOG_CHUNK_BLOCKS` | `1000` | Largest block range of one `eth_getLogs` request. |
| `ISSUER_ADDRESS`, `BATCH_PRICE_WEI` | not set, `100000000000000` | Inputs of `contracts/script/Deploy.s.sol`. |
| `GATEWAY_PUBLIC_BIND` | `0.0.0.0:8081` | Gateway public API listen address. |
| `GATEWAY_ADMIN_BIND` | `127.0.0.1:8082` | Gateway admin API listen address. Keep it private. |
| `GATEWAY_DATABASE_PATH` | `data/gateway.db` | Gateway SQLite database. |
| `GATEWAY_UPSTREAM_RPC_URL` | not set | Upstream Sepolia RPC for paid reads. Secret if it has a key. |
| `GATEWAY_ROOT_RPC_URL` | `SEPOLIA_RPC_URL` | RPC to read finalized roots from `RootRegistry`. |
| `GATEWAY_ADMIN_TOKEN` | not set | Admin API bearer token. Secret. |
| `DEMO_IP_LOGGING` | `false` | `true` only in the demo profile. Accepts only `true` or `false`. |
| `GATEWAY_TRUSTED_PROXY_ADDRS` | not set | Trusted reverse proxy addresses, comma separated. More gateway variables: "Gateway (phase 3)". |
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

## Credit issuance (phase 2)

### Parts

| Part | Path |
|---|---|
| `CreditSale`, `RootRegistry`, deploy script, Foundry tests | `contracts/` (see [contracts/README.md](contracts/README.md)) |
| SQLite MMR store and root snapshots | `crates/registry/src/sqlite.rs` |
| Issuer service | `crates/issuer/` |
| Issuer API envelopes | `crates/protocol/src/issuer_api.rs`, `packages/protocol/src/issuer-api.ts` |
| Shared API examples | `fixtures/protocol/issuer-api.json` |

New error codes: `not_found` and `payment_invalid` (both not retryable).

### Deploy the contracts

The user deploys. No check broadcasts a transaction.

```sh
export PATH="$HOME/.foundry/bin:$PATH"
cd contracts
export SEPOLIA_RPC_URL=... ISSUER_PRIVATE_KEY=... ISSUER_ADDRESS=0x... BATCH_PRICE_WEI=100000000000000 EPOCH_SECONDS=30
forge script script/Deploy.s.sol:Deploy --rpc-url $SEPOLIA_RPC_URL --broadcast --private-key $ISSUER_PRIVATE_KEY
```

The verify commands and the deployment record shape (`contracts/deployments/sepolia.example.json`)
are in `contracts/README.md`. Then copy `config/deployment.testnet.template.toml`, and set
`sale_address`, `root_registry_address`, and `issuer_address` (lowercase hex).

### Run the issuer against Sepolia

```sh
export DEPLOYMENT_CONFIG=config/deployment.sepolia.toml   # your copy with the real addresses
export SEPOLIA_RPC_URL=https://...                        # secret; must support the "finalized" tag
export ISSUER_PRIVATE_KEY=0x...                           # secret; the address must be issuer_address
export ISSUER_START_BLOCK=<CreditSale deployment block>
export ISSUER_DB_PATH=data/issuer.db
cargo run --release --bin issuer
```

At start, the issuer checks `eth_chainId`, `CreditSale.issuer()` and `batchPriceWei()`,
`RootRegistry.issuer()` and `epochSeconds()`, and the publisher key address. It refuses a
database of a different `deployment_id`. Without `ISSUER_PRIVATE_KEY`, it records roots but does
not send them. Put an HTTPS reverse proxy in front of port 8080.

### HTTP API (all under `/v1`)

| Method and path | Result |
|---|---|
| `GET /config` | Deployment, `deployment_id`, batch price, purchase limit, root window. |
| `POST /topups` `{tx_hash, log_index}` | 200 issued, 202 pending (tracked), 422 `payment_invalid`. Never mints from client values. |
| `GET /topups/:tx_hash/:log_index` | Stored state: issued (leaf indices, insertion epoch, eligible epoch, expiry), pending, or rejected. 404 if not tracked. |
| `GET /roots?from=E&limit=N` | Publication records with state `pending`, `submitted`, `included`, `finalized`, `skipped`, or `failed`. Default: the last 96. |
| `GET /tree/path/:leaf_index?root=R` | Complete MMR proof against the snapshot with root `R`. 404 if `R` is not a kept snapshot or the leaf is not in it. |
| `GET /epoch` | Current epoch, epoch length, clock, seconds until the next boundary. |
| `GET /events/leaves?from=N&limit=L` | `LeafAppended(index, leaf)` events (FUTURE.md C6). |
| `GET /events/roots?from=E&limit=L` | `RootUpdated(index, root)` events of roots with a successful `postRoot` receipt. |

Errors use `ErrorBody` with a stable code. Unknown body fields and unknown query parameters
are rejected (400 `invalid_request`). The body limit is 4 KiB. CORS allows any origin for `GET`
only. The issuer does not record client addresses.

### How issuance timing works

1. The client calls `CreditSale.buy(commitments)` with exactly `batch_price_wei * n`.
2. The indexer reads `Purchased` logs only up to the RPC `finalized` block (about 13 minutes on
   Sepolia). For each log, it checks the contract address, the event, the amounts, the receipt
   status, and the canonical block hash. If the RPC gives no finalized block, issuance waits
   and reports `finality_unavailable`. A fixed block depth is never used.
3. In one SQLite transaction, the issuer records the payment, keyed by
   `(chain_id, tx_hash, log_index)`, and appends one leaf for each commitment:
   `leaf = H(DOM_LEAF, c, K, expiry)`, `expiry = insertion_epoch + 35,040`. The issuer sets the
   insertion epoch (C8). A repeated payment returns the stored issuance and appends nothing.
4. When epoch `e` closes (30 s on testnet), the publisher records the snapshot of `e` (the
   leaves with insertion epoch `<= e`) and a pending publication in one transaction. A leaf
   never gets an epoch that already has a snapshot. Leaves of epoch `e` are eligible from
   `e + 1`.
5. The publisher signs `postRoot(e, root, leaf_count)`, stores the signed bytes, then sends
   them. It waits until the latest block time passes the end of `e`. One transaction is in
   flight at a time. If it falls behind, it sends only the newest pending epoch and marks the
   older ones `skipped`. After a restart, it sends the stored bytes again and reconciles the
   receipt: `included`, then `finalized` when the block is final and canonical. A dropped or
   reverted transaction becomes `failed`; the next epoch replaces it.
6. The gateway reads roots from `RootRegistry` after root finality (about 13 more minutes).

Thus the first open after a purchase waits for payment finality, one epoch boundary, root
publication, and root finality. After that, a new root comes every 30 s.

Gas: the issuer publishes every epoch, also with no new leaves, so that the gateway always has a
fresh root. At 30 s epochs this is 2,880 `postRoot` transactions each day (96 each day at 900 s).
Fund the issuer key for this.

### Database (`ISSUER_DB_PATH`, WAL, `synchronous = FULL`)

| Table | Key | Contents |
|---|---|---|
| `mmr_leaves` | `leaf_index` | Leaf value. |
| `mmr_nodes` | `(height, node_index)` | Hash of each complete subtree. |
| `mmr_root_snapshots` | `epoch` | Leaf count and root at the end of a closed epoch. All are kept. |
| `issuer_meta` | `key` | `deployment_id` of the database. |
| `payments` | `(chain_id, tx_hash, log_index)` | Event values, block, insertion epoch, expiry, first leaf. |
| `issued_leaves` | `leaf_index` | Payment, commitment, insertion epoch. |
| `topup_tracking` | `(chain_id, tx_hash, log_index)` | Registered payments that are pending or rejected. At most 10,000; rows without a receipt expire after 1 hour. |
| `root_publications` | `epoch` | State, signed transaction, nonce, receipt block. |
| `indexer_state` | `id = 1` | Next block of the indexer. |

### Tests

```sh
cargo test -p anon-credit-registry --test sqlite_store   # equivalence with the memory store, rollback, restart
cargo test -p anon-credit-issuer                         # mock chain and manual clock; no network
(cd contracts && forge test)                             # 38 tests: every revert path and event
pnpm --filter @anon-credit/protocol test                 # issuer API schemas against the shared examples
cargo test -p anon-credit-issuer --test issuer_fixtures -- --ignored regenerate   # rewrite issuer-api.json
```

New dependencies (local to the crate manifests, already in `Cargo.lock`): alloy features
`signer-local`, `network`, `consensus`, `eips` and tower-http 0.6.11 (`cors`) in the issuer;
tower 0.5.3 (dev) in the issuer; sqlx and tokio (dev) in the registry. Solidity: solc 0.8.30,
EVM `cancun`, no vendored library.

## Gateway (phase 3)

The gateway (`crates/gateway`, binary `gateway`) opens anonymous sessions from batch-open
proofs and sells paid JSON-RPC reads. It uses stable Rust. The ProveKit verifier runs in the
separate loopback sidecar (see "Verifier sidecar"). The gateway reads roots from
`RootRegistry` on Sepolia at the `finalized` block tag. It does not use the issuer API.

### Run

```sh
# 1. Start the verifier sidecar (nightly toolchain, 127.0.0.1:8083).
(cd crates/prover && cargo run --release -- serve --pkv ../../artifacts/batch-open/batch-open.pkv \
  --pkv-sha256 <verifier_artifact_hash without 0x>)

# 2. Start the gateway. Use a deployment file without placeholders.
export DEPLOYMENT_CONFIG=config/deployment.testnet.toml
export GATEWAY_UPSTREAM_RPC_URL=...        # secret if it has a key
export SEPOLIA_RPC_URL=...                 # or GATEWAY_ROOT_RPC_URL
export GATEWAY_ADMIN_TOKEN=$(openssl rand -hex 32)
cargo run --release --bin gateway
```

The gateway refuses to start unless: the deployment has no placeholder values; the admin
token has at least 16 characters; the sidecar `GET /health` reports `pkv_sha256` equal to the
deployment `verifier_artifact_hash`, `witness_mode` `zk`, and the batch-open `circuit_id`; and
the upstream `eth_chainId` equals `GATEWAY_UPSTREAM_CHAIN_ID` (default: the deployment
`payment_chain_id`). The log has no secret values and no peer addresses.

### Settings

The shared and the older gateway variables are in the Configuration table. Phase 3 adds:

| Variable | Default | Use |
|---|---|---|
| `GATEWAY_VERIFIER_URL` | `http://127.0.0.1:8083` | Verifier sidecar base URL. |
| `GATEWAY_UPSTREAM_CHAIN_ID` | deployment `payment_chain_id` | Expected upstream `eth_chainId`. |
| `GATEWAY_TRUSTED_PROXY_ADDRS` | not set | Comma-separated IP addresses of trusted reverse proxies. `GATEWAY_TRUSTED_PROXY` (one address) is also read. |
| `GATEWAY_FORWARDED_HEADER` | `x-forwarded-for` | Forwarding header that only a trusted proxy can set. |
| `GATEWAY_ROOT_POLL_SECONDS` | `10` | Time between root refreshes. |
| `GATEWAY_OPEN_BODY_LIMIT_BYTES` | `16777216` | Largest `POST /v1/open` body. |
| `GATEWAY_SPEND_BODY_LIMIT_BYTES` | `65536` | Largest `POST /v1/rpc` and `POST /v1/session/status` body. |
| `GATEWAY_UPSTREAM_RESPONSE_LIMIT_BYTES` | `1048576` | Largest upstream response. |
| `GATEWAY_UPSTREAM_TIMEOUT_MS` | `15000` | Upstream timeout. |
| `GATEWAY_PROOF_CONCURRENCY`, `GATEWAY_PROOF_QUEUE_DEPTH` | `2`, `8` | Proof verifications at the same time, and open requests that wait. A full queue gives `busy`. |

`GATEWAY_PUBLIC_BIND` now defaults to `0.0.0.0:8081`. The admin listener stays on
`127.0.0.1:8082`. Response retention (60 s) and the batch lock wait (5 s) are fixed.

### Public API (`/v1`, CORS for `GATEWAY_CORS_ORIGINS`)

| Endpoint | Body | Result |
|---|---|---|
| `GET /v1/config` | | IDs, circuit ID, verifier hash, chains, epoch, windows, price table hash, limits |
| `GET /v1/prices` | | `{price_table_hash, price_table}`; check the hash with the canonical encoding |
| `GET /v1/roots` | | Accepted roots of the last 96 source epochs, newest first |
| `POST /v1/open` | `OpenRequest` | `{session, existing}` |
| `POST /v1/rpc` | `SpendRequest` | Raw JSON-RPC bytes; headers `X-Anon-Remaining`, `X-Anon-Next-Seq`, `X-Anon-Replayed` |
| `POST /v1/session/status` | `StatusRequest` | `{session, current_epoch, latest_receipt, nonce}` |
| `GET /v1/demo/peer` | | Only with `DEMO_IP_LOGGING=true`: `{observed_ip, attribution, proxy_hop}` |

The envelopes are in `crates/protocol/src/api.rs` and `packages/protocol/src/gateway-api.ts`.
Shared examples: `fixtures/protocol/gateway-api.json`. All envelopes reject unknown fields.
IDs are lowercase hex, proofs, signatures, and RPC bytes are canonical base64, and `u64`
values are decimal strings. Errors are `{code, message, retryable}`; `response_expired` adds
`receipt`. HTTP status by code: 400 `invalid_request`/`unsupported_version`, 401
`signature_invalid`, 402 `insufficient_units`, 404 `not_found`, 409 `session_conflict`/
`sequence_gap`/`sequence_conflict`, 410 `response_expired`/`session_expired`, 413 for a body
above the limit (`invalid_request`), 422 `proof_invalid`/`root_not_accepted`/
`proof_epoch_stale`/`method_not_allowed`, 502 `upstream_failed`, 503
`storage_unavailable`/`busy`.

### Signing messages

All signatures are Ed25519 with the session key over `keccak256(message)`. Integers are
big-endian. Vectors: `fixtures/protocol/open-message.json`, `status-message.json` (made by an
independent Python program), checked by Rust and TypeScript tests.

Open (238 bytes): domain `anon-credit/open` (32) | version u16 | deployment_id (32) |
gateway_id (32) | batch_id (32) | root (32) | leaf_count u32 | proof_epoch u64 |
session_pub (32) | price_table_hash (32).

Status (162 bytes): domain `anon-credit/status` (32) | version u16 | deployment_id (32) |
gateway_id (32) | batch_id (32) | nonce (32).

Spend: see "Protocol encodings" (182-byte header and the exact RPC bytes).

Price table: canonical JSON with sorted keys and no white space,
`{"units":{"eth_blockNumber":1,"eth_chainId":1,"eth_getBalance":2},"version":1}`.
`price_table_hash = keccak256` of it
(`0xda98f5f3639aec038cc4eafa8881883249966a89123bd2fb42111d30b123f72f`).

### Open pipeline

Body limit and schema; protocol version, `deployment_id`, `gateway_id`; `batch_id` and `root`
are canonical field elements. If the batch already has a session: a valid signature with the
same key and the same signed message is an exact retry and returns the stored state (also after
the proof epoch aged out; units and sequence do not reset); anything else is
`session_conflict`. Otherwise: price table hash is current; proof epoch is the current or the
previous epoch; root is accepted (source epoch in the last 96, leaf count equal); open
signature; then the proof through the sidecar with public inputs that the gateway builds
(`[circuit_id, deployment_id hi/lo, gateway_id hi/lo, root, leaf_count, proof_epoch, batch_id,
binding]`, checked against `fixtures/protocol/batch-open-public-inputs.json`); then one insert
under the unique `batch_id`. A zero root from `rootAt` means "not posted"; skipped epochs are
allowed. Session deadline: `open_epoch + 35040`.

### Spend pipeline

Body limit and schema; signature over the spend digest with the session key and the frozen
price table hash (before the lock and before any state change); per-batch lock (5 s, then
`busy`); then `seq` against `next_seq`: lower with the same digest returns the stored response
with no charge (`X-Anon-Replayed: true`), or `response_expired` with the receipt after 60 s; a
different digest is `sequence_conflict`; higher is `sequence_gap`. Then the deadline, the
method allowlist (`eth_chainId` and `eth_blockNumber` with no params, `eth_getBalance` with
`[address, block]`; duplicate JSON keys, batches, and notifications are rejected), remaining
units, and `units_total == session units_total + method units`. The gateway forwards the exact
client bytes upstream. A JSON-RPC result or error object with HTTP 200 is charged; a transport
failure, a non-200 status, a malformed response, or more than 1 MiB is `upstream_failed` and
changes nothing. The debit, the receipt, and the response bytes commit in one transaction; a
commit failure is `storage_unavailable` and the response is discarded.

### Database (`GATEWAY_DATABASE_PATH`, WAL, `synchronous = FULL`)

| Table | Contents |
|---|---|
| `sessions` | `batch_id` (key), `session_pub`, `remaining`, `units_total`, `next_seq`, `open_epoch`, `deadline_epoch`, `open_request_digest`, `open_request_json` (without proof bytes; `proof_keccak256` instead), `price_table_hash`, `proof_size`, `verify_ms`, `state`, `opened_at` |
| `receipts` | (`batch_id`, `seq`) key, `request_digest`, `method`, `units`, `units_total`, `response_bytes` (set to NULL 60 s after commit), `committed_at` |
| `roots` | Cache of finalized roots: `source_epoch`, `root`, `leaf_count`, `fetched_at` |

A session row (the spent marker) stays through `deadline_epoch + 1`; then pruning deletes it
with its receipts.

### Admin API (`127.0.0.1:8082`, `Authorization: Bearer <GATEWAY_ADMIN_TOKEN>`)

| Endpoint | Result |
|---|---|
| `GET /admin/v1/snapshot` | Status, verifier, root status, counters, session totals, recent events and sessions |
| `GET /admin/v1/events` | Server-Sent Events; `id` is the monotonic event ID; reconnect with `Last-Event-ID` |
| `GET /admin/v1/sessions/{batch_id}` | Session summary and recent receipt metadata |

The token is never accepted in a URL. Envelopes: `crates/protocol/src/admin.rs` and
`packages/protocol/src/admin-api.ts`.

Events (in memory, at most 10,000 or 30 minutes): `open_received`, `open_verified`,
`open_rejected`, `session_opened`, `rpc_received`, `rpc_completed`, `rpc_replayed`,
`rpc_rejected`, `upstream_failed`, `storage_failed`. Debit events come only after the commit.
Events have method names and sizes, never keys, proofs, tokens, or RPC parameters. With
`DEMO_IP_LOGGING=false` the observed IP is `"unavailable"` and the gateway does not read the
peer address. With `true` it is the socket peer, or, only from a trusted proxy, the first
untrusted address of the forwarding header read from the right; the proxy hop is shown
separately.

### Tests

`cargo test -p anon-credit-gateway` (no network; loopback servers only): 31 unit tests and 50
integration tests with an injected clock, a fake root source, a fake verifier, a fake upstream,
and a SQLite file. They cover the open checks and order, altered binding, stale epochs, the
96-epoch window, exact retry and conflicts, concurrent opens, the full verification queue,
balances 100 -> 99 -> 98 -> 96, replay, sequence conflict and gap, bad signatures, exhaustion,
upstream failures, a JSON-RPC error that is charged, an injected commit failure (a SQLite
trigger), response expiry after 60 s, restart on the same database, concurrent requests with
one sequence, the lock wait, the session deadline and pruning, the admin token, SSE reconnect,
forwarding headers, no IP in events or logs in the normal profile, the sidecar and upstream
clients, and the public-input fixtures.

`crates/gateway` adds these crate-local dependencies (all already in `Cargo.lock`):
async-trait 0.1.92, futures-util 0.3.34, tower-http 0.6.11 (cors); tests: ed25519-dalek,
http-body-util 0.1.5, tempfile 3.27.0, tower 0.5.3.

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

## ProveKit (phases 1A and 1C)

Status: both gates pass.

- Phase 1A: headless Chromium proves the sample circuit with the ProveKit WASM prover, and the
  Rust verifier in `crates/prover` verifies the browser proof.
- Phase 1C: headless Chromium proves the real `circuits/batch-open` statement (scalar and
  threaded builds) for a real witness: a tree of 100 leaves, leaf 37, the deployment and
  gateway IDs of `fixtures/protocol/deployment-id.json`, and a real Ed25519 session key. The
  Rust verifier accepts the browser proof. It rejects a proof with a changed byte, and, for each
  of the 10 public inputs one at a time, a wrong expected value and a changed value in the proof.

The gateway calls the verifier through the loopback sidecar `anon-credit-prover serve` (see
"Verifier sidecar" below).

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
replace the noirup nargo. Phase 1C moved `circuits/batch-open` and `fixtures/protocol/noir-vectors`
to beta.26. All circuits of the project now use beta.26.

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
| `tooling/provekit/` | `pins.env`, `install.sh` (CLI, nargo, wasm-bindgen), `build-wasm.sh`, `prepare-sample.sh`, `prepare-batch-open.sh`, the WASM patch |
| `circuits/provekit-sample/` | Sample circuit: Poseidon2 batch ID, depth-16 Merkle path with a private index, expiry check. 3 public inputs, 5136 constraints. |
| `crates/prover/` | `anon-credit-prover`: `PinnedVerifier`, `Proof`, `PublicInput`, `Sha256Digest`, `serve` (sidecar); binary `anon-credit-prover` (`verify`, `bench`, `inspect`, `serve`) |
| `packages/prover/` | `@anon-credit/prover`: manifest and digest checks, worker, `createBatchOpenProver`, batch-open ABI check and `batchOpenInputsSchema`; `dev/` test page (`?circuit=sample` or `batch-open`) and `dev/gate.ts --circuit sample\|batch-open` |
| `artifacts/batch-open/` | Checked in (1.9 MB): `batch-open.pkp`, `batch-open.pkv`, `batch-open-standard.pkv` (non-hiding, tests only), `prover-manifest.json` (pinned), `gate-witness.json`, `abi.json`, `nargo-info.txt`, `prepare.json`, `proof.np`, `proof.native.json`, `proof.browser.json` |
| `artifacts/batch-open-results.json` | Measured batch-open gate results |
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
cargo run -p anon-credit-registry --example generate_fixtures   # batch-open Prover.toml and gate witness
tooling/provekit/prepare-batch-open.sh   # batch-open: nargo test and info, prepare (zk),
                                         # native prove and verify, prepare.json

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
node packages/prover/dev/gate.ts     # sample; GATE_WRITE_FIXTURE=1 also replaces proof.browser.json
node packages/prover/dev/gate.ts --circuit batch-open   # real circuit; writes artifacts/batch-open-results.json
PROVEKIT_GATE=1 ./check.sh           # all checks and both gates

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

### Batch-open circuit (phase 1C)

The keys are deterministic: `prepare-batch-open.sh` gives the same PKP and PKV digests for the
same pins and the same circuit. The prover manifest pins the PKP, the PKV, and the WASM files
(sizes and SHA-256). The WASM files are not checked in (about 5 MB each). The manifest digest
below is valid only for the WASM bytes that `build-wasm.sh` made on the measurement machine.
A different WASM build gives a different manifest digest, and thus a new deployment. Phase 4
must host the exact WASM bytes that the manifest pins.

Measured on an Apple M4 Pro (12 cores), HeadlessChrome 149, `GATE_RUNS=3`
(`artifacts/batch-open-results.json`, `artifacts/batch-open/prepare.json`):

| Circuit size | Value |
|---|---:|
| ACIR opcodes (`nargo info`) | 819 |
| ProveKit R1CS constraints | 14,416 |
| ProveKit R1CS witnesses | 14,672 |
| Public inputs | 10 |

| Measurement | Scalar WASM | Threaded WASM (8 threads) | Native CLI |
|---|---:|---:|---:|
| Warm proof (witness and proving), runs 2 and 3 | 504 ms | 172 ms | 100 ms (process wall time) |
| Witness generation (noir_js), warm | 7 ms | 6 ms | |
| Cold first proof (worker start, download, checks, init, proof) | 720 ms | 391 ms | |
| WASM linear memory after proving | 25.9 MiB | 42.1 MiB | 68.5 MiB peak RSS |
| Artifact download, raw (WASM, glue, PKP) | 5.54 MB | 5.70 MB | |
| Artifact download, gzip | 1.49 MB | 1.52 MB | |

| Artifact, proof, and verification | Value |
|---|---:|
| PKP (prover key, xz-compressed) | 326 KB |
| PKV (verifier key) | 179 KB |
| Browser proof (JSON encoding) | 477 KB (318 KB gzip) |
| Native proof (binary `.np`, zstd) | 306 KB |
| Rust verify, browser proof, 1 thread (`RAYON_NUM_THREADS=1`) | 26.2 ms median |
| Rust verify, browser proof, 12 threads | 13.4 ms median |
| Sidecar `POST /verify` (`duration_ms`, decode and verify, default threads) | 14 to 16 ms |

Unmet target: the single-core verification target is 20 ms (PROVER.md section 7). The measured
single-thread median is 26.2 ms. The proof is larger than the 50 to 200 KB target in
Architecture.md (306 KB binary, 477 KB JSON). The 16 MiB body limit has a large margin.

### Public-input order contract

`fixtures/protocol/batch-open-public-inputs.json` has the exact field-element vector that the
verifier receives, in order, and one real case (the gate witness). The registry fixture
generator writes it from a list that follows the parameters of `main`, not from the Rust or
TypeScript code. These tests check it:

- `crates/crypto/tests/public_inputs.rs`: `PUBLIC_INPUT_NAMES` and
  `BatchOpenPublicInputs::for_open(..).to_fields()` (the gateway form).
- `packages/crypto/src/public-inputs.test.ts`: `PUBLIC_INPUT_NAMES` and `batchOpenPublicInputs`
  (the SDK form).
- `crates/prover/tests/batch_open.rs`: the public inputs of the native and the Chromium proofs
  are equal to the contract vector. The 10 values are distinct, so a different order fails.

| Index | Name | Gateway source |
|---|---|---|
| 0 | `circuit_id` | `DeploymentConfig.circuit_id` (= `CIRCUIT_ID`) |
| 1 | `deployment_id_hi` | `DeploymentConfig.deployment_id()`, bytes 0..16 |
| 2 | `deployment_id_lo` | `DeploymentConfig.deployment_id()`, bytes 16..32 |
| 3 | `gateway_id_hi` | `DeploymentConfig.gateway_id`, bytes 0..16 |
| 4 | `gateway_id_lo` | `DeploymentConfig.gateway_id`, bytes 16..32 |
| 5 | `root` | accepted root record that the open request selects |
| 6 | `leaf_count` | leaf count of the same root record |
| 7 | `proof_epoch` | open request; the gateway checks freshness |
| 8 | `batch_id` | open request |
| 9 | `binding` | `H(DOM_BINDING, gateway_id_hi, gateway_id_lo, session_pub_hi, session_pub_lo)` from the session key of the open request |

Each value is a canonical BN254 field element (`0x` and 64 lowercase hex digits, big-endian).
The ProveKit JSON proof stores the same values as little-endian hex.

### Deployment configuration values

`config/deployment.testnet.template.toml` has these public values. The test
`deployment_template_pins_these_artifacts` checks them against `artifacts/batch-open/`.
The secret scan of `check.sh` accepts non-zero 32-byte values only on these three keys.

| Field | Value | Source |
|---|---|---|
| `circuit_id` | `0x00000000000000616e6f6e2d6372656469742f76312f62617463682d6f70656e` | `CIRCUIT_ID` (`anon-credit/v1/batch-open`) as 32 bytes |
| `verifier_artifact_hash` | `0xc8b4fb4722bb6d926d73112223865bd2756413f6f8085e549a90dd16a8aef6d4` | SHA-256 of `artifacts/batch-open/batch-open.pkv` |
| `prover_manifest_hash` | `0x373a90b6dde1fc48f6ee771659d76fe87b9c454fee606ab637c65a255c557648` | SHA-256 of `artifacts/batch-open/prover-manifest.json` |

The PKP digest (in the manifest) is `be804ed5936ffc4b82509136371bc0f4b6d7b4781188990595d20d3e9636b2e9`.

### Verifier sidecar

The gateway uses stable Rust. ProveKit needs the nightly toolchain. Thus the gateway does not
link ProveKit: it sends each proof to `anon-credit-prover serve`, a separate process that
listens only on `127.0.0.1`.

```sh
cd crates/prover
cargo run --release -- serve --pkv ../../artifacts/batch-open/batch-open.pkv \
  --pkv-sha256 c8b4fb4722bb6d926d73112223865bd2756413f6f8085e549a90dd16a8aef6d4
# options: --port 8083 --circuit-id <0xhex> --max-concurrency 2 --max-queue 32
#          --max-body-bytes 16777216 --max-proof-bytes 4194304
```

| Route | Request | Response |
|---|---|---|
| `POST /verify` | `{"proof": <JSON proof object as the browser emits, or base64 string of JSON or binary .np bytes>, "public_inputs": ["0x..", ...]}` | `{"ok": bool, "duration_ms": number, "error_code": string \| null}` |
| `GET /health` | | `{"ok", "pkv_sha256", "circuit_id", "witness_mode": "zk", "hash", "provekit_rev", "num_public_inputs", "num_constraints", "max_concurrency", "max_body_bytes"}` |

- The gateway makes `public_inputs` from its own values (the order contract). It does not copy
  them from the client.
- `error_code` values: `invalid_request` (400), `body_too_large` (413), `busy` (503),
  `internal` (500), and, with status 200 and `ok: false`: `circuit_id_mismatch`,
  `proof_malformed`, `public_input_count`, `public_input_mismatch`, `proof_invalid`.
- At most `max_concurrency` verifications run at the same time (default 2). At most
  `max_queue` requests wait (default 32). Other requests get `busy` at once.
- The body limit (16 MiB) and the proof limit (4 MiB) apply before the proof is decoded.
- The sidecar loads the PKV only if its SHA-256 is the pinned digest and the key is hiding.
- `duration_ms` is the decode and verification time. It does not include the queue time.

`crates/prover` adds these dependencies, at the versions of the root workspace: axum 0.8.9
(http1, json, tokio), tokio 1.54.1, serde 1, base64 0.22.1; tests: tower 0.5.3, http-body-util
0.1.5.

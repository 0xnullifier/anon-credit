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
| 1. Proof feasibility | Pin ProveKit and Noir, batch-open circuit, hash encodings, artifacts | Not started |
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
| Noir | nargo 1.0.0-beta.12 (`9a5b369`) | `noirup`. Installed at `~/.nargo/bin`, which is not on `PATH`. |

Phase 0 does not need Foundry or Noir to build. `check.sh` runs them if it finds them on
`PATH` or at the default install locations.

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
SKIP_OPTIONAL=1 ./check.sh   # skip Foundry and Noir
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
| Circuit (optional) | `nargo test` in `circuits/batch-open/` |

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
  prover/               ProveKit verifier adapter (phase 1)
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
circuits/batch-open/    Noir circuit (placeholder until phase 1)
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

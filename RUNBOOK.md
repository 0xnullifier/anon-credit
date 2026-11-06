# Demo runbook

This is the operator sequence for the Sepolia demo (implementation.md sections 14 and 15,
phase 6). Do the steps in order. Each step says what to do, what you see, and how long it takes.

Governing documents: [implementation.md](implementation.md), [MVP.md](MVP.md). Background on each
part: [README.md](README.md).

Contents:

1. Install the tools
2. Build the prover WASM
3. Deploy the contracts (helper)
4. Fill in the env file
5. Run the services behind HTTPS
6. Start the dashboard
7. Run `pnpm example:e2e`
8. What you see at each of the 16 steps
9. Expected waits
10. Demo script (4 minutes)
11. What is not in this build
12. Troubleshooting and stop

Secrets: the payer key, the issuer key, the deployer key, the admin token, RPC URLs with API
keys, and the Etherscan key. Keep them only in `config/testnet-demo.env` (git ignores it) or in
the shell. No script prints them. The result file of the run has none of them.

## 1. Install the tools

| Tool | Version | Install |
|---|---|---|
| Rust | stable 1.98.1 (pinned by `rust-toolchain.toml`) | `rustup` |
| Node | 26 or later | nodejs.org or your package manager |
| pnpm | 12.18.0 | `npm install -g pnpm` |
| Foundry | forge 1.7.1 (`forge`, `cast`, `anvil`) | `foundryup`; installs to `~/.foundry/bin` |
| ProveKit, nargo 1.0.0-beta.26, wasm-bindgen-cli | pins in `tooling/provekit/pins.env` | `tooling/provekit/install.sh` |
| Chromium | Playwright Chromium (149 measured) | `npx playwright-core install chromium`, or set `CHROMIUM_PATH` |
| jq, openssl, curl | any | macOS has them; Linux: package manager |
| Caddy or nginx | any current | for HTTPS termination (step 5) |

```sh
export PATH="$HOME/.foundry/bin:$HOME/.nargo/bin:$PATH"
pnpm install
./check.sh                 # all checks must pass
pnpm test:integration      # optional: local anvil run of the deploy helper, the launcher, and steps 1-15
```

## 2. Build the prover WASM

```sh
tooling/provekit/build-wasm.sh     # artifacts/provekit-wasm/{scalar,threaded}/ (about 5 MB each)
```

The deployment pins the prover manifest (`prover_manifest_hash` =
SHA-256 of `artifacts/batch-open/prover-manifest.json`). The manifest pins the SHA-256 of each
WASM file. `tooling/dev/run-services.sh` checks both and stops if a digest is different. If your
build gives different WASM bytes, the browser prover refuses them. Then you must either use the
WASM bytes of the machine that made the manifest, or make a new manifest and a new deployment
(`deployment_id` changes).

Hosting of the browser page: the page (`examples/e2e/browser/`) and the prover files
(`artifacts/`) do NOT have to be public. `pnpm example:e2e` serves them from your machine with
Vite on `http://127.0.0.1:5173` (`E2E_PAGE_PORT`), with COOP and COEP headers so that the
threaded prover can run. The Vite public directory is `artifacts/`, so the page loads
`/batch-open/prover-manifest.json` and the files that it pins. Only the issuer and the gateway
must be public HTTPS: the Nox exit nodes call them from the public internet.

If you want to host the page elsewhere (for example for a second browser profile in the demo),
serve `examples/e2e/browser/` built by Vite, with `artifacts/batch-open/` and
`artifacts/provekit-wasm/` at the same relative paths, and send these headers on every file:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without these headers the page uses the scalar prover (about 3 times slower; it still works).

## 3. Deploy the contracts (helper)

Fund the issuer key with Sepolia ETH. The issuer sends one `postRoot` transaction for each
30 s epoch (2,880 each day), so give it enough for the demo period. If you use a separate
deployer key, fund it too.

```sh
export SEPOLIA_RPC_URL=https://...          # must support the "finalized" block tag
export ISSUER_PRIVATE_KEY=0x...             # root publisher
# optional: DEPLOYER_PRIVATE_KEY=0x...  BATCH_PRICE_WEI=100000000000000  EPOCH_SECONDS=30
# optional: ETHERSCAN_API_KEY=...       (turns on forge verify-contract)
tooling/deploy/deploy-sepolia.sh
```

The helper:

1. Refuses an RPC whose chain ID is not 11155111.
2. Runs `forge script script/Deploy.s.sol:Deploy --broadcast`.
3. Reads both addresses, the transaction hashes, and the blocks from
   `contracts/broadcast/Deploy.s.sol/11155111/run-latest.json`, and checks the code, `issuer()`,
   and `epochSeconds()` on chain.
4. Writes `contracts/deployments/sepolia.json` (the deployment record).
5. Writes `config/deployment.testnet.toml` from the template: the addresses, the issuer address,
   chain ID 11155111, a new random `gateway_id` (`openssl rand -hex 32`), and the unchanged
   circuit, verifier, and prover manifest digests.
6. Prints `DEPLOYMENT_CONFIG=...` and `ISSUER_START_BLOCK=<CreditSale block>`.
7. With `ETHERSCAN_API_KEY`, verifies both contracts on Etherscan.

It refuses to replace existing output files. `DEPLOY_FORCE=1` replaces them, which makes a new
deployment (new `gateway_id`, new `deployment_id`). Git ignores `config/deployment.testnet.toml`.
You can commit `contracts/deployments/sepolia.json` and the broadcast file: they are public.

Test of the helper (no Sepolia): `tooling/deploy/test-deploy-anvil.sh [--with-services]` deploys
to a local anvil with chain ID 11155111 and checks the written files. `pnpm test:integration`
runs it with `--with-services`.

## 4. Fill in the env file

```sh
cp config/testnet-demo.env.example config/testnet-demo.env
openssl rand -hex 32        # use the output as GATEWAY_ADMIN_TOKEN
```

Set at least these values:

| Variable | Value |
|---|---|
| `DEPLOYMENT_CONFIG` | `config/deployment.testnet.toml` (printed by the helper) |
| `ISSUER_START_BLOCK` | printed by the helper |
| `SEPOLIA_RPC_URL` | Sepolia RPC with the `finalized` tag. Secret if it has a key. |
| `ISSUER_PRIVATE_KEY` | root publisher key. Secret. |
| `GATEWAY_UPSTREAM_RPC_URL` | Sepolia RPC for the paid reads. Secret if it has a key. |
| `GATEWAY_ADMIN_TOKEN` | the random token. Secret. |
| `DEMO_IP_LOGGING` | `true` (demo profile) |
| `GATEWAY_TRUSTED_PROXY_ADDRS` | `127.0.0.1` if the proxy of step 5 runs on the same host |
| `ISSUER_BIND`, `GATEWAY_PUBLIC_BIND` | `127.0.0.1:8080`, `127.0.0.1:8081` behind a local proxy |
| `GATEWAY_ADMIN_BIND` | `127.0.0.1:8082`. Never public. |

The example run reads these from the shell (section 7):

| Variable | Use |
|---|---|
| `E2E_ISSUER_URL`, `E2E_GATEWAY_URL` | Public HTTPS URLs of the issuer and the gateway. The run refuses HTTP, localhost, and private addresses. |
| `E2E_PAYER_KEY` | Test payer key (the brief calls it PAYER_PRIVATE_KEY). Secret. Needs 3 x `BATCH_PRICE_WEI` plus gas. |
| `E2E_PAYMENT_RPC_URL` | Payer RPC for the purchase and the funding check. Empty: `SEPOLIA_RPC_URL`. |
| `NOX_BOOTSTRAP_RPC_URL` | RPC that reads the Nox specifier (the brief calls it BOOTSTRAP_RPC_URL). Default: public Sepolia RPC. |
| `E2E_ADMIN_URL`, `GATEWAY_ADMIN_TOKEN` | Private admin access for step 15. Both or neither. Use an SSH tunnel if the gateway is remote: `ssh -L 8082:127.0.0.1:8082 host`, then `E2E_ADMIN_URL=http://127.0.0.1:8082`. |
| `CHROMIUM_PATH` | Chromium executable. Empty: the Playwright cache. |
| `E2E_TIMEOUT_SECONDS` | Overall timeout. Default 7200 (two hours). |
| `E2E_PROVER_MODE` | `auto` (default), `scalar`, or `threaded`. |
| `E2E_PAGE_PORT`, `DASHBOARD_PORT` | 5173 and 5174. |
| `E2E_DEPLOYMENT_ID` | Optional pin of the `deployment_id`. |
| `E2E_TEST_ADDRESS` | Address for `eth_getBalance`. Default `0x...dead`. Not the payer. |
| `E2E_RESULT_PATH` | Result file. Default `examples/e2e/results/sepolia-result.json`. |

Fixed timeouts in the code: Nox ready 180 s, page ready 120 s, issuance and root polls every 15 s.
The local harness has `INTEGRATION_TIMEOUT_MS` (default 1,200,000).

## 5. Run the services behind HTTPS

```sh
tooling/dev/run-services.sh                 # reads config/testnet-demo.env
tooling/dev/stop-services.sh                # stops them (data/run/latest)
```

`run-services.sh` checks the deployment file and the prover artifacts (it runs
`tooling/provekit/build-wasm.sh` if the WASM is missing), builds the release binaries
(`SKIP_BUILD=1` skips it), and starts the verifier sidecar, the issuer, and the gateway with
`nohup`. Logs and process IDs go to `data/run/<UTC time>/` (`RUN_DIR` changes it;
`data/run/latest` points to the newest). Health checks: sidecar `GET /health` (the key digest
must be the deployment `verifier_artifact_hash`), issuer `GET /v1/epoch`, gateway `GET /v1/config`
(its `deployment_id` must equal the issuer value), and the admin snapshot with the token. If a
check fails, the script stops what it started and exits 1. `stop-services.sh` stops only the
processes in `services.pids`.

What you see: one line for each start and each ready check, then the deployment ID, the URLs,
the log directory, and the stop command.

### HTTPS termination

The issuer and the public gateway port must be public HTTPS. The admin port (8082) and the
sidecar (8083) stay private. Set `GATEWAY_TRUSTED_PROXY_ADDRS` to the address from which the
proxy connects (`127.0.0.1` on the same host). The gateway then reads the client address from
`X-Forwarded-For`, right to left, skips trusted proxies, and takes the first other address. It
shows the proxy hop separately (`proxy_hop`, "Socket peer IP" in the dashboard). A forwarding
header from any other peer is ignored, so a client cannot set its own observed address.

Caddy (`Caddyfile`; Caddy gets the certificates):

```caddyfile
registry.example.org {
	reverse_proxy 127.0.0.1:8080
}

rpc.example.org {
	# Caddy replaces a client X-Forwarded-For with the real client address unless
	# trusted_proxies is set, so the gateway sees "<client>" with the hop 127.0.0.1.
	reverse_proxy 127.0.0.1:8081
	# Demo profile only. In the normal profile, do not log client addresses.
	log
}
```

nginx:

```nginx
server {
    listen 443 ssl;
    server_name rpc.example.org;
    ssl_certificate     /etc/letsencrypt/live/rpc.example.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/rpc.example.org/privkey.pem;
    # Open requests and proof chunks (POST /v1/open, PUT /v1/open/chunks).
    client_max_body_size 16m;
    location / {
        proxy_pass http://127.0.0.1:8081;
        # Replace, do not append: the client cannot add its own addresses.
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Host $host;
    }
    # Demo profile only. In the normal profile use: access_log off;
    access_log /var/log/nginx/rpc.access.log;
}

server {
    listen 443 ssl;
    server_name registry.example.org;
    ssl_certificate     /etc/letsencrypt/live/registry.example.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/registry.example.org/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
    }
}
```

Check from another machine:

```sh
curl -s https://rpc.example.org/v1/config | jq .deployment_id
curl -s https://registry.example.org/v1/epoch
curl -s https://rpc.example.org/v1/demo/peer     # your address, attribution "trusted_proxy", proxy_hop 127.0.0.1:<port>
```

If `/v1/demo/peer` shows `attribution: "socket"` and `observed_ip: "127.0.0.1"`, then
`GATEWAY_TRUSTED_PROXY_ADDRS` is wrong: every request then shows the proxy address.

## 6. Start the dashboard

On the operator machine (the dashboard does not need to be public):

```sh
ssh -L 8082:127.0.0.1:8082 <gateway-host>     # only if the gateway is remote
pnpm dashboard:dev                            # http://localhost:5174
```

Sign in with:

- Admin API URL: `http://127.0.0.1:8082`
- Public gateway URL: `https://rpc.example.org` (the probe must use the same public ingress as
  the paid traffic)
- Token: `GATEWAY_ADMIN_TOKEN`

The token stays in the `sessionStorage` of the tab and goes only in the `Authorization` header.
What you see before the run: status `ok`, upstream chain Sepolia, current epoch, accepted roots
(the issuer publishes one root each epoch; the first one is accepted after root finality, about
13 minutes after the first publication), zero sessions, the proof and privacy panel with the
deployment ID, gateway ID, circuit ID, verifier key pin (it must say "equals the pin"), epoch
length 30 s, IP capture on, the price table (hash check "matches the canonical encoding"), and the
accepted roots. Click "Direct probe" in the demo comparison panel: column (a) shows your own
address.

## 7. Run `pnpm example:e2e`

```sh
set -a; source config/testnet-demo.env; set +a
export E2E_ISSUER_URL=https://registry.example.org E2E_GATEWAY_URL=https://rpc.example.org
export E2E_PAYER_KEY=0x...                      # secret
export E2E_ADMIN_URL=http://127.0.0.1:8082      # with GATEWAY_ADMIN_TOKEN from the env file
pnpm example:e2e -- --dry-run                   # all checks, no transaction
pnpm example:e2e                                # the full run
```

The dry run must print `ok` for every check and "no transaction was sent". The full run prints the
dashboard URL and a reminder to sign in with the admin token at the start and at the end. It
never prints the token. The result is `examples/e2e/results/sepolia-result.json`: step outcomes,
timings, proof size, public deployment values, and in step 15 the admin view of the three
batches (remaining, cumulative units, next seq, state, receipt count, proof size, verification
time), the gateway counters, and the observed source addresses. It has no key, token,
passphrase, or RPC URL. The run exits nonzero on a failed step or on the timeout.

Note on step 8: Nox refuses request bodies above about 40,000 bytes. The open request carries a
proof of about 475 KB. The open goes through the chunked proof upload
(`PUT /v1/open/chunks`, then `POST /v1/open` with the upload reference), which keeps each request
below the Nox limit. If your gateway build has no chunked upload, the run fails at step 8.

## 8. What you see at each of the 16 steps

Console lines start with `[e2e hh:mm:ss]`. The dashboard updates within 1 s of each event.

| Step | Console | Dashboard |
|---|---|---|
| 1. Preflight | One `ok`/`FAIL` line per check: identities, chain IDs, manifest digest, connectivity, funding, admin access. A failure stops the run before the purchase. | Nothing (the checks read only public endpoints and one snapshot). |
| 2. Browser prover and transport | Nox ready time (4 to 5 s typical, up to 180 s), prover mode and threads, three batches made in the browser. | Nothing. |
| 3. Purchase | `sending CreditSale.buy for 3 batches`, then the transaction hash, log index, and block. | Nothing: the gateway has no payment data. |
| 4. Issuance | `waiting for Sepolia finality of the payment (about 13 minutes)`, then `topup pending (...)` lines every 15 s, then `issued`. | Nothing. |
| 5. Eligible root and delay | Progress lines until a finalized root with the new leaves is accepted, then the random delay of 0 to 3 epochs. | Accepted roots: the leaf count grows by 3 in a new root. Root age stays small. |
| 6. Membership path | The path is fetched on the `registry:<batch>` isolation key and checked locally. | Nothing (the path comes from the issuer). |
| 7. Proof | Proof size (about 475 KB), proving time (about 0.2 s threaded, 0.5 s scalar on an M4 Pro). | Nothing. |
| 8. Open batch 1 | `remaining 100, next_seq 0`. | Events `open_received` -> `open_verified` (verification time) -> `session_opened`. Health: sessions active 1. Demo comparison column (b) fills: the observed source IP of the Nox exit. |
| 9. Three reads | Remaining 99, 98, 96; next_seq 1, 2, 3. | `rpc_received`/`rpc_completed` pairs with methods `eth_chainId`, `eth_blockNumber`, `eth_getBalance`, units 1, 1, 2. Spend table in the demo comparison. |
| 10. Replay and conflict | Same body, `X-Anon-Replayed: true`, no debit; another body with the same seq: `sequence_conflict`. | `rpc_replayed` (no units), then `rpc_rejected sequence_conflict`. Remaining stays 96. |
| 11. Bad signature and gap | `signature_invalid`, `sequence_gap`, remaining 96. | Two `rpc_rejected` events. Failure counters grow. |
| 12. Exhaustion | 96 one-unit reads to 0, then `insufficient_units` with next_seq 99. | Many `rpc_completed` events; session state `exhausted`; receipt count "99 receipts (all)". |
| 13. Batch 2 | Opens on a new isolation key; one read leaves 99. | A second `session_opened` with a new batch ID. Nothing in the gateway joins the two batches. |
| 14. Batch 3 | A modified proof gives `proof_invalid` and no session row; the valid open gives 100. | `open_rejected proof_invalid`, then `open_verified` and `session_opened`. |
| 15. Admin check | Remaining 0, 99, 100 in the admin view; counters and observed addresses go into the result. | Select each batch: the timeline shows open_received -> open_verified -> session_opened -> rpc_*; the deadline shows as a UTC time. |
| 16. Result | `result: pass; written to ...`, then the dashboard reminder. | Unchanged. |

## 9. Expected waits

| Wait | Time | Why |
|---|---|---|
| Nox ready | 4 to 5 s, rarely 80 s | Worker start and Nox entry dials |
| Payment finality (step 4) | about 13 minutes | The issuer reads `Purchased` logs only up to the `finalized` block (two Sepolia epochs of 6.4 min). |
| Epoch boundary | up to 30 s | Leaves of epoch e are in the root of e; eligible from e + 1. |
| Root publication and root finality (step 5) | about 13 minutes | The gateway reads `RootRegistry` at the `finalized` tag. |
| Random first-use delay (steps 5, 13, 14) | 0 to 3 epochs (0 to 90 s) | Chosen once per batch in the browser. |
| Proof (step 7) | under 1 s | Browser ProveKit, measured |
| Steps 8 to 15 | a few minutes | About 110 paid requests through Nox (about 2 s each) |

Plan for 30 to 40 minutes from step 3 to the end. For a live audience, do steps 1 to 7 before
the presentation, or run the presentation on a run that is already past step 5.

## 10. Demo script (4 minutes)

Adapted from MVP.md section 4 to what exists. There is no demo dApp and no dispenser: the
dashboard is the visual, and the browser page of the example is the client.

Before the audience arrives: services up, dashboard signed in, `pnpm example:e2e` started and
past step 5 (or done; then show the events of the run).

1. Dashboard, health panel (30 s). Point at the epoch (30 s), the accepted roots with the root
   age, the price table with "matches the canonical encoding", the verifier key "equals the
   pin", and IP capture "on (demo profile)". Say: the purchase was a normal Sepolia transaction;
   the issuer inserted three leaves and published a root on Sepolia; the gateway read it at the
   finalized tag.
2. Demo comparison, column (a) (30 s). Click "Direct probe". It shows the address of this
   browser as the gateway sees it (through the HTTPS proxy: "Observed source IP", socket peer =
   proxy hop).
3. Demo comparison, column (b) (60 s). The newest `session_opened` and its spends: batch ID, seq,
   method, and an observed source IP that is a Nox exit address, not the probe address. Read the
   statement on the page: different addresses are evidence of routing, not proof against timing
   or content analysis. No key, no account, no IP of the payer.
4. Sessions panel (45 s). Select batch 1: the timeline open_received -> open_verified ->
   session_opened -> rpc_*, the verification time, the proof size, remaining units, cumulative
   units, the deadline as a UTC time, and the receipts (99 at the end). Then batch 2: a different
   batch ID with nothing in the gateway that joins it to batch 1.
5. Replay and tamper (45 s). In the event list, filter by batch 1: the `rpc_replayed` event (same
   response, no charge), `sequence_conflict`, `signature_invalid`, `sequence_gap`. Filter by
   batch 3: `proof_invalid` before the valid open.
6. Close (30 s). Health counters: requests served, opens, median and p95 spend and open latency,
   median verification time, median proof size. Show the result file: `"status": "pass"`.

## 11. What is not in this build

| Not built | Instead | Pointer |
|---|---|---|
| Dispenser (a developer server that holds batches and hands one to each user) | The example runner buys batches; the browser page holds them. | implementation.md section 2 (later scope), Architecture.md 4.8, PRD.md R30, FUTURE.md section 7 |
| Custom combined Anon-RPC worker (hash-pinned worker bundle with the SDK inside) | The stock Nox worker from `@anon-rpc/browser-harness`; the SDK runs on the page. | implementation.md sections 2 and 17, MVP.md section 2, FUTURE.md section 7 |
| Offchain payment (card, UPI) and remainder credit | Exact onchain `CreditSale.buy` payments of whole batches. | PRD.md R3 and R8, Architecture.md 4.2, MVP.md section 8, FUTURE.md section 1 |
| Demo dApp with three modes and the public log viewer | The dashboard (private, with the admin token). | MVP.md sections 2 and 3 |
| Onchain registry, many gateways, settlement receipts | One issuer and one gateway (trusted for the beta). | FUTURE.md sections 3 to 6 |
| Measurement phase (load tests, benchmarks) | Measured proving and verification numbers in README.md. | implementation.md section 16, phase 7 |

## 12. Troubleshooting and stop

| Symptom | Cause and action |
|---|---|
| `run-services: FAIL: ... does not have the digest that the manifest pins` | Your WASM build differs from the pinned build. See section 2. |
| Gateway does not start: sidecar `pkv_sha256` | The sidecar key is not the deployment `verifier_artifact_hash`. Use `artifacts/batch-open/batch-open.pkv`. |
| Issuer: `finality_unavailable` | The RPC has no `finalized` tag. Use another Sepolia RPC. |
| Dashboard: "admin token is required" | Wrong token, or the token has a space. Sign out and enter it again. |
| Dashboard probe: network error or CORS refusal | Add the dashboard origin to `GATEWAY_CORS_ORIGINS` and restart the gateway. |
| Every event shows `127.0.0.1` | Set `GATEWAY_TRUSTED_PROXY_ADDRS` (section 5). |
| Example refuses the URLs (exit code 2) | The URLs must be public HTTPS (Nox cannot reach private addresses). |
| Step 5 times out | No root accepted: check the issuer log (publisher funded?), and the gateway root status in the dashboard. |

Stop: `tooling/dev/stop-services.sh` (or with the run directory). The databases in `data/` stay;
the next start continues with them. The example stops only the page and Chromium that it
started; it never stops the services.

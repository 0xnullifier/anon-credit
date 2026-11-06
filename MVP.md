# MVP: hosted demo

Status: Draft 1
Date: 2026-11-07
Companions: PRD.md, Architecture.md, FUTURE.md

## 1. Goal

One hosted system that a judge or a first customer can touch.
It must show, with public logs and not with claims, that the gateway serves RPC without an API key, a login, or an IP address.
It runs on this project's own credential layer. zkAPI is not in the MVP. The presentation names it as one production route (FUTURE.md section 7).

## 2. Hosted components

| Host | Component | Notes |
|---|---|---|
| rpc.<domain> | Gateway | One binary behind TLS. `POST /open`, `POST /rpc`, `GET /prices`, `GET /roots`, `GET /status`. Upstream: one paid provider key for mainnet reads, one Sepolia node. |
| registry.<domain> | Registry service | Sells batches, keeps the Mountain Range tree, posts roots, serves paths and peaks. Reachable through Anon-RPC. |
| Base Sepolia | Root contract | `postRoot(epoch, root)`, `rootAt(epoch)`. 96 roots per day at 900 s, 2,880 at the 30 s testnet epoch. |
| Sepolia | Specifier contract | Pins the worker bundle hash and resolver URLs, listed the same way Nox and tor-js are. |
| worker.<domain> | Worker bundle | Hash-pinned Anon-RPC worker that wraps the SDK and dials the gateway over Nox. |
| dispenser.<domain> | Dispenser and dashboard | Buy batches with a testnet wallet. See batches and units left. Copy one config line for a dApp. |
| demo.<domain> | Demo dApp | Portfolio viewer. Any address. Mode toggle: direct provider, public RPC, our gateway over Nox. |
| logs.<domain> | Public gateway log | Live tail of what the gateway records. IP and transport fields are absent from the schema, not redacted. |
| prover sidecar | Prover | Runs next to the dispenser for the demo. Its proving time is on the status page. |

Demo epoch: `EPOCH_SECONDS=30` on the Sepolia testnet deployment, so a judge waits 30 seconds, not fifteen minutes. Production is 900.
Random first-use delay: `FIRST_USE_DELAY_EPOCHS=0..1` on the demo deployment. Production is 0 to 3.

## 3. What the demo dApp does

1. Paste an address. The page shows ETH balance, ERC-20 balances, and the last 20 transfers.
2. A mode toggle switches the transport:
   - Direct provider: the dApp's own provider key, as dApps do today.
   - Public RPC: a rate-limited public endpoint.
   - Our gateway: the SDK with one batch, over the Anon-RPC worker on Nox.
3. A side panel shows what the RPC provider received for the last request in each mode:
   - Direct provider: key, viewer IP, method, address. Described, with a screenshot of the provider dashboard.
   - Public RPC: viewer IP, method, address.
   - Our gateway: batch id, seq, method, address. Pulled live from logs.<domain>.
4. A footer shows latency per mode for the last request.

## 4. Demo script

Target: 4 minutes.

1. Dashboard. Buy five batches with a testnet wallet. Show the five leaf indices and the root on Base Sepolia. The epoch boundary passes in 30 seconds.
2. Demo dApp, direct mode. Query a known whale address. Show the provider dashboard with the dApp key, the IP, and the address on one line.
3. Flip to our gateway. Same query, same result. Show logs.<domain>: batch id, seq, method, no IP, no key, no account. Show the worker log in the browser: three Nox entry nodes dialed, TLS opened inside the sandbox.
4. Second browser profile, second batch, same address. Show two batch ids in the log with nothing to join them. Show the dispenser dashboard: both batches belong to one developer, and the developer cannot see the address.
5. Open the browser network tab. Replay the last spend request as-is. The gateway serves it from cache with no new debit. Change one byte of the body and replay. The gateway rejects it at the signature step.
6. Status page. Requests served, opens per minute, median spend latency, median open latency, proving time per batch on the sidecar.

## 5. What it must prove

- The developer integration is one config line. Nothing else in the dApp changed.
- The public log is enough to audit the privacy claim. No trust in the operator's word.
- The three links from PRD section 3 appear as three log views: the provider sees everything, our gateway sees a batch id, the developer sees a customer.
- The system works through a real mixnet with latency a user accepts.
- The credential layer is real code with a measured proving time.

## 6. Status page metrics

| Metric | Why |
|---|---|
| Requests served, opens served | scale |
| Median and p95 spend latency at the gateway | G2, target under 5 ms |
| Median and p95 open latency at the gateway | G3, target under 50 ms |
| End-to-end latency over Nox, median | the user's experience |
| Proving time per open proof on the sidecar | decision D1, the one unmeasured number |
| Proof size | bandwidth per batch |
| Open batches, batches at zero | economics |
| Anonymity set: unexpired leaves under the newest root | M4 |

## 7. Build order

1. Registry: top-up, Mountain Range tree, root posting, paths and peaks. Local first, then hosted.
2. Open circuit and sidecar prover. Measure proving time on a laptop before anything else is built on it.
3. Gateway: open pipeline, spend pipeline, batch store, replay cache, public log schema, status page.
4. SDK: batches, open, signed spend, retry, one circuit per batch.
5. Worker bundle and specifier contract on Sepolia. Verify it boots in the Anon-RPC harness over Nox.
6. Dispenser and dashboard.
7. Demo dApp with the three modes and the side panel.
8. Public log viewer.
9. Load test at 100 requests per second through the gateway without the mixnet, then 10 requests per second through Nox.

Step 2 gates everything. If an open proof takes more than 10 seconds on a laptop, raise K or change the prover before step 3.

## 8. Not in the MVP

- Mainnet money. Testnet only.
- User-pays wallet mode, beyond the worker being installable.
- Several gateways, rotation between gateways, reputation.
- Offchain payment.
- Browser-side proving. The sidecar is the prover.
- zkAPI. Named in the presentation as a production route.

Each of these is a line in FUTURE.md. The demo says so instead of faking it.

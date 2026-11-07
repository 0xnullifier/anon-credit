# Learnings: Anon-RPC demo

Each entry has three parts: what I expected, what happened, and what to do.

## 1. No Node harness on npm
- Expected: `@anon-rpc/node-harness` could be on npm.
- Actual: `npm view` gives E404. In the repo, `impl/node-harness` is `"private": true`, version `0.0.0`. Its README says "Not yet a conforming harness".
- Do: Use `@anon-rpc/browser-harness` in a browser. Do not plan on a Node script.

## 2. The harness has no stage events
- Expected: Events for "resolving specifier" and "bundle verified".
- Actual: The only signals are `ready`, `acceptLog()` and rejections.
- Do: Log "resolving specifier" in your bootstrap `rpcProvider` when it gets `eth_call`. Log "bundle verified" when the sandboxed iframe (`sandbox="allow-scripts"`) appears in `document.body`, because the harness adds that iframe only after the keccak256 check passes.

## 3. The specifier is read with two eth_call requests
- Expected: One call to the bootstrap provider.
- Actual: Two `eth_call` requests, one for `workerHash()` and one for `resolvers()`.
- Do: Expect two log lines. The provider is not used after boot.

## 4. RpcError.code is not only a KpsErrorCode
- Expected: SPEC §12 lists only KPS codes (`timeout`, `network-error`, ...).
- Actual: Workers send their own codes through `signalFailed`, for example Nox sends `bad-config` and `unsupported-platform`. Some boot errors have no code: a failed specifier read, a hash mismatch or a bundle load error is a plain `Error`, not an `RpcError`.
- Do: Check `instanceof RpcError` first. In the `switch`, handle `undefined` and add a `default` case. Read the worker README for its codes.

## 5. host.js needs a bundler
- Expected: Serve `dist/host.js` from `node_modules` with no build.
- Actual: It imports bare names (`@anon-rpc/harness-core`, `@kpstreams/webrtc-client`, `@kpstreams/core/webrtc`, many `@noble/hashes/*` subpaths). An import map for all of them is fragile.
- Do: Bundle with esbuild (`--bundle --format=esm`). The output is about 116 KB. npm shows an "install-scripts" warning for esbuild, but the binary works.

## 6. The harness needs document.body
- Expected: Nothing about the DOM.
- Actual: The harness appends a hidden iframe to `document.body`, and it listens for `message` on `window`.
- Do: Make the worker only after the body exists, for example from a module script at the end of the page.

## 7. The default srcdoc iframe works without a CSP
- Expected: Possible CSP problems.
- Actual: The page has no CSP, so the inline `srcdoc` bootstrap ran. With a strict `script-src`, `ready` would never settle.
- Do: If you add a CSP without `'unsafe-inline'`, serve `dist/iframe-boot.js` from your own origin and set `iframeUrl`.

## 8. The specifier chain is not the target chain
- Expected: The brief gave this, and it was correct, but it is easy to get wrong.
- Actual: The Nox specifier is on Sepolia (11155111). The anonymized fetch still reads mainnet blocks. The other three specifiers are on mainnet (`chainId` is not given, which means 1).
- Do: Choose the bootstrap RPC from the specifier `chainId`. Compare `eth_chainId` with it before you boot. The wallet guide does not show this check.

## 9. Mixnet workers ran in headless Chromium
- Expected: The brief said that maybe only the passthrough worker runs without a live network.
- Actual: Nox and Nym both worked in headless Chromium over real WebRTC/KPS. Nox was ready in about 3.4 to 4 s, and its calls took 1.4 to 2 s.
- Do: Use Nox as the default for a real anonymized demo. Use passthrough only as a fast fallback. Passthrough does not anonymize.

## 10. Nym bootstrap is slower than adopters.json5 says
- Expected: "A few seconds to bootstrap".
- Actual: Ready at about 30 s (it auto-discovers an IP Packet Router, which took about 16 s). The first call took about 17 s. The second call took about 1 s.
- Do: Set a `ready` timeout of 60 s or more, and keep the worker open for later calls.

## 11. The tor-js demo gateway did not answer
- Expected: The `exampleConfig` gateway in adopters.json5 works.
- Actual: The KPS dial to `152.236.3.22:12298` timed out. Tor did not get a consensus in 120 s.
- Do: Treat that gateway as unreliable. Run your own gateway, or choose another worker.

## 12. Passthrough needs CORS from the target RPC
- Expected: The wallet guide does not mention CORS.
- Actual: The passthrough worker uses a plain `fetch` from a null-origin worker (`Origin: null`). The target RPC must send `Access-Control-Allow-Origin: *`. publicnode does this.
- Do: For the passthrough worker, use an RPC that allows any origin. Nox does TLS inside the worker and sends the request through the exit, so this applies to passthrough only.

## 13. acceptLog() takes the logs from the console
- Expected: Worker logs always go to the console.
- Actual: After the first `acceptLog()` call, the harness stops echoing worker logs to the console.
- Do: If you call `acceptLog()`, print the entries yourself. Start the loop early, because entries are kept from boot (up to 1000).

## 14. Log order around ready
- Expected: The worker log "ready" comes before `worker.ready` resolves.
- Actual: The Nox log line "nox-worker ready" came after the host `ready` resolved, because logs and the ready event arrive as separate messages.
- Do: Use `worker.ready` for control flow. Do not use log lines for control flow.

## 15. Passthrough resolver host
- Expected: The bundle is served from `ethereum/anon-rpc`.
- Actual: The passthrough resolver URL is `raw.githubusercontent.com/privacy-ethereum/anon-rpc/keccak/...`. This does not matter, because the hash pins the bundle.
- Do: Trust the hash, not the URL.

## 16. Tool problems (not Anon-RPC)
- Expected: `playwright-core` finds its browser, and `timeout` exists.
- Actual: playwright-core 1.65 wants Chromium revision 1254, but only 1228 was in the cache. macOS has no `timeout` command.
- Do: `verify.mjs` uses `CHROMIUM_PATH` or the newest cached Chromium, and it has its own `VERIFY_TIMEOUT_MS`.

## 17. Nox carries 8 requests of 40 KB at the same time
- Expected: Nox refuses request bodies above about 48,000 bytes (60,000 bytes failed with `protocol-error: TLS record buffering ... failed to write whole buffer`). Many requests in flight on one isolation key can make Nox throttle or close tunnels.
- Actual: `NOX_BOOTSTRAP_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com node examples/e2e/nox-probe.ts --chunks` (2026-11-07, headless Chromium 149, two probe runs) sent the 8 raw chunks of a real proof (318,335 bytes of gzip; 7 bodies of 40,000 bytes and 1 of 38,335 bytes; `application/octet-stream`; URL at most 190 bytes) with `PUT` to `https://httpbingo.org/anything` + the chunk path. With 8 in flight: 72 of 72 chunks passed in the first pass in 9 runs, no retry; 8 chunks took 4.4 to 6.6 s (median 5.7 s); one chunk took 2.2 to 6.6 s (median 4.4 s). With 4 in flight: 6.4 s. With 1 at a time: 19.7 s (1.9 to 4.5 s per chunk). The echo had every chunk unchanged. The harness copies a `Uint8Array` body to the worker and keeps custom headers such as `content-type`. httpbin.org answered 429 to 8 requests at the same time, also without Nox; httpbingo.org did not. Nox was ready after 79 s in both runs (earlier: 4 to 5 s). The earlier format (24 KiB as base64 in JSON, 13 chunks, 4 in flight) took 19 to 38 s.
- Do: Send binary data as raw bytes, not base64 in JSON: it gives 33 % more data per request. Put the request metadata in the URL path (no secrets), so that it does not depend on header forwarding. Keep each body at 40,000 bytes or less. Send up to 8 requests at the same time on one isolation key, and keep a sequential retry for failed ones. Use httpbingo.org, not httpbin.org, as an echo for parallel probes.

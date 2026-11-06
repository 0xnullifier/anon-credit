# anon-rpc-demo

A bare-bones browser demo of [Anon-RPC](https://github.com/ethereum/anon-rpc).
The page makes an `AnonRpcWorker` (`@anon-rpc/browser-harness` 0.4.0), waits for `ready`,
sends `eth_blockNumber` two times through the anonymized `fetch` (the second call with
`anonOptions.isolationKey`), shows the result and timing, and then closes the worker.

The default worker is **Nox** (Sphinx mixnet). Its specifier contract is on **Sepolia**.

## Prerequisites

- Node 20 or later (tested on Node 26).
- A Chromium-based browser for `npm start`. WebRTC must be available (the harness dials KPS over WebRTC).
- For `npm run verify` only: a Playwright Chromium. If you do not have one, run `npx playwright-core install chromium`, or set `CHROMIUM_PATH`.

## Commands

```sh
cd anon-rpc-demo
npm install
npm start                 # builds public/app.js with esbuild, serves http://localhost:5173/
```

Open http://localhost:5173/ and look at the page (the same lines go to the DevTools console).
To change the worker: `?worker=passthrough`, `?worker=nym`, `?worker=tor-js`.

Headless check (starts the server, runs the page in Chromium, exits 0 on success):

```sh
npm run verify            # Nox
node verify.mjs passthrough
node verify.mjs nym
```

Environment variables (all are optional):

| Variable | Default | Use |
|---|---|---|
| `RPC_URL` | `https://ethereum-rpc.publicnode.com` | Target RPC for the anonymized calls. Do not put a key in it. |
| `WORKER` | `nox` | Default worker when the URL has no `?worker=`. |
| `BOOTSTRAP_RPC_URL` | public RPC for the specifier chain | RPC that reads the specifier contract. It must be on the specifier chain. |
| `PORT` | `5173` (verify: `5174`) | HTTP port. |

URL parameters `?rpc=` and `?bootstrap=` override `RPC_URL` and `BOOTSTRAP_RPC_URL`.

## What you should see (Nox, measured)

```
worker=nox specifier=0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A specifierChain=11155111 bootstrap=https://ethereum-sepolia-rpc.publicnode.com
resolving specifier: eth_call to 0x3513... via https://ethereum-sepolia-rpc.publicnode.com
bundle verified (keccak256 == workerHash), sandbox iframe created after ~1000 ms
worker info: nox-worker boot.start ... kps.dial.ok ... kps.connected
ready after ~3500 ms
request sent (call 1): eth_blockNumber -> https://ethereum-rpc.publicnode.com
response (call 1): HTTP 200, block 26356863 (0x1922c7f) in ~2000 ms
request sent (call 2): ... anonOptions={"isolationKey":"demo-account-2"}
response (call 2): HTTP 200, block 26356863 (0x1922c7f) in ~1400 ms
DONE: all calls succeeded
worker closed
```

## Workers (from adopters.json5)

| id | Specifier | Specifier chain | Anonymizes | Config |
|---|---|---|---|---|
| passthrough | `0x4fd77be300f31c5fe6ab266d35d27750a3478d27` | 1 (mainnet) | **No**, plain fetch | none |
| nox | `0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A` | 11155111 (Sepolia) | Yes | optional, `undefined` boots on pinned anchors |
| nym | `0x3aCD9742C68F6d993066Ae25533e09b9e1f60eD0` | 1 (mainnet) | Yes | none |
| tor-js | `0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e` | 1 (mainnet) | Yes | `{ gateways: ["<ip>:<port>:<certhash>"] }` |

## Caveats

- **Bootstrap delay.** Nox was ready in about 3 to 4 s. Nym downloads an approximately 18 MB bundle and was ready in about 30 s, with a first call of about 17 s. tor-js builds Tor circuits and is the slowest. The page stops waiting after 120 s and shows a `timeout` error.
- **Bootstrap RPC.** The harness needs `preExisting.rpcProvider` to read the specifier contract one time. The demo uses a tiny provider over plain `fetch` to a public RPC. The demo stops if that RPC is on a different chain than the specifier.
- **Specifier chain.** The Nox specifier is on Sepolia, so its bootstrap RPC must be a Sepolia RPC. The other three are on mainnet. The specifier chain is not the chain that the anonymized fetch can reach: the Nox demo reads mainnet blocks.
- **passthrough does not anonymize.** It only shows the sandbox and the hash pinning. The page says this in red.
- **tor-js demo gateway.** The gateway in adopters.json5 is for demonstration only. In our test its KPS dial timed out and Tor did not bootstrap in 120 s.
- **Errors.** The page branches on `RpcError.code` (`timeout`, `network-error`, `bad-config`, `unsupported-platform`, `cancelled`, `closed`, ...), never on the message text.
- The harness is browser-only. `@anon-rpc/node-harness` is not on npm (the repo copy is private, version 0.0.0, a prototype).

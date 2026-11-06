# End-to-end example

Two runs share the same browser page (`browser/`) and the same step list (`src/scenario.ts`,
implementation.md section 15). Only the transport, the endpoints, and the timing differ.

| Run | Command | Chain | Transport |
|---|---|---|---|
| Local integration harness | `pnpm test:integration` (`node examples/e2e/integration.ts`) | anvil, 1 s blocks, 5 s epochs | direct (Nox cannot reach localhost) |
| Sepolia example | `pnpm example:e2e` | Sepolia, deployed contracts | Nox |
| Sepolia dry run | `pnpm example:e2e -- --dry-run` | none (reads only) | none |
| Nox probe | `node examples/e2e/nox-probe.ts` | none | Nox |

The Sepolia run does not start a chain and does not deploy contracts. It does not mock proofs or
give free credit. It refuses a localhost or private gateway or issuer URL. The payer needs test
ETH for three batches and gas. Never commit the payer key. Settings: `config/testnet-demo.env.example`
and the README section "SDK, transport, and end-to-end runs (phase 4)".

Results go to `results/` (git ignores it): `integration-result.json`, `sepolia-result.json`,
`nox-header-probe.json`. A result has no keys, passphrase, token, or RPC URL.

Known blocker for the Sepolia run: the Nox worker refuses request bodies above about 48 KB. The
open request with the proof is about 640 KB. See the README for the measurement.

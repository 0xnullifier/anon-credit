# End-to-end example

Status: placeholder (phase 0). Phase 4 implements the run.

The run uses deployed Sepolia contracts, public HTTPS services, and the real Nox worker.
It does not start a local chain. It does not mock proofs or give free credit.

```sh
pnpm example:e2e
```

Until phase 4, the command prints its settings and exits with code 2 ("not implemented").

Settings come from environment variables. See `config/testnet-demo.env.example`.
The payer needs test ETH for the purchase and gas. Never commit the payer key.

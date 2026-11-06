#!/usr/bin/env bash
# Run the local phase 4 integration harness (examples/e2e/integration.ts).
#
# It starts anvil, deploys the contracts, starts the verifier sidecar, the issuer, the gateway,
# and the e2e page, and runs the implementation.md section 15 steps in headless Chromium with
# the direct transport. It stops only the processes that it started.
#
# First it runs tooling/deploy/test-deploy-anvil.sh --with-services: the Sepolia deployment
# helper and tooling/dev/run-services.sh against a separate anvil with chain ID 11155111.
#
# Needs: ~/.foundry/bin (anvil, forge, cast), cargo, the ProveKit nightly toolchain, Chromium,
# jq, openssl.
# Result: examples/e2e/results/integration-result.json
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.foundry/bin:$HOME/.nargo/bin:$PATH"
# The deployment helper and the service launcher, against their own anvil (chain 11155111).
tooling/deploy/test-deploy-anvil.sh --with-services
exec node examples/e2e/integration.ts "$@"

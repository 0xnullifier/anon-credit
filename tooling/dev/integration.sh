#!/usr/bin/env bash
# Run the local phase 4 integration harness (examples/e2e/integration.ts).
#
# It starts anvil, deploys the contracts, starts the verifier sidecar, the issuer, the gateway,
# and the e2e page, and runs the implementation.md section 15 steps in headless Chromium with
# the direct transport. It stops only the processes that it started.
#
# Needs: ~/.foundry/bin (anvil, forge), cargo, the ProveKit nightly toolchain, Chromium.
# Result: examples/e2e/results/integration-result.json
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.foundry/bin:$HOME/.nargo/bin:$PATH"
exec node examples/e2e/integration.ts "$@"

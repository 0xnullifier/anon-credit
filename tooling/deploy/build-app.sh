#!/usr/bin/env bash
# Build the customer app (packages/app) for a public deployment and pack it as a tarball.
#
# Usage:
#   tooling/deploy/build-app.sh [env-file]      default env file: config/testnet-demo.env
#
# The env file gives the service URLs. The build reads:
#   E2E_GATEWAY_URL           -> VITE_GATEWAY_URL      (required, public HTTPS)
#   E2E_ISSUER_URL            -> VITE_ISSUER_URL       (required, public HTTPS)
#   NOX_BOOTSTRAP_RPC_URL     -> VITE_NOX_BOOTSTRAP_RPC_URL
#   APP_MAX_FIRST_USE_DELAY   -> VITE_MAX_FIRST_USE_DELAY_EPOCHS (default 0: demo profile)
# No private key goes into the build. The dev payer key is a development setting only.
#
# Output: packages/app/dist and dist/anon-credit-app.tar.gz. Serve dist/ as static files
# with these response headers on every path, or the threaded prover cannot run:
#   Cross-Origin-Opener-Policy: same-origin
#   Cross-Origin-Embedder-Policy: require-corp
# Add the app origin to GATEWAY_CORS_ORIGINS of the gateway and restart it.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
env_file="${1:-$repo/config/testnet-demo.env}"
[ -f "$env_file" ] || { echo "build-app: FAIL: $env_file is missing" >&2; exit 1; }

set -a
# shellcheck disable=SC1090
. "$env_file"
set +a

: "${E2E_GATEWAY_URL:?E2E_GATEWAY_URL is required (public HTTPS gateway URL)}"
: "${E2E_ISSUER_URL:?E2E_ISSUER_URL is required (public HTTPS issuer URL)}"

export VITE_GATEWAY_URL="$E2E_GATEWAY_URL"
export VITE_ISSUER_URL="$E2E_ISSUER_URL"
export VITE_NOX_BOOTSTRAP_RPC_URL="${NOX_BOOTSTRAP_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}"
export VITE_MAX_FIRST_USE_DELAY_EPOCHS="${APP_MAX_FIRST_USE_DELAY:-0}"
unset VITE_DEV_PAYER_KEY VITE_DEV_RPC_URL

echo "build-app: gateway $VITE_GATEWAY_URL, issuer $VITE_ISSUER_URL"
(cd "$repo" && pnpm --filter @anon-credit/app build)

mkdir -p "$repo/dist"
tar -C "$repo/packages/app/dist" -czf "$repo/dist/anon-credit-app.tar.gz" .
echo "build-app: wrote $repo/dist/anon-credit-app.tar.gz ($(du -h "$repo/dist/anon-credit-app.tar.gz" | cut -f1))"

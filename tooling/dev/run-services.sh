#!/usr/bin/env bash
# Start the verifier sidecar, the issuer, and the gateway for the testnet demo from one env file.
#
# Usage:
#   tooling/dev/run-services.sh [env-file]     default env file: config/testnet-demo.env
#   tooling/dev/stop-services.sh [run-dir]     default run directory: data/run/latest
#
# Make the env file once: cp config/testnet-demo.env.example config/testnet-demo.env, then fill
# it in (RUNBOOK.md, step 4). Git ignores config/testnet-demo.env.
#
# What the script does, in order:
#   1. Read the env file. Check the deployment file (no placeholders) and the required values.
#   2. Check the prover artifacts: build the WASM with tooling/provekit/build-wasm.sh if it is
#      missing, then check that the SHA-256 of artifacts/batch-open/prover-manifest.json is the
#      deployment prover_manifest_hash and that each WASM file has the digest that the manifest
#      pins. The e2e page serves these exact bytes (examples/e2e/src/page-server.ts).
#   3. Build the binaries (SKIP_BUILD=1 skips this step).
#   4. Start the sidecar, the issuer, and the gateway in the background with nohup. Each one
#      writes <run-dir>/<name>.log. The process IDs go to <run-dir>/services.pids.
#   5. Health checks: sidecar GET /health (pkv_sha256 must be the deployment verifier hash),
#      issuer GET /v1/epoch, gateway GET /v1/config (deployment_id must equal the issuer value),
#      and the admin snapshot with the token. If a check fails, the script stops the processes
#      that it started and exits 1.
#
# Block tag: this launcher is for the testnet demo. If the env file does not set BLOCK_TAG, the
# launcher sets BLOCK_TAG=latest for the issuer and the gateway: a purchase can open after one
# epoch plus chain latency, not after Sepolia finality. latest trades reorg safety for speed:
# testnet only. Set BLOCK_TAG=finalized in the env file to keep the production behavior.
#
# Settings (environment, optional):
#   RUN_DIR                  default data/run/<UTC time>; data/run/latest points to the newest
#   SERVICES_PROFILE         release (default) or debug
#   SKIP_BUILD               1: use the binaries that exist
#   HEALTH_TIMEOUT_SECONDS   default 120 for each service
#
# The services bind to the addresses in the env file. For public access, put an HTTPS reverse
# proxy in front of the issuer and the public gateway port (RUNBOOK.md, step 5). Keep the
# admin port and the sidecar port private.
#
# The script never prints a secret value. Secrets stay in the env file and in the environment
# of the services.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo"
export PATH="$HOME/.foundry/bin:$HOME/.cargo/bin:$PATH"

fail() {
  echo "run-services: FAIL: $*" >&2
  exit 1
}
say() {
  echo "run-services: $*"
}

for tool in curl jq cargo shasum; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is not installed or not on PATH"
done

env_file="${1:-config/testnet-demo.env}"
[ -f "$env_file" ] || fail "$env_file is missing. Copy config/testnet-demo.env.example to config/testnet-demo.env and fill it in."

# Read the env file. Every value goes to the environment of the services.
set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

# The testnet demo profile reads the chain at the latest block (see the header).
export BLOCK_TAG="${BLOCK_TAG:-latest}"
case "$BLOCK_TAG" in
  finalized | safe | latest) ;;
  *) fail "BLOCK_TAG must be finalized, safe, or latest" ;;
esac
if [ "$BLOCK_TAG" != "finalized" ]; then
  say "BLOCK_TAG=$BLOCK_TAG: reorg safety is traded for speed; use it only on a testnet"
fi

profile="${SERVICES_PROFILE:-release}"
case "$profile" in
  release) cargo_profile=(--release) ;;
  debug) cargo_profile=() ;;
  *) fail "SERVICES_PROFILE must be release or debug" ;;
esac
timeout="${HEALTH_TIMEOUT_SECONDS:-120}"

# --- 1. Settings ----------------------------------------------------------------------------
deployment="${DEPLOYMENT_CONFIG:-}"
[ -n "$deployment" ] || fail "DEPLOYMENT_CONFIG is not set"
[ -f "$deployment" ] || fail "DEPLOYMENT_CONFIG $deployment is missing (tooling/deploy/deploy-sepolia.sh writes it)"
if grep -qE '= "0x0+"$' "$deployment"; then
  fail "$deployment has placeholder values. Use the file that tooling/deploy/deploy-sepolia.sh wrote."
fi
toml_value() {
  sed -nE "s/^$1 = \"?([^\"]*)\"?$/\1/p" "$deployment"
}
verifier_hash="$(toml_value verifier_artifact_hash)"
manifest_hash="$(toml_value prover_manifest_hash)"
[[ "$verifier_hash" =~ ^0x[0-9a-f]{64}$ ]] || fail "verifier_artifact_hash in $deployment is not 32 bytes of hex"
[[ "$manifest_hash" =~ ^0x[0-9a-f]{64}$ ]] || fail "prover_manifest_hash in $deployment is not 32 bytes of hex"

for name in SEPOLIA_RPC_URL GATEWAY_UPSTREAM_RPC_URL GATEWAY_ADMIN_TOKEN; do
  [ -n "${!name:-}" ] || fail "$name is not set in $env_file"
done
[ "${#GATEWAY_ADMIN_TOKEN}" -ge 16 ] || fail "GATEWAY_ADMIN_TOKEN must have at least 16 characters"
if [ -z "${ISSUER_PRIVATE_KEY:-}" ]; then
  say "warning: ISSUER_PRIVATE_KEY is not set; the issuer records roots but does not publish them"
fi

# A listen address as a local URL: 0.0.0.0 and [::] become the loopback address.
local_url() {
  local bind="$1" port="${1##*:}"
  case "$bind" in
    0.0.0.0:* | "[::]:"*) echo "http://127.0.0.1:$port" ;;
    *) echo "http://$bind" ;;
  esac
}
issuer_url="$(local_url "${ISSUER_BIND:-0.0.0.0:8080}")"
gateway_url="$(local_url "${GATEWAY_PUBLIC_BIND:-0.0.0.0:8081}")"
admin_url="$(local_url "${GATEWAY_ADMIN_BIND:-127.0.0.1:8082}")"
verifier_url="${GATEWAY_VERIFIER_URL:-http://127.0.0.1:8083}"
sidecar_port="${verifier_url##*:}"
sidecar_port="${sidecar_port%%/*}"
[[ "$sidecar_port" =~ ^[0-9]+$ ]] || fail "GATEWAY_VERIFIER_URL must have an explicit port"
case "$verifier_url" in
  http://127.0.0.1:* | http://localhost:*) ;;
  *) fail "GATEWAY_VERIFIER_URL must be a loopback URL: the sidecar listens only on 127.0.0.1" ;;
esac

# --- 2. Prover artifacts --------------------------------------------------------------------
sha256_of() {
  shasum -a 256 "$1" | awk '{print $1}'
}
manifest="artifacts/batch-open/prover-manifest.json"
if [ ! -f artifacts/provekit-wasm/scalar/provekit_wasm_bg.wasm ] || [ ! -f artifacts/provekit-wasm/threaded/provekit_wasm_bg.wasm ]; then
  say "the prover WASM is missing; running tooling/provekit/build-wasm.sh"
  tooling/provekit/build-wasm.sh
fi
[ "0x$(sha256_of "$manifest")" = "$manifest_hash" ] || fail "SHA-256 of $manifest is not the deployment prover_manifest_hash"
while IFS=$'\t' read -r path digest; do
  file="artifacts/batch-open/$path"
  [ -f "$file" ] || fail "$file (pinned by the manifest) is missing"
  [ "$(sha256_of "$file")" = "$digest" ] || fail "$file does not have the digest that the manifest pins. Rebuild with tooling/provekit/build-wasm.sh on the machine that made the manifest, or make a new deployment."
done < <(jq -r '[.pkp, .pkv] + [.wasm[][]] | .[] | [.path, .sha256] | @tsv' "$manifest")
say "prover artifacts match the manifest; the e2e page serves them from artifacts/"

# --- 3. Build -------------------------------------------------------------------------------
target_dir="target/$profile"
sidecar_bin="crates/prover/target/release/anon-credit-prover"
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  say "building the issuer and the gateway ($profile)"
  cargo build ${cargo_profile[@]+"${cargo_profile[@]}"} --bin issuer --bin gateway
  say "building the verifier sidecar (release, ProveKit toolchain)"
  (cd crates/prover && cargo build --release)
fi
for bin in "$target_dir/issuer" "$target_dir/gateway" "$sidecar_bin"; do
  [ -x "$bin" ] || fail "$bin is missing; run without SKIP_BUILD=1"
done

# --- 4. Start ------------------------------------------------------------------------------
run_dir="${RUN_DIR:-data/run/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$run_dir"
run_dir="$(cd "$run_dir" && pwd)"
pids="$run_dir/services.pids"
: >"$pids"
for path in "${ISSUER_DB_PATH:-data/issuer.db}" "${GATEWAY_DATABASE_PATH:-data/gateway.db}"; do
  mkdir -p "$(dirname "$path")"
done
if [ -z "${RUN_DIR:-}" ]; then
  ln -sfn "$run_dir" data/run/latest
fi

started_ok=0
stop_on_failure() {
  if [ "$started_ok" != "1" ] && [ -s "$pids" ]; then
    echo "run-services: stopping the processes that this run started" >&2
    tooling/dev/stop-services.sh "$run_dir" >&2 || true
  fi
}
trap stop_on_failure EXIT

start() {
  local name="$1"
  shift
  nohup "$@" >"$run_dir/$name.log" 2>&1 &
  echo "$name=$!" >>"$pids"
  say "started $name (pid $!), log $run_dir/$name.log"
}

# Wait until the command succeeds. Fail with the log path after the timeout.
wait_ready() {
  local name="$1"
  shift
  local deadline=$((SECONDS + timeout))
  local pid
  pid="$(sed -n "s/^$name=//p" "$pids")"
  until "$@" >/dev/null 2>&1; do
    kill -0 "$pid" 2>/dev/null || fail "$name stopped; see $run_dir/$name.log"
    [ "$SECONDS" -lt "$deadline" ] || fail "$name is not ready after $timeout s; see $run_dir/$name.log"
    sleep 1
  done
  say "$name is ready"
}

sidecar_health() {
  curl -fsS "http://127.0.0.1:$sidecar_port/health" | jq -e --arg h "${verifier_hash#0x}" '.ok == true and .pkv_sha256 == $h and .witness_mode == "zk"'
}
issuer_ready() {
  curl -fsS "$issuer_url/v1/epoch" | jq -e '.epoch != null'
}
gateway_ready() {
  curl -fsS "$gateway_url/v1/config" | jq -e '.deployment_id != null'
}

start sidecar "$sidecar_bin" serve --pkv artifacts/batch-open/batch-open.pkv --pkv-sha256 "${verifier_hash#0x}" --port "$sidecar_port"
wait_ready sidecar sidecar_health
start issuer "$target_dir/issuer"
wait_ready issuer issuer_ready
start gateway "$target_dir/gateway"
wait_ready gateway gateway_ready

# --- 5. Cross-checks -------------------------------------------------------------------------
issuer_deployment="$(curl -fsS "$issuer_url/v1/config" | jq -r .deployment_id)"
gateway_deployment="$(curl -fsS "$gateway_url/v1/config" | jq -r .deployment_id)"
[ "$issuer_deployment" = "$gateway_deployment" ] || fail "issuer deployment_id $issuer_deployment, gateway $gateway_deployment"
issuer_tag="$(curl -fsS "$issuer_url/v1/config" | jq -r .block_tag)"
gateway_tag="$(curl -fsS "$gateway_url/v1/config" | jq -r .block_tag)"
[ "$issuer_tag" = "$BLOCK_TAG" ] && [ "$gateway_tag" = "$BLOCK_TAG" ] || fail "block tag: issuer $issuer_tag, gateway $gateway_tag, expected $BLOCK_TAG"
# The token goes to curl in a header file, not on the command line.
header_file="$(mktemp "$run_dir/.auth.XXXXXX")"
chmod 600 "$header_file"
printf 'Authorization: Bearer %s\n' "$GATEWAY_ADMIN_TOKEN" >"$header_file"
snapshot_ok=0
curl -fsS -H "@$header_file" "$admin_url/admin/v1/snapshot" | jq -e '.status == "ok"' >/dev/null && snapshot_ok=1
rm -f "$header_file"
[ "$snapshot_ok" = "1" ] || fail "the admin snapshot failed at $admin_url"
epoch_line="$(curl -fsS "$issuer_url/v1/epoch" | jq -r '"epoch \(.epoch), \(.epoch_seconds) s"')"
started_ok=1

echo
say "all services are ready ($epoch_line)"
echo "  deployment_id   $gateway_deployment"
echo "  block tag       $BLOCK_TAG$([ "$BLOCK_TAG" = latest ] && echo ' (testnet demo: no finality wait)')"
echo "  issuer          $issuer_url        (publish over HTTPS)"
echo "  gateway public  $gateway_url        (publish over HTTPS)"
echo "  gateway admin   $admin_url        (private; the dashboard reads it)"
echo "  sidecar         http://127.0.0.1:$sidecar_port   (private)"
echo "  logs and pids   $run_dir"
echo "  stop            tooling/dev/stop-services.sh $run_dir"
echo "  dashboard       pnpm dashboard:dev, then sign in with GATEWAY_ADMIN_TOKEN"

#!/usr/bin/env bash
# Test tooling/deploy/deploy-sepolia.sh against a local anvil. It never uses Sepolia.
#
# anvil runs with chain ID 11155111, so the helper runs without a change. All outputs go to a
# temporary directory (DEPLOY_RECORD_PATH, DEPLOY_CONFIG_PATH, FOUNDRY_BROADCAST); the tracked
# files are not touched. The test checks the written record and the deployment TOML against
# the chain and the template.
#
# Usage:
#   tooling/deploy/test-deploy-anvil.sh                  deploy and check the files
#   tooling/deploy/test-deploy-anvil.sh --with-services  also run tooling/dev/run-services.sh
#                                                        against the deployment, check the
#                                                        health endpoints, and stop the services
#
# Needs: ~/.foundry/bin (anvil, forge, cast), jq, openssl, node. --with-services also needs
# cargo, the ProveKit nightly toolchain (sidecar), and the prover WASM.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
with_services=0
[ "${1:-}" = "--with-services" ] && with_services=1

work="$(mktemp -d "${TMPDIR:-/tmp}/anon-credit-deploy-test.XXXXXX")"
anvil_pid=""
cleanup() {
  if [ "$with_services" = "1" ] && [ -f "$work/run/services.pids" ]; then
    "$repo/tooling/dev/stop-services.sh" "$work/run" >/dev/null 2>&1 || true
  fi
  if [ -n "$anvil_pid" ]; then
    kill "$anvil_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

fail() {
  echo "test-deploy-anvil: FAIL: $*" >&2
  echo "test-deploy-anvil: logs in $work" >&2
  exit 1
}
free_port() {
  node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});'
}

# Public anvil test keys (mnemonic "test test ... junk"), indices 0 and 1. Local test ETH only.
deployer_key=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
issuer_key=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
issuer_address=0x70997970c51812dc3a010c7d01b50e0d17dc79c8

port="$(free_port)"
rpc="http://127.0.0.1:$port"
echo "test-deploy-anvil: anvil on $rpc (chain 11155111), work directory $work"
anvil --port "$port" --chain-id 11155111 --block-time 1 --slots-in-an-epoch 1 >"$work/anvil.log" 2>&1 &
anvil_pid=$!
for _ in $(seq 1 60); do
  cast chain-id --rpc-url "$rpc" >/dev/null 2>&1 && break
  sleep 0.5
done
[ "$(cast chain-id --rpc-url "$rpc")" = "11155111" ] || fail "anvil did not start"

record="$work/sepolia.json"
config="$work/deployment.testnet.toml"
SEPOLIA_RPC_URL="$rpc" DEPLOYER_PRIVATE_KEY="$deployer_key" ISSUER_PRIVATE_KEY="$issuer_key" \
  BATCH_PRICE_WEI=100000000000000 EPOCH_SECONDS=30 ETHERSCAN_API_KEY="" \
  DEPLOY_RECORD_PATH="$record" DEPLOY_CONFIG_PATH="$config" FOUNDRY_BROADCAST="$work/broadcast" \
  "$repo/tooling/deploy/deploy-sepolia.sh" >"$work/deploy.log" 2>&1 || fail "deploy-sepolia.sh failed; see $work/deploy.log"

# A second run must refuse to replace the files without DEPLOY_FORCE=1.
if SEPOLIA_RPC_URL="$rpc" ISSUER_PRIVATE_KEY="$issuer_key" DEPLOY_RECORD_PATH="$record" DEPLOY_CONFIG_PATH="$config" \
  FOUNDRY_BROADCAST="$work/broadcast" "$repo/tooling/deploy/deploy-sepolia.sh" >"$work/deploy-again.log" 2>&1; then
  fail "a second run replaced the deployment files without DEPLOY_FORCE=1"
fi
grep -q 'DEPLOY_FORCE=1' "$work/deploy-again.log" || fail "the second run did not name DEPLOY_FORCE"

# The record.
sale="$(jq -r .credit_sale.address "$record")"
registry="$(jq -r .root_registry.address "$record")"
sale_block="$(jq -r .credit_sale.block_number "$record")"
[ "$(jq -r .chain_id "$record")" = "11155111" ] || fail "record chain_id"
[ "$(jq -r .network "$record")" = "sepolia" ] || fail "record network"
[ "$(jq -r .issuer_address "$record")" = "$issuer_address" ] || fail "record issuer_address"
[ "$(jq -r .deployer "$record")" = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266" ] || fail "record deployer"
[ "$(jq -r .batch_price_wei "$record")" = "100000000000000" ] || fail "record batch_price_wei"
[ "$(jq -r .epoch_seconds "$record")" = "30" ] || fail "record epoch_seconds"
[ "$(jq -r .credit_sale.verified "$record")" = "false" ] || fail "record verified"
[[ "$sale" =~ ^0x[0-9a-f]{40}$ && "$registry" =~ ^0x[0-9a-f]{40}$ ]] || fail "record addresses"
[[ "$sale_block" =~ ^[1-9][0-9]*$ ]] || fail "record block number"
[ "$(cast code --rpc-url "$rpc" "$sale")" != "0x" ] || fail "no code at the recorded CreditSale"
[ "$(cast code --rpc-url "$rpc" "$registry")" != "0x" ] || fail "no code at the recorded RootRegistry"
receipt_block="$(cast receipt --rpc-url "$rpc" "$(jq -r .credit_sale.deploy_tx "$record")" blockNumber)"
[ "$receipt_block" = "$sale_block" ] || fail "record block $sale_block, receipt block $receipt_block"
[ "$(cast call --rpc-url "$rpc" "$sale" 'batchPriceWei()(uint256)' | awk '{print $1}')" = "100000000000000" ] || fail "batch price on chain"

# The deployment TOML: the deployed values, a fresh gateway_id, and the template digests.
template="$repo/config/deployment.testnet.template.toml"
value() { sed -nE "s/^$1 = \"?([^\"]*)\"?$/\1/p" "$2"; }
[ "$(value payment_chain_id "$config")" = "11155111" ] || fail "toml payment_chain_id"
[ "$(value sale_address "$config")" = "$sale" ] || fail "toml sale_address"
[ "$(value root_registry_address "$config")" = "$registry" ] || fail "toml root_registry_address"
[ "$(value issuer_address "$config")" = "$issuer_address" ] || fail "toml issuer_address"
[ "$(value epoch_seconds "$config")" = "30" ] || fail "toml epoch_seconds"
gateway_id="$(value gateway_id "$config")"
[[ "$gateway_id" =~ ^0x[0-9a-f]{64}$ ]] || fail "toml gateway_id is not 32 bytes of hex"
[ "$gateway_id" != "0x$(printf '0%.0s' $(seq 1 64))" ] || fail "toml gateway_id is the placeholder"
for key in circuit_id verifier_artifact_hash prover_manifest_hash batch_size credit_lifetime_epochs protocol_version; do
  [ "$(value "$key" "$config")" = "$(value "$key" "$template")" ] || fail "toml $key differs from the template"
done
grep -qE '= "0x0+"$' "$config" && fail "toml still has a placeholder"
grep -q "^ISSUER_START_BLOCK=$sale_block\$" "$work/deploy.log" || fail "the helper did not print ISSUER_START_BLOCK=$sale_block"
echo "test-deploy-anvil: deployment files ok (CreditSale $sale, RootRegistry $registry, block $sale_block)"

if [ "$with_services" = "1" ]; then
  env_file="$work/services.env"
  cat >"$env_file" <<ENV
DEPLOYMENT_CONFIG=$config
EPOCH_SECONDS=30
RUST_LOG=info
ISSUER_BIND=127.0.0.1:$(free_port)
ISSUER_DB_PATH=$work/issuer.db
SEPOLIA_RPC_URL=$rpc
ISSUER_PRIVATE_KEY=$issuer_key
ISSUER_START_BLOCK=$sale_block
ISSUER_INDEX_POLL_SECONDS=1
ISSUER_PUBLISH_POLL_SECONDS=1
GATEWAY_PUBLIC_BIND=127.0.0.1:$(free_port)
GATEWAY_ADMIN_BIND=127.0.0.1:$(free_port)
GATEWAY_DATABASE_PATH=$work/gateway.db
GATEWAY_UPSTREAM_RPC_URL=$rpc
GATEWAY_ROOT_POLL_SECONDS=1
GATEWAY_ADMIN_TOKEN=$(openssl rand -hex 24)
DEMO_IP_LOGGING=true
GATEWAY_TRUSTED_PROXY_ADDRS=127.0.0.1
GATEWAY_VERIFIER_URL=http://127.0.0.1:$(free_port)
ENV
  RUN_DIR="$work/run" SERVICES_PROFILE="${SERVICES_PROFILE:-debug}" \
    "$repo/tooling/dev/run-services.sh" "$env_file" || fail "run-services.sh failed; see $work/run"
  # The admin snapshot has the deployment values of phase 6.
  admin_bind="$(sed -n 's/^GATEWAY_ADMIN_BIND=//p' "$env_file")"
  token="$(sed -n 's/^GATEWAY_ADMIN_TOKEN=//p' "$env_file")"
  printf 'Authorization: Bearer %s\n' "$token" >"$work/auth-header"
  curl -fsS -H "@$work/auth-header" "http://$admin_bind/admin/v1/snapshot" >"$work/snapshot.json" || fail "admin snapshot"
  jq -e --arg gid "$gateway_id" --arg vh "$(value verifier_artifact_hash "$config")" '
    .gateway_id == $gid and .epoch_seconds == 30 and .verifier_artifact_hash == $vh
    and .demo_ip_logging == true and (.price_table_hash | test("^0x[0-9a-f]{64}$"))
    and (.price_table.units | has("eth_chainId")) and (.accepted_roots | type == "array")
    and .root_window_epochs == 96' "$work/snapshot.json" >/dev/null || fail "admin snapshot fields; see $work/snapshot.json"
  # The launcher sets the testnet demo block tag when the env file has none.
  gateway_bind="$(sed -n 's/^GATEWAY_PUBLIC_BIND=//p' "$env_file")"
  [ "$(curl -fsS "http://$gateway_bind/v1/config" | jq -r .block_tag)" = "latest" ] || fail "the launcher did not set BLOCK_TAG=latest"
  "$repo/tooling/dev/stop-services.sh" "$work/run" || fail "stop-services.sh failed"
  while read -r line; do
    pid="${line#*=}"
    kill -0 "$pid" 2>/dev/null && fail "process ${line%%=*} ($pid) still runs after stop-services.sh"
  done <"$work/run/services.pids"
  echo "test-deploy-anvil: services started, passed the health checks, and stopped"
fi
trap - EXIT
cleanup
rm -rf "$work"
echo "test-deploy-anvil: pass"

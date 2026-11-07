#!/usr/bin/env bash
# Deploy CreditSale and RootRegistry to Sepolia and write the deployment files.
#
# Steps:
#   1. Check the tools, the settings, and the chain ID of the RPC (11155111).
#   2. Run `forge script script/Deploy.s.sol:Deploy --broadcast`.
#   3. Read the two contract addresses, the transaction hashes, and the blocks from the
#      broadcast JSON (run-latest.json).
#   4. Write contracts/deployments/sepolia.json (the deployment record).
#   5. Write config/deployment.testnet.toml from config/deployment.testnet.template.toml: the
#      addresses, the issuer address, chain ID 11155111, the epoch length, and a new random
#      gateway_id (`openssl rand -hex 32`). The circuit, verifier, and prover manifest digests
#      come from the template without change.
#   6. Print ISSUER_START_BLOCK (the CreditSale deployment block).
#   7. If ETHERSCAN_API_KEY is set, run `forge verify-contract` for both contracts.
#
# Settings (environment). Secrets are never printed.
#   SEPOLIA_RPC_URL        required. Secret if it has an API key.
#   ISSUER_PRIVATE_KEY     the root publisher key. Secret. The deployer key if
#                          DEPLOYER_PRIVATE_KEY is not set.
#   DEPLOYER_PRIVATE_KEY   optional. Secret. The key that sends the two deploy transactions.
#   ISSUER_ADDRESS         optional. Default: the address of ISSUER_PRIVATE_KEY.
#   BATCH_PRICE_WEI        default 100000000000000.
#   EPOCH_SECONDS          default 30 (testnet). Production: 900.
#   ETHERSCAN_API_KEY      optional. Secret. Turns on the verification step.
#   EXPECTED_CHAIN_ID      default 11155111. The script refuses another chain.
#   GAS_ESTIMATE_MULTIPLIER
#                          default 800. Percent of the local gas estimate that forge sets as the
#                          transaction gas limit. Sepolia (reth 2.10, 2026-11) charges about 6.6 times
#                          the local EVM estimate for contract creation. 130 and 250 ran out of gas.
#   DEPLOY_RECORD_PATH     default contracts/deployments/sepolia.json.
#   DEPLOY_CONFIG_PATH     default config/deployment.testnet.toml.
#   DEPLOY_FORCE           1: replace existing output files. A new file means a new gateway_id
#                          and thus a new deployment_id.
#   FOUNDRY_BROADCAST      optional. Directory of the forge broadcast files (default
#                          contracts/broadcast). The anvil test sets a temporary directory.
#
# Needs: forge and cast (~/.foundry/bin), jq, openssl, git.
# Test: tooling/deploy/test-deploy-anvil.sh deploys to a local anvil with chain ID 11155111.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"

fail() {
  echo "deploy-sepolia: FAIL: $*" >&2
  exit 1
}
say() {
  echo "deploy-sepolia: $*"
}

for tool in forge cast jq openssl git; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is not installed or not on PATH"
done

: "${SEPOLIA_RPC_URL:?SEPOLIA_RPC_URL is required}"
issuer_key="${ISSUER_PRIVATE_KEY:-}"
deployer_key="${DEPLOYER_PRIVATE_KEY:-$issuer_key}"
[ -n "$deployer_key" ] || fail "set ISSUER_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY"
batch_price_wei="${BATCH_PRICE_WEI:-100000000000000}"
epoch_seconds="${EPOCH_SECONDS:-30}"
expected_chain="${EXPECTED_CHAIN_ID:-11155111}"
gas_multiplier="${GAS_ESTIMATE_MULTIPLIER:-800}"
record_path="${DEPLOY_RECORD_PATH:-$repo/contracts/deployments/sepolia.json}"
config_path="${DEPLOY_CONFIG_PATH:-$repo/config/deployment.testnet.toml}"
template="$repo/config/deployment.testnet.template.toml"
broadcast_dir="${FOUNDRY_BROADCAST:-$repo/contracts/broadcast}"

[[ "$batch_price_wei" =~ ^[1-9][0-9]*$ ]] || fail "BATCH_PRICE_WEI must be a positive integer"
[[ "$epoch_seconds" =~ ^[1-9][0-9]*$ ]] || fail "EPOCH_SECONDS must be a positive integer"
[[ "$gas_multiplier" =~ ^[1-9][0-9]*$ ]] || fail "GAS_ESTIMATE_MULTIPLIER must be a positive integer"

# The issuer address: lowercase hex. It must be the address of ISSUER_PRIVATE_KEY if both are set.
issuer_address="${ISSUER_ADDRESS:-}"
if [ -n "$issuer_key" ]; then
  derived="$(cast wallet address --private-key "$issuer_key" | tr 'A-F' 'a-f')"
  if [ -n "$issuer_address" ] && [ "$(echo "$issuer_address" | tr 'A-F' 'a-f')" != "$derived" ]; then
    fail "ISSUER_ADDRESS is not the address of ISSUER_PRIVATE_KEY"
  fi
  issuer_address="$derived"
fi
[ -n "$issuer_address" ] || fail "set ISSUER_ADDRESS or ISSUER_PRIVATE_KEY"
issuer_address="$(echo "$issuer_address" | tr 'A-F' 'a-f')"
[[ "$issuer_address" =~ ^0x[0-9a-f]{40}$ ]] || fail "ISSUER_ADDRESS is not a 20-byte hex address"

chain_id="$(cast chain-id --rpc-url "$SEPOLIA_RPC_URL")" || fail "the RPC did not answer eth_chainId"
[ "$chain_id" = "$expected_chain" ] || fail "the RPC chain ID is $chain_id, expected $expected_chain"

for out in "$record_path" "$config_path"; do
  if [ -e "$out" ] && [ "${DEPLOY_FORCE:-0}" != "1" ]; then
    fail "$out exists. Set DEPLOY_FORCE=1 to replace it (this makes a new deployment)."
  fi
done
[ -f "$template" ] || fail "$template is missing"

say "chain $chain_id, issuer $issuer_address, batch price $batch_price_wei wei, epoch $epoch_seconds s"
say "running forge script (broadcast)"
(
  cd "$repo/contracts"
  ISSUER_ADDRESS="$issuer_address" BATCH_PRICE_WEI="$batch_price_wei" EPOCH_SECONDS="$epoch_seconds" \
    FOUNDRY_BROADCAST="$broadcast_dir" \
    forge script script/Deploy.s.sol:Deploy --rpc-url "$SEPOLIA_RPC_URL" --broadcast --private-key "$deployer_key" \
      --gas-estimate-multiplier "$gas_multiplier"
)

run_json="$broadcast_dir/Deploy.s.sol/$chain_id/run-latest.json"
[ -f "$run_json" ] || fail "no broadcast file at $run_json"

# Values of one contract from the broadcast JSON: address, transaction hash, block (decimal),
# receipt status. The address is lowercase.
contract_field() {
  local name="$1" field="$2"
  jq -r --arg name "$name" --arg field "$field" '
    (.transactions | map(select(.transactionType == "CREATE" and .contractName == $name)) | last) as $tx
    | if $tx == null then error("no CREATE transaction of \($name)") else . end
    | (.receipts | map(select(.transactionHash == $tx.hash)) | last) as $rc
    | if $rc == null then error("no receipt of \($name)") else . end
    | {
        address: ($tx.contractAddress | ascii_downcase),
        hash: ($tx.hash | ascii_downcase),
        from: ($tx.transaction.from | ascii_downcase),
        block: $rc.blockNumber,
        status: $rc.status
      }[$field]' "$run_json"
}

hex_to_dec() {
  local value="$1"
  case "$value" in
    0x*) echo $((value)) ;;
    *) echo "$value" ;;
  esac
}

sale_address="$(contract_field CreditSale address)"
sale_tx="$(contract_field CreditSale hash)"
sale_block="$(hex_to_dec "$(contract_field CreditSale block)")"
sale_status="$(contract_field CreditSale status)"
registry_address="$(contract_field RootRegistry address)"
registry_tx="$(contract_field RootRegistry hash)"
registry_block="$(hex_to_dec "$(contract_field RootRegistry block)")"
registry_status="$(contract_field RootRegistry status)"
deployer_address="$(contract_field CreditSale from)"

for status in "$sale_status" "$registry_status"; do
  case "$status" in
    0x1 | 1) ;;
    *) fail "a deploy transaction did not succeed (status $status)" ;;
  esac
done
for address in "$sale_address" "$registry_address"; do
  [[ "$address" =~ ^0x[0-9a-f]{40}$ ]] || fail "bad contract address in the broadcast file: $address"
  code="$(cast code --rpc-url "$SEPOLIA_RPC_URL" "$address")"
  [ "$code" != "0x" ] || fail "no contract code at $address"
done

# Check the contract values on chain against the settings.
onchain_issuer="$(cast call --rpc-url "$SEPOLIA_RPC_URL" "$sale_address" 'issuer()(address)' | tr 'A-F' 'a-f')"
onchain_registry_issuer="$(cast call --rpc-url "$SEPOLIA_RPC_URL" "$registry_address" 'issuer()(address)' | tr 'A-F' 'a-f')"
onchain_epoch="$(cast call --rpc-url "$SEPOLIA_RPC_URL" "$registry_address" 'epochSeconds()(uint64)')"
[ "$onchain_issuer" = "$issuer_address" ] || fail "CreditSale.issuer() is $onchain_issuer"
[ "$onchain_registry_issuer" = "$issuer_address" ] || fail "RootRegistry.issuer() is $onchain_registry_issuer"
[ "$onchain_epoch" = "$epoch_seconds" ] || fail "RootRegistry.epochSeconds() is $onchain_epoch"

verified=false
if [ -n "${ETHERSCAN_API_KEY:-}" ]; then
  say "verifying both contracts on Etherscan"
  (
    cd "$repo/contracts"
    forge verify-contract --chain-id "$chain_id" --watch --etherscan-api-key "$ETHERSCAN_API_KEY" \
      --constructor-args "$(cast abi-encode 'constructor(address,uint256)' "$issuer_address" "$batch_price_wei")" \
      "$sale_address" src/CreditSale.sol:CreditSale
    forge verify-contract --chain-id "$chain_id" --watch --etherscan-api-key "$ETHERSCAN_API_KEY" \
      --constructor-args "$(cast abi-encode 'constructor(address,uint64)' "$issuer_address" "$epoch_seconds")" \
      "$registry_address" src/RootRegistry.sol:RootRegistry
  )
  verified=true
else
  say "ETHERSCAN_API_KEY is not set: no verification (see contracts/README.md to verify later)"
fi

network=sepolia
[ "$chain_id" = "11155111" ] || network="chain-$chain_id"
git_commit="$(git -C "$repo" rev-parse HEAD 2>/dev/null || echo 0000000000000000000000000000000000000000)"
mkdir -p "$(dirname "$record_path")" "$(dirname "$config_path")"
jq -n \
  --arg network "$network" \
  --argjson chain_id "$chain_id" \
  --arg deployed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg git_commit "$git_commit" \
  --arg deployer "$deployer_address" \
  --arg issuer "$issuer_address" \
  --arg price "$batch_price_wei" \
  --argjson epoch "$epoch_seconds" \
  --arg sale "$sale_address" --arg sale_tx "$sale_tx" --argjson sale_block "$sale_block" \
  --arg registry "$registry_address" --arg registry_tx "$registry_tx" --argjson registry_block "$registry_block" \
  --argjson verified "$verified" \
  '{
    network: $network,
    chain_id: $chain_id,
    deployed_at: $deployed_at,
    git_commit: $git_commit,
    deployer: $deployer,
    issuer_address: $issuer,
    batch_price_wei: $price,
    epoch_seconds: $epoch,
    credit_sale: {address: $sale, deploy_tx: $sale_tx, block_number: $sale_block, verified: $verified},
    root_registry: {address: $registry, deploy_tx: $registry_tx, block_number: $registry_block, verified: $verified}
  }' >"$record_path"
say "wrote $record_path"

# The deployment TOML. Replace only the deployment-specific lines of the template.
gateway_id="0x$(openssl rand -hex 32)"
tmp_config="$(mktemp "${config_path}.XXXXXX")"
{
  echo "# Written by tooling/deploy/deploy-sepolia.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ) from"
  echo "# config/deployment.testnet.template.toml. Chain $chain_id, CreditSale block $sale_block."
  echo "# The services and the client compute deployment_id from these values. Do not edit them"
  echo "# after the services start: a change gives a new deployment."
  echo
  # Skip the leading comment block of the template (its copy instructions), keep the rest.
  awk 'started || !/^(#|$)/ { started = 1 } started' "$template" | sed -E \
    -e "s/^payment_chain_id = .*/payment_chain_id = $chain_id/" \
    -e "s/^sale_address = .*/sale_address = \"$sale_address\"/" \
    -e "s/^root_registry_address = .*/root_registry_address = \"$registry_address\"/" \
    -e "s/^issuer_address = .*/issuer_address = \"$issuer_address\"/" \
    -e "s/^gateway_id = .*/gateway_id = \"$gateway_id\"/" \
    -e "s/^epoch_seconds = .*/epoch_seconds = $epoch_seconds/"
} >"$tmp_config"
if grep -nE '= "0x0+"$' "$tmp_config"; then
  rm -f "$tmp_config"
  fail "the written deployment file still has a placeholder"
fi
mv "$tmp_config" "$config_path"
say "wrote $config_path (new gateway_id)"

echo
echo "CreditSale      $sale_address (block $sale_block, tx $sale_tx)"
echo "RootRegistry    $registry_address (block $registry_block, tx $registry_tx)"
echo "issuer_address  $issuer_address"
echo
echo "Put these lines in config/testnet-demo.env:"
echo "DEPLOYMENT_CONFIG=${config_path#"$repo/"}"
echo "ISSUER_START_BLOCK=$sale_block"

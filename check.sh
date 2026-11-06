#!/usr/bin/env bash
# Run all repository checks. Stop at the first failure.
#
# Required: Rust format, Clippy, Rust tests, TypeScript type checks, TypeScript tests,
# and a scan of tracked configuration for secrets.
# Optional: Foundry and ProveKit checks. They run if forge and the ProveKit toolchain are found.
# Noir: the circuits need nargo 1.0.0-beta.26 (tooling/provekit/pins.env). If it is missing,
# the circuit step fails and tells how to install it.
# Set SKIP_OPTIONAL=1 to skip the Foundry, Noir, and ProveKit steps.
set -euo pipefail

cd "$(dirname "$0")"

step() {
  printf '\n==> %s\n' "$*"
}

find_tool() {
  # Use the tool on PATH, else the default install location.
  local name="$1" fallback="$2"
  if command -v "$name" >/dev/null 2>&1; then
    command -v "$name"
  elif [ -x "$fallback" ]; then
    echo "$fallback"
  fi
}

step "cargo fmt --check"
cargo fmt --all -- --check

step "cargo clippy -D warnings"
cargo clippy --workspace --all-targets -- -D warnings

step "cargo test"
cargo test --workspace

step "pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile

step "pnpm -r typecheck"
pnpm -r typecheck

step "pnpm -r test"
pnpm -r test

step "secret scan of tracked configuration"
config_files=$(git ls-files config contracts/foundry.toml)
# A secret variable in an env template must have an empty value.
if grep -nE '^[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE)=.+' $config_files; then
  echo "FAIL: a secret variable has a value in tracked configuration"
  exit 1
fi
# A private RPC URL must not be in tracked configuration. Public bootstrap RPCs are allowed.
if grep -nE '^(SEPOLIA_RPC_URL|GATEWAY_UPSTREAM_RPC_URL|GATEWAY_ROOT_RPC_URL)=.+' $config_files; then
  echo "FAIL: a private RPC URL has a value in tracked configuration"
  exit 1
fi
# A 32-byte hex value that is not all zero can be a private key.
if grep -noE '0x[0-9a-fA-F]{64}' $config_files | grep -vE ':0x0{64}$'; then
  echo "FAIL: a non-placeholder 32-byte hex value is in tracked configuration"
  exit 1
fi
echo "no secrets found in: $(echo $config_files | tr '\n' ' ')"

if [ "${SKIP_OPTIONAL:-0}" = "1" ]; then
  step "optional Foundry and Noir checks skipped (SKIP_OPTIONAL=1)"
  exit 0
fi

forge_bin=$(find_tool forge "$HOME/.foundry/bin/forge")
if [ -n "$forge_bin" ]; then
  step "forge test (in-process EVM)"
  (cd contracts && "$forge_bin" test)
else
  step "forge not found; skip contract checks"
fi

# Noir. All circuits use the Noir version that ProveKit links (pins.env: NOIR_VERSION, NARGO).
# shellcheck source=tooling/provekit/pins.env
source tooling/provekit/pins.env
step "nargo $NOIR_VERSION test (batch-open, provekit-sample)"
if [ ! -x "$NARGO" ] || ! "$NARGO" --version | grep -q "nargo version = $NOIR_VERSION"; then
  echo "FAIL: nargo $NOIR_VERSION not found at $NARGO"
  echo "Install it with tooling/provekit/install.sh, or set NARGO to its path."
  exit 1
fi
(cd circuits/batch-open && "$NARGO" test)
(cd circuits/provekit-sample && "$NARGO" test)

# ProveKit. crates/prover is a separate workspace on the nightly toolchain that ProveKit pins.
# It runs only if that toolchain is installed (tooling/provekit/install.sh).
# PROVEKIT_GATE=1 also runs the Chromium browser gates (sample and batch-open circuits).
if rustup toolchain list 2>/dev/null | grep -q "^$PROVEKIT_RUST_TOOLCHAIN"; then
  step "crates/prover fmt, clippy, test ($PROVEKIT_RUST_TOOLCHAIN)"
  (cd crates/prover && cargo fmt -- --check && cargo clippy --all-targets -- -D warnings && cargo test)
else
  step "$PROVEKIT_RUST_TOOLCHAIN not installed; skip crates/prover"
fi
if [ "${PROVEKIT_GATE:-0}" = "1" ]; then
  step "ProveKit browser gate (Chromium proves, Rust verifies)"
  node packages/prover/dev/gate.ts
fi

printf '\nAll checks passed.\n'

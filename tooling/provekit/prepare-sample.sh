#!/usr/bin/env bash
# Compile the sample circuit, make its ProveKit keys, prove natively, and verify natively.
#
# Output in artifacts/provekit-sample/: sample.pkp, sample.pkv, proof.np, proof.native.json,
# and sample-standard.pkv (a non-hiding key for negative tests only).
# The keys are deterministic: the same pins give the same digests.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
# shellcheck source=pins.env
source "$here/pins.env"

# Run a command. Hide its output, but print the output if the command fails.
quiet() {
  local log
  log=$(mktemp)
  if ! "$@" >"$log" 2>&1; then
    cat "$log" >&2
    rm -f "$log"
    return 1
  fi
  rm -f "$log"
}

circuit="$repo/circuits/provekit-sample"
out="$repo/artifacts/provekit-sample"
mkdir -p "$out"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

(cd "$circuit" && "$NARGO" test)
quiet "$PROVEKIT_CLI" prepare "$circuit" --force --hash "$PROVEKIT_HASH" \
  --witness-mode "$PROVEKIT_WITNESS_MODE" --pkp "$out/sample.pkp" --pkv "$out/sample.pkv"
quiet "$PROVEKIT_CLI" prove --prover "$out/sample.pkp" --input "$circuit/Prover.toml" \
  --out "$out/proof.np"
quiet "$PROVEKIT_CLI" verify --verifier "$out/sample.pkv" --proof "$out/proof.np"
# The same proof statement in the JSON encoding. The browser WASM prover writes this encoding.
quiet "$PROVEKIT_CLI" prove --prover "$out/sample.pkp" --input "$circuit/Prover.toml" \
  --out "$out/proof.native.json"
# A non-hiding verifier key. Tests use it to check that the adapter rejects it.
quiet "$PROVEKIT_CLI" prepare "$circuit" --force --hash "$PROVEKIT_HASH" \
  --witness-mode standard --pkp "$tmp/standard.pkp" --pkv "$out/sample-standard.pkv"
echo "native verify: ok"
"$PROVEKIT_CLI" show-inputs --hex "$out/sample.pkv" "$out/proof.np" 2>/dev/null | tail -4
shasum -a 256 "$out/sample.pkp" "$out/sample.pkv" "$out/sample-standard.pkv"

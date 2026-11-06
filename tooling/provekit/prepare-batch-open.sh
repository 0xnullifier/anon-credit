#!/usr/bin/env bash
# Compile the batch-open circuit, make its ProveKit keys, prove the gate witness natively, and
# verify the proof natively.
#
# Input: circuits/batch-open/Prover.toml. `cargo run -p anon-credit-registry --example
# generate_fixtures` writes it (tree of 100 leaves, leaf 37).
# Output in artifacts/batch-open/: batch-open.pkp, batch-open.pkv, proof.np, proof.native.json,
# batch-open-standard.pkv (a non-hiding key for negative tests only), nargo-info.txt, abi.json
# (the Noir ABI; packages/prover tests check it), and prepare.json (sizes, digests, R1CS size,
# and native timings).
# The keys are deterministic: the same pins and the same circuit give the same digests.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
# shellcheck source=pins.env
source "$here/pins.env"

# Run a command. Write its output to a log. Print the log if the command fails.
logged() {
  local log="$1"
  shift
  if ! "$@" >"$log" 2>&1; then
    cat "$log" >&2
    return 1
  fi
}

# Wall time in milliseconds and peak resident memory in bytes of one command (macOS or Linux).
measure() {
  local name="$1"
  shift
  local log="$tmp/$name.log" time_log="$tmp/$name.time"
  case "$(uname -s)" in
    Darwin) /usr/bin/time -l -o "$time_log" "$@" >"$log" 2>&1 || { cat "$log" >&2; return 1; } ;;
    *) /usr/bin/time -v -o "$time_log" "$@" >"$log" 2>&1 || { cat "$log" >&2; return 1; } ;;
  esac
}

# Read the measured values of `measure` as "<ms> <bytes>".
measured() {
  local time_log="$tmp/$1.time"
  case "$(uname -s)" in
    Darwin)
      awk '/ real /{ms=$1*1000} /maximum resident set size/{rss=$1} END{printf "%d %d", ms, rss}' "$time_log"
      ;;
    *)
      awk -F': ' '/Elapsed \(wall clock\)/{n=split($2,t,":"); ms=(n==3?(t[1]*3600+t[2]*60+t[3]):(t[1]*60+t[2]))*1000}
        /Maximum resident set size/{rss=$2*1024} END{printf "%d %d", ms, rss}' "$time_log"
      ;;
  esac
}

if [ ! -x "$NARGO" ]; then
  echo "nargo $NOIR_VERSION not found at $NARGO. Run tooling/provekit/install.sh." >&2
  exit 1
fi
if [ ! -x "$PROVEKIT_CLI" ]; then
  echo "provekit-cli not found at $PROVEKIT_CLI. Run tooling/provekit/install.sh." >&2
  exit 1
fi

circuit="$repo/circuits/batch-open"
out="$repo/artifacts/batch-open"
mkdir -p "$out"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

(cd "$circuit" && "$NARGO" test >/dev/null && "$NARGO" execute >/dev/null)
(cd "$circuit" && "$NARGO" info) >"$out/nargo-info.txt"
node -e 'const fs = require("node:fs");
  const program = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  fs.writeFileSync(process.argv[2], JSON.stringify(program.abi, null, 2) + "\n");' \
  "$circuit/target/batch_open.json" "$out/abi.json"

measure prepare "$PROVEKIT_CLI" prepare "$circuit" --force --hash "$PROVEKIT_HASH" \
  --witness-mode "$PROVEKIT_WITNESS_MODE" --pkp "$out/batch-open.pkp" --pkv "$out/batch-open.pkv"
measure prove "$PROVEKIT_CLI" prove --prover "$out/batch-open.pkp" --input "$circuit/Prover.toml" \
  --out "$out/proof.np"
measure verify "$PROVEKIT_CLI" verify --verifier "$out/batch-open.pkv" --proof "$out/proof.np"
# The same statement in the JSON encoding. The browser WASM prover writes this encoding.
logged "$tmp/prove-json.log" "$PROVEKIT_CLI" prove --prover "$out/batch-open.pkp" \
  --input "$circuit/Prover.toml" --out "$out/proof.native.json"
logged "$tmp/verify-json.log" "$PROVEKIT_CLI" verify --verifier "$out/batch-open.pkv" \
  --proof "$out/proof.native.json"
# A non-hiding verifier key. Tests use it to check that the adapter rejects it.
logged "$tmp/standard.log" "$PROVEKIT_CLI" prepare "$circuit" --force --hash "$PROVEKIT_HASH" \
  --witness-mode standard --pkp "$tmp/standard.pkp" --pkv "$out/batch-open-standard.pkv"
echo "native verify: ok"

# The R1CS size after the ProveKit optimizations ("After GE optimization: <c> constraints,
# <w> witnesses"), and the witness split.
summary=$(sed 's/\x1b\[[0-9;]*m//g' "$tmp/prepare.log" | grep -E 'After GE optimization' | tail -1)
constraints=$(echo "$summary" | sed -E 's/.*: ([0-9]+) constraints.*/\1/')
witnesses=$(echo "$summary" | sed -E 's/.* ([0-9]+) witnesses.*/\1/')
acir=$(awk -F'|' '/ main /{gsub(/ /,"",$4); print $4}' "$out/nargo-info.txt")
read -r prepare_ms prepare_rss <<<"$(measured prepare)"
read -r prove_ms prove_rss <<<"$(measured prove)"
read -r verify_ms verify_rss <<<"$(measured verify)"

size() { wc -c <"$1" | tr -d ' '; }
digest() { shasum -a 256 "$1" | cut -d' ' -f1; }
cat >"$out/prepare.json" <<JSON
{
  "circuit": "circuits/batch-open",
  "noir": "$NOIR_VERSION",
  "provekitRev": "$PROVEKIT_REV",
  "hash": "$PROVEKIT_HASH",
  "witnessMode": "$PROVEKIT_WITNESS_MODE",
  "acirOpcodes": $acir,
  "r1csConstraints": $constraints,
  "r1csWitnesses": $witnesses,
  "pkp": { "bytes": $(size "$out/batch-open.pkp"), "sha256": "$(digest "$out/batch-open.pkp")" },
  "pkv": { "bytes": $(size "$out/batch-open.pkv"), "sha256": "$(digest "$out/batch-open.pkv")" },
  "nativeProof": { "binaryBytes": $(size "$out/proof.np"), "jsonBytes": $(size "$out/proof.native.json") },
  "nativeCli": {
    "note": "one run of provekit-cli on this machine; wall time includes process start and key loading",
    "prepare": { "wallMs": $prepare_ms, "maxRssBytes": $prepare_rss },
    "prove": { "wallMs": $prove_ms, "maxRssBytes": $prove_rss },
    "verify": { "wallMs": $verify_ms, "maxRssBytes": $verify_rss }
  }
}
JSON
cat "$out/prepare.json"
"$PROVEKIT_CLI" show-inputs --hex "$out/batch-open.pkv" "$out/proof.np" 2>/dev/null | tail -14

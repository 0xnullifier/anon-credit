#!/usr/bin/env bash
# Build the ProveKit browser WASM (scalar and threaded) from the pinned commit.
#
# The pinned commit has no single-threaded feature in tooling/provekit-wasm. The patch in
# patches/ adds an optional `threads` feature, the same as the published SDK branch
# (commit 11bfde0c). The scalar build turns it off and has no atomics, shared memory,
# or SIMD, so it does not need cross-origin isolation.
#
# Output: artifacts/provekit-wasm/{scalar,threaded}/ (git ignores it).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
# shellcheck source=pins.env
source "$here/pins.env"

if [ ! -d "$PROVEKIT_SRC/.git" ]; then
  echo "FAIL: $PROVEKIT_SRC is not a ProveKit clone. Run tooling/provekit/install.sh." >&2
  exit 1
fi
if [ ! -d "$PROVEKIT_WASM_SRC" ]; then
  git -C "$PROVEKIT_SRC" worktree add --detach "$PROVEKIT_WASM_SRC" "$PROVEKIT_REV"
fi
git -C "$PROVEKIT_WASM_SRC" checkout --quiet --force --detach "$PROVEKIT_REV"
git -C "$PROVEKIT_WASM_SRC" apply "$here"/patches/*.patch

out="$repo/artifacts/provekit-wasm"
rm -rf "$out"

build_variant() {
  local variant="$1" target="$PROVEKIT_WASM_SRC/target/wasm-$1"
  local -a features=()
  case "$variant" in
    scalar)
      features=(--no-default-features)
      export RUSTFLAGS=""
      export CARGO_ENCODED_RUSTFLAGS=$'-Ctarget-cpu=mvp\x1f-Ctarget-feature=-simd128,-relaxed-simd'
      ;;
    threaded)
      # The threaded flags come from .cargo/config.toml in the ProveKit tree.
      unset RUSTFLAGS CARGO_ENCODED_RUSTFLAGS
      ;;
  esac
  (cd "$PROVEKIT_WASM_SRC" && cargo build --release --locked --target wasm32-unknown-unknown \
    -p provekit-wasm ${features[@]+"${features[@]}"} --target-dir "$target" -Z build-std=panic_abort,std)
  wasm-bindgen --target web --out-dir "$out/$variant" \
    "$target/wasm32-unknown-unknown/release/provekit_wasm.wasm"
}

build_variant scalar
build_variant threaded
unset RUSTFLAGS CARGO_ENCODED_RUSTFLAGS

# Leave the ProveKit tree clean.
git -C "$PROVEKIT_WASM_SRC" checkout --quiet --force --detach "$PROVEKIT_REV"
find "$out" -type f -name '*.wasm' -exec ls -l {} \;

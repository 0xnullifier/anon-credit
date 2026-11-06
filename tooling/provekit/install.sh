#!/usr/bin/env bash
# Install the pinned ProveKit CLI and Noir nargo outside this repository.
#
# - Clones ProveKit into $PROVEKIT_SRC at $PROVEKIT_REV and builds provekit-cli.
# - Downloads nargo $NOIR_VERSION into $NOIR_HOME and checks its SHA-256 digest.
#   It does not replace the nargo from noirup in ~/.nargo/bin.
# - Installs wasm-bindgen-cli $WASM_BINDGEN_VERSION (cargo binstall if present, else cargo install).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=pins.env
source "$here/pins.env"

if [ ! -d "$PROVEKIT_SRC/.git" ]; then
  git clone "$PROVEKIT_REPO" "$PROVEKIT_SRC"
fi
git -C "$PROVEKIT_SRC" fetch --quiet origin
git -C "$PROVEKIT_SRC" checkout --quiet --detach "$PROVEKIT_REV"
(cd "$PROVEKIT_SRC" && cargo build --release --locked --bin provekit-cli)
echo "provekit-cli: $PROVEKIT_CLI"

if [ ! -x "$NARGO" ] || ! "$NARGO" --version | grep -q "nargo version = $NOIR_VERSION"; then
  mkdir -p "$NOIR_HOME/bin"
  archive="$NOIR_HOME/nargo.tar.gz"
  curl -sSfL -o "$archive" "$NOIR_NARGO_URL"
  actual=$(shasum -a 256 "$archive" | cut -d' ' -f1)
  if [ "$actual" != "$NOIR_NARGO_SHA256" ]; then
    echo "FAIL: nargo archive digest $actual is not $NOIR_NARGO_SHA256" >&2
    exit 1
  fi
  tar xzf "$archive" -C "$NOIR_HOME/bin"
fi
"$NARGO" --version

if ! wasm-bindgen --version 2>/dev/null | grep -q "$WASM_BINDGEN_VERSION"; then
  if command -v cargo-binstall >/dev/null 2>&1; then
    cargo binstall -y "wasm-bindgen-cli@$WASM_BINDGEN_VERSION"
  else
    cargo install wasm-bindgen-cli --version "$WASM_BINDGEN_VERSION" --locked
  fi
fi
wasm-bindgen --version

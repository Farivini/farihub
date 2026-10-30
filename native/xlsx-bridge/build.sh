#!/usr/bin/env bash
# Rebuilds vendor/xlsx-bridge from native/xlsx-bridge. Paths are remapped so the
# output does not depend on the machine; CI rebuilds and compares byte for byte.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$(cd "$here/../.." && pwd)/vendor/xlsx-bridge"
# From here rustup uses rust-toolchain.toml (pinned Rust and the wasm32 target).
cd "$here"
registry="${CARGO_HOME:-$HOME/.cargo}/registry/src"
# The CLI must match the wasm-bindgen crate in Cargo.lock.
want="$(grep -A1 '^name = "wasm-bindgen"$' "$here/Cargo.lock" | sed -n 's/^version = "\(.*\)"/\1/p')"
have="$(wasm-bindgen --version | cut -d' ' -f2)"
if [ "$want" != "$have" ]; then
  echo "wasm-bindgen $have installed, $want required: cargo install wasm-bindgen-cli --version $want --locked" >&2
  exit 1
fi
export RUSTFLAGS="--remap-path-prefix=$registry=/cargo --remap-path-prefix=$here=/bridge --remap-path-prefix=$(rustc --print sysroot)=/rust"
cargo build --manifest-path "$here/Cargo.toml" --release --locked --target wasm32-unknown-unknown
rm -rf "$out"
wasm-bindgen --target web --out-dir "$out" --out-name xlsx_bridge "$here/target/wasm32-unknown-unknown/release/farcel_xlsx_bridge.wasm"
cp "$here/LICENSES.md" "$out/LICENSES.md"
(cd "$out" && sha256sum xlsx_bridge_bg.wasm xlsx_bridge.js > SHA256SUMS)

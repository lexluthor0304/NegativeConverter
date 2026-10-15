#!/usr/bin/env bash
# Builds the PNG16 deflate modules (#301) from wasm/png-deflate: a scalar
# module and a WASM SIMD one, written to negative2positive/src/workers/ with
# png-deflate-build-info.txt next to them. The modules are committed (the web
# build and CI need no Rust); after changing the crate, its Cargo.lock or the
# toolchain pin, run this and commit the three files together.
#
#   bash scripts/build-png-deflate-wasm.sh
#
# Needs rustup: the toolchain and the wasm32 target come from
# wasm/png-deflate/rust-toolchain.toml. Source paths are remapped, so the
# bytes do not depend on where the checkout or the cargo registry is.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CRATE="$ROOT/wasm/png-deflate"
OUT="$ROOT/negative2positive/src/workers"
REGISTRY="${CARGO_HOME:-$HOME/.cargo}"
TARGET_DIR="$(mktemp -d)"
trap 'rm -rf "$TARGET_DIR"' EXIT

REMAP="--remap-path-prefix=$REGISTRY=/cargo --remap-path-prefix=$CRATE=/png-deflate"
SIMD_FLAGS="-C target-feature=+simd128"

build() { # <extra rustflags> <module name>
  (cd "$CRATE" && RUSTFLAGS="$REMAP $1" CARGO_TARGET_DIR="$TARGET_DIR/$2" \
    cargo build --locked --release --target wasm32-unknown-unknown)
  cp "$TARGET_DIR/$2/wasm32-unknown-unknown/release/png_deflate.wasm" "$OUT/$2"
}

build "" png-deflate.wasm
build "$SIMD_FLAGS" png-deflate-simd.wasm

line() { # <module name> <how>
  local file="$OUT/$1"
  printf '%-22s %s %8d  %s\n' "$1" "$(shasum -a 256 "$file" | cut -d' ' -f1)" "$(wc -c < "$file" | tr -d ' ')" "$2"
}

{
  echo "png-deflate (#301): zlib-rs raw deflate behind a C ABI, for workers/pngDeflateWasm.js"
  echo "source:    wasm/png-deflate (Cargo.lock), built by scripts/build-png-deflate-wasm.sh"
  echo "zlib-rs:   $(awk '/^name = "zlib-rs"/{getline; print $3}' "$CRATE/Cargo.lock" | tr -d '"') (Zlib licence)"
  echo "toolchain: $(cd "$CRATE" && rustc -V)"
  echo "           $(cd "$CRATE" && cargo -V)"
  echo "target:    wasm32-unknown-unknown, release profile (opt-level 3, lto, codegen-units 1, panic abort, strip)"
  echo
  echo "module                 sha256                                                              bytes  rustflags"
  line png-deflate.wasm "(none)"
  line png-deflate-simd.wasm "$SIMD_FLAGS"
} > "$OUT/png-deflate-build-info.txt"

cat "$OUT/png-deflate-build-info.txt"

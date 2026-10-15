# png-deflate

Raw deflate for the 16-bit PNG export (#301): [zlib-rs](https://github.com/trifectatechfoundation/zlib-rs)
0.6.8, a Rust port of zlib-ng, compiled to WebAssembly behind a small C ABI.
`negative2positive/src/workers/pngDeflateWasm.js` wraps it in pako's
streaming `Deflate` interface for `png16Bands.js`, so the band encoder and
its layout are unchanged (`docs/batch-export-pipeline.md`).

Why this and not more WebAssembly: on the encoder's real band streams it
deflates about 1.8× as fast as pako in V8 and 1.5× in JavaScriptCore with the
same compression, while ports of the app's own pixel kernels gained
0.5–1.6× and are not worth a second implementation (measurements in #301).

## The modules

Two builds of this crate are committed next to the JS wrapper:

| file | rustflags | runs where |
|---|---|---|
| `negative2positive/src/workers/png-deflate.wasm` | none | engines without WASM SIMD (macOS 10.15's WebKit) |
| `negative2positive/src/workers/png-deflate-simd.wasm` | `-C target-feature=+simd128` | everywhere `wasmSimdSupported()` holds |

Both write identical bytes (`pngDeflateWasm.test.mjs`); SIMD only speeds up
zlib-rs's internals. They import nothing. `png-deflate-build-info.txt`
records the toolchain, the zlib-rs version and both SHA-256 hashes, and the
test holds the files to it. Vite emits them as hashed assets
(`new URL(..., import.meta.url)`), so neither the web build, Vercel nor CI
needs Rust.

## Rebuilding

```bash
bash scripts/build-png-deflate-wasm.sh
```

Run it after changing `src/lib.rs`, `Cargo.toml`, `Cargo.lock` or
`rust-toolchain.toml`, and commit the two modules and the build info
together. rustup installs the pinned toolchain and the `wasm32-unknown-unknown`
target from `rust-toolchain.toml`. Source paths are remapped
(`--remap-path-prefix`), so the same inputs give the same bytes in any
checkout; the build info's hashes are the check.

To update zlib-rs: change the exact version in `Cargo.toml`, run
`cargo update -p zlib-rs` here, rebuild, and run
`node negative2positive/src/workers/pngDeflateWasm.test.mjs`,
`node negative2positive/src/workers/png16Bands.test.mjs` and
`npm run test:smoke -- --png16-only`. A new zlib-rs may compress to other
bytes; decoded samples must not change.

## C ABI

| function | does |
|---|---|
| `pd_alloc(len) -> ptr` / `pd_free(ptr, len)` | caller buffers in the module's memory |
| `pd_new(level, strategy) -> stream` | a raw stream, zlib's 32 KiB window and memory level 8; null for a level or strategy zlib rejects |
| `pd_deflate(stream, in, in_len, out, out_cap, flush) -> status` | zlib's `deflate()`: 0 progress, 1 stream end, 2 no progress (`Z_BUF_ERROR`), negative zlib errors |
| `pd_consumed(stream)` / `pd_produced(stream)` | what the last call read and wrote |
| `pd_end(stream)` | frees a stream, finished or not |

As in zlib, a flush whose output does not fit `out_cap` is completed by the
next call with one more empty block, so the bytes depend on the output size
at flush points; the encoder's is fixed (1 MiB).

## Licences

This crate is part of the application (MIT). zlib-rs is under the zlib
licence (its text is in the crate, `LICENSE` in the cargo registry); the
modules also contain parts of Rust's standard library (MIT or Apache-2.0).

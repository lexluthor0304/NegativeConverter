# libraw-wasm (vendored, #302)

The app's RAW decoder in WebAssembly: libraw-wasm built from
[lexluthor0304/LibRaw-Wasm@45b40c0](https://github.com/lexluthor0304/LibRaw-Wasm/commit/45b40c07e08f46a3330a7aa2945f5d389daf592a),
the head of the upstream pull request ybouane/LibRaw-Wasm#30, which upstream
has not released on npm. It is the 1.6.0 package plus that PR:

- **Deterministic decoding.** No `-ffast-math`, `-ffp-contract=off`, and
  LibRaw's `pow`/`powf`/`exp`/`log`/`logf`/`cos` from bundled musl 1.2.6, so
  the pixels do not depend on the toolchain. The desktop's native LibRaw
  (`src-tauri/src/native_raw.rs`) decodes to the same RGB16
  (`src-tauri/native/wasm-parity-hashes.json`).
- **An optional multi-threaded module** (`new LibRaw({ threads })`,
  `LibRaw.features.threads`), which `librawRuntime.js` uses where the page has
  shared memory. Its pthread pool workers are named `em-pthread-mt`.
- **Worker failures reject** the pending call instead of hanging.

`package.json` (repository root) depends on it as
`"libraw-wasm": "file:negative2positive/vendor/libraw-wasm"`, so every import
of `libraw-wasm` stays as it was. `LIBRAW_WASM_VERSION` in
`src/app/nativeRawDecoder.js` names this version
(`1.6.0-deterministic.45b40c0`), and `scripts/check-pinned-versions.mjs`
holds the two together.

## Pixels

It decodes slightly differently from 1.6.0, which was a flagged change in the
release that shipped it (`docs/raw-decoding.md`, "The one flagged change").
For example, on `_DSC5290.dng` 769 of 24.3 M pixels differ, and 1.6.0's black
samples at the auto-bright white point are gone.

## Rebuilding

```bash
bash scripts/build-libraw-wasm.sh
```

The script checks out the pinned commit, runs the PR's own build
(`FORCE_LIBS=1 bash compileLibraw.sh && node build.js`) and copies `dist/`
here. It also writes `package.json` and `BUILD-INFO.txt`, which holds the
SHA-256 of every file.

It needs:
- Emscripten 6.0.4;
- autotools;
- network access for LibRaw 0.22.1 and Little-CMS 2.19.1.

The build is deterministic: the same commit and toolchain give the same
bytes, so compare `BUILD-INFO.txt`.

## Back to npm

When upstream publishes #30, follow these steps:

1. Install the release in a scratch directory and compare its `dist/` hashes
   with `BUILD-INFO.txt`.
2. If they are identical, set `package.json` to that exact version,
   `LIBRAW_WASM_VERSION` and `NATIVE_RAW_PARITY.librawWasm` to it, update the
   lockfile and delete this directory.
3. If they differ, run the RAW gates of `docs/raw-decoding.md` against the
   release first.

## Licences

libraw-wasm is ISC. Inside the modules:
- LibRaw 0.22.1, used under the CDDL-1.0;
- Little-CMS 2.19.1, MIT;
- the Independent JPEG Group's libjpeg 9f;
- musl's math functions, MIT;
- in the multi-threaded module, LLVM's OpenMP runtime, Apache-2.0 WITH
  LLVM-exception.

Their notices are in `negative2positive/public/licenses/raw-decoder-notices.txt`
(`scripts/check-third-party-notices.mjs`).

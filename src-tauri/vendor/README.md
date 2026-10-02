# Vendored third-party code for the native RAW decoder

Compiled into the desktop app by `src-tauri/native/build_libraw.rs`; see
`docs/native-raw-decode.md`. Nothing here is modified.

## libraw/ — LibRaw 0.22.1

- Source: https://github.com/LibRaw/LibRaw, tag `0.22.1`, commit
  `b860248a89d9082b8e0a1e202e516f46af9adb29` (the release libraw-wasm 1.6.0
  and its deterministic rebuild compile).
- Contents: the library's translation units (`src-tauri/native/libraw-sources.txt`,
  LibRaw's `lib_libraw_a_SOURCES`), `libraw/` and `internal/` headers,
  `COPYRIGHT`, `LICENSE.CDDL`, `LICENSE.LGPL`, `README.md`, extracted with
  `git archive b860248 <paths>`.
- Licence: LGPL-2.1 or CDDL-1.0; the app uses CDDL-1.0 (see the doc and
  `negative2positive/public/licenses/raw-decoder-notices.txt`).
- Updating: replace the directory with the new tag's files, update
  `libraw-sources.txt` from its `Makefile.am`, and re-run the parity tests
  against the libraw-wasm build of the same release.

## portable-math/ — musl 1.2.6 libm subset

- Copied byte-identically from libraw-wasm's `portable-math/` (#264 part B):
  unmodified musl v1.2.6 `pow`, `powf`, `exp`, `log`, `logf`, `cos` and their
  data tables (`musl-1.2.6.tar.gz`, sha256
  `d585fd3b613c66151fc3249e8ed44f77020cb5e6c1e635a616d3f9f82460512a`),
  plus libraw-wasm's stand-in headers. SHA-256:
  - `libraw_portable_math.h` `7c8a296d2025d4f0ca28b95ef64b8f2c44183058140924fca5e2998e2931fcaa`
  - `include/libm.h` `29c502a954e668a68da174866db95938b9c5070d249bc1c040b78783a77ceb22`
  - `include/features.h` `c400ec04072f56261b3739832883bda5a3090206b23573864d101370564a4718`
  - `(cd musl && cat $(ls *.c *.h | sort) | shasum -a 256)`
    `0ac4775ed249adce05e909ecf77e2a26bf6bd82fe414d0e92def1f6886166354`
- Licence: MIT (`musl/COPYRIGHT`). The math files carry their own notices
  (Arm Limited's MIT, Sun Microsystems'), which musl's COPYRIGHT refers to;
  both are reproduced in `negative2positive/public/licenses/raw-decoder-notices.txt`,
  and `scripts/check-third-party-notices.mjs` fails when a vendored file's
  notice is missing there.
- Must stay identical to the copy the page's libraw-wasm release was built
  with, or native and WASM output diverge.

## libomp/macos/ — LLVM OpenMP runtime 22.1.8, static

- Built by `scripts/build-libomp-macos.sh` from `llvm-project-22.1.8.src.tar.xz`
  (sha256 `922f1817a0df7b1489272d18134ee0087a8b068828f87ac63b9861b1a9965888`):
  `LIBOMP_ENABLE_SHARED=OFF`, no OMPT/OMPD/hwloc, x86_64 for macOS 10.15 and
  arm64 for macOS 11.0, merged with `lipo`, build paths mapped away
  (`-ffile-prefix-map`).
- `lib/libomp.a` sha256 `54f84234936c62b0e441efc580ab37fe700a938cd7615275b854c1b813af3dae`,
  `include/omp.h` sha256 `5974470842520cea4bc50136e2329bbf4e36ba928d317e86f7def2ba1752d3d4`.
  Reproducible: a rebuild with the script from the verified tarball on
  2026-09-30 (Apple clang 21, cmake 4) gave both hashes again.
- Licence: Apache-2.0 with LLVM Exceptions, with legacy parts from Intel's
  runtime under the University of Illinois/NCSA or MIT licence
  (`LICENSE.TXT`). Those require the notice in binary distributions, so the
  whole file is reproduced in
  `negative2positive/public/licenses/raw-decoder-notices.txt`.
- Linked statically, so the app loads no OpenMP library at run time and the
  App Store build needs no extra entitlement.

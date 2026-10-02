# Native RAW decode on the desktop (#264 part C)

The web app decodes RAW files with LibRaw compiled to WebAssembly
(`libraw-wasm`), on one core, inside the page's process. The desktop app
links the same LibRaw release natively (`src-tauri/src/native_raw.rs`) and can
decode on every core with OpenMP, outside WebContent. It does so only where the
native output is verified bit-identical to the libraw-wasm release the page
runs; everywhere else the page keeps libraw-wasm. Today that is nowhere by
default (see [The gate](#the-gate)).

## What runs where

How this decoder fits with libraw-wasm's single- and multi-threaded builds,
and what each target runs, is in `docs/raw-decoding.md`.

```
rawFileLoader.js ── createRawDecoder() ──► libraw-wasm      (web, unverified desktops;
                                      │                      createLibRaw: threaded or not)
                                      └──► nativeRawDecoder.js (verified desktops)
                                              │ native_raw_begin / _append (8 MiB raw invoke bodies)
                                              │ native_raw_open            (open_buffer + metadata)
                                              │   … the loader's memory reservation (#258) …
                                              │ native_raw_process         (unpack, dcraw_process,
                                              │                             the RGBA16 plane)
                                              │ nativeRawFetchWorker.js ◄── rawdecode://localhost/<id>?part=k
                                              ▼
                                   { width, height, colors: 4, bits: 16, data: Uint16Array }
                                   → rawPostDecodeWorker (packRGBToImage16(…, 4) only wraps)
```

- `nativeRawDecoder.js` hands the loader an object with libraw-wasm's
  interface and semantics (`open`, `metadata(true)`, `imageData`, `dispose`),
  so the loader's timeouts, aborts, memory gate and fallbacks are unchanged.
  The loader hook is one line.
- It reproduces exactly the settings `rawFileLoader.js` passes (the fixed
  set plus `halfSize` and `outputBps`; `nc_libraw.cpp` sets the same LibRaw
  parameters). Any other setting decodes with libraw-wasm without a native
  attempt (`nativeDecodeOptions`).
- The file bytes the page already holds go to the shell as raw invoke bodies
  (like `append_export_chunk`): the App Store sandbox never sees a path and no
  entitlement is added.
- `native_raw.rs` runs LibRaw on the blocking pool. The plane is written
  straight from LibRaw's image, row-parallel on the decode's threads
  (`NcLibRaw::pack_rgba16` in `nc_libraw.cpp`): the output curve comes from
  `copy_mem_image()`'s own code (histogram white point, `gamma_curve`), each
  pixel is read at the index `copy_mem_image()` would read it for the
  file's orientation, and it is written as the page's post-decode pass packs
  libraw-wasm's result (`packRGBToImage16`: alpha 65535 after RGB, a grey
  sample replicated, a fourth colour kept, 8-bit samples ×257). There is no
  intermediate RGB image (`dcraw_make_mem_image()` allocates 362 MB at
  60 MP) and no serial copy (at 24 MP: 13 ms instead of 37 ms for
  `copy_mem_image()` plus widening). The Rust tests hold the plane to
  `packRGBToImage16(dcraw_make_mem_image())` for all eight orientations at
  8 and 16 bits, full and half size.
- The plane is served from the `rawdecode` scheme in 32 MiB parts, with CORS
  and `Cross-Origin-Resource-Policy: cross-origin` (valid under COEP
  `require-corp`). The CSP's `connect-src` lists `rawdecode:` and
  `http://rawdecode.localhost` (Windows).
- A disposable worker (`nativeRawFetchWorker.js`, started while LibRaw
  decodes) streams the parts into one buffer and transfers it: no task on the
  page copies pixels. If a worker cannot reach the scheme (its first fetch
  fails as a network error), the page reads the parts itself, in chunks of a
  few hundred KiB, and remembers that for the session.
- `sharedPlane` (off): where the page is cross-origin isolated (#264 Part A)
  the worker can allocate the plane in shared memory and post it without a
  transfer list. It stays off until the post-decode pass keeps a shared
  4-channel plane instead of copying it (`rawResultToRgb16`), and nothing
  would use it yet: native decoding is enabled only on macOS, whose WKWebView
  has no `SharedArrayBuffer`. Where both meet later (WebView2), the editor's
  decodes still end in shared memory: the post-decode worker builds their
  shared plane from the transferred one, in the worker, as for a WASM decode.
- The metadata object mirrors libraw-wasm's `metadata(true)` for every key the
  loader reads (size, camera, lens), in the same key order, with LibRaw's
  `float`s widened exactly as embind does. `extractRawLensMetadata` searches
  the whole object breadth-first; the only keys of libraw-wasm's much larger
  object that match its names are `camera_make`, `camera_model`,
  `focal_len`, `aperture`, `lens` and `lens.LensMake`/`Lens`, all of which the
  native object has at the same places, so it answers identically (checked on
  all fixtures against libraw-wasm 1.6.0 and the deterministic build).

### Failure handling

| what fails | libraw-wasm does | the native path does |
|---|---|---|
| LibRaw rejects the file itself: unsupported (the HE-compressed Nikon NEFs, `unpack` −2), corrupt or truncated data, beyond LibRaw's size limits | its worker swallows the C++ exception; `open()`/`imageData()` resolve `undefined`; the loader takes the embedded-JPEG path | resolves the same way; the loader takes the same path with **no second LibRaw attempt** (`librawError`) |
| anything else: IPC, a refused session, the transfer, a step timeout (open 10 s, decode 20 s, transfer 20 s, each at most a third of the loader's budget), out of memory, an unexpected exception or sample layout | — | decodes the same bytes and settings with libraw-wasm (`needsWasm`), built by `createLibRaw` like any web decode (the threaded build where the page has shared memory, with the lane's thread cap) |
| a file this build decodes differently: lossy DNG / Kodak JPEG (no libjpeg natively: `LIBRAW_WARN_NO_JPEGLIB` at open) | — | libraw-wasm |
| abort (#243) | the worker is disposed | the session is released: LibRaw's cancel flag, a progress handler and the plane packing stop it at their next check |

`failure_status` in `native_raw.rs` is the list of LibRaw codes that count as
the file's own (−2, −3, −8, −100008, −100009, −100011, −100012, −100013);
everything else, including unknown codes, retries with WASM. "The same
result" after a fallback holds because the gate below only enables native
decoding where native and WASM output are identical.

## Determinism

The native build uses exactly the settings of the deterministic libraw-wasm
rebuild (#264 part B, `notes/264-decoder.md` in the #229 program):

- LibRaw 0.22.1, commit `b860248a89d9082b8e0a1e202e516f46af9adb29` (the
  annotated tag `0.22.1` upstream), vendored unmodified in
  `src-tauri/vendor/libraw` (all 101 files byte-identical to that commit;
  sources = LibRaw's `lib_libraw_a_SOURCES`, listed in
  `src-tauri/native/libraw-sources.txt`).
- `-O3 -ffp-contract=off`, no fast-math, `-DNDEBUG`, `-fsigned-char` (as on
  wasm32, x86-64 and Apple arm64; Linux arm64 defaults to unsigned). Clang
  fuses `a*b+c` into FMA by default on arm64 and GCC in GNU mode everywhere;
  WASM and baseline x86-64 have none.
- LibRaw's `pow`/`powf`/`exp`/`log`/`logf`/`cos` go to unmodified musl 1.2.6
  copies (`src-tauri/vendor/portable-math`, byte-identical to libraw-wasm's
  `portable-math/` and to Emscripten 6.0.4's musl), force-included with
  `libraw_portable_math.h`; the musl files build with `-O2 -ffp-contract=off
  -fno-builtin -U__FP_FAST_FMA -include include/libm.h`. The only other libm
  symbols the compiled archive references are `fabs`, `floor` and `scalbn`
  (the last from musl's `__rem_pio2_large`), all exact.
- OpenMP with `LIBRAW_FORCE_OPENMP` (libraw_types.h drops
  `LIBRAW_USE_OPENMP` on Apple when `_REENTRANT` is set). `unpack()` runs on
  the whole team; `dcraw_process()` runs on one thread unless the sensor is
  Bayer (or non-CFA) and the demosaic is not DHT: LibRaw's X-Trans demosaic,
  its X-Trans half-size copy and DHT read pixels other threads write. The
  wrapper in libraw-wasm applies the same rule, at the same point (after
  `unpack()`).
- Thread-safe LibRaw (no `LIBRAW_NOTHREADS`, like libraw-wasm's `libraw.la`
  build).
- Deliberately different: no `USE_JPEG` and no `USE_LCMS2` natively. LCMS is
  only used with colour profiles, which the app never sets. Without libjpeg,
  LibRaw refuses lossy DNG and Kodak JPEG files at open; those decode with
  libraw-wasm on the desktop too. Neither build has `USE_ZLIB` (the WASM
  archive references no zlib), so deflate DNGs fail alike.
- Residual risk: wasm32 is ILP32 (`long` and `size_t` are 32-bit), the
  native targets LP64. A LibRaw computation that overflows a 32-bit `long`
  would differ; the gate's fixtures are what rules that out per release.

### Verified (2026-09-30, M1 Pro)

RGB16 SHA-256 over `dcraw_make_mem_image`, the app's options, 16 bits; native
at 1, 4 and 8 threads, all equal, and equal to the deterministic libraw-wasm
build (single-threaded and threaded) — `src-tauri/native/wasm-parity-hashes.json`,
checked by `npm run test:rust` whenever the fixtures are present:

| file | setting | native = deterministic WASM | libraw-wasm 1.6.0 |
|---|---|---|---|
| `_DSC3111.NEF` 4000×2672 | full | `807257b7…03b7b3` | `c49338e2…4c454f` |
| `_DSC3111.NEF` | half size | `dd11ed90…ec2dac` | `377ca191…cd1afe` |
| `_DSC5290.dng` 6048×4024 | full | `1ef215b7…15fa1b` | `651852cd…23e55b` |
| `_DSC5290.dng` | half size | `7a9568c7…8c8b90` | `ccd8e8fa…df19d6` |

The same four hashes at 1, 4 and 8 threads from three toolchains:

- the app's build (Apple clang 21, arm64, static libomp) — `cargo test`;
- Apple clang 21 for x86_64 (macOS 10.15 target, the libomp x86_64 slice),
  run under Rosetta 2; an Intel Mac has not run it;
- GCC 16 with libgomp on arm64 (the compiler family of the Linux build).

The last two are a scratch driver over `nc_libraw.cpp` and the vendored
sources with the build script's flags, not the Tauri app. The same three
toolchains, at 1, 4 and 8 threads, also decode three synthetic CFA DNGs
(`scripts/perf/fixtures.mjs` `writeSyntheticDng`, 1600×1066, colour seeds
41 and 11, B&W seed 43) to the RGB16 of the deterministic libraw-wasm build,
single-threaded and threaded (8), in Node; libraw-wasm 1.6.0 differs on all
three.

The HE-compressed `DSC_8800/8798/8806/4127.NEF` open (metadata as in WASM)
and fail in `unpack()` with LIBRAW_FILE_UNSUPPORTED (−2) natively as in WASM.
The metadata of all six fixtures equals libraw-wasm's. The 60 MP M11 DNGs
were not decoded here.

## The gate

`nativeRawDecoder.js`:

- `LIBRAW_WASM_VERSION`: the libraw-wasm release the page runs.
  `scripts/check-pinned-versions.mjs` keeps it equal to `package.json` and to
  the version `package-lock.json` installs.
- `NATIVE_RAW_PARITY = { librawWasm, platforms }`: the release the native
  output was verified against, and the `<os>-<arch>` keys (`native_raw_info`)
  where it was. Native decoding is on only when both match.

Today `librawWasm` is `null`: the app still runs libraw-wasm 1.6.0, whose
output differs from the deterministic build (the flagged decoder change of
part B), so desktops keep decoding with WASM. `package.json` pins 1.6.0
exactly. When the deterministic libraw-wasm is released, follow
`docs/raw-decoding.md` ("When the deterministic libraw-wasm is released"):
pin it, run the WASM RGB16 gate (`--raw-decode-gate-only`) against
`src-tauri/native/wasm-parity-hashes.json`, run `npm run test:rust` with the
fixtures on each platform, then set `NATIVE_RAW_PARITY.librawWasm` to it.

macOS arm64 and x86_64 then decode natively. Add another platform after its
parity test passes there.

Support / measurement override: `localStorage.nc_native_raw = 'on'` decodes
natively wherever the decoder is built in (even unverified), `'off'` never.

## Threads, memory and cancellation

- Foreground decodes use every core; `priority: 'background'`
  (`loadFileToImageData`) uses 2 threads, so a background lane leaves the
  cores to the photo on screen; the same flag caps libraw-wasm's threaded
  build. The thread count never changes the output.
- Memory, in the app process: the file bytes are freed once `dcraw_process()`
  is done, before the plane is allocated, and LibRaw's image and raw buffers
  right after the plane is written. At 60 MP the peak is LibRaw's image
  (483 MB) and raw data (121 MB) plus the plane (483 MB); WebContent holds
  the plane only (about 1.2–1.6 GB of LibRaw heap leave it).
- Releasing a session sets LibRaw's cancel flag, which the decoders check per
  row or tile row inside `unpack()`, makes the progress handler stop
  `dcraw_process()` at its next callback (stage starts and ends, and every
  AHD band thread 0 starts), and makes the plane widening skip its remaining
  rows. What runs between two checks runs to its end. For `_DSC5290.dng`
  (24 MP, 8 threads, load average ~20) the progress handler was called at
  the start and end of `unpack()` (whose DNG decoder checks the cancel flag
  per row), then after 29 ms (`raw2image_ex`, no check), at both ends of
  `scale_colors` (108 ms, serial), of `pre_interpolate` (5 ms), once at the
  start of AHD (198 ms: eight 506-row bands on eight threads, and only
  thread 0 calls the handler, when it starts a band) and at both ends of
  `convert_to_rgb` (71 ms, serial). The Rust test cancels at 12 points of a
  decode: the decode returned within 33 ms (10.7 MP) and 122 ms (24 MP) at
  most. At 60 MP the longest stretches (AHD's bands, `scale_colors`) scale
  to an estimated 0.2–0.3 s. The page never waits for it: the pending call
  rejects at once, and a stretch that is serial occupies one core.
- The statically linked libomp shuts itself down when the last OS thread that
  used it exits, and LibRaw's `#pragma omp critical` lock then dangles (the
  next decode on a new blocking-pool thread crashed). A parked thread that
  registers with libomp first and never exits keeps the runtime up
  (`openmp_anchor`).

## Build and packaging

`src-tauri/native/build_libraw.rs` (included by `build.rs`) compiles LibRaw,
the musl functions and the C shim (`src-tauri/native/nc_libraw.cpp`) with the
`cc` crate, spread over cargo's jobs, and caches the archive by a fingerprint
of sources, flags and compiler. It is not a cargo feature, so the App Store
build (`--no-default-features`) has it too.

LibRaw's sources are vendored (about 2 MB), not fetched at build time: every
build (CI, the App Store build, an offline machine) compiles exactly the
reviewed files without network access, the source the CDDL obliges us to make
available is the repository itself, and a LibRaw update is an ordinary
reviewed diff. The OpenMP runtime is the one prebuilt binary: building libomp
in `build.rs` would need cmake and Python on every build machine and minutes
per architecture, so the archive is committed together with the script that
rebuilds it byte-identically from the checksummed LLVM source.

| platform | default | OpenMP runtime |
|---|---|---|
| macOS (x86_64, arm64, universal) | built | static LLVM libomp 22.1.8 in `src-tauri/vendor/libomp/macos` (x86_64 for 10.15, arm64 for 11.0; `scripts/build-libomp-macos.sh` rebuilds it byte-identically). Nothing is loaded at run time; the App Store build needs no new entitlement. |
| Linux | built, one thread | `NEGATIVE_CONVERTER_NATIVE_RAW_OPENMP=gomp` links libgomp; the deb/rpm then have to depend on `libgomp1`/`libgomp` (the AppImage bundles it) |
| Windows | not built | `NEGATIVE_CONVERTER_NATIVE_RAW=1` builds it single-threaded; `…_OPENMP=vcomp` adds `/openmp`, and `vcomp140.dll` must then ship next to the executable |

`NEGATIVE_CONVERTER_NATIVE_RAW=0` leaves the decoder out anywhere; the commands
then report it unavailable. Linux and Windows builds are unverified in the
app: their parity test has to pass there before they join
`NATIVE_RAW_PARITY`.

## Security and crash containment

LibRaw parses the RAW file. In the WASM path a parser bug stays inside the
WebAssembly sandbox and at worst kills a worker; natively it runs in the
app's own process, which in the direct-download builds is not sandboxed
(`entitlements.plist`), and a crash takes the app down. The App Store build
keeps the App Sandbox. Keep the vendored LibRaw on current releases (its
security fixes land there), and consider a helper process for the decoder if
the files the app opens become less trusted than the user's own scans.

## Licences

LibRaw is dual-licensed LGPL-2.1 / CDDL-1.0. The apps use it under
**CDDL-1.0**: its obligations are file-based, with no relinking requirement,
which suits a statically linked App Store binary (LGPL-2.1 would add the duty
to let users relink with a modified LibRaw). The covered source files stay
available under CDDL with the licence text (unmodified in
`src-tauri/vendor/libraw`, and upstream); recipients of the executable must
be told how to obtain them (§3.1); and where the executable is distributed
under other terms, as the App Store does under Apple's licence agreement,
those terms must be made clear as the distributor's alone (§3.5). These are
conditions of the licence grant. They apply to every macOS and Linux build,
the App Store build included, whether or not `NATIVE_RAW_PARITY` lets the
page use the native decoder, and every app (the web app and Windows
included) also runs LibRaw as libraw-wasm.

`negative2positive/public/licenses/raw-decoder-notices.txt` carries the
notices: where LibRaw's source is and the §3.5 statement, LibRaw's COPYRIGHT
and the copyright lines of its source files, the BSD licences of DCB/FBDD and
the X3F tools, the MIT notice of the DNG SDK code, musl's COPYRIGHT in full
with the notices of the compiled math files (Arm Limited's MIT for pow, exp,
log, powf, logf and their tables; Sun Microsystems' for cos and its kernels,
"provided that this notice is preserved"), the CDDL text, and the OpenMP
runtime's licence file (Apache-2.0 with LLVM Exceptions; its legacy parts
from Intel's runtime are under the University of Illinois/NCSA or MIT
licence, which ask for the notice in binary distributions).

Recipients find it:

- in every desktop package, as a plain file (`bundle.resources` in
  `src-tauri/tauri.conf.json`): `Contents/Resources/licenses/` in the macOS
  app, the App Store build included, the installation folder on Windows, and
  `usr/lib/<product name>/licenses/` in the deb and rpm packages and the
  AppImage. The copy among the frontend assets alone would not do: Tauri
  compresses those into the executable.
- in the app: the Studio menu's Third-party notices entry opens it in a new
  tab; the desktop app opens the site's copy in the browser, as it does every
  link.
- on the site at `/licenses/raw-decoder-notices.txt`, linked from
  `about.html` (Source, releases and support).
- in the GitHub release text (`append_body` in
  `.github/workflows/desktop-release.yml`), which names LibRaw, the CDDL-1.0,
  the source and the file.
- in the App Store description, which this repository does not manage
  (`docs/mas-release.md`).

`scripts/check-third-party-notices.mjs` (part of `npm test`) fails when a
copyright or SPDX line or a permission notice in the header of a vendored
source, or a vendored licence file, is missing from the notices, and when the
menu link, its zh/en/ja label, the about page's link or the release text's
mention goes; `scripts/check-tauri-config.mjs` keeps the bundle resource and
keeps the override configs away from it; `node scripts/smoke-test.mjs
--workspace-ui-only` clicks the menu entry and reads what it opens.

## Measured

macOS 27 arm64 WKWebView, M1 Pro while other agents loaded the machine
(load average 16–35), 2026-09-30, with `localStorage.nc_native_raw = 'on'`,
from a temporary probe page in three runs: two under `tauri dev` (the page
from the Vite server, not isolated) and one in a debug build with embedded
assets (`tauri://localhost`) and the COOP/COEP pair, where the page and its
workers were cross-origin isolated. Debug shell, LibRaw at `-O3`; ranges
over the three runs, medians of three where repeated:

| file | bytes held in JS → packed RGBA16 plane in the page | of which LibRaw + plane / transfer | loader, bytes → ImageData (incl. the post-decode pass) | the same with libraw-wasm 1.6.0 |
|---|---|---|---|---|
| `_DSC3111.NEF` 10.7 MP (85.5 MB plane) | 320–327 ms | 250 / 30–57 ms | 468–487 ms | 1036–1043 ms |
| `_DSC3111.NEF` half size | 197–202 ms | 175 / 17 ms | — | — |
| `_DSC5290.dng` 24.3 MP (194.7 MB plane) | 693–779 ms | 593–668 / 74–164 ms | 1016–1035 ms | 2053–2093 ms |
| `_DSC5290.dng` half size | 465–817 ms | 426 / 28 ms | — | — |

- Every plane that reached the page hashed to the Rust tests' RGBA16 hash.
  The page's longest task during these decodes was 9–19 ms (4 ms interval
  probe); none exceeded 50 ms. libraw-wasm's own path showed 43–44 ms.
- Transfer alone, 194.7 MB in six parts from the worker: 100–158 ms one
  part at a time, 72–82 ms with the next part requested ahead (the default),
  63–123 ms two ahead.
- `DSC_8800.NEF` (HE): embedded JPEG in 344–426 ms, no libraw-wasm worker
  created. (One 58 ms task there is the preview JPEG's decode on the page,
  the fallback's existing path.)
- An IPC failure injected at `native_raw_process`: decoded with libraw-wasm,
  plane identical to a libraw-wasm-only decode.
- Abort 300 ms into a 24 MP decode: rejected 1 ms later; the next
  foreground decode took 294–308 ms (baseline 320–327 ms).
- A 24 MP background decode (2 threads, 1216–1465 ms) running under a
  foreground 10.7 MP decode: the foreground took 304–338 ms.
- Cross-origin isolated (the built app): the transfer worker reached the
  scheme and every result above held. WKWebView reports
  `crossOriginIsolated` there but, per Part A's check, offers no
  `SharedArrayBuffer`, so `sharedPlane` would have nothing to allocate on
  macOS anyway.

Not measured here (60 MP M11 files are off-limits on this machine; other OSes
unavailable): the 60 MP cold decode (target ≤ 2.0 s), WebContent RSS, roll
analysis and Export All over the 116-frame roll, WebView2 and WebKitGTK.

## Tests

- `npm test`: `nativeRawDecoder.test.mjs` (gate, settings, upload chunking =
  the Rust limit, metadata post-processing, dispose, plane reads, shared
  planes, worker → page fallback) and `rawFileLoader.native.test.mjs` (planes
  identical to the WASM path, HE NEF → embedded JPEG without WASM, every
  native failure → WASM with the same bytes, timeouts, abort, thread
  requests).
- `npm run test:rust`: failure classification, sessions, the scheme's CORS
  answer, and with the fixtures (`NATIVE_RAW_FILES`, `NATIVE_RAW_HE_FILES`,
  `NATIVE_RAW_EXPECTED`, default: the worktree-root fixtures) thread-count
  independence, the WASM gate hashes, the plane against
  `dcraw_make_mem_image` for every flip and depth, the metadata, the HE NEF
  failure and cancel latency.

# RAW decoding paths and cross-origin isolation (#264)

Every RAW decode goes through one seam, `loadRawFile` in
`negative2positive/src/app/rawFileLoader.js`. It picks one of three decoders,
all of which run LibRaw 0.22.1 with the same settings
(`librawDecodeSettings()`), and hands the result to the same post-decode pass
(packing, the sensor-defect pass, the 8-bit mirror; `rawPostDecode.js`).
Where more than one decoder can run, they are held to the same pixels, so
the choice changes only how fast the exact image arrives. The two detailed
pages are `docs/native-raw-decode.md` (the desktop's native LibRaw) and
`docs/cross-origin-isolation.md` (the headers, shared planes, threads).

## Which decoder runs

```
loadRawFile ── createRawDecoder (nativeRawDecoder.js)
                 │ desktop, gate passes ─► native LibRaw in the shell
                 │                          └ any other failure ─► the libraw-wasm row below
                 └ otherwise ─► createLibRaw (librawRuntime.js)
                                  │ shared memory + LibRaw.features.threads ─► new LibRaw({ threads })
                                  │                                   └ did not start ─► new LibRaw()
                                  └ otherwise ─► new LibRaw()
```

| where | decoder | threads | when it cannot decode |
|---|---|---|---|
| desktop app whose native LibRaw passes the gate (`NATIVE_RAW_PARITY`: the pinned libraw-wasm release and the platform it was verified on; **no platform today**) | native LibRaw 0.22.1 with OpenMP, in the app process | every core; 2 for a background lane | LibRaw rejects the file (unsupported, corrupt, too big): the embedded JPEG, no second LibRaw attempt. Anything else (IPC, transfer, a step timeout, memory, lossy DNG, other settings): libraw-wasm below, with the same bytes and settings |
| a page with shared memory (`crossOriginIsolated` **and** `SharedArrayBuffer`) and a libraw-wasm that ships the threaded build (`LibRaw.features.threads`: the vendored build since #302, not 1.6.0) | libraw-wasm's threaded build, `new LibRaw({ threads })` | min(cores, 8); 2 for a background lane | an instance that does not start (its worker, pthread pool or 4 GB shared memory; `runtimeInfo()` rejects or does not answer in 8 s) decodes on `new LibRaw()` instead, before any bytes are handed over, and the page stops asking for threads |
| everywhere else | `new LibRaw()`, exactly as before #264 | 1 | as before |

After LibRaw, whichever ran: no image (the HE-compressed NEFs) or a decode
timeout gives the embedded JPEG (8 bits), and un-demosaiced output the same;
a post-decode worker that dies holding the pixels too. A libraw-wasm worker
that fails (its script refused, or an error escaping it) takes the timeout's
path at once: `librawRuntime.js` watches every instance's worker, disposes a
failed one and rejects its calls with the loader's timeout code, where
libraw-wasm 1.6.0 left `open()` to wait out its 30 s (#229 review R2-046).

Embedded JPEG fallback admission uses the extracted preview dimensions after
any source reread, including a RAW-open timeout before metadata. The same
gate runs at the JPEG worker's ready/transfer boundary and before a browser
retry; foreground work may have arrived during either wait. IIQ's preview
shortcut uses this path too. Abort and admission errors propagate without
starting another decoder. This preserves the existing 8-bit fallback pixels.

One flag caps a background lane on either decoder: `loadFileToImageData`'s
`priority: 'background'`, which only the background lanes pass: roll
analysis, the prefetch and the shared decodes the editor adopts, and
light-table tiles. While they decode, the photo on screen keeps the cores.
Export All's decodes (`processFileWithSettings` and the decode-ahead
`prepare`) run at `'user'` priority, uncapped.

What each target runs today (the vendored deterministic build
`1.6.0-deterministic.45b40c0`, #302; the native gate still off):

| target | isolated | SharedArrayBuffer | RAW decoder |
|---|---|---|---|
| Chrome, Vite dev/preview (and the production site, same headers) | yes | yes | the threaded build, `new LibRaw({ threads })`: min(cores, 8), 2 in a background lane |
| macOS desktop (WKWebView, `tauri://localhost`) | the flag says yes | **no** | `new LibRaw()` (the same build's single-threaded module); native LibRaw once the gate names this build (below) |
| Windows WebView2, Linux WebKitGTK | not checked | not checked | `new LibRaw()` (or threaded, if they turn out to share memory); native is not built on Windows and not verified on Linux |

## Output

- **Thread counts and builds.** LibRaw's parallel regions write disjoint
  pixels except in the X-Trans demosaic, its X-Trans half-size copy and the
  DHT demosaic; both the native decoder and libraw-wasm's threaded build
  develop those on one thread. Native RGB16 at 1, 4 and 8 threads equals the
  deterministic libraw-wasm build's, single-threaded and threaded, on every
  fixture (three toolchains; `docs/native-raw-decode.md`).
- **The one flagged change.** The deterministic libraw-wasm (#264 part B:
  no `-ffast-math`, `-ffp-contract=off`, musl's libm functions bundled) decodes
  differently from 1.6.0, whose `-ffast-math` both made its output depend on
  the toolchain and turned samples at the auto-bright white point black for
  about one white point in seven. It reached the app with #302 (the
  vendored build), flagged in that release's notes. RGB16 against 1.6.0 (the
  app's settings, 16 bits):

  | file | size | differing samples | differing pixels | max difference |
  |---|---|---|---|---|
  | `_DSC3111.NEF` (Nikon Z f, 10.7 MP) | full | 13,949 of 32,064,000 | 12,159 | 1,656 |
  | `_DSC3111.NEF` | half | 2,633 of 8,016,000 | 2,633 | 17 |
  | `_DSC5290.dng` (Sony ILCE-7M2, 24 MP) | full | 2,152 of 73,011,456 | 769 | 8,155 |
  | `_DSC5290.dng` | half | 114 of 18,252,864 | 114 | 65,535 (1.6.0's black white-point samples) |
  | `L1009967.dng` (Leica M11, 60.4 MP) | full | 14,619 of 181,260,288 | 5,013 | 1,723 |

  The M11 row was measured in Node through the real dist files (#302): the
  vendored build's single-threaded module and its threaded module at 1, 4
  and 8 threads give one RGB16 hash (`be64623a95441caa…`).

## Gates

| gate | what it holds | how to run |
|---|---|---|
| `src-tauri/native/wasm-parity-hashes.json` | per fixture: RGB16 SHA-256 of 1.6.0 and of the deterministic build, full and half size; the metadata the page reads; the HE-compressed NEFs' embedded-JPEG result at 1703835 | the reference for both gates below |
| native parity (`src-tauri/src/native_raw/parity_tests.rs`) | native RGB16 at 1, 4 and 8 threads equals the deterministic build's hashes; the plane equals `packRGBToImage16(dcraw_make_mem_image())`; the metadata; the HE NEFs fail in `unpack` | `npm run test:rust` (uses the fixtures at the worktree root when present) |
| WASM RGB16 gate (`scripts/raw-decode-gate-smoke.mjs`) | the libraw-wasm the page runs decodes each file to its build's hashes: `new LibRaw()`, the threaded build at 1, 2, 4 and 8 threads, and both on a page without isolation; the HE NEFs yield no image on any build and the loader returns their 1703835 embedded JPEG | `RAW_DECODE_GATE_FILES='["/abs/a.NEF", …]' npm run test:smoke -- --raw-decode-gate-only` |
| loader parity (`--raw-parity-only`) | the loader's planes (after the defect pass) against a recording from 1703835 | `RAW_PARITY_FILES=… RAW_PARITY_EXPECTED=/abs/hashes.json` (record with `RAW_PARITY_RECORD=1`) |
| `scripts/check-pinned-versions.mjs` (`npm test`) | `libraw-wasm` is declared exactly and installed as `LIBRAW_WASM_VERSION`, the release the native gate names | `npm test` |

**A local libraw-wasm build (tests only).** `LIBRAW_WASM_DIST=/abs/dist`
makes the Vite dev server resolve `libraw-wasm` to that directory (a built
package's `dist/`), so every smoke step, the gate above all, runs against an
unreleased decoder. `vite build` and `vite preview` ignore it, and `npm test`
always uses the installed package.

## The vendored deterministic build (#302)

Upstream has not released ybouane/LibRaw-Wasm#30, so the app builds it
itself: `scripts/build-libraw-wasm.sh` vendors the PR's head (commit
`45b40c0`) as `negative2positive/vendor/libraw-wasm`, which `package.json`
depends on as `file:negative2positive/vendor/libraw-wasm`
(`negative2positive/vendor/libraw-wasm/README.md`). Of the steps a release
of the deterministic build needs:

1. Pin it: done. `LIBRAW_WASM_VERSION = '1.6.0-deterministic.45b40c0'`;
   `check-pinned-versions` reads a `file:` dependency's version from its
   own `package.json` and the lockfile's link.
2. The WASM gate on the fixtures: passed. Every fixture decodes to the
   deterministic hashes recorded here, single-threaded and threaded at 1,
   2, 4 and 8 threads, isolated and not; the HE NEFs yield no image.
3. The M11 DNGs: `L1009967.dng` decodes deterministically at every thread
   count (the table above). Its gate entry (`RAW_DECODE_GATE_RECORD=1`,
   with the half-size decode and the metadata) is still to be recorded.
4. `npm run test:rust` with the fixtures, the M11 DNG among them, on each
   desktop platform; then set `NATIVE_RAW_PARITY.librawWasm =
   '1.6.0-deterministic.45b40c0'`. macOS (arm64 and x86_64) then decodes
   natively. Still to do: the native build needs several GB of free disk.
5. The output change is flagged in the release notes of #302's release.

On an isolated web page the threaded build runs at once: the page needs
no change. When upstream publishes #30, compare its `dist/` with the
vendored `BUILD-INFO.txt` and go back to the npm package (the vendored
README has the steps).

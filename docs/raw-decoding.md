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
| a page with shared memory (`crossOriginIsolated` **and** `SharedArrayBuffer`) and a libraw-wasm that ships the threaded build (`LibRaw.features.threads`; **not 1.6.0**) | libraw-wasm's threaded build, `new LibRaw({ threads })` | min(cores, 8); 2 for a background lane | an instance that does not start (its worker, pthread pool or 4 GB shared memory; `runtimeInfo()` rejects or does not answer in 8 s) decodes on `new LibRaw()` instead, before any bytes are handed over, and the page stops asking for threads |
| everywhere else | `new LibRaw()`, exactly as before #264 | 1 | as before |

After LibRaw, whichever ran: no image (the HE-compressed NEFs) or a decode
timeout gives the embedded JPEG (8 bits), and un-demosaiced output the same;
a post-decode worker that dies holding the pixels too.

One flag caps a background lane on either decoder: `loadFileToImageData`'s
`priority: 'background'` (roll analysis, Export All, warm switching). The
photo on screen keeps the cores.

What each target runs today (libraw-wasm 1.6.0 pinned, the native gate off):

| target | isolated | SharedArrayBuffer | RAW decoder |
|---|---|---|---|
| Chrome, Vite dev/preview (and the production site, same headers) | yes | yes | `new LibRaw()` (1.6.0 has no threaded build); the threaded build once a release ships it |
| macOS desktop (WKWebView, `tauri://localhost`) | the flag says yes | **no** | `new LibRaw()`; native LibRaw once the gate names the pinned release |
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
  about one white point in seven. It reaches the app only when a release
  with it is pinned; until then every path decodes exactly as 1.6.0 did.
  RGB16 against 1.6.0 (the app's settings, 16 bits):

  | file | size | differing samples | differing pixels | max difference |
  |---|---|---|---|---|
  | `_DSC3111.NEF` (Nikon Z f, 10.7 MP) | full | 13,949 of 32,064,000 | 12,159 | 1,656 |
  | `_DSC3111.NEF` | half | 2,633 of 8,016,000 | 2,633 | 17 |
  | `_DSC5290.dng` (Sony ILCE-7M2, 24 MP) | full | 2,152 of 73,011,456 | 769 | 8,155 |
  | `_DSC5290.dng` | half | 114 of 18,252,864 | 114 | 65,535 (1.6.0's black white-point samples) |

  The 60 MP M11 DNGs (`L1009967.dng`, the 2026-09-23 roll) are still to be
  measured, on a machine that may decode them.

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

## When the deterministic libraw-wasm is released

1. Pin it: `libraw-wasm` `X.Y.Z` exactly in `package.json` (and the lock);
   `LIBRAW_WASM_VERSION = 'X.Y.Z'` in `nativeRawDecoder.js`
   (`check-pinned-versions` enforces all three).
2. Run the WASM gate on the fixtures. It compares against the deterministic
   hashes because the release advertises `LibRaw.features.threads`. If the
   published build decodes differently from the one recorded here (built
   with other flags or another toolchain), stop: record its hashes, then
   re-run the native parity tests against them.
3. Add the M11 DNGs and `L1009967.dng` to the gate on a machine that may
   decode 60 MP files, and record them.
4. `npm run test:rust` with the fixtures on each desktop platform; then set
   `NATIVE_RAW_PARITY.librawWasm = 'X.Y.Z'`. macOS (arm64 and x86_64)
   then decodes natively.
5. Flag the output change in the release notes with the table above.

On an isolated web page the threaded build then runs at once: the page
needs no change.

# Cross-origin isolation (#264 Part A)

The app is served with the pair that makes a page and its workers
`crossOriginIsolated`:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

One source, `scripts/cross-origin-isolation.mjs`, feeds the Vite dev and
preview servers (`negative2positive/vite.config.js`; `tauri dev` loads the dev
server). The catch-all rule of both `vercel.json` files and
`app.security.headers` in `src-tauri/tauri.conf.json` carry the same pair, and
`scripts/check-vercel-config.mjs` and `scripts/check-tauri-config.mjs` (in
`npm test`) hold them to it. The pair goes on every response: dedicated worker
scripts need COEP on their own responses.

`require-corp`, not `credentialless`: WebKit (WKWebView, WebKitGTK, Safari)
does not implement `credentialless`.

## What isolation turns on

Everything below is decided at runtime from `sharedMemoryAvailable()`:
`crossOriginIsolated` **and** a `SharedArrayBuffer` constructor (macOS
WKWebView has the first without the second). A page or webview without both
keeps the copy path it always had, with the same pixels.

- **Shared 16-bit planes** (`src/app/crossOriginIsolation.js`). The editor's
  decodes (`sharedPlanes: true`: the photo that is opened, its two-stage full
  decode, and the background lanes' decodes that the editor adopts,
  prefetches or analyses) build their RGBA16 plane in a `SharedArrayBuffer`
  where the plane is built: RAW files in the post-decode worker, 16-bit TIFF
  and PNG scans in the scan decode worker. The geometry pool builds the
  working frame of such a base in shared memory too; its bands read the base
  through views and write their rows of the frame in place, and a display
  proxy fill's bands (#249) read it through views as well, so a fill copies
  nothing on the main thread (a roll frame's planes from its worker stay
  plain and are copied, `docs/photo-sessions.md`). The display
  level (#248) of a shared frame is shared as well, built where it is
  assembled (the geometry pool or `buildDisplayLevel*`), so the preview
  conversion posts it without a copy. Batch-export and
  pass decodes stay plain: they hand their planes over by transfer (#250,
  #256).
  - The conversion clients post the shared plane itself: no copy, no
    transfer list (a `SharedArrayBuffer` in a transfer list throws). A
    full-resolution conversion of the open photo therefore posts in well
    under a millisecond and its worker reads a view, not a second copy.
  - The conversion band pool (#256): the bands of a shared source copy their
    own rows into the pool's plane in their workers; nothing is copied into
    shared memory on the main thread. The pool's own shared planes (#256
    turned them on wherever the page is isolated) first ran in a browser
    here: an 8-bit Step 3 on bands sent now read zeros and exported black
    frames until the band adjusted the 8-bit rows it was sent
    (`docs/batch-export-pipeline.md`).
  - The auto-frame and film-edge worker and the dust worker receive the
    shared plane and, where the frame's 8-bit plane is by construction that
    plane `>>> 8` (a fresh decode and its geometry frames, marked with
    `markDerivedEightBit`), derive the 8-bit bytes themselves (`derive8`)
    instead of receiving a copy. The dust worker gets the plane whole instead
    of in 32 MB slices.
  - **Write-once rule.** Before a plane is published exactly one thread
    writes it (row bands of one job count as one writer); afterwards nobody
    does, and no worker posts a shared plane back to the page (the #258
    ledger counts each `SharedArrayBuffer` once, by object). A post-decode
    worker that fails while repairing a shared plane loses it (the loader
    takes its embedded-preview path), as a lost transfer does.
  - **The guard.** In dev (every smoke run), `?debug=1` and `?planeGuard=1`,
    every shared plane posted to a worker is hashed before and after the job;
    a change is logged, recorded in `window.__ncIsolation.planeGuard()` and
    fails the smoke run. A plane of up to 4 MB is hashed whole; a larger
    one by a sample of about 4 MB (every n-th 4 KB page and the last), which
    any write spanning n pages changes (at 4 MP, two rows): a whole 4 MP plane
    takes ~50 ms to hash on the page thread, which slowed a rotate click past
    the geometry smoke's 100 ms. `?planeGuard=1` hashes every byte of every
    plane (the isolation smoke step runs with it); `?planeGuard=0` turns the
    guard off.
  - `?sharedPlanes=0` keeps the copy path on an isolated page.
- **ONNX Runtime threads** (`src/app/inferenceRuntime.js`): min(4, cores - 2)
  in an isolated worker, one elsewhere and on the main thread. MI-GAN (AI
  repair) uses them; EfficientViT (semantic colour) stays on one thread
  because its logits depend on the thread count (see below).
- **A threaded LibRaw build** (`src/app/librawRuntime.js`, #264 Part D), once
  libraw-wasm ships one (`LibRaw.features.threads`): `new LibRaw({ threads })`
  only where shared memory is available (min(cores, 8) in the foreground, 2
  in a background lane); everywhere else, and with libraw-wasm 1.6.0,
  `new LibRaw()` exactly as before. An instance that does not start (its
  worker, pool or shared memory; no answer in 8 s) decodes on `new LibRaw()`
  instead and the page stops asking for threads. Its report entry comes from
  inside the LibRaw worker (`runtimeInfo()`: isolation, threads, pool size).
  Its pthread workers share that worker's memory, so a pool that starts at
  all is isolated; `ISOLATION_CDP_WORKERS=1` also reads each of them over
  CDP. How this and the desktop's native decoder are chosen:
  `docs/raw-decoding.md`.

## Third-party loads under COEP

| load | why it keeps working |
|---|---|
| lensfun (bundled, `lensfunLoader.js`) | same origin |
| lensfun web fallback, jsDelivr | loaded in CORS mode (`crossOrigin = 'anonymous'`, the core module loaded by the app before the IIFE); jsDelivr sends `Access-Control-Allow-Origin: *` and `Cross-Origin-Resource-Policy: cross-origin` |
| GitHub star count (`api.github.com`) | CORS `fetch`, `Access-Control-Allow-Origin: *` (the smoke's isolation step checks it renders, unless offline or rate limited) |
| update manifest (`download.neoanaloglab.com`, the only host that serves it; the site has no copy), in the app and on `download.html` | CORS `fetch`, `Access-Control-Allow-Origin: *` (`scripts/check-updater-manifest.mjs` holds the app to the URL the release workflows publish) |
| the static SEO pages (`guide.html` and the others) | no cross-origin subresources: only links, canonical/alternate `<link>`s and metadata |
| feedback form (`/api/feedback/`) | web: same origin; desktop: CORS `fetch` to `https://negative-converter.tokugai.com/api/feedback/`, the API reflects the desktop origins. The trailing slash is needed: `trailingSlash: true` answers `/api/feedback` with a 308 without CORS headers, and the desktop's preflight fails on a redirect (`scripts/check-updater-manifest.mjs`) |
| Vercel Analytics | production loads the same-origin `/_vercel/insights/script.js`; not injected under `vite dev`, where it would load a cross-origin classic script without `crossorigin` |
| Tauri IPC (`ipc://localhost`, `http://ipc.localhost`) | CORS requests (the IPC answers with `Access-Control-Allow-Origin`) or the postMessage fallback |
| in-app updater | runs in Rust (tauri-plugin-updater), not in the webview |

COOP `same-origin` severs `window.opener`; the app's one `window.open` passes
`noopener`.

## Returning visitors: scripts cached before isolation

Until the release that turns the pair on, the site served `/assets/` with
`Cache-Control: public, max-age=31536000, immutable` and without COEP. A
browser that cached a script then reuses its copy without asking, and an
isolated page refuses a dedicated worker whose own response lacks COEP (the
embedder-policy check of the HTML standard's worker fetch). Scripts whose
content did not change keep their content-hash names, so without a rename a
returning visitor's LibRaw worker would never start (every RAW file opening
as its 8-bit embedded JPEG after the 30 s open timeout), nor would ONNX
Runtime's pthreads or any app worker whose code did not change. Fresh
profiles (the smoke run, `scripts/isolation-preview-check.mjs`) cannot see
it (#229 review R2-041, R2-046).

- **Every script gets a new name.** The page build and the worker bundles
  name every script `[name]-[hash]-coi.js` (`isolatedOutputNames()` in
  `scripts/cross-origin-isolation.mjs`, used by `vite.config.js`). Binary
  assets (wasm, the lensfun data, fonts) keep their names: they are fetched
  from the same origin, where COEP asks nothing of them, so returning
  visitors keep those cached copies. The desktop bundle (relative base
  `./`, assets embedded) is not affected either way. Measured on this
  release's build (2026-10-02, Vite 8.2.2): without the suffix, 13 of its
  47 scripts carry a 1703835 name again, libraw-wasm's worker
  (`worker-BpdlSnKn.js`) and both ONNX Runtime bundles its pthreads start
  from among them; with it, none (`opencv-glue-<sha>.js`, named by its
  plugin, is new in this release).
- **The check.** `scripts/check-dist-asset-names.mjs` fails when a build's
  `assets/` holds a script name that production served at 1703835, the last
  release without COEP (34 scripts, read from the site), or when a worker
  script served from outside `assets/` is byte-identical to 1703835's (next
  point). `npm test` runs its self-test; CI (`desktop-ci.yml`) runs it on the
  build after `npm run build:web`.
- **Outside `/assets/`.** Other files are revalidated (`max-age=0`), but
  Vercel answers a revalidation with a 304 that carries none of
  `vercel.json`'s headers (checked on the production site), so a browser
  keeps the headers it cached a file with for as long as the file does not
  change. The one worker script there, `public/codecs/heif-worker.js` (HEIC
  decode), changed in this release (#264's isolation probe), so returning
  browsers fetch it whole, with COEP. The pages change with every build
  (their script names).
- **If a LibRaw worker fails anyway** (its script refused, or an error
  escaping it), the decode fails at once instead of after the 30 s open
  timeout: `librawRuntime.js` watches the worker's `error` event, disposes
  the instance and rejects its calls with the loader's timeout code, so the
  embedded JPEG opens without the wait (`docs/raw-decoding.md`). The
  isolation report's LibRaw entry fetches the worker script through the HTTP
  cache, as the worker load does, so a cached copy without COEP reads as not
  isolated (`cache: 'no-store'` reported it isolated).
- **Checked in Chrome 154** (headless, 2026-10-02; a local server with
  Vercel's `/assets/` caching, libraw-wasm 1.6.0 and `librawRuntime.js`):
  LibRaw's worker script, cached by a page without COEP, is refused when an
  isolated page on the same origin and profile starts it (DevTools issue
  `CoepFrameResourceNeedsCoepHeader`), with no request to the server.
  `new LibRaw().open()` then never settles; the app's watched instance
  rejects in 2 ms, and the report's entry reads not isolated. The same
  files under a URL the profile never fetched start and answer.

## Per platform

| target | isolated | SharedArrayBuffer | how it was checked |
|---|---|---|---|
| Chrome, Vite dev server | yes: page and every worker | yes | `npm run test:smoke -- --isolation-only` (2026-09-30, Chrome 154, M1 Pro; since the integration with #264 Part C, 15 worker scripts including the native plane transfer worker; 18 once #252's roll-frame and detection-helper workers and #249's display-proxy worker joined, same day) |
| Chrome, Vite preview (production build) | yes: page and every worker | yes | `scripts/isolation-preview-check.mjs` (same day): a LibRaw decode and a 16-bit PNG export on the built bundle; built with #264 Part B's threaded libraw-wasm, its pthread pool starts from the bundled chunks (8 threads, pool 7), and MI-GAN repairs dust with 4 ONNX Runtime threads |
| production web (Vercel) | expected as the preview (same headers) | expected | not deployed from this branch |
| macOS WKWebView (`tauri://localhost`) | page, module and classic workers report `crossOriginIsolated === true`; blob: workers do not | **no** | the desktop log line of a debug build with embedded assets (`cargo build --features tauri/custom-protocol`), 2026-09-30, macOS 27 |
| Windows WebView2 (`http://tauri.localhost`) | not checked (no Windows machine) | | the desktop log line |
| Linux WebKitGTK | not checked (no Linux machine) | | the desktop log line |

macOS WKWebView honours the headers for `crossOriginIsolated` but does not
expose `SharedArrayBuffer` to the custom-scheme app webview (Safari exposes it
only in the WebContent processes it launches for isolated pages). Every
consumer therefore gates on `sharedMemoryAvailable()` (isolated **and** a
`SharedArrayBuffer` constructor), not on the flag alone: the macOS desktop app
runs the copy path, single-threaded ONNX Runtime and the single-threaded
LibRaw build, with no errors, and gets its decode speed from native LibRaw
(#264 Part C) instead.

How to check a platform: the desktop app writes one line to its terminal log
about 15 s after launch, e.g. (macOS)

```
[webview] isolation page=1 sab=0 secure=1 workers: geometry=1/0 heif=1/0 blob=0/0
```

(each worker reads `crossOriginIsolated/SharedArrayBuffer`; with `?debug=1`,
every worker and LibRaw). In a browser, `await window.__ncIsolation.report()`
lists every worker. A target without shared memory runs the copy path and
single-threaded ORT and LibRaw with no errors.

## Measurements (M1 Pro, Chrome 154, CPU WASM)

ONNX Runtime, one realm per thread count (`inferenceThreads.harness.mjs`):

| model | 1 thread | 2 threads | 4 threads | output |
|---|---|---|---|---|
| MI-GAN, one 512 px tile | 1085-1136 ms | 594-755 ms | 380-580 ms | identical at 2 and 4 threads (0 of 786432 samples differ) |
| EfficientViT-B1, 512 px | 248-281 ms | 173-225 ms | 134-195 ms | identical at 2 threads; at 4, 512879 of 614400 logits differ (at most 4.1e-6), label maps equal |

The semantic map's labels and confidence go into the recipe and the white
balance, so EfficientViT keeps one thread and no export depends on the
thread count. MI-GAN's per-tile memo (#246) needs no thread count in its key.

LibRaw through the app's loader (`loadRawFile`, 16-bit full size, median of
3; other agents loading the machine), with libraw-wasm 1.6.0 and with the
threaded build of #264 Part B on the isolated page (8 threads; its pool
starts in 31-62 ms per decode):

| file | 1.6.0, one thread | threaded build, 8 threads |
|---|---|---|
| `_DSC3111.NEF` (10.7 MP) | 1256 ms | 865 ms |
| `_DSC5290.dng` (24.3 MP) | 2502 ms | 2224 ms (1796-2622) |

With the threaded build the isolation smoke step decodes its generated DNG
three times on the isolated page (8 threads) and once on a page without
isolation (the single-threaded build): the same RGBA16 and 8-bit planes and
metadata every time, and the same 8- and 16-bit PNG exports, in 4 of 4 runs.
One earlier run (12:31, before the decode probe existed) exported a
different PNG on the isolated page; it did not recur and its cause is not
known.

Page-thread copies during a fresh import, from file selection until the
photo settles (`ISOLATION_IMPORT_PROFILE`, the isolation smoke step's copy
log: every slice / postMessage clone / structuredClone of 1 MB or more;
two runs each, load average 11-21):

| file | shared planes | copy path (`?sharedPlanes=0`) |
|---|---|---|
| `_DSC5290.dng` (24.3 MP) | 0.2-0.3 ms in all: the 1.9 MB analysis sample | 47-48 ms in all, longest 22-25 ms: the cropped frame's 107 MB 16-bit plane, the 93 MB 8-bit slice for auto-frame, the 46 MB display level |
| `_DSC3111.NEF` (10.7 MP) | 0.3-0.4 ms | 32-34 ms, longest 15 ms |

The analysis sample is capped at 250 000 pixels, so a 60 MP import should
stay far inside #264's budget (no copy over 10 ms, 20 ms in all); that run
(M11 files) is still to be made: `ISOLATION_IMPORT_PROFILE=/abs/L1000618.DNG
node scripts/smoke-test.mjs --isolation-only`.

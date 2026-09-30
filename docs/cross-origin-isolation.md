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

Everything below is decided at runtime from `crossOriginIsolated`; a page or
webview that is not isolated keeps the copy path it always had, with the same
pixels.

- **Shared 16-bit planes** (`src/app/crossOriginIsolation.js`). The editor's
  decodes (`sharedPlanes: true`: the photo that is opened, its two-stage full
  decode, and the background lanes' decodes that the editor adopts,
  prefetches or analyses) build their RGBA16 plane in a `SharedArrayBuffer`
  where the plane is built: RAW files in the post-decode worker, 16-bit TIFF
  and PNG scans in the scan decode worker. The geometry pool builds the
  working frame of such a base in shared memory too; its bands read the base
  through views and write their rows of the frame in place. Batch-export and
  pass decodes stay plain: they hand their planes over by transfer (#250,
  #256).
  - The conversion clients post the shared plane itself: no copy, no
    transfer list (a `SharedArrayBuffer` in a transfer list throws). A
    full-resolution conversion of the open photo therefore posts in well
    under a millisecond and its worker reads a view, not a second copy.
  - The conversion band pool (#256): the bands of a shared source copy their
    own rows into the pool's plane in their workers; nothing is copied into
    shared memory on the main thread.
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
    fails the smoke run. Planes over 256 MB (about 32 MP) are hashed only with
    `?planeGuard=1`; `?planeGuard=0` turns it off.
  - `?sharedPlanes=0` keeps the copy path on an isolated page.
- **ONNX Runtime threads** (`src/app/inferenceRuntime.js`): min(4, cores - 2)
  in an isolated worker, one elsewhere and on the main thread. MI-GAN (AI
  repair) uses them; EfficientViT (semantic colour) stays on one thread
  because its logits depend on the thread count (see below).
- **A threaded LibRaw build** (`src/app/librawRuntime.js`, #264 Part D), once
  libraw-wasm ships one: threads only on an isolated page.

## Third-party loads under COEP

| load | why it keeps working |
|---|---|
| lensfun (bundled, `lensfunLoader.js`) | same origin |
| lensfun web fallback, jsDelivr | loaded in CORS mode (`crossOrigin = 'anonymous'`, the core module loaded by the app before the IIFE); jsDelivr sends `Access-Control-Allow-Origin: *` and `Cross-Origin-Resource-Policy: cross-origin` |
| GitHub star count (`api.github.com`) | CORS `fetch`, `Access-Control-Allow-Origin: *` |
| update manifest (`download.neoanaloglab.com`, the site) | CORS `fetch`, `Access-Control-Allow-Origin: *` |
| feedback form | web: same origin; desktop: CORS `fetch`, the API reflects the desktop origins |
| Vercel Analytics | production loads the same-origin `/_vercel/insights/script.js`; not injected under `vite dev`, where it would load a cross-origin classic script without `crossorigin` |
| Tauri IPC (`ipc://localhost`, `http://ipc.localhost`) | CORS requests (the IPC answers with `Access-Control-Allow-Origin`) or the postMessage fallback |
| in-app updater | runs in Rust (tauri-plugin-updater), not in the webview |

COOP `same-origin` severs `window.opener`; the app's one `window.open` passes
`noopener`.

## Per platform

| target | isolated | how it was checked |
|---|---|---|
| Chrome, Vite dev server | yes: page and every worker, ORT pthreads included | `npm run test:smoke -- --isolation-only` (2026-09-30, Chrome 154) |
| Chrome, Vite preview / production build | see below | `scripts/isolation-preview-check.mjs` |
| macOS WKWebView (`tauri://localhost`) | see below | the desktop log line |
| Windows WebView2 (`http://tauri.localhost`) | not checked (no Windows machine) | the desktop log line |
| Linux WebKitGTK | not checked (no Linux machine) | the desktop log line |

How to check a platform: the desktop app writes one line to its terminal log
about 15 s after launch, e.g.

```
[webview] isolation page=1 sab=1 secure=1 workers: geometry=1 heif=1 blob=1
```

(with `?debug=1`, every worker and LibRaw). In a browser,
`await window.__ncIsolation.report()` lists every worker. A target where
`page=0` runs the copy path and single-threaded ORT with no errors.

## Measurements (M1 Pro, Chrome 154, CPU WASM)

ONNX Runtime, one realm per thread count (`inferenceThreads.harness.mjs`):

| model | 1 thread | 4 threads | output |
|---|---|---|---|
| MI-GAN, one 512 px tile | 1112-1136 ms | 506-546 ms | identical (0 of 786432 samples differ) |
| EfficientViT-B1, 512 px | 260-272 ms | 145-153 ms | 512879 of 614400 logits differ, at most 4.1e-6; label maps equal |

The semantic map's labels and confidence go into the recipe and the white
balance, so EfficientViT keeps one thread and no export depends on the
thread count. MI-GAN's per-tile memo (#246) needs no thread count in its key.

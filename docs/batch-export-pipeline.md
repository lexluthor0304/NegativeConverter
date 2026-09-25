# Batch export and roll analysis pipeline

## Current architecture (updated 2026-09-25)

Batch export used to run one file at a time: decode → geometry → convert →
adjust → encode → write, each stage awaited before the next file started. The
conversion worker sat idle while the main thread decoded, and the RAW decoder
(the dominant cost) never overlapped with anything.

Now one driver (`runBatchExport` in `main.js`) runs the per-file pipeline
(`processFileWithSettings`) for several files at once through
`batchExportScheduler.js`:

- `planBatchParallelism` chooses the lane count from cores, reported memory
  and the largest decoded image dimensions: 18 MP frames run four wide,
  24 MP three wide, 36 MP two wide, ≥45 MP sequential; devices reporting
  ≤4 GB get about a third of the pixel budget. `imageDimensions.js` reuses
  known decoded dimensions or reads at most 256 KiB of PNG/JPEG/TIFF-family
  headers per file. RAW preview IFD dimensions are not accepted as sensor
  dimensions. Unknown formats/sizes use a conservative 150 MP estimate.
  Compressed file size is no longer a memory estimate. `localStorage
  nc_batch_lanes_v1` (1–4) supplies a lane ceiling for support and benchmarking;
  core and memory limits still apply.
- `runBatchPipeline` keeps `lanes` files in flight and hands the encoded
  results to the sink strictly in the original order, so ZIP entries, folder
  writes and downloads keep the roll's sequence. A failed file marks only
  itself. Processing files plus completed, unwritten payloads count toward
  the same lane budget: a lane is released only after its own sink finishes.
  A slow first file therefore cannot cause the rest of a roll's encoded
  outputs to accumulate. An `AbortSignal` stops further files; in-flight ones
  finish and are written. An optional `beforeStart` hook (the hidden-window
  gate, `docs/hidden-window-jobs.md`) is awaited before a lane claims its next
  index and released after that index's sink, so a lane held back while the
  window is hidden never blocks the in-order sink.
- Each batch owns a pool of conversion workers
  (`createConversionWorkerPool`, kept alive across frames instead of
  restarting per file) and a pool of export workers (`createExportWorkerPool`,
  one per lane, a single lane included) for the adjustment and encode stages.
  Both are released when the batch ends, so a one-lane batch (every frame
  over 40 MP) no longer leaves its export worker, and its dead planes, in
  the module-level bridge (#250). The on-device AI repair session is shared,
  so lanes take turns with it (`withAiRepairTurn`). Lanes look tiles up in
  the session's tile memo but never insert (`memoInsert: false`), so a roll
  export does not evict the open photo's tiles (#246).
- The geometry chain (base → rotation → mirror → crop) runs in one pass that
  only builds the cropped window, for right angles and mirror-only geometry
  too, bit-identical to the step chain (`planGeometry` + `renderGeometryRows`
  in `imageGeometry.js`). It runs in the shared geometry worker pool
  (`geometryPool.js`, 4–6 row bands), so lanes no longer queue on the main
  thread for this step; only 8-bit sources at a non-right angle keep the
  canvas rotation there. Each lane's bands in flight come from
  `planGeometryBandsInFlight` (a transient band budget shared by the lanes).
  A lane that ran the import frame detection adopts the auto-frame worker's
  rotated frame instead of rotating again. See `docs/geometry-chain.md`.
- The three sinks are thin adapters: streaming ZIP (browser), individual
  downloads (browser) and folder writes (desktop). The dead JSZip desktop ZIP
  path was removed. The desktop batch now also gets 16-bit output and the
  analog metadata, which only the browser paths had before.
- ZIP computes CRC while writing each payload once, then writes a standard
  ZIP32/ZIP64 data descriptor. CRC/write work uses bounded chunks and yields
  periodically so input and progress tasks can run. The CRC is slice-by-8
  (`workers/crc32.js`, eight bytes per step, identical values; shared with
  the PNG chunk CRCs). Opaque PNG16/TIFF files store RGB; real transparency
  remains RGBA. PNG16 uses lossless Sub filtering.
- PNG16 is encoded in row bands (#257, `workers/png16Bands.js`). The rows
  are split into bands of about 16 MiB of filtered bytes (whole rows; 22
  bands at 60 MP, 9 at 24 MP). The layout depends only on width, height and
  channel count, so the file is byte-identical whoever encodes the bands.
  Each band is Sub-filtered in 4 MiB steps into a raw `pako.Deflate` stream
  (level 6) with a running Adler-32 and ends with a sync flush (the last
  band finishes the stream); it becomes its own IDAT chunk, built as a Blob
  in the worker. Band 0 carries the zlib header, and a last 4-byte IDAT
  holds the Adler-32, folded from the bands with `adler32Combine`. Decoded
  samples are those of the old one-shot encoder; the compressed bytes and
  size differ slightly (a few bytes per band), so a PNG16 parity check
  compares decoded samples, not file hashes.
  - `createPng16BandPool` (`workerBridge.js`) runs the bands on export
    workers: one pool per export operation (a single export or a batch),
    disposed when it ends. Bands wait in one ordered queue and are sliced
    from the frame only when a worker takes them, so at most W band copies
    exist. Each band has a timeout from its own pixel count, counted from
    dispatch. A failed or timed-out band, or a cancel, terminates every
    worker still busy with that frame.
  - W (`planPng16BandWorkers`): cores − 2 for a single export or a
    one-lane batch, 4 for two lanes. With three or more lanes there is no
    pool: the lane's export worker encodes the bands one after another
    (`workerEncodePng16`), which gives the same bytes.
  - Fallbacks: pool → one export worker → the main thread
    (`exportImageEncoders.js`), all with the same bytes.
  - `localStorage nc_png16_rle_v1 = on` switches to the run-length strategy
    (lossless, about 4 % larger, several times faster). It has no UI and is
    off by default; it is for measuring WKWebView if level 6 misses its
    budget there.
- The linear DNG kernel is two table lookups per sample (#257): a Float32
  table per channel of the linear value for each 16-bit code (exactly the
  value the old per-pixel Float32 buffer held), the gain percentile from the
  same strided samples, and a Uint16 output table. On a little-endian host
  the strip is a view of the output, not a copy. A single export builds it
  synchronously behind the overlay. A batch builds it with
  `buildLinearPositiveAsync`: one task per channel percentile, then the
  output pass in slices of about 16 ms with a MessageChannel task in
  between, because the desktop batch keeps the editor live. The final
  `new Blob` still copies the strip in one call; its duration is in the
  `linearDngBatch` perf trace (`blobMs`, `?debug=1`). If it exceeds 50 ms in
  the macOS app, the batch build should move into the lane's export worker,
  which can take the batch-owned source plane by transfer.
- Desktop writes (`desktopExportWriter.js`) send 8 MiB chunks
  (`EXPORT_CHUNK_BYTES`, equal to `CHUNK_LIMIT` in `export_stream.rs`; a
  test reads the Rust constant). Exactly one `append_export_chunk` is in
  flight while the next Blob slice is read. The native stream stays strictly
  sequential and checks the total in `finish`. Each stream has its own lock,
  so the stream map is not held during a disk write. `onProgress` reports
  written bytes, and a signal aborts after the in-flight append: the staging
  file is removed and any existing target is kept. A single desktop export
  keeps its overlay up with "Saving… x / y MB" until `finish_export_write`
  resolves, then toasts the saved file name. Its Cancel button appears once
  the encode starts. The desktop batch sink still awaits each write while
  its lane is held (#256 overlaps the write with the next frame).
- Hot-folder reads use 8 MiB chunks (`IMPORT_CHUNK_BYTES` = the Rust
  `IMPORT_CHUNK_LIMIT`, pinned by a test). `read_import_file` is an async
  command whose read runs on the blocking pool, not on the native main
  thread, and it still checks scope, symlinks and the fingerprint on every
  chunk.
- PNG16 and scanner TIFF decode run in disposable workers with transferred
  input/output planes. The existing decoder is the fallback when a worker
  cannot start. RAW demosaic remains in LibRaw's dedicated worker.
- Everything after LibRaw's result (RGB16 → RGBA16 packing, the garbled
  check, the sensor-defect pass, the 8-bit mirror) runs in a disposable
  post-decode worker that each RAW decode owns (`rawPostDecodeClient.js`,
  `rawPostDecode.js`, #232), spawned before `raw.open()` and terminated on
  every exit. Lanes therefore never queue behind each other's defect pass,
  and no lane decode adds main-thread packing or mirror work. Callers that
  will build default settings (`loadFileToImageData(file, { filmStats: true })`,
  used by `processFileWithSettings` without saved settings and by the roll
  lanes) also get the film-type and film-base statistics from that worker;
  `filmStatsCache.js` hands them to `createDefaultSettings`. The embedded
  JPEG preview is read from the source File only when a fallback needs it.
- Batch exports can be cancelled: the loading overlay's Cancel button
  (browser) and a Cancel button in the header progress strip (desktop).
- The adjustment stage runs in the export worker and its result is used: a
  16-bit result is viewed as `Uint16Array` and its 8-bit mirror is built in
  the worker (#240). Before, the bridge read the plane as bytes, `ImageData`
  rejected the doubled length, and every lane redid the 16-bit pass on the
  main thread, one after another.
- Planes stay with the workers (#250). `renderBatchExportFile` asks
  `processFileWithSettings` for the frame only up to `stage: 'processed'`
  (after dust, brush, auto WB and expired rescue) and runs adjust, sprocket
  frame and encode itself, so every plane of the frame belongs to it and
  moves to the next worker without a copy:
  - the 16-bit source goes to the conversion lane with a transfer list
    (`handoff`): the decoded base is lent and comes back with the result
    (it is read again for the analysis region, the brush mapping and
    expired rescue); a geometry or lens output is handed over and the
    adapter writes the result into it (`ownedSource`: no clone, the film
    base and flat field pass in place). 8-bit sources keep the clone;
  - every lane message sets `releaseAfter`, so the lane drops its pristine
    plane, source, analysis inputs and promotion after each frame
    (`releaseSlotBuffers`);
  - a 16-bit TIFF without the sprocket frame is one `adjust16AndEncode`
    request: only the Blob comes back. So is a 16-bit PNG when the batch has
    no PNG16 band pool (three or more lanes); with a pool the adjusted plane
    comes back by transfer and the pool encodes its bands (#257), the same
    bytes as the fused request;
  - otherwise the processed frame moves into the adjust stage (in place in
    the worker) and the adjusted frame into the encoder. PNG8 and JPEG are
    encoded in the export worker through `OffscreenCanvas` (`encodeImage`);
    the JPEG gain map (JPEG, gain map on, no sprocket frame) travels in the
    same request with the unadjusted plane, and only the map's JPEG comes
    back. The contact sheet and watch-folder imports never start a map.
  If a worker dies holding a plane (`ExportInputLostError`, or `INPUT_LOST`
  from the conversion lane), the frame is rendered once more from decode
  with copies, so the file never depends on the failure. The main-thread
  conversion fallback never sees a detached source.
- Nothing the frame allocated outlives it: the planes
  `processFileWithSettings` created (decode, geometry, conversion, repairs),
  the adjusted frame and the sprocket frame are stamped export-owned and
  released once the file is encoded (`releaseOwnedPlanes` in
  `app/planeRelease.js`: `transfer(0)` on WebKit, a throwaway worker on
  Chromium), instead of stacking under the next frame's decode until the
  next major GC. A plane that the editor, a photo session or history still
  references is never transferred or released. Single export does the same
  with a bridge of its own that it terminates when the export ends; the
  contact sheet and the watch folder release their full-resolution planes
  once the thumbnail exists.
- Batch frames run frame detection silently (`processFileWithSettings`
  `silent: true`): a never-analysed frame gets no blocking overlay and no
  frame wait, so a hidden window keeps exporting. Each job writes a marker so
  a killed export can be named at boot and resumed under the same names; see
  `docs/hidden-window-jobs.md`.

The automatic roll analysis after a multi-file import uses the same scheduler
and lane planning, with one auto-frame worker per lane
(`createAutoFrameWorkerPool`), and runs frame detection silently: it used to
show the blocking "Detecting the image area and tilt…" overlay for every file
in the background pass, covering the editor for minutes on a long roll.

The exact 900px geometry-applied roll samples now live in
`analysisSampleStore.js`, with a 128 MiB retained-RAM budget. Samples that do
not fit spill into a private, temporary IndexedDB database and remain available
to all analysis passes. `measurements` retains statistics and settings instead
of image planes; later analysis and thumbnail stages retrieve one sample at a
time without promoting disk reads into another cache. Completed samples and
the private database are released by the owning analysis in its cleanup path.
This prevents long rolls from first evicting samples into repeated RAW decodes
and then retaining the full sample set outside the cache's budget.

The cap applies to retained samples, not total renderer memory: active decode
lanes, currently consumed samples and IndexedDB implementation buffers are
additional. When IndexedDB is unavailable or its quota is exhausted, memory
stays bounded and missing samples can be rebuilt from their original files;
this fallback trades extra decode time for correctness. Abrupt process
termination may prevent deletion of a temporary database.

## Historical measurements (2026-09-16)

The following results used 12 × 18.5 MP Leica DNG files on an Apple M1 Pro in
Chrome with PNG 8-bit output. They describe the earlier concurrency change,
not a new benchmark of the 2026-09-22 implementation.

| | main | 2 lanes | 3 lanes | 4 lanes |
| --- | ---: | ---: | ---: | ---: |
| Export | 53.6 s (4.46 s/file) | 29.0 s | 22.6 s | 16.9 s (1.41 s/file) |
| Renderer RSS peak during export | ~1.2 GB | 2.7 GB | 2.8 GB | 3.7 GB |
| Background roll analysis | 170 s | 98 s | 82 s | 78 s |

Those runs used the same conversion and encoder, with unchanged output pixels.
Current lossless encoder and scheduler measurements are recorded in
[performance-audit-2026-09-22.md](performance-audit-2026-09-22.md).

The follow-up (branch `feat/roll-analysis-speed`) replaced the auto-frame
line search: `findWindowLineQuads` used `cv.HoughLinesP` over all 1800
directions of four channels (10–20 s per 18 MP frame); it now runs a
standard Hough restricted to ±15° around each axis and walks the edge pixels
of each strong line into segments (same thresholds, sub-pixel slopes), with
identical detections on the regression set. The fallback candidate builder
reuses its Hough bound for the repeated angle-0 pass, and the worker loads
OpenCV while the first photo decodes. Same 12 DNGs: first photo ready
28.8 s → 13.0 s, background roll analysis 170 s → 51.5 s (4 lanes).

In that historical run the dominant work was RAW decode (LibRaw, ~2.7 s per 18.5 MP DNG,
single-threaded WASM, one worker per lane), and in the auto-frame fallback
the per-angle candidate passes (`detectAxisAlignedCropRegion`, ~0.5 s each,
3–4 angles) plus the window search itself (~2.3 s for 8 restricted Hough
calls). Both could run across helper workers for the first photo; the
background lanes already saturate the cores. See `docs/auto-frame-regression.md`
before touching the detector. The 2026-09-22 audit additionally tracks exact
per-detection preprocessing reuse in GitHub issue #216; its validation status
is recorded in the current audit report.

## Verification

```bash
npm test            # includes batchExportScheduler, conversion pool, export pool, geometry chain
npm run test:smoke  # batch export scenario (ZIP fallback to individual downloads), roll import
npm run test:smoke -- --gain-map-only  # real-worker 16-bit result and gain map, gain-map requests per export intent
npm run test:smoke -- --png16-only     # PNG16 band pool in real workers: same bytes for 1/2/6 workers, one worker and the main thread
npm run test:smoke -- --export-ownership-only  # worker PNG8/JPEG parity, per-export workers, plane hand-off
node scripts/performance-io-benchmark.mjs /path/to/baseline
```

The historical benchmark harness that produced the Leica numbers above lives outside the
repo (headless Chrome + CDP, `?debug=1` for `[perf]` traces); it imports N
files through `#fileInput`, waits for every file's settings badge, then
clicks Export All and records per-stage timings, long tasks and RSS.
End-to-end roll and export measurements now come from the checked-in
`npm run bench:interactive` (S6 roll import, S9 export, memory in every
scenario; `docs/performance-benchmark.md`).

# Batch export and roll analysis pipeline

## Current architecture (updated 2026-09-22)

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
  finish and are written.
- Each batch owns a pool of conversion workers
  (`createConversionWorkerPool`, kept alive across frames instead of
  restarting per file) and, with more than one lane, a pool of export workers
  (`createExportWorkerPool`) for the adjustment and 16-bit encode stages.
  Both are released when the batch ends. The on-device AI repair session is
  shared, so lanes take turns with it (`withAiRepairTurn`).
- The geometry chain (base → rotation → mirror → crop) runs in one pass that
  only resamples the cropped window for 16-bit sources at non-right angles
  (`applyGeometryChainToImageData`, bit-identical to the step chain); every
  other case still runs the step chain so the result matches the interactive
  path exactly.
- The three sinks are thin adapters: streaming ZIP (browser), individual
  downloads (browser) and folder writes (desktop). The dead JSZip desktop ZIP
  path was removed. The desktop batch now also gets 16-bit output and the
  analog metadata, which only the browser paths had before.
- ZIP computes CRC while writing each payload once, then writes a standard
  ZIP32/ZIP64 data descriptor. CRC/write work uses bounded chunks and yields
  periodically so input and progress tasks can run. Opaque PNG16/TIFF files
  store RGB; real transparency remains RGBA. PNG16 uses lossless Sub filtering.
- PNG16 and scanner TIFF decode run in disposable workers with transferred
  input/output planes. The existing decoder is the fallback when a worker
  cannot start. RAW demosaic remains in LibRaw's dedicated worker.
- Batch exports can be cancelled: the loading overlay's Cancel button
  (browser) and a Cancel button in the header progress strip (desktop).

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
node scripts/performance-io-benchmark.mjs /path/to/baseline
```

The historical benchmark harness that produced the Leica numbers above lives outside the
repo (headless Chrome + CDP, `?debug=1` for `[perf]` traces); it imports N
files through `#fileInput`, waits for every file's settings badge, then
clicks Export All and records per-stage timings, long tasks and RSS.

# Batch export and roll analysis pipeline

## What changed (2026-09-16)

Batch export used to run one file at a time: decode → geometry → convert →
adjust → encode → write, each stage awaited before the next file started. The
conversion worker sat idle while the main thread decoded, and the RAW decoder
(the dominant cost) never overlapped with anything.

Now one driver (`runBatchExport` in `main.js`) runs the per-file pipeline
(`processFileWithSettings`) for several files at once through
`batchExportScheduler.js`:

- `planBatchParallelism` chooses the lane count from cores, reported memory
  and the largest file (estimated from file size): 18 MP frames run four wide,
  24 MP three wide, 36 MP two wide, ≥45 MP sequential; devices reporting
  ≤4 GB get about a third of the pixel budget. `localStorage
  nc_batch_lanes_v1` (1–4) pins the count for support and benchmarking.
- `runBatchPipeline` keeps `lanes` files in flight and hands the encoded
  results to the sink strictly in the original order, so ZIP entries, folder
  writes and downloads keep the roll's sequence. A failed file marks only
  itself. An `AbortSignal` stops further files; in-flight ones finish and are
  written.
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
- Batch exports can be cancelled: the loading overlay's Cancel button
  (browser) and a Cancel button in the header progress strip (desktop).

The automatic roll analysis after a multi-file import uses the same scheduler
and lane planning, with one auto-frame worker per lane
(`createAutoFrameWorkerPool`), and runs frame detection silently: it used to
show the blocking "Detecting the image area and tilt…" overlay for every file
in the background pass, covering the editor for minutes on a long roll.

## Measured (12 × 18.5 MP Leica DNG, Apple M1 Pro, Chrome, PNG 8-bit)

| | main | 2 lanes | 3 lanes | 4 lanes |
| --- | ---: | ---: | ---: | ---: |
| Export | 53.6 s (4.46 s/file) | 29.0 s | 22.6 s | 16.9 s (1.41 s/file) |
| Renderer RSS peak during export | ~1.2 GB | 2.7 GB | 2.8 GB | 3.7 GB |
| Background roll analysis | 170 s | 98 s | 82 s | 78 s |

The output pixels are unchanged (same conversion, same encoder). What still
dominates: the RAW decode (LibRaw, ~2.7 s per 18.5 MP DNG, single-threaded
WASM, one worker per lane) and, in the import pass, the auto-frame line
search (`findWindowLineQuads`: `cv.HoughLinesP` at π/1800 over four
channels, 10–20 s per frame on these scans). Coarser Hough resolutions are
2.5–5× faster but change detections on the RAW regression set, so they were
not adopted; see the notes in `docs/auto-frame-regression.md` before touching
it.

## Verification

```bash
npm test            # includes batchExportScheduler, conversion pool, export pool, geometry chain
npm run test:smoke  # batch export scenario (ZIP fallback to individual downloads), roll import
```

The benchmark harness that produced the numbers above lives outside the
repo (headless Chrome + CDP, `?debug=1` for `[perf]` traces); it imports N
files through `#fileInput`, waits for every file's settings badge, then
clicks Export All and records per-stage timings, long tasks and RSS.

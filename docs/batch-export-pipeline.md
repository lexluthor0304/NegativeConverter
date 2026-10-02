# Batch export and roll analysis pipeline

## Current architecture (updated 2026-09-25)

Batch export used to run one file at a time: decode → geometry → convert →
adjust → encode → write, each stage awaited before the next file started. The
conversion worker sat idle while the main thread decoded, and the RAW decoder
(the dominant cost) never overlapped with anything.

Now one driver (`runBatchExport` in `main.js`) runs the per-file pipeline
(`processFileWithSettings`) for several files at once through
`batchExportScheduler.js`:

- `planBatchParallelism` chooses the lane count from cores, memory and the
  largest decoded image dimensions, in bytes (#258): each lane costs 50 B/px
  (`LANE_BYTES_PER_PIXEL`) against a 4.0 GB lane budget (the historical
  80 MP): 18 MP frames run four wide, 24 MP three wide, 36 MP two wide,
  ≥45 MP sequential; devices with ≤4 GiB (reported `deviceMemory`, or the
  desktop app's real RAM) get 1.4 GB. When the RAM is known, half of the
  renderer-wide budget may be used instead, which only ever raises the plan:
  unknown RAM and RAM up to 16 GiB plan exactly as before, 32 GiB and more
  plan two 60 MP lanes. The plan is a ceiling: each lane reserves its bytes in
  the memory budget before it claims an index and waits while a photo is being
  opened or the budget is full (`docs/memory-budget.md`). `imageDimensions.js`
  reuses known decoded dimensions or reads at most 256 KiB of
  PNG/JPEG/TIFF-family headers per file. RAW preview IFD dimensions are not
  accepted as sensor dimensions. A header without dimensions borrows those of
  a decoded file with the same extension; otherwise unknown formats/sizes use
  a conservative 150 MP estimate. Compressed file size is no longer a memory
  estimate. `localStorage nc_batch_lanes_v1` (1–4) supplies a lane ceiling for
  support and benchmarking, and `nc_memory_ram_gib_v1` the RAM (the forced
  2-lane parity run uses 32); core and memory limits still apply.
- `runBatchPipeline` keeps `lanes` files in flight and hands the encoded
  results to the sink strictly in the original order, so ZIP entries, folder
  writes and downloads keep the roll's sequence. A failed file marks only
  itself. A lane whose encoded payload fits the unwritten-bytes cap goes on
  to the next file while the payload waits for its turn at the sink; a
  payload that does not fit holds its lane until its own sink finishes, as
  every payload did before #256. A slow first file therefore still cannot
  cause the rest of a roll's encoded outputs to accumulate: unwritten
  payload bytes never exceed the cap, and past it the lanes stop. An
  `AbortSignal` stops further files; in-flight ones finish and are written.
  An optional `beforeStart` hook (the hidden-window gate,
  `docs/hidden-window-jobs.md`, then the memory budget's lane reservation,
  `docs/memory-budget.md`) is awaited before a lane claims its next index
  and released after that index's sink, so a lane held back while the window
  is hidden or memory is short never blocks the in-order sink
  (`batchExportScheduler.test.mjs` also runs it against a gate that admits
  the newest waiter first, where a lane that claimed before admission would
  deadlock). A lane that goes on before its payload's write keeps only the
  payload's bytes of its memory reservation (the release's `early`); the
  hidden-window admission lasts until the sink. The stages a frame goes
  through (decode ahead, process, wait for the write) are budgeted apart;
  see "Stages of a frame" below.
- Each batch owns a pool of conversion workers
  (`createConversionWorkerPool`, kept alive across frames instead of
  restarting per file) and a pool of export workers (`createExportWorkerPool`,
  one per lane, a single lane included) for the adjustment and encode stages.
  Both are released when the batch ends, so a one-lane batch (every frame
  over 40 MP) no longer leaves its export worker, and its dead planes, in
  the module-level bridge (#250). The export pool is disposed of: no lane
  starts a worker again, and a request still in flight, still copying its
  inputs or made later is cancelled (an AbortError) instead of falling back
  to the main thread. The on-device AI repair session is shared,
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
  The import frame detection returns the rotated frame's size only (#251),
  so this is the file's one rotation. See `docs/geometry-chain.md`.
- A file the batch decodes itself goes to the auto-frame worker for frame
  detection and film edge in one request without a copy: the 8-bit buffer is
  transferred and handed back, the 16-bit plane stays (`runImportDetections`
  with `owned`, `docs/auto-frame-regression.md`).
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
  the encode starts. The desktop batch sink writes each file while the lane
  already processes the next frame, when the payload fits the byte cap
  (#256).
- Hot-folder reads use 8 MiB chunks (`IMPORT_CHUNK_BYTES` = the Rust
  `IMPORT_CHUNK_LIMIT`, pinned by a test). `read_import_file` is an async
  command whose read runs on the blocking pool, not on the native main
  thread, and it still checks scope, symlinks and the fingerprint on every
  chunk.
- PNG16 and scanner TIFF decode run in disposable workers with transferred
  input/output planes. The existing decoder is the fallback when a worker
  cannot start. RAW demosaic remains in LibRaw's dedicated worker (on a page
  with shared memory and a libraw-wasm that ships the threaded build, on its
  pthread pool), or, on a desktop whose native LibRaw passes the parity gate,
  in the shell. Export All's decodes run at `'user'` priority, uncapped on
  either; only the background lanes' decodes (roll analysis, prefetch and
  adoption, light-table tiles) use 2 threads (`docs/raw-decoding.md`).
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
    Where the worker cannot encode (no `OffscreenCanvas` encode before
    WebKit 16.4, a non-opaque frame), it hands the frame and the map's plane
    back: the restored frame is encoded on the main thread's canvas and the
    map runs on its own `gainMap16` request with the re-attached plane.
  If a worker dies holding a plane (`ExportInputLostError`, or `INPUT_LOST`
  from the conversion lane), the frame is rendered once more from decode
  with copies, so the file never depends on the failure. The failed
  attempt's planes (its base, when the lane lost a geometry output) are
  released before that render decodes again. The main-thread conversion
  fallback never sees a detached source.
- Nothing the frame allocated outlives it: the planes
  `processFileWithSettings` created (decode, geometry, conversion, repairs),
  the adjusted frame and the sprocket frame are stamped export-owned and
  released once the file is encoded (`releaseOwnedPlanes` in
  `app/planeRelease.js`: `transfer(0)` on WebKit, every iOS browser
  included, a throwaway worker on Chromium), instead of stacking under the
  next frame's decode until the next major GC. A plane that the editor, a
  photo session or history still references is never transferred or
  released (`liveEditorBuffers` in `main.js` names them with the
  `backingBuffers` walk, which never builds a geometry frame descriptor's
  pixels, `docs/geometry-chain.md`). Single export does the same with a
  bridge of its own that it disposes of when the export ends (no worker
  starts on it afterwards; a gain map left running by a failed canvas
  encode is cancelled there, and Cancel reaches that map too); the contact
  sheet releases a frame's full-resolution planes once its cell exists, and
  the light-table lane those of a watch-folder arrival's recipe render
  (`stage: 'processed'`, no adjustments) once the recipe is measured (#229
  review, R1-124).
- Batch frames run frame detection silently (`processFileWithSettings`
  `silent: true`): a never-analysed frame gets no blocking overlay and no
  frame wait, so a hidden window keeps exporting. A job fixes its export
  options when it starts (`captureExportJobOptions`: JPEG quality, sprocket
  border and edge markings, dust removal with its AI switch) and every frame
  reads them from `runBatchExport`'s `options`, not from the controls. Each
  job writes them with a marker, so a killed export can be named at boot and
  resumed under the same names, format and options; see
  `docs/hidden-window-jobs.md`.

## Stages of a frame (#256)

At 60 MP a batch used to run one frame at a time on about one core: the
80 M-pixel budget gives such frames one lane, and a lane held its frame from
decode to the end of the write. The stages now overlap, each with its own
budget, and the idle cores convert in bands. `nc_batch_pipeline_v1 = serial`
(support and benchmarks, no UI) turns all of it off on the same build: the
parity oracle for the comparisons below.

Budgets, in estimated bytes (`batchExportScheduler.js`):

| stage | estimate | where |
| --- | --- | --- |
| decoding (LibRaw heap, packing, post-decode) | 256 MB + 26 B/px, ~1.8 GB at 60 MP | `estimateRawDecodeBytes` |
| decoded, waiting for its lane | 12 B/px, ~0.72 GB | `DECODED_BASE_BYTES_PER_PIXEL` |
| one processing lane | 25 B/px, ~1.5 GB (code accounting) | `PROCESSING_SLOT_BYTES_PER_PIXEL` |
| a lane converting in the band pool, on top | 10 B/px, ~0.6 GB (code accounting: the assembled planes beside the bands' outputs, 12 B per converted pixel at an 81 % crop) | `BAND_POOL_BYTES_PER_PIXEL` |
| encoded, waiting for its write | the payload's size, at most 512 MiB in all | `EXPORT_MAX_UNWRITTEN_BYTES` |
| the editor (open photo, sessions, previews, stores, workers) and frames decoded ahead that wait for their lane | resident bytes | the memory ledger (`hiddenResidentBytes()`, #258) |
| everything else the memory budget has reserved (roll and tile lanes, the prefetch, other jobs) | their reservations | `memoryBudget.reserved` minus the batch's own lanes |

The lane plan (`planBatchParallelism`) is unchanged: frames of 45 MP and
more keep one processing lane, and the other cores go to decode-ahead and
the band pool. The processing figure is code accounting until the #230
harness measures the per-lane peak. The decode-ahead ceiling is the memory
budget's (`docs/memory-budget.md`, #258: 6.0 GiB at 16 GiB of RAM, 3.6 GiB
at 8 GiB or unknown), the editor's bytes are its ledger's, and the budget's
other holders count with their reservations (the batch's own lanes are
counted by the rows above instead). A prepared decode takes no reservation
of its own: a lane reserves before it claims a frame and then waits for that
frame's prepare, so admission is a yes or no at once, and a refused frame is
decoded by its lane inside the lane's reservation. Once decoded, a frame
waiting for its lane is in the ledger (`heldJobFrames`) until a lane takes it
or the batch drops it, so the budget's other requests see it.

- **Smaller lane** (Part 1). `processFileWithSettings` with `releaseEarly`
  (batch only) releases the decoded base and the geometry/lens outputs it
  owns as soon as the conversion resolves, not after the encode: later
  steps read their sizes and the lens mapping only. A base decoded ahead
  arrives with `sourceOwned` and counts as the call's own. A frame without
  lens correction gets only the 16-bit plane of its geometry output
  (`planes: '16'`); an 8-bit output drops the unadjusted 16-bit plane before
  the adjustment. If the conversion lane loses a handed-over geometry
  output, the output is rebuilt from the retained base with the same chain
  and converted by the lane's single worker, instead of decoding again.
  Code accounting at 60 MP (81 % crop, PNG8): ~3.0-3.5 GB per lane at
  1703835, ~2.0 GB with #250, ~1.2-1.5 GB now.
- **Byte cap** (Part 2). A lane is released as soon as its payload fits
  `EXPORT_MAX_UNWRITTEN_BYTES` (one 60 MP TIFF16 is ~362 MB, a JPEG ~7 MB),
  so the desktop write or the ZIP CRC of frame N overlaps frame N+1. Its
  memory reservation (50 B/px of the batch's largest frame) shrinks to the
  payload's size then: at 60 MP on 16 GiB two full reservations (6.04e9)
  leave only 0.4 GB of the 6.44e9 budget for the ledger, so frame N+1's lane
  would otherwise wait for N's sink. `earlyReleases` (the diagnostics' `last`
  and the `batchExport` trace) counts the writes a frame overlapped: the lane
  released before frame N's write started its next frame before N's sink
  ended. A lane whose next frame starts after that write (a browser download
  ends in the same task as its sink; a lane still waiting for memory) is not
  counted, nor is another lane's frame.
  Learned defaults keep a one-lane batch's order: the folder and download
  sinks hand over their `learnFromExport` promise, and a never-analysed
  frame awaits every earlier learning frame's write (`createLearningBarrier`)
  before it reads the learned records. The ZIP learns after it is closed.
- **Decode-ahead** (Part 3). While a lane processes frame N, frame N+1 is
  decoded (`createPrepareStage`, exported for roll analysis and the contact
  sheet): at most one frame ahead, one decoder at a time, started only once
  every lane's frame has its base. Each frame is admitted by
  `planDecodeAhead` (the table above against the ceiling; off at
  `deviceMemory` <= 4, on WebKit engines, while the hidden-window gate
  limits jobs, and in safe mode; the refusals are counted by reason in
  `decodeAhead.refused`). On WebKit (`wkwebview`, `webkitgtk`, Safari's
  `webkit`; `memoryRuntime.engine`, read at each admission because the
  desktop's answer arrives after boot) the spec enables it only once the
  #230 harness has measured the per-lane `phys_footprint` and
  `PROCESSING_SLOT_BYTES_PER_PIXEL` is set from it; until then every lane
  there decodes its own frame, as before #256. Nothing is decoded ahead
  while a foreground reservation is out (#258). RAW and PNG files only,
  whose decodes run off the main thread.
  The prepared base is `loadFileToImageData` with the options the lane
  would use, so it is the same decode. On the desktop a prepare waits for
  the background gate's foreground conditions only (input in the last
  400 ms, a photo switch, a foreground decode or conversion), at most 2 s;
  the batch's own export lock never holds it. Cancelling aborts every frame
  no lane has taken (its LibRaw worker goes with the abort) and releases
  those already decoded; they are never processed or written. A failed
  prepare fails only its own file.
- **Decoder sub-stages** (Part 4, off). With `nc_batch_pipeline_v1 =
  substages` a prepare reports `postDecode` once LibRaw is done
  (`loadRawFile`'s `onStage`), which frees the decode slot for the next
  frame while this one runs its post-decode pass; each sub-stage holds one
  frame. It is to be switched on only if the #230 harness shows the decode
  stage still bounds a batch after #232.
- **Band pool** (Part 5). `createConversionBandPool`
  (`conversionWorkerClient.js`, `workers/conversionBandWorker.js`,
  `pipeline/silverBands.js`) converts a frame in K row bands on
  min(6, cores − 2) workers, K = cores − 2 − decodes in flight, between 2 and
  6, and 2 while the desktop user gives input. Worker 0 plans the job
  (parameters, the loaded 3D profile, the reference sample's analysis) and
  builds the tables once from the bands' merged analysis (256-bin
  histograms, or the positive analysis's strided sample in frame order);
  the bands apply the engine's per-pixel tail with their own rows of the
  flat field and the stop map, and exchange unsharpened edge rows before
  sharpening, clamped at the frame's edges. Step 3 runs on bands with the
  frame's size and each band's start row (`createBandedExportBridge` wraps
  the export bridge: the 16-bit and 8-bit passes, the fused TIFF/PNG16
  request, the JPEG gain map's pass). Users: one-lane batches of frames over
  4 MP, and single exports (the export-time conversion of a frame over
  16 MP, and Step 3 of frames over 4 MP). The main thread slices and
  assembles in steps of about 8 ms. A batch frame whose later steps read no
  pixels (no dust, no repair, no pending expired measurement, auto WB from
  the analysis preview or none) keeps its converted bands in the pool and
  its Step 3 runs there: the processed frame is never assembled on the main
  thread. A single export keeps them too without dust or repairs; the plane
  that becomes `state.processedImageData` comes back as a copy. With
  cross-origin isolation (#264) the bands share one plane instead of being
  sliced; a source that is itself shared (the editor's RAW frame) is copied
  into it by the bands in their workers ('load' with `sourceRows`), never on
  the main thread. An 8-bit Step 3 on shared planes adjusts the 8-bit rows
  it was sent (the pool's 8-bit plane); until #264 turned isolation on for
  the dev server nothing ran this mode in a browser, and it derived those
  rows from the unsent 16-bit plane instead: black 8-bit exports of every
  non-resident frame. A pool that fails falls back to the lane or the single worker
  with the same pixels and is not used again; a released geometry output
  is rebuilt from the base; lost resident bands re-render the frame. The
  pool is released at batch end and after each single export.
  `window.__ncBatchPipeline.diagnostics` reports what the stages did: `last`
  (the scheduler's counters), `bands` (the pool's) and `residentFrames` are
  the last batch's; the other counters add up.

Parity: `pipeline/silverBands.parity.test.mjs` (band counts 1-7 against the
whole frame by SHA-256, every mode, references, flat field, strokes,
overrides, profiles, paper, sharpening radii, Step 3 with the expired
spatial map), `app/conversionBandPool.test.mjs` (the real worker in
worker_threads), `app/exportPlaneLifecycle.test.mjs` (banded single exports,
resident and assembled batch frames and a crashing band worker against the
serial path by bytes), `app/processFileWithSettings.parity.test.mjs`
(`releaseEarly`, `sourceOwned`, the rebuild, and the release probe), and
`npm run test:smoke -- --batch-pipeline-only` (Export All serial against
staged, byte for byte, in Chrome).

Measurements still to record here (with the #230 S9 method, 12 × 60 MP M11
DNGs, another 60 MP photo open): per-file time for TIFF16 and JPEG, decode
stage busy share, the `convert` mark per 60 MP frame with bands, Step-3
band time, per-lane peak and WebContent `phys_footprint`, and the per-frame
copy time and lane retention before and after.

The automatic roll analysis after a multi-file import runs frame detection
silently: it used to show the blocking "Detecting the image area and tilt…"
overlay for every file in the background pass, covering the editor for
minutes on a long roll. Its pass 1 no longer runs through `runBatchPipeline`
(#243): the background photo lanes pull one frame at a time in display order
around the open photo, wait for the foreground before each decode, and share
each decode with the foreground and the tile and prefetch needs of that frame
(`docs/photo-sessions.md`). A frame measured on the page sends frame
detection and film edge to its lane's auto-frame worker in one request, sizes
only (#251); the decode is shared, so its 8-bit plane goes as one copy rather
than being transferred. The per-frame measurements and the group commit,
built from `pending` in import order, are unchanged, and
`runBatchPipeline`'s export sink order and cancellation are untouched.

Roll analysis has its own lane plan and its own per-frame worker (#252):

- **Plan.** `planRollAnalysis` (`batchExportScheduler.js`) plans
  `framesInFlight` lanes sharing `decodeSlots` decoders from the analysis
  footprint, not the export lane's 50 B/px: a decode slot holds the RAW
  decode estimate (1.84 GB at 60.4 MP), a frame in analysis 14 B/px plus one
  OpenCV realm (about 1.0 GB). The planned bytes stay within a quarter of the
  machine's RAM and the slots leave two cores free; 16 GB at 60 MP gives 1
  decoder and 2 frames in flight, 32 GB gives 2 and 4. The RAM is the memory
  budget's (`resolveMemoryRam`, `docs/memory-budget.md`: the
  `nc_memory_ram_gib_v1` override, the desktop `get_memory_info` command or
  `navigator.deviceMemory`), once the desktop command has answered; without a
  known RAM above 8 GiB the plan is exactly the export planner's lanes, and
  it is never below them: those lanes count the RAM too (#258), the analysis
  plan's own floor does not, so where the analysis plan would run fewer
  frames or decoders (24 MP on 8 cores and 24 GiB: 3 and 3 against 4 lanes),
  the export planner's lanes run, each with its own decoder
  (`planRollAnalysisLanes`). So do they, each lane with its own frame
  analyzer as before #252, on a host where the roll-frame worker cannot run
  (no `OffscreenCanvas` in workers, as in Catalina's WebKit): every frame is
  then decoded and measured on the page, which the analysis footprint does
  not describe. `nc_batch_lanes_v1` stays the ceiling. A RAW whose
  header yields no size takes the decoded size of a same-extension file of
  the import (the foreground photo records its size too), and pass 1 plans
  again after its first frame. The memory budget (#258) reserves each lane
  by the same footprint: the frame in analysis from admission to its sink,
  plus its decode from the loader gate until its planes are packed (the
  roll-frame worker reports that before its detection), so the two agree on
  2 frames in flight at 16 GB.
- **Decode slots.** `createDecodeSlots` is the semaphore the lanes share. A
  lane opens the file and LibRaw's metadata while another demosaics, then
  reserves its frame's real decode bytes (`loadRawFile`'s `decodeSlot`) and
  gives the slot back as soon as `imageData()` returns; a frame larger than
  planned waits there instead of overcommitting. A RAW the lane decodes on
  the page (its worker analysis failed twice) takes the same slot
  (`decodeRollFrameOnPage`). With one slot no two background demosaics
  overlap, and frame N is measured while frame N+1 decodes. (Export
  decode-ahead, #256, admits its prepared decodes
  separately: `planDecodeAhead` and the prepare stage's one decoder.)
- **Roll-frame worker.** One `workers/rollFrameWorker.js` per frame in
  flight, created once per roll and held across retry attempts
  (`createRollAnalysisWorkers`, disposed when the roll ends). LibRaw's result
  is transferred there (`loadRawFile`'s `postDecode`), and the #232
  post-decode steps, the frame detection on both planes (sizes only, the
  full-resolution fallback in place) and the film-edge read run on the
  worker's planes. Once the planes are packed and LibRaw's result dropped,
  the worker posts `packed`, before the detection: the lane's memory claim
  keeps the frame's analysis bytes from there (`onPacked`). The page merges
  the plain results with today's functions in today's order
  (`createDefaultSettings` on a pixel-less frame primed with the worker's
  statistics, `analyzeStudioImportFrame`, `mergeImportFilmEdge`, learned
  settings); then the worker builds the roll
  sample (`rollSample.js`, the page's own builder) and drops the frame. No
  plane of the frame travels back to the page and no main-thread loop runs
  over it, except for a frame whose display proxy is still to be filled
  (#249: neither the spill nor the persistent store holds it): its planes
  come back with the sample for `fillDisplayProxy`.
- **Fallbacks per frame.** Scans and TIFFs, the pre-LibRaw branches (the
  heavy IIQ preview, UTIF DNGs), garbled output, a lost worker and a worker
  that does not answer keep today's path (garbled and lost go through the
  lazy embedded preview). A frame whose worker detection or film-edge read
  fails is measured once more in the worker, then on the page, as before. The
  detector options, the film-type choice and the border buffer are
  snapshotted when a frame's job starts; a frame whose options changed before
  its merge is measured again.
- **Sharing.** A foreground that opens a frame a lane holds adopts it: the
  planes come back from the worker between its steps (`sharedDecodes`' held
  values), or the file is decoded again if the worker lost them. A prefetch,
  or a base the photo sessions have room for, takes the planes back with the
  analysis, as lane bases were handed over before. While a roll's workers
  live, the shared auto-frame worker keeps OpenCV loaded through idle
  periods (`holdIdle`), so a cold switch to a frame the roll has not reached
  starts no new realm.
- **Half-size analysis (off by default, a quality trade-off).**
  `localStorage.nc_roll_analysis_half_v1 = 'on'` decodes a roll's RAWs at half
  size for the analysis (LibRaw `halfSize`, about 2.0 s instead of 5.1 s at
  60 MP), maps the worker's crop x2 onto the full frame and builds the roll
  sample for the full size; such a decode is never adopted by the
  foreground, prefetched or retained. It changes the automatic film base (up
  to 23 levels in the reviewers' check) and the 900 px sample grid, and
  through the roll median, the outliers and `channelData` the exported
  pixels, permanently. It may be offered only with a recorded comparison on
  the 151-frame M11 roll (roll base delta, outlier-set diff, `channelData`
  delta, per-frame crop and angle diffs against a stated tolerance), which
  has not been made.

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
additional. The renderer-wide memory budget (#258) counts the stores in use in
its ledger and reserves the decodes separately (`docs/memory-budget.md`). When IndexedDB is unavailable or its quota is exhausted, memory
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
calls). The belief then that the background lanes saturate the cores did not
hold at 60 MP: the 2026-09-23 audit measured 1.04 of 8 cores busy during a
60 MP roll analysis (one lane, every stage in sequence), which the plan,
the decode slots and the roll-frame workers above address (#252). The
foreground detector now spreads its channel units and angle passes over the
shared worker and two helpers (#252 part 4); roll lanes do not use helpers.
See `docs/auto-frame-regression.md` before touching the detector. The 2026-09-22 audit additionally tracks exact
per-detection preprocessing reuse in GitHub issue #216; its validation status
is recorded in the current audit report.

## Verification

```bash
npm test            # includes batchExportScheduler, conversion pool, export pool, geometry chain,
                    # planRollAnalysis, rollFrameTask (worker steps vs the lane sequence)
npm run test:smoke -- --roll-frame-only  # OpenCV shared module, roll-frame worker and parallel detector in Chrome
npm run test:smoke  # batch export scenario (ZIP fallback to individual downloads), roll import
npm run test:smoke -- --gain-map-only  # real-worker 16-bit result and gain map, gain-map requests per export intent,
                                       # a second JPEG export of the photo is the same file
npm run test:smoke -- --png16-only     # PNG16 band pool in real workers: same bytes for 1/2/6 workers, one worker and the main thread
npm run test:smoke -- --export-ownership-only  # worker PNG8/JPEG parity, per-export workers, plane hand-off
npm run test:smoke -- --batch-pipeline-only    # Export All serial vs staged (byte cap, decode-ahead, band pool, resident Step 3), banded single export, overlap count of a slow-write ZIP
node scripts/performance-io-benchmark.mjs /path/to/baseline
```

The historical benchmark harness that produced the Leica numbers above lives outside the
repo (headless Chrome + CDP, `?debug=1` for `[perf]` traces); it imports N
files through `#fileInput`, waits for every file's settings badge, then
clicks Export All and records per-stage timings, long tasks and RSS.
End-to-end roll and export measurements now come from the checked-in
`npm run bench:interactive` (S6 roll import, S9 export, memory in every
scenario; `docs/performance-benchmark.md`).

# Performance audit — 2026-09-22

This audit records 18 concrete performance findings as GitHub issues
[#199–#216](https://github.com/lexluthor0304/NegativeConverter/issues?q=is%3Aissue+perf).
The implementation is in an isolated worktree. "Implemented" below means
the change exists on the implementation branch; it does not mean merged,
deployed, or accepted by every browser. All 111 Node test files, 34 Rust tests,
the web build, complete Chrome smoke and five available RAW fixtures passed.
The final comparison/lifetime guard also passed its focused CPU/GPU regression.
Final branch CI and desktop platform builds remain merge gates.

Release preflight also found and corrected two compatibility regressions within
these findings: ZIP32 streaming local headers now zero their descriptor-owned
size fields, and AI workers signal readiness before model dispatch so asynchronous
bootstrap failures can use the existing main-thread fallback. Model initialization
and inference errors remain errors rather than triggering a second inference
backend. The follow-up checks cover exact ZIP32/ZIP64 headers and independent
Info-ZIP extraction, worker startup failure/timeout, model-byte ownership and
the boundary between startup fallback and actual model errors. Final follow-up
test and release results are recorded in PR #217.

The audit covered import/decoding, batch scheduling and memory, conversion,
display rendering, file lists, roll analysis, dust/AI repair, semantic work,
lossless encoders and ZIP/desktop output. Historical backlog statements were
checked against current code rather than counted as new findings.

## Import, batch scheduling, roll analysis and output

| Issue | Confirmed problem and source | Implementation | Verification status |
| --- | --- | --- | --- |
| [#199](https://github.com/lexluthor0304/NegativeConverter/issues/199) | `runBatchPipeline` released a processing lane while its encoded payload still waited for an earlier sink entry. A single slow first file could accumulate an entire roll of outputs. [Scheduler](../negative2positive/src/app/batchExportScheduler.js) | A lane remains occupied until its own result has been consumed. Output order, in-flight cancellation behavior and per-file failures remain intact. | Implemented; stalled decode/sink, ordering, failure and cancellation tests pass. |
| [#209](https://github.com/lexluthor0304/NegativeConverter/issues/209) | UPNG inflate/unpacking and UTIF scanner decoding ran synchronously on the UI thread. [PNG loader](../negative2positive/src/app/pngFileLoader.js), [TIFF loader](../negative2positive/src/app/tiffFileLoader.js) | Disposable [scan worker](../negative2positive/src/workers/scanDecodeWorker.js) transfers input and output planes. A ready handshake preserves fallback input if module startup fails; termination releases decoder heaps. | Implemented; real worker-thread precision, transfer, startup failure, error and timeout tests pass. Vite bundles the worker. Native browser PNG16/TIFF imports transferred buffers and retained exact 16-bit samples. |
| [#210](https://github.com/lexluthor0304/NegativeConverter/issues/210) | ZIP read each complete Blob once for CRC and a second time for output. Ready streams could prevent input/paint tasks from running. [ZIP writer](../negative2positive/src/app/zipStoreWriter.js) | One-pass CRC/output with ZIP32/ZIP64 data descriptors, at most 256 KiB write chunks and periodic task yields. | Implemented; independent JSZip extraction/CRC, empty entries, Unicode/name handling, bounded writes and single-read tests pass. |
| [#211](https://github.com/lexluthor0304/NegativeConverter/issues/211) | Opaque PNG16/TIFF exported redundant alpha; PNG used no row filter and copied compressed bytes into another IDAT allocation. [Encoders](../negative2positive/src/workers/imageEncoders.js) | Opaque output uses RGB, actual 8-bit-source transparency retains RGBA, and the existing 16-bit opacity contract remains. PNG Sub filtering is lossless; multipart IDAT removes the compressed-size copy. | Implemented; exact low-byte samples, alpha, multi-row filtering, worker/main parity and metadata tests pass. |
| [#213](https://github.com/lexluthor0304/NegativeConverter/issues/213) | Lane planning inferred decoded pixels from compressed file size. A highly compressed large scan could incorrectly run four-wide. [Dimension reader](../negative2positive/src/app/imageDimensions.js), `planBatchLanes` in [main](../negative2positive/src/app/main.js) | Cached decoded dimensions or bounded PNG/JPEG/TIFF-family headers determine the pixel budget. Unknown sizes are conservatively sequential. Explicit lane preferences are ceilings subject to core/memory limits. | Implemented; dimension/malformed-header tests and full browser batch/roll integration pass. Five local RAW headers were checked: four yield sensor dimensions, one safely uses the conservative fallback. |
| [#214](https://github.com/lexluthor0304/NegativeConverter/issues/214) | The 128 MiB sample cache evicted early 900px samples, causing another RAW decode, while `measurements[]` later retained the whole roll anyway. [Sample store](../negative2positive/src/app/analysisSampleStore.js), `runRollAnalysis` in [main](../negative2positive/src/app/main.js) | Exact samples spill into a private temporary IndexedDB database. Measurements retain statistics/settings; later passes read one sample at a time without repopulating a second RAM cache. Cleanup runs on completion/cancellation/error; Web Locks protect live-tab ownership and allow later crash-orphan reclamation. | Implemented; repeated lossless reads, concurrent writes, byte bounds, cleanup and storage-failure tests pass. Native IndexedDB spill/cleanup and real roll integration pass; cached and freshly decoded roll exports have identical SHA-256. |

## Conversion, rendering and editor updates

| Issue | Confirmed problem and source | Implementation | Verification status |
| --- | --- | --- | --- |
| [#202](https://github.com/lexluthor0304/NegativeConverter/issues/202) | Unsharp mask allocated three full-frame Float32 planes and read vertical neighborhoods with large strides. [Sharpening](../negative2positive/src/silvercore/engine/Sharpening.js) | A bounded row ring retains only the Gaussian neighborhood and current luminance row, preserving kernel/edge/rounding behavior. | Implemented; reference comparisons verify exact output across edge cases and 16-bit samples. |
| [#203](https://github.com/lexluthor0304/NegativeConverter/issues/203) | The live display histogram scanned full-resolution images and allocated four bins on each draw. [Histogram](../negative2positive/src/silvercore/ui/Histogram.js) | Reusable bins and deterministic stratified sampling capped at 262,144 pixels. Conversion analysis and exported pixels are untouched. | Implemented; sample bounds, small-image exact counts, channel/16-bit interpretation tests pass. Browser redraw/adjustment regression passes. |
| [#204](https://github.com/lexluthor0304/NegativeConverter/issues/204) | Re-promoting the same 8-bit source produced a new 16-bit buffer on each render, invalidating source/analysis reuse. [Adapter](../negative2positive/src/pipeline/silverAdapter.js), `toImage16ForSlot` | Each existing preview/full/scratch slot retains one promotion keyed by source plane and dimensions, with forced refresh when requested. | Implemented; cache invalidation and uncached pixel-equivalence tests pass. |
| [#205](https://github.com/lexluthor0304/NegativeConverter/issues/205) | `transformCanvas` copied full-resolution output without any reader; releasing comparison forced a full CPU render. [Main](../negative2positive/src/app/main.js), display/`exitBeforeAfter` | Removed the unused canvas/copies. Comparison restores current settings through the normal bounded/GPU preview path and refreshes the adjusted histogram. Session close releases border/reference scratch canvases. | Implemented; repository search confirms removal. Full browser geometry/export regression passes. A focused test first reproduced stale comparison pixels, then verified recent/during-comparison edits, GPU histogram and close/reopen cleanup. |
| [#206](https://github.com/lexluthor0304/NegativeConverter/issues/206) | Every status/selection update rebuilt all visible file rows, thumbnails and listeners. [File list](../negative2positive/src/app/fileListView.js) | Keyed rows retain unchanged DOM and update selection/status/index callbacks. Individual thumbnail updates address one row. | Implemented; browser smoke passes for 200 rows, repeated updates, focus, reorder callbacks and filtering. |
| [#207](https://github.com/lexluthor0304/NegativeConverter/issues/207) | Full display redraws regenerated procedural film borders for unchanged geometry/settings. [Border cache](../negative2positive/src/app/sprocketFrameCache.js) | One bounded cache stores border strips and copies fresh photograph pixels on every composition. Geometry/options/font readiness invalidate it; photo-dependent overexposure bypasses it. | Implemented; exact landscape/portrait pixels, invalidation, font readiness and browser border/close/reopen tests pass. Export composition retains its existing full-resolution path. |
| [#208](https://github.com/lexluthor0304/NegativeConverter/issues/208) | Unchanged dodge-and-burn strokes rerasterized a full exposure map during unrelated slider adjustments. [Adapter](../negative2positive/src/pipeline/silverAdapter.js) | Per-slot exposure map reuse is keyed by exact stroke content, geometry and dimensions; source replacement and invalidation clear it. | Implemented; output equality, cache reuse and stroke/geometry/source invalidation tests pass. |

## Dust removal, AI repair and queued analysis

| Issue | Confirmed problem and source | Implementation | Verification status |
| --- | --- | --- | --- |
| [#200](https://github.com/lexluthor0304/NegativeConverter/issues/200) | Full-resolution dust detection, TELEA and brush refinement ran on the UI thread; strength changes repeated work. [Dust processor](../negative2positive/src/workers/dustWorkerProcessor.js), [client](../negative2positive/src/app/dustWorkerClient.js) | Reusable serialized worker with source/hat-response reuse, stale-result guards, idle release and failure cleanup. Integer binary prefix counts halve that integral plane's storage. | Implemented; actual OpenCV masks, strengths, 8/16-bit TELEA and brush modes match direct processing. Full browser detection, clean-source reset, brush-without-reconversion and precision checks pass. |
| [#201](https://github.com/lexluthor0304/NegativeConverter/issues/201) | Sparse AI repair allocated one Float32 overlap weight per full-image pixel and continued obsolete tile inference. [AI inpaint](../negative2positive/src/app/aiInpaint.js) | Sparse Float32 overlap blocks preserve blending semantics. Freshness/cancellation is checked before and after each inference. | Implemented; sparse allocation, dense/overlapping pixel equivalence, alpha/16-bit behavior and cancellation tests pass. |
| [#212](https://github.com/lexluthor0304/NegativeConverter/issues/212) | Superseded semantic requests still loaded/started the model when their queued turn arrived. [Semantic queue](../negative2positive/src/app/semanticModel.js), `scheduleSemanticColour` in [main](../negative2positive/src/app/main.js) | A freshness predicate is checked before model/worker startup and after inference; stale work is skipped without poisoning following tasks. | Implemented; obsolete queued work, startup failure, timeout and crash tests pass. |
| [#215](https://github.com/lexluthor0304/NegativeConverter/issues/215) | The single-threaded WASM MI-GAN fallback ran in the main realm; `async session.run()` did not move CPU work off the UI thread. [AI session client](../negative2positive/src/app/aiInpaintWorkerClient.js), [processor](../negative2positive/src/workers/aiInpaintWorkerProcessor.js) | Reusable model sessions and serialized inference run in a worker. Exclusive tile buffers/results transfer; provider fallback, release and failure handling remain explicit. | Implemented; session/tensor lifecycle unit tests pass. Actual bundled-model WASM worker/direct 8/16-bit pixels match; 1195 ms inference allowed 119 heartbeat ticks with a 12 ms maximum gap. |

## Auto-frame detection

| Issue | Confirmed problem and source | Implementation/status | Verification status |
| --- | --- | --- | --- |
| [#216](https://github.com/lexluthor0304/NegativeConverter/issues/216) | Zero-angle RGBA/gray/CLAHE/morphology/Canny work and density-template scoring repeat within one detection; line evidence computes variation/median after earlier conditions have already failed. [Analyzer](../negative2positive/src/app/autoFrameAnalyzer.js), [line evidence](../negative2positive/src/app/imageWindowLines.js) | Per-detection reuse of identical zero-angle edge preprocessing and density candidates, plus early rejection of already-failed line evidence. Distinct contour modes, rotated inputs, thresholds and ranking remain separate. | Implemented; exact candidate lists/order and existing line detector tests pass. All five available NEF/DNG fixtures and full browser auto-crop checks pass. Historical whole-detector timings are not measurements of this change. |

## Measured evidence

Measurements are isolated probes on the audit machine, not end-to-end latency
or portable performance guarantees. Node version for IO probes was 26.5.1.

| Probe | Before | After | What the result establishes |
| --- | ---: | ---: | --- |
| Batch, first of 100 jobs stalled, 2 lanes | 100 started; 99 MiB waiting | 2 started; 1 MiB waiting | Completed output is included in backpressure. |
| 24 MP sharpening, radius 1 | 694 ms; 288,000,028 B Float32 scratch | 524 ms; 192,028 B scratch | Bounded row storage and exact output. |
| 24 MP display histogram | 78.45 ms | 4.27 ms | Bounded display-only sampling. |
| Same 500 × 500 8-bit source, three renders | 3 analyses; 45.5 ms | 1 analysis; 41.1 ms | Promotion identity now allows analysis reuse. |
| 1.5 MP, unchanged 20 strokes × 30 points, next render | 433 ms | 92 ms | Exposure map rasterization is reused. |
| 1600 × 1067 repeated zero-angle auto-frame preparation | 99.05 ms median | 2.40 ms median | Exact candidate lists/order; Hough reuse active in both comparisons. |
| 24 MP OpenCV dust detection | 2326 ms; 2331 ms max heartbeat gap | 2239 ms; 16 ms max gap | Equal masks with UI-thread relief; not reduced detection resolution. |
| 24 MP dust binary integral | 192,080,008 B | 96,040,004 B | Integer prefix counts halve one scratch plane. |
| 24 MP sparse AI repair, directly constructed Float32 storage | 101,242,880 B | 5,259,264 B | 94.8% reduction in measured Float32 construction, not total image memory. |
| 12 MP PNG16 decode | 1520 ms total; 1520 ms max timer gap | 1581 ms total; 11 ms max gap | Work moves off the UI thread; worker startup adds elapsed cost. |
| 12 MP TIFF16 decode | 157 ms total; 158 ms max timer gap | 181 ms total; 10 ms max gap | Same responsiveness tradeoff. |
| ZIP 64 MiB payload | 128 MiB read; 354 ms; 1 timer tick | 64 MiB read; 395 ms; 27 ticks | One-pass IO and cooperative scheduling, not a wall-clock speedup. |
| Opaque 3.84 MP TIFF16 | 30,720,666 B | 23,040,650 B | 25% smaller pixel payload. |
| 3.84 MP PNG16 ramp | 26,149,821 B; 1683 ms | 112,362 B; 294 ms | Lossless filtering helps this highly correlated fixture. |
| 3.84 MP PNG16 seeded grain | 26,460,896 B; 1620 ms | 23,048,698 B; 1003 ms | More conservative noisy-image compression result. |

The 24 MP direct/worker dust masks have the same SHA-256:
`767fd2b19a467b3c4d0296fe95b9526312634001ae4f0418a472302ea14612dd`.
IO fixture definitions and precision/format checks are documented separately
in [performance-io-audit.md](performance-io-audit.md).

Reproducible probes:

```sh
node scripts/performance-io-benchmark.mjs /path/to/baseline
node scripts/benchmark-pipeline-performance.mjs --root /path/to/baseline
node scripts/benchmark-pipeline-performance.mjs --root .
node scripts/benchmark-dust-performance.mjs 6000 4000
node scripts/benchmark-autoframe-preparation.mjs
```

## Verification gate

Targeted tests accompany the scheduler, codecs, scan worker, sample store,
dimension parser, border cache, sharpening, histogram, conversion caches,
dust worker, sparse AI blending, AI session proxy and semantic queue.
`scripts/performance-ui-smoke.mjs` adds real DOM reuse, native IndexedDB
precision/cleanup and bundled dust-worker checks to the browser suite.

Recorded local results:

- `npm test`: 111/111 test files (baseline 98/98; includes release-preflight regression coverage).
- `npm run build:web`: passed, including all new workers.
- `cargo test --manifest-path src-tauri/Cargo.toml --locked`: 34 tests passed.
- Complete Chrome smoke with `AUTOFRAME_RAW_DIR`: passed, including PNG16/TIFF
  import/export, real MI-GAN, batch/roll, camera, comparison and five local RAWs.
- Subsequent comparison freshness/lifetime guard: focused
  `--compare-preview-only` passed after first reproducing the regression.
  Both CPU exits rendered 915 × 610 preview pixels, not the 3600 × 2400 frame;
  GPU comparison restored the same histogram as a fresh same-settings draw.
  Close/reopen released and recreated all three border/reference scratch canvases.
- Conversion benchmark: all 25 output and analysis SHA-256 values match baseline.
- Final complete-branch CI and desktop platform builds must pass before merge.

The first complete smoke preceded the final comparison guard; its focused
regression followed that guard. A final full run/CI result belongs in the PR.
No merge, production deployment, desktop release or App Store submission is
claimed here. Private RAW originals and screenshots remain local.

## Limits and historical findings

- RAW demosaic, full-precision color/HSL transforms, spatial sharpening,
  full-image output ownership and lossless compression still consume CPU and
  memory. Their existence alone is not a defect. Approximate HSL 3D tables,
  reduced detection resolution or altered frame thresholds were not used to
  manufacture speedups.
- Display histogram counts are sampled on large images. Conversion analysis
  and export remain full precision. RGB exports preserve decoded color while
  intentionally changing container layout and compressed bytes.
- The sample store caps retained sample RAM, not total renderer memory.
  Active decode lanes, one retrieved sample, image outputs and IndexedDB
  implementation buffers add transient memory. Storage denial/quota failures
  preserve bounded RAM and correct output by allowing a later re-decode.
  Normal cleanup deletes its private database. Versioned databases hold a
  Web Lock for their lifetime; a later session reclaims crash leftovers only
  when their ownership lock is available, preserving other active tabs.
  Browsers without Web Locks or database enumeration use the bounded RAM
  and re-decode fallback instead of creating unreclaimable spill databases.
- Dust processing now yields the UI through workers. Mask construction,
  bounds scans, particle counts and independent output buffers can still cost
  O(image pixels); this audit does not claim every brush operation is O(repair
  area). Dense AI repair still needs many inference tiles.
- Worker startup, model compilation, provider support, browser memory limits,
  storage performance, image size/content and thermal throttling vary across
  hardware. Node worker and synthetic timings do not replace browser and
  real-camera regression checks.
- Historical claims about unused 16-bit output, unbounded 30-entry history,
  extra whole-file PNG/TIFF concatenation and leaked crashed export workers
  were stale: precision exports now consume the plane, history already has
  byte pruning, Blob parts already avoided whole-file concatenation, and
  worker failure cleanup already existed. Only remaining concrete costs were
  registered as new issues.
- Preview conversion already caches resident source data. Full-resolution
  workers deliberately release large heaps and retain an independent caller
  source, so their initial structured copy remains a memory/latency tradeoff.
  Potential lossless pass fusion and source-ownership redesign are optimization
  research, not changes verified by this branch.

This inventory is the set of confirmed findings from this audit. It does not
prove that every possible input, device or future workload has no performance
problem. The unrelated correctness, accessibility, UX and security backlog
remains separate in [audit-backlog.md](audit-backlog.md).

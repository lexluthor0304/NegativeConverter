# Interactive performance benchmark (`npm run bench:interactive`)

The checked-in end-to-end benchmark for the Lightroom-grade budgets of #229
(tool: #230). It replaces the ad hoc scripts of the 2026-09-16 and 2026-09-23
audits, which were lost. Every child issue of #229 attaches a compare table
from this tool.

It measures the production bundle, never the dev server: it builds the ref
under test with source maps into a temp dir, serves it with `vite preview`
from a detached worktree on its own ports, drives Chrome with trusted CDP input
at 60 Hz, and reads an in-page probe. It is a local or nightly tool for a real
Mac, not a PR CI gate: shared runners have software GL and noisy CPUs.

## Quick start

```bash
npm ci
npm run bench:interactive -- --quick                       # S1, S2 at DPR 2, S4, S7; ~15 min (estimate)
npm run bench:interactive                                  # S1–S9, child scenarios, M, H; duration depends on export variants
npm run bench:interactive -- --compare 1703835 HEAD --scenarios s2,s4
npm run bench:interactive -- --head ../wt-233 --scenarios s2   # uncommitted changes of a worktree
npm run bench:interactive -- --against output/perf/<run>/results.json
NC_PERF_RAW_DIR=~/rolls/2026-09-23 NC_PERF_ROLL_DIR=~/rolls/2026-09-23 \
  npm run bench:interactive -- --fixtures real --scenarios s1,s2,s4,s7
```

Results go to `output/perf/<UTC>-<sha>/` of the invoking checkout (ignored by
git): `results.json` (source of truth, written after every scenario),
`report.md`, gzipped Chrome traces of the profiled repetitions (open them in
Chrome DevTools → Performance) and `hang-*.json` dumps with `sample` files.
Synthetic fixtures are cached in `output/perf/fixtures/` (or
`NC_PERF_FIXTURE_DIR`) with a `fixtures.json` manifest.

Requirements: Node ≥ 22, Chrome (`CHROME_BIN` to override), `python3` for the
macOS memory helper (it uses only `ctypes`), git. No npm dependency is added:
raw CDP over Node's `WebSocket`, `node:module` `SourceMap`, W3C WebDriver over
`fetch`.

## Options

| option | meaning |
|---|---|
| `--scenarios s1,s2,…` | subset of `s1`–`s9`, `s9-parallel`, `dust-brush`, `overlay-idle`, `loupe`, `h`; `s9` also selects `s9-parallel`; M is always sampled |
| `--quick` | S1, S2 at DPR 2, S4, S7 (warm and cold only, on a 4-frame roll unless `--roll-size`); one fixture; 3 repetitions without the profiled one |
| `--fixtures synthetic\|real` | synthetic (default) or the `NC_PERF_*` directories |
| `--fixture NAME` | only this single-file fixture |
| `--film-type auto\|positive\|bw\|color` | pin the film type before import (unchecks "auto" and presses the film-type button) so runs compare like for like across #231 |
| `--reps N` | unprofiled repetitions (default 3), reported as median (min–max) |
| `--no-profile` | skip the extra profiled repetition |
| `--no-probe` | control run (S1, S2) without the probe or `Debugger.enable`; compare its `control.*` metrics with a probe run through `--against` |
| `--dpr 1,2` | device pixel ratios (Chrome only) |
| `--ref REF` / `--head WORKTREE` | ref to build; or a worktree with its uncommitted tracked changes (`git stash create`, untracked files excluded) |
| `--compare BASE HEAD` | both refs, separate worktrees and ports, repetitions interleaved A B A B |
| `--against results.json` | compare this run with a saved one |
| `--browser chrome\|safari\|tauri` | see "WebKit" |
| `--roll-size N` | roll scenarios (default 12; the 116-frame roll only when asked for) |
| `--headful` | headful Chrome (compositing differs from headless) |
| `--allow-software-gl` | measure on SwiftShader / llvmpipe anyway (labelled) |
| `--inject-hang` | prepend the hang self-test (a 60 s busy loop injected through CDP) |
| `--allow-pixel-change` | a compare with changed export pixels does not fail |
| `--record-baselines` | write this run's medians into `scripts/perf/budgets.json` |
| `--force` | skip pre-flight refusal; disk guard allows starting free space until a further 2 GiB drop; memory and swap guards stay active |
| `--port`, `--cdp-port` | preview and CDP ports (defaults 5297 / 9324; the smoke test uses 5197 / 9224) |
| `--keep-worktree` | keep the temp worktree and build for debugging |

Environment: `NC_PERF_RAW_DIR`, `NC_PERF_RAW_FILES` (JSON list of names or
paths, like `PHOTO_SESSION_RAW_FILES`), `NC_PERF_ROLL_DIR`,
`NC_PERF_FIXTURE_DIR`, `NC_PERF_HANG_S` (default 30), `NC_PERF_LOCK`,
`NC_PERF_MEM_CEILING_GB` (default 60 % of RAM), `NC_PERF_PORT`,
`NC_PERF_CDP_PORT`, `CHROME_BIN`.

Exit status: 0 ok; 1 a compare regression, changed export pixels, a failed hang
self-test, a dev-server request or an error; 2 usage; 3 another run holds the
lock; 4 refused by the pre-flight; 5 no Chrome.

## How a run works

1. **Lock.** A machine-wide lock `/tmp/negativeconverter-bench.lock`
   (`%TEMP%` on Windows, `NC_PERF_LOCK` to override) created with `O_EXCL`,
   holding PID, start time and argv. The path is fixed, not `os.tmpdir()`:
   macOS gives each user and sandboxed agent session its own `$TMPDIR`, and
   isolated worktrees each have their own `output/`. A second run exits at
   once and names the holder; a lock whose PID is dead is reclaimed under an exclusive reclaim mutex, re-reading its owner before replacement. A crashed `.reclaim` sidecar fails closed: verify its owner and the lock owner are dead before removing it. Signal and exit handlers kill only registered harness processes and remove registered temp worktrees before releasing the lock. Worktrees are registered immediately after creation, including setup failures.
2. **Pre-flight.** Refuses to start (unless `--force`) when
   `kern.memorystatus_vm_pressure_level` is not normal or free disk is below
   20 GB. Waits up to 2 min for the 1-minute load average to drop below
   cores ÷ 2, else labels the run `noisy`.
3. **Worktree.** `git worktree add --detach` of the ref in a temp dir;
   `node_modules/` is a real directory of per-package symlinks to the invoking
   checkout's packages plus its own empty `.vite` (so concurrent worktrees never
   share Vite's cache). When `package-lock.json` differs, `npm ci` runs there
   instead. Removed on exit with `git worktree remove --force` on its own path
   (never a global prune). The main worktree's `negative2positive/dist` is never
   touched.
4. **Build and serve.** `vite build --config negative2positive/vite.config.js
   --sourcemap --outDir <tmp>/dist-<sha> --emptyOutDir`, then `vite preview
   --configLoader native --config scripts/perf/vite.preview.config.js` on its
   own port. That config is the ref's app config plus a preview-only plugin
   (`scripts/perf/preview-plugin.mjs`): `/__perf/probe.js`, fixtures (WebKit
   modes only), `POST /__perf/results`, `POST /__perf/export` and, for WebKit
   modes, the probe injected into `index.html?perf=1`. The probe is same-origin,
   so the desktop CSP (`script-src 'self'`) allows it. The shipped bundle is
   unchanged. The run fails if any `/@vite/client`, `/@fs/` or `?import`
   request reaches the server.
5. **Browser.** A fresh Chrome (`--headless=new`, throwaway profile, 1440×900)
   per scenario repetition, so kernel lifetime peaks stay per scenario. DPR 1
   and 2 through `Emulation.setDeviceMetricsOverride`. The app is loaded twice
   before the measured boot so HTTP and WASM caches are warm. A short first
   session records `WEBGL_debug_renderer_info`; SwiftShader and other software
   GL are refused without `--allow-software-gl`. The page and worker debugger is enabled only for H, profiled repetitions and the hang self-test, before a potential hang. Timing and export-verification repetitions retain V8’s normal Wasm tier. Workers are auto-attached recursively (LibRaw spawns nested workers).
6. **Input.** Trusted CDP input only (`Input.dispatchMouseEvent`,
   `Input.dispatchKeyEvent`, wheel events) on an absolute 60 Hz schedule (a late
   step never delays the next). Files through `DOM.setFileInputFiles` on
   `#fileInput`. Controls are revealed (tab, `<details>`, scroll) before a
   measured window, never inside it.
7. **Repetitions.** `--reps` timing repetitions, then one profiled repetition
   with a Chrome trace of all threads (CPU samples source-mapped to `src/`
   file:line; excluded from medians), then scenario-specific verification
   repetitions (S9 singles, ZIPs, then no-flag parity in separate sessions). Results are medians with (min–max). Completed metrics and hashes survive an abort; the interrupted step and scenario status are failures. S7 updates per-class medians after each completed step.
8. **Conditions** recorded in `results.json`: git SHA and dirty flag, Chrome
   version, GPU string, DPR, fixture set and SHA-256 of every fixture,
   `os.loadavg()` at start and end, power source (`pmset -g batt`), thermal state
   (`pmset -g therm`), swap at start and end, memory ceiling.

## The probe (`scripts/perf/probe.js`)

One engine-neutral classic script (Chrome: `Page.addScriptToEvaluateOnNewDocument`;
WebKit: the preview-server injection). It records, with `performance.now()`
timestamps:

- WebGL 1 **and** 2: `texImage2D`/`texSubImage2D` with a sparse pixel hash per
  upload, `drawArrays`/`drawElements` (and the WebGL 2 variants) with a state
  signature (program, bound texture contents, uniform values, backing size),
  and the app's own `readPixels`/`getError` calls.
- 2D canvas `putImageData`/`drawImage`; `toDataURL`, `toBlob`, `convertToBlob`.
- Worker creation/termination and every request/result, classified by
  `type`/`fn`: `convert` (with film type and cache flags; the result's 8-bit
  pixels hashed like uploads), `suppress`, `analyze-frame`, `read-film-edge`,
  `analyze-import` (#251: an import's frame detection and film edge in one
  request; its time is `stage.autoFrameMs`),
  LibRaw `open`/`imageData`, scan decode, export encode, dust, semantic, AI.
- `File` reads (`arrayBuffer`, `slice`, `stream`, `text`, `FileReader`), Tauri
  `invoke` and its completion, including matching native write windows, with no destination paths or capability tokens; trusted input (capture phase, platform timestamps). Dust `detect`, `inpaint`, `stroke`, `plane` and `maskDelta` payloads record exact binary lengths plus a metadata estimate, with shared-plane lengths separate. Removed `refine` messages are not classified as dust.
- `PerformanceObserver`: `long-animation-frame` (script attribution, mapped
  through the source maps), `longtask`, `event` (`durationThreshold: 16`),
  `first-input`, `mark`/`measure` (the app hook below). Entry types are
  feature-detected.
- Visibility: the loading overlay (class and, while it fades, opacity) and
  `studio-ready`/`studioBusy`; mutations of the zoom transform, the file name,
  the crop overlay and film-strip thumbnails.
- Measurement windows: a rAF-gap recorder and a 5 ms `setInterval` heartbeat
  (the WebKit long-task proxy), only while a window is open.
- A 30 s ring buffer that a hang dump reads while the page is paused;
  `window.__ncMemory?.snapshot()` once #258 adds it.

It never calls `readPixels`, `getError` or `getImageData` itself (GPU or raster
sync points): "visible" is decided from upload hashes. The one exception is
S9's verification repetition, which decodes a JPEG export on an
`OffscreenCanvas` after the measured window to hash its pixels. Its own time is
reported per window as `probeSelfMs`/`probeSelfPct` (budget: ≤ 1 % of
main-thread task time in S2; `probe.selfPctMax` in every S2 summary).
`scripts/perf/probe-worker.js` adds worker-side start/reply timestamps through
a CDP binding (Chrome only). Worker attachment and wrappers still impose some cost. Compare S1/S2 `control.stage.librawDecodeMs` and `control.stage.autoFrameMs`, ready time and main busy time against `--no-probe`. That control uses only a minimal stage observer: no debugger, draw hashing, worker attachment or performance observers. Diagnostic repetitions intentionally include debugger/trace bias and are excluded from timing medians.

## The app hook (`?perf=1`)

`createPerfTrace` lives in `negative2positive/src/app/perfTrace.js`. With
`?perf=1` every trace emits `performance.mark` per stage and one
`performance.measure` per trace (`nc:<label>`, with `detail`, no 120 ms
threshold, no debug widget) for trace sites including (`fullResolutionRender`,
`processNegative`, `imageDataToBlob`, `processFileWithSettings`, `batchExport`,
`prepareStudioPhoto`, `automaticRollImport`, `linearDngBatch`), and the auto-frame stage timings
become the `nc:autoFrameStages` measure. `?debug=1` keeps its console output
above 120 ms. Without either flag no entry is created (unit test
`perfTrace.test.mjs`; smoke `perf-harness-smoke.mjs`), so the unbounded User
Timing buffer cannot grow. S9 checks that export pixels are identical with the
flag on and off.

## Scenarios and metric definitions

Metric keys are `s<N>.<subject>.<metric>`; summaries are keyed
`<metric>@<fixture>`.

- **Picture**: a draw on the display canvas whose state signature differs from
  the previous draw's, or a 2D put/draw with new pixels on the CPU display
  canvas. `#glCanvas` only ever shows converted positives (negatives go to the
  2D canvas), so a GL draw after a new source-texture upload is a **positive**;
  it is tied to the conversion result whose pixels hash like the upload, or,
  when the app resized the result for display, to the newest result before the
  upload. This order fallback accepts only display-sized RGBA8 uploads (equal to a conversion result, or larger than 256×256). Integer input textures and LUT uploads of at most 256×256 are uniform-like changes at their own upload time. On the 2D canvas a put/draw is a positive when its pixels hash like a
  conversion result. A uniform-only GL redraw is a picture but not new content.
- **Input→draw** is draw-anchored: picture time minus the time of the newest
  input it reflects. A picture reflects the newest value-changing input at or
  before its cause: the request time of the conversion whose result it shows,
  otherwise the latest upload or uniform change behind it. The input time is
  the trusted mouse move that produced the value (platform timestamp). On-glass
  presentation adds about one vsync.
- **Frames covered** is the share of value-changing 60 Hz frames whose newest
  input is reflected by a picture (pictures up to 250 ms after release count).
- **Updates/s** counts pictures during the drag; **value changes/s** counts
  `input` events that changed the value.
- **Main busy %**: CDP `Performance.getMetrics` `TaskDuration` over the window
  (Chrome); the 5 ms heartbeat's lateness in WebKit.
- **Long tasks**: Long Tasks API entries > 50 ms in the interaction window
  (S2–S5, S8: first input until 500 ms after the last; S7: keypress until
  ready; S1 and S9 are tracked, not budgeted). WebKit: timer gaps > 50 ms.
- **Settled**: the end of the last worker activity (a request in flight or a
  message) followed by 2.5 s without any.

| ID | Steps | Main metrics |
|---|---|---|
| S1 import | boot, import one file | boot ms and transferred KB; from `change`: first pixels drawn, first photo visible, first positive visible, ready, settled; stage timeline (worker round trips, `nc:*` measures); long tasks; LibRaw decodes; film type and route |
| S2 sliders | 3 s drags (180 moves at 60 Hz over 40 % of the track) of `coreExposure`, `coreContrast`, `coreTemperature`, `wbR`, `cyan` at DPR 1 and 2; `coreExposure` and `cyan` on the CPU path (`#coreUseWebGL` off) | updates/s, value changes/s, frames covered %, input→draw p50/p95/max, Event Timing p95 (0 = under the 16 ms reporting threshold), main busy %, long tasks, rAF gaps > 50 ms, worker round trip, final value and last change after release, thumbnail re-encodes; Studio flushes, total/last-flush DOM writes and file-list renders per drag under `?debugCounters=1` |
| S3 curve | add a mid-tone point on the diagonal, drag it up 20 % over 3 s inside the canvas | as S2 plus rAF fps and the same UI counters |
| S4 zoom/pan | double-click fit→2×, `#zoomInBtn` to 2.5×, 3.9×, 7.6×; fit → true 100 % with the `1:1` button (#248); 24 wheel notches; 2 s pan at 2× | transform applied ms, texture refined at ms, long task during refinement, backing px, backing ÷ needed (texture width ÷ min(source width, on-screen CSS width × DPR)), native detail ms (3000 = not within the observation window; since #248 also reached by the detail layer's region at ≥ 0.95 source px per device px), detail ready ms (first region upload on `glDetailCanvas`), source px per device px on screen, long tasks of the 1:1 step, pan frames/s and move→frame p50/p95 |
| S5 geometry | enter crop, drag an edge 2 s, ⌘-draw a straighten line, apply, rotate 90° twice, mirror | enter→first draw (the crop canvas's px, positive or not), overlay fps, edge move→frame, straighten release→preview, apply→first frame with the overlay opaque and the longest task before it (#245), apply→positive drawn, rotate/mirror→first redraw, max long task per step |
| S6 roll | import N files; Brightness and Cyan drags during and after the background work | S1 metrics; settings badge and thumbnail on all N; LibRaw decodes and workers; cores used (Σ process CPU ÷ wall; Σ thread busy ÷ wall in the profiled trace); drag metrics during vs after |
| S7 navigation | Arrow + Enter on the film strip: cold unanalysed (during analysis), warm 1-back, cold analysed, 2-back, 5 presses in 0.8 s | first pixels of the target, first display-resolution positive, ready, LibRaw decodes, stale results after the target is shown, long tasks, main busy % (median per class and repetition) |
| S8 light table | open, wheel-scroll 2 s at normal and fast speed, Cyan drag, Sync colours to all | click→first frames, fps, frames > 25 ms, time until every tile is final, thumbnail px ÷ drawn device px, active-tile re-encodes per drag, Sync colours until every tile is final |
| S9 export | after settled: current photo as PNG8/16, linear DNG, TIFF16, JPEG with the gain map on and off, as imported and after the geometry recipe (straighten, rotate 90°, mirror, crop); Export All ZIP of `--export-count` non-current files (default 3) | total s, s/file, bytes, max long task, main busy %, inputs accepted during export, memory before / peak / 10 s after; verification repetitions stream the bytes to the harness: SHA-256 of decoded pixels (PNG and TIFF in Node, JPEG in the page after the window), PNG/TIFF/DNG bit depth, ZIP JPEG primary-pixel hashes and gain-map bytes; PNG16 encode trace, DNG batch build/total/Blob time and observed batch lane count; `s9.perfFlagParity` compares `?perf=1` on and off |
| `s9-parallel` | fresh session, four distinct 24 MP DNGs; PNG16 ZIP of three non-current frames, lane ceiling 3 | S9 metrics under `s9.zip.png16.lanes3`; fail if actual lanes <3; decoded 16-bit sample hashes |
| `dust-brush` | full-resolution 60 MP LibRaw DNG, AI off, Show mask on, twenty Alt-drag repairs | per-stroke mouseup→repair, worker round trip, long tasks and message sizes; p95 ≤150 ms, max task ≤50 ms, every copied payload <16 MiB |
| `overlay-idle` | PNG8 export, require a visible export overlay, check hidden and idle | reuse `scripts/loading-overlay-idle.mjs` read-only; zero running animations under hidden overlays |
| `loupe` | Chrome fake camera; wait for five frames, measure 5 s, close and verify release | main busy ≤10%, conversions/grabs/defaults/repeated counters, fake input labelled |
| M memory | 4 Hz in every scenario | renderer and GPU-process `phys_footprint`: sampled peak, kernel lifetime peak, after settle; JS heap after GC; the memory budget's snapshot (ledger breakdown, reservations) and grant/release log at the end of each run (`result.memoryBudget`, `docs/memory-budget.md`) |
| H hang repro | `_DSC3111.NEF` from `NC_PERF_RAW_DIR`, else the synthetic 24 MP DNG (labelled): 50 DPR 1 curve drags and 50 CPU-path cyan drags, half with the CPU profiler on, a continuous trace ring buffer throughout | stalls and a dump per stall |

The TIFF16 export selects TIFF, waits until `[data-bitdepth="16"]` is no longer
`disabled` (it syncs one animation frame later; clicking both in one task
silently exported 8-bit TIFF in the 2026-09-23 audit), clicks it and waits for
`aria-pressed="true"`; the verification checks the bit depth in the file
header. Whole-file hashes are not compared: ZIP entries carry the current time.

The #257 encoder variants, #259 dust run and #261 counters, overlay idle
check and fake-camera loupe are registered. Their new large-fixture scenarios
have unit/simulated coverage; performance acceptance is **unmeasured** until
the coordinator runs #230. This lane does not claim 60 MP, native Tauri, or
complete benchmark results from the small smoke. The default S9 ZIP has three
files; `--scenarios s9 --export-count 10` selects eleven distinct inputs,
excludes the current one and measures #257's ten-frame acceptance batch.
With real fixtures, `NC_PERF_ROLL_DIR` must contain ten other files; insufficient
fixtures fail instead of measuring a shorter batch. This remains a coordinator measurement.
The >=3-lane run uses four distinct 24 MP fixtures (or four real NEFs) in a
fresh session and fails if the planner legitimately selects fewer lanes.
The one-lane improvement of >=10 s/frame and native write head/base <=0.5
are acceptance annotations in the budgets; the generic gate detects
regressions rather than these improvement ratios. Additional AI/exposure brush
(#246/#254) and merge-memory (#260) extensions remain outside this lane.

Every import records `scenario.photo0.route` and `.filmType` from the request
tied to the displayed foreground conversion. S6/S7/S8/S9 record every photo
under `scenario.photoN.*`; extra visits happen after measured windows, so they
cannot warm cold navigation timings. Background conversions cannot replace
photo 0's route. Compare flags route and film-type changes on all these keys.

S9 records `rotationAngle`, `mirrored` and `cropRegion` for each single export.
Its pointer recipe depends on layout; a mismatch fails before hash comparison,
even with `--allow-pixel-change`, and corresponding hashes are inconclusive.
PNG16 compares decoded sample SHA-256, so zlib or chunk-layout changes alone
cannot produce a pixel-change verdict.

## Fixtures

- **Synthetic** (default, any machine): `scripts/perf/fixtures.mjs`, from fixed
  seeds, streamed in 64-row bands (the generator stays far below 300 MB RSS).
  The scene extends `make-technical-fixtures.mjs` with a film rebate, sprocket
  holes through to the light source, frame edges and grain.
  - `synthetic-24mp-color.tif` (6000×4000), `synthetic-60mp-color.tif`
    (9536×6336), `synthetic-60mp-bw.tif`: 16-bit RGB negatives.
  - `synthetic-24mp-cfa.dng`, `synthetic-60mp-cfa.dng`: RGGB CFA DNGs with
    12-bit packed samples (86.4 MiB of samples at 60 MP), so they stay under the
    100 MiB heavy-RAW threshold and take the M11's full-decode route while the
    two-stage flag is off (its default). With `?twoStageMinMp=40` (#255) the
    60 MP DNG and the M11 files take the two-stage route instead
    (two-stage-raw-import.md); compare runs with the same flag. IFD0 comes
    from the app's `buildTiffParts`; three JPEG previews at the M11's sizes
    (full size, 2112×1408, 720×480) hang off SubIFDs. The previews are encoded by
    the harness's Chrome (the repo has no JPEG encoder), so the files are stable
    per Chrome version; `fixtures.json` records the encoder. No "iPhone" string
    in the first 1000 bytes. Decode time is not comparable with the M11's: use
    them for before/after only. A 1200×800 file was checked with LibRaw 0.22.1
    (rawpy) and Apple's RAW decoder: the raw values match the scene exactly,
    the pattern is RGGB with white level 4095, the demosaiced image has no Bayer
    snow, and LibRaw lists the SubIFD previews as thumbnails. The smoke suite
    decodes one through the app's LibRaw.
  - `synthetic-roll-01…12.dng`: a 60 MP roll with different seeds (about 1.1 GB).
  - `synthetic-export24-1…3.dng`: distinct 24 MP companions for the three-lane ZIP.
  - Generation checks free disk first (it must stay above 20 GB).
- **Real**: `NC_PERF_RAW_DIR` (+ `NC_PERF_RAW_FILES`) and `NC_PERF_ROLL_DIR`,
  opened read-only, never copied; results and committed baselines name
  basenames only. The 2026-09-23 files: A `L1000617.DNG` (9536×6336, 79 MB),
  B `_DSC3111.NEF` (4000×2672), roll `L1000617…628.DNG`.

## Budgets and compare mode (`scripts/perf/budgets.json`)

Each metric has a unit, a direction (`better`), an optional `target`, a noise
`tolerance` (`rel`, `abs`) and baselines (ref, fixture, route, value,
`range` or `null` when a report gave only a median, source). Keys may use `*`
per segment; the most specific key wins. Metrics without a target are tracked.

`--compare BASE HEAD` prints:

| metric | target | before median (min–max) | after median (min–max) | Δ % | status | export pixels |
|---|---|---|---|---|---|---|

Status per metric: `pass` (target met, or tracked within noise), `open`
(target not met, not a regression beyond noise), `improved`, `regressed`
(worse by more than the tolerance and the min–max ranges do not overlap) and
`broke-budget` (met before, missed after by more than the tolerance). Hash rows
read `identical` or `pixels-changed`; a conversion route change is flagged
(`route-changed`) because the route decides the cost. The run exits 1 on
`regressed`, `broke-budget`, `missing-after` (base measured it, head did not), non-ok head scenarios/steps, recipe changes, or changed export pixels (unless
`--allow-pixel-change`, for a PR that flags a quality trade-off); `open` never
fails a run. New head-only metrics are informational. Scenario errors also exit 1 without a compare. Baseline recording replaces the existing ref/fixture/metric entry rather than adding duplicates.

## Hang watchdog

A heartbeat `Runtime.evaluate('1')` goes to the page every second. After
`NC_PERF_HANG_S` seconds (default 30) without a reply the watchdog:
in diagnostic repetitions, `Debugger.pause`s the page and every attached worker (Chrome handles it on the
IO thread and interrupts running JavaScript) and keeps the source-mapped call
frames; reads the probe ring buffer with `Debugger.evaluateOnCallFrame`; ends
and saves the continuous trace ring buffer (H and profiled repetitions only);
runs `sample <pid> 3` on the renderer and GPU processes (the only stack when
the main thread is stuck in native code); records `SystemInfo.getProcessInfo`
CPU times; then kills the browser, marks the repetition `hang` and continues.
Renderer crashes and target loss are recorded with the last memory sample.
`--inject-hang` proves it with a 60 s busy loop; the self-test fails the run
unless detection is within threshold + 5 s, the dump holds `ncInjectedHang` and frames for every busy worker, the ring buffer, the trace, and a native sample for each renderer and GPU PID. Idle workers are listed separately; failed pauses never count as frames. A dedicated busy worker makes the check meaningful. Timing hangs use native samples and process CPU data without JS worker stacks; H keeps full diagnostics. Dump and sample names contain a per-stall UUID to preserve repeated stalls.

## Guardrails

- One heavy run at a time (the lock). Nothing runs in parallel; the 116-file
  roll and the Tauri build run only when asked for.
- The summed `phys_footprint` of the browser's processes may not exceed
  `NC_PERF_MEM_CEILING_GB` (default 60 % of RAM, 9.6 GB on 16 GB); swap may not
  grow by more than 2 GB (`sysctl vm.swapusage`); free disk may not fall below
  20 GB (with `--force`, abort on a further 2 GiB drop from starting free disk). Memory and swap guards stay active under `--force`. On a crossing the browser gets SIGKILL within one 250 ms sampling
  period and the repetition reads `memory-ceiling` with the last sample, the
  window it happened in and the time until the browser was gone. At 1703835
  rapid switching (renderer 7.9–9.4 GB plus the GPU process) and ZIP export
  (8.3–8.8 GB) therefore report "≥ ceiling" instead of driving the machine into
  swap. With a 3 GB ceiling the 60 MP roll import already crosses it (renderer
  2.8 GB plus the 1.8 GB GPU process) before S7's burst.

## WebKit

- **`--browser safari`**: `safaridriver --enable` once and Develop → Allow
  Remote Automation. Trusted input through W3C Perform Actions; the probe is
  injected by the preview server; fixtures are fetched from
  `/__perf/fixtures/` by the probe and assigned to `#fileInput` through
  `DataTransfer` (memory-backed, so the file's 80–95 MB adds to the WebContent
  footprint; labelled). Safari runs at the display DPR. Scenarios S1, S2, S4,
  S7. Memory samples only the WebContent connected to the preview port, or the sole new WebContent during harness navigation, plus the sole new GPU. Existing Mail/Safari WebContent and shared GPU PIDs are excluded; ambiguous attribution fails. Keys are `webContentPeakMB`, `webContentLifetimePeakMB`, `webkitGpuPeakMB`. Memory, swap and disk guards run on every sample and kill only attributed PIDs and the owned driver/Tauri group. Excluding an already shared GPU may undercount GPU memory; record that limit in engine comparisons.
- **`--browser tauri`**: `tauri dev --release --no-watch` in the harness
  worktree with `beforeDevCommand` emptied and `devUrl` pointing at the harness
  preview server (`?perf=1&scenario=…`), so the real WKWebView and an optimised
  Rust side load the production bundle, never the dev server, and edits by
  parallel agents trigger no rebuild. It runs one cargo build (share
  `CARGO_TARGET_DIR`). The probe self-drives S1, S2, S7 and S9 (including `s9-parallel`): sliders get `value`
  plus an `input` event per rAF (range inputs only react to value changes),
  photo switches and exports are clicks. S9 retains the real native save dialog: choose a disposable destination for each export. Cancellation or missing finish events cannot pass. `desktopWriteMs` excludes the dialog and measures the matching begin through finish resolution. This path has unit coverage only in this lane. Results are labelled synthetic input and
  compared only with the same mode. The `http://` origin differs from
  `tauri://localhost` in caching and custom-protocol behaviour. Web Inspector
  (enabled in `tauri dev` builds) can record a Timeline by hand. Alternative
  not taken yet: `tauri-plugin-wdio-webdriver` behind a non-default `perf`
  cargo feature (check first that its actions arrive as trusted events).
- WebKit ships neither LoAF nor the Long Tasks API: rAF and timer gaps are the
  long-task proxy. Event Timing exists from Safari 26.2. A probe worker reports
  "main thread silent" to the harness, which then runs `sample` on WebContent.
- Later, optional: Windows WebView2 with
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=…` gets the
  full CDP mode; Linux WebKitGTK can use `tauri-driver` + `WebKitWebDriver`.

## Baselines at 1703835 (2026-09-23)

Conditions: Apple M1 Pro 8 cores 16 GB, macOS 27.0, Chrome 153.0.8010.53
`--headless=new` with ANGLE Metal, production build, 1440×900, DPR 2 unless
noted, load average 3–50 and partly on battery (treat times as ±10 %). Values
are medians with (min–max). Every M11 frame ran the `positive` route because of
#231; re-record the M11 baselines after #231 (the roll moves to the B&W route)
and keep both, labelled by route. The full reports are posted on #229;
`budgets.json` carries these numbers.

### Targets vs baseline

| budget | target | baseline | status |
|---|---|---|---|
| SilverCore slider input→draw p95, DPR 2 | ≤ 16 ms | coreExposure 56, coreContrast 64, coreTemperature 70 ms (A); 92 / 113 / 115 ms (B) | fails |
| Brightness redraw rate | ≥ 55 draws/s | 31.3 (29.3–31.3) (A), 14.3 (B); 52 % / 24 % of value-changing frames drawn | fails |
| Step-3 sliders (wbR, cyan) and curve p95 | ≤ 16 ms | 12 / 16 ms; curve 15.0 ms (A) | meets |
| Zoom step, transform applied | ≤ 16 ms | 11–15 ms (A and B, DPR 1 and 2) | meets |
| Pan at 2× | ≥ 58 fps, p95 ≤ 16 ms, 0 long tasks | 59.8 / 59.9 fps, p95 8.4 / 14.3 ms (A / B), 0 | meets |
| Native detail after a zoom step | ≤ 200 ms | never: 0.68 at 2×, 0.35 at 3.9×, 0.26 at 7.6× (A); refinement at 0.34–0.55 s with long tasks up to 283 ms | fails |
| Warm switch (1-back), first display-resolution positive | ≤ 100 ms | 77.6 ms (72.8–349); 8-photo session 76–477 ms | median meets |
| Cold switch, provisional pixels | ≤ 300 ms | 9672 ms (9472–10445) | fails |
| 5 presses in 0.8 s | ≤ 300 ms provisional | target positive 17 376 ms (12 879–26 265); first pixels 6968 (6600–19 416); 5 LibRaw decodes | fails |
| First photo | ≤ 2 s | 13.3 s (A), 5.7 s (B), 13.6 s (12-file roll) | fails |
| Long tasks in interaction windows | 0 | rotate 90° 2.2 s; apply crop 1.9–2.1 s; cold switch 4 tasks, max 416 ms; drags during roll analysis up to 665 ms; CPU-path drags on A 11–38 per 3 s | fails |
| Renderer peak `phys_footprint` | ≤ 6 GB | rapid switching 7.9–9.4 GB; ZIP export 8.3–8.8 GB; 12-file import 5.2 GB; single import 2.8 GB | fails |
| GPU process after import, no AI tool | ≤ 0.5 GB | 1.8 GB (1.66 GB pre-loaded MI-GAN) | fails |

Tracked without a budget: roll analysis (every thumbnail final at 277 s for 12
files, settings badges at 173.8 s, 24 LibRaw decodes, about 1.04 of 8 cores);
Sync colours 92–96 s for 11 photos; single export JPEG with gain map 11.5 s
(max task 6957 ms), TIFF16 3.0 s; ZIP TIFF16 15.5 s/file, JPEG 21.1 s/file;
memory retained after one single export about 6.3 GB (2.0 GB before); crop
mode enter 30 ms, straighten 35 ms.

### S1 import (ms from `change`)

| file | first pixels drawn | first photo visible | first positive visible | ready | settled | LibRaw | defects | auto-frame | film edge | convert |
|---|---|---|---|---|---|---|---|---|---|---|
| A | 9074 (9041–9420) | 12349 (12319–12749) | 13332 (13135–13553) | 13220 | 19317 (18433–20394) | 5381 | 2966 | 2761 | 272 | 78 |
| B | 1664 (1663–1743) | 4505 (4484–4576) | 5734 (5706–5776) | 5726 | 13912 | 1010 | 485 | 2449 | 305 | 117 |

Long tasks (n / total / max ms): A 6 / 1125 / 347, B 6 / 949 / 483. Renderer
peak A 2830 (2607–2943) MB, B 1664 MB; after settle 1597 / 1385 MB; GPU process
1813 / 1804 MB (peak 2391 / 2411); JS heap after GC 3.4 / 3.6 MB; change→LibRaw
open 183 / 44 ms.

### S2 slider drags (prod)

| file | slider | DPR | updates/s | value changes/s | frames covered % | input→draw p50 / p95 ms | main busy % | worker RT ms | final value after release ms |
|---|---|---|---|---|---|---|---|---|---|
| A | coreExposure | 2 | 31.3 (29.3–31.3) | 60 | 52 | 48 / 56 | 31 | 25.8 | 39 |
| A | coreContrast | 2 | 27.3 | 28 | 98 | 61 / 64 | 25 | 29.1 | 47 |
| A | coreTemperature | 2 | 25.6 (25.0–27.3) | 28 | 92 | 67 / 70 | 23 | 29.3 | 50 |
| A | wbR | 2 | 21.0 | 21 | 98 | 11 / 12 | 19 | – | 10 |
| A | cyan | 2 | 28.0 | 28 | 100 | 15 / 16 | 22 | – | −2 |
| A | coreExposure | 1 | 32.6 (31.0–32.6) | 60 | 54 | 20 / 36 | 24 | 7.3 | 18 |
| A | coreContrast / coreTemperature | 1 | 27.6 | 28 | 99 | 40 / 41, 39 / 40 | 18–19 | 7–8 | 25–26 |
| B | coreExposure | 2 | 14.3 | 60 | 24 | 80 / 92 | 19 | 63.5 | 81 (last change 2383) |
| B | coreContrast | 2 | 14.3 | 28 | 51 | 97 / 113 | 17 | 64.0 | 111 |
| B | coreTemperature | 2 | 11.0 (10.7–11.0) | 28 | 39 | 97 / 115 | 17 | 63.6 | 134 |
| B | coreExposure | 1 | 29.6 (29.6–31.6) | 60 | 49 | 31 / 33 | 24 | 17.0 | 31 |
| A (dev, 60 MP canvas) | cyan, CPU path | 2 | 4.7 | 5 | 94 | 20 / 64 | 97 | – | 12 (15 long tasks, 3100 ms) |
| A (dev, 60 MP canvas) | coreExposure, CPU path | 2 | 4.2 | 12 | 34 | 40 / 93 | 8 | 25.2 | 48 (11 long tasks, 2159 ms) |

Step-3 sliders on B (DPR 1 and 2): every change drawn, p50 6–10 ms, p95 ≤ 10 ms.

### S3 curve (DPR 2)

A: 8 updates/s (8-bit LUT quantisation of the slow drag), 13.5 / 15.0 ms, main
busy 33 %, 0 long tasks, 60 fps. B: 8, 13.2 / 14.2 ms.

### S4 zoom and pan (A, DPR 2)

| step | transform ms | refined at ms | long task ms | backing px | backing ÷ needed |
|---|---|---|---|---|---|
| fit→2× | 11 | 476 | 283 | 2453×1630 | 0.68 |
| →2.5× | 12 | none (capped) | 0 | 2453×1630 | 0.54 |
| →3.9× | 13 | none | 0 | 2453×1630 | 0.35 |
| →7.6× | 14 | none | 0 | 2453×1630 | 0.26 |
| wheel ×24 | 0.4 | – | 0 | 2453×1630 | 0.72 |

Pan at 2×: 59.8 transform frames/s, move→frame 7.8 / 8.4 ms, main busy 14 %,
0 long tasks. DPR 1: backing ÷ needed 1.00 / 1.00 / 0.69 / 0.36. B: 0.68 /
0.67 / 0.67 / 0.67 at DPR 2; pan 59.9 fps, 13.6 / 14.3 ms.

### S5 geometry (prod)

| file | enter crop → draw ms (px) | edge fps | edge move→frame ms | straighten ms | apply → positive ms | apply max task ms | rotate 90° → redraw ms (task) |
|---|---|---|---|---|---|---|---|
| A | 30 (953×633 negative) | 59.9 | 11.6 | 35 (34–44) | 3263 (3194–4001) | 1990 (1871–2083) | 2260 (2181); 2238 (2197) |
| B | 13 (1001×670) | 59.9 | 14.6 | 33 | 1734 (565–2638) | 1310 | 514 (411); 726 (686) |

### S6 roll (12 × 60 MP, seconds from `change`)

First pixels 9.2 (9.1–9.5), first visible 12.8 (12.6–12.9), first positive
13.6 (13.5–13.8), ready 13.6, settings on all 12 at 173.8 (170.8–176.7), a
thumbnail on all 12 at 277.0 (273.5–282.4), 24 LibRaw decodes. 116 files: first
positive 12.9 s. Renderer peak 5207–5267 MB (p1 traced 6051), GPU 1871–2382 MB.
Drags during vs after the background work: Brightness 25.9 (22.7–30.3) vs 29.9
(29.3–30.6) updates/s, p95 66.5 vs 55.8 ms, max long task 174 (0–665) vs 0 ms;
Cyan p95 13 vs 14.9 ms, max task 384 (248–507) vs 0 ms. Background window: 313
s of thread busy time in 301 s wall, 1.04 of 8 cores.

### S7 navigation (ms from Enter)

| class | first pixels | first display positive | ready | LibRaw decodes | long tasks n / max ms | main busy % |
|---|---|---|---|---|---|---|
| warm (1-back) | 77.6 (72.8–86.7) | 77.6 (72.8–349) | 105 (97.7–388) | 0 | 1 / 91 | 6.1 |
| cold, analysed | 9672 (9472–10445) | 9672 | 9704 | 1 | 4 / 416 | 9.0 |
| 2 photos back | 78 (1200×797 stand-in) | 4851 (75–9873) | – | 0.5 | – | – |
| 5 presses in 0.8 s | 6968 (6600–19416) | 17376 (12879–26265) | 17406 | 5 | 11 / 624 | 20.4 |

### S8 light table (12 files)

Open: click handler 0.9–1.2 ms, first frames at 10–11, 22–28, 36–45 ms, 0 long
tasks. Wheel scroll 59.7–59.8 fps, 0 frames > 25 ms. Thumbnails 144×96 JPEG
drawn at 304 device px (2.1× upscaled). Active tile re-encoded about 28–30
times/s (85 per 3 s Cyan drag). Sync colours to 11 photos: 92.4–95.9 s, 10
LibRaw decodes, 30 long tasks totalling 5.5–5.6 s (max 261 ms).

### S9 export (60 MP)

| export | total | output | max long task ms | main busy % |
|---|---|---|---|---|
| single TIFF16 | 3.0 s (2.7–4.7) | 362.5 MB | 1319 (1277–1936) | 50 |
| single JPEG, gain map on | 11.5 s (10.5–11.7) | 16.46 MB | 6957 (6945–7080) | 88 |
| single JPEG, gain map off | 1.4 s (1.3–1.5) | 16.20 MB | 227 (125–275) | 45 |
| ZIP TIFF16, 3 files | 46.5 s (44.4–46.5), 15.5 s/file | 1.088 GB | 3080–4054 | 27–30 |
| ZIP JPEG, 3 files | 63.3 s (62.6–63.3), 21.1 s/file | 22.0 MB | 7527–7590 | 50–52 |

Editing during ZIP export: locked by the overlay (0 inputs). Renderer during
ZIP 8282–8798 MB, GPU up to 3044 MB. After the first single export the renderer
stays at about 6.3 GB (2.0 GB before).

## Calibration and first WebKit numbers

Pending the first run on the M1 Pro (the harness was written in an environment
without a browser). Record here: at 1703835 with `NC_PERF_RAW_DIR`/`NC_PERF_ROLL_DIR`
on the M11 files, whether the harness reproduces the report within ±15 % for
`L1000617.DNG` S1 first positive visible; S2 `coreExposure` DPR 2 updates/s and
input→draw p50/p95; S4 backing ÷ needed at 2×; S7 warm and cold medians; the
renderer peak of a single import — or why it differs; the synthetic-fixture
baselines (`--record-baselines`); H on `_DSC3111.NEF` (a stall dump, or "no
stall in 100 drags" with the conditions); and the Safari and Tauri numbers for
`L1000617.DNG` and `synthetic-60mp-cfa.dng` next to Chrome's.

## Tests

`npm test` runs `scripts/perf/**/*.test.mjs` without a browser: statistics,
compare statuses and exit codes, budgets.json validity, the lock (including a
second CLI process with another `$TMPDIR`), guards and parsers, the
`proc_pid_rusage` helper against the test process, the probe against stand-in
browser objects, metric definitions, source maps and trace analysis, the hang
watchdog and dump collection, worktree creation and removal, the preview
plugin routes, fixture structure and memory, export verification. Two
simulation tests run the scenario code itself: `scenarios.test.mjs` drives
S1–S9, the child scenarios with small stub payloads, H and the hang self-test through the runner's repetition code against
a scripted Chrome session, and `webkit.test.mjs` drives Safari's S1, S2, S4
and S7 against a scripted WebDriver session (`NC_PERF_TIME_SCALE=0` skips
their waits; real runs never set it). `runner.test.mjs` covers the
orchestration (interleaving, failed head scenarios, retained pre-abort hashes, missing-metric gates, forced disk guards, duplicate baseline replacement and signal cleanup). Lock tests force concurrent stale reclaimers. Session tests verify timing repetitions never enable the page or worker debugger. Hang tests preserve two stalls and reject failed busy-worker pauses or missing renderer samples. The smoke
suite (`npm run test:smoke`, or `--perf-harness-only`) checks the probe and the
`?perf=1` hook in the real app and decodes a small synthetic CFA DNG through
LibRaw.

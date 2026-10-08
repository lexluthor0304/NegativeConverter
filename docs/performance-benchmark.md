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
| `--no-probe` | control run (S1, S2) without the probe or `Debugger.enable`; documented Chrome probe/control `--against` comparisons intersect intended scenarios, fixtures and DPRs, then compare `control.*` metrics and scenario statuses; missing measurements within that scope still fail; ordinary saved/base/head comparisons retain every gate |
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
   step never delays the next; a command that fails because a guard stopped
   the browser mid-drag is reported with the others, never left unhandled,
   which ended the whole run until #273). Files through `DOM.setFileInputFiles` on
   `#fileInput`. Controls are revealed (tab, `<details>`, scroll) before a
   measured window, never inside it. The reveal waits for running finite
   animations on the control and its ancestors and then for a rect that holds
   still for 6 frames: an opened Studio drawer slides its body in (160 ms,
   `steps(4)`, 8 px), and S2's `wbR` press, taken from a rect read during that
   animation, landed 6 px below its 3 px track until #273, so its drags
   recorded no input.
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
  and the app's own `readPixels`/`getError` calls. Uniform calls compare their
  numbers with the location's last ones in place; a change rehashes that
  location and XORs it into the context's uniform state, so a draw's
  signature covers every uniform value without walking them (#273).
- 2D canvas `putImageData`/`drawImage`; `toDataURL`, `toBlob`, `convertToBlob`;
  `ImageBitmapRenderingContext.transferFromImageBitmap` (`bmp` events, the
  bitmap's size read before the transfer detaches it).
- The photo-switch veil `#studioPhotoSwitchFeedback` (#235): a mutation
  observer records when it is shown or hidden, its `data-provisional` kind and
  the visible surface (`veil` events). Its canvases are named by their
  `data-surface` (`studioPhotoSwitchFeedback:bitmap`, `…:image`), and a
  capturing `load` listener on the document records the thumbnail `<img>`
  surface's loads (`veil.load`).
- Worker creation/termination and every request/result, classified by
  `type`/`fn`: `convert` (with film type and cache flags; the result's 8-bit
  pixels hashed like uploads), `suppress`, `analyze-frame`, `read-film-edge`,
  `analyze-import` (#251: an import's frame detection and film edge in one
  request; its time is `stage.autoFrameMs`, and the reply's `frameMs` and
  `filmEdgeMs`, each part's own time in the worker, are recorded with it),
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
  (the WebKit long-task proxy), only while a window is open. Chrome windows
  run without the heartbeat (`beginWindow(label, { ticks: false })`): Chrome
  has the Long Tasks API and CDP task time, and its 200 timer tasks a second
  were probe load that `probeSelfMs` did not count (#273).
- A 30 s ring buffer (at least 4096 events) that a hang dump reads while the
  page is paused; old events are dropped by advancing a start index and the
  array is compacted when half of it is dead. Until #273 every push spliced
  the ring once it held more than 4096 events of the last 30 s: O(n) per
  event, 17–70 µs at 200–1000 events/s in V8 (busy scenarios such as roll
  imports, not S2's drags).
- `window.__ncMemory?.snapshot()` once #258 adds it.

It never calls `readPixels`, `getError` or `getImageData` itself (GPU or raster
sync points): "visible" is decided from upload hashes. The one exception is
S9's verification repetition, which decodes a JPEG export on an
`OffscreenCanvas` after the measured window to hash its pixels. Its own time is
reported per window as `probeSelfMs`/`probeSelfPct` (budget: ≤ 1 % of
main-thread task time in S2; `probe.selfPctMax` in every S2 summary).

Probe cost (#273). The quick runs at 8f8faa6a and 12ed8051 put `probeSelfPct`
at 2.1–2.5 % for the drags that moved (3.5 % for the idle `wbR` window). A
Chrome CPU profile of S2-style drags (Vite dev server, the 1.8 MP JPEG
negative, DPR 2) attributed the probe's time to its input listeners (42 %,
half of it the capturing `pointermove` listener on every move), the draw
wrapper's signature text over every uniform and bound texture (14 %), hashing
(8 %), the worker `postMessage` wrapper (8 %), uniform wrappers (5 %) and the
rAF recorder (4 %). After the changes above, the quick run at 49efdf33
(Chrome 155, `synthetic-60mp-cfa.dng`, DPR 2) measures 1.4–1.8 % per drag:
medians 1.6 % for the three SilverCore sliders and 1.7 % for `cyan` and
`wbR`, `probe.selfPctMax` 1.8 % (was 3.5 %). The ≤ 1 % bound is not met, so
`probe.selfPctMax` stays tracked in `budgets.json`. What remains is a floor
per frame: every value change costs two listener calls (the trusted move,
whose platform time input→draw needs, and the `input` event), a rAF sample
and one or two draw records, and a SilverCore frame adds about 40 uniform
calls and two 256×256 table uploads whose sparse hashes keep picture
detection exact. The Step-3 drags keep the main thread only 4–5 % busy, so
that floor alone is about 1.5 % of their task time. In the light check, the
`--no-probe` control's main-thread share was 14.3 % (`coreExposure`),
4.3 % (`cyan`) and 3.2 % (`wbR`) against 14.7–16.7 %, 3.8–7.8 % and
3.4–6.8 % with the probe on a busy machine; the S2 control on the 60 MP
fixture was stopped twice by the disk guard (other runs on the machine) and
is still to be repeated.
`scripts/perf/probe-worker.js` adds worker-side start/reply timestamps through
a CDP binding (Chrome only). Worker attachment and wrappers still impose some cost. Compare S1/S2 `control.stage.librawDecodeMs` and `control.stage.autoFrameMs`, ready time and main busy time against `--no-probe`. That control uses only a minimal stage observer: no debugger, draw hashing, worker attachment or performance observers. Diagnostic repetitions intentionally include debugger/trace bias and are excluded from timing medians.

## The app hook (`?perf=1`)

`createPerfTrace` lives in `negative2positive/src/app/perfTrace.js`. With
`?perf=1` every trace emits `performance.mark` per stage and one
`performance.measure` per trace (`nc:<label>`, with `detail`, no 120 ms
threshold, no debug widget) for trace sites including (`fullResolutionRender`,
`processNegative`, `imageDataToBlob`, `processFileWithSettings`, `batchExport`,
`prepareStudioPhoto`, `automaticRollImport`, `linearDngBatch`, `detailRegion` (#270: a zoom
detail region's `converted` and `shown` stages, its bands and the workers'
own stage times)), and the auto-frame stage timings
become the `nc:autoFrameStages` measure. The `filmEdge` stage of
`prepareStudioPhoto` carries `readMs`, the read's own time: it arrives in the
same worker reply as the frame detection, so the stage's mark alone cannot
time it (#273). `?debug=1` keeps its console output
above 120 ms. Without either flag no entry is created (unit test
`perfTrace.test.mjs`; smoke `perf-harness-smoke.mjs`), so the unbounded User
Timing buffer cannot grow. S9 checks that export pixels are identical with the
flag on and off.

## Scenarios and metric definitions

Metric keys are `s<N>.<subject>.<metric>`; summaries are keyed
`<metric>@<fixture>`.

- **Provisional pixels** (#235): the target's own pixels on the photo-switch
  veil, which covers the viewer while a photo opens: the camera's embedded
  preview transferred to its bitmap surface (kind `embedded`), the retained
  1200 px converted copy put on its image surface (`cached`), or its
  thumbnail `<img>` once loaded (`thumbnail`, or `cached` for a stored
  converted preview). Visible when the full-screen loading overlay is hidden.
  They are never on the display canvases, so the exact metrics below do not
  count them.
- **Exact pixels visible**: a picture on a display canvas is visible once
  neither the loading overlay nor the veil covers it. A RAW import opens
  through the veil instead of the overlay since #235, so S1's first photo and
  first positive visible wait for the veil to hide; recordings without veil
  events (older refs) reduce to the overlay alone.
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
- **Input phase** (#272, not a recorded metric). Chrome dispatches mouse moves
  aligned to animation frames: a move later than a frame's time waits for the
  next frame's BeginMainFrame, about 1 ms after that frame's time. A move's wait
  is therefore up to one frame, set by where in the frame it arrives. `drag()`
  starts the 60 Hz schedule right after the awaited `mousePressed`, which, after
  the frame-aligned hover move, completes 1.5–5.5 ms after a frame start when
  the main thread is idle; all 180 moves keep that phase and wait 13–16 ms each
  (Chrome 155, measured from the probe's `t`/`h` and the rAF frame times). A
  drag whose press meets a busy main thread starts later in the frame and reads
  up to about 10 ms less, with the same app work. Input→draw of a SilverCore or
  Step-3 drag is therefore about 17.8 ms minus the phase plus the app's tick,
  and repetitions of the same code can land on either side of the 16 ms budget.
  Pairing by platform timestamp also lets a slider that changes value on every
  move (coreExposure) pair a picture with a move that arrived before the
  picture's upload but was not dispatched yet: at a 2 ms phase such a drag reads
  about 1 ms where the move→draw time is about 17 ms. Both are queued in
  audit-backlog.md (Test coverage).
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
| S1 import | boot, import one file | boot ms and transferred KB; from `change`: provisional pixels (`firstProvisionalPixelsMs`, its kind, `firstEmbeddedPreviewMs`), then the exact ones: first pixels drawn, first photo visible, first positive visible, ready, settled; stage timeline (worker round trips, `nc:*` measures), with `stage.filmEdgeMs` and `stage.frameDetectMs` the worker's own times inside the `analyze-import` request (`stage.autoFrameMs` stays the whole request); long tasks; LibRaw decodes; film type and route |
| S2 sliders | 3 s drags (180 moves at 60 Hz over 40 % of the track) of `coreExposure`, `coreContrast`, `coreTemperature`, `wbR`, `cyan` at DPR 1 and 2; `coreExposure` and `cyan` on the CPU path (`#coreUseWebGL` off). The press point is measured after the reveal has settled and must hit the slider (`elementFromPoint`), and the recorded press must land on it, else the step fails (`ui`) | updates/s, value changes/s, frames covered %, input→draw p50/p95/max, Event Timing p95 (0 = under the 16 ms reporting threshold), main busy %, long tasks, rAF gaps > 50 ms, worker round trip, final value and last change after release, thumbnail re-encodes; Studio flushes, total/last-flush DOM writes and file-list renders per drag under `?debugCounters=1` |
| S3 curve | add a mid-tone point on the diagonal, drag it up 20 % over 3 s inside the canvas | as S2 plus rAF fps and the same UI counters |
| S4 zoom/pan | double-click fit→2×, `#zoomInBtn` to 2.5×, 3.9×, 7.6×; fit → true 100 % with the `1:1` button (#248); 24 wheel notches; 2 s pan at 2× | transform applied ms, texture refined at ms, long task during refinement, backing px, backing ÷ needed (texture width ÷ min(source width, on-screen CSS width × DPR)), native detail ms (3000 = not within the observation window; since #248 also reached by the detail layer's region at ≥ 0.95 source px per device px; since #270 at ≥ 0.95 of the most the view allows, min(1, source width ÷ on-screen device width), so above true 100 % a native region counts, and a region shown before the step that still covers the view that sharply counts at the transform), detail ready ms (first region upload on `glDetailCanvas`), source px per device px on screen and the best possible (`bestSourcePxPerDevicePx`), and where the step's region spent its time (#270, from the app's `nc:detailRegion` measure: `detailRequestMs` input → request, `detailConvertMs` request → converted pixels, `detailDrawMs` → drawn, `detailBands` workers, `detailWorkerMs` the slowest band's worker time), long tasks of the 1:1 step, pan frames/s and move→frame p50/p95 |
| S5 geometry | enter crop, drag an edge 2 s, ⌘-draw a straighten line, apply, rotate 90° twice, mirror | enter→first draw (the crop canvas's px, positive or not), overlay fps, edge move→frame, straighten release→preview, apply→first frame with the overlay opaque and the longest task before it (#245), apply→positive drawn, rotate/mirror→first redraw, max long task per step |
| S6 roll | import N files; Brightness and Cyan drags during and after the background work | S1 metrics; settings badge and thumbnail on all N; LibRaw decodes and workers; cores used (Σ process CPU ÷ wall; Σ thread busy ÷ wall in the profiled trace); drag metrics during vs after |
| S7 navigation | Arrow + Enter on the film strip: cold unanalysed (during analysis), warm 1-back, cold analysed, 2-back, 5 presses in 0.8 s | the target's provisional pixels on the veil (`firstProvisionalPixelsMs`, kind, `firstEmbeddedPreviewMs`), its first exact pixels drawn, first display-resolution positive, ready, LibRaw decodes, stale results after the target is shown, long tasks, main busy % (median per class and repetition); `s7.cold.firstProvisionalPixelsP95Ms`: the p95 over every cold switch of the timing repetitions (a switch without provisional pixels counts its ready time) |
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
  - Generation checks projected free disk first (normally it must stay above 20 GiB). A forced harness run passes its admission baseline separately from the generator's regeneration flag and counts estimated fixture bytes against the same further 2 GiB disk-loss allowance. Missing baselines keep the ordinary floor; cached fixtures are not regenerated by the run policy.
- **Real**: `NC_PERF_RAW_DIR` (+ `NC_PERF_RAW_FILES`) and `NC_PERF_ROLL_DIR`,
  opened read-only, never copied; results and committed baselines name
  basenames only. The 2026-09-23 files: A `L1000617.DNG` (9536×6336, 79 MB),
  B `_DSC3111.NEF` (4000×2672), roll `L1000617…628.DNG`.

## Budgets and compare mode (`scripts/perf/budgets.json`)

Each metric has a unit, a direction (`better`), an optional `target`, a noise
`tolerance` (`rel`, `abs`) and baselines (ref, fixture, route, value,
`range` or `null` when a report gave only a median, source). Keys may use `*`
per segment; the most specific key wins. Metrics without a target are tracked.

A summary is the median (min–max) over timing repetitions, except two pooled
kinds: `probe.selfPctMax` (the largest `probeSelfPct` of any drag) and the
`…P95Ms` keys a scenario fills sample by sample (`ctx.sample`), whose value is
the p95 over every timing repetition's samples together, with their (min–max)
and count (`pooled: 'p95'`). A p95 budget such as #235's cold switch is checked
there, not on a median of per-repetition values.

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
  20 GB (with `--force`, abort on a further 2 GiB drop from starting free disk). Memory and swap guards stay active under `--force`. The sampler checks at 250 ms intervals; native attribution and versioned cleanup can add response latency. The tiny actual Tauri debug check observed abort callbacks after 154 ms (memory sample), 338 ms (synthetic swap crossing) and 336 ms (synthetic disk crossing); this does not establish a 250 ms termination bound or real-pressure acceptance. On a crossing the repetition reads `memory-ceiling` with the last sample, the
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
  S7. **Complete Safari benchmark runs currently refuse before fixture preparation or navigation:** automation does not provide an exclusively owned native Safari host/GPU instance. Port connectivity or coalition membership cannot prove that its GPU is exclusive to the harness. No Safari preferences, authentication or user tabs are changed to obtain that proof. Scripted scenario callers remain covered: Safari publishes S7 medians after each completed step, before metadata queries or later switches can fail. Renderer-only data cannot fulfill the renderer-plus-GPU memory/ceiling requirement.
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
- Tauri's production harness now builds a developer-only observer dylib in its results directory and passes it through `DYLD_INSERT_LIBRARIES` in the owned launch. It invokes the Tauri CLI JavaScript through the current Node executable directly: the installed `/usr/bin/env node` shim loses `DYLD_*` through the [protected interpreter](https://developer.apple.com/library/archive/documentation/Security/Conceptual/System_Integrity_Protection_Guide/RuntimeProtections/RuntimeProtections.html). The tiny native proof records both environment paths before testing the production script launcher. The observer reads the view's native renderer/GPU identifiers and that process's one-shot XPC endpoints/audit tokens. OS unique IDs, PID versions, executable paths and parent unique IDs must match the exact bound launcher and native descendant. The view must serve the loopback harness port. Separate one-shot endpoints provide instance evidence; process freshness and group membership never qualify as ownership. Pre-existing, ambiguous or unsupported endpoints fail closed. Private introspection is confined to `scripts/perf/native/` and is never added to the shipped app's APIs.
- Every sampling resolution rechecks native identity, including after asynchronous footprint reads and guard reads. Tauri's self-drive waits for a unique workload admission claim before fetching fixtures or starting decode, switches or exports. The first page gate request starts a 30-second attribution warmup; Cargo startup retains its separate scenario deadline. An admission request drains any earlier in-flight sample, then requires a new complete positive renderer/GPU sample with successful guards. Native attribution is checked again after the swap await, after the readiness tick drains, and synchronously immediately before the caller writes its grant; each check must match the exact identities behind those positive readings. Pending/zero observations cannot grant admission or fabricate zero-byte metrics; genuine partial measurements remain available, including readings captured before a later guard-stage failure. After a valid sample, loss, revocation, ambiguity, changed endpoints, missing footprints and sampling errors/timeouts immediately latch an automatic error and stop the verified workload. Sampling operations have a 2-second timeout; the 250 ms polling interval is not a termination deadline. Final result scope assertions remain an additional success barrier.
- Registered XPC cleanup callbacks retain the enrolled endpoint identity/instance and recheck them before a versioned audit-token signal; a changed/reused endpoint is excluded even if a later snapshot describes a valid replacement. Native cleanup independently enumerates the bound launcher's live descendants, validates current unique IDs, PID versions, paths and parent unique IDs again, then issues individual versioned signals with the host stopped before its launcher. It never sends process-group signals or authorizes a WebKit service from ancestry alone. The [XNU audit-token lookup](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_proc.c) checks PID version atomically; ancestry supplies the owned-child authority separately. If the launcher identity cannot be revalidated, cleanup refuses to signal it or infer new authority. Unknown/shared PIDs never enter a raw kill set. Keys remain `webContentPeakMB`, `webContentLifetimePeakMB`, `webkitGpuPeakMB`; unavailable GPU data is absent. The Tauri scope/footprint barrier runs before its native host is stopped.
- The Tauri launcher enables the opt-in `perf-harness` Cargo feature, creates a fresh private cache claim under the run's evidence directory, and uses nonpersistent WKWebView storage while preserving the configured window geometry. In that feature, a missing, mismatched, public or symlink cache claim fails closed without falling back to the user's application cache; this avoids startup clearing a user's prior display-proxy spill. Normal app builds do not enable the feature. Claims and native proof evidence are retained.
- `node scripts/perf/tauri-platform-proof.mjs <new-evidence-directory>` is a separate bounded actual-application caller check under both shared locks and `caffeinate -di`, after sourcing the shared Cargo environment. It runs the production Tauri scenario/CLI launcher against the actual NegativeConverter debug app, reusing the debug cache. Only its 64x48 test page, attribution revocation and policy inputs are synthetic; it invokes the app's read-only `get_memory_info`, requires both real footprints from automatic sampling, waits for actual workload admission, measures the automatic callback and real native-host disappearance separately, and requires the host plus original renderer/GPU identities to disappear within the tiny proof's 2-second cleanup bound. It checks preservation of another tiny same-origin native instance after every case. The one-byte synthetic ceiling waits at most 1.5 seconds for its read-only bootstrap reply before allowing the first real footprint sample to trigger that guard; no workload is admitted during this wait. Evidence records the bootstrap reply, first real footprint and policy-trigger timestamps and asserts their order separately from workload admission. The revocation case changes only the metadata validator's GPU version after a valid sample and tiny workload admission; revoked endpoints receive no signal, while real OS ancestry authorizes stopping the actual app. The proof script makes no manual sampler ticks; the production caller retains its final successful-scope barrier tick. Guard triggers use automatic sampling. The proof's bounds do not waive the original pressure/termination targets. This is not the release/hardened-runtime configuration, a production frontend workload, a real-pressure latency measurement or the full benchmark. The original WKWebView fixture proof remains separate; R1-006 still needs Safari functionality and required platform acceptance.
- A tiny self-owned WKWebView correctness proof uses the same production launch and memory callers, including launcher-to-native-child ancestry. It checks native getter agreement, distinct GPUs for two instances on the same origin, actual renderer/GPU `proc_pid_rusage` footprints, stale-identity rejection and memory/swap/disk policy aborts. Guard thresholds and swap/disk readings in that proof are synthetic; no real pressure is created. Run it only under the shared test/browser locks and `caffeinate -di`: `node scripts/perf/webkit-ownership-proof.mjs <new-evidence-directory>`. This proves attribution/caller correctness on the tested OS, not Tauri native performance acceptance or guard latency. Hardened runtimes, changed private ABI or blocked injection retain safe refusal; instrumented native timing/bias remains unmeasured.
- Safari imports/switches and Tauri report parts record `scenario.photoN.route` and `.filmType` using the same foreground-request selector as Chrome. Later background requests cannot replace that evidence. Remaining roll photos are visited after all measured switches/exports; Tauri preserves completed parts on rejection and closes an interrupted measurement window. Repeated same-photo switches contribute separate samples to the class median; an incomplete import cannot fabricate zero decode/timer/frame counters.
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
| Cold switch, the target's own pixels (`s7.cold*.firstProvisionalPixelsMs`, p95 `s7.cold.firstProvisionalPixelsP95Ms`) | ≤ 200 ms p95 (#235; #230 had ≤ 300 ms) | 9672 ms (9472–10445), nothing before the exact image | fails |
| 5 presses in 0.8 s (`s7.rapid5.firstProvisionalPixelsMs`) | ≤ 300 ms provisional | target positive 17 376 ms (12 879–26 265); first pixels 6968 (6600–19 416); 5 LibRaw decodes | fails |
| Import, provisional pixels (`s1.firstProvisionalPixelsMs`) | ≤ 300 ms (#235) | none: the first visible pixels were the exact negative at 12.3 s (A) | fails |
| First photo | ≤ 2 s | 13.3 s (A), 5.7 s (B), 13.6 s (12-file roll) | fails |
| Film-edge stage of an import (`s1.stage.filmEdgeMs`) | ≤ 180 ms (#236) | 272 ms (A), 305 ms (B) | fails |
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
browser objects (including the veil's surfaces and bitmap transfers, the
uniform and texture state of draw signatures, the ring's trimming and the
optional heartbeat), metric definitions (provisional and exact pixels, the
pooled p95), source maps and trace analysis, the hang
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

Supplemental caller regressions cover Safari pre-abort retention and per-photo routes, the Tauri probe's actual self-drive/report mapper (including post-export metadata visits and repeated same-photo samples), exclusion/revalidation of unrelated GPU/WebContent PIDs, actual saved full-probe versus subset-control orchestration across scenarios/fixtures/DPRs with strict compared-scope and ordinary base/head gates, and fake-disk runner preparation through a 48-pixel generator. Node simulations remain correctness evidence. The additional tiny native attribution proof described above reads real WKWebView process identities/footprints; it does not fulfill large/native performance targets.

Native ownership source references: [WebKit's view PID getters](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebView.mm), [per-launch one-shot XPC instances](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/Launcher/cocoa/ProcessLauncherCocoa.mm), [XNU unique process identities](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info_private.h), and [versioned audit-token signals](https://github.com/apple-oss-distributions/xnu/blob/main/libsyscall/wrappers/libproc/libproc.c). These are private developer interfaces; runtime proof and exact-size checks are required rather than assuming compatibility from current source alone.

# Hidden-window jobs

Issue: [#241](https://github.com/lexluthor0304/NegativeConverter/issues/241)
(part of the #229 performance program).

A 116-frame 60 MP roll takes tens of minutes to export or analyse, and people
switch to other apps meanwhile. Three mechanisms keep that work going and make
a kill recoverable.

## 1. Hidden jobs keep running

- **No suspension.** `src-tauri/tauri.conf.json` sets
  `app.windows[0].backgroundThrottling` to `"disabled"`, which wry maps to the
  public `WKPreferences.inactiveSchedulingPolicy = None` (macOS 14+; Windows,
  Linux and older macOS ignore it). Without it, WebKit suspends the whole
  WebContent process, workers included, 20 s after the window is minimised,
  hidden or covered. The policy is static: WebKit latches RunningBoard
  throttling per process. `scripts/check-tauri-config.mjs` (in `npm test`)
  checks the value and that no override config (`tauri.appstore.conf.json`,
  `tauri.release.conf.json`) sets `app.windows`, which JSON Merge Patch would
  replace whole.
- **No frame waits on job paths.** A hidden page never fires
  `requestAnimationFrame` and aligns DOM timers to 1 s or more.
  `yieldToPaint.js` has the shared helper (`yieldToPaint`, also exported as
  `yieldForJob`): rAF then `setTimeout(0)` while visible, a `MessageChannel`
  task while hidden, and the hidden branch when the page hides mid-wait.
  `yieldTaskForJob` is the task-only variant for the ZIP CRC loop and the
  roll-analysis frame loop. Batch exports call `processFileWithSettings` with
  `silent: true`, so a never-analysed frame is detected without the blocking
  overlay and its frame wait; detection inputs and geometry are unchanged.
  Readiness polls (the thumbnail lane, roll-analysis retries) stay on timers.
- No Web Lock (Chrome's Energy Saver ignores one that blocks nothing outside
  the page) and no `NSProcessInfo` activity (it had no effect in the probe).

## 2. The hidden-job gate

`hiddenJobGate.js` (pure, unit-tested) decides when a job's next item may
start. Every long job asks it: batch exports and automatic roll analysis
through `runBatchPipeline`'s `beforeStart` hook, which a lane awaits **before**
it claims an index (a lane that waits holds no index later sinks wait for) and
releases after that index's sink; the thumbnail lane, roll-analysis decodes
and contact-sheet frames directly. It counts in-flight items across callers.

| window | rule |
|---|---|
| visible | admit at once (the normal lane plan) |
| hidden, macOS WebKit (desktop app, Safari) | one item in flight; for `HIDDEN_GRACE_MS` (5 min) no byte check; then only if resident + estimate ≤ `HIDDEN_BUDGET_BYTES` (3.3 GB), else wait until visible (running items finish) |
| hidden, Chromium or WebKitGTK | admit at once |

The reason is WebKit's memory policy on a 16 GB Mac: 8 GiB (7 + 1 per page)
while active, 4 GiB (3 + 1) once the process has been hidden for 8 minutes,
polled every 30 s, then killed. The constants live in `hiddenJobGate.js`;
re-check them for each macOS release (set the grace to 0 once WebKit's
UI-process `MemoryFootprintMonitor` ships). #258 replaces the local estimate:

- an item: `max(estimateRawDecodeBytes, pixels × 50 B)` of the batch's largest
  frame (header dimensions; `rawDecodeEstimate.js` keeps the RAW figure
  importable without LibRaw);
- resident: unique backing buffers of the open photo's planes, the undo
  history and both photo caches (`backingBuffers` from `photoSessionCache.js`).

While the gate holds an item back, the header export strip, the roll-analysis
status and the browser batch overlay read "Paused while the window is hidden",
and the page logs the resident breakdown (`[hidden-job] paused while hidden`).

**Shedding.** On macOS WebKit, while a job runs when the window hides, before
each hidden admission, when a hidden job ends, and at the end of the grace
period when idle, the page drops the photo-session and preview caches,
terminates the export-worker singleton when it has no request in flight, and
releases the MI-GAN session unless the running job may use AI repair. (The
RAW post-decode worker, which runs the sensor-defect pass, lives only for its
own decode since #232, so there is no idle one to terminate.) MI-GAN keeps its `sourceRef` and reloads the
same model on the same provider on demand without bumping `aiRepair.revision`,
so photo keys and thumbnails stay valid. An idle window that is only briefly
hidden keeps its warm caches. Showing the window releases waiting items and
restarts the thumbnail lane; caches refill and workers respawn lazily.

**Parking (opt-in).** With `localStorage nc_hidden_park_v1 = 'on'`, a held
item also parks the open photo: its recipe is persisted, only the decoded base
and the undo history are kept, and showing the window rebuilds the planes from
that base through the cold photo-switch path, without a decode. It is off
until a visible 60 MP desktop export's WebKit "Current memory footprint" shows
whether it is needed (#244's lazy planes make it cheaper).

For QA, `localStorage nc_hidden_job_limits_v1 = 'force'` applies the WebKit
rules in any browser, and `window.__ncHiddenJobs.status()` reports the gate
state, cache bytes, live workers, the MI-GAN session and `aiRepair.revision`.

## 3. A kill is recoverable

- **Native.** When a page starts loading, `lib.rs` clears every unfinished
  export stream (`ExportStreams::clear`, deleting its `.part` file) and stops
  the folder watch: a reloaded page could never finish them, and four orphans
  refused every export. On macOS the app registers
  `on_web_content_process_terminate`, which records `{ at, count }`, clears the
  streams and reloads the webview itself (registering the hook replaces
  Tauri's default reload). The page reads the record once at boot
  (`take_web_content_termination`). Folder grants live in the app process, so
  they survive a WebContent reload; after a full restart the folder is picked
  again.
- **Job marker.** `jobMarker.js` keeps one marker per job family in
  localStorage (`nc_job_marker_export_v1`, `nc_job_marker_roll_v1`): files in
  order with output names and whether their recipe was automatic, destination,
  export info and options, and each frame once its sink returned (a desktop
  frame is recorded after the native rename or copy and sync). The marker is
  deleted when the job ends or is cancelled. Each export sink and each analysed
  roll frame schedules the recovery copy.
- **Boot.** A marker left over names the job ("Export of 116 photos to Scans
  stopped after 47"), adds that macOS stopped the web process when the native
  record is present, and points to the recovery flow. After the originals are
  added again and the roll restored:
  - a desktop-folder or download export offers to resume: the full original
    job list with the same names, positions and automatic-recipe flags,
    skipping frames recorded as written whose file still exists
    (`exported_files_exist` checks inside the granted folder). No `_1`
    duplicates, same pixels;
  - a ZIP cannot be resumed (no central directory) and offers a restart;
  - roll analysis resumes with its frames back in automatic analysis unless the
    user had edited them: frame detection runs only for frames without a
    recovered recipe, and the roll-level pass re-runs over the whole group,
    re-decoding frames whose samples died with the page.
- **Crash loop.** A resumed job that stops again runs its next attempt with the
  hidden limits while visible (one lane, photo caches off) and says so.

## Checks

- Unit: `yieldToPaint`, `hiddenJobGate`, `jobMarker`, `hiddenPhotoPark`,
  `batchExportScheduler` (admission before claiming, deadlock), worker and
  cache helpers, the MI-GAN release in `photoSessionLifecycle`, the roll marker
  in `automaticRollImport`; Rust: `ExportStreams::clear`, the termination
  record, the existence check.
- Smoke (`scripts/hidden-job-smoke.mjs`, `--hidden-job-only`): a desktop batch
  with a never-analysed frame completes hidden with rAF never firing and no
  overlay; hiding sheds caches and idle workers and keeps the revision; a
  hidden contact sheet completes; a batch killed after frame 1 is named at boot
  and resumes only the missing frames under the same names and bytes; the
  opt-in park rebuilds an identical export (WARN line otherwise).
- The macOS acceptance runs in #241 (suspension log, footprint after 8 min,
  `kill -9` of the WebContent pid, throughput) need the release app and 60 MP
  files.

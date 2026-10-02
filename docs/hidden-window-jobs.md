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
  Readiness polls (the background photo lanes, roll-analysis retries) stay on timers.
- Nothing holds a hidden job awake: the Web Lock a running job holds (section
  3) only shows that its page is alive, and Chrome's Energy Saver ignores a
  lock that blocks nothing outside the page. No `NSProcessInfo` activity
  either (it had no effect in the probe).

## 2. The hidden-job gate

`hiddenJobGate.js` (pure, unit-tested) decides when a job's next item may
start. Every long job asks it: batch exports through `runBatchPipeline`'s
`beforeStart` hook, which a lane awaits **before** it claims an index (a lane
that waits holds no index later sinks wait for) and releases after that
index's sink; the background photo lanes (roll-analysis pass 1, tiles and the
prefetch, #243) before each job's decode, and roll-analysis decodes and
contact-sheet frames directly. It counts in-flight items across callers.

A background lane asks only once the foreground is idle (`backgroundGate.js`)
and does not hold an admission while it waits for the foreground to let its
job start: when the foreground is busy again after the admission (a hidden
wait, an uncached header read) or after the frame's memory reservation, the
job gives back what it holds and waits for the foreground first. Only its
later steps wait while it holds one, at most 2 s each. A desktop batch export
and Analyze roll keep the foreground busy and admit their own items here, so a
lane that waited holding the one hidden slot would stall them until the window
is shown, with nothing reported as paused. A full-resolution render that only
waits for its first frame does not make the foreground busy for the lanes
while the window is hidden: a hidden page paints no frame, so the render runs
once the window is shown, and roll analysis and tiles go on meanwhile
(`hiddenAdmission.test.mjs`).

| window | rule |
|---|---|
| visible | admit at once (the normal lane plan) |
| hidden, macOS WebKit (desktop app, Safari) | one item in flight; for `HIDDEN_GRACE_MS` (5 min) no byte check; then only if resident + estimate ≤ `HIDDEN_BUDGET_BYTES` (3.3 GB), checked again after the page has shed (`onBudgetHold`), else wait until visible (running items finish) |
| hidden, Chromium or WebKitGTK | admit at once |

The reason is WebKit's memory policy on a 16 GB Mac: 8 GiB (7 + 1 per page)
while active, 4 GiB (3 + 1) once the process has been hidden for 8 minutes,
polled every 30 s, then killed. The constants live in `hiddenJobGate.js`;
re-check them for each macOS release (set the grace to 0 once WebKit's
UI-process `MemoryFootprintMonitor` ships). The figures:

- an item: `max(estimateRawDecodeBytes, pixels × 50 B)` of the batch's largest
  frame (header dimensions; `rawDecodeEstimate.js` keeps the RAW figure
  importable without LibRaw);
- resident: the renderer-wide memory ledger (#258, `docs/memory-budget.md`):
  the open photo's planes, history, the photo caches, the prefetch slot and
  other bounded stores, frames a job keeps and long-lived worker residents,
  each buffer counted once.

While hidden on these hosts the memory budget's ceiling also drops to
`HIDDEN_BUDGET_BYTES`, and every item passes this gate before it reserves its
bytes in the budget (never the other way round).

While the gate holds an item back, the header export strip, the roll-analysis
status and the browser batch overlay read "Paused while the window is hidden",
and the page logs the resident breakdown (`[hidden-job] paused while hidden`).

**Shedding.** On macOS WebKit, while a job runs when the window hides, before
each hidden admission, before an item is held back for its bytes (the gate
then checks it again, so what was shed can let it start), when the gate goes
idle after a job ran hidden, and at the end of the grace period when idle,
the page drops the photo-session, preview and prefetch caches,
terminates the export-worker singleton when it has no request in flight, and
releases the MI-GAN session unless the running job may use AI repair. (The
RAW post-decode worker, which runs the sensor-defect pass, lives only for its
own decode since #232, so there is no idle one to terminate.) MI-GAN keeps its `sourceRef` and reloads the
same model on the same provider on demand without bumping `aiRepair.revision`,
so photo keys, thumbnails, repair stamps and the kept dust pass stay valid: a
settled repair exports without a reload, and an export after a dust-brush
stroke reloads the model and repairs from scratch (`technical-depth.md`). The
stroke's own learned refresh loads it too (`dust-removal.md`). The release
also takes the model of a repair brush armed on Retouch; showing the window
loads it again for that brush.
An idle window that is only briefly hidden keeps its warm caches. A background
photo lane (#243) is a running job only while one of its jobs holds its
admission for a frame's analysis or tile: a lane that rests between jobs,
waits for the foreground or for its admission, or only prefetches is not, so
hiding the window then sheds nothing, nor does the end of that prefetch.
While the window is hidden the lanes keep no base (none goes to the photo
sessions or the prefetch slot) and do not prefetch: every hidden admission
empties the slot again, and the lane would decode the same next photo after
each of its other jobs. Showing the window releases waiting items and
restarts the background photo lanes; caches (the prefetch slot too) refill and
workers respawn lazily, so the first switch after it may be cold.

**Parking (opt-in).** With `localStorage nc_hidden_park_v1 = 'on'`, a held
item also parks the open photo: its recipe is persisted, only the decoded base
and the undo history are kept, and showing the window rebuilds the planes from
that base through the cold photo-switch path, without a decode. Every history
step stays, as a cold entry (#244: its pixels are rebuilt from the base on
restore): a hot one pins the very planes parking drops, so the held item would
stay held. A dust-brush stroke (#259) cannot go cold and is kept as it is. It
is off until a visible 60 MP desktop export's WebKit "Current memory
footprint" shows whether it is needed (#244's lazy planes make it cheaper).

For QA, `localStorage nc_hidden_job_limits_v1 = 'force'` applies the WebKit
rules in any browser, and `window.__ncHiddenJobs.status()` reports the gate
state, cache bytes, live workers, the MI-GAN session and `aiRepair.revision`.

## 3. A kill is recoverable

- **Native.** When a page starts loading, `lib.rs` clears every unfinished
  export stream (`ExportStreams::clear`, deleting its `.part` file), stops
  the folder watch and drops the display proxies the page before spilled
  (`display_proxy_store::reset_spill`; the store stays): a reloaded page
  could never finish or read them, and four orphan streams refused every
  export. On macOS the app registers
  `on_web_content_process_terminate`, which records `{ at, count }`, clears the
  streams and the spill and reloads the webview itself (registering the hook
  replaces Tauri's default reload). The page reads the record once at boot
  (`take_web_content_termination`). Folder grants live in the app process, so
  they survive a WebContent reload; after a full restart the folder is picked
  again.
- **Job marker.** `jobMarker.js` keeps one marker per job family in
  localStorage (`nc_job_marker_export_v1`, `nc_job_marker_roll_v1`): files in
  order with output names and whether their recipe was automatic, destination,
  export info, and each frame once its sink returned (a desktop frame is
  recorded after the native rename or copy and sync). An export also records
  every option it writes with besides each frame's recipe
  (`captureExportJobOptions` in `main.js`): JPEG quality, the sprocket border
  and its edge markings, and dust removal with its AI switch. The job reads
  these, not the controls, for every frame, so edits made during a desktop
  batch never reach its later frames. The marker is deleted when the job ends
  or is cancelled. Each export sink and each analysed roll frame schedules the
  recovery copy.
- **Owner.** While a job runs, its page holds a Web Lock named after the
  marker (`nc_job_owner_<id>`), which the browser releases when the page dies
  (WebKit releases the locks of a terminated WebContent process). Without the
  Web Locks API (Safari before 15.4) the job rewrites a heartbeat into the
  marker every 10 s instead. The job deletes its marker before it lets go of
  the lock. The desktop app has one page, so every marker found at its boot
  is the previous page's.
- **Boot.** `findInterruptedJobMarkers` sorts the markers: one whose lock is
  held, or whose heartbeat is younger than a minute (the margin covers a
  hidden tab's timer throttling), belongs to a job still running in another
  tab and is left alone (a fresh heartbeat is looked at again once it could
  have gone stale); a page never counts its own running jobs. An interrupted
  export is named once ("Export of 116 photos to Scans stopped after 47",
  "…stopped before any was written" when none finished; the count is of
  finished frames, which lanes finish out of order); the marker then records
  that it was reported, and a later launch stays silent while the job stays
  resumable for 14 days. The message adds that macOS stopped the web process
  when the native record is present, and points to the recovery flow. An
  interrupted roll analysis is never named at launch: background analysis
  stops whenever the window closes, and it resumes when its roll is restored.
  After the originals are added again and the roll restored:
  - a desktop-folder or download export offers to resume: the full original
    job list with the same names, positions and automatic-recipe flags,
    skipping frames recorded as written whose file still exists
    (`exported_files_exist` checks inside the granted folder). No `_1`
    duplicates, same pixels;
  - a ZIP cannot be resumed (no central directory) and offers a restart: every
    frame again, with the names, positions and automatic-recipe flags of the
    original list;
  - both write with the marker's format, bit depth and options, never with
    the controls a reload reset, and leave the controls as they are. A
    version-1 marker (before these options were recorded) lacks the edge
    markings, the AI switch and, for browser jobs, dust removal: its resume
    question says that the current ones are used;
  - roll analysis resumes with its frames back in automatic analysis unless the
    user had edited them, and a toast says what stopped: frame detection runs
    only for frames without a recovered recipe, and the roll-level pass re-runs
    over the whole group, re-decoding frames whose samples died with the page.
- **Crash loop.** A resumed job that stops again runs its next attempt with the
  hidden limits while visible (one lane, photo caches off) and says so.

## Checks

- Unit: `yieldToPaint`, `hiddenJobGate`, `jobMarker` (options round trip,
  version-1 markers, lock and heartbeat owners, reported once, the boot
  sentence in zh/en/ja), `hiddenHandOver` (the lanes in a hidden window: no
  base kept, no prefetch, what counts as a running job; the shed before an
  item is held for its bytes; parking frees what hot history pinned; a switch
  keeps a lane's decode from its first task), `interruptedJobResume`
  (main.js's export, boot and resume functions: a desktop folder job killed
  after frame 1 resumes with its options while the controls keep their
  defaults; ZIP restart; version-1 question; another tab's job; roll
  analysis), the job-options parity in
  `exportPlaneLifecycle`, `hiddenPhotoPark`, `batchExportScheduler` (admission
  before claiming, deadlock), worker and cache helpers, the MI-GAN release in
  `photoSessionLifecycle`, the roll marker in `automaticRollImport`; Rust:
  `ExportStreams::clear`, the termination record, the existence check.
- Smoke (`scripts/hidden-job-smoke.mjs`, `--hidden-job-only`): a desktop batch
  with a never-analysed frame completes hidden with rAF never firing and no
  overlay; hiding sheds caches and idle workers and keeps the revision; a
  hidden contact sheet completes; a batch killed after frame 1 is named at boot
  and resumes only the missing frames under the same names and bytes; the
  opt-in park rebuilds an identical export (WARN line otherwise). A TIFF 16-bit
  browser ZIP and a 'Download individually' run, with dust removal (AI off),
  the sprocket border and custom edge markings, killed after frame 1 and
  resumed after a reload: same names, format, bit depth and decoded pixels as
  the uninterrupted run, controls untouched (`hidden-job-resume-smoke.mjs`).
- The macOS acceptance runs in #241 (suspension log, footprint after 8 min,
  `kill -9` of the WebContent pid, throughput) need the release app and 60 MP
  files.

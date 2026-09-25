# Renderer memory budget

Issue: [#258](https://github.com/lexluthor0304/NegativeConverter/issues/258)
(part of the #229 performance program).

With a 60 MP roll open the renderer used to reach 8–9 GB on a 16 GB Mac:
every cache had its own cap, batch and roll lanes planned against a fixed
80 MP pixel budget, and background decodes started whatever the foreground,
the caches and the other lanes held. The desktop app did not even know its
RAM (WKWebView has no `navigator.deviceMemory`). Now one budget decides how
much may be in use at once. It changes when work starts and what is kept,
never how a frame is processed: exported pixels are unchanged.

## Sizing

`budgetFor({ ramBytes })` in `app/memoryBudget.js`:

```
budget = min(0.45 × RAM, (RAM > 16 GiB ? 16 GiB : 8 GiB) − 2 GiB)
```

The second term is WebKit's kill limit for an active WebContent process with
one page (`thresholdForMemoryKillOfActiveProcess`: 7 + 1 GiB, or 15 + 1 GiB
above 16 GiB of RAM) minus a 2 GiB margin for what the estimates miss (GC lag,
WASM heaps, code and image caches). Chromium (Chrome, WebView2) has no such
limit, but the same cap keeps a 16 GB machine out of swap, so one formula
applies everywhere.

| RAM | budget |
|---|---|
| unknown (web) → 8 GiB | 3.6 GiB |
| 8 GiB | 3.6 GiB |
| 16 GiB | 6 GiB |
| 32 GiB | 14 GiB |
| 64 GiB | 14 GiB |

Where the RAM figure comes from (`resolveMemoryRam`):

1. `localStorage nc_memory_ram_gib_v1` (GiB, support and benchmarks: the
   forced 2-lane parity run uses `32`);
2. the desktop command `get_memory_info` (`src-tauri/src/memory_info.rs`):
   `{ totalBytes, availableBytes, engine }` from `hw.memsize` on macOS (allowed
   in the App Store sandbox), `GlobalMemoryStatusEx` on Windows and
   `/proc/meminfo` on Linux, with `engine` `wkwebview`, `webview2` or
   `webkitgtk`;
3. `navigator.deviceMemory × 2^30` (Chrome 147+ reports up to 32 on desktop);
4. unknown: 8 GiB.

The page starts with 3 and 1, and re-sizes once the desktop command answers.
While the window is hidden on the hosts `hiddenJobGate.js` limits (macOS
WebKit), the ceiling drops to that gate's `HIDDEN_BUDGET_BYTES` (3.3 GB, under
WebKit's 4 GiB inactive limit); nothing granted is revoked. The RAW decoder's
low-memory refusal (`checkRawDecodeBudget`) reads the same RAM when it is known
and keeps its ≤ 4 GiB rule.

## Reservations

`createMemoryBudget` keeps the reservations; `reserve(bytes, { priority,
signal, label })` resolves with a handle that its owner releases once the
memory is really gone.

- **Foreground** (the photo being opened) is granted at once, recorded
  synchronously, even over budget, and evicts nothing: one decode that ends in
  seconds.
- **User** (jobs the user started and waits for) and **background** (work the
  app starts on its own) requests wait in one queue, every user request ahead
  of every background one, FIFO within a priority, and only the head is
  granted, so a small request never overtakes a large one. The head is granted
  when no foreground reservation is out and `reserved + retained + bytes ≤
  budget`; if it does not fit, `onPressure(shortfall)` evicts first and the
  check runs again.
- **Progress rule.** A head that still does not fit is granted when no other
  user or background reservation is out: the worst case is one item at a time,
  never a stall.
- A waiting request's `signal` rejects it with an `AbortError`. A granted
  handle is not released by its signal: a LibRaw decode still running must
  stay counted until its owner's `finally`.
- Waiters are re-evaluated on every release, `setBudget` and `poke`, and every
  second while anything waits.

| site | priority | bytes | held |
|---|---|---|---|
| `loadFile` and the cold path of `switchToFile` | foreground | the decode's peak (`estimateRawDecodeBytes` with LibRaw's size, taken at the loader gate after `metadata()`); 12 B/px from the header for PNG/JPEG/TIFF | until the photo has settled (no switch, conversion or geometry build, not provisional, two polls 250 ms apart) or a newer activation supersedes it |
| deferred full-resolution decode of a heavy RAW | foreground | same | until the decode returns |
| Export All lanes (`runBatchExport`) | user | 50 B/px (`LANE_BYTES_PER_PIXEL`) × the batch's largest frame | from `beforeStart` (after the hidden-job gate, before the lane claims an index) until that index's sink ran |
| background lanes: roll analysis (pass 1) | background | 50 B/px of the frame | from before the decode until the job ends |
| background lanes: tiles, including Sync colour re-renders, and the prefetch | background | decode peak + 12 B/px; nothing when the base is a retained session or the prefetch slot | until the tile is written or the base handed over |
| Auto Frame Selected, multi-shot merge, blank-frame search, manual Analyze Roll, contact sheet | user | decode peak + 12 B/px | one frame at a time, until it is dropped |
| automatic roll-analysis decodes and sample fallbacks | background | same | same |

**One chokepoint.** `loadRawFile` awaits `options.reserveDecode(size)` before
every branch decodes: with LibRaw's `width`, `height` and `estimatedBytes`
after `metadata()`, and without a size before a UTIF, embedded-preview or
browser decode. `loadFileToImageData(file, { claim })` passes the caller's
claim (`createMemoryClaim`): a claim reserved up front from the header is
corrected there to the real size (never waiting), an Export All lane's is
`fixed`, and a decode without a claim takes its own. Nothing decodes
unreserved and nothing is counted twice. Background decodes reserve through
the shared decode (`sharedDecodes.open(file, { context: { claim } })`). A
header without dimensions borrows those of a decoded file with the same
extension in the queue (`imagePixelsWithSiblings`); the progress rule covers
the rest.

**No deadlock.** Foreground never waits. A lane reserves before it claims an
index. Every job holds at most one reservation while it waits for the next
(Auto Frame Selected and the roll analysis release per frame; the blank-frame
search keeps its best candidate as retained, in the ledger, not as a
reservation), and every handle is released in `finally`. The hidden-job gate
is always passed before the budget, never after. `batchExportScheduler.test.mjs`
runs three lanes against a budget that fits 1.5 items with a slow first sink.

## The ledger

`createRetainedLedger` counts every `ArrayBuffer` once, attributed to the first
consumer that holds it:

1. **editor**: `loadedBaseImageData`, the `SNAPSHOT_REF_KEYS` planes,
   `displayImageData`, the dust planes and the CPU display buffers (each with
   its `__image16`), a parked photo's base;
2. **sessions**, then **previews** (`photoSessionCache.js`);
3. **history**: only what nothing above holds (#244's exclusive count);
4. **stores**: the prefetch slot, tile sources, watch-folder roll samples and
   the roll-analysis sample stores in use;
5. **jobs**: frames a job keeps between its items;
6. **workers**: long-lived worker residents: the default export bridge (the
   planes of its last request until it is terminated), the auto-frame
   worker's OpenCV heap (`cv.HEAPU8`, reported with each reply) and a warmed
   MI-GAN session (an estimate: 0.7 GB on WASM, 0.25 GB on WebGPU). Workers
   a lane owns are inside its reservation.

It is computed on demand, at an admission and at an idle check, never per
frame.

**Eviction under pressure** (`relieveMemoryPressure`), in order, stopping once
the shortfall is freed, then `poke()`:

1. `photoPreviews`;
2. `photoSessions`, except the entry stored last (`lastStoredKey`): the warm
   1-back switch is never traded for other work;
3. the open photo's full-resolution `processedImageData`, demoted to the
   preview plane by #250's `demoteFullResolutionPlane`, only for a large frame
   (above `LARGE_IMAGE_PIXELS`, where no idle render brings it back) and only
   while no export, repair or full-resolution render needs it; the next export
   converts it again;
4. history: the oldest snapshots lose their pixel references (their steps
   stay; a cold step restores its scalars and rebuilds from the base).

## Lane planning

`planBatchParallelism` plans in bytes: 50 B/px per lane against
`max(legacy, 0.5 × budget)` when RAM is known, else the legacy 4.0 GB (the old
80 MP) or 1.4 GB (28 MP) for devices with 4 GiB or less. Unknown RAM and any
RAM up to 16 GiB plan exactly as before; 32 GiB and more plan two 60 MP lanes.
The planned count is a ceiling: the reservations admit fewer lanes where the
plan is optimistic. `#256`, `#251` and `#232` lower the per-lane constant once
their footprints are measured.

## WebKit: the 30 s purge and the idle check

WebKit on macOS 26.x and 27.0 (WebContent-side monitor) and WebKitGTK measure
the WebContent process every 30 s. From half of `min(3 GiB, RAM)`, 1.5 GiB on
any Mac, the policy is Strict, and every tick then releases critical memory:
decoded image data (film-strip thumbnails), font caches, the page's JIT code
and every worker's (`deleteAllCode`), the SilverCore preview worker included.
WebKit main moved the monitor to the UI process (321179@main) and runs no
periodic purge there; the kill limits stay. Windows (WebView2) has neither.

On WebKit engines (`wkwebview`, `webkitgtk`, or the WebKit UA test on the
web), the **idle check** runs 10 s after the last reservation release and the
last pointer, key, wheel or slider input, once no job, conversion or repair
is running:

1. release idle workers: the default export bridge when it is still alive with
   nothing pending (#250 releases it itself 4 s after a large request), the
   auto-frame/OpenCV worker, and MI-GAN only under #236's idle-release rule;
   semantic analysis already ends with each photo. Each comes back lazily.
2. trim while the ledger exceeds `IDLE_RETAINED_TARGET_BYTES` (1 GiB, to be
   calibrated against the logged footprint): previews, then sessions except
   the one just left (until #249's Tier B can demote it instead), then the
   large open photo's full-resolution plane.
3. never the open photo's other planes, history or anything a job holds.

With #236 (no eager MI-GAN) one idle 60 MP photo should sit at about
0.9–1.1 GB of WebContent (estimate), below Strict, and the idle check keeps it
there after exports and roll analysis.

**Linux.** WebKitGTK accepts memory-pressure settings (`memory-limit`, which
moves Strict) only as the construct-only `memory-pressure-settings` property
of a `WebKitWebContext`, and wry 0.55 builds that context without it; the one
static setter, `webkit_website_data_manager_set_memory_pressure_settings`,
covers the network process. Until wry exposes the property, WebKitGTK keeps
its defaults and the app logs one startup line with the limit it would set
(half of `MemTotal`):
`[memory] WebKitGTK memory pressure: WebKit defaults (Strict from 1.5 GiB); planned memory-limit … MB …`.

## Instrumentation and measurement

With `?debug=1` or the benchmark's `?perf=1`, `window.__ncMemory` exposes
`snapshot()` (budget, retained, reserved per priority, outstanding and waiting
reservations, the ledger breakdown, the RAM and its source, the engine), and
`log()`, every grant (with the rule it was granted under: `foreground`,
`fits`, `pressure` or `progress`), wait, release, abort, resize, eviction and
idle check with its label. The benchmark records both next to each scenario's
footprint (`result.memoryBudget`). `scripts/memory-budget-smoke.mjs` replays
the log in Chrome.

Measuring on a Mac:

- Chrome: the #230 harness samples the renderer's `phys_footprint`
  (`npm run bench:interactive`, `docs/performance-benchmark.md`).
- WKWebView (the direct build): `footprint <WebContent pid>`, and WebKit's own
  log:
  `/usr/bin/log stream --predicate 'subsystem == "com.apple.WebKit" AND category == "MemoryPressure"'`.
  Each 30 s tick logs `Current memory footprint: N MB` (MiB), and a policy
  change `Memory usage policy changed: … -> Strict`. On macOS 27.0 the
  WebContent process forwards these lines to its host app, so they appear
  under the app's own process as `WebContent[<pid>] Current memory footprint:
  N MB`, not under `com.apple.WebKit.WebContent`.

Re-check the WebKit constants and the log format on each macOS release.

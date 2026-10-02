# Apply Crop, the crop view and the page's OpenCV analyses

Issue: [#245](https://github.com/lexluthor0304/NegativeConverter/issues/245)
(part of the performance program #229). Builds on the geometry chain of #244
(`docs/geometry-chain.md`) and the shared yield helper of #241
(`app/yieldToPaint.js`).

## Apply Crop paints first

The handler reads the draft angle and a copy of the rectangle, sets the busy
state, waits for a conversion already running, then shows the overlay with
`show({ immediate: true })` and awaits `yieldToPaint()` (rAF, then a task;
a MessageChannel task while hidden) before anything else runs. `immediate`
adds `.loading-overlay-immediate`, which sets `transition: none` on the
visible overlay, so the first frame shows it fully opaque: Studio's fade uses
`steps(3, end)`, and WebKit cannot run `steps()` timing off the main thread.
`hide()` drops the class, so the fade-out is unchanged. The overlay stays up
through the geometry build and hands over to the conversion's own overlay in
the same task. Every early return goes through the `finally` that clears the
busy state. Apply sets `studioBusy` only when it is free and clears only a lock
it set: one another task holds (a photo's detection tail) stays with it.

## Converting without waiting for the crop-area detection

When the applied frame differs from the stored image area
(`isSameAnalysisFrame`), Apply looks for the image window inside the crop
again. The outcome feeds the conversion: a hit sets `imageArea`, which
drives the analysis region and the colour sample, and lets auto white
balance run; a miss sets `analysisNeedsReview`, which skips auto white
balance. On a roll where the detector misses (most frames of the user's M11
roll), the search held every Apply for about a second before the positive.

Apply now installs the miss outcome (`analysisNeedsReview = true`, the image
area unchanged) and converts at once. That provisional conversion is the
exact result when the detection misses. The detection runs in the auto-frame
worker meanwhile (`startCropDetection`):

- Its input is the <=1 MP point sample of the frame Apply installs, 8-bit
  only (`renderFrameSample(..., { with16: false })`), built from the base by
  the geometry core without waiting for the pool. An 8-bit frame at a
  non-right angle is sampled once the pool has installed it.
  `buildCropDetectionInput` cuts the region around the crop on the page;
  `detectCropAreaInRegion` (the OpenCV half) runs in the worker.
- A hit completes the diagnostics Apply installed, but only between
  conversions: a conversion still running read the miss outcome and
  finishes first. If a conversion ran since Apply, the hit converts again
  (`processNegative({ quiet: true })`), so the analysis area, the colour
  sample and auto white balance follow the image area as in the single pass
  before. That conversion first supersedes every render that read the miss
  outcome (a new `coreReprocessToken`, the full-resolution render state
  cleared, a >16 MP render aborted): a full-resolution render the
  provisional pass armed would otherwise land after it as the exact frame
  and be exported. `processNegative` arms a new one. Until it replaces the
  provisional frame, that frame keeps its flags, so a preview never passes
  for the exact frame (the AI brush, history and export read them). A hit
  that lands before the conversion starts is converted once. A miss does
  nothing more. A miss converts once, a hit at most twice.
- With the expired rescue on, Apply still waits for the detection before
  converting (the rescue measures once per source, whatever the area), now
  after the paint and off the main thread.
- The pending detection ends on a new geometry edit or a second Apply
  (`pushUndo` with a geometry label), a new load, closing the session, and
  an undo or redo, except one that restores an entry taken while the
  detection ran (an edit made after Apply, or the undo or redo entry of
  one): that entry holds the frame being detected, so the detection goes on
  and follows the diagnostics the restore installs. It is current only while
  the geometry Apply installed and those diagnostics are in place.
- On a two-stage import's half-size stand-in (#255) the detection samples
  provisional pixels. The swap to the full decode ends it, applies the crop
  again on the full base with the same rule (`appliedCropDiagnostics`, the
  diagnostics Apply installs) and starts the crop's detection there; the
  photo counts as exact once that has landed (`docs/two-stage-raw-import.md`).
- History taken while the detection runs holds the miss outcome and the
  white balance before the hit. Before #245 the hit was in place before any
  such entry, so every entry taken while the detection is pending carries
  its token (`captureSnapshot`), a slider entry taken at pointerdown and
  committed after the hit included. A hit records itself on the token, and
  restoring such an entry applies it (`restoreSnapshot`): the image area and
  review flags, and the white balance its auto white balance set where the
  entry held the white balance it started from. White balance the user set
  while the detection ran wins (no auto white balance ran then), so an entry
  taken before that edit gets the hit without an auto white balance. Entries
  of another Apply carry that Apply's token. The crop-apply smoke holds the
  detection request while a magenta drag starts and checks that the PNG8 and
  TIFF16 exports, before and after undoing the drag, equal those of the same
  drag made after the hit.
- `settlePendingCropDetection()` is the barrier for everything that reads or
  copies the photo's settings for output: single export (before it persists
  the settings), `ensureFullResolutionReadyForExport`, batch and ZIP export,
  the contact sheet, project save, the photo switch (it waits rather than
  cancels, so the leaving photo is persisted with the outcome), roll sync,
  apply to selected, the roll reference, Copy recipe and its QR code, and
  Apply film type to roll (it persists and restores the photo, and the
  restore would end the detection without its hit).
- The measurements that persist settings read the positive, the analysis
  area and the white balance a hit decides: the gray-point click, the
  expired rescue's analysis (one-click colour correction, turning the rescue
  on, Analyze, and Reset colour when it measures) and lab match's rendering.
  They go through `settleMeasurementInputs`, which also waits for a dragged
  frame's 16-bit plane to come back from the preview worker (#233). With
  either pending, Studio is busy (panel, photo and strip inert) until both
  have settled, a hit's conversion included, and the action then runs as if
  clicked after them; it is dropped if the photo, its load or the edit
  revision changed meanwhile, the gray-point mode was left, or the
  expired-roll entry (the menu, outside the busy panel) was toggled. With
  nothing pending it runs within the click, as before. The crop-apply smoke holds the
  detection request, and the plane's commit after a core exposure release,
  while each is clicked, and compares the settings and the PNG8 and TIFF16
  exports with the same clicks made after waiting
  (`runMeasureWhileWaiting`, on a fixture made large with
  `?largeImagePixels` so the display preview stays the measured frame).
- Known edge cases, accepted: redo right after an undo of Apply that ended a
  pending detection restores the provisional (miss) diagnostics, and so does
  an undo of a geometry edit or a second Apply made while the detection ran
  (that edit ended it; 1703835 had the hit in place before it).
- A visible difference: a hit (rare on the M11 roll) shows the positive
  first with the miss outcome and changes colour or white balance once, when
  the second conversion lands. White balance the user set before that wins.
  Its auto white balance is measured on that second conversion, so a
  conversion setting changed before it lands (core exposure, a film preset)
  is part of what it measures; a Step-3 edit (C/M/Y, curves, gains) is not.
- Until the detection ends, that miss outcome is no request to confirm the
  image area (`cropAreaDetecting()`, a current pending detection): Studio's
  frame notice reads `detectingFrame` with the `detecting` status, as during
  an import's detection tail, the composition pane shows its hint, and the
  filmstrip does not flag the photo for review (`frameNeedsReview(...,
  { areaPending })`). The notice is re-read when the detection starts and
  ends, and the filmstrip is rendered once when it ends, so a miss then asks
  for the image area and a hit does not. Unlike the import tail it sets no
  `studioDetecting`: editing, undo and the strip stay unlocked. The
  crop-apply smoke holds the request, checks the notice, the pane and a
  filmstrip rendered meanwhile, then forces a miss (a uniform region) and
  checks that all three ask for the image area; after a hit none does.

## The page's OpenCV analyses in the warm worker

Crop-area detection, the expired rescue's fog surface and lab match's
alignment used to boot a second OpenCV.js in the page (about 145 MB for the
rest of the session) and run on the main thread. Each is now split into a
page half that builds a small input and an OpenCV half the auto-frame worker
runs (`app/openCvAnalysisTasks.js`):

| request | page half | worker half |
|---|---|---|
| `detect-crop-area` | `buildCropDetectionInput`: <=1 MP sample, region, scale | `detectCropAreaInRegion` |
| `expired-spatial-maps` | `sampleExpiredSpatialInputSliced`: the 160 px area average, in ~12 ms row slices (yieldToPaint interactively, a task yield in batch export and semantic colour), stopping when the photo or source changes or a newer request with other inputs supersedes it (docs/expired-film-rescue.md) | `measureExpiredSpatialMapsFromSample` |
| `estimate-alignment` | `sampleAlignmentGray` of both images, a copy of the lab's 8-bit reference | `matchAlignment` and `warpImageData` (`alignAndWarp`) |

- The worker answers these types before its `analyze-frame` branch; any
  other unknown type now throws. The requests go through the shared
  foreground client (never a roll lane) with the page's buffers transferred,
  not copied. An error from the analysis itself (`taskError`) rejects that
  request only and keeps the warm worker.
- `analyzeExpiredFilm` stays on the page (about 30 ms per pass at 60 MP).
- `createOpenCvTaskRunner` loads the page's OpenCV only when a worker request
  rejects (no Worker, the factory throws, a crash, a timeout), rebuilds an
  input the failed attempt had transferred, and warns once per type. A null
  result is a result.
- The worker is started when the tools come into reach, to hide its cold
  boot after the 30 s idle release (which stays): crop mode, hover or focus
  on one-click colour correction, the Expired tab and the lab-match drawer.
- Parity (`openCvAnalysisTasks.test.mjs`) runs frozen copies of the
  functions before the split against the worker entry points through
  structured-clone transfers, with the real opencv-js build.

## The crop view

Crop mode draws on `#cropCanvas`, whose 2D context has no
`willReadFrequently` (the main canvas has it, which keeps it on the CPU in
Chrome):

- The canvas is sized at display resolution for the turned frame
  (`displayPreviewSize`: canvas area x DPR, 4 MP cap, zoom 1) and its CSS box
  is fitted like the develop view's (`getFullResDisplayReference` returns the
  turned frame's full size while cropping). For an uncropped frame at angle
  0 the two boxes are the same: the ratio control crop mode adds to the
  toolbar is no taller than its buttons (`.studio .toolbar-select`, 30 px),
  so the container keeps its size. At its own 32 px it made the toolbar 2 px
  taller, and the picture shrank and moved when crop mode opened. A toolbar
  that wraps into a second row in crop mode (a narrow window) still shrinks
  the container, and the crop view is fitted to that. The crop-apply smoke
  compares the two boxes (within 1 px).
- The picture is an area-filtered (`app/areaResample.js`) 8-bit proxy of the
  base, sized for either orientation, built in ~8 ms row slices at idle
  after a photo settles and kept per base image. It is drawn with canvas
  transforms: rotation and mirror into the working frame, then the draft
  angle, scaled to the canvas; a tilted frame's corners are drawn black as
  its pixels are. Until the proxy exists, the frame's 700k-pixel point sample
  stands in and is swapped out when the proxy lands.
- The draft rectangle lives in the canvas's pixels (`draft.rotatedSize`).
  Apply maps it by the ratio of the turned frame's full size to that size
  and translates it onto the base-derived frame, as before.
- An angle change (straighten-line release, +-90 degrees) resizes the canvas
  and redraws: no per-pixel JS rotation and no histogram, which is drawn
  once on entry. `cropView.test.mjs` follows single base pixels through the
  drawing transform and through the geometry chain plus
  `applyRotationToImageData`.

## Debug counters

`window.__ncAnalysis` (for the smoke run and #230's scenarios): `tasks`
(worker and fallback requests), `detection` (started, hits, misses, stale,
reconversions, conversions), `cropView` (proxy builds, stand-ins, draws,
histograms, the last redraw's time), `settle()`, `pendingDetection()`,
`converting()` (a `processNegative` in flight), `proxyReady()`, `draftView()`,
`plane()` (whether the 16-bit plane of the frame on screen is still in the
preview worker, on its way back or attached, and whether that frame is the
display preview), `failWorker(true)` to force the page fallback.

## Remaining acceptance runs

Timing criteria (first overlay frame within 100 ms and no task over 50 ms
before it on the 60 MP M11 file and the 10.7 MP NEF, click to positive,
angle-change cost <= 8 ms, memory footprint) and the SHA-256 export parity
on the real files need the #230 harness in Chrome and in the macOS app.

# Geometry chain off the main thread

Issue: [#244](https://github.com/lexluthor0304/NegativeConverter/issues/244)
(part of the performance program #229).

The chain is base → rotation → mirror → crop. `rotationAngle` is measured on
the unmirrored base and `cropRegion` on the rotated (and mirrored) frame.

## One frame-size rule, one core

- `rotatedDimensions(width, height, angle)` in `imageGeometry.js` is the size
  of the frame `applyRotationToImageData` builds. Readers that only need that
  size use it instead of rotating pixels (import frame analysis, the
  mirrored edge-text crop flip, Apply Crop, the memo key).
- `planGeometry(source, geometry)` describes the whole chain as one output
  window; `renderGeometryRows(plan, src, out, y0, y1)` renders any row range
  of it from any source rectangle that holds the pixels those rows read.
  Arbitrary angles are the exact 16-bit bilinear kernel (the 8-bit view is
  `>>> 8` of its result); right angles, mirror and crop are index maps that
  move whole words. Every export (`applyRotationToImageData`,
  `mirrorImageDataHorizontal`, `applyGeometryChainToImageData`), the worker
  pool and its synchronous fallback run this core, so banded output is the
  whole output by construction. Only 8-bit sources at a non-right angle keep
  the 2D-canvas rotation on the main thread.
- Strided plans (`step`) reproduce the chain followed by the step
  downsampler exactly; readers that downsample anyway (the crop view's
  stand-in, Apply Crop's crop-area detection) get their sample without the
  frame. `renderGeometry(..., { with16: false })` leaves the 16-bit plane out
  of such a sample (the kernels render it band by band into a scratch
  buffer), with the same 8-bit bytes. The other way round, a batch frame
  without lens correction asks the pool for `planes: '16'` (#256): the
  16-bit plane alone, `{ width, height, __image16 }`, with the kernels'
  8-bit bytes written into a few rows of scratch. Crop mode itself draws a display proxy
  of the base turned by canvas transforms (#245,
  `docs/crop-apply-and-analysis-worker.md`).

## Pool and ordering

`geometryPool.js` splits the output window into 4–6 row bands (pool size
`min(6, hardwareConcurrency - 2)`). Each band's source rectangle is the
bounding box of its corner pixels' source positions, padded by two pixels
for bilinear plans; the main thread copies it row by row (bilinear bands post
the 16-bit plane only) and yields between band slices and assembly steps.
The base is never transferred. Bands in flight are capped by the band budget
of `planGeometryBandsInFlight` (batchExportScheduler.js: about 20 bytes per
output pixel of a band, 768 MiB shared by the lanes, a third of that on
devices reporting 4 GB or less); interactive builds use the budget of one
lane. A stale job stops posting bands; any worker failure, or no `Worker`,
renders the remaining bands on the main thread with the same core, at most
1 MP per task. Interactive builds also ask for the output's display level
(#248, `render(..., { level: true })`): the bands then start on multiples of
its k, and each band returns its level rows, so the working frame arrives with
the k × k box level the preview worker resamples display images from. Batch
export asks for none. A display proxy fill (#249) asks for the level alone
(`renderDisplayLevel`): its bands read a shared base through views and copy
only the plane the level reads from a plain one, in bands planned by the
bytes they copy (`planDisplayLevelBands`, `docs/photo-sessions.md`). A
lens-corrected frame's fill (#278, `renderLensDisplayLevel`) renders, per
band, the crop rows the lens remap of its rows reads, remaps them with the
band's grid rows (`lensMaps.js`, the editor's remap) and box-averages them,
in bands planned by the base rows they copy and the rows they render.
`counters.copiedBytes` counts every band row the main thread copies, for
both kinds of job.

In `main.js` the scalars change synchronously and the planes follow:

- `applyGeometryFromBase` keys the requested geometry (base identity, angle,
  mirror, crop sanitised against the frame). The installed output carries
  the key it was built for (a `WeakMap` on the object), so a settings-only
  `restoreSettings` makes no kernel call, and undo, a new file or a two-stage
  import's swap to its full decode invalidate it by installing other objects.
  While a half-size stand-in is loaded (two-stage-raw-import.md) the live
  crop is in its units; settings and history carry the exact
  full-resolution crop, and the swap installs that one.
- A miss starts one job (`state.geometryPending`, `state.geometryReady`).
  `processNegative`, export, crop-mode entry, Step 2's border suggestion and
  the frame readers await `whenGeometrySettled()`; film-base sampling ignores
  clicks while a build is pending. A newer edit, undo/redo or a switch
  supersedes the job. The job holds `studioBusy` unless someone else does
  (Studio then makes the panel, the preview toolbar and the photo's brushes
  inert, as for any `studioBusy`), except the swap to a two-stage import's
  full decode (`holdBusy: false`), which never locks editing.
  Cancellation also detaches a full-base history restore's live promise and
  WB event. It leaves the measurements saved entries own intact; an obsolete
  finalizer cannot clear the next operation's binding. A settings replacement
  cancels an owned restore even when its geometry key matches a pending job.
  A geometry/analysis edit captures its outgoing history entry first, then
  cancels that owner, including Confirm when the planes do not change.
  Intent cancellation keeps the interim display so consecutive turns/mirrors
  still compose until the replacement planes are installed.
  Reset all adjustments likewise captures before cancellation. If geometry
  is still pending, it rebuilds the requested frame and converts the reset
  recipe after that build; it never adopts the superseded planes.
  A positive recipe captured before its first positive exists is cold too,
  even after an obsolete restoration owner has been detached.
- Rotate 90° and mirror turn or flip the current display with CSS at once
  (UI only; composed when edits follow each other); the first paint of the
  new planes removes it, on the GL display or on `#canvas`, with the film
  border or without.
- A build that fails while it is still the current one (a plane the pool or
  the canvas cannot allocate, the original of a photo restored without it
  that cannot be decoded again, #249) is rolled back, so the settings never
  name a geometry the planes were not built with (a conversion, an export and
  the saved recipe would pair them). The edit that asked for it hands its
  undo entry to the build: while that entry still holds the planes on screen
  it is restored as Undo restores it, without a redo step; otherwise
  `rotationAngle`, `mirrored` and `cropRegion` are taken from the planes'
  key and the photo is converted again. The interim CSS goes, and a toast
  says the rotation, mirror or crop could not be applied. A settings refresh
  (`restoreSettings`: a switch, a roll commit) that fails the same way keeps
  the planes' geometry too, and leaving the photo saves that. Only planes of
  another base (a two-stage import's stand-in after its swap) cannot be
  rolled back: `processNegative` builds the planes the settings name first
  and converts nothing when that fails again, and an export refuses
  (`geometryOutOfStep`).
- A tilted import rotates once, in the pool: the auto-frame worker returns
  the rotated frame's size only (#251). Only the Auto Frame button still
  gets the worker's rotated planes, and the build adopts them when base and
  angle match (the exact 16-bit kernel, or any source for the button).
- Rotate and Apply Crop derive the frame from the base by the total angle.
  Apply Crop translates the rectangle drawn on the draft canvas D onto that
  frame F by `((Fw - Dw) / 2, (Fh - Dh) / 2)`. This is the one flagged pixel
  change: before, an edit on an already rotated (or mirrored) frame resampled
  that frame again, and its crop drifted against restore and batch export.
  Now single export, batch export and `restoreSettings` agree. Right-angle
  edits of an untilted frame are pure permutations and unchanged.

## What is kept

- Beside a crop, `state.originalImageData` is a size-only frame descriptor
  (`__geometryFrame` holds the base and the key). Only the crop window is
  built. The rare reader of the whole frame's pixels (recipe defaults, flat
  field defaults) awaits `geometryFramePixels()`; a synchronous read still
  works but is counted (`window.__ncGeometry.diagnostics.frameSyncReads`).
  Walks over state and history never read the pixel getters
  (`backingBuffers`): the session and history byte counts, and the probe
  that keeps an export from transferring or releasing an editor plane
  (#250), which counts the base and any pixels a reader already built as
  live. The histogram never reads a descriptor, nor the size-only stand-in
  a photo switch leaves while the next photo decodes: a redraw (a window
  resize) keeps the last histogram. Without a crop the working frame is the
  output itself.
- Hidden brush-history archives store lazy frame descriptors as their base,
  geometry key and any pixels already built, without reading pixel getters.
  Restore recreates the lazy descriptor and its aliases, reinstalls geometry
  memos for hot Undo/Redo, and preserves nonenumerable 16-bit planes and the
  derived-8-bit sampling flag. A missing descriptor restorer fails storage
  before live history can be released. Writes remain bounded to 8 MiB.
- History counts only the bytes it holds exclusively (`backingBuffers` over
  undo/redo minus live state), after every edit, Undo and Redo. Over
  768 MiB the oldest entries become cold (pixel references dropped, scalars
  kept) instead of being removed: from the bottom of the undo stack, then
  from the far end of redo; an entry that holds only what live state holds
  (a slider step on the planes on screen) frees nothing and stays hot. A new
  edit drops the redo branch before the budget is applied. The geometry
  entry pushed last stays hot beside the budget (entries are numbered as
  they are pushed): after an edit the newest geometry entry of the undo
  stack, after an Undo of a geometry step its redo entry, after a Redo of
  one the undo entry it pushed. Undo right after a geometry edit, and Redo
  or Undo right after the other, are reference swaps even when one snapshot
  is larger than the budget (a 60 MP crop). A cold entry, or one captured
  while a build was pending, restores its exact scalars and rebuilds its
  planes from the base in the pool, then converts without new automatic
  measurements. A stripped entry keeps the dust state it settled (#281,
  `docs/dust-removal.md`), compacted once nothing else holds it; the
  detection after that conversion puts it back instead of detecting again. Promoted two-stage entries replay their full-base crop/WB
  event (`docs/two-stage-raw-import.md`). Snapshots captured while that history
  rebuild or measurement is pending also stay cold and retain the same event,
  even after geometry/detection finish, so temporary pixels or WB cannot
  bypass replay on a later Undo or Redo. Dust-brush stroke entries (#259, `docs/dust-removal.md`)
  patch the objects they hold and cannot go cold; only when history is
  still over budget after that is the oldest one dropped, with everything
  older on its stack.
- Photo sessions: see `docs/photo-sessions.md` (cold session entries,
  releasing the outgoing photo on a switch).

Full-resolution 8-bit planes of the base and of the crop are still kept.
Deriving them on demand (RGB `>>> 8`, alpha by the producer's rule) needs
every full-resolution 8-bit reader moved to derived inputs; the base plane is
produced by the post-decode worker of #232 and the display preview by #248.

## Debugging

`window.__ncGeometry` exposes the counters (`diagnostics`, `main`, `pool`),
`pending()`, `disableWorkers()` (the synchronous fallback) and
`inspect({ chain })`: plane hashes, the same chain built on the main thread
from the base, the unique bytes held by state, history and photo sessions,
and how many rotated-frame-sized buffers are reachable.

## Verification

```sh
npm test    # imageGeometry.chain (core vs HEAD, 1–6 bands), geometryPool, geometryMemo, geometryHistory
PORT=5215 CDP_PORT=9239 npm run test:smoke -- --geometry-only
```

The geometry smoke checks the planes against the export chain and, after
Rotate 90°, what the screen shows: the display preview's aspect turns, the
GL source texture is uploaded again at that size (`__ncDisplay.frame().texture`)
or `#canvas` holds the turned frame, and the interim CSS is gone. It repeats
rotate and mirror with the film border on, on the GL display and in a CPU
mode. geometryHistory.test covers the budget across Undo and Redo, the
border's paints, the histogram's redraws without pixels and a photo switch
while a build is pending.

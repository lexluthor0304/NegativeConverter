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
  downsampler exactly; readers that downsample anyway (the crop draft,
  Apply Crop's crop-area detection) get their sample without the frame.

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
1 MP per task.

In `main.js` the scalars change synchronously and the planes follow:

- `applyGeometryFromBase` keys the requested geometry (base identity, angle,
  mirror, crop sanitised against the frame). The installed output carries
  the key it was built for (a `WeakMap` on the object), so a settings-only
  `restoreSettings` makes no kernel call, and undo, a new file or a heavy-RAW
  upgrade invalidate it by installing other objects.
- A miss starts one job (`state.geometryPending`, `state.geometryReady`).
  `processNegative`, export, crop-mode entry, Step 2's border suggestion and
  the frame readers await `whenGeometrySettled()`; film-base sampling ignores
  clicks while a build is pending. A newer edit, undo/redo or a switch
  supersedes the job. The job holds `studioBusy` unless someone else does.
- Rotate 90° and mirror turn or flip the current display with CSS at once
  (UI only; composed when edits follow each other); the first paint of the
  new planes removes it.
- The import adopts the auto-frame worker's rotated frame when base and
  angle match and the exact 16-bit kernel built it, so a tilted import
  rotates once. Batch lanes do the same.
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
  Without a crop the working frame is the output itself.
- History counts only the bytes it holds exclusively (`backingBuffers` over
  undo/redo minus live state). Over 768 MiB the oldest entries become cold
  (pixel references dropped, scalars kept) instead of being removed; the
  most recent geometry entry stays hot so undoing it is a reference swap. A
  cold entry, or one captured while a build was pending, restores its exact
  scalars and rebuilds its planes from the base in the pool, then converts
  without new automatic measurements. Dust-brush stroke entries (#259,
  `docs/dust-removal.md`) patch the objects they hold and cannot go cold;
  only when history is still over budget after that is the oldest one
  dropped, with everything older on its stack.
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

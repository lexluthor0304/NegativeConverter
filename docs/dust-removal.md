# Dust removal: TELEA per cluster and regional brush strokes

Dust removal detects specks and scratches with a dual top-hat (see
`DustRemoval.js`), repairs them with OpenCV's TELEA or, when AI repair is on,
with MI-GAN (`technical-depth.md`). This page covers how the TELEA repair and
the dust brush stay proportional to the dust, not to the frame (#259).

## TELEA per cluster (`inpaintMasked`)

TELEA is local. A masked pixel takes its value from known pixels within the
inpaint radius, weighted by distances the fast-marching pass computes one or
two pixels further out, so mask pixels more than `2 × (radius + 2)` apart never
influence each other.

- The mask is scanned once (empty 32-bit words are skipped) and looked at
  through a grid of cells `2 × pad` wide (`pad = radius + 2`), aligned to the
  frame origin. 8-connected occupied cells form one cluster
  (`dustMaskClusters`). The grid may merge clusters that did not need it but
  never separates two that interact.
- Each cluster is repaired in its own crop (its pixel box grown by `pad`), with
  a crop mask that holds only its pixels. Only masked pixels are written back:
  RGB8 from the crop, 16-bit = 8-bit × 257. Alpha and every other pixel keep
  their source values.
- The result is bit-identical to one full-frame `cv.inpaint` wherever that
  fits (`DustRemoval.partition.test.mjs`). It also fits the 1 GiB heap compiled
  into OpenCV.js at any frame size: the full-frame call needs about 19 B per
  pixel and failed above about 50 MP, where HEAD ran a JS stand-in that left
  every speck of a dilated mask in place.
- Only a single cluster too big for the heap (a stroke or a dense chain across
  most of a 50 MP+ frame) is split into windows with a `4 × pad` halo, with one
  console warning. That is the one inexact case; a full-frame call already
  failed there.
- There is no JS fallback. An OpenCV error reaches the caller: the dust status
  line, the export error, or the batch file's error.

The detect-time commit, single export, batch export and the main-thread
fallbacks all call `inpaintMasked`, so all of them get this.

`scripts/bench-dust-inpaint-60mp.mjs` is the 60 MP acceptance run (an `inpaint`
request through the worker processor in a fresh OpenCV instance: every speck
repaired, heap < 512 MB, ≤ 400 ms in V8). It is too heavy for `npm test`; run it
alone, one heavy job at a time.

## Pinned dust worker (`dustWorkerClient.js`)

While dust removal and Show mask are on for the current photo (the brush can
paint only then), `main.js` pins the shared dust worker (`syncDustWorkerPin`):

- no idle release while pinned; unpinned on photo switch, dust or Show mask
  off, and in `clearDustState`, after which the 30 s idle release applies again;
- `dustWorker.pinned` is the reservation a memory ledger (#258) can see;
- at pin start, and at every detection while pinned, the worker gets the clean
  source's 16-bit plane (and the 8-bit plane or the mask when it lacks them) in
  slices of at most 32 MB, one per task, so no copy blocks the page for long;
- a lost worker (crash or trim) is re-seeded once, in slices, by the next
  stroke, which then also carries the mask.

The worker keeps the current mask under a tag the page chose
(`state.dustRemoval.maskTag`) and that mask's full-frame particle count, taken
right after detection while pinned.

## Regional stroke protocol (`DustBrush.js`)

A stroke posts `{ type: 'stroke', baseTag, tag, points, brushRadius, mode }`, a
few hundred bytes. In the worker (`applyDustStroke`):

1. The brush is rasterised into its own bounding box with the full-frame rule
   it replaced, then cut to the tight bounds of its pixels.
2. The mask is refined in place inside that box: `intelligent` runs the same
   Scharr, blur and contour steps on the same tight crop; `direct` and `remove`
   apply OR / AND-NOT.
3. The affected rect R starts at the box grown by `pad` and is closed over
   every cluster of the old or new mask it reaches, until none crosses R.
4. R is repaired from the clean source (`inpaintMaskedRect`): the clean source
   everywhere, TELEA on new-mask pixels. Clusters the stroke did not touch come
   out byte-identical, so the patch needs no write mask.
5. The particle count moves by the external contours of the old and the new
   mask inside R. When R could lie in a hole of a component outside it (no
   straight background run joins R to the frame edge), the frame is recounted.

The reply carries R's 8-bit and 16-bit bytes, the stroke box's mask bytes and
the count, all transferred. `DustBrush.test.mjs` checks 200+ random strokes
(all modes, edges, corners, points off the frame) against the full-frame path:
`createBrushMask` + `refineMask*`, full-frame TELEA and full-frame
`findContours`.

## Page side (`main.js`, `dustStrokeHistory.js`)

- **Private buffer.** Patches go into `state.dustRemoval.inpaintedImageData` in
  place; `cleanSource` is never patched. When there is no repaired image yet,
  the clean source is cloned once, at pin time.
- **Revision.** `state.dustRemoval.revision` changes on every patch, undo, redo,
  detection and clear. Export and the learned-repair refresh compare it
  instead of mask identity; the tint follows the mask's tag. Export reads a
  copy of the mask.
  A committed repair's export recipe (#246, `repairReuse.js`) records the
  revision too, and a patch, undo or redo forgets the stamp of the image it
  writes and the content hash of the mask it writes, so an export after a
  stroke always runs the from-scratch pass.
- **History.** A stroke's undo entry (`pushUndoDelta`) holds R's bytes before
  and after, the mask box's bytes and the counts, not another full image and
  mask. Undo and redo write them into the objects the stroke patched and make
  those current again, strictly LIFO, and post the mask change to the worker.
  They start no conversion and no detection and keep earlier refinements.
  `dustStrokeHistory.test.mjs` interleaves strokes with slider, strength, crop,
  AI-export and photo-switch steps. A stroke entry cannot go cold under the
  history budget (#244, `docs/geometry-chain.md`): when history is still over
  budget once every other entry is cold, the oldest stroke entry is dropped
  with everything older on its stack. A photo session cached without its
  planes keeps no stroke entries.
- **Display.** Only the preview pixels whose bilinear taps fall in R are
  recomputed (`updateDisplayPreviewRect`, exact), the WebGL source texture gets
  a `texSubImage2D` of that rect, the tint cells over the mask box are put on
  the display overlay, and the histogram source is rebuilt on idle.
- **Tint and brush feedback (#253, #254).** The mask is shown on
  `#displayOverlay`, a canvas in the transform wrapper at the display frame's
  size (at most the display-preview cap), so zoom and pan only move it and the
  view stays on the GPU. A tint cell is set when any mask pixel inside it is
  set (max-pooling, `dustTint.js`), so one-pixel specks show at fit. The dust
  worker pools it: `detect` (while the mask is shown) and `stroke` requests
  carry the overlay's size, and the replies carry the whole tint or the cells
  over the stroke's mask box; the page only puts them. A mask that changes
  without such a reply (a restored session, a new display size, the page
  fallback) is pooled on the page in row bands of about 8 ms; an undo or redo
  pools the stroke's box alone. The
  stroke being painted is drawn on `#brushFeedback` (`brushFeedback.js`):
  pointer events (touch and pen paint too, `touch-action: none` on the view
  while a brush is active), coalesced samples at least a device pixel apart,
  one draw per animation frame of the new segments only, round-capped lines of
  the brush's width. `#canvas` is not written while a stroke is painted.
- **AI repair on, or repair strokes present.** The TELEA patch also overwrote
  MI-GAN pixels inside R. After a 200 ms debounce only the tiles over queued
  rects are inferred again, on a window of the repaired image, and only the
  rects are written back. The refresh lands only if the dust revision did not
  change; it then amends the newest stroke's history entry, otherwise its
  rects stay queued. Each refresh is a model run for #236's idle release.
  This is preview only: export still runs the from-scratch MI-GAN pass over
  the whole mask.
- **A released model (#236, #241).** With AI repair on, or repair strokes
  present, a model that the idle rule or the hidden window released is still
  the repair's inpainter, never a reason to take TELEA as the repair: a stroke
  queues its rect, and the refresh keeps it queued, loads the model again (on
  its provider, under its revision) and runs once it is back (a failed load
  leaves TELEA for the dust, as an error state does). An export after a stroke
  loads the model too, with the load on its overlay, and repairs from scratch;
  when the model cannot be loaded (offline without a cached copy) the export
  fails with a message instead of shipping TELEA in its place. A settled
  repair keeps its stamp across the release and is exported without a load.

## Known limits

- Batch export still re-detects dust per file and ignores brush edits
  (`audit-backlog.md`).

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
   mask inside R. That is exact unless R lies in a hole of a component
   outside it (`findContours` skips what sits in a hole; holes are
   4-connected background, and the frame edge is open). R's border ring is
   background, so the frame is recounted unless the background around R is
   shown to reach the frame edge (`mayBeEnclosed`): by a straight run from
   R's corners, or, when dust blocks all four, by a search of that background
   (`searchBackgroundToEdge`) that expands, in turn, the reached pixel
   nearest each frame edge, so it crosses open background in straight lines
   and climbs out of pockets. A search that finds the background closed, or
   passes 8 × (width + height) expansions, means a recount.

The reply carries R's 8-bit and 16-bit bytes, the stroke box's mask bytes and
the count, all transferred. `DustBrush.test.mjs` checks 200+ random strokes
(all modes, edges, corners, points off the frame) against the full-frame path:
`createBrushMask` + `refineMask*`, full-frame TELEA and full-frame
`findContours`, and that each stroke box is the tight bounds of its brush.
`DustBrush.enclosure.test.mjs` checks the enclosure test: built cases
(blocked runs, a pocket facing away from the nearest edge, diagonal joints,
one-pixel gaps, a U closed only by the frame edge, closed rings), the search
against a full background flood on random masks, and a 12 MP run at the #229
review's dust densities with hairs: no random stroke recounts the frame (the
four runs alone recount 9 % and 34 % of them), strokes inside closed loops do,
and every count equals a full recount.

## Page side (`main.js`, `dustStrokeHistory.js`)

- **Private buffer.** Patches go into `state.dustRemoval.inpaintedImageData` in
  place; `cleanSource` is never patched. When there is no repaired image yet,
  the clean source is cloned once, at pin time. Undo and redo are not blocked
  while an export runs, so a single export marks the repaired image and every
  image a stroke entry patches (`markInPlaceEditedPlanes`) before it hands the
  planes to its worker: the bridge copies a marked plane in one task, never
  in 32 MiB slices an undo could land between.
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
  budget once every other entry that holds pixels of its own is cold, the
  oldest stroke entry is dropped with everything older on its stack. A photo
  session cached without its planes keeps no stroke entries.
- **Undo across a conversion.** Undoing or redoing any other step (a core
  slider, the strength, a crop, an AI-brush stroke) puts back that step's dust
  state by reference, mask, repaired image and particle count, and converts
  the frame again. Its landing used to detect dust from scratch and drop every
  brush refinement. A snapshot records whether its dust state was a finished
  repair of its clean source (`refs.dustSettled`: no detection, brush repair
  or learned refresh owed, a known inpainter). The restore hands a settled
  state to the conversion (`restoredDust`); `resetDustForCleanSource` passes
  it on when the conversion lands, if only strokes and their undo changed it
  since, on the same clean source with the same dust inputs; and the
  detection that follows (`keepRestoredDust`) keeps it as it was once the new
  frame proves to have the restored clean source's pixels (8 and 16 bits,
  compared in 32 MB slices: `sameFramePixels`) and the inpainter is the one
  recorded. The clean source stays the restored object, which the stroke
  entries name, and the repair's stamp carries over as on a session restore,
  so the export equals the one made before that step. Anything in doubt
  detects from scratch, as before: a frame with other pixels (a snapshot taken
  while its frame lagged its settings, an input outside history), a state its
  snapshot had not settled (that mark travels with the restored state),
  other dust inputs or another inpainter. `dustUndoKeep.test.mjs` runs
  main.js's history, conversion landing, detection and export repair step on
  real OpenCV detection, TELEA and strokes; in the browser,
  `dust-undo-smoke.mjs` (full run; alone `--dust-undo-only`) undoes an
  Exposure drag after a stroke and compares the PNG 8-bit and TIFF 16-bit
  exports with those made before the drag.
- **Cold entries (#281).** History's budget (#244) strips its oldest entries
  of their pixel references: after a later edit, an Undo or a Redo, and under
  memory pressure. From about 30 MP that dropped the only copies of a step's
  clean source and repaired image, and the entry's undo detected dust again,
  losing the settled mask, the particle count and every brush refinement. A
  stripped entry now keeps the dust state its snapshot settled
  (`coldRefsFor`):
  - by reference while live state, a restore in progress, a stroke entry or
    an entry that keeps its pixels still holds its mask or repaired image.
    Those bytes are held anyway, and strokes and their undo still write into
    them, so only the history position their content matches may read them
    (LIFO, as for hot entries);
  - compacted once nothing else holds them (`compactColdDust`,
    `dustColdState.js`): the mask's set pixels as runs of pixel indices with
    their bytes, the pixels where the repaired image differs from the clean
    source as runs with their RGBA8 and RGBA16 values, and the clean source's
    digest (its size and the MurmurHash3 x86_128 of its 8- and 16-bit
    planes). Every cold entry that names the same objects is compacted at
    once and shares the pixel record (each keeps its own count, inpainter
    and repair stamp), so nothing can write into the objects while the
    record is filled. That runs off the edit's task in slices of about a
    million pixels (`startColdDustJob`; the memory ledger counts what it
    holds until it ends), stops when no entry wants the record any more, and
    finishes at once before history goes into a photo session or the
    parking archive.

  A record costs a byte per masked pixel, 12 bytes per repaired pixel (4 +
  8) and 8 bytes per run of consecutive pixels of each: 556 kB for a 60 MP
  frame with 400 particles (37 399 masked pixels), where the planes it stands
  for are 1.5 GB. Records count against history's budget; one over 96 MiB is
  not kept, and only when history is still over budget after the strokes
  went do the oldest records go. At 60 MP the edit that makes an entry cold
  takes about 1 ms for it, and the compaction about 1 s of slices of at most
  a few tens of ms (`scripts/dust-cold-undo-60mp.mjs`).

  Undo or redo of a cold entry rebuilds its planes from the base and converts
  them, as before (#244). The detection after that conversion
  (`keepColdRestoredDust`) then puts the dust state back instead of
  detecting, when nothing changed the dust state or its inputs since the
  restore, the inpainter is the one recorded, and the converted frame proves
  to be the clean source: compared byte for byte with a clean source kept by
  reference, else by its digest. A compacted state's mask and repaired image
  are rebuilt on that frame (a copy in 32 MB slices with the record's pixels
  written back), which becomes their clean source; a committed repair's stamp
  carries over when it had no lens mapping. A compaction still running is
  waited for. Anything in doubt detects from scratch, as before.
  `dustColdUndo.test.mjs` runs main.js's history, budget, conversion,
  detection and keep steps with the budget scaled down so entries go cold at
  12 MP and less; `scripts/dust-cold-undo-60mp.mjs` is the 60 MP run with the
  real budget (too heavy for `npm test`); the dust-undo smoke makes the step
  before its Exposure drag cold (`__ncMemory.pruneHistory(0)` with
  `?debug=1`) and compares the exports after its undo.
- **Display.** Only the preview pixels whose bilinear taps fall in R are
  recomputed (`updateDisplayPreviewRect`, exact), the WebGL source texture gets
  a `texSubImage2D` of that rect, the tint cells over the mask box are put on
  the display overlay, and the histogram source is rebuilt on idle.
- **Repaired preview (#237 phase 2).** The stroke hands its mask box to
  `rememberRepairMasks(source, patch.maskRect)`, which pools only that box into
  the kept display-size pool (`repoolRepairMaskRect`: equal to pooling the
  whole mask again). The fill itself is made again once input pauses for
  300 ms, from the display negative the preview repair worker kept, so the
  stroke scans no whole mask, asks the preview worker for nothing and posts
  nothing; the fill after it posts the display-size mask only (#229 review
  R1-104, `repairedPreviewStroke.test.mjs`). An undo or redo of a stroke
  leaves the fill as it was, as before; the next stroke's fill pools the whole
  mask again, since `revision` moved by more than that stroke.
- **Tint and brush feedback (#253, #254).** The mask is shown on
  `#displayOverlay`, a canvas in the transform wrapper at the display frame's
  size (at most the display-preview cap), so zoom and pan only move it and the
  view stays on the GPU. It takes the photo canvas's box; with the border
  preview its backing is the framed display size and the tint is put at the
  photo's offset in it, so tint and photo share one pixel grid (#279). A tint cell is set when any mask pixel inside it is
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
  the brush's width. `#canvas` is not written while a stroke is painted. The
  brush stores the pointer rounded to a pixel, and `DustBrush` stamps each disc
  around that pixel, centred on its centre; the live stroke is drawn through
  those centres (`dustDiscCentre`), so the dab lies where the disc is committed
  (#279 follow-up). It used to be drawn at the pixel's corner, half a pixel up
  and to the left of the disc: in the display-modes smoke (1500 px fixture, DPR
  1) 0.76 to 0.84 CSS px off the committed disc at 381 % with the border and
  1.14 to 1.17 px without it; now within 0.1 px at 100 % and 381 %. The smoke
  reads the disc back from the mask (`__ncBrush.maskWindow`) and measures the
  dab and the tint against it. The stored points, the mask and exports are
  unchanged.
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
  its provider, under its revision) and runs once it is back. A failed load
  leaves the model failed, and no stroke loads it again on its own: the next
  refresh drains the queue, with TELEA for the dust and the repair strokes in
  the rects as the stroke left them (the repaired image has no stamp, so export
  repairs from scratch). A refresh run that fails marks the model failed the
  same way. So the queue always drains, the photo settles and a photo switch
  keeps its view and history. An export after a stroke loads the model too,
  with the load on its overlay, and repairs from scratch; when the model cannot
  be loaded (offline without a cached copy) the export fails with a message
  instead of shipping TELEA in its place. Repeated exports after that failure
  also fail until the model is explicitly reloaded; a previous model error
  does not authorize a different repair algorithm. A settled repair keeps its stamp
  across the release and is exported without a load.
- **The refresh's memory.** The refresh keeps the repair strokes' frame-sized
  mask with the clean source it was built for, and drops both with that source
  (a new conversion, `clearDustState`) and with the photo
  (`invalidatePhotoActivation`: every switch, New session, a parked photo).

## OpenCV build: SIMD and scalar (#292)

Dust detection, TELEA and the brush refinement run on whichever OpenCV build
the page chose (`docs/cross-origin-isolation.md`: the WASM SIMD build where
the engine validates v128, the package's scalar build otherwise or with
`?opencvSimd=0`). Both builds give the same masks and the same pixels; only
the time differs. Measured 2026-10-09 (M1 Pro, Node 26.5.1, both builds in
one process on the same planes, load average 35–180 from other agents, so
the times carry noise; harness in `notes/292-harness/`, rows in
`notes/results/measure-292.md`):

- **Parity.** `detectDust` masks and particle counts, `inpaintMasked` in
  8-bit and in the 16-bit plane (radius 3 and 5) and `refineMaskIntelligent`
  (40 strokes each) are byte-identical on the synthetic frames at 640×480,
  1500×1000 and 3000×2000 (60–400 specks) and `detectDust` at 24 MP
  (6000×4000, 12 164 particles); `detectDust` masks on the 20 M11 frames
  downsampled to 24 MP and on L1000617 at 60 MP are identical as well.
  `DustRemoval.partition.test.mjs` (17 frames bit-identical to one
  full-frame TELEA), `DustBrush.test.mjs` (200+ strokes against the
  full-frame path), `DustRemoval.regional/inpaint`, `DustBrush.enclosure`,
  `dustWorkerProcessor`, `dustWorkerMemoryResize`, `dustStrokeHistory` and
  `dustWorkerClient.shared` pass on the SIMD build
  (`NC_OPENCV_VARIANT=simd node -r ./scripts/opencv-variant-preload.cjs`).
  So dust exports do not change with the build.
- **Speed, scalar → SIMD (medians).** Detection at 24 MP: the dual top-hat
  (Scharr, morphology, blur, threshold, contours) is where SIMD pays:
  2324 → 433 ms on the synthetic 6000×4000 frame (harness, 3 runs);
  `scripts/benchmark-dust-performance.mjs 6000 4000`: direct 2375 → 423 ms
  (second pass 2438 → 431), in its worker thread 2315 → 453 ms; on the 12
  frames of the M11 B&W roll (L1000617–628) downsampled to 24 MP, median
  of the per-frame medians (3 runs) 1392 → 325 ms (−77 %; 1324–1437 →
  252–511 ms); on the full 60 MP L1000617 14 464 → 2 909 ms. Detection at 3000×2000
  513 → 100 ms, at 1500×1000 141 → 28 ms. TELEA itself is not vectorised:
  `inpaintMasked` at 3000×2000 34 → 32 ms (radius 3) and 43 → 42 ms
  (radius 5); `scripts/bench-dust-inpaint-60mp.mjs` (9504×6320, 400 specks)
  199 → 193 ms in an idle pass and 596 → 278 ms in a pass at load average
  180 (the scalar run then exceeded the bench's 400 ms bound; the earlier
  pass did not). `refineMaskIntelligent` 27 → 21 ms at 640×480, unchanged
  at 1500×1000 and 3000×2000 (the stroke cost is the crop and the
  contour pass).

## Known limits

- Batch export still re-detects dust per file and ignores brush edits
  (`audit-backlog.md`).
- A stroke entry still holds the planes it patched, so once they are off
  screen history's budget drops it with every older step (#259): at 60 MP
  with dust removal on, strokes made before a conversion are dropped at the
  next edit. The step before that conversion keeps their refinements in its
  dust state.
- A photo left in a session without its planes (#244's cold form,
  `photo-sessions.md`; a 60 MP frame with dust removal does not fit with
  them) keeps the dust states of its entries that were already cold, but not
  its current one or a hot entry's: reopening the photo, or undoing such an
  entry, detects dust again.

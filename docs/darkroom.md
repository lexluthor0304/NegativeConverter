# Darkroom paradigm: test strip, enlarger controls, dodge and burn, paper emulation

Roadmap items #149, #150, #151 and #152. The Edit and Retouch tabs gain the
vocabulary of a printing darkroom on top of the existing engine: nothing new
is stored for the enlarger view, the strokes and the paper choice are ordinary
per-file settings, and everything applies identically to the preview and to
the full-resolution export.

## Test strip (#149)

**Test strip** drawer in the Edit tab. Choose an axis, a step and 5 or 7
patches; **Make strip** renders the current photo at 360 px through the real
conversion (`convertFrameWithRouter` with a dedicated `scratch` cache slot in
`silverAdapter.js`, so the preview and export caches are untouched) plus the
step-3 adjustments, once per value. Click a patch to apply its value with one
undo entry; Shift-click also halves the step around it and re-renders; keys
1–9 pick a patch, `[` and `]` halve or double the step. **Area: Centre** shows
the middle half of each patch, like laying a paper strip across a face.

Axes follow the control paradigm: digital (brightness, contrast, temperature,
tint, cyan/red, saturation, shadows, highlights) or enlarger (stops, yellow /
magenta / cyan filtration, paper grade). `enlarger.js` defines them
(`TEST_STRIP_AXES`, `testStripValues`, `formatAxisValue`).

## Enlarger controls (#150)

**Digital / Enlarger** toggle above the basic sliders (remembered in
`localStorage` as `nc_paradigm_v1`). The enlarger view shows:

- **Exposure (stops)**, mapped through the curve engine's mid-grey response
  (`exposureUnitsForStops` / `stopsFromExposureUnits`): +0.5 stop is about
  39 slider units, −0.5 stop about −20.
- **Cyan / Magenta / Yellow filtration** 0–200 in steps of 5, around a
  reference pack of 20C 50M 40Y. Adding a filter removes that colour from the
  print, so one filter unit is minus one slider unit: +10M → tint −10
  (greener), +10Y → temperature −10 (cooler), +10C → cyan −10 (redder). The
  cyan/red axis is a new core control (`coreCyan` → engine `colorCyan`, which
  joins the automatic and colour-model corrections in `Engine.buildSettings`
  exactly like temperature and tint).
- **Paper grade** 00–5 in half grades (B&W only; RA-4 paper has one grade).
  Grades map to the contrast slider through a table calibrated so that the
  mid-tone slope of `CurveEngine.contrastLayer` reproduces the Ilford
  multigrade ISO(R) ratios (170/150/130/110/90/70/50 relative to grade 2):

  | grade | 00 | 0 | 1 | 2 | 3 | 4 | 5 |
  |---|---|---|---|---|---|---|---|
  | contrast | −45 | −34 | −21 | 0 | 12 | 25 | 44 |

  `enlarger.test.mjs` asserts the ratios within 5 % against the real engine.

The head is a view: `updateEnlargerUI` derives it from the core sliders and
every core slider change refreshes it (`coreReprocessHandlers`), so switching
paradigms never changes the image. Split-grade printing is not implemented.

## Dodge and burn (#151)

**Dodge and burn** drawer in the Retouch tab. **Paint on the photo** turns the
canvas into a brush (pointer events with capture, `touch-action: none`, so
pens and fingers work): choose dodge or burn, stops, brush size (% of the
short side) and feather. Each stroke is stored as a vector path in normalised
coordinates of the unrotated, unmirrored base image (`settings.localExposure`,
sanitised by `localExposure.js`), so it survives later rotation, mirror and
crop changes; `basePointToWorking` / `workingPointToBase` map through the
geometry chain and are verified against `applyRotationToImageData`. Every
edit replaces the stroke object (strokes are never changed in place), so the
dodge-and-burn and repair sanitisers cache their result by input identity and
per-frame settings rebuilds do not re-sanitise the paths (#234).

The adapter rasterises the strokes for the buffer it converts
(`rasterizeExposureStops`, cosine feather, one accumulation per stroke over
its bounding box only) and the engine multiplies the negative by 2^stops in
linear light after the histogram analysis and before the tone curves
(`Engine._applyLocalExposure`), where the enlarger's light would have been
held back or added. Because the same settings drive the preview worker and
the export worker, the exported pixels match the preview at any resolution.
Interactive conversions keep the dodged plane per cache slot (the
post-exposure level, `docs/silvercore-conversion-cache.md`): a slider tick
reuses it, and a stroke edit rebuilds only that level.

The maps are built incrementally and exactly (#254). An interactive slot's map
remembers its strokes (`updateExposureStopsMap`): a new stroke is added into it
inside its box, and an undone last stroke is written back from a snapshot of
that box, so adding stroke 21 costs one stroke and the post-exposure level
changes inside that box only. Every other change (geometry, preview size, an
older stroke, a second undo) rasterises again. Full-resolution and export
conversions use a tiled map (`rasterizeExposureStopsTiled`, 256 x 256 Float32
tiles allocated only where a stroke reaches), which the engine and the fused
B&W pass apply tile by tile. The raster itself skips pixels already at full
coverage, rejects by squared distance before `Math.hypot` and, for a soft
stroke of one pressure, evaluates the falloff only for the segments nearest
each pixel (`nearestSegmentCoverageInto`; the comment states the error bound
that makes it exact). `localExposure.incremental.test.mjs` checks all of it
bitwise against the frozen raster in `pipeline/oracle/localExposure.oracle.js`
on randomised stroke sets, and `silverAdapter.strokes.test.mjs` checks the
adapter frames against the frozen adapter. Timings:
`node scripts/bench-exposure-maps.mjs` (one default stroke at 2449 x 1628:
105 → 26 ms; stroke 21 after 20: 26 ms instead of a 2 s full raster; undo
0.3 ms; a stroke over 7 % of a 12 MP frame: 7 MB of tiles instead of 46 MB).
Strokes are part of undo, of the per-file settings and of batch export.

Painting (#254). The stroke under the pointer is drawn on `#brushFeedback`, a
canvas over the whole view at device resolution (`brushFeedback.js`): coalesced
pointer samples at least a device pixel apart, one draw per animation frame of
the new segments, orange for burn and blue for dodge. Its exposure change shows
under the brush while it is painted: the preview worker converts only the
rectangle the new segments touched over the frame its last interactive
conversion produced (`renderLiveExposureRect`, the stored raster's arithmetic),
and the page puts it into the exact frame's texture on the GPU display, or runs
Step 3 on the rectangle at its place in the frame and puts it on a CPU display.
For the same points it is exactly the frame the stored stroke gets, so the
pen-up frame replaces it without a jump. The points come from one recorder
(`createStrokeRecorder` in `brushFeedback.js`, #280): every point up to 400,
so such a stroke is stored as recorded. Past 400, a pen stroke keeps one point
per eighth of the brush radius; the live effect paints exactly those points
and the pen-up stores them, up to 1000 points (`MAX_STROKE_POINTS`, the
sanitiser's cap, 400 before #280), so its settled frame is its last live frame
whatever the pen pressure does. A mouse or touch stroke (one pressure) keeps
every point and is resampled to 400 at pen-up with the repair strokes' index
formula, keeping its end; its settled frame stays within 1/255 of the live
one. Resampling a pen stroke cannot do that: a merged segment paints with the
larger of its two pressures, which moves the feather edge where the pressure
changes, and no choice of 400 of a fast-pressure stroke's 600 points stays
within the acceptance bound (see Limits). Over another frame than the worker's
the stroke is painted otherwise (next paragraph). A stroke stored before its
pen-up frame ran is added to the worker's map first, so a quick second stroke
never hides the first. `?liveDodge=0` turns the live effect off. The stored
strokes (orange = burn, blue = dodge) are drawn on `#displayOverlay` in the
transform wrapper at display size while the brush is active (#253), each at the
width its raster paints, redrawn only when the strokes, the geometry or the
size change. The overlay takes the photo canvas's box, framed like it with the
border preview (#279), so the compositor puts the strokes on the photo's pixel
grid: within 1 CSS px of their image points at 100 % and about 400 % zoom, as
is the stroke being painted. The tool keeps the GPU display; the detail layer (#248) stays off
while it is active, since the live rectangles go into the base frame's
texture. Escape cancels the stroke being painted.

Over another frame than the worker's (#254 follow-up). Once a photo of at most
16 MP is idle, the frame on screen is the full-resolution render's display
preview (#248 part 4), not the preview worker's frame: the display converts,
then filters, while the worker filters the negative, then converts. Through the
conversion's curves the two differ at edges and on grain: by up to 67/255 at the
darkroom fixture's strip edges, and at the 772 px display of `_DSC3111.NEF` by
more than 2/255 in 70 % of the pixels (up to 31/255). Such a stroke used to be
painted as displayed + (live - committed) of the worker's frames, and its
pen-up frame, the worker's frame of the stored stroke, replaced the whole frame
on screen: every pixel where the two renderings differ moved, inside the
stroke's box or not (the darkroom smoke's long pen stroke: 348,157 pixels
outside its box, up to 67/255), and moved back about a second later when the
exact frame landed.

- Exact rectangles. A full-resolution render returns the analysis it converted
  with (`returnAnalysis`), and main records its display previews as exact
  displays of its settings (`exactDisplays`). A repaired frame is another
  object and an in-place repair moves `convertedPixelsRevision`, so a display
  with repaired pixels never counts. A stroke over an exact display ('display'
  mode) goes to the worker as `exposureExact`: the new segments are rasterised
  at full resolution; the display pixels whose filter footprint they reach
  (`displayFootprint`) are converted from the region of the source the worker
  holds as its level (k = 1: every display of a frame of at most 16 MP) with
  the render's analysis and every stroke placed by `region`, as the detail
  layer converts regions, and filtered as the display was
  (`filterDisplayRegion`, both planes). The rectangles are that display's own
  pixels with the stroke: `conversionWorker.exact.test.mjs` compares them bit
  for bit with the full render of the stored stroke (colour with and without a
  flat field, B&W and positive; plain and mirrored-crop geometry; bilinear and
  area displays; with and without an analysis sample). A request converts the region its new points
  reach (Node: 4 ms for the fixture's 237 x 237 brush region, 32 ms for the
  782 x 782 region of a 30 % brush on a 10 MP frame).
- Delta. Any other frame (dust or AI repairs that changed pixels, a worker
  that no longer holds the source, `?liveDodgeExact=0`) is painted as
  displayed + (live - committed), as before.
- Pen-up. Over either, the last points go to the worker at once, ahead of the
  pen-up conversion. Once their rectangles are on screen, what the stroke left
  there becomes the display preview without a redraw (`adoptLiveComposite`; a
  CPU display keeps its adjusted frame too), and the pen-up frame leaves it
  there (`applyPreviewFrame`) until the exact frame of the stroke replaces it.
  Outside the stroke's rectangles the exact frames before and after a stroke
  are bit-identical, so nothing there moves at pen-up or later. Inside, an
  exact composite is that frame, and it is recorded as the exact display of
  the pen-up's settings, so a next stroke paints exactly over it; a delta one
  is refined when the exact frame lands (Limits).

Layout and DPR changes refit the canvases before remapping active dodge, dust
and AI strokes, including at fit zoom. The DPR watcher uses both the standard
resolution query and the older WebKit pixel-ratio query. The worker releases
live coverage tiles and committed strokes after the final flush or on cancel;
stroke IDs keep a late release from clearing the next stroke.

## Paper emulation (#152)

**Paper** in the Looks drawer (`PaperProfiles.js`): RA-4 papers (Fujicolor
Crystal Archive glossy and matte, Kodak Endura) for colour negatives, B&W
papers (Ilford Multigrade RC, FB Warmtone, FB Cooltone, Fomatone MG Classic,
a matte fibre paper) with selenium / sepia / split toning for B&W negatives;
none for slides. Each paper is a parametric characteristic curve in display
space (mid-tone slope 110 / ISO(R), soft toe and shoulder), its density
limits (black = 10^−(Dmax − Dmin) of white: 0.6 % for a glossy Dmax 2.25,
2.8 % for a matte 1.65) and a base tint; toning tints shadows and highlights
separately. The stage runs as three 16-bit LUTs after the tone curves,
3D profile and saturation and before sharpening (`Engine._applyLuts`), cached
per paper / toning / strength. The strength-independent part of a build (the
encoded print value and the toning weights, two `Math.pow` per entry) is kept
for the last two paper / toning pairs, so a toning-strength drag rebuilds the
LUTs in about 1 ms instead of 5–6 ms with identical values (#239). The parameters are approximations drawn from
published data sheets and give each paper its recognisable character, not a
colorimetric match.

## Verification

- `npm test`: `enlarger.test.mjs`, `PaperProfiles.test.mjs`,
  `localExposure.test.mjs` (geometry round trips through rotation, mirror and
  crop; rasteriser falloff, accumulation and crop following; linear-light
  application), plus the existing adapter and curve engine tests.
  `conversionWorker.exact.test.mjs` checks exact rectangles against the full
  render of the stored stroke bit for bit, `brushWiring.test.mjs` the pen-up
  composite and the 'display' wiring, `displayPreview.test.mjs` the display
  footprints and region filters (#254 follow-up).
- `scripts/darkroom-smoke.mjs` (`npm run test:smoke`, or
  `node scripts/smoke-test.mjs --darkroom-only`): renders a brightness test
  strip (patch means 21 → 134), applies a patch (+20) with toast and undo,
  narrows with Shift-click; switches to the enlarger view (20C 50M 40Y, grade
  hidden for colour) without changing the screenshot, sets 60M → tint −10,
  30Y → temperature +10, +0.5 stop → exposure ≈ 39, and a digital tint change
  back to 50M; selects Crystal Archive matte (mean 110 → 122) and back to none
  (restored within 1); paints a 1.5-stop burn stroke (region 138 → 86) and
  removes it (restored); paints a 522-sample pen stroke with fast-changing
  pressure and checks that it stores the points the live effect painted, more
  than 400 (#280). Over the full-resolution display that stroke gets exact
  rectangles, and once its pen-up frame and once its exact frame have landed
  the frame on screen must be within 2/255 of its last live frame in 99.9 % of
  the stroke's pixels, with no pixel outside its box more than 2/255 off
  (#254 follow-up). Measured: bit-identical both times (104,182 stroke pixels,
  348,552 outside), where the pen-up frame used to move 348,157 pixels outside
  the box by up to 67/255. The same stroke painted by delta
  (`__ncBrush.setExactDisplays(false)`) meets the bound at pen-up
  (bit-identical) and leaves the outside of its box untouched when its exact
  frame lands, which refines the inside (logged: 97.7 % within 2/255, up to
  104/255). The stroke over the repaired frame (dust removal on; the fixture
  has no dust) is exact as well.

```sh
npm test
node scripts/smoke-test.mjs --darkroom-only
NC_DARKROOM_CPU=1 node scripts/smoke-test.mjs --darkroom-only
```

## Limits

- The brushes map through the photo inside the sprocket border (#254), so
  strokes land on the image with the border preview on too.
- A pen stroke that goes on past 1000 stored points (at least 75 brush radii
  beyond its first 400 samples, so a long stroke with a small brush gets there
  first) is resampled to 1000 at pen-up and can still jump at the feather edge.
  `silverAdapter.live.test.mjs` logs one: a 2,400-sample stroke with a 3 %
  brush keeps 2,056 points, and resampled to 1000 it has 88 % of its pixels
  within 2/255, up to 104/255 (82 %, up to 143/255, when it was resampled to
  400 before #280). Shorter pen strokes are exact, and the test asserts the
  acceptance bound (2/255 in 99.9 % of the stroke's pixels) for mouse, slow
  and fast pen pressure. Before #280 the fast-pressure stroke had 93 % of its
  pixels within 2/255 (up to 19/255).
- Over a frame with repaired pixels (dust or AI repairs) the live effect is
  still displayed + (live - committed). Nothing moves at pen-up or outside the
  stroke's rectangles, but the exact frame refines the inside when it lands:
  the darkroom smoke's long pen stroke painted by delta has 97.7 % of its
  pixels within 2/255 of it (up to 104/255 at the strip's edges); at the
  772 px display of `_DSC3111.NEF` a Node probe of the composite against the
  exact frame finds 47.8 % (up to 46/255). Exact rectangles there would need
  the region's repair as well.
- The dust pass after a stroke detects on the new frame, and its thresholds
  are quantiles of the whole frame (`hatThreshold`), so a burn can change which
  specks are repaired outside the stroke. Probe: a 1.5-stop burn on a 900 x 600
  negative with 220 graded specks, at the default strength 3: the white
  top-hat threshold moves 132 -> 129 and 5 specks outside the stroke become
  repaired, while the conversion outside the stroke's box is bit-identical. The
  exact frame and the export show that repair set; the live effect cannot. The
  change that would stop it (detect before local exposure, or keep the
  thresholds of the frame without strokes) changes exports, so it is queued in
  `docs/audit-backlog.md` (Dust removal) for the owner.
- Exact rectangles need the preview worker to hold the frame's source as its
  level (the client numbers the sources it posts, and the worker refuses a
  request for another) and the full render's analysis. Otherwise (a restarted
  worker, a display the main thread resized in area mode) the stroke is
  painted by delta.
- A long pen stroke stores up to 1000 points instead of 400, so its share of
  the settings, the undo snapshots and the export raster grows with it. A
  2,400-sample pen stroke rasterised for a 24 MP export (Node): 0.70 → 0.97 s
  with the default 12 % brush (400 → 602 points), 64 → 128 ms with a 3 % brush
  (400 → 1000 points).
- Test strip patches analyse the 360 px copy themselves; the auto white
  balance can differ slightly from the main preview.
- Paper curves are parametric approximations; no split-grade printing; the
  colour-negative "paper contrast" analogue is not exposed.

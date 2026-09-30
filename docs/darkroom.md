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
pen-up frame replaces it without a jump; a stroke of more than 400 points is
resampled at pen-up (the repair strokes' index formula) and keeps its end
(its settled frame then differs from the live one at the edge, within 1/255
for mouse strokes; see Limits). When
the frame on screen is not that conversion (a repaired full-resolution frame,
say), the worker also returns the rectangle without the stroke and the screen
shows displayed + (live - committed) until pen-up. A stroke stored before its
pen-up frame ran is added to the worker's map first, so a quick second stroke
never hides the first. `?liveDodge=0` turns the live effect off. The stored
strokes (orange = burn, blue = dodge) are drawn on `#displayOverlay` in the
transform wrapper at display size while the brush is active (#253), each at the
width its raster paints, redrawn only when the strokes, the geometry or the
size change. The tool keeps the GPU display; the detail layer (#248) stays off
while it is active, since the live rectangles go into the base frame's
texture. Escape cancels the stroke being painted.

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
- `scripts/darkroom-smoke.mjs` (`npm run test:smoke`, or
  `node scripts/smoke-test.mjs --darkroom-only`): renders a brightness test
  strip (patch means 21 → 134), applies a patch (+20) with toast and undo,
  narrows with Shift-click; switches to the enlarger view (20C 50M 40Y, grade
  hidden for colour) without changing the screenshot, sets 60M → tint −10,
  30Y → temperature +10, +0.5 stop → exposure ≈ 39, and a digital tint change
  back to 50M; selects Crystal Archive matte (mean 110 → 122) and back to none
  (restored within 1); paints a 1.5-stop burn stroke (region 138 → 86) and
  removes it (restored).

```sh
npm test
node scripts/smoke-test.mjs --darkroom-only
```

## Limits

- The brushes map through the photo inside the sprocket border (#254), so
  strokes land on the image with the border preview on too.
- A stroke of more than 400 points is stored resampled to 400. With a mouse
  the settled frame stays within 1/255 of the live one; pen pressure that
  changes within a few hundred samples cannot be carried by 400 points, so the
  feather edge can change by a few levels at pen-up
  (`silverAdapter.live.test.mjs` logs the measured difference).
- Test strip patches analyse the 360 px copy themselves; the auto white
  balance can differ slightly from the main preview.
- Paper curves are parametric approximations; no split-grade printing; the
  colour-negative "paper contrast" analogue is not exposed.

# Expired film rescue (过期卷抢救)

A separate entry and a separate flow for rolls that were shot or developed
long past their date. It applies to both kinds of input:

- **Expired negatives** go through the normal conversion first (film base,
  histogram levels, tone curves) and are then rescued as a positive.
- **Expired positives** (aged slides, or scans a lab already converted) are
  rescued directly.

The rescue is a post-conversion stage on the positive, so it never touches
the negative pipeline and works the same for RAW, TIFF, PNG and JPEG.

## What an aged roll does to a positive

Colour and tone are corrected separately, and both by density (luminance).
Per-channel levels — the classic "auto colour" — assume the darkest pixels
are neutral black; on a roll with heavy crossover the darkest pixels are
green, and per-channel levels then turn a grey excavator cab magenta. So:

| Symptom | Cause | Stage that answers it |
| --- | --- | --- |
| Overall cast (blue, magenta, green…) | the dye layers lose speed at different rates | the colour table: per luminance band, the near-neutral pixels' mean colour is measured; the offset that brings it onto its luminance is added to every pixel of that density (the overall cast is the population-weighted part, "Neutralise") |
| Crossover: shadows lean one way, highlights the other | the layers also fade with different gammas | the same table: what varies with density beyond the overall cast ("Crossover"). A cyan sky and a magenta wall may share a red value and need opposite corrections, so this is indexed by the pixel's luminance, not a per-channel curve |
| Fog: the black point floats up, contrast collapses | base density grows with age | one tone curve shared by the three channels: black / white points from the luminance histogram (0.5 % / 99.5 %), so neutrals stay neutral |
| Thin, dark midtones | an old roll is slower than its box speed | the shared curve's brightness gamma, defaulting from where the leveled midtones sit |
| Flat tonality | range loss | the shared curve's soft tanh S-curve, defaulting from how much range the levels had to recover |

| Uneven fog: one edge or corner fogged more (light piping at the cassette lip, the outer turns of the roll, an uneven bath) | fog is not the same everywhere on the frame | **OpenCV**: per-channel local dark floor (wide erosion = minimum filter, light blur) on a small copy, a robust quadratic surface fitted to it, subtracted per pixel |
| Flat local detail | haze inside the emulsion | **OpenCV**: local luminance mean (Gaussian blur) as a grid; deviations from it are amplified (a wide-radius clarity), opt-in because it also lifts grain |

Grain is left alone on purpose: it is part of the roll, and any smoothing
would have to be a separate, opt-in tool.

## Implementation

The correction has a global part (per-channel curves) and a spatial part
(what varies across the frame). The spatial part is measured with OpenCV.js
on the main thread — the same lazily loaded build the auto frame, dust
removal and lab match use — and stored as a few numbers, so it is applied
everywhere without OpenCV: in the export worker, the 16-bit export and batch
exports.

`negative2positive/src/app/expiredRescueOpenCv.js` (needs `globalThis.cv`):

- `measureExpiredSpatialMaps(image, { region, borderBuffer, placement })`
  area-averages the analysis region to ~160 px, and per channel runs
  `cv.erode` with an elliptical kernel 22 % of the width (the local dark
  floor), a light `cv.GaussianBlur`, and `cv.resize` (INTER_AREA) to a 32-wide
  grid; the luminance goes through a 5 % blur to the same grid for the local
  mean. Every Mat is released.

`negative2positive/src/pipeline/expiredRescue.js` is a pure module with no
DOM and no OpenCV:

- `fitExpiredSpatial(maps)` fits a quadratic floor per channel to the grid
  of minima with an asymmetric robust loss (cells above the surface, i.e.
  bright content, lose weight fast; cells below keep pulling it down), so a
  bright wall is not read as fog. The surface lives in frame coordinates,
  its amplitude is reported, and it never removes more than 15 % of the
  range at any point.
- `buildExpiredSpatialStage(settings)` / `applyExpiredSpatial(stage, u, v, px)`
  apply the surface (subtract, rescale so white stays white) and the local
  contrast (luminance deviation from the interpolated mean grid) to one
  pixel given its normalised position.

- `analyzeExpiredFilm(image, { region, borderBuffer, maxSamples })` samples
  the positive (8-bit, a 16-bit plane, or an ImageData carrying `__image16`)
  and returns a small plain object: luminance black / white points, eight
  luminance bands with their near-neutral mean colour, the overall lean.
  Near-neutral pixels weigh the colour decisions, and within a band three
  mean-shift steps settle on the densest near-neutral cluster (a film's
  neutrals gather there), so an orange cat on green grass keeps its
  colours. What it cannot decide: two populations at the same density that
  lean opposite ways (a magenta locomotive against green foliage, a grey
  cab against green rubble) — the larger one is taken as neutral, and the
  existing gray-point click, whose gains apply after the rescue, says
  otherwise when it should.
- `buildExpiredRescueStages(settings)` turns the analysis plus the strengths
  into the colour table (64 luminance bins × 3 offsets) and the shared tone
  curve; `applyExpiredTone(stages, px)` runs one pixel through them. When
  nothing leans the tone curve alone composes into the LUT fast path.
- `describeExpiredAnalysis(analysis)` gives the diagnosis panel its numbers
  and hue names.

The spatial stage, the colour table and the tone curve are the first stages
of the Step-3 adjustment chain in `workers/pixelAdjustments.js` and
`workers/pixelAdjustments16.js`, ahead of the WB gains, so the preview (CPU
path, like the lab-match look), the export worker, the 16-bit export and
batch exports all render the same result. The chain receives the frame size
(`computeAdjustmentParams(settings, { width, height })`) for the pixel
positions; without it the spatial stage is left out. A never-opened frame in
a batch export is measured from its own positive before the adjustment
stage, with OpenCV when it loads.

Interactively the measurement runs in two phases: the global curves show at
once, then OpenCV (loaded once per session) measures the fog surface and the
curves are re-measured on the flattened frame and swapped in. The diagnosis
shows "OpenCV is loading…", then the measured unevenness; if OpenCV cannot
load, the global rescue stays and the two spatial sliders are disabled.

## Settings

Per photo, flat keys like every other colour setting: `expiredEnabled`,
`expiredLevels`, `expiredNeutralize`, `expiredCrossover`,
`expiredBrightness`, `expiredContrast`, `expiredUnevenFog`,
`expiredLocalContrast`, and `expiredAnalysis` (the measurement, with its
`spatial` part: fog surface coefficients, offsets, amplitude and the local
mean grid). The strengths travel with "Sync color", recipes and
"Apply strengths to selected"; the analysis is never copied, each frame is
measured on its own tones. A frame's first measurement fills brightness and
contrast unless they were already moved off the defaults.

`state.expiredSession` is the session-level entry: photos added while it is
on start rescued, and the Studio shows the rescue tab first. It is switched
on by the welcome-screen button "Rescue an expired roll" and the menu entry,
and off by the menu entry or closing the session.

The automatic gray point is skipped for rescued frames (a global gain on top
of the per-band balance would fight it); a gray point sampled by hand still
applies after the rescue.

A fogged, borderless positive scan (a lab's JPEG of an expired roll) keeps
its full frame on import in the rescue flow and skips the frame detection:
it has nothing to crop, the fog makes the image-window detector see the
subject as the window (two of the three real test scans were cropped to the
cat), and on a 6 MP scan the detection worker times out and its main-thread
fallback freezes the page for about a minute. The colour analysis uses the
frame inside the border buffer, and the Crop tab works as usual. Negatives
are auto-framed exactly as outside the flow.

## Validation

```bash
node negative2positive/src/pipeline/expiredRescue.test.mjs
node negative2positive/src/app/expiredRescueOpenCv.test.mjs
node scripts/smoke-test.mjs --expired-only
```

The OpenCV test loads the real opencv-js build in Node, ages a scene with a
left-edge fog gradient and a bright wall, and checks the floor map follows
the gradient, the fitted surface is not tilted by the wall, the stage
flattens the halves, and the whole chain (8-bit and 16-bit) restores the
scene.

The unit test ages a synthetic scene (fog, range loss, per-layer gamma,
green shadows / magenta highlights) and checks the rescue brings the neutral
ramp back within a few levels while coloured patches stay coloured, that
partial strengths land between, that the 8-bit LUT path, the per-pixel path
and the 16-bit path agree, and that a disabled stage is a true identity.
The smoke test drives the real Studio through the expired entry with an
aged positive (with a left-edge fog gradient) and an aged negative
synthesised from the fixture, and checks the tab, the diagnosis including
OpenCV's unevenness reading, that the left-right tilt is flattened and the
uneven-fog slider drives it, the hold-to-compare, the single and batch
exports.

Defaults were tuned on five real expired-roll scans (a blue-fogged backlit
frame, two green-shadow / pink-highlight frames, and two with a heavy
green-shadow / cyan-sky crossover): every colour strength at 100 %, levels
100 %, brightness and contrast from the measurement.

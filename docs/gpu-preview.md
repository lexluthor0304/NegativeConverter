# GPU preview of SilverCore controls (#239)

The sixteen SilverCore controls (Exposure, Brightness, Contrast, Highlights, Shadows,
Whites, Blacks, Temperature, Tint, Cyan/Red, Saturation, Glow, Fade, Profile
Strength, Pre-saturation, Paper Toning Strength), the paper and toning selects and the
enlarger controls that mirror them used to re-convert the display preview in the
preview worker on every tick: 11–31 updates/s, 26–48 MB copied and transferred per
tick. With a WebGL2 context the Studio now draws such a tick with one fragment shader
on the display-size negative, and converts only the frame that settles it.

The CPU engine stays the reference and the only producer of settled and exported
pixels. A GPU frame is display-only.

## Pieces

| module | role |
|---|---|
| `render/previewShader.js` | GLSL ES 3.00 `applyProgram` and `step3Program` (one shared Step-3 function) and their display-mode variants (#253), the GLSL ES 1.00 fallback; constants from the JS stage modules |
| `render/previewTables.js` | 256 × 256 table packing, hue weights and the exposure LUT in rows of 64 texels, the per-tick uniforms, the CPU apply chain, the display-mode stages (`displayStageUniforms`) |
| `render/gpuPreviewRenderer.js` | WebGL2 programs and textures, the parallel compile, the precision gate, the self-tests |
| `render/gpuPreviewSelfTest.js` | 64 × 64 fixtures and parity cases with the engine's 8-bit reference; the display-mode fixtures and budget |
| `render/borderUnderlay.js` | the film-border background as pass 1 of a bordered GL frame (#253) |
| `app/gpuPreviewScheduler.js` | when a GPU frame draws and when its exact frame settles it |
| `app/renderEnvironment.js` | `describeWebglRenderer` (#263) for the software-rasteriser gate |
| `pipeline/silverAdapter.js` | `prepareSilverCorePreview`, `analyzeSilverCorePreview`, `silverCoreAnalysisKey`, `silverCorePreparedKey`, `trySilverCoreParams` |
| `workers/conversionWorker.js` | `prepare` and `analyze` next to `convert` |

## One WebGL2 context, two programs

`initWebGLRenderer` asks for `webgl2` first (a canvas keeps the first context type it
gets) and falls back to `webgl`, whose Step-3 program is only the fallback.

- **step3Program** reads the exact 8-bit worker frame (RGBA8) and runs Step 3. It
  draws whenever that frame is current, which includes every Step-3 drag.
- **applyProgram** reads the prepared negative (RGBA16UI; 8-bit sources as RGBA8UI,
  multiplied by 257 in the shader like `fromImageData8`) and runs the SilverCore
  per-tick stages, then `>> 8` and the same Step 3. It draws while SilverCore settings
  are ahead of the exact frame on screen.

Both read texels with `texelFetch` at `ivec2(v_uv * textureSize)` with the flip in
the vertex shader, so the drawing buffer and the texture may differ in size. Every
sampler has its own texture unit, and unused ones hold a 1-texel texture of their kind.

applyProgram is used only when all of these hold (otherwise the session keeps
today's path): a WebGL2 context; `HIGH_FLOAT` with 23 mantissa bits and 32-bit
`HIGH_INT`; both programs linked; a hardware renderer (`describeWebglRenderer`); and
the idle self-test: three 64 × 64 fixtures (colour with HSL in every band, a 3D profile
at strength 150, papers, pre-saturation, stops; B&W with the red mix, split toning and
the grey table; a positive with gain and WB and transparent pixels) plus step3Program
at identity, drawn into an offscreen framebuffer and compared with the CPU engine in
one `readPixels`, at most 1 per channel. `?gpuPreview=` selects `webgl1` (never ask
for WebGL2), `off` (WebGL2 for Step 3 only), `force` (also on a software rasteriser,
for CI) or `selftest-fail`.

## Stages, with the CPU's quantisation

| # | stage | shader |
|---|---|---|
| 1 | B&W mix (`toGrayscaleInPlace`) | dot product, `floor(x + 0.5) & 0xFFFF` |
| 2 | pre-saturation (`adjustSaturation`) | luma blend, clamp, truncate; exact greys from the engine's ramp |
| 3 | positive gain/WB (`applyPositiveAnalysis`) | same formula, alpha 0 skipped, `floor(x + 0.5)` |
| 4 | dodge-and-burn stops (`applyExposureStopsToImage16`) | R32F stops, the R32F linear LUT, 0 stops untouched |
| 5 | tone LUT (`applyLUT`) | `texelFetch` of a 256 × 256 RGBA16UI table |
| 6 | HSL model (`applyHSLAdjustments`) | same branches and strict-maximum skip; weights from the uploaded tables |
| 7 | 3D profile (`applyLut3D`) | 8 corners of the baked RGB16UI `TEXTURE_3D` at `(b, g, r)`, same clamps |
| 8 | saturation | as 2 |
| 9 | paper (`applyPaperLuts`) | `texelFetch` |
| 10 | 16 → 8 | `>> 8` |
| 11 | Step 3 | shared with step3Program |

B&W runs 1, 2 (through `Engine.preSaturationRamp`), 4 and one fetch from the #238 grey
→ RGB table, which is stages 5–9 evaluated by the engine. On an exact grey the
saturation blend lands on an integer, where the truncation follows the sign of the
luma's rounding error; those pixels read `Engine.saturationRamp` /
`preSaturationRamp`, the CPU's own results, so they cannot differ.

A line-by-line fp32 model of applyProgram (`test-fixtures/previewShaderModel.mjs`) is
within 1 of the engine with at least 99.9 % identical pixels for all 37 presets and the
acceptance extremes, both with strict fp32 and with wider intermediates.

## Worker protocol

| message | when | returns |
|---|---|---|
| `prepare` | a new display preview, film base, flat field or strokes (at idle after an exact frame, or when a tick or a draw finds its texture stale) | the pristine plane (film base / flat field) or nothing, the stops, and point samples of both (≤ 24,576 px) for the histogram; for a display target (#248) without compensation, a copy of the display negative the worker resampled from the level, since main holds none |
| `analyze` | the analysis key changed (source, reference sample, border buffer, colour model, pre-saturation, B&W mix, override, film base) | `channelData`, `autoColor`, `positiveAnalysis` |
| `convert` | the settle frame, every excluded mode, and whenever the GPU cannot draw | today's exact conversion, unchanged |

Both run in the slot the next exact frame uses, so that frame reuses the pristine
plane and the analysis exactly as the next tick of a drag does, and its pixels are
unchanged (`silverAdapter.preview.test.mjs` checks them against the 1703835 adapter).
The prepared texture is tagged with the display preview, the generation, the film-base
/ flat-field key and the strokes; any rebuild (geometry, window or DPR settle, photo
switch, restart) invalidates it. Main keeps no copy after the upload; on context loss
the next warm-up prepares again. A window or DPR settle on current full-resolution
pixels (#237) converts nothing; it moves the display target (#248: a size on the
retained level, no pixels on main) and the GPU preview prepares that at idle, so a
drag after it is not drawn at the old size. A target within the hysteresis band
(at most 15 % larger or about 5 % smaller) keeps serving. Zoom no longer changes the
display size (#248); native pixels at zoom come from the detail layer, which hides
while a GPU frame is ahead of its exact frame.

Pre-saturation, border-buffer (and B&W mix) drags ask for an `analyze` per tick,
newest wins, and draw with the previous analysis until it lands.

## Per tick, per animation frame

`scheduleCoreReprocess` hands a request the GPU can take to the scheduler, which draws
at the next animation frame with the newest state: `trySilverCoreParams` (the preset
table is a cached import), `Engine.previewPlan` on an engine seeded from `analyze`
(curves, HSL factors, profile strength, saturation, paper LUTs; the B&W grey table),
the tone LUT packed into a kept buffer and uploaded with `texSubImage2D` (512 KB), the
paper LUT, ramps and 3D profile only when they change, uniforms, one draw. The 3D
profile is fetched and baked at idle (the preset's) or on a preset change, never in
the draw.

The GPU takes only a tick it can draw. A texture prepared for another film base,
flat field, mode or strokes, an analysis of another mode, or a 3D profile not loaded
make `gpuPreviewCanTake` decline the tick: the worker converts it, as before #239,
and the missing input is asked for. A profile load or an `analyze` that failed is
asked again after `GPU_INPUT_RETRY_MS` (5 s), a profile at once when a preset is
picked and an analysis at once for another key; meanwhile those ticks convert. A draw
that still fails (a stage that reads neighbours, for one) settles with the exact frame.

The paper LUT build caches its strength-independent part per paper and toning
(exact), so a toning-strength drag rebuilds it in about 1 ms instead of 5–6 ms.

## Settle, state and histogram

- The exact frame of the newest settings leaves on commit, 150 ms after the last
  input, and at once from `flushScheduledCoreReprocess` (every export barrier) and
  from a photo switch. Every discrete change is a commit: a slider's release and value
  box (the enlarger head's too), the paper, toning, film preset, colour model and
  positive-mode selects, the film-type buttons, a console key or reset, a test-strip
  patch, Studio's style and colour reset, a recipe, a detected film's preset, and the
  immediate refreshes (film base, flat field, roll frame, border buffer). When it
  lands it is applied as before and step3Program takes over.
- Until then `coreReprocessBusy()` is true (an armed settle or a GPU frame ahead of
  its exact frame), so exports, the photo-session capture and every other barrier wait
  for the exact frame. A photo switch sends it at once and waits, so the photo being
  left is remembered settled.
- An older exact frame never replaces a newer GPU frame. After a draw that failed the
  screen still shows the exact frame, so a superseded exact frame is applied as before
  #239. A settle that cannot apply (another photo, a restart, a failure) returns the
  display to its exact frame.
- GPU frames never reach `processedImageData`, `previewSourceImageData`, the session
  cache, the active tile or the samplers; the retained 16-bit plane (#233) is not
  committed during a GPU drag. A release or a commit asks for the plane of the frame
  that settles it, which is committed as that frame lands, not after the 150 ms idle
  commit.
- The histogram of a GPU frame is the CPU chain over the prepared point samples (the
  exact frame's pixels at those points, all stages being pointwise), then Step 3, at
  the same 260 ms throttle.

## Display modes (#253)

The lab-match look, the expired-film rescue, the film-border preview, the
dodge-and-burn tool and a shown dust mask used to switch the GL display off and run
Step 3 per pixel on the main thread (171–403 ms per frame for a rescue with its fog
surface at 2.2–4 MP, in Node). They now stay on the GPU.

- **Stages.** The mode variants of both programs (`STEP3_MODES_FRAGMENT_SHADER`,
  `APPLY_MODES_FRAGMENT_SHADER`) run, in `pixelAdjustments.js`'s order and in its
  0..255 domain on the integer input: the rescue (R1 fog surfaces: 18 coefficients,
  offset, limit, scale; R2 local contrast against the ≤ 128 × 128 mean grid, an R32F
  texture interpolated by hand with `meanAt`'s weights and edge rule; R3 the 64-bin
  colour offsets, RGBA32F; R4 the 256-entry tone curve, R32F), then Step 3, then the
  look (L1 the matrix, uploaded row-major with `transpose = true`, and offset; L2 its
  curves in row 1 of the 256 × 2 Step-3 curve texture). Every stage has an enable
  uniform mirroring the CPU's flags, and C/M/Y reads an integer where the CPU's
  per-pixel loop stores one. The textures hold the float32 values `expiredRescue.js`
  stores; the luma weights and the bin count are exported from it.
- **Positions.** `uv = u_frame.xy + (p + 0.5) · u_frame.zw` from the texel index `p`,
  never `gl_FragCoord`: the border draws the photo in a sub-viewport, and the detail
  layer (#248) passes its region of the whole frame (`regionFrame`), so the fog and the
  mean grid stay normalised to the frame the CPU normalises them to.
- **Values.** `currentDisplayStages()` builds them with `computeAdjustmentParams` from
  the display recipe (the look, the rescue strengths and analysis, vibrance, hold-to-compare),
  only when one of those changed. A strength tick is one `buildExpiredRescueStages`
  and 2 KB of uploads; the grid uploads once per analysis and the look's curves once
  per look. The textures stay under 70 KB.
- **Readiness.** The variants compile at idle once a WebGL2 context exists and draw
  their fixtures (rescue with offsets, fog and local contrast; the look with a
  non-symmetric matrix and curves; rescue + look + vibrance; hold-to-compare) against
  `pixelAdjustments.js` ('full') in one readback: mean ≤ 1 level and p99.9 ≤ 3.
  The readback includes a SilverCore conversion drawn through the combined
  apply-mode shader, with rescue, look and vibrance, against the CPU chain.
  Earlier claims that both variants were tested were premature: the combined
  program joined the runtime self-test in the #229 review fix (R2-019).
  `webglState.modesReady` is false until then, for good if they fail, on WebGL1,
  and on software rasterisers. `?gpuPreview=force` explicitly allows software GL;
  while it is false only a look or a rescue keeps the CPU display.
  Identity WB with nonzero vibrance and a look or rescue also keeps the exact
  CPU display: this recipe misses the stricter original rounding fixture. Both
  the gate and the shader read WB as float32, including gains that round to 1.
  `drawStep3` and `drawApply` reject it even after the mode programs link, and
  the app resumes GL when the recipe becomes supported. The force switch does
  not bypass this pixel-correctness gate.
  `?gpuPreview=modes-fail` (or `?gpuPreview=force&displayModesFail=1` on software renderers)
  fails the self-test.
- **Border.** With the border preview the drawing buffer is the framed display size
  (`getSprocketFrameLayout`, portrait included): pass 1 draws
  `composeSprocketFrameBackground` at display size (uploaded once per size, markings
  and fonts), pass 2 the photo into its rectangle. With overexposed sprockets the smear
  keeps the last background during a drag and is recomposed after each settle from an
  exact display-size frame adjusted in the export worker (a UI-only approximation that
  lags by one settle). The smear belongs to its display source: a same-size
  photo switch releases it, invalidates the underlay, and waits for that photo's
  own adjusted pixels. The memory ledger counts the held smear. The WebGL1
  fallback draws the same underlay.
- **Overlays.** The dust tint and the saved dodge strokes are drawn on
  `#displayOverlay`, a transparent canvas in the transform wrapper above the photo,
  backed at the display photo's size and placed over the photo's rectangle with the
  border. It is repainted only when the tint, the strokes, the geometry or the size
  change; the photo is never redrawn for an overlay, and both display paths use it.
  The stroke being painted, by any brush, is on `#brushFeedback` outside the wrapper
  (#254, `brushFeedback.js`), and the brushes map through the photo rectangle inside
  the border on both canvases. With the border the overlay's box is fractional, and the
  compositor places the layer on its own pixel grid: at 381 % zoom the smoke measures
  the drawn stroke 1.3 screen px off its point (a third of a layout pixel), with the
  overlay's own pixels exact.
- **Histogram.** Unchanged: the GL path's sample (≤ 24,576 px) goes through the same
  look, rescue and hold-to-compare rules, every 260 ms and at each settle, including
  above 16 MP where `updateFull` does not run.

## Scope and fallback

Excluded, with today's per-tick worker frames: crop, a look or rescue before the mode
programs are ready (`isWebGLActive`), frame repairs (`hasFrameRepairs()`, so dust-mask
core drags keep the worker path), before/after, WebGL off. The border preview, the
dodge-and-burn tool and a shown dust mask draw applyProgram frames like a default
session. While the dodge tool or a shown dust mask is active the detail layer stays
off: a live dodge stroke's rectangles (#254) and a dust stroke's patches go into the
base frame's texture. Failures fall back to WebGL1 Step 3 or the CPU display. A lost
context drops to the worker path; on restore the programs are compiled, tested and fed
again.

Not done: the optional row-band split of the fallback `convert` across workers (the
fallback keeps one worker; #256 splits export conversions).

## Verification

- Node: `silverAdapter.preview.test.mjs`, `conversionWorker.preview.test.mjs`,
  `conversionWorkerClient.test.mjs`, `gpuPreviewScheduler.test.mjs` (also main.js's
  take test, failed draws, retries and every discrete commit, on
  `gpuSettleHarness.mjs`), `settleOnSwitch.test.mjs`, the GPU scenarios
  in `coreReprocessDispatcher.test.mjs`, `previewShader.test.mjs` (glslc compile when
  installed, the fp32 model sweep), `PaperProfiles.test.mjs`.
- Chrome: `node scripts/smoke-test.mjs --gpu-preview-only` (offscreen self-test and
  parity sweep, step3Program vs the 1703835 WebGL1 shader, in-app GPU frames vs their
  exact frames, display-only and export-after-release checks, every fallback), plus the
  WebGL2-aware `realtime-preview`, `webgl-preview` and `photo-session` probes.
- #253: `render/displayModes.test.mjs` (the fp32 model of the mode stages against
  `pixelAdjustments.js` on every parity recipe, the orientation fixture, the stage
  cache), `--display-modes-only` (offscreen mode parity, a look in the app, the border
  underlay against `composeSprocketFrame`, overlay alignment at 100 % and about 400 %,
  GL vs CPU pointer mapping, the failed self-test) and `--expired-only` (the rescue on
  `#glCanvas` within the budget, drags, hold-to-compare).
- Frame rates, latency, heap growth and WebKit behaviour need the #230 harness.

## Native detail at zoom (#248 review)

A current exact frame supplies the region's pixels directly. A source-derived
region becomes stale as soon as that frame arrives; the next base draw recrops
it without a pan. Tier B uses its pending whole-frame size for fog and mean-grid
coordinates. Conversion completion wakes a waiting request directly; retaining
or committing a preview plane does not block an ROI. The 250 ms release budget
is exercised with fake timers; real driver/worker latency remains device-dependent.

Only one current region is requested. Matching cuts deduplicate even when they
cannot cover the entire view, and superseded requests abort and drop queued row
buffers. When native rows would exceed 16 MP, the retained level covers the full
view at its available density. This is a display approximation below native zoom;
100% and export-triggered exact frames use exact frame crops.

An export's exact frame uses its own pixels and box-filter grid, even when the
source plan says `fromLevel`. Above the 16 MP native-copy limit it builds that
exact crop's level in bands of at most 1 MP, then transfers the bounded level
to the preview worker with the original crop geometry. The resulting filter
is byte-identical to cropping the whole rectangle and filtering it at once;
the rectangle, placement and whole-frame fog coordinates stay the same. It
never substitutes the retained source-conversion level for the exact frame.
Cancellation stops before the next band or transfer.

The worker owns the private padded RGBA16 plane, converts it in place, releases
received rows before conversion, and uses its result's RGBA8 bytes directly when
slot and output sizes match. The former unconditional 128 MB claim is replaced
by conservative allocation accounting: at DPR 2, a 1110x700 CSS view has a
2560x1792 slot and a <=2478x1658 native-density region. At lower densities native
rows may approach the 16 MP cap. Including that resampling peak, a worst-case sparse
stops map and old/new detail textures plus the drawing buffer, allow **384 MiB**
for that slot, and **512 MiB** for a 1600x1000 view (3584x2304 slot). The bound
also allows one superseding row payload while an active synchronous
pass finishes; older queued payloads are discarded. These bounds
exclude the already retained base/analysis and driver-internal overhead; they
are estimates, not measured process RSS. Planning uses a 60 MP descriptor while
tests allocate at most 12 MP. `estimateDetailRoiBytes` checks the plane/texture
accounting against these bounds. `?detailProbe=1` retains a test-only region for CPU
parity checks; its retained plane and transient reference/readback copies are additional.

The limits bind allocation callers: native/level copies are at most 16 MP,
exact-frame native bands at most 1 MP, and output/padded-slot/GL surfaces at
most 8,388,608 pixels with dimensions at most 8192. Planning and warm-up skip
unsupported viewport sizes; the base display continues. The page client and
worker check dimensions before copying, posting, resampling or padding, and
the detail upload checks again. `estimateDetailRoiBytes(..., { exactFrame: true })`
accounts for the exact crop's own reduction and band scratch rather than
assuming the source plan's retained level. Tiny actual-caller tests and
descriptor allocator traps verify these limits; they do not measure 60 MP RSS.

The original 211x137 aged, curves-only look with identity WB, vibrance 35 and
C/M/Y 6/-4/3 retains its strict p99.9 = 0 target. Its affected GL mode is gated
to the exact CPU display, where mean/p99.9/max are 0/0/0. The ungated fp32
model's p99.9 = 2 remains a diagnostic failure, not accepted parity. The
nonidentity-WB case remains an additional shader regression. Exports continue
through the original CPU/16-bit paths.

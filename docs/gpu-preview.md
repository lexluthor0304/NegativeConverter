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
| `render/previewShader.js` | GLSL ES 3.00 `applyProgram` and `step3Program` (one shared Step-3 function), the GLSL ES 1.00 fallback; constants from the JS stage modules |
| `render/previewTables.js` | 256 × 256 table packing, hue weights and the exposure LUT in rows of 64 texels, the per-tick uniforms, the CPU apply chain |
| `render/gpuPreviewRenderer.js` | WebGL2 programs and textures, the parallel compile, the precision gate, the self-test |
| `render/gpuPreviewSelfTest.js` | 64 × 64 fixtures and parity cases with the engine's 8-bit reference |
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
| `prepare` | a new display preview, film base, flat field or strokes (at idle after an exact frame, or when a draw finds its texture stale) | the pristine plane (film base / flat field) or nothing, the stops, and point samples of both (≤ 24,576 px) for the histogram; for a display target (#248) without compensation, a copy of the display negative the worker resampled from the level, since main holds none |
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
the draw; a draw that lacks something asks for it and settles with the exact frame.

The paper LUT build caches its strength-independent part per paper and toning
(exact), so a toning-strength drag rebuilds it in about 1 ms instead of 5–6 ms.

## Settle, state and histogram

- The exact frame of the newest settings leaves on commit (slider release, value box,
  paper and toning selects), 150 ms after the last input, and at once from
  `flushScheduledCoreReprocess` (every export barrier). When it lands it is applied as
  before and step3Program takes over.
- Until then `coreReprocessBusy()` is true (an armed settle or a GPU frame ahead of
  its exact frame), so exports, the photo-session capture and every other barrier wait
  for the exact frame.
- An older exact frame never replaces a newer GPU frame. A settle that cannot apply
  (another photo, a restart, a failure) returns the display to its exact frame.
- GPU frames never reach `processedImageData`, `previewSourceImageData`, the session
  cache, the active tile or the samplers; the retained 16-bit plane (#233) is not
  committed during a GPU drag.
- The histogram of a GPU frame is the CPU chain over the prepared point samples (the
  exact frame's pixels at those points, all stages being pointwise), then Step 3, at
  the same 260 ms throttle.

## Scope and fallback

Excluded, with today's per-tick worker frames: crop, a look, expired rescue, the border
preview, the active dodge-and-burn tool, a shown dust mask (`isWebGLActive`), frame
repairs (`hasFrameRepairs()`), before/after, WebGL off. Failures fall back to WebGL1
Step 3 or the CPU display. A lost context drops to the worker path; on restore the
programs are compiled, tested and fed again.

Not done: the optional row-band split of the fallback `convert` across workers (the
fallback keeps one worker; #256 splits export conversions).

## Verification

- Node: `silverAdapter.preview.test.mjs`, `conversionWorker.preview.test.mjs`,
  `conversionWorkerClient.test.mjs`, `gpuPreviewScheduler.test.mjs`, the GPU scenarios
  in `coreReprocessDispatcher.test.mjs`, `previewShader.test.mjs` (glslc compile when
  installed, the fp32 model sweep), `PaperProfiles.test.mjs`.
- Chrome: `node scripts/smoke-test.mjs --gpu-preview-only` (offscreen self-test and
  parity sweep, step3Program vs the 1703835 WebGL1 shader, in-app GPU frames vs their
  exact frames, display-only and export-after-release checks, every fallback), plus the
  WebGL2-aware `realtime-preview`, `webgl-preview` and `photo-session` probes.
- Frame rates, latency, heap growth and WebKit behaviour need the #230 harness.

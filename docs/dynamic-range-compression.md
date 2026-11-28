# Dynamic range compression

A group on the Tone panel, next to Highlights and Shadows: **Compression
amount** (0–100, 0 is off and the default) and five fine adjustments under
it, greyed while Amount is 0. For contrasty scenes (backlight, windows, sun
and shade): bright and dark areas keep their detail at the same time. The
photo is never compressed without the user: a hint offers it on photos where
it helps, and **Auto** sets the six controls from the photo.

The method is Fattal, Lischinski and Werman, *Gradient Domain High Dynamic
Range Compression* (SIGGRAPH 2002), the one behind RawTherapee's Dynamic
Range Compression tool. It is implemented here from the paper. RawTherapee,
Luminance HDR and pfstmo are GPL; their source was not read. RawTherapee was
used only as a black box (`rawtherapee-cli` 5.13) for reference outputs, and
RawPedia for what its controls mean.

Code: `pipeline/dynamicRangeSolver.js` (FFT, DCT, the Poisson solve),
`pipeline/dynamicRange.js` (the method, the sample, the solve, the
per-pixel reference `exposeDrcReference`, saturation protection, the hint's
estimate and Auto), `render/dynamicRangeGpu.js` (the per-pixel stage on
WebGL2, full resolution), the compression stage of `render/previewShader.js`
(the GPU preview), `_planDrc` and `exposeDrcFrame` in
`pipeline/silverAdapter.js` (where a conversion applies it), `drcBandSums` /
`drcTablesFor` / `drcBandStage` in `pipeline/silverBands.js` (the band pool),
`workers/drcMapWorker.js` (maps for the GPU preview),
`app/dynamicRangeHint.js` (the page's sample, the map service and the hint)
and the section "Dynamic range compression" of `app/main.js`.

The split: the 512 px sample and the solve are CPU work (JavaScript, Float64,
deterministic, under 100 ms); every per-pixel step is on the GPU where there
is one, with the JavaScript reference as the definition, the test oracle and
the fallback.

## The method

1. **Sample.** The negative as the engine receives it (geometry applied,
   before film-base compensation) is reduced to a grid of about 512 px on its
   long side (both sides products of 2, 3 and 5), each cell the mean of the
   16-bit codes it covers per channel (integer sums, so a band pool's partial
   sums give the same cells). Before the solve each cell goes through the
   engine's own preparation of that frame (film-base gains, B&W mix,
   pre-saturation, a positive's gain and white balance), is made linear (the
   same 2.2 gamma as the dodge-and-burn stops) and reduced to Rec. 709
   luminance L: the map sees what the exposure stage sees.
2. **Log luminance** H = ln(L + 0.001).
3. **Attenuation** (the paper's equation 6). A Gaussian pyramid of H down to
   a short side of 32 px; on each level k ≥ 1 the gradient magnitude g and a
   threshold α_k, the level's own percentile of g (Detail);
   φ_k = (g/α_k)^(β−1) above it, 1 below it (or a raise, Local contrast); the
   field Φ is the product of the levels, coarsest first, each upsampled to
   the next. Level 0 (the grid itself) reads mostly the film's grain and sets
   no attenuation.
4. **Poisson.** G = Φ ∇H with forward differences (Φ averaged over the two
   pixels a difference joins), div G with backward differences, and
   ∇²I = div G solved exactly with reflected borders: the 5-point Laplacian
   is diagonal in the DCT-II basis (eigenvalues 2 cos(πk/N) − 2 per axis),
   so the solve is two DCTs each way and a division, in Float64, a fixed
   number of operations. If Φ = 1, I = H exactly.
5. **Anchor.** I is shifted so the frame's median log luminance keeps its
   level.
6. **Gain.** The map holds the raw log gain ln(L_out / L) of each cell and
   its H. The Shadow recovery and Highlight compression shares are applied
   per pixel (`drcStopsOf`): the part that brightens the picture scaled by
   one, the part that darkens it by the other (on a negative the signs are
   the other way round), limited to ±4.5 stops, and then held inside the
   picture's own extremes (below, "No crushed shadows"). So those two
   controls never need a new solve. The map also keeps the picture's
   extremes and middle; when the conversion names the picture (a crop, or
   the detected frame of an uncropped scan) the solve runs on the picture's
   cells alone, so a film holder or rebate is no part of it.
7. **Per pixel.** At any resolution each pixel gets the log gain of the
   map's four nearest cells weighted by distance and by how close their H is
   to the pixel's own ln(L + 0.001) (a joint bilateral upsampling, Kopf et
   al., SIGGRAPH 2007, range σ 0.5; the range weight is a 1D table): the gain
   changes where the picture's edge is, not beside it. It becomes stops of
   exposure (log₂ of the gain), added to the dodge-and-burn strokes' stops,
   and the pixel is exposed in linear light, in one pass. Nothing per pixel
   is kept but the saturation protection's weight (1 byte).

### Where it acts: on the negative, before the curves (position B)

The stage is the engine's exposure stage (`_applyLocalExposure`, where the
dodge-and-burn stops are applied, `silvercore/util/localExposure.js`): after
the engine's analysis and before its curves. When the compression is on,
`params.drc.expose` replaces the strokes' own pass and applies both, on the
GPU (`exposeDrcFrame`) or in the reference, so every path that exposes (the
cached levels of the interactive slots, the transient full-resolution path,
a detail region, a band of the band pool, the engine) applies the
compression at the same point. B&W frames take the RGBA path while it is on
(the grey fast path has no exposure stage), and a positive's folded tables
(`_positiveFold`) are not used, so its exposure stays a stage of its own.

The engine's black and white points and automatic colour
are measured on the uncompressed frame, so turning the compression up does
not make the curve stretch back what was just compressed: compressed
highlights land inside the clip points instead of on them. On a negative
the bright areas are the picture's shadows (the gain's sign is read the
other way round); positives (slides, edit-mode positives) get the stage at
the same point without the inversion, after their gain and white balance.

**Saturation protection** acts after the curves, the one part that does: a
pixel the compression darkened by d stops loses up to 0.6 × (control/100)
of its chroma around its luminance, reached at 1.5 stops. Highlights
brought down from the shoulder of the curve come back more saturated than
they were. Measured on the 31 colour negatives at Amount 50
(`.cache/drc/proto/satprobe.mjs`; mean HSV saturation of the pixels the
compression darkened by more than 20 %, 0.194 without it): 0.372 with
protection 0, 0.314 at 50, 0.283 at 75, 0.251 at 100. The default is 75
(it was 50): the darkened areas stay close to their own colour and the
control keeps room above it. Lifted shadows lose saturation at every
setting (0.407 → 0.286): only the darkened side is protected (a known
limit). B&W is untouched.

### No crushed shadows, no blown highlights

The gain is regional: a region gets the gain its large-scale tone needs,
and detail darker (or brighter) than its region gets the same gain. With
the method alone, that pushed some pixels past the frame's own black or
white, where the curves clip them: on 2 of 66 real negatives the
near-black share (luminance at most 1 %) grew past 1 % at Amount 70
(L1002388, a B&W forest with people in sun, 0.3 % → 10.5 %; L1002112, a
colour lake under trees, 0.6 % → 3.2 %), and frames whose middle already
sits near black (more than half of the picture at the negative's clear end)
were pulled further into it. The cause on L1002388: the positive's black
point sits inside a large dark mass, and the compression darkened that mass
by 0.08–0.16 stops on the negative (a uniform +0.06 stops on the negative
alone takes its near-black share from 0.32 % to 0.71 %).

So every pixel's gain is held inside the frame (`drcLimitGain`). The map
keeps the picture's extremes (its 0.5 % and 99.5 % solve cells) and its
middle (the anchor). In the direction a pixel moves, it moves freely up to a
ceiling (the middle, and at least half a stop inside the extreme); past
the ceiling its new level goes through a soft knee a quarter of the
remaining way wide, so it approaches the extreme and never passes it, and
two pixels keep their order. Moving towards the middle (lifting shadows,
lowering highlights) is untouched up to the middle. The same function runs
in the reference, the GPU stage and the preview shader.

Measured at Amount 30, 50 and 70 (only Amount moved) on the 66 real
negatives and the 32 public frames (`.cache/drc/proto/crushset.mjs`):
no frame gains more than a quarter of a percentage point of near-black or
near-white at any Amount; the worst is +0.03 points of near-black
(L1002388 at Amount 70) and no frame gains near-white. Before the fix 14 of
the 98 frames gained more than that at Amount 70 (up to +14.5 points). The
compression did not get weaker for it: the mean change of the p2–p98 range
is −0.81, −1.07 and −1.25 stops at Amount 30, 50 and 70 (−0.78, −1.03 and
−1.21 before) `dynamicRange.test.mjs` checks four scenes (a backlit
forest with dark detail inside bright regions, a night frame whose middle
is near black, its mirror near white, the room) at Amount 30–100: none
gains more than a quarter of a percentage point of near-black or
near-white, and the limit's own properties (never past the extreme, order
kept, inward moves untouched).

If shadows still look heavy, raise **Shadow recovery** (the share of the
gain that lifts the dark side); if highlights look dull, lower **Highlight
compression**.

### The controls

| control | default | in the method |
|---|---|---|
| Compression amount | 0 (off) | β = 1 − 0.22 × amount/100 on every level |
| Detail preservation | 50 | α_k = the 50th…97th percentile of the level's gradients (73.5 % at 50): gradients below it keep their contrast |
| Shadow recovery | 50 | share of the gain that brightens: ×(value/50) |
| Highlight compression | 50 | share of the gain that darkens: ×(value/50) |
| Local contrast | 50 | gradients below the level's 70th percentile (or α_k if lower) get the exponent 1 − 2 × (1 − β) × (value − 50)/50: at 50 they keep their contrast, towards 100 they are raised (the product of the raises bounded by 1 + (value − 50)/50), towards 0 flattened |
| Saturation protection | 75 | chroma of darkened pixels, after the curves (above) |

Shadow recovery and Highlight compression are an extension: the paper's
method is symmetric in the log domain. At 50 and 50 their shares are 1 and 1,
which is the method as published (with the anchor above). Local contrast
at 50 leaves the small gradients alone. An earlier version mirrored the
attenuation's exponent below the threshold at 50 (the paper's single power
law); on real negatives that raise was what deepened the shadows of
backlit frames (near-black share of L1002388: 0.3 % off, 19 % at Amount 70
with that raise, 10.5 % without it), so the neutral point moved to 50 and
the raise lives above it. The rest of that deepening is the median anchor's
(`docs/audit-backlog.md`).

Two departures from the paper, both measured in the first round
(`.cache/drc/proto/controls.mjs`, nine frames, Amount 60; four of them were
the positive photos withdrawn below, so these figures are indicative): the paper's α = 0.1 × the level's mean
gradient, every small gradient raised on every level and the result
rescaled to the display. Without that rescale (the anchor keeps the frame's
level, which a converter must do) it cost the frames 19 % of their fine
detail and 27 % of their mid-scale detail; with a percentile threshold and
the raise below it, 5 % and 20 % (the mid-scale loss is the compression of
medium edges itself). Raising on every level also multiplied grain up five
times over in calm areas. The raise is measured against the level's 70th
percentile, not against the Detail threshold: against the threshold, Detail
100 raised nearly every gradient and expanded the range past the original
(+2.1 stops against +1.0 for off).

What each control does, alone, from Amount 60 with the others at 50 (mean of
nine frames: five public synthetic negatives and four real ones, L1002028,
L1002100, L1002112, L1002404; `.cache/drc/proto/controls.mjs`; log₂ of the
positive's brightness on the solve grid; range p2–p98 of the 8-px blurred
frame, detail the high-pass energy at 1 px and 1–6 px), on the final tuning:

| setting | range | shadows (p10) | highlights (p90) | mid detail | fine detail |
|---|---|---|---|---|---|
| Amount 0 (off) | +1.00 stops | −0.26 | +0.66 | +28 % | +15 % |
| Amount 30 / 90 | +0.38 / −0.27 | −0.12 / +0.08 | +0.28 / −0.21 | +12 / −10 % | +7 / −5 % |
| Detail 0 / 100 | −0.74 / +0.83 | +0.28 / −0.24 | −0.35 / +0.58 | −22 / +25 % | −18 / +14 % |
| Shadow recovery 0 / 100 | +0.24 / −0.15 | −0.28 / +0.22 | −0.02 / +0.02 | +12 / −11 % | +7 / −5 % |
| Highlight compression 0 / 100 | +0.71 / −0.52 | +0.03 / −0.03 | +0.68 / −0.55 | +16 / −13 % | +9 / −6 % |
| Local contrast 0 / 100 | −0.19 / +0.36 | +0.10 / −0.14 | −0.01 / +0.03 | −13 / +26 % | −21 / +43 % |

Shadow recovery and Highlight compression are independent by construction:
one never changes a pixel the other moves (checked to 10⁻⁶ in
`dynamicRange.test.mjs`). Detail is not independent of Amount: protecting
more gradients leaves fewer to compress, so Detail 100 also compresses the
range less (and Detail 0 more). That is what preserving detail means here;
the two are reported as they are rather than forced apart. Anchor
(RawTherapee's third control) was not added: Shadow recovery and Highlight
compression already decide which side of the frame's typical tone moves, and
a median anchor kept frames that are mostly a dark void dark where a range-
midpoint anchor lifted them to an empty grey.

## Design: what was measured

Measured again on the final tuning, on real negatives: 66 frames from two
client rolls (Leica M11 DNGs of colour and B&W film, 31 colour and 35 B&W),
decoded neutrally by `rawtherapee-cli` at 2400 px, cropped to their inner
88 %, typed colour or B&W by their chroma and converted by SilverCore in
Node (`.cache/drc/proto/measure31b.mjs`). The first round's "owner's
negatives" set (`L10021xx`) turned out to be mostly positive digital photos
that the harness had forced through the colour-negative path; its figures
are withdrawn. In the Studio those frames are typed Positive and convert
correctly (L1002152 included).

### 3.1 Where in the pipeline

Amount 70, other controls at 50. "Highlight detail" is the local contrast
of the scene's brightest 2 % (by the negative's density) against the
midtones', on the positive; "near black" and "near white" the share of
pixels with luminance at most 1 % or at least 99 %:

| | highlight detail, median (p10–p90) | shadow detail, median | frames > 1 % near white | frames > 1 % near black |
|---|---|---|---|---|
| off | 0.46 (0.30–0.77) | 1.21 | 3 | 2 |
| A: on the converted 16-bit positive | 0.44 (0.24–0.73) | 1.85 | 1 | 0 |
| B: on the negative, before the curves (the product) | 0.56 (0.44–1.17) | 1.26 | 0 | 1 |

(The final method, with the per-pixel limits of "No crushed shadows" in
both A and B. Before them A sent 15 frames past 1 % white and B darkened
two frames' shadows: L1002388 0.3 % → 10.5 % near black, L1002112 0.6 % →
3.2 %.)

Without the compression the shoulder squeezes the brightest 2 % into few
levels on some frames (7 of 66 keep under 600 distinct 16-bit levels there,
one only 5). Compressing the positive (A) cannot bring that back: it lowers
the highlight detail and multiplies the deep shadows' noise (shadow detail
1.85). Compressing the negative (B) spreads the highlights out again and
clips none; its one frame with more than 1 % near black was there without
it and has less with it (L1002408, 2.1 % → 1.3 %). So B: the
information the curve squeezes into a few levels still exists on the
negative, and only there can it be spread out again. It is also where the
method is defined (scene-referred log luminance) and where RawTherapee puts
it (before its tone curves).

### 3.2 At what resolution

A full-size solve at 60 MP is about 20 s and 2 GB on the CPU; a capped solve
is 52–90 ms (512 px) on one Node thread (M5 Pro). The question was whether a
capped map upsampled per pixel leaves halos at strong edges. On a synthetic
room with a window 5.8 stops brighter (`.cache/drc/proto/halo.mjs`,
1800 × 1200, grid 512), the band next to the edge against its plateau
40–120 px away:

| upsampling of the map | halo at Amount 25 / 50 / 100 (stops) |
|---|---|
| full-size solve with the same attenuation (reference) | 0.003 / 0.002 / 0.001 |
| bilinear | 1.15 / 1.68 / 2.05 |
| joint bilateral (guided by the pixel's luminance) | 0.003 / 0.003 / 0.002 |

On four real negatives (Amount 70, `.cache/drc/proto/measure32.mjs`),
error against the full-size solve at the 99th percentile near the strongest
1 % of edges: joint bilateral 0.21–0.57 stops, bilinear 0.28–0.65 (11–27 %
lower), at both 256 and 512 px grids. Away from edges both are the same
(0.03–0.37 stops): that part is not the upsampling but the map itself,
whose attenuation depends on the resolution it is solved at. So the capped
map with joint bilateral upsampling, at 512 px: no halo, fastest, and the
result does not depend on the resolution it is applied at.

Since the map depends on the pixels it is solved from, there is one map per
photo: the editor makes the sample from the full-resolution frame
(`app/dynamicRangeHint.js`, in slices of about 8 ms on the page, integer
sums, so the numbers are those of the adapter's own `sampleDrcInput`) and
sends it with every conversion of the open photo; a full-resolution
conversion without it (a batch lane) makes the same sample from the same
pixels, and the band pool from its bands' partial sums.

### GPU and CPU

The owner asked for the GPU first, for speed. The split:

- **CPU, deterministic:** the sample (integer sums) and the solve (Float64
  DCTs), 130–190 ms per photo at 60 MP together, once per photo and
  solve-setting (Amount, Detail, Local contrast); Shadows, Highlights and
  Saturation protection never re-solve. Keeping the solve on the CPU keeps
  the map, the part every pixel depends on, identical on every machine.
- **GPU, per pixel:** the joint bilateral lookup, the shares, the strokes'
  stops, the exposure and the protection weight.
  - *Full resolution* (exports, batch lanes, the detail layer, the band
    pool's bands): `render/dynamicRangeGpu.js` on each conversion worker's
    own WebGL2 context (OffscreenCanvas). Built like focus recovery
    (`docs/focus-recovery.md`): the integer plane goes up as RGBA16UI bands
    of whole rows (at most 4 MP each), float32 inside, two integer targets
    come back (RGBA16UI pixels, R8UI weights) through pixel-pack buffers
    into the same places. A plane in shared memory is never written: its
    band is copied to a private buffer first. A failed band (lost context,
    an error) is finished by the reference, the rest stay GPU; no WebGL2 at
    all means the reference for the whole frame.
  - *Preview:* a stage of the GPU preview's shader (`previewShader.js`,
    units 13 and 14: the map as an RG32F texture, the range table as R32F),
    at the same point of its chain (after the positive stage, before the
    curves; protection after saturation and before paper). The GPU preview
    stays on with the compression. The map comes from a small page worker
    (`drcMapWorker.js`); while the map for a new Amount, Detail or Local
    contrast is being solved, the photo's newest map stands in, so a drag
    never waits for a solve.
- **The reference** (`exposeDrcReference`, JavaScript, the same arithmetic
  in float64) is the definition: Node tests run it, the smoke compares the
  GPU to it, and it runs wherever the GPU stage cannot.

Agreement, measured in Chrome on this Mac (`scripts/dynamic-range-smoke.mjs`,
a synthetic 9-stop negative, frames crossing band borders, strokes on and
off, colour and positive): the full-resolution GPU stage differs from the
reference by at most one 16-bit code on about 0.2 % of the values, and by
at most 1 in the protection weight; the preview shader stage against the
CPU preview chain by at most one 8-bit level, ≥ 99.96 % identical. Different
GPUs may round the last bit differently, as focus recovery's may: a
compressed export is identical on one machine run after run, not
necessarily across GPUs (an uncompressed export is unchanged). Saturation
protection itself is applied after the curves in JavaScript from the
weights (`applyDrcProtection`), as the curves are.

## Paths

| path | |
|---|---|
| GPU preview (slider drags) | the shader stage, with the photo's map from the map worker (a stand-in map while a new one is solved); the GPU preview stays on |
| display preview, detail layer (zoom) | the preview worker converts with the photo's sample, the exposure on that worker's WebGL2 stage; a detail region gets the frame's stops at its own pixels (`frame` option), equal to that window of the full frame |
| single export (8 and 16 bits, fused 16-bit, gain map source) | the full-resolution conversion in the conversion worker: the editor's sample, the same map, the GPU stage (reference without WebGL2) |
| batch export, contact sheet | `processFileWithSettings` converts with the item's settings. On the band pool too: each band sums its cells of the sample, worker 0 solves in the tables step, every band runs the stage on its own worker's WebGL2 context with its frame coordinates. Byte-identical to one worker (`dynamicRange.test.mjs`, reference; `batch-pipeline-smoke.mjs`, GPU). A frame smaller than the solve grid stays in one worker |
| filmstrip thumbnails, tiles | converted with the photo's settings from their small decode: the sample is made from that, so the compression is the same kind, not the same bytes (up to about 0.1–0.3 stops at the 99th percentile at 320 px) |
| histogram, clipping warning | drawn from the converted frame, so they show it |
| Sync color, recipes, processing settings, roll reference | the six controls travel with them (tone settings); the hint's dismissal does not |
| undo/redo, history, projects, batch job snapshots | all seven keys (`SNAPSHOT_SCALAR_KEYS`, `sanitizeSettings`, `deepCopySanitizedSettings`) |
| linear DNG export | not applied: it exports the geometry-applied negative's linear data, before any conversion |
| "Hold to see before" (the group's button) | converts the photo without the compression, with its Step 3, and shows it over the photo while held |

Order with the other stages: dust removal, repairs and focus recovery act on
the converted positive, the compression on the negative inside the
conversion, so it comes first of them (repairs and focus recovery read the
compressed positive). The expired-film rescue, Step 3 (exposure, contrast,
highlights/shadows, curves) and the look come after it. The rescue measures
its analysis-area preview, which (like the dodge-and-burn strokes) is never
compressed.

Off is free: with Amount 0 `_planDrc` returns before allocating anything,
no key or plane changes, and every output is byte-identical
(`dynamicRange.test.mjs` checks colour, B&W and positive, 8 and 16 bits).

## Leading users to it

**What the compression would give a photo** is measured, not guessed
(`estimateDrcEffect`). With the conversion's own curves, on a strided sample
of 16 k pixels of the picture and on its 256 px grid:

- *the gain*: the fine detail a viewer sees in the picture's darkest and
  brightest tenth: the contrast a texture of ±0.1 stop on the negative makes
  there on screen, as Weber contrast in linear light with the screen's
  flare (2 % of white: a difference in deep shadow is lost in it). The
  curves' toe and shoulder flatten it; the compression moves an end back to
  where the curve shows it. This is the position study's measure (local
  contrast in the ends), on the cheap estimate;
- *against it*: what the middle loses of its local contrast between
  neighbouring grid cells (the flat, grey look), an end moved by more than
  25 display levels (a bright end dimmed to grey, a dark end lifted to
  grey), and a colour change in the ends (chroma relative to brightness, so
  an exposure change that keeps the saturation does not count and a black
  turning blue does);
- *excluded*: any setting that adds near-black or near-white (within 1 %)
  beyond a quarter of a percentage point of the sampled pixels.

**Auto** weighs 36 settings: Amount 15, 30, 50 and 70 with Shadow recovery
and Highlight compression at 25, 50 and 75 (only Amount needs a solve; the
shares are per pixel). It takes the gentlest setting within 90 % of the best
score (smallest Amount, then shares nearest 50), and when no setting scores
above 0 it leaves the compression off and says so ("This photo's brightness
range already fits"). Detail stays at 50, Local contrast at 50 and
Saturation protection at its default. Auto works from Amount 0 in one
press, measuring the photo first if it has not been measured.

**The hint** is offered when Auto's score is at least 6
(`DRC_HINT_THRESHOLD`). It says what the user gains, from the end whose
detail comes back: "Detail in this photo's bright areas (sky, windows,
lights) is washed out…", "…dark areas is lost in shadow…" or both, with
**Apply** (Auto) and **Not now**, as unobtrusive as before. It is measured
about a second after a photo's automatic conversion, when the page is idle
(a separate conversion of the display level in the worker), so opening a
photo never waits for it. It comes once per photo per session; Not now,
Apply, or moving Amount above 0 keeps it away for good (`drcHintDismissed`,
saved with the photo).

The measure and the threshold were chosen by looking, on the 66 real
negatives and the 32 public frames (`.cache/drc/proto/hintset.mjs`, each
frame converted at 1600 px; `.cache/drc/hint/`: `hinted_*.png`,
`not_hinted_sample_*.png`, `auto_worst10_*.png`, each cell the frame without
| with Auto, names in the `.txt` beside each page):

- the hint goes to 19 of 98 frames: 8 of the 66 real negatives (L1001985 a
  white car in sun, L1002419 a jellyfish on black, L1002425, L1002415 and
  L1002441 contrasty underwater B&W frames, L1002384 a forest pond, L1002376,
  L1002396 a night street with lamps) and 11 of the 32 public frames;
- the public frames were made with an expanded range, so many have blown
  whites by construction; some of those hinted look ordinary at thumbnail
  size, Auto bringing their whites down a little;
- missed by eye: the tunnel window (L1002450, 5.3), a sun flare over grass
  and the coloured glasses (public), just under 6;
- Auto switches the compression on for 88 of 98 frames when asked, never
  adds near-black (worst +0.01 points) or near-white (0); its ten largest
  moves (`auto_worst10`) look natural.

Three versions of the measure were tried and dropped, by eye: neighbour
contrast on the grid (the compression lowers it by design), fine detail in
display levels (it rewarded dimming bright subjects to grey, and called
lifted shadows a loss), and a hue-angle colour term (it missed a black
background turning blue in a fire picture).

**Inside the picture.** The measure reads the picture only (the
conversion's analysis region, the crop or the detected frame of an
uncropped scan, less its border), and when the conversion names the
picture the map is solved on it alone, so a film holder or rebate in view
neither counts as clipped nor takes part in the solve. Tested in
`dynamicRange.test.mjs` (a picture inside a holder 150 px wide, 60 % of the
scan: the decision is the picture alone's; measured on the whole scan the
holder adds over 20 % of "clipped" area). In the Studio on the owner's
60 MP camera scan L1002152 (a B&W positive, uncropped, a strip of holder
along its bottom edge): benefit 0.40, no hint; the same frame in Node reads
0.23 uncropped, 0.30 with the picture named as the analysis region, 0.33
cropped to the picture (the strip is 1.6 % of the height; the Studio
detected the frame but kept no analysis area for it).

The measure sees the conversion's curves only: the stages after them (the
automatic colour correction's tone, Step 3, a look) are not in it. Where
they crush or lift the ends further, the hint can miss a photo that would
show the gain on screen (`docs/audit-backlog.md`).

## Compared with RawTherapee

`.cache/drc/compare/` (original | ours at 50 | RawTherapee at 20, its
default | RawTherapee at 50; RawTherapee gets our uncompressed positive as a
16-bit TIFF and compresses it in its linear working space), four real
negatives (L1002028, L1002100, L1002112 colour; L1002404 B&W) and four
public frames (synthetic negatives of `n7`, `n50`, `n75`, `n96`),
regenerated on the final tuning. The same kind of processing: highlights
come back, shadows lift, no halos, in both. Luminance p2 / p98 of the
positive and fine detail (high-pass energy against the original):

| frame | original | ours 50 | RawTherapee 20 | RawTherapee 50 |
|---|---|---|---|---|
| L1002028 | 0.113 / 0.927 | 0.187 / 0.902, detail 0.98 | 0.180 / 0.904, 0.92 | 0.281 / 0.883, 0.85 |
| L1002100 | 0.109 / 0.966 | 0.203 / 0.900, 0.96 | 0.186 / 0.897, 0.93 | 0.305 / 0.865, 0.84 |
| L1002112 | 0.039 / 0.931 | 0.050 / 0.863, 0.98 | 0.055 / 0.845, 0.87 | 0.075 / 0.772, 0.76 |
| L1002404 (B&W) | 0.042 / 0.967 | 0.150 / 0.922, 1.01 | 0.116 / 0.907, 0.94 | 0.217 / 0.844, 0.88 |
| n75 | 0.015 / 0.985 | 0.014 / 0.882, 0.93 | 0.046 / 0.940, 1.00 | 0.111 / 0.891, 0.98 |
| n96 | 0.016 / 0.992 | 0.076 / 0.951, 0.95 | 0.039 / 1.000, 1.08 | 0.089 / 1.000, 1.22 |
| n50 | 0.016 / 0.958 | 0.044 / 0.926, 0.91 | 0.029 / 0.931, 1.06 | 0.056 / 0.934, 1.10 |
| n7 | 0.017 / 0.981 | 0.158 / 0.956, 0.90 | 0.061 / 0.965, 1.00 | 0.142 / 0.953, 0.96 |

- On the real negatives ours at 50 sits between RawTherapee's 20 and 50 in
  range and keeps the fine detail (0.96–1.01 against 0.76–0.94): it
  compresses on the negative, where the curve has not yet flattened the
  highlights.
- What the crush fix moved (against the previous round's run): L1002112's
  and n50's darkest 2 % now come up as RawTherapee's do (p2 0.039 → 0.050,
  0.016 → 0.044; they went down to 0.008 and 0.009 before); L1002028 lifts
  a little less (0.204 → 0.187); fine detail on the real negatives
  0.96–1.01 (0.97–1.06 before), on the public frames 0.90–0.95 (0.91–0.96).
- RawTherapee raises saturation as it compresses (visible in reds); ours
  holds it in the darkened highlights.
- On a synthetic 6-stop window ours at 25 leaves 2.8 stops and at 50 1.2;
  RawTherapee at 20 leaves 3.35, at 50 1.4.

## Measured cost

Chrome, this Mac (M5 Pro, ANGLE Metal), a 60 MP M11 negative (L1002112,
9536 × 6336), before → after this round's GPU work:

| | round 1 (CPU) | now (GPU) |
|---|---|---|
| slider release to the updated frame, a compression control | 251–296 ms | GPU frame 4–18 ms; the exact settled frame 40–116 ms |
| the same, Saturation protection | 43 ms | 4–18 ms |
| first switch-on (no sample, no map yet) | 296 ms | 213 ms |
| main-thread tasks over 50 ms during drags | none | none |
| added to the conversion of a single export | +4.7 s (7.8 s against 3.1 s, JPEG) | +0.45 to +0.63 s (1281–1396 ms against 651–951 ms) |
| of which: sample / solve / per-pixel stage / protection | 99 / 63 / 1636 ms (stops) + exposure | 0 (the editor's) / 92 / 302–359 ms (GPU) / the rest |
| the whole single export (PNG 8-bit, three pairs) | | +0.59 s, +0.97 s, and one pair −0.46 s (another agent's tests were running on the machine) |

The slider figures were measured on a 60 MP M11 frame (L1002152, display
frame 1941 × 1290) before the final retune of the anchor and Local
contrast, which changes the numbers the solve produces, not its work. The
GPU stage alone on a 24 MP plane: 94 ms against 1250 ms for the reference;
60 MP 230–360 ms. Saturation protection after the curves was the largest
remaining part (0.8 s at 60 MP when every weight is non-zero); a tighter
loop with a table of the 256 weights (same rounding, byte-identical) brought
it to 0.25–0.74 s in Node. Both targets of this round (slider under 60 ms,
export under +1 s at 60 MP) are met where WebGL2 runs in the worker.

Without WebGL2 in the worker the reference runs: its fused exposure takes
1.85 s at 24 MP and 4.65 s at 60 MP on one Node thread, about round 1's
cost (+4.7 s per 60 MP export).

The hint's estimate (four 256 px solves and 36 settings weighed) takes
140–190 ms in the worker for a 1600–2400 px display level; it is measured
when the page is idle after a photo opens, not with its conversion.

### WebKit (the App Store builds, WebKitGTK)

Playwright's WebKit build on this Mac (Safari 26.5's engine), driving the
production build served with the isolation headers on every response
(under `vite preview` WebKit refused the conversion workers, "blocked by
Cross-Origin-Embedder-Policy", although the headers were sent; a plain
server without caching loads them):

- a dedicated worker gets an OffscreenCanvas WebGL2 context, with float
  render targets (EXT_color_buffer_float: RGBA32F and RGBA16F complete) and
  the integer targets the stage draws to (RGBA16UI, R8UI); RG32F uploads;
- the full-resolution stage in WebKit against the reference: at most one
  16-bit code on 0.24–0.30 % of the values, weights at most 1, across a
  band border (2348 × 1997: GPU 24–81 ms, reference 604–610 ms);
- every compressed conversion of the app ran on the workers' GPU stage
  (`__ncDynamicRange.paths()`: 22 and 13 conversions, none on the
  reference); the reference fallback itself is tested in Node (no stage, a
  stage that cannot start, one that fails part-way: the reference's pixels);
- the GPU preview's own check of the compression's shader stage (run at
  its start-up, `__ncDynamicRange.previewSelfTest()`): identical to the CPU
  chain (0 levels);
- times: at 60 MP (L1002112) release to the updated frame 47–178 ms (the
  first switch-on 178 ms; display level 1131 × 752); the GPU preview's frame
  16–23 ms once the map is there (24 MP, DPR 2); a single export 3.46–3.78 s
  with the compression against 3.20–3.23 s without (+0.24 to +0.58 s); at
  24 MP 610–628 ms against 625–681 ms (no added time measurable);
- one run at DPR 2 lost its page at the first switch-on (WebKit's
  WebContent process ended); four later runs at DPR 2, two with the
  compression, did not, so it is not reproduced.

So in WebKit the worker stage and the preview stage are the GPU ones; the
page's context is not needed for full resolution.

### First switch-on

When a photo opens, the page makes its sample in slices and asks the map
worker for the map at the default settings once the page is idle. The
first time Amount moves, the GPU preview draws at once with that map (24 ms
in Chrome on the hint photo), then with the map for the chosen Amount when
it is solved; the frame on screen never waits.

### Memory

There is no stops plane: the stops are computed per pixel inside the
exposure (GPU or reference). What a compressed conversion holds beyond an
uncompressed one:

- the saturation protection's weights, 1 byte per converted pixel (60 MB at
  60 MP), from the exposure to the curves. Counted: `DRC_BYTES_PER_PIXEL` in
  `batchExportScheduler.js`, added to a lane's reservation
  (`laneReservationBytes`) and to the decode-ahead estimate
  (`planDecodeAhead`, `compressing`) when a job's recipe has
  `drcAmount > 0`;
- the sample (for a 3:2 frame 512 × 324 cells × 3 floats, 2 MB) and up to
  four maps per worker (log gain and guide, 1.3 MB each);
- on the GPU stage, per band of at most 4 MP: the input texture, the two
  targets and their pixel-pack buffers (about 100 MB of GPU memory, released
  with the worker's context); for a plane in shared memory, a private copy
  of one band (32 MB), not per pixel of the frame.

## Known limits

- The hint and Auto measure the conversion's curves, not the stages after
  them (the automatic colour correction's tone, Step 3, a look).
- Lifted shadows lose some saturation (Saturation protection acts on the
  darkened side only).
- Auto may dim a bright subject (a jellyfish, a fish on black) by about 20
  display levels to show its texture.
- A compressed export is reproducible on one machine, but different GPUs
  may round the last bit of some pixels differently (one 16-bit code).
- The map of a thumbnail or tile of an unopened photo is solved from that
  small decode, not from the full frame.
- Very strong settings (Amount above 80 with Highlights or Shadows at 100)
  can leave a faint band of 0.02–0.05 stops where the gain changes sign.
- The detail percentile is per level of the frame, so a frame that is almost
  all edges compresses less than a calm one at the same Amount.
- Platforms: Chrome and WebKit measured on macOS (above). Not measured:
  WebView2 (Windows, Chromium: expected to behave as Chrome), WebKitGTK
  (Linux) and WKWebView on iPhone/iPad (the same WebKit engine family as
  the one measured, but their GPU drivers and memory limits differ). Where a
  worker has no WebGL2, `createDrcExposer` reports unsupported and the
  reference runs: the same pixels within one code, about 4.7 s more per
  60 MP export.
- WebKit: the first switch-on of a 24 MP RAW did not draw on the GPU (the
  worker converted it while the frame stayed on screen); later ticks did.
  Probably the full decode replacing the preview after the warm-up; not
  verified.

## Validation

```bash
node negative2positive/src/pipeline/dynamicRange.test.mjs
node negative2positive/src/app/dynamicRangeHint.test.mjs
node scripts/smoke-test.mjs --drc-only
node scripts/smoke-test.mjs --batch-pipeline-only
```

`dynamicRange.test.mjs`: the FFT and DCT against their definitions, the
Poisson solve against exact solutions, a flat frame and Amount 0 (no map),
an 8-stop three-zone scene (the range falls with Amount, texture kept, no
halo at the 4-stop edges), each control's own effect, determinism, the
sliced sample, display-size against full-size stops, a detail region, the
adapter (off byte-identical in colour, B&W and positive; on lifts shadows and
lowers highlights; interactive = full-resolution path; the editor's sample =
the conversion's own; a region = that window of the frame; protection only on
darkened pixels; the estimate changes no pixel), the band pool equal to one
worker byte for byte (colour, B&W, positive, with and without the editor's
sample), the hint inside a film holder, no crushed or blown ends at Amount
30–100 on four scenes and the limit's own properties, Auto adding no
clipped area and an ordinary frame getting no hint, and the fallback to the
reference (no GPU stage, one that cannot start, one that fails part-way).
`dynamicRangeHint.test.mjs`:
recipe code, Sync color, snapshots, main.js's key lists, the GPU preview
gate, when the hint is wanted and what it says, Auto, the page's sampler.

The DRC smoke, in the real Studio: the GPU stage against the reference
(within one code, across a band border, dense and tiled strokes, a
positive), the GPU preview's shader stage against the CPU chain (within one
level), WebGL2 in a worker; then a synthetic 9-stop 16-bit negative: the hint and
Not now, Auto (the histogram's ends move in), Undo/Redo (the frame exact),
Hold to see before, a single export and Export All (same pixels, the
compression on screen), and Amount 0. The batch-pipeline smoke exports
three photos with the compression serially and on the band pool: the files
must be identical, and the pool reports which bands ran on the GPU
(`drcBands`).

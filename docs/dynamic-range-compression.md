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
`pipeline/dynamicRange.js` (the method, the sample, the per-pixel stops,
saturation protection, the hint's estimate and Auto), `_applyDrc` in
`pipeline/silverAdapter.js` (where a conversion applies it),
`app/dynamicRangeHint.js` (the page's sample and the hint) and the section
"Dynamic range compression" of `app/main.js`.

## The method

1. **Sample.** The negative as the engine receives it (geometry applied,
   before film-base compensation) is reduced to a grid of about 512 px on its
   long side (both sides products of 2, 3 and 5), each cell the mean of the
   16-bit codes it covers, then made linear (the same 2.2 gamma as the
   dodge-and-burn stops) and reduced to Rec. 709 luminance L.
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
6. **Gain.** The log gain of the luminance itself, ln(L_out / L), with the
   part that brightens the picture scaled by Shadow recovery and the part
   that darkens it by Highlight compression (on a negative the signs are the
   other way round), limited to ±4.5 stops. The map holds the log gain and H
   of each cell.
7. **Per pixel.** At any resolution each pixel gets the log gain of the
   map's four nearest cells weighted by distance and by how close their H is
   to the pixel's own ln(L + 0.001) (a joint bilateral upsampling, Kopf et
   al., SIGGRAPH 2007, range σ 0.5): the gain changes where the picture's edge
   is, not beside it. It becomes stops of exposure (log₂ of the gain).

### Where it acts: on the negative, before the curves (position B)

The stops are added to the dodge-and-burn stops
(`silvercore/util/localExposure.js`) after the engine's analysis and before
its curves: the same place, the same arithmetic, so every path that exposes
(the cached levels of the interactive slots, the transient full-resolution
path, the B&W grey paths, a detail region, the engine) applies the
compression alike. The engine's black and white points and automatic colour
are measured on the uncompressed frame, so turning the compression up does
not make the curve stretch back what was just compressed: compressed
highlights land inside the clip points instead of on them. On a negative
the bright areas are the picture's shadows (the gain's sign is read the
other way round); positives (slides, edit-mode positives) get the stage at
the same point without the inversion, after their gain and white balance.

**Saturation protection** acts after the curves, the one part that does: a
pixel the compression darkened by d stops loses up to 0.6 × (control/100)
of its chroma around its luminance, reached at 1.5 stops. Measured on the
owner's colour negatives, highlights brought down from the shoulder of the
curve came back about twice as saturated (HSV saturation 0.05 → 0.10 in the
lowered areas), while lifted shadows lose saturation (0.47 → 0.26): only the
darkened side is protected. B&W is untouched.

### The controls

| control | default | in the method |
|---|---|---|
| Compression amount | 0 (off) | β = 1 − 0.22 × amount/100 on every level |
| Detail preservation | 50 | α_k = the 50th…97th percentile of the level's gradients (73.5 % at 50): gradients below it keep their contrast |
| Shadow recovery | 50 | share of the gain that brightens: ×(value/50) |
| Highlight compression | 50 | share of the gain that darkens: ×(value/50) |
| Local contrast | 50 | gradients below the level's 70th percentile (or α_k if lower) raised with exponent 1 − 2 × (1 − β) × value/100, the product of the raises bounded by 1 + value/100 |
| Saturation protection | 50 | chroma of darkened pixels, after the curves (above) |

Shadow recovery and Highlight compression are an extension: the paper's
method is symmetric in the log domain. At 50 and 50 their shares are 1 and 1,
which is the method as published (with the anchor above). Local contrast at
50 mirrors the attenuation's own exponent below the threshold, as the
paper's single power law does.

Two departures from the paper, both measured (`.cache/drc/proto/controls.mjs`,
nine real frames, Amount 60): the paper's α = 0.1 × the level's mean
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
nine frames: five public synthetic negatives and four of the owner's; log₂ of
the positive's brightness on the solve grid; range p2–p98 of the 8-px
blurred frame, detail the high-pass energy at 1 px and 1–6 px):

| setting | range | shadows (p10) | highlights (p90) | mid detail | fine detail |
|---|---|---|---|---|---|
| Amount 0 (off) | +1.07 stops | −0.19 | +0.75 | +20 % | +4.6 % |
| Amount 30 / 90 | +0.44 / −0.28 | −0.08 / +0.08 | +0.31 / −0.21 | +8 / −5 % | +0.6 / −0.6 % |
| Detail 0 / 100 | −1.13 / +1.06 | +0.44 / −0.25 | −0.52 / +0.66 | −30 / +27 % | −28 / +17 % |
| Shadow recovery 0 / 100 | +0.16 / −0.10 | −0.24 / +0.22 | −0.03 / +0.05 | +4 / −2 % | −3 / +5 % |
| Highlight compression 0 / 100 | +0.86 / −0.51 | +0.06 / −0.05 | +0.77 / −0.55 | +16 / −10 % | +7 / −1 % |
| Local contrast 0 / 100 | −0.12 / +0.22 | +0.08 / −0.07 | −0.02 / +0.07 | −9 / +12 % | −14 / +18 % |

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

The two measurements below were taken with the first prototype of the
method (before the attenuation's threshold and the anchor were settled);
they decide where and at what resolution, not the final strengths.

### 3.1 Where in the pipeline

The owner's 46 RAW negatives (43 Leica M11 DNGs, mostly Delta 3200, three
colour ones; `_DSC3111.NEF`, `_DSC5290.dng`, `L1009967.dng`), decoded
neutrally by `rawtherapee-cli` at 2400 px, cropped to their inner 76 %,
converted by SilverCore in Node (`.cache/drc/proto/measure31.mjs`):

- Hard clipping after the curves: none (the soft clip keeps every channel
  off 0 and 65535).
- But the shoulder: in the brightest 2 % of the scene (by the negative's
  density) the positive keeps 0.11–0.76 of the midtones' local contrast
  (median about 0.3), and some frames have very few distinct levels left there
  (one frame 1, five frames under 600 of 65536).
- Compressing the 16-bit positive (position A) recovered none of it: the
  brightest 2 % stayed at 0.02–1.6 (mostly unchanged), the deepest shadows'
  noise was multiplied (shadow detail 1.5–56× the midtones'), and up to 7 % of
  pixels went to white.
- Compressing the negative before the curves (position B) brought the
  brightest 2 % to 0.26–2.6 of the midtones' contrast (mostly 0.5–1.2), with
  no pixel clipped.

So B: the information the curve squeezes into a few levels still exists on
the negative, and only there can it be spread out again. It is also where the
method is defined (scene-referred log luminance) and where RawTherapee puts it
(before its tone curves).

### 3.2 At what resolution

A full-size solve at 60 MP is about 20 s and 2 GB on the CPU; a capped solve
is 52 ms (512 px), 110 ms (768) or 194 ms (1024) on one Node thread (M5 Pro).
The question was whether a capped map upsampled per pixel leaves halos at
strong edges. On a synthetic room with a window 6 stops brighter
(`.cache/drc/proto/halo.mjs`, 1800 × 1200), the band next to the edge against
its plateau 40–120 px away:

| upsampling of the map | halo (stops) |
|---|---|
| full-size solve with the same attenuation (reference) | 0.002–0.005 |
| bilinear, grid 192 → 1024 | 2.4 → 1.2 |
| joint bilateral (guided by the pixel's luminance), grid 192 → 1024 | 0.003–0.006 |

On four real frames, error against the full-size reference near the top 1 %
of edges: joint bilateral 25–40 % below bilinear at every grid size. So the
capped map with joint bilateral upsampling, at 512 px: no halo, fastest, and
the result does not depend on the resolution it is applied at.

What does depend on resolution is the map itself: solved from a reduced copy
of the frame (1200 px instead of 1824) it differed by 0.006–0.024 stops on
average and up to 0.04–0.19 stops at the 99th percentile on real frames (grid
512; at 1024 it was worse). A light blur before the solve did not help and
brought halos back. Hence one map per photo: the editor makes the sample from
the full-resolution frame (`app/dynamicRangeHint.js`, in slices of about 8 ms
on the page, integer sums, so the numbers are those of the adapter's own
`sampleDrcInput`) and sends it with every conversion of the open photo; a
full-resolution conversion without it (an export, a batch lane) makes the
same sample from the same pixels.

### GPU or CPU

The owner asked for the GPU first, for speed. Measured, the solve is not
where the time goes: 52–100 ms for sample and solve per photo on one CPU
thread, in the conversion worker that already runs. The time is in the
per-pixel stops (27 ms per megapixel) and in the exposure pass they feed
(the dodge-and-burn arithmetic, `Math.pow` per channel), both inside the
engine's conversion in its worker. A WebGL2 solve would need the page's
context (OffscreenCanvas WebGL2 in a worker is not available everywhere this
app runs: WKWebView, WebKitGTK), a round trip of the sample and the map, and
would make the map, and with it every exported pixel, depend on the GPU's
rounding. So this version has no GPU code: the CPU reference is the
implementation, everywhere, and the same input and settings give the same
bytes on every machine of the same engine (Math.log/Math.pow may round the
last bit differently between JavaScript engines, as the existing
dodge-and-burn path already may). The GPU preview's shader has no stage for
the compression: while Amount is above 0 SilverCore ticks convert in the
preview worker instead of on the GPU (`gpuPreviewCanTake`), as they did
before #239. A shader stage (the map as a texture, the joint bilateral
upsampling per fragment) is the obvious next step if drags on compressed
photos feel slow.

## Paths

| path | |
|---|---|
| display preview, detail layer (zoom) | the preview worker converts with the photo's sample; a detail region gets the frame's stops at its own pixels (`frame` option), equal to that window of the full frame |
| single export (8 and 16 bits, fused 16-bit, gain map source) | the full-resolution conversion: the same sample (made from the same pixels), map and stops |
| batch export, contact sheet | `processFileWithSettings` converts with the item's settings; the lane's conversion makes the sample from its full frame. Not on the band pool (`bandsSupported` is false: the map is the whole frame's), so such a frame converts in one worker |
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

Off is free: with Amount 0 `_applyDrc` returns before allocating anything,
no key or plane changes, and every output is byte-identical
(`dynamicRange.test.mjs` checks colour, B&W and positive, 8 and 16 bits).

## Leading users to it

After a photo's automatic conversion the adapter estimates, on a strided
sample of 32k pixels and with that conversion's curves, how much of the frame
sits within 3 % of black or white without the compression and with it at
Amount 30, 50 and 70 (`estimateDrcEffect`, about 150 ms in the worker). If
Amount 50 brings back at least 8 % of the frame (`DRC_HINT_THRESHOLD`), a
toast offers it: "This photo has a wide brightness range…" with **Apply**
(Auto) and **Not now**. The threshold was set on the owner's 46 negatives
and 32 public frames (`.cache/drc/proto/hintdata.mjs`, cropped to the
picture): it offers it on 4 of the owner's frames (reductions 13.0–26.8 %)
and on 11 of the public ones, which were made with an expanded range; frames
that are dark or bright by design (a tunnel, a white wall: 90 % near black,
none recovered) are not offered it. In the Studio the estimate is taken on
the frame as converted: one of those four owner frames, opened with its
holder in the frame, read 3.5 % and got no hint. The hint comes once per photo per session; Not now, Apply, or
moving Amount above 0 keeps it away for good (`drcHintDismissed`, saved with
the photo).

**Auto**: the smallest of 30, 50, 70 that brings back 80 % of what 70 would;
the end that was clipped more gets the larger share (Shadow recovery and
Highlight compression 50 ± 15); Detail, Local contrast and Saturation
protection stay at 50.

## Compared with RawTherapee

`.cache/drc/compare/` (original | ours at 50 | RawTherapee at 20, its
default | RawTherapee at 50; RawTherapee gets our uncompressed positive as a
16-bit TIFF and compresses it in its linear working space), four of the
owner's frames and four public ones. The same kind of processing: highlights
come back, shadows lift, no halos, in both. Differences:

- Fine detail (high-pass energy against the original): on the owner's four
  frames RawTherapee at 20 and 50 kept 0.46–0.96 of it and ours at 50
  1.01–1.37; on the four public frames RawTherapee kept 0.96–1.22 and ours
  0.94–0.98. Ours keeps local contrast more evenly; RawTherapee lowers it on
  some frames and raises it on others.
- On a synthetic 6-stop window ours at 25 leaves 2.8 stops and at 50 1.5;
  RawTherapee at 20 leaves 3.35, at 50 1.4. Both keep the dark side where it
  was. On the owner's B&W frames ours at 50 compresses the range less than
  RawTherapee at 20.
- RawTherapee raises saturation as it compresses (visible in reds); ours
  holds it in the darkened highlights.
- On two public frames ours left the darkest 2 % slightly darker (p2
  0.015 → 0.008); RawTherapee lifts them. Local contrast raised around a black
  void next to a very bright area; the shadows' share or Local contrast set
  lower avoids it.

## Measured cost

Node, one thread, M5 Pro, synthetic contrasty negatives
(`.cache/drc/proto/perf.mjs`):

| | without | with (Amount 50) | of which |
|---|---|---|---|
| 24 MP full-resolution conversion | 375 ms | 2112 ms | sample 45, solve 75, stops 673 ms, exposure and protection the rest |
| 60 MP | 840 ms | 5504 ms | sample 99, solve 63, stops 1636 ms |
| 2400 × 1600 display conversion | 41 ms | 416 ms | |

In Chrome (M5 Pro) on a 60 MP M11 negative (display frame 1941 × 1290):
slider release to the updated frame 296 ms (Amount 0 → 50) and 251 ms
(Detail), 43 ms for Saturation protection (the map is kept) against 24–44 ms
for a control without the compression; no main-thread task over 50 ms. A
single JPEG export took 7.8 s with the compression and 3.1 s without.

The stops plane is 4 B/px while the frame converts (96 MB at 24 MP, 241 MB
at 60 MP, transient) and is counted in nothing yet: the memory ledger and the
lane planning (50 B/px) do not include it (`docs/audit-backlog.md`).

## Known limits

- The map of a thumbnail or tile of an unopened photo is solved from that
  small decode, not from the full frame.
- No GPU preview stage: compressed photos drag their SilverCore controls
  through the preview worker.
- Exports with the compression take 1.7 s more at 24 MP and 4.7 s at 60 MP;
  a compressed frame does not use the band pool.
- Very strong settings (Amount above 80 with Highlights or Shadows at 100)
  can leave a faint band of 0.02–0.05 stops where the gain changes sign.
- The detail percentile is per level of the frame, so a frame that is almost
  all edges compresses less than a calm one at the same Amount.
- WKWebView, WebKitGTK and WebView2 were not measured; the code uses no API
  beyond what the conversion workers already use.

## Validation

```bash
node negative2positive/src/pipeline/dynamicRange.test.mjs
node negative2positive/src/app/dynamicRangeHint.test.mjs
node scripts/smoke-test.mjs --drc-only
```

`dynamicRange.test.mjs`: the FFT and DCT against their definitions, the
Poisson solve against exact solutions, a flat frame and Amount 0 (no map),
an 8-stop three-zone scene (the range falls with Amount, texture kept, no
halo at the 4-stop edges), each control's own effect, determinism, the
sliced sample, display-size against full-size stops, a detail region, the
adapter (off byte-identical in colour, B&W and positive; on lifts shadows and
lowers highlights; interactive = full-resolution path; the editor's sample =
the conversion's own; a region = that window of the frame; protection only on
darkened pixels; the estimate changes no pixel). `dynamicRangeHint.test.mjs`:
recipe code, Sync color, snapshots, main.js's key lists, the GPU gate, when
the hint is wanted, Auto, the page's sampler. The smoke imports a synthetic
9-stop negative in the real Studio: the hint and Not now, Auto (the
histogram's ends move in), Undo/Redo (the frame exact), Hold to see before, a
single export and Export All (same pixels, the compression on screen), and
Amount 0.

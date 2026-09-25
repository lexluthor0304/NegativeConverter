# SilverCore conversion cache (#238)

`pipeline/silverAdapter.js` runs every SilverCore conversion: slider ticks in the
preview worker, settle renders, exports, frame repair and batch lanes. Much of the
per-pixel work produces the same pixels on every tick, so the adapter keeps it per
cache slot (`preview`, `full`, `scratch`). All of it is exact: exported and settled
pixels are bit-identical to the engine before #238, checked by SHA-256 against a
frozen copy (see Verification).

## Two kinds of request

- **Interactive**: no `forceFullProcess` and at most `LARGE_IMAGE_PIXELS` (16 MP).
  Preview-slot ticks, the full slot when the preview worker converts a source of
  4 MP or less there, the scratch slot (test strip) and roll thumbnails. These keep
  the planes described below.
- **Transient**: `forceFullProcess` (settle, export, frame repair, batch lanes) or
  larger than 16 MP. A worker receives a fresh copy of the source with each of these,
  so a cached plane would never be read again while pinning 8 B/px (480 MB at 60 MP)
  in a retained batch lane. The adapter clones the source once (or uses an 8-bit
  source's fresh 16-bit promotion), runs the flat field and film base in place and
  keeps nothing: no pristine plane, no `lastSourceRef`, no prepared plane. The
  analysis key identifies buffers through a `WeakMap` id, so it does not pin the
  source either. One 8 B/px work plane plus the 8-bit output.

## What an interactive slot keeps

1. **Pristine plane**: the source with the flat field and the film base applied
   (`_pristineFor`), rebuilt when the source buffer or the gains change. Without
   either, the source itself is the pristine state.
2. **Pre-exposure level** (`slot.prepared`): the B&W mix → pre-saturation → positive
   gain/WB, in the engine's order. It is a plane of its own only when one of those
   stages is active; otherwise it is the pristine plane or the source. Key: the
   analysis state (`_analysisStateFor`), the input buffer, the mode, the derived
   `positiveAnalysis` and the representation (RGBA or grey).
3. **Post-exposure level** (`slot.exposed`): the dodge-and-burn stops applied to a
   copy of the pre-exposure level; exists only while strokes exist. Key: the
   pre-exposure key plus the rasterised stroke map's key. A stroke edit rebuilds only
   this level; a stroke added or undone in place (#254, `slot.exposureChange`)
   updates it inside that stroke's box only.

A tick that changes neither key (Brightness, Contrast, Temperature, Saturation, Paper,
3D profile …) runs only the tail: `Engine.applyTail(src, dst, params)` builds the
curves and runs `_applyLuts`, whose first pass reads the cached level and writes the
fresh output buffer (alpha copied in the same loop). The cached planes are never
handed to the caller. `forceFullProcess`, `invalidateSilverCoreCache()` and a slot size
change drop every level.

The output buffer is fresh unless the caller hands one back as `options.workBuffer16`:
the preview worker passes the 16-bit plane of the dragged frame it retained (#233), so
a drag allocates no output plane after the first frame. The tail, the B&W grey-table
write and the transient work plane all take it; every one of them writes it in full,
so the pixels equal a fresh allocation. `_reusableOutput` refuses a plane of another
size or one that shares memory with the source, the analysis sample or a level the
slot keeps.

Memory per slot: none for a colour negative at defaults without strokes; one RGBA
level (8 B/px, 17.6 MB at 2.2 MP) when a prefix stage is active, two only while
strokes exist; B&W levels are grey planes at 2 B/px.

When the analysis changes and there is no reference sample, the level is built in
`process()` order: copy (and mix), `engine.analyze()` (which applies the
pre-saturation and derives the statistics and the positive analysis), then the
positive gain/WB. With a reference sample the sample is analysed as before and the
level is built as `reprocess()` builds its input.

## Forced positive conversions: the gain-1 fold

`applyPositiveAnalysis` with gain exactly 1 is `Math.round(v * wb[c])` per channel on
pixels with alpha ≠ 0. When no stops sit between it and the curves, `process`,
`reprocess` and `applyCurrentCurves` fold it into the curve LUT
(`fold_c[v] = lut_c[round(v * wb[c])]`, alpha-0 pixels keep the plain LUT) and skip the
pass. Gain above 1 is cross-channel and keeps the pass.

## B&W: one grey plane and one table

After the channel mix every B&W stage maps a pixel from its grey value alone
(pre-saturation, stops, curves, 3D profile, saturation, paper and toning).
`Engine.buildGreyTable(params)` runs the unchanged `_applyLuts` over a 65536-entry
grey ramp and returns the RGB result per grey value; `silvercore/util/greyPlane.js`
writes the RGBA16 and RGBA8 output from it in one loop (two 32-bit stores for 16
bits and one for 8 on little-endian platforms, per-channel stores elsewhere), alpha
taken from the source. The interactive level is a Uint16 grey plane with the mix and
the pre-saturation ramp (`Engine.preSaturationRamp`, the unchanged `adjustSaturation`
over the ramp, its 1-LSB drift included) baked in; stops run on one channel
(`applyExposureStopsToGrey`). The histogram is taken from that plane
(`analyzeGreyImage`, the same crop and levels as `analyzeImage`).

Forced B&W conversions keep no plane: one fused pass mixes, applies the stops and
writes through the table (the pre-saturation ramp composed into the table when there
are no stops). Without a reference sample the histogram is taken first from the same
mix computed on the fly over the analysis crop; at 12 MP this measured as fast as a
transient grey plane (81–89 vs 76–104 ms) without its 2 B/px.

The table is exact only while every stage after the mix is pointwise. Sharpening is
the one spatial stage today (unreachable from the adapter, which never sets
`sharpenAmount`); `buildGreyTable` returns null for it and the generic RGBA path runs.
Any future spatial stage must be registered in `tailIsPointwise` (Engine.js).

## HSL pre-test

`applyHSLAdjustments` skips a pixel on its integer values when its strict-maximum
channel belongs to an inactive band, or when it is a two-channel tie or grey: the band
weights are non-zero only inside their own strict-max sector, ties compute exactly the
sector borders where all weights are 0, and a zero shift round-trips the 16-bit
values. At the default `standard` model (which falls back to `basic`, blue band only)
only blue-max pixels still run the float round trip. A module-init self-check
(`checkHueBandSupport`) verifies the supports and the tie indices with the loop's own
expressions and disables the skip if a table change breaks them.

## Other exact micro-steps

The curve pass (`applyLUT`, `applyLUTInto`) and `toImageData8` work on little-endian
32-bit words (two loads and two stores per pixel, four 8-bit samples per store) and
fall back to per-sample loops elsewhere.

## GPU preview inputs (#239)

The WebGL2 preview (`docs/gpu-preview.md`) draws slider ticks from a prepared negative
and an analysis the preview worker computes in this same slot:

- `prepareSilverCorePreview` returns a copy of the pristine plane (null without film
  base or flat field, when main's own display preview is that plane), the stops of
  `localExposureStopsForSlot`, and point samples of both at the positions
  `downsampleImageDataForMaxPixels` takes, for the histogram.
- `analyzeSilverCorePreview` runs the analysis exactly as `runSilverCore` would (on
  the reference sample, or through `_prepareRgba` / `_prepareGrey` without the stops)
  and records `slot.analysis`, so the settle frame that follows reuses it like the next
  tick of a drag.
- `silverCoreAnalysisKey` is `_analysisStateFor` as a string, for main to tell when to
  ask again; `silverCorePreparedKey` names the film base and flat field;
  `trySilverCoreParams` is `buildSilverCoreParams` without waiting once the preset
  table has loaded.

`silverAdapter.preview.test.mjs` checks that the frames after them stay identical to
the 1703835 adapter and that the CPU apply chain over the prepared plane reproduces
them bit for bit.

## Verification

- `ImageProcessor.hsl.test.mjs`: the pre-test against the frozen HSL for the 256³
  lattice (default model), tie planes with offsets 0, ±1, ±2 and 1 M random triples for
  every colour-model and single-band setting, the forced fallback and the self-check.
  `npm run test:hsl-sweep` (and CI) runs the full sweep: lattice, 1 M tie points and
  10 M random triples for every setting.
- `silverAdapter.parity.test.mjs`: about 1600 conversions through the live adapter
  and the frozen one in `pipeline/oracle/` (1703835 copies of the adapter, engine,
  ImageProcessor and image16): all modes, film presets, paper × toning, B&W mixes,
  pre-saturation and saturation, enhanced profiles, colour models, positive gain 1
  and above 1, strokes, transparent corners, 8-bit sources, flat field, every slot with
  and without a reference sample and `forceFullProcess`, and sharpening forced on.
- `silverAdapter.prefix.test.mjs`: what each slot keeps, the rebuild keys, a
  Brightness drag that runs no prefix stage, and the gain-1 fold.
- `silverAdapter.memory.test.mjs`: a forced conversion allocates one 16-bit work
  plane and the 8-bit output.
- `greyTable.test.mjs`: grey histogram levels, pre-saturation ramp, grey stops, the
  table and both output loops against the RGBA stages.
- `node scripts/silvercore-parity-real.mjs`: the same hash comparison on real files at
  the repository root when present (`--max-mp` limits the size).

Node, synthetic frames, M1 Pro (medians; the frozen adapter first):

| case | before | after |
|---|---|---|
| colour tick 4 MP, `standard`, film base | 135–140 ms | 78–80 ms |
| colour tick 4 MP, `frontier` | 117–126 ms | 88–100 ms |
| colour tick 2.2 MP, with / without strokes | 82 / 62 ms | 34.5 / 34.3 ms |
| positive tick 2.2 MP / 4 MP, gain 1 with WB | 27–29 / 48–49 ms | 9.1–9.4 / 15–16 ms |
| positive tick 2.2 MP with strokes | 46 ms | 8.9 ms |
| B&W tick 2.2 MP / 4 MP, default | 16–17 / 28–29 ms | 6.6–7 / 10 ms |
| B&W tick 2.2 MP, selenium + `frontier` profile at 80 | 72–74 ms | 7.8 ms |
| B&W tick 2.2 MP with strokes | 39–40 ms | 6.4–6.8 ms |
| forced colour 12 MP | 424–559 ms | 269–338 ms |
| forced positive 12 MP, gain 1 | 190–197 ms | 103–125 ms |
| forced B&W 12 MP, no reference / reference | 122–147 / 87–122 ms | 84–89 / 52 ms |

On the `_DSC3111.NEF` frame crop scaled to 4 MP (decoded through `sips`, default
film base): `applyHSLAdjustments` 114 → 52 ms (44 % of its pixels are blue-max), the
preview-slot tick 113–118 → 67–69 ms. These are not the in-browser numbers of #229;
the #230 harness re-measures those on the real files.

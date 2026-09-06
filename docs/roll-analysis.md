# Roll analysis (one film base and one tone analysis for the whole roll)

Roadmap item #147. A minilab analyses the whole roll before it prints and then
varies only the exposure per frame. The app now offers the same: **Analyse
roll** in the Convert pane measures every selected frame, derives one film base
and one histogram analysis for the roll, locks the matching frames to them,
carries a per-frame exposure offset, and flags frames that do not belong.

## What the analysis does

`runRollAnalysis` (main.js) runs the same busy / undo / progress protocol as
"Auto frame selected":

1. **Pass 1, measure.** Each selected file is decoded once. Its rebate is read
   if that has not happened yet (`analyzeImportFilmEdge`), a 900 px sample with
   the file's rotation, mirror and crop applied is kept, and the frame's film
   base and mean negative luminance are recorded.
2. **Roll base and outliers.** `aggregateRollAnalysis` (`src/app/rollAnalysis.js`)
   compares the base chromaticity of every frame (channel shares, independent
   of light-box brightness). Rebate and manual samples weigh 3, auto samples
   1 + confidence. Frames whose red or blue share differs by more than 0.03
   from the weighted median, or whose base brightness differs by more than
   35 %, are outliers ("film base colour" / "film base density"); a frame
   without a base is one too. With fewer than three frames only the missing
   base counts. The roll base is the weighted median of the inliers
   (`method: 'roll'`).
3. **Pass 2, shared analysis.** Every inlier sample is analysed with the roll
   base through `analyzeSilverCoreFrame` (silverAdapter.js), which applies film
   base compensation, B&W mix, pre-tone saturation and the analysis crop exactly
   as a conversion would and returns the engine's channelData. The roll
   channelData takes the 20th percentile of the dark ends, the 80th percentile
   of the bright ends and the median mean point, so one odd frame cannot
   flatten the roll.
4. **Apply.** Each analysed file gets `settings.rollFrame = { rollId, locked,
   channelData, offsetStops, equalize, outlier, reasons }`. Inliers also take
   the roll film base (unless theirs was sampled manually). Outliers keep their
   own analysis and show the "≠ roll" badge on the strip.

Conversion honours the record through `buildCoreConversionSettings`:
`analysisOverride` hands the shared channelData to the engine
(`Engine.analyze` uses it instead of the frame's own histogram; the adapter's
analysis cache keys on it), and the per-frame offset is folded into the
exposure the engine sees. The offset is `log2(frame mean / roll mean)` of the
negative: a thinner (brighter) negative inverts to a darker positive and is
brightened. `exposureUnitsForStops` inverts the curve engine's mid-grey
exposure response so the offset is expressed in stops, not slider units.
**Equalise exposure across frames** (default on) toggles the offsets; the roll
lock stays. **Clear roll analysis** removes every `rollFrame`.

The record is per file: "Apply to selected" and the roll reference copy the
look but leave each frame's own `rollFrame` in place.

## Verification

Unit tests (`npm test`):

- `rollAnalysis.test.mjs`: chromaticity, negative mean with inset, aggregation
  of a five-frame roll with one foreign stock (outlier, weighted-median base,
  robust channelData, ±1 stop offsets), a light-box brightness outlier, the
  two-frame rule, the exposure mapping round trip at seven offsets, and the
  settings sanitiser.
- `silverAdapter.test.mjs` and `CurveEngine.test.mjs` still pass with the
  `analysisOverride` parameter added.

Smoke (`scripts/roll-analysis-smoke.mjs`, run by `npm run test:smoke` and by
`node scripts/smoke-test.mjs --film-edge-only`): three synthetic strips
(Ultra Max, Ultra Max with denser frames, Portra with a different base). After
**Analyse roll** the status reads "2/3 frames share one film base and tone
analysis · R 215 G 150 B 95 · 1 outlier(s): negative-strip-other.png", the
current frame is "locked to the roll, 0.0 stop", the denser strip opens with
the same film base and "-0.3 stop", the Portra strip shows "outlier (film base
colour)" and the badge, and **Clear roll analysis** resets everything.

```sh
npm test
node scripts/smoke-test.mjs --film-edge-only
node scripts/make-film-edge-fixture.mjs    # regenerates the three strips
```

## Limits

- Frames are decoded once more for the analysis (like "Auto frame selected");
  a 36-frame RAW roll takes as long as its decodes.
- The exposure offset is measured on the whole analysis region, so a frame that
  is legitimately dark (night scene) is brightened like an underexposed one.
  Switch off "Equalise exposure across frames" for such rolls.
- Outlier thresholds are fixed (0.03 chromaticity, 35 % brightness); a roll
  scanned under two different light sources is split into inliers and
  outliers rather than normalised.
- No white-balance residual per frame yet; the roll shares WB through the
  common base and analysis only.

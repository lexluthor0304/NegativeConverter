# Film edge reader (perforations, DX edge barcode, rebate film base)

Roadmap item #146. When a scan shows the film rebate, the app now reads it:
it finds the two perforation lanes, rectifies the bands outside them, decodes
the ISO 1007 DX film edge barcode, names the stock from the DX number and
samples the film base from the unexposed rebate.

## What happens on import

`prepareStudioPhoto` (and the headless `processFileWithSettings` path used for
unopened files in batch export) calls `analyzeImportFilmEdge` once per file.
The reader runs in the auto-frame worker (`read-film-edge` message; no OpenCV
needed) with a main-thread fallback. For a fresh file the detection also sets:

- film type, when the database says the stock is B&W or a slide film;
- the film preset, when none was chosen (`gold-warm` for Gold/Ultra Max,
  `portra-classic` for Portra, `superia-vivid` for Fuji consumer films, ...);
- the film base, taken from the unexposed rebate (`method: 'rebate'`), unless
  the base was sampled manually or came from a roll reference.

The result is stored per file as `settings.filmEdge` (`checked`, `found`,
`dxNumber`, `filmName`, `frames`, `filmBase`, `applied*`), shown in the Convert
pane ("Film edge" group with *Apply detected film* and *Use rebate as film
base*), as a toast, and as a badge on the film strip thumbnail. A file whose
rebate is not visible stores `checked: true, found: false` and is not analysed
again.

## How the reader works (`src/app/filmEdgeReader.js`)

1. **Perforations.** A nearest-neighbour raster (long side 1400 px) is
   thresholded at 86 % of its brightest level; white connected components with
   the KS perforation proportions (1.98 mm along the strip, 2.80 mm across,
   4.75 mm pitch) are clustered into lanes along x and along y. Two lanes about
   29 mm apart win; one lane is accepted with lower confidence. The pitch gives
   px/mm, a least-squares line through the hole centres gives the tilt.
2. **Rectified bands.** For each lane the band from the outer hole edge to
   2.9 mm outward is resampled bilinearly from the full-resolution pixels along
   the fitted line (0.05 mm per column, 0.08 mm per row), so a 0.42 mm DX
   module stays several pixels wide even on a whole-strip scan.
3. **Clock track.** Each row is normalised against the local clear base (85th
   percentile over ~20 mm, compared in linear light), binarised, run-length
   encoded, and searched for the clock pattern 5·1×23·3 (frame-number version)
   or 5·1×15·3 (older version) in both reading directions.
4. **Data track.** Clock detections are grouped by position; the module grid is
   the median over all rows of the clock track. The rows beyond the clock are
   sampled at the module centres; a decode must show the b/w/b/w/b start and
   b/w/b stop patterns, zero separators (bits 0, 8, 20, 22), and a parity bit
   equal to the number of set bits before it. The majority over the data rows
   wins and needs at least two agreeing rows.
5. **Polarity.** Negatives print dark bars on a clear base. If nothing decodes,
   the reader retries with clear marks on a dense base (slide film, and the
   app's own rendered borders).
6. **Film base.** Median colour of rebate samples that are neither print nor
   light box (`method: 'rebate'`).

DX part 1 (7 bits) and part 2 (4 bits) form the four-digit "DX extract"
`part1 * 16 + part2`, the key used by The Big Film Database.
`src/app/dxFilmTable.js` is derived from that database
(`scripts/derive-dx-film-table.mjs`; CC BY-SA 4.0, attribution in the file
header) and `src/app/dxFilmDatabase.js` classifies the trade name into film
kind and starting preset.

`sprocketFrame.js` (the border renderer) computed the DX parity bit from the
numeric sum of the fields; it now counts set bits like the standard, so
rendered borders decode with the same reader.

## Verification

Unit tests (`npm test`):

- `filmEdgeReader.test.mjs` synthesises a strip (`test-fixtures/syntheticFilmStrip.mjs`)
  and checks geometry (px/mm within 3 %, tilt), all placed codes and frame
  numbers, mirrored / 180° / 90° / 270° / half-size variants, a 1° tilt, a slide
  strip (light polarity), the 15-bit code, and two negative controls (flat
  image, framed negative without holes). Bit-level tests cover the published
  worked example (112-1 / 10A), parity and separator rejection, and clock
  search in both directions.
- `dxFilmDatabase.test.mjs` checks the lookups 95-7 → Ultra Max 400,
  112-1 → Vericolor III, 40-9 → Konica, 79-13 → Portra 400, classification
  of colour / B&W / slide names, and badge labels.
- `sprocketFrame.test.mjs` asserts the set-bit parity of rendered DX codes.

Smoke (`npm run test:smoke`, `scripts/film-edge-smoke.mjs`): imports
`test-fixtures/negative-strip-dx.png` through the file input and requires the
toast "Detected Kodak ULTRA MAX 400 GC400 (DX 95-7), preset applied, film base
from the rebate", the status "DX 95-7 · … · frames 30–32 · 5/5 codes agree",
preset `gold-warm`, film base 215/150/95 from the rebate, the strip badge, the
*Apply detected film* button after clearing the preset, and silence on
`negative-plain.png`. The gated RAW smoke (`AUTOFRAME_RAW_DIR=. npm run test:smoke`)
adds the real strips below.

Real scans (repository root, Nikon Zf camera scans of Kodak Ultra Max 400,
edge print "GC 400"), read in Node from `sips` PNG renders:

| file | pixels | codes decoded | frames | time |
|---|---|---|---|---|
| DSC_8800.NEF | 6048×4032 | 3 of 4 visible (one under the reel) | 30A, 31, 31A | 71 ms |
| DSC_8800 at 3000 px | 3000×2000 | 3 | 30A, 31, 31A | 64 ms |
| DSC_8800 at 1000 px | 1000×666 | 3 | 30A, 31, 31A | 30 ms |
| DSC_8798.NEF | 3000×2000 | 2 | 36, 36A | 45 ms |
| DSC_8806.NEF | 3000×2000 | 2 | 21, 21A | 54 ms |
| DSC_4127.NEF (holder, no rebate) | 3000×2000 | none, `found: false` | | 24 ms |
| _DSC3111.NEF (single frame) | 3000×2000 | none, `found: false` | | 20 ms |

All three strips decode DX 95-7, which the database maps to Kodak ULTRA MAX 400
(GC400); the frame numbers match the printed ones next to each code. Mirrored,
rotated and downscaled copies of DSC_8800 decode identically.

```sh
npm test
node scripts/smoke-test.mjs --film-edge-only
AUTOFRAME_RAW_DIR=. npm run test:smoke
node scripts/derive-dx-film-table.mjs      # regenerate the DX table
node scripts/make-film-edge-fixture.mjs    # regenerate the smoke fixtures
```

## Limits

- The rebate must be in the scan. Holders that mask the perforations (ES-2,
  most flatbed holders) give `found: false` and nothing changes.
- 120 film has edge text but no DX barcode; text is not read yet.
- 135 edge text ("KODAK GC 400", frame numbers) is not read; the DX code is
  the only stock source, so a code missing from the database is shown as a
  raw number only.
- Slide-film polarity is validated on synthetic strips and the app's own
  rendered borders, not yet on a real slide scan.
- The stock → preset mapping is a starting point (keyword rules in
  `dxFilmDatabase.js`); the user can always pick another preset.

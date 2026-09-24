# Folder import and film-type corrections

## Folder import

The active photo loads before background thumbnails. RAW contact-sheet tiles use
an embedded JPEG when one is available; they never invoke LibRaw just to make a
144-pixel tile. Files without an embedded JPEG keep a numbered tile until opened
or analysed. The image used for conversion/export still uses the normal decoder.

Automatic roll preparation keeps the same geometry-applied, 900-pixel analysis
samples for the subsequent roll analysis. The cache counts both 8-bit and 16-bit
planes and is capped at 128 MiB. Evicted samples can be decoded again. A current
RAW larger than 100 MiB is not reused because it may still be a temporary preview.
Colour conversion and roll-analysis mathematics are unchanged.

Automatic analysis does not lock the editor. Changes to the active file, manual
edits, cropping, or an explicit film-type choice invalidate pending background
results. Roll settings and thumbnails are committed together after validation.

## Black-and-white detection

A consistent, modest RGB tint can still be monochrome. The classifier checks
channel coherence after bounded gain normalization instead of requiring almost
perfectly equal RGB values. Two opposing thin, bright rebates can supply negative
polarity evidence, including clipped clear-film pixels. DX/edge text remains
stronger evidence.

Samples are block means. At 60 MP a camera scan resolves film grain, and
demosaicing turns it into about 3 % per-pixel false colour, which failed the grey
tests on single pixels. Each of the roughly 24 000 stride samples is the mean of
the opaque pixels in a k×k box, `k = clamp(round(shortSide / 1500), 1, 8)`: 4 at
6336 px, 3 at 24 MP, and a single pixel on the 2–4 MP preview planes and small
scans, whose verdicts are unchanged. Both grey tests keep their thresholds and
apply to the block mean. Gathering the blocks costs a few milliseconds (a 12 MP
synthetic frame: +0–3 ms at k = 4 to 8 in Node on an M1 Pro), because the sample
count does not depend on the resolution.

Borderless monochrome without a rebate is typed as a B&W negative at low
confidence (`monochrome`), whatever the fallback. Film scans are more common here
than prints or monochrome digital images; the frame is flagged for review and a
prompt asks for Positive when it is a print or slide.

## Roll film-type decision

Each import transaction of at least three frames, with automatic roll import on
(watch-folder batches included), keeps every frame's own verdict in import order.
`rollFilmType.js` splits the import into contiguous segments. A segment of at
least three frames of which at least two thirds are B&W is a B&W segment:

- auto-typed frames without film evidence (`noMask`, `empty`) between its B&W
  frames are retyped, plus at most one at each end, such as a leader with a dark
  holder edge. A run of two or more of them is never absorbed: a colour negative
  whose mask LibRaw's auto white balance neutralised can also come out `noMask`;
- frames with `dx`, `edge-text`, `orangeRebate`, `orangeMask` or `warmScene`
  verdicts, or with film-edge evidence, split segments and are never retyped;
- manual choices, whole-roll overrides, saved or recovered settings and edited
  frames are never changed; they vote with the type they have;
- frames typed by the segment get `{ bw, medium, rollMonochrome }`, so they raise
  no review flag and no per-frame prompt, and show their own status line.

A retype is applied like a film-type change but stays automatic: automatic white
balance is reset and learned defaults are re-applied under the B&W key. The
decision is incremental while the import's first pass reads the frames (it only
adds frames then) and authoritative when that pass ends. It is applied before
roll grouping, so the shared roll analysis runs once, in B&W, from the samples
the first pass kept: a retype changes only film-type fields, and the samples are
re-keyed instead of decoded again. The open photo follows the decision only while
untouched, from its loaded base, with no decode and no undo entry; a newer load,
an edit or a roll revision wins. Auto-frame keeps the film type the first pass
started with, so the decision does not change framing within an import. Frames
that get settings outside the first pass (batch export, batch auto-frame,
thumbnails) take the recorded decision.

One toast per import reports the typed frames with **These are positives**. It
applies the whole-roll override to exactly those frames as one undo step
(`rollFilmType`), leaving a colour roll in the same import alone. When no segment
forms, the open photo's own monochrome prompt is shown once the decision is known;
single-photo and two-photo imports show it immediately, as before.

## Whole-roll override

In Convert, select Color, B&W or Positive, then use **Apply this film type to the
whole roll**. The action covers every imported photo, including unopened and
unchecked photos. Individual crop, exposure, repair and other edits remain.
Analysis shared under the old film type is cleared; automatic white balance is
reset only when it has not been manually overridden. Positive processing mode
travels with the choice.

The override is manual and cannot be replaced by automatic pixel/DX detection.
Undo/redo applies across the roll, and project/recovery serialization preserves
the choice for unopened photos. Later imports are a separate operation.

## Validation

- Film classifier: neutral/tinted monochrome, thin/opposing/clipped rebates,
  borderless uncertainty, ordinary colour and orange-mask negatives, 8/16-bit,
  seeded ±3 % grain on neutral and colour frames, and single-pixel parity with
  the previous classifier.
- Roll decision: B&W majority, noMask leader, warm colour frame, a run of noMask
  frames, locked and edited frames and two rolls in one import
  (`rollFilmType.test.mjs`); the orchestration with decode counts, sample reuse,
  the open-photo flip, the toast and its correction (`automaticRollImport.test.mjs`);
  and `npm run test:smoke -- --bw-roll-only` on generated PNG frames.
- Whole-roll override: preserve per-frame edits and manual white balance; project
  round-trip for unopened photos.
- Real Chrome: pause background preparation, set B&W, apply to the roll, undo,
  redo, release the stale analysis, open an untouched frame with colour-film DX.
- Folder smoke: 12 PNG files, one full read per frame, no thumbnail before the
  first photo is ready, and no editor lock during automatic analysis.
- Optional real RAW run: `NC_FOLDER_RAW_FIXTURE=/path/to/file.dng npm run test:smoke -- --folder-only`.

Measured locally on the real 60 MP `L1009967.dng` fixture duplicated into a
three-file import: exactly three LibRaw image decodes, only the active frame
decoded before first-ready, and no busy-editor samples after first-ready. This
verifies scheduling and decode counts; it is not a general hardware speed claim.
Cached versus freshly decoded roll analysis produced identical exported PNG
pixel SHA-256 hashes in the 12-frame fixture.

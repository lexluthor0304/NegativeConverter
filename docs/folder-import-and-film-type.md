# Folder import and film-type corrections

## Folder import

The active photo loads before background thumbnails and roll analysis. RAW tiles
fill at import from the embedded JPEG previews of TIFF-container RAWs, read with
small Blob slices and decoded in the scan-decode worker; they never invoke
LibRaw or read the whole file just to make a tile, and they are marked
provisional (`embedded`, pending) until a converted preview replaces them.
Files without a usable baseline JPEG preview (CR3, RAF, JPEG XL-only DNGs) keep
a numbered tile until opened or analysed. The image used for conversion/export
still uses the normal decoder; embedded previews are never an editing, analysis
or export source. The folder regression counts these jobs as their own
`embedded` route with a byte budget (tiles ≤ 200 KB per DNG, the viewer frame
≤ its preview + 32 KB).

Automatic roll preparation keeps the same geometry-applied, 900-pixel analysis
samples for the subsequent roll analysis, each with the base's size, a
16384-pixel 16-bit analysis reference and the frame's 288 px tile working
image, taken while the frame is decoded. Frames
a scheduled roll import owns get no lane render before it finishes, with or
without a recipe: a thumbnail recipe set in the gap would leave the frame
without a pass-1 sample, and any lane decode there would be a second decode of
the same file. The import gives them their final tiles from those samples
instead: the roll commit for grouped frames, and a render from the retained
sample for frames no group took (positives, mixed stocks, groups of fewer than
three). With default recipes the light table is complete when the import ends,
after exactly one read and one decode per photo. The cache counts both 8-bit
and 16-bit planes and is capped at 128 MiB. Evicted samples can be decoded
again. The current photo's base is not reused while it is a two-stage import's
half-size stand-in (`rawDecodePending`, `__decodeScale`; see
two-stage-raw-import.md): roll analysis waits for its full decode. Colour conversion and roll-analysis mathematics are
unchanged.

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
prompt asks for Positive when it is a print or slide. Projects and recovery
copies keep their film type: a monochrome frame saved as a positive before this
rule opens as a positive, and its status line says the polarity is uncertain,
not that it is treated as a B&W negative.

## Roll film-type decision

Each import transaction of at least three frames, with automatic roll import on
(and a folder watch's roll: three or more arrivals whose recipes landed within
2.5 s of each other, `docs/simplicity-workflow.md`), keeps every frame's own
verdict in import order.
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
an edit or a roll revision wins. A decision that only confirms its type (B&W at
low confidence becoming `rollMonochrome`) changes what the detection describes,
not what converts: the status line follows and the photo is not converted
again. When the end of the first pass waits for the open photo (crop mode) and
the user leaves it for another frame, it is retyped as a background frame
before grouping and joins its roll; a decision that finds another flip holding
the photo is applied again once that flip is done. Auto-frame keeps the film
type the first pass started with, so the decision does not change framing
within an import. Frames that get settings outside the first pass (batch
export, batch auto-frame, thumbnails) take the recorded decision.

One toast per import reports the typed frames with **These are positives**. It
applies the whole-roll override to exactly those frames as one undo step
(`rollFilmType`), leaving a colour roll in the same import alone. The toast is
up while the import's roll groups are analysed, and a click cancels nothing
else: only the group of the retyped frames stops (a group formed before the
click and not yet analysed waits for the next grouping, which leaves them out),
the colour roll is still analysed from the first pass's samples, other imports
and their decisions go on, and an open photo that is not one of those frames is
not counted as edited. The toast's 12 s count from when it is shown: one made
while the window is hidden waits until the window is seen again. When no segment
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
Undo/redo applies across the roll, each frame's tile included with its rank and
settings key, and project/recovery serialization preserves the choice for
unopened photos. Later imports are a separate operation.

## Validation

- Film classifier: neutral/tinted monochrome, thin/opposing/clipped rebates,
  borderless uncertainty, ordinary colour and orange-mask negatives, 8/16-bit,
  seeded ±3 % grain on neutral and colour frames, and single-pixel parity with
  the previous classifier.
- Roll decision: B&W majority, noMask leader, warm colour frame, a run of noMask
  frames, locked and edited frames and two rolls in one import
  (`rollFilmType.test.mjs`); the orchestration with decode counts, sample reuse,
  the open-photo flip, the toast and its correction (`automaticRollImport.test.mjs`,
  which also covers the correction while the roll groups are analysed, the
  leader left while the first pass waits for it and a confirmation without a
  conversion); the toast's duration in a hidden page (`toast.test.mjs`); the
  status line of a restored monochrome positive (`filmModeStatus.test.mjs`);
  and `npm run test:smoke -- --bw-roll-only` on generated PNG frames, including a
  colour roll followed by B&W frames, corrected with **These are positives** as
  its toast appears: the colour roll is still analysed, and its PNG and TIFF
  exports match the same import without the click.
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

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
stronger evidence. Borderless monochrome remains low confidence: the same pixel
statistics can describe a positive or a negative, so the UI asks for a choice.

No failing customer scan was supplied; synthetic regression cases verify these
specific failure modes, not a measured accuracy rate on customer photographs.

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
  borderless uncertainty, ordinary colour and orange-mask negatives, 8/16-bit.
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

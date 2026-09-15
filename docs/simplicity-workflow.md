# Fewer steps (roadmap #181)

## HEIC / HEIF

Select or drop HEIC/HEIF just like a JPEG. Native browser decoding is attempted
first; a bundled libheif 1.19.8 worker is the fallback. It selects the primary
image, uses libheif container transforms, checks dimensions, and terminates the
worker after each decode or timeout to release its heap. No conversion service
or CDN is involved. Codec source/licence information is in `public/codecs/`.
The bundled HEIC fixture is a macOS-generated container from the repository's
negative sample, not a camera-original iPhone capture.

## Review queue

Uncertain framing, film type, WB, roll outliers, contradictory edge polarity
and decode failures share one predicate. A compact badge explains the reasons;
“Needs review” filters the photo strip without changing export selection or
stored indices. Mark reviewed acknowledges a frame; opening it does not.
Explicit manual corrections resolve their corresponding reasons. Decode errors
remain visible even if the frame was acknowledged. Export informs but does not
block. Reviewed status survives recipes, projects and recovery.

## Relevant panels

Advanced is off initially and remembers its setting. Flat-field controls apply
to phone/camera sources, lab matching to colour negatives, paper to negatives,
merge tools to multiple photos, and edge tools to detected/enabled rebates.
The CMYD correction console is always visible above basic adjustments, and
is the first quick-navigation entry. It is not an Advanced tool. Other
darkroom tools are available under Advanced. Existing active effects stay
visible so the user can inspect or undo them. Unknown input sources use neutral
rules; RAW metadata and HEIC extensions provide source hints.

## Desktop folder watch

The desktop empty workspace, then the batch bar after import, offers “Watch a folder…” and an optional “Import existing
files too” checkbox (off by default). Choose the directory using the native
picker. The active entry shows the directory name and Stop. New matching files
must have unchanged size and modification time for at least a second; hidden,
temporary, symlink and nested files are excluded. Files are read through a
session grant in checked 1 MiB chunks, converted and added to the photo strip.
Quiet batches of at least three new frames enter automatic roll analysis.

Stop or a new session revokes the grant. The watch never persists across app
launches. There is no web menu entry. Grant/stability/chunk tests run with
`npm run test:rust`; the browser reader's chunk and cancellation tests run with
`npm test`. macOS sandbox and other desktop-platform checks are listed in
`simplicity-validation.md` and `mas-release.md`.

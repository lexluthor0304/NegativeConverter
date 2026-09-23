# Photo navigation and light-table previews

Issues: [#220](https://github.com/lexluthor0304/NegativeConverter/issues/220),
[#221](https://github.com/lexluthor0304/NegativeConverter/issues/221).

## Ownership and invalidation

The active editor still owns its image buffers. Leaving a settled photo moves
its decoded base, conversion/display sources, recipe, undo/redo and zoom into
`photoSessionCache.js`. Opening a matching entry takes ownership back before
storing the outgoing photo. This avoids evicting the destination in an A/B/A
sequence that fits only one inactive photo.

The inactive cache counts unique backing buffers, including high-bit-depth
planes and buffers shared with history. Its limit is 768 MiB, or 128 MiB on
devices reporting at most 4 GiB of memory and unknown-memory touch devices.
The desktop budget fits a 60 MP RAW base with its 8/16-bit planes and small
editing previews; 512 MiB did not fit the measured 9536 × 6336 fixture.
Oversized sessions retain only their
decoded base if it fits. A separate 48 MiB cache holds small adjusted previews
for revisits after full-session eviction. These are retained-buffer limits,
not a total renderer-memory promise; the active editor, workers, native GPU
resources and file storage are additional.

Keys include the per-file recipe, film-type override, repair configuration,
AI model revision and flat-field identity. A pending RAW upgrade, conversion,
dust detection or brush refinement is not a settled session. Preview-only
restoration keeps the full-resolution pending flag: export must still pass the
existing full-resolution barrier. Presentation proxies never become export
sources. Queue removal and closing the session release retained entries.

Navigation invalidates older asynchronous activations. A late decode or
metadata callback cannot replace the newly selected image. Quiet cold loads
do not impose the loading-overlay dwell or deliberately display a negative
between processed views. Cache misses still require real processing; no
unbounded cache or promise of instant first opens is made.

## Light table

`photoPreview.js` downsamples an already converted source and applies the
shared final-adjustment pipeline once. It does not read `displayImageData`,
which is intentionally absent when the editor uses WebGL. Thus GPU/CPU choice
does not decide whether a thumbnail includes white balance, CMY, curves or a
look. Core tone controls are stripped from this final stage because the
conversion already applied them.

The active thumbnail refreshes on coalesced preview/full redraws. Other photos
use a single background preview lane through `processFileWithSettings`, with
bounded output size and stale-result guards. The previous tile stays visible
during invalidation, accompanied by a pending indicator; a failed preview is
marked rather than retried indefinitely. This includes two-photo imports,
which do not run automatic roll analysis.

If roll analysis takes ownership while a thumbnail is in flight, that
thumbnail stays invalid even after analysis becomes idle. It cannot publish
prepared settings or errors over the analysis result; a fresh preview job
refreshes the tile. The folder regression tracks foreground, analysis and
thumbnail reads separately, and requires exactly one foreground/analysis
decode per photo while allowing the separate final-recipe preview lane.

## Verification

```sh
npm test
PORT=5214 CDP_PORT=9238 npm run test:smoke -- --photo-session-only
PHOTO_SESSION_RAW_FILES='["/absolute/a.dng","/absolute/b.nef"]' npm run test:smoke -- --photo-session-raw-only
npm run test:smoke
npm run build:web
```

The targeted browser regression measures actual decode/conversion worker
messages and original-file reads during warm A/B/A navigation. It compares
settled GPU dimensions and sampled patch hashes, zoom, and exact decoded 8/16-bit PNG export
pixels. It also checks active CMY thumbnail changes, identical unopened
negative previews, whole-roll black-and-white pending-to-ready transitions,
and a delayed cold-file read losing to a newer selection. Synthetic fixtures
are used; private user photographs are not published.

Browser tests must run against frozen runtime files so Vite hot reload cannot
invalidate the measurements. The generated visual artifact is
`output/playwright/photo-session-lighttable.png` (not committed).

Local targeted evidence (2026-09-23, Chrome, synthetic 900 × 600 PNGs): three
warm activations were observed at 114, 75 and 117 ms by the CDP polling probe,
with zero additional original-file reads or decode/conversion requests. These
are navigation observations, not a large-RAW benchmark. The restored GPU
sample hash and 8/16-bit decoded export hashes matched exactly; the 16-bit
fixture retained 2678/4610/4375 distinct RGB levels. All three final whole-roll
B&W thumbnails had zero measured chroma, retained images during the pending
phase, and the delayed cold-read race left the latest selection active.

The roll analyzer's quick thumbnails are provisional: they omit stages such
as lens correction and repair, so the canonical preview lane replaces them
before marking them ready. This can require another decode for an uncached
RAW; correctness is not traded for a misleading cache hit.

Lens-corrected photographs with saved repair strokes keep native coordinates
through repair before the thumbnail is reduced. Other small previews scale
the dust particle-size threshold to their working dimensions. The ordinary
full-resolution 8/16-bit export path is unchanged.

The optional real-file regression also passed with a 76 MB DNG decoded to
9536 × 6336 RGB16 and a 17 MB NEF. Three warm activations were observed at
72/94/87 ms with zero new file reads, LibRaw calls or conversion requests;
the DNG GPU sample hash and zoom matched before/after. The NEF decoder used
its existing embedded-preview fallback in this run, so this is not evidence
of full-precision NEF decoding. No export was forced in the large-file cache
test; exact export precision is covered separately by the 16-bit PNG test.

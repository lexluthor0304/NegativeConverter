# Photo navigation and light-table previews

Issues: [#220](https://github.com/lexluthor0304/NegativeConverter/issues/220),
[#221](https://github.com/lexluthor0304/NegativeConverter/issues/221),
[#223](https://github.com/lexluthor0304/NegativeConverter/issues/223),
[#224](https://github.com/lexluthor0304/NegativeConverter/issues/224),
[#234](https://github.com/lexluthor0304/NegativeConverter/issues/234).

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
A session too large with its planes keeps its recipe, its history as
scalars (cold entries) and its decoded base (#244); reopening it shows the
adjusted preview at once while the geometry pool rebuilds the crop window
from the base, then converts without new automatic measurements. Only when
even that does not fit is the decoded base kept alone.
Once the outgoing session is cached, a cold switch releases the outgoing
photo's planes and undo/redo pins before decoding the target, so they are not
reachable during the decode. A failed decode takes the outgoing session back
from the cache through the normal warm or base-only activation. A separate 48 MiB cache holds small adjusted previews
for revisits after full-session eviction. These are retained-buffer limits,
not a total renderer-memory promise; the active editor, workers, native GPU
resources and file storage are additional. While a job runs in a hidden
macOS window, or once an idle window has been hidden for five minutes, both
caches are emptied to stay under WebKit's inactive memory limit; they refill
on use (`docs/hidden-window-jobs.md`).

Keys include the per-file recipe, film-type override, repair configuration,
AI model revision and flat-field identity. `settingsKey.js` builds them
exactly but cheaply: the JSON of those values with each `{ r, g, b }` curve
LUT triple replaced by null, then a raw U+0000 and the LUT bytes. Two keys are
equal only when the plain JSON would be; nothing is memoised, because curve
LUTs change in place. A pending RAW upgrade, conversion,
dust detection or brush refinement is not a settled session, nor is an open
reduced preview-tier drag or a reduced frame still waiting for its normal-size
tick (#263). Preview-only
restoration keeps the full-resolution pending flag: export must still pass the
existing full-resolution barrier. Every snapshot records whether its plane is a
display preview and whether it lags its settings (#237); a session that swaps
its plane for the display preview updates both, and a plane that is not the
size of the conversion source always restores as a preview. A restore paints
the display planes the snapshot captured instead of resampling its plane. Presentation proxies never become export
sources. Queue removal and closing the session release retained entries.

Navigation invalidates older asynchronous activations. A late decode or
metadata callback cannot replace the newly selected image. Quiet cold loads
do not impose the loading-overlay dwell or deliberately display a negative
between processed views. Cache misses still require real processing; no
unbounded cache or promise of instant first opens is made.

Cold navigation immediately identifies the target in the status bar and tile,
and paints a viewer-local loading surface before starting expensive work.
The outgoing pixels are covered so they cannot be mistaken for the target;
the filmstrip stays interactive while editing and export are locked. The
localized, live-announced status distinguishes opening from preparing the
photo. Only the current activation may remove its feedback. Warm session
restoration skips the loading surface and introduces no artificial dwell.

A photo that still needs its frame and film-edge detection is converted first
(#236): its provisional settings, the snapshot plus learned values, are
rendered while both detections run, and the loading surface lifts at that
paint. During the detection tail the frame notice reads "Detecting the image
area and tilt…", the filmstrip navigates, and editing, history and export stay
locked (`studioBusy`). The final settings are then built in the old order
(frame, film edge, learned defaults); when their conversion key equals the
provisional one only the detection descriptions are applied, otherwise the
photo is rendered once more. A provisional photo is never persisted, cached
as a session snapshot or read by roll analysis: leaving it mid-tail keeps its
decoded base only, and its settings stay as they were.
Global history, color-console and zoom shortcuts cannot change the outgoing
photo while another target is loading; the history controls are locked too.

### Provisional pixels (#235)

The loading surface may show a marked, provisional positive of the target
instead of a blank card. It is drawn on surfaces owned by the veil
(`createPhotoSwitchPresentation` in `studioWorkspace.js`), on the veil's opaque
background, never on `#canvas`: it cannot inherit the outgoing zoom/pan, and
an error has nothing to restore. The veil keeps `inset: 0`, pointer blocking,
`role=status`/`aria-live=polite`/`aria-atomic` and its announced message; the
centred card becomes a corner chip with an `aria-hidden` " · preview" suffix,
and the veil carries `data-provisional="cached|thumbnail|embedded"`:

- `cached`: the retained 1200 px `photoPreviews` copy, when its key equals
  `photoSettingsKey(item)`, drawn in the same task that shows the veil;
- `thumbnail`: otherwise the tile's thumbnail of any kind, upscaled;
- `embedded`: the camera JPEG inside a TIFF-container RAW, decoded in the
  scan-decode worker (`rawEmbeddedPreview.js`, `embeddedPreviewRender.js`):
  inverted and stretched per channel (0.5/99.5 percentiles of the mapped crop,
  or of the central 80 %, with a mild gamma lift), mapped through the frame's
  rotation → mirror → crop, and histogram-matched to a converted thumbnail when
  one exists. It is skipped when a `cached` copy is shown or a base-only session
  makes the exact positive ~0.3 s away. Frames without settings are never typed
  from the camera JPEG: they invert by default; frames whose film type (or
  override, or the manual import type) is positive are shown uninverted.

The embedded job is posted before the container read, and its bitmap is shown
through `ImageBitmapRenderingContext.transferFromImageBitmap` only while the
same activation's target is still loading; hiding the veil releases it with
`transferFromImageBitmap(null)`. A TIFF-container RAW import activates its
first photo through the same viewer-local surface (not the full-screen
overlay), so the provisional frame is visible while the decode runs; other
files keep today's loading card.

All provisional and cached pixels are presentation-only: they are never
assigned to `loadedBaseImageData`, `originalImageData`, `processedImageData`,
any conversion, preview, histogram or WebGL source, or `photoSessions`, and
never passed to frame, film-edge, roll, dust or semantic analysis or to export.
`provisionalPreview.test.mjs` runs the actual main.js functions against a
`state` that throws on any such write.

## Light table

`photoPreview.js` downsamples an already converted source and applies the
shared final-adjustment pipeline once. It does not read `displayImageData`,
which is intentionally absent when the editor uses WebGL. Thus GPU/CPU choice
does not decide whether a thumbnail includes white balance, CMY, curves or a
look. Core tone controls are stripped from this final stage because the
conversion already applied them.

The active thumbnail is not part of the frame loop. A preview redraw (slider,
curve, brush, zoom step) re-arms a trailing timer, so the tile settles about
250 ms after the last one; a full render updates it in the next frame. When
the timer fires, the tile is rebuilt only if its inputs changed: the converted
preview source it samples and an exact signature of the adjustment settings.
Zoom, pan and resize change neither; the display-preview refinement after a
zoom converts the same settings at another size and carries the tile over
instead of rebuilding it. The request records what the tile was sampled from
before it marks the full-resolution pixels pending, and the tile is carried
only if no other result was applied in between. A full-resolution re-render that follows it on
photos of 16 MP or less is a new source and rebuilds the tile once. During a
drag the tile keeps its pre-drag colours until it settles.

A photo switch persists the outgoing photo's tile synchronously (restamping
only, when the settled tile already matches), adopts the incoming photo's
current tile without rebuilding it, and refreshes the file list once: before
the cold-switch feedback paints, or at the end of a warm switch. The 1200 px
proxy for revisits after eviction is sampled in the click and adjusted after
the next paint; it is stored only while the photo is still queued under the
same key. Row refreshes compute one key per row and touch only their row when
a single tile changes.

Other photos use a single background preview lane through
`processFileWithSettings`, with bounded output size and stale-result guards. The previous tile stays visible
during invalidation, accompanied by a pending indicator; a failed preview is
marked rather than retried indefinitely. This includes two-photo imports,
which do not run automatic roll analysis.

The expanded light table uses the entire allocated row below its header.
Its grid is the only vertical scrollport; the legacy file panel's 200px cap
and sticky positioning must not apply. Mobile grid tile sizing is separate
from compact filmstrip sizing. Keyboard navigation scrolls only the list and
reveals the complete tile, including its border, rather than its inset button.

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
PORT=5214 CDP_PORT=9238 npm run test:smoke -- --light-table-only
PHOTO_SESSION_RAW_FILES='["/absolute/a.dng","/absolute/b.nef"]' npm run test:smoke -- --photo-session-raw-only
npm run test:smoke
npm run build:web
```

The targeted browser regression measures actual decode/conversion worker
messages and original-file reads during warm A/B/A navigation. It compares
settled GPU dimensions and sampled patch hashes, zoom, and exact decoded 8/16-bit PNG export
pixels. Zoom steps are a compositor transform: they must not draw, and only a
display preview of a new size repaints, at its texture's size. It also checks active CMY thumbnail changes, identical unopened
negative previews, whole-roll black-and-white pending-to-ready transitions,
and a delayed cold-file read losing to a newer selection. Cold navigation
also checks synchronous target feedback, accessible visible loading state,
successful completion and read-failure recovery. The light-table regression
imports 39 photos and checks full-height occupancy, final-tile access,
mobile sizing, short landscapes and collapsed/reopened layouts. Synthetic fixtures
are used; private user photographs are not published.

Browser tests must run against frozen runtime files so Vite hot reload cannot
invalidate the measurements. Timed switch measurements (warm, cold, 2-back,
rapid presses) come from `npm run bench:interactive` S7, which serves a
production build from its own worktree (`docs/performance-benchmark.md`). The generated visual artifact is
`output/playwright/photo-session-lighttable.png` and
`output/playwright/photo-switch-loading.png` (not committed), along with
the light-table desktop/mobile captures.

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
before marking them ready. Tiles rank `embedded` < `analysis` < `processed`
(`thumbnailRank.js`): import-time embedded tiles and per-frame analysis tiles
only fill empty or `embedded` tiles, so a tile never moves back, and neither
kind carries a `thumbnailKey` or counts as ready. This can require another decode for an uncached
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

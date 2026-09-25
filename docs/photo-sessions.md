# Photo navigation and light-table previews

Issues: [#220](https://github.com/lexluthor0304/NegativeConverter/issues/220),
[#221](https://github.com/lexluthor0304/NegativeConverter/issues/221),
[#223](https://github.com/lexluthor0304/NegativeConverter/issues/223),
[#224](https://github.com/lexluthor0304/NegativeConverter/issues/224),
[#234](https://github.com/lexluthor0304/NegativeConverter/issues/234),
[#243](https://github.com/lexluthor0304/NegativeConverter/issues/243).

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
macOS window, or once an idle window has been hidden for five minutes, these
caches and the prefetch slot (#243) are emptied to stay under WebKit's inactive memory limit; they refill
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

Latest wins (#243). Each activation (a switch, or any `loadFile` a switch did
not start) owns an `AbortController`; beginning the next one aborts it. The
signal reaches the decode: `loadRawFile` disposes LibRaw (a pending open,
metadata or imageData rejects at once) and terminates the per-decode
post-decode worker in the same task, skips every later stage and never takes
an embedded-preview fallback for an abort; a scan decode keeps its input
before dispatch and terminates its worker after; a heavy file's background
full-resolution decode stops with it. The superseded load ends `stale`
without an error or a marked item. `invalidatePhotoActivation` also aborts the
full-resolution render's worker request (`WORKER_ABORTED`, never counted
against the worker) and the detection requests; a detection worker that owed
nothing else is terminated with its plane copies, and the next cold load warms
a fresh one while it decodes. A cold switch target waits a 120 ms dwell after
the veil's paint before reading its file, so a double click or a fast
Arrow+Enter run never reads the targets it skips; the dwell is skipped when the
target's base is retained, prefetched or being decoded by a lane. The
generation checks stay as a second line of defence.

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
the display-size frame on screen in CPU modes, which is absent when the
editor uses WebGL. Thus GPU/CPU choice
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
drag the tile keeps its pre-drag colours until it settles. A SilverCore drag drawn
by the WebGL2 preview (#239, `docs/gpu-preview.md`) schedules no tile update at all:
its frames are display-only, and while one is on screen ahead of its exact frame the
reprocess chain reads as busy, so a switch stores no snapshot of it. The tile and the
session follow the exact frame that settles the drag.

A photo switch persists the outgoing photo's tile synchronously (restamping
only, when the settled tile already matches), adopts the incoming photo's
current tile without rebuilding it, and refreshes the file list once: before
the cold-switch feedback paints, or at the end of a warm switch. The 1200 px
proxy for revisits after eviction is sampled in the click and adjusted after
the next paint; it is stored only while the photo is still queued under the
same key. Row refreshes compute one key per row and touch only their row when
a single tile changes.

Other photos get their tiles from the background photo lanes (below) through
`processFileWithSettings`, with bounded output size and stale-result guards. The previous tile stays visible
during invalidation, accompanied by a pending indicator; a failed preview is
marked rather than retried indefinitely. This includes two-photo imports,
which do not run automatic roll analysis.

The lanes render a tile without a new decode whenever they can (#247):

- **Tile sources.** `thumbnailSources.js` keeps, per queue item, the
  geometry-applied working image (long side at most 288 px) a canonical tile
  was converted from, a 16-bit analysis reference of at most 16384 pixels and
  the geometry both belong to (`tileGeometryKey`: rotation, mirror, crop, base
  size, analysis area). Roll commits, ungrouped roll frames and every lane
  decode fill it. When a recipe changes and the geometry does not (Sync
  colours, Apply to selected without crop, the dust toggle, an AI-repair
  revision, a film-type change), the lane re-renders the tile from it in
  milliseconds, with no decode and no hidden-job admission (when the tile is
  the job's only need). Entries are
  stored compactly (RGB samples and a one-bit opacity mask for 16-bit planes),
  at most 0.6 MB each and 100 MB in total (about 0.43 MB per 3:2 frame with
  its reference), least recently used out first; a moved geometry, active
  lens correction or an evicted entry falls back to a decode, which refills it.
- **Reduced geometry.** A lane render without active lens correction (enabled
  with a selected lens, `lensCorrectionActive`, the same test as
  `applyLensCorrectionWithSettings`) never builds the full-resolution frame.
  The post-geometry size comes from the base size (`reducedTileGeometry`), and
  the working image is taken at the step the preview downsample used to apply
  after the chain: on a full-size 16-bit base the geometry core's strided plan
  builds exactly that image and reads only its pixels (about 2 ms on 12 MP
  with a 0.75° straighten and an 85 % crop, instead of seconds of full-frame
  resampling); an 8-bit source at a non-right angle is decimated first and
  the small image rotated. The router settings, analysis region, strokes and
  dust size still read the full base size, and the colour analysis reference
  still comes from the full base.
- **Half-size decodes.** A RAW frame with a settled recipe (frame detection
  and the film-edge read done) and no tile source is decoded at half size in
  16 bits without the sensor-defect pass (`halfSize`, `outputBps: 16`,
  `suppressSensorDefects: false`). The decode reports the full size its recipe
  refers to and is never remembered as the file's size (batch lane planning
  reads that). When the tile is the job's only need, this decode is the
  job's own (`openHalfSizeTileDecode`): never shared through
  `sharedDecodes`, adopted, retained or prefetched, and opening that photo
  aborts it so the file is never decoded twice at once. Frames without a
  recipe, and jobs that also analyse or prefetch the frame, take the full
  shared decode.
- **One renderer.** `renderPreviewFromWorkingImage` converts, removes dust at
  the scaled particle size, repairs strokes, bakes the automatic gray point
  and the expired-film measurement, and adjusts at preview quality, for the
  lane, roll-sample tiles and tile-source re-renders alike. It never writes
  `item.settings`.

Frames with active lens correction keep the native path: full-resolution
geometry and lens correction, then the reduction (or none at all for a
lens-mapped repair).

### Background photo lanes (#243)

One pull-based scheduler in `main.js` runs every background decode: pass 1 of
an automatic roll import (`runRollAnalysisPass`), lane tiles that still need a
decode, and the prefetch of the next photo. Lanes are planned with
`planBatchLanes` (one for tiles and prefetch; a roll pass brings its own
count). Each time a lane frees up it picks one job with `pickBackgroundJob`
(`backgroundPhotoScheduler.js`), recomputed on every pick so it follows
navigation at once. For display position k of the open photo and direction of
travel d (the sign of the last step in the shared display order, +1 when
unknown): k+d first (for the prefetch, the next photo in that direction
without a retained session), then k−d, then tiles visible in the strip or
light table (an `IntersectionObserver` on `#fileListItems` with a one-row
margin), then everything else by display distance. Photos the review filter
hides come last. No job starts on a file another lane is working on.

- **When.** A lane waits for `backgroundGate.idle()` (`backgroundGate.js`)
  before every pick and before its decode: no photo switch, no busy editor,
  no conversion, core reprocess or full-resolution render (in flight or
  scheduled), no export, and no pointer, wheel, key or slider input for
  400 ms (passive capture listeners; hovering does not count). A job mid-way
  waits again, at most 2 s, before each main-thread-heavy step (frame
  detection, geometry, the tile encode), so a paused job does not hold a
  decoded frame through a foreground decode. A hidden window is not busy here;
  hidden admission is `hiddenJobGate.js` (#241), which every job also passes.
- **One decode.** Background decodes go through `sharedDecodes.js`: the
  foreground's options (full size, defects repaired) with the RAW metadata,
  so an adopted base carries lens and EXIF data exactly like a cold open. A
  job's decode serves every need of its frame (analysis, tile, prefetch), and
  a retained session or prefetched base is used instead of a decode. When the
  user opens a frame a lane is decoding, or still holds while it analyses it,
  `loadFile` adopts that decode instead of reading the file again (a heavy
  file skips its half-size stage); the lane's analysis of the now-current frame
  stops and the foreground analyses it, as before. Leases are reference
  counted: a superseded adopter detaches without cancelling the lane's decode,
  and the entry lives until the owning job releases the base.
- **In-flight decodes.** With the desktop session budget, a cold activation
  lets a lane's decode finish (it would have to be redone); on low-memory
  devices the activation aborts the lanes' decodes, except the target's own.
- **After a job.** Its base becomes a base-only `photoSessions` entry only if
  it fits without evicting anything (`putIfRoom`); otherwise it goes to the
  prefetch slot when the frame is the next photo, or is dropped. Tiles and
  prefetch previews use the lanes' own conversion and frame-detection
  workers, never the foreground's.
- **Prefetch.** A separate one-entry session cache (`photoPrefetch`, the
  desktop session budget; off on low-memory devices until #258 owns the
  budget) holds the next photo's base-only entry `{ file, base, rawMetadata }`,
  so an unvisited prefetch never evicts the photo just left (A/B/A stays
  warm). Once the open photo has settled, the lane decodes the next photo,
  keeps its base, and renders a 1200 px `photoPreviews` entry of its recipe
  with `processFileWithSettings(previewMaxDimension: 1200)` on its own pool.
  `switchToFile` takes a session or the prefetched base, so the next photo
  opens without a read or decode: the veil shows the matching preview in the
  click's task and the exact positive follows from the base. A new recipe (a
  roll commit) re-renders the preview from the held base; the slot is dropped
  once the user is two photos away from it.
- **Buffers.** A shared, retained or prefetched base is read-only: it is
  listed among the editor's live buffers, so no export transfers it (#244 and
  #249 copy instead).

The expanded light table uses the entire allocated row below its header.
Its grid is the only vertical scrollport; the legacy file panel's 200px cap
and sticky positioning must not apply. Mobile grid tile sizing is separate
from compact filmstrip sizing. Keyboard navigation scrolls only the list and
reveals the complete tile, including its border, rather than its inset button.

If roll analysis takes ownership while a thumbnail is in flight, that
thumbnail stays invalid even after analysis becomes idle. It cannot publish
prepared settings or errors over the analysis result; a fresh preview job
refreshes the tile. A scheduled, unfinished automatic roll import owns its
frames, with or without a recipe: the lanes skip them until the import gives
a frame its tile or fails on it, and the import's end releases the rest and
restarts the lanes. The folder regression tracks foreground, analysis,
thumbnail and prefetch reads separately (the lanes open their decode through
`openAnalysisDecode`, `openTileDecode`, `openHalfSizeTileDecode` or
`openPrefetchDecode`) and requires exactly one read and one decode per photo
for default recipes, thumbnail routes included; the prefetch of the next
photo is a separate, later decode and is not counted.

## Verification

```sh
npm test
PORT=5214 CDP_PORT=9238 npm run test:smoke -- --photo-session-only
PORT=5214 CDP_PORT=9238 npm run test:smoke -- --photo-activation-only
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

Roll tiles are canonical at the commit (#247): pass 1, while the decoded
frame is in hand, keeps with its 900 px sample the base size, a 16-bit
analysis reference and the lane's own reduced working image of the frame
(the strided plan, so the tile samples the frame where a lane decode would),
and the roll renders each tile from that through the lane's renderer on a
size-1 conversion pool. A tile is `processed` when the frame has
no active lens correction and its settings key at the commit equals the key
it was rendered for; otherwise (lens correction, or a global dust, AI or
flat-field change while the commit waited) it stays `analysis` and the lane
renders it again, from its tile source when it has one. Frames no group took
(positives, mixed stocks, groups of fewer than three) get their canonical
tile from the retained sample before the import finishes. Tiles rank
`embedded` < `analysis` < `processed` (`thumbnailRank.js`): import-time
embedded tiles and per-frame analysis tiles only fill empty or `embedded`
tiles, so a tile never moves back, and neither kind carries a `thumbnailKey`
or counts as ready.

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

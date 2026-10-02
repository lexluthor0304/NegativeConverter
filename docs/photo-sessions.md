# Photo navigation and light-table previews

Issues: [#220](https://github.com/lexluthor0304/NegativeConverter/issues/220),
[#221](https://github.com/lexluthor0304/NegativeConverter/issues/221),
[#223](https://github.com/lexluthor0304/NegativeConverter/issues/223),
[#224](https://github.com/lexluthor0304/NegativeConverter/issues/224),
[#234](https://github.com/lexluthor0304/NegativeConverter/issues/234),
[#243](https://github.com/lexluthor0304/NegativeConverter/issues/243),
[#249](https://github.com/lexluthor0304/NegativeConverter/issues/249).

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
A session too large with its planes is kept without its base when that fits
(Tier A, #249, below); otherwise it keeps its recipe, its history as scalars
(cold entries) and its decoded base (#244): reopening it shows the adjusted
preview at once while the geometry pool rebuilds the crop window from the
base, then converts without new automatic measurements. A large frame's
display planes alone come next (Tier B), and only when none of these fits is
the decoded base kept alone.
Once the outgoing session is cached, a cold switch releases the outgoing
photo's planes and undo/redo pins before decoding the target, so they are not
reachable during the decode. A failed decode takes the outgoing session back
from the cache through the normal warm or base-only activation. A separate 48 MiB cache holds small adjusted previews
for revisits after full-session eviction. These are retained-buffer limits,
not a total renderer-memory promise on their own; the renderer-wide memory
budget (#258, `docs/memory-budget.md`) counts them with the active editor,
history, bounded stores and worker residents in one ledger. When a lane or a
job needs room, it evicts previews first, then sessions except the one stored
last (the warm 1-back switch stays), each demoted to its display form (Tier B
below) where it has one, and on WebKit the idle check trims them toward 1 GiB
of ledger bytes the same way, demoting the one stored last too when it has a
display form. Native GPU resources and file
storage are not counted. While a job runs in a hidden
macOS window, or once an idle window has been hidden for five minutes, these
caches and the prefetch slot (#243) are emptied to stay under WebKit's inactive memory limit; they refill
on use (`docs/hidden-window-jobs.md`).

### Display-resolution sessions (#249)

Above 16 MP without repairs, a photo's settled view is the preview
conversion of a display target (`conversionPreviewImageData`) on its retained
display level (#248: `displayLevelImageData`, a k × k box average of the
conversion source, 16-bit only: 3178 × 2112 for a 9536 × 6336 frame) with the
base's colour-analysis sample. That level is the photo's **display proxy**:
the preview worker
resamples it for any window size, DPR or preview tier, so it needs no source
while the view is at display resolution. A photo is left in the largest of
these forms that fits the budget (one shared 768 MiB, unchanged):

1. **full**: base, planes and history;
2. **Tier A**: the conversion source and the display planes, without the
   base and the whole rotated frame beside a crop (a size-only stand-in takes
   its place, in history too). A full-resolution positive of a large frame
   without repairs returns to its display preview. History entries that still
   pin a dropped plane keep their scalars (cold, #244); only if that does not
   fit do the entries that pin display planes of their own go cold too. A
   cropped 60 MP frame is about 637 MiB this way, so it fits;
3. **cold** (#244): the base, the recipe and scalar history;
4. **Tier B**: only the display level, the processed preview, the histogram
   source, the auto-WB sample and the colour-analysis sample, with the base
   and source sizes, `rawMetadata`, the film-edge record, zoom and pan,
   history as scalars (about 100-140 MiB at 60 MP: the level alone is 54 MB
   of RGBA16, more than the issue's 15-26 MB estimate for a viewport-sized
   proxy, but it serves every window and needs no copy);
5. the base alone.

Tier B is exact only for a frame whose view is display-resolution (a source
over 16 MP, no dust removal, repair strokes or AI brush, a separate display
preview) and whose recipe needs no detection on reopening (the item's
settings carry `autoFrameMeta` and a read film edge); a colour frame without a
crop reads its border pixels for Step 2's mode, so it takes the exact path.
Every form of such a photo carries its Tier B form: an eviction
(`createPhotoSessionCache`'s `onEvict`) demotes the entry to it, filed as the
oldest entry so it never displaces a photo visited later, and a Tier B entry
that does not fit spills (below).

A session restored without its base keeps `state.baseDescriptor` (the base's
size, 16-bit plane and decode route, registered under the base's geometry id)
and stand-ins `{ width, height, released }` for the planes it dropped; a Tier B
session keeps `state.sourcePending` (the source's size and the proxy's key)
too. Readers of the base's size use `baseSizeSource()`, readers of the
source's size `conversionSourceSize()`; the colour-analysis sample stays
cached on the descriptor, and the auto-WB sample is keyed by the level until
the source is back (`autoWbSampleKey()`). The proxy's key is the base
(size, depth, decode route), the geometry, lens correction and the analysis
area; no viewport, since the level serves any window.

- **Return.** A Tier A or in-RAM Tier B entry whose recipe key matches restores
  in the click's task like a warm switch: no veil, no read, no decode, the same
  planes and history. Zoom on a Tier A photo works as before (the source is
  kept).
- **Recipe changed while away** (a roll commit, Sync colours) or a Tier B entry
  whose settled frame was a full-resolution plane: under the veil, the kept
  planes are installed, the item's recipe restored over them and the photo
  prepared as a cold open would be (`prepareStudioPhoto`), without a decode.
- **The preview half.** `processNegative` converts the level directly while
  its key matches the live geometry, lens and analysis area
  (`displayProxyMatches`), with the automatic measurements a cold open runs
  (the auto-WB sample comes from the level, as for any photo since #248);
  otherwise it rebuilds the source first. Slider ticks, Undo/Redo of scalar
  steps, reduced preview-tier drags and window resizes convert the level at
  the new display target too (`pendingConversionTarget`). A frame that is its
  own level (k = 1, only below the large-image size with a debug threshold)
  whose window needs the source's own pixels rebuilds the source instead.
- **Barriers.** `ensureBase()` decodes the original through the normal loader
  (joining a lane's decode, #243) under a foreground reservation of its own
  until the decode returns (#258: the photo on screen waits for it, so it never
  queues behind lanes), checks its size, depth and route against
  the descriptor and installs it under the same geometry id, so the kept planes
  stay valid; a decode that differs purges the photo's proxies and reopens it
  cold. `ensureSource()` adds the geometry chain from the base (pool) and lens
  correction, keeps the level as the display level and then checks it: the
  level must equal the new source's own level (the pool's prebuilt one, or
  `buildDisplayLevelInBands`; hash compare); a mismatch purges the stored
  copies, installs the new level and converts again. A
  geometry edit (rotate, mirror, a settings refresh with new geometry, Undo of
  a cold geometry entry) runs as a geometry job that first awaits the base;
  crop mode, Auto Frame, film-base sampling and detection, the flat field,
  Reprocess from original, Compare, every export and full-resolution render
  (dust, the AI brush) and native-pixel detail regions at zoom (#248's detail
  layer; regions drawn from the level need nothing) await `ensureSource()`.
  Meanwhile the editor is locked and the frame notice reads
  "Preparing original…" (`body[data-studio-preparing]`). A settings-only
  refresh with the same geometry keeps the crop.
- **Invariant.** A proxy is display-only: it is never assigned to
  `loadedBaseImageData`, `originalImageData`, `croppedImageData` or
  `conversionSourceImageData`, and exports always wait for the real source
  (`displaySessions.test.mjs` asserts it on a guarded state).

**The spill.** Tier B entries that no longer fit, and proxies the fills make,
go to a per-tab private IndexedDB database (the analysis samples' lock
protocol, `createPrivateIndexedDbBackend`), written from the display-proxy
worker (`workers/displayProxyWorker.js`), which packs the 16-bit level as
RGB16 when its alpha is uniformly opaque (RGBA16 otherwise; about 40 MB at
60 MP) with its source geometry, the sample and a checksum (`displayProxy.js`;
a plane with an 8-bit copy, a frame that is its own level, has it rebuilt with
`Math.round(v / 257)`, or stored when it is not derived). The main thread
keeps an index, so
`has` answers at once. The spill leaves 2 GiB free (`navigator.storage.estimate`
on the web) and uses at most a quarter of what is free, up to 4 GiB. It is
emptied when a photo leaves the queue, when the list is cleared and when the
session closes. A spilled hit shows the retained 1200 px copy on the veil and
converts the level (about 0.15-0.35 s at 60 MP, estimated), at whatever
window and zoom the editor has.

**Fills.** While roll analysis (`analyze` of the roll pass) or a lane job
holds a frame's full decode, `fillDisplayProxy` renders the level a first open
would convert: in the geometry pool, band by band, each band rendering only
the crop-window rows of k × 16 level rows and box-averaging them with
`buildDisplayLevel`'s own sums (`renderDisplayLevel`, bit-identical to the
whole level of the export chain's crop). Frames with lens correction, repairs,
an undecided recipe, an 8-bit RAW fallback or no level smaller than
themselves (k = 1) are skipped. A roll frame measured in its lane's roll-frame
worker (#252) stays there, so `displayProxyFillPlan` decides from its size
alone whether it has a proxy to fill; only then do its planes come back to
the page with its roll sample for the fill.

**The store** (across restarts and project reopens). The same records, keyed by
the file's content (size, date, SHA-256 of the first MiB plus the size, SHA-256
of the last 64 KiB, hashed only when size and date match an index entry), the
build's LibRaw and code hashes (`scripts/display-proxy-hashes.mjs`, stamped by
`vite.config.js`; #264's decoders count too: the decoder choice, the desktop's
native plane and its transfer, libraw-wasm's threaded build, and on the dev
server the `LIBRAW_WASM_DIST` package it resolves) and the proxy's key. Only reproducible decode routes are
stored, never a recipe; a record carries its full key and checksum, verified
on read. The desktop app keeps records in `app_cache_dir()/display-proxies`
through `src-tauri/src/display_proxy_store.rs` (chunked atomic writes and
reads, the volume's free space, `CACHEDIR.TAG` and Time Machine's exclusion;
the spill of an earlier run is removed at start), so no pixels reach WebKit's
origin storage; the web keeps them in the origin-private file system from the
worker (IndexedDB where sync access handles are missing). The budget is
`min(setting, 25 % of the free space above 10 GiB)`, off below the floor,
least recently used out first; the Studio menu shows the size, a limit
(Off, 1-10 GB, default 2 GB) and **Clear cache**. The store also keeps #235's
1200 px presentation previews as JPEG, keyed by content and a recipe digest,
which the switch veil shows at once after a restart; they are presentation
only. The veil shows a stored or spilled hit's presentation copy until the
exact view lands.

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
the display planes the snapshot captured instead of resampling its plane. Since
#248 a snapshot also carries the retained display level (54 MB at 60 MP, the
source itself up to ~16 MP) and the auto-WB sample; the conversion preview is a
size on that level, and the preview worker gets the level back with the next
request. Presentation proxies never become export
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

A large RAW may open from a half-size stand-in while its exact decode runs
behind it (two-stage-raw-import.md, #255). Until that decode is installed and
converted the photo is provisional in the same sense and longer: no session
snapshot or base is kept of the stand-in, nothing is persisted, and leaving
keeps only what the user changed (a photo without a recipe carries those
edits as `pendingEdits`).
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
The source is recorded as an identity (a number per raster object, from a
`WeakMap`), never held, so a photo's converted frame (up to 240 MB + 480 MB
at 60 MP) does not outlive its session, its eviction or the next decode for
the sake of its tile. Dust-brush strokes, their undo and redo, and MI-GAN's
refresh of the stroked rects patch that frame in place (#259): they move a
pixel revision the inputs record as well, so the tile is rebuilt from the
patched pixels before its key is stamped again. Only the open photo's inputs
are kept: an activation (`invalidatePhotoActivation`: a switch, a load, New
session, a hidden-window park) forgets them, after the switch's persist has
restamped the outgoing tile. Zoom, pan and resize change neither input; the
display-preview refinement after a
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
a single tile changes. The first edit of a clean photo (a restored or just
saved one) marks its own row unsaved in place (`setFileListRowDirty`; the
unsaved marker is not part of a row's signature, so no render rebuilds a row
for it). The list render for whatever else that edit may change (review and
film badges) waits until edits pause for 250 ms: every input of a drag
re-arms it, so the first drag after a switch or an export renders no list
while the pointer moves.

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
  `idle({ foregroundOnly: true })` waits on input, a switch and foreground
  decodes and conversions only, not on the export locks: a desktop batch's
  decode-ahead uses it, capped at 2 s (#256, `docs/batch-export-pipeline.md`).
- **One decode.** Background decodes go through `sharedDecodes.js`: the
  foreground's options (full size, defects repaired) with the RAW metadata,
  so an adopted base carries lens and EXIF data exactly like a cold open. A
  job's decode serves every need of its frame (analysis, tile, prefetch), and
  a retained session or prefetched base is used instead of a decode. When the
  user opens a frame a lane is decoding, or still holds while it analyses it,
  `loadFile` adopts that decode instead of reading the file again (a
  two-stage file skips its stand-in); the lane's analysis of the now-current frame
  stops and the foreground analyses it, as before. Leases are reference
  counted: a superseded adopter detaches without cancelling the lane's decode,
  and the entry lives until the owning job releases the base. A roll-analysis
  lane decodes a RAW into its roll-frame worker (#252), which keeps the planes
  (`{ base: null, held }`): adopting such a frame asks the worker for its
  planes (between its steps while it still measures, or at once when it holds
  the finished frame), and a worker that lost them is answered with a fresh
  decode of the file; a held frame nobody adopts is dropped in the worker
  with the entry.
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
PORT=5214 CDP_PORT=9238 npm run test:smoke -- --photo-heap-only
PORT=5214 CDP_PORT=9238 npm run test:smoke -- --photo-activation-only
PORT=5214 CDP_PORT=9238 npm run test:smoke -- --light-table-only
PORT=5214 CDP_PORT=9238 npm run test:smoke -- --display-session-only
PHOTO_SESSION_RAW_FILES='["/absolute/a.dng","/absolute/b.nef"]' npm run test:smoke -- --photo-session-raw-only
npm run test:smoke
npm run build:web
```

The targeted browser regression measures actual decode/conversion worker
messages and original-file reads during warm A/B/A navigation. It compares
settled GPU dimensions and sampled patch hashes, zoom, and exact decoded 8/16-bit PNG export
pixels. Zoom steps are a compositor transform: they must not draw, and only a
display preview of a new size repaints, at its texture's size (since #248 zoom
does not change the display size; the detail layer covers it). It also checks active CMY thumbnail changes, identical unopened
negative previews, whole-roll black-and-white pending-to-ready transitions,
and a delayed cold-file read losing to a newer selection. Its drag check
observes the active row's own element: no tile encode, no tile write and no
list render while the slider moves, the row marked unsaved in place, and one
tile update within 500 ms of release. Cold navigation also checks
synchronous target feedback, accessible visible loading state,
successful completion and read-failure recovery. The same step ends with a
heap check (`scripts/photo-heap-smoke.mjs`, alone with `--photo-heap-only`):
ten frames made large with `?largeImagePixels` are opened one after another,
three of them exported, with the sessions of the photos left forced to their
display form; after a forced GC, every live full-resolution `ImageData` must
be held by the open photo or a budgeted photo cache
(`window.__ncMemory.held()`, `?debug=1`). The light-table regression
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
tile from the retained sample before the import finishes. A frame's
per-frame `analysis` tile, published as soon as pass 1 has measured it, is
rendered from the same sample with the same renderer and recipe, so a tile
whose recipe the commit leaves alone keeps its pixels. Tiles rank
`embedded` < `analysis` < `processed` (`thumbnailRank.js`): import-time
embedded tiles and per-frame analysis tiles only fill empty or `embedded`
tiles, so a tile never moves back, and neither kind carries a `thumbnailKey`
or counts as ready. A roll transaction's undo entry (`rollAnalysis`,
`rollFilmType`) records each frame's tile with its kind and key, so Undo and
Redo restore a camera-JPEG or analysis tile as what it is: pending, and never
the colour-match target of a provisional frame.

Lens-corrected photographs with saved repair strokes keep native coordinates
through repair before the thumbnail is reduced. Other small previews scale
the dust particle-size threshold to their working dimensions. The ordinary
full-resolution 8/16-bit export path is unchanged.

The optional real-file regression also passed with a 76 MB DNG decoded to
9536 × 6336 RGB16 and a 17 MB NEF. Three warm activations were observed at
72/94/87 ms with zero new file reads, LibRaw calls or conversion requests;
the DNG GPU sample hash and zoom matched before/after. The NEF decoder used
its existing embedded-preview fallback in this run, so this is not evidence
of full-precision NEF decoding. That run forced no export; since #249 the
RAW regression keeps import auto-frame on and ends with a 16-bit export
before and after an A/B/A switch, which must be byte-identical.

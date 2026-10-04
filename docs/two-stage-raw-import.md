# Two-stage RAW imports (#255)

A 60 MP RAW takes about 5 s to decode fully in LibRaw (WASM, one thread),
plus the defect pass (a verified desktop decodes natively instead, and a page
with shared memory runs libraw-wasm's threaded build once a release ships it:
`docs/raw-decoding.md`). A half-size 16-bit decode of the same file takes about 2 s. The
two-stage import shows an editable half-size stand-in first and installs the
exact full decode behind it. Exports and every other exact consumer only
ever see the full decode.

## The plan

`rawDecodePlan(file, { buffer, minPixels })` (`imageDimensions.js`) decides
from the TIFF/DNG header, not from the compressed size:

| file | stages |
|---|---|
| CFA mosaic (PhotometricInterpretation 32803) of at least `minPixels` | 2 |
| CFA below `minPixels` | 1 |
| LinearRaw (34892): LibRaw cannot shrink demosaiced data | 1 |
| `.tif`/`.tiff`, iPhone DNGs (routed to UTIF), non-RAW files | 1 |
| header unreadable (CR3, RAF, a truncated file, ...) | 2 above `RAW_SIZE_HEAVY` (100 MiB), else 1 |

`loadFile` passes the whole file it has read, so an IFD0 stored at the end of
the file (`L1009967.dng`) is found. Header-only callers read 256 KiB and follow
IFD offsets past it with aligned 64 KiB `slice()` reads (at most 128).
`parseImageDimensions` returns the matched IFD's `photometric`; its IFD walk
is one generator driven by a buffer or by a File, and finds exactly the sizes
the 1703835 parser found (`imageDimensions.plan.test.mjs`). `RAW_SIZE_HEAVY`
exists only in `imageDimensions.js`; `rawFileLoader.js` imports it for the
heavy-IIQ shortcut.

### The flag

`twoStageMinMp` (URL `?twoStageMinMp=N`, else localStorage
`nc_two_stage_min_mp`, else `TWO_STAGE_MIN_MP_DEFAULT` in
`provisionalPhoto.js`) sets `minPixels`. The default is **off** until the
parity criteria below pass on real 60 MP files; then it becomes 40
(`TWO_STAGE_MIN_MP_TARGET`). Off keeps today's gate for every file: two
stages above 100 MiB. Everything else here (stage-1 options, crop units,
held-back analyses, barriers, lifecycle) applies to whatever goes two-stage,
so files over 100 MiB are exact today whatever the flag. Before #255, such a
file could export its half-size stand-in, clamp and double its crop, and lose
stage 2 to crop mode or a failure.

## Stage 1 and stage 2

- **Stage 1**: `loadRawFile(buffer, name, { preview: true, halfSize: true,
  outputBps: 16, suppressSensorDefects: false })`, on the file's own buffer,
  through the #232 post-decode worker. 16-bit output costs the same as 8-bit.
  The defect pass is skipped because it is slower on binned data, and stage 2
  runs it. `loadRawFile` no longer derives half size or 8-bit output from the
  byte size or `preview`; the caller states them (`preview` only shortens the
  timeouts). The result carries `__decodeScale` 0.5 and `__fullSize` (LibRaw's
  metadata size, else the file header's raw IFD, else twice its own). A result
  LibRaw did not halve (LinearRaw: at the reported size, or of a LinearRaw IFD)
  carries neither. It is logged and still provisional, since it had no defect
  pass.
- **Stage 2**: a full decode (`loadRawImageData`) of a second
  `file.arrayBuffer()`. Nothing is copied on the main thread and no buffer is
  pinned in state. It starts with stage 1 in a second LibRaw worker when
  `navigator.deviceMemory >= 8 && hardwareConcurrency >= 6` (Chromium only).
  Everywhere else (WKWebView on the macOS desktop, WebKitGTK, Safari, smaller
  devices) it starts when stage 1's LibRaw worker is gone
  (`onLibRawReleased`), before stage 1's post-decode work and analyses.
  `?twoStageMode=sequential|concurrent` forces either. If stage 1 fails, the
  full decode becomes the load.
- **Memory** (#258): stage 1 takes the activation's foreground reservation at
  the loader gate with its half-size decode peak. Stage 2 takes a foreground
  reservation of its own there with the full size, released when its decode
  returns. From its return until the swap the ledger counts the decoded full
  base with the open photo (`record.decodedImage`), which the record takes
  before the reservation goes: releasing it admits the requests waiting in
  the budget at once, and that admission already sees the full base.
  Foreground requests never wait, so the budget does not choose between the
  concurrent and the sequential start.
- A lane's decode of the same file (#243 `sharedDecodes`), or the next
  photo's base in the prefetch slot, is adopted instead of both stages. A
  photo without a recipe opened that way gets its recipe from that full
  decode, the recipe a direct open settles on (#229 review R1-062).

`state.fullDecode` is the record (`waiting` → `running` → `decoded` →
`swapped` → `installed`, or `failed` / `abandoned`). `state.rawDecodePending`
is true from the stand-in until the swap. `state.provisional` holds the
window: the geometry mapping, the provisional pass's inputs and its settled
settings.

## The provisional window

### Crop units

Live state works in the stand-in's units: `state.cropRegion` is relative to
its post-mirror frame, so every live pixel path (display, crop mode, analysis
regions, brushes) is unchanged. Every settings object is in full-resolution
units. `createExactGeometry` (`provisionalPhoto.js`) does the conversion at
that boundary:

- `restoreSettings` projects the saved crop onto the stand-in's rotated frame
  (by the ratio of the two rotated frame sizes, rounded outward). It records
  the saved crop as exact and never writes the projection back.
- `extractCurrentSettings` emits the exact crop while the live geometry is
  that projection. After a user edit (a crop, rotation or mirror in the
  window) the live crop is converted once, at 2 px granularity, and becomes
  the new exact crop.
- Undo entries carry the exact state (`provisionalGeometry`). A restore in
  the window brings it back.
- The swap installs the exact crop on the full frame: no clamp, no ×2, no
  drift. A converted edit is converted again against the real full size,
  because `__fullSize` may be an estimate.

Repair strokes and dodge-and-burn paths are stored in normalised base
coordinates, so they need no conversion.

### Analyses

`prepareStudioPhoto` runs on the stand-in as today (createDefaultSettings,
auto-frame and film edge on the stand-in, learned defaults, the provisional
conversion and its automatic WB). Its side effects are held back:

- nothing is persisted (`persistCurrentFileSettings` refuses);
- no `automaticDefaults` (`provisionalLearnedSettings`);
- no vote into the roll's film-type decision (`settleImportFilmType` with
  `record: false`);
- no roll date from the edge text (`mergeImportFilmEdge` with
  `rollDate: false`);
- no semantic colour.

Toasts are shown as usual and are not repeated. The pass records its inputs
(`defaultSettingsInputs`, the snapshot, the detection decisions, the auto-frame
settings, `userEdited`) and, when it ends, the settled settings the window's
edits are measured against.

`settleProvisionalPhoto` then works off-state. It computes the settings
today's single decode would have given on the full decode: the pixel-derived
fields of createDefaultSettings with the recorded inputs, the same
detections (the full decode goes to the worker without a copy, `owned`), and
the same film-edge, roll film-type and learned-default steps (these vote,
learn and set the roll date). Those steps decide with the `userEdited` the
pass began with: an edit made in the window neither drops the learned
defaults nor locks the frame out of the roll's film-type decision. It waits
until the swap cannot cut into an interaction: the pass is over, no crop
draft is open, no conversion or geometry build is running, and input has
been quiet for 400 ms, unless an exact consumer is waiting. A crop-area
detection still running there measures the stand-in's sample: it ends
instead (step 4 runs it on the full base). It then swaps in one task:

1. The user's window edits (`windowEdits`, the diff between the pass's settled
   settings and now) go over the new automatic settings. Geometry, film type
   and curves count as groups. White balance counts only once a gray point
   was sampled or the gains were set by hand; conversions re-estimate it
   otherwise. `expiredAnalysis`, `learnedDefaults` and `filmEdge` always come
   from the full decode. So does `autoFrameMeta`, with what the user did in
   the window replayed on it (`windowFrameMetaOnFull`): Restore full frame
   keeps its mode, and Apply Crop and Confirm image area, whose analysis
   fields (`ANALYSIS_META_KEYS`) count as an edit even without a geometry
   change, are applied again on the full base with Apply's own rule
   (`appliedCropDiagnostics`), the frame they replaced being the settled
   one. An image area the user confirmed keeps its fractions of the base,
   the same area on both decodes. A crop that is not the image area's frame
   gets the miss outcome. The window also records its confirmation and
   whether Apply requested crop detection, independently of the hit that
   later replaces the confirmed area. A close automatic area on the full
   import cannot cancel that requested detection. Undo restores this intent
   alongside the provisional geometry.
2. The history is rebased: every entry's crop goes to full units, entries go
   cold (#244: rebuilt from the full base on restore), and dust-stroke
   entries (they patch stand-in planes) go with everything older. Both Undo
   and Redo stacks overlay each entry's own window edits on the full import's
   recipe, including its automatic film base and geometry. Each entry's
   Apply/Confirm intent is replayed on the full diagnostics. Stand-in hit
   tokens are discarded. Restoring a promoted entry redetects its crop on
   the full base before conversion. Automatic WB carries its measurement
   recipe, geometry and frame intent: a late hit measured after an exposure
   edit and a completed hit measured before it remain distinct, as with one
   decode. The swap and cold restores remeasure that event on the full base
   without installing its older controls; manual WB remains the entry's.
   If the stand-in detector is still pending at the swap, cancellation keeps
   its unresolved WB intent shared with the matching history entries. The
   replacement full-base hit supplies that event's actual settings, even if
   detection finishes before conversion begins. It must not replay the
   preceding import/confirmation measurement over the new crop hit. A miss
   keeps that preceding completed measurement; manual, gray-point and
   semantic WB overrides still win. The intent retains no pixel planes.
   The measurement recipe and geometry are captured at conversion dispatch,
   before awaiting the worker reply. A control edited while that reply is
   pending stays live; replay measures the recipe that actually produced the
   pixels. History captured after full-source installation and before WB
   completion shares the same pending event even after the detector finishes.
   Those matching entries are cold, so restoring them rebuilds full-source
   pixels and awaits the event rather than retaining the previous positive.
   This also applies to snapshots captured during a full-base history
   restoration after provisional promotion has ended. Geometry and detection
   may already have finished while conversion or WB replay still waits;
   entries captured by edits, Undo or Redo remain cold for the whole history
   barrier and carry the same WB event into later restoration.
   That binding belongs only to the current restore operation. A hot or cold
   restore, saved-settings replacement, new geometry or photo activation
   invalidates the superseded live binding through geometry cancellation.
   Apply/Confirm captures the outgoing entry before cancellation, including
   analysis-only Confirm with unchanged geometry planes.
   Reset all adjustments also replaces the operation after saving Undo:
   unity gains are a new WB intent even when the old baseline was unity.
   Any still-requested geometry rebuilds before the reset conversion.
   Snapshots without the required positive remain cold after the old owner
   is detached, so Undo rebuilds that new recipe instead of a missing frame.
   Saved entries retain their completed measurements and intent. The old
   finalizer compares its promise identity and cannot clear a newer restore.
   Conversion replies also compare the operation token after geometry/source
   preparation, even when a hot restore reuses identical source objects.
   The full-swap WB event has its own installed operation token: after
   superseding history, it no longer supplies snapshots or automatic WB, and
   its obsolete replay cannot overwrite the newer recipe. The full decode
   still completes admission; the immutable saved measurement remains valid.
   The event also keeps its film type and positive mode. Full-import WB may
   seed a promoted entry only when that interpretation matches; an old event
   cannot be relabelled by promotion or replayed into a different mode.
   Replay checks the interpretation and user ownership both before and after
   awaiting conversion. Pending crop-WB events carry the same provenance.
   A late crop hit converts the original historical interpretation when the
   dispatched positive belongs to another recipe. Completed events match
   type/mode, WB ownership, film base, semantic map and roll inputs; both old
   and new entries keep their own measurements. Intermediate Undo/Redo
   entries sharing that detection token are measured too, even if neither
   the starting nor final conversion used their WB and input recipe. Each
   recipe is captured before its worker wait, without installing historical
   pixels; temporary planes are released before the detection settles.
   Dispatch settings stay fixed
   across the worker wait, and a crossing converts the current recipe before
   adopting it. Manual/gray WB locks still permit missing rescue analysis on
   cold replay.
   Promoted replay captures the restored entry's inputs and checks they have
   not changed before dispatch or after an await. Its earlier event keeps its
   own recipe; a newer input edit retains its genuine WB measurement.
   Other automatic conversion measurements, including expired-film analysis,
   still run before that WB replay, preserving user rescue strengths.
   Pending restoration joins the crop-analysis barrier, so exports and saved
   recipes cannot sample the intermediate diagnostics (#229 R2-052).
3. The full base is installed (`rawDecodePending` false). The stand-in's
   renders are dropped, and `restoreSettings(..., { holdBusy: false })`
   rebuilds the geometry in the #244 pool without `studioBusy`.
4. That crop's crop-area detection starts on the installed base, as Apply
   starts it (`startCropDetection`). The settle waits for its outcome (a
   hit converts again) after the conversion below, so `installed` includes
   it, as a single decode's exports wait for it.

One `processNegative` of the full base follows, with today's automatic
measurements. Then the record is `installed` and semantic colour is scheduled,
for the edit revision the provisional pass ended with (`settledRevision`, taken
with `settledSnapshot`): an edit or an export click in the window cancels it
(the export's click-time freeze bumps `manualEditRevision`), so an export never
picks up a map that lands while it renders.
The settle never raises the overlay, sets `studioBusy` or shows a toast.

### Barriers

`ensureFullDecode()` resolves true once the photo on screen is its installed,
converted full decode, and false if the photo was left. It never hands out
the stand-in:

| consumer | behaviour |
|---|---|
| single export (DNG included), `ensureFullResolutionReadyForExport` (dust detection, AI brush plane) | waits behind the export overlay |
| Export All, ZIP export, contact sheet, settings sync, roll reference, Save settings | wait before reading the current photo's recipe |
| Analyze roll, Auto Frame and Auto Frame Selected, Apply film type to roll, Save Project | wait with "Preparing full resolution…" before they persist the current photo's recipe (`persistCurrentFileSettings` refuses in the window) and read it back or detect its frame |
| AI brush, dust brush, "Use as flat field", and "Apply flat field to selected" (and "Find blank frame") when a photo without settings gets defaults measured on the open frame (`flatFieldDefaultsImage`) | wait with "Preparing full resolution…" |
| automatic roll analysis, "These are positives", lanes, prefetch | `studioBackgroundReady` / `foregroundBusyForBackground` wait while stage 2 runs or settles (after a failure, see below) |
| photo sessions, roll samples | refuse the stand-in (`rememberPhotoSession`, `rememberPhotoBase`, `canReuseLoadedRollSource`) |

Once an exact consumer is waiting, the swap no longer waits for input to go
quiet.

### Failure, abort, leaving

- **Failure**: a toast ("Full resolution could not be loaded; export will
  retry"). The status becomes `failed` and the photo stays provisional. The
  next exact consumer decodes again in the foreground, and a second failure
  fails that consumer. It never falls back to the stand-in. A concurrent
  stage 2 can fail while the stand-in still decodes: its record keeps the
  failure, and the toast comes when the stand-in is installed.
  A failed stage 2 holds no background work (`studioBackgroundReady`, as
  `foregroundInteractionBusy`): the lanes and the automatic roll import go
  on beside the stand-in until an exact consumer decodes again, which they
  then wait for. The roll import never persists or samples the stand-in
  (`persistCurrentFileSettings`, `canReuseLoadedRollSource`), and its
  film-type flip and "These are positives" wait for the exact photo. It
  analyses the other frames without the open photo: a roll formed meanwhile
  leaves it out, as a frame whose decode failed; where fewer than three
  others share its roll none forms meanwhile, and it is analysed with them
  once exact. The prefetch stays off while the open photo is provisional.
- **Abort**: the record's controller follows the activation (#243). A switch
  disposes stage 2's LibRaw and post-decode workers in the same task
  (`abandonFullDecode`).
- **Leaving before the photo is exact**: the saved recipe stays as it was,
  plus the user's window edits. A photo without a recipe keeps only those
  edits as `item.pendingEdits`. Switch-back (`prepareStudioPhoto`), batch
  export (`processFileWithSettings`), roll analysis, Auto Frame Selected and
  the flat field compute the automatic fields as for a fresh file. Reopening
  and batch export first rebuild the full decode's diagnostics for geometry
  and analysis-area edits, then replay the user intent; other window edits
  are applied on top.
  That fresh recipe decides as the window's pass began: leaving records the
  pass's `userEdited` as `item.pendingUserEdited`, which `importUserEdited`
  hands to the recipe's learned-default and film-type steps until the photo
  has a recipe again. Everywhere else the photo counts as edited
  (`item.userEdited` stays set): the automatic roll import leaves it alone,
  as after one decode, and never builds it a recipe without its pending
  edits; the roll's decisions for other frames treat it as edited.
  `photoSettingsKey` includes the edits of a photo without a recipe. A
  geometry/analysis edit also stores `item.pendingFrameEdit`: the confirmed
  area, crop-analysis intent and any existing full-base recipe. Stand-in
  `autoFrameMeta` is discarded. Reopening, Export All and the full-decode
  settle replay that intent on the full base; crops run crop-area detection
  again before conversion, while confirmed areas keep their normalized
  coordinates (R2-052). Pending geometry cannot suppress that full-base
  analysis. The photo's tile
  keeps the stand-in's render without its settings key, so the lane renders
  the photo again.

## Flagged approximations (display only, never exported)

- The stand-in comes from 2×2-binned data, with no AHD and no defect repair.
  It is softer past 50 % zoom, may show single hot pixels, and edges differ
  slightly in colour.
- Automatic values can move at the swap: the auto-frame crop and angle by a
  few pixels, and the film base and WB slightly. The settled view is exact.

## Tests

The targeted `TWO_STAGE_SCENES=crop-leave` browser scene holds stage 2,
confirms an area, crops, requires the stand-in detector to hit, then leaves
before full installation. Export All's decoded samples (including 16-bit
PNG/TIFF and linear DNG) must match the same edits after a single decode.
The scene uses a separate small framed CFA fixture and exports DNG first:
even a source-only export must finish the viewed photo's automatic WB before
committing its full recipe. Those gains use the viewed sliders' two-decimal
normalization, and the settled recipe stops being a thumbnail's automatic
recipe, so subsequent exports retain them.
Node regressions exercise full-base replay after early leaving for fresh and
previously configured photos, hits, misses and manual confirmations.

- `imageDimensions.plan.test.mjs`: the plan on synthetic headers (CFA ≥ / <
  40 MP, LinearRaw, iPhone, `.tif`, unreadable above and below 100 MiB, the
  flag off, IFD0 past 256 KiB), parity of the IFD walk with the 1703835
  parser, and the repo-root RAW fixtures when present.
- `provisionalPhoto.test.mjs`: crop projection and the exact round trip
  (rotated, mirrored, clamped-looking, the issue's {400, 300, 8700, 5800}),
  convert-once edits, the window-edit merge, and Apply Crop and Confirm
  image area as edits of `autoFrameMeta`'s analysis fields.
- `twoStageImport.test.mjs`: the real main.js functions (loadFile routing and
  stage options, sequential and concurrent start, abort on switch, the
  barrier with retry and failure, a concurrent stage 2 failing before the
  stand-in shows, the settle with its history rebase, and leaving early). The settle and a photo left with a window edit decide as
  their pass began (learned defaults, the roll's film type): one decode's
  recipe plus the edit; outside the window every roll decision and recipe
  equals the old functions' (synthetic rolls). Analyze roll, Auto Frame
  Selected, Apply film type to roll and Save Project clicked in the window
  wait for the exact photo and end as on one decode (on one decode as
  before); crop mode and the automatic roll import (fake timers) still
  complete. Confirm image area on the stand-in survives the swap over the
  full decode's diagnostics; a crop applied there is detected again on the
  installed base, its stand-in detection ended or its hit dropped, and the
  photo is exact once that lands; a rotation or Restore full frame keeps the
  full decode's diagnostics; Apply flat field to selected measures new
  photos' defaults on the full decode. Each ends as on one decode. Each
  window case has a control without the fix. The admission that stage 2's
  release runs reads a ledger (a real `createMemoryBudget`) that counts the
  full base. After a failed stage 2 background work goes on (old and new
  `studioBackgroundReady` agree on every other state), the real automatic
  roll import runs without persisting or sampling the stand-in and ends as
  without the failure, and the roll's film-type changes to the open photo
  wait. A photo without a recipe adopted from a lane's decode or the
  prefetch slot gets a direct open's recipe. With the real geometry (#244's
  harness), a crop applied in the window and undone after the swap installs
  the pre-crop region in full units with the full base's planes, and Apply
  Crop then maps within the full decode (controls: 4fdd9db's landing).
- `restartRender.test.mjs`: the provisional pass holds its side effects back;
  switch-back to a photo left in the window decides as its pass began.
- `processFileWithSettings.parity.test.mjs`: Export All of a photo left in
  the window writes the recipe, and the pixels, of one decode plus the edit.
- `rawFileLoader.postDecode.test.mjs`: explicit half-size options,
  `__decodeScale`, and the `onLibRawReleased` timing.
- Smoke (`scripts/two-stage-import-smoke.mjs`, `--two-stage-only`): generated
  1600×1066 CFA DNGs with `?twoStageMinMp=1`, stage 2 held or failed through
  the `?debug=1` hooks. Each of the parity scenarios is compared with the
  same files decoded once: export after the settle, export during stage 2
  (each format clicked while stage 2 is held), crop mode open when stage 2
  lands, a failed stage 2, leaving before stage 2 then Export All, and
  Analyze roll clicked during stage 2 after an exposure edit. Each compares
  the whole settled recipe (a roll id aside), every photo's
  `automaticDefaults` (`__ncTwoStage.status()`), and PNG 8, PNG 16, TIFF 16,
  JPEG and DNG exports by the SHA-256 of their decoded samples (PNG through
  the app's decoder, the TIFF and DNG strips, the JPEG's primary image and
  gain map) and of their bytes (not after a roll analysis: its roll id is new
  on every run). An export clicked before the photo is exact (during stage
  2, after a failed stage 2) freezes the recipe at its click, before the
  photo's semantic colour pass could answer; its reference is one decode
  exported as soon as the photo shows, with that pass's answer held until
  the exports are written (on a photo whose semantic colour moves the white
  balance the two differ). The exposure edit before Analyze roll is made the
  same way in both runs, before the semantic colour pass answers; that
  scenario's exports are compared with one decode's Export All of the same
  recipe, because one decode's own export right after the roll analysis can
  carry a full-resolution render its edit armed (audit backlog). It also checks the stand-in, installation without
  `studioBusy` and the ledger under crop mode. The settle and a PNG 16
  export during stage 2 run once more on a 2800×1866 DNG with
  `?largeImagePixels=2000000`, the paths of a 60 MP file: its full decode
  counts as large (the >16 MP rules: display-resolution conversions, a
  full-resolution render only for exports) and its exports convert on the
  band pool (over 4 MP), while its stand-in (1.3 MP) is neither; the page's
  threshold and the band pool's use are checked. TIFF 16 and DNG exports
  clicked during stage 2 have the full decode's width, height and 16-bit
  samples. A photo without a recipe opened from the prefetch slot and the
  same photo opened directly (two stages) give the same recipe,
  automaticDefaults and exports. With three photos and the open one's stage
  2 failed, the other two get their thumbnails while it stays provisional,
  and no roll is analysed from its stand-in.
  `TWO_STAGE_SCENES=crop-history` also holds the preview detector through
  full-source promotion, proves cancellation and replacement settlement
  before releasing the old worker request, and compares live/Undo/Redo
  PNG8/TIFF16 decoded samples and file bytes with a delayed-hit single-stage
  reference. The cancelled late preview answer must leave WB and diagnostics
  unchanged. Existing before/after-exposure hit scenes remain included.
  The conversion-in-flight scene lets the replacement detector finish while
  full-source geometry is held, then holds the actual WB conversion reply
  dispatched at exposure 15. A new history entry edits exposure to 0 before
  release. Live/Undo/Redo PNG8/TIFF16 samples and bytes must match the same
  delayed conversion on a single-stage decode.
  The cold-undo-edit and cold-redo-edit scenes then hold a cold history
  restore's conversion reply after geometry/detection finish, edit exposure
  again, and compare live and repeated Undo/Redo PNG8/TIFF16 samples and file
  bytes with one stage. A second Undo during the first rebuild creates the
  cold Redo entry through the actual history caller. The barrier must stay
  pending until the worker reply is released; no history/capture function is
  replaced.
  The ownership-wb and ownership-conversion scenes then Confirm a later
  full-base area, Undo into a cold rebuild, hot Redo twice while its reply is
  held, and create a new exposure edit. The WB-only scene proves that live
  conversion, geometry and detection finished before the held reply. Both
  scenes compare live and repeated Undo/Redo PNG8/TIFF16 decoded samples and
  file bytes with one stage. Two reset scenes replace cold WB/conversion with
  the actual Reset all adjustments action; a Confirm-only scene replaces
  cold WB with a new analysis area, without intervening Undo/Redo. Each then
  edits exposure and compares live and repeated Undo/Redo PNG8/TIFF16 samples
  and bytes. The conversion reset opens its real confirmation on the hot
  photo, holds that UI reply, and accepts it during cold conversion, when a
  newly opened Reset action would be disabled. `TWO_STAGE_HISTORY_TIMINGS`
  can select individual timings during development; the default crop-history
  gate runs all eleven.

## Verification on real files (not in the repository)

- Parity: `TWO_STAGE_PARITY_FILES=/raw/L1000617.DNG:/raw/L1009967.dng
  node scripts/smoke-test.mjs --two-stage-only`. After the generated files,
  each listed file runs the smoke's scenarios and checks above, against one
  decode of it with the flag off: the settle, an export during stage 2 in
  each of the five formats, crop mode, a failed stage 2, leaving then Export
  All and Analyze roll during stage 2, the other photo being a generated
  DNG; and the file opened from the prefetch slot against the file opened
  directly. The two-stage runs use `?twoStageMinMp=40`
  (`TWO_STAGE_PARITY_MIN_MP` sets another threshold, so smaller RAWs can go
  two-stage too). Run one 60 MP file at a time: a file takes several
  minutes. So far it has passed on `_DSC3111.NEF` (10.7 MP, concurrent
  mode) with `TWO_STAGE_PARITY_MIN_MP=1`; the 60 MP files with the default
  threshold are still to run.
- Latency and memory: the #230 benchmark (S1 import on `L1000617.DNG`, S7 cold
  switches over `L1000617…628.DNG`), with and without `?twoStageMinMp=40`, in
  concurrent and in forced sequential mode (`&twoStageMode=sequential`). Take
  `window.__ncTwoStage.diagnostics` (plans, stage-1 sizes, stage-2 times and
  mode, swaps) and the `twoStageSettle` perf trace (`?perf=1`).
- The flag's default moves to 40 only after both pass.

## Not done here

- **Part 7** (unpack once in the LibRaw-Wasm fork, `imageData({ halfSize })`
  after one `unpack()`) belongs to the local, gitignored `LibRaw-Wasm/` fork.
  The app ships npm `libraw-wasm`. It would save about 1.2 s of shared unpack
  per two-stage open. First check that `half_size` toggles cleanly between
  `dcraw_process()` calls for DNG.
- Zoom detail levels beyond the stand-in (#248). The concurrent start still
  follows `stageTwoStartMode`, not the memory budget (#258).

The crop-interpretation history smoke includes 32 encoded scenarios: the twelve prior endpoint flows, eight intermediate type/mode flows and twelve warm/full-source manual-base, semantic-map and roll-input flows across rescue off/on. Manual bases use canvas clicks. Semantic/roll updates use bounded input leaves injected only into the test response; roll histogram/density measurements use real image data downsampled to at most 256 pixels per side. Production capture, measurement, Undo/Redo and PNG8/TIFF16 encoding remain intact. Each intermediate recipe is checked on two Undo/Redo rounds against actual batch and independent full-source exports, preserving its base, semantic anchors and roll inputs. These synthetic correctness checks do not establish historical noMask/positive baseline parity, Safari functionality or native/60MP performance targets.

A rescued history entry captured before a crop hit cannot reuse its miss-frame rescue analysis. Restoration adopts a matching hit measurement or rebuilds and measures that recipe behind the existing owned history barrier, preserving explicit strengths and WB ownership. Independent intermediate rescue references remeasure from their own full geometry and inputs.

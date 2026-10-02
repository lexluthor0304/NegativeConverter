# Automatic import and output (roadmap #181, group A)

## Import

Three or more newly imported negatives of one detected stock run the existing
roll analysis after the first frame renders. Mixed stocks are separated; a
group with fewer than three frames is left alone. Saved settings, manual film
bases, edited frames and reference locks take precedence. The import switch is
on by default and stored locally. One Undo restores the whole transaction,
including settings and thumbnails of the other frames. Exposure equalisation
remains optional.

The film-edge worker first reads the perforation lanes and DX barcode, then
rectifies those lanes for template matching. Without perforations it examines
narrow outer bands for 120 edge lettering. Templates share the output bitmap
font and recognise stock vocabulary, frame numbers and Kodak date symbols.
DX remains authoritative. Weak/ambiguous text cannot mirror the image or fill
a year; repeated historical Kodak symbols retain candidate years. Existing
frame metadata is preserved. Year-only dates are written to XMP; EXIF dates
require a full date.

## Semantic colour

The bundled Apache-2.0 EfficientViT B1 ADE20K model runs on a maximum 512-pixel
preview in a disposable worker, after statistical conversion has rendered.
It only runs where the map can be used: colour film, or any film under
expired-film rescue, and not for the frames of a scheduled automatic roll
analysis, which assigns their recipes meanwhile. A photo left or edited
mid-inference terminates the worker at once: the analyzer polls only what
stays false once false (the load, the photo, the edit revision, the user's own
white balance or grey point, a reference lock, a saved recipe). Passing states
(crop mode, Auto Frame, a roll import) count before and after the inference
only, so crop mode opened and cancelled meanwhile keeps the map. A two-stage
import schedules the pass after its swap, for the edit revision its stand-in
pass ended with: an edit or an export click in the window cancels it, as one
after an import always did. WebGPU is preferred and probed with a warm-up
run (a WASM session makes just the real run); initialization, warm-up or
inference failure rebuilds on WASM. Failure keeps statistical colour. The result is a sanitised 64 × 64 label
map stored with the photo recipe. Manual WB, a sampled grey point, manual base,
saved settings, reference locks and positive Edit only take precedence.

Person labels include clothing, so only plausible skin-coloured pixels vote
for a skin hue/chroma band. Sky uses a range, not a single blue. Vegetation and
water cannot vote as neutrals; road/wall/building pixels receive more weight.
Expired-film analysis accepts the same class weights. Source revision, model
hash, tensor contract and reproduction instructions are in
`negative2positive/public/models/README.md` and `scripts/export-semantic-model.py`.
The ONNX file itself lives in `negative2positive/src/assets/models/`, so its URL
carries a content hash. The page loads it at most once per session
(`createSemanticAnalyzer`, IndexedDB copy on the web through `modelCache.js`)
and posts the Blob to each short-lived semantic worker, which still ends with
its photo; a worker fetches the model itself only when the page has no copy.

## Learned defaults

Explicit colour-control edits are recorded after settings are saved or an
export succeeds. The local IndexedDB key is stock × lab × film type. One roll
gets one median vote, regardless of the number of frames or repeat exports.
No WB, geometry, metadata or reference settings are learned. Saved/project
recipes are not training examples. Reset is available in the workspace menu.

Numeric offsets use `median × n / (n + 3)` with a ±25 cap. Thus three rolls at
+12 contribute +6, following issue #185's stated formula; its separate +9
example is inconsistent with k=3. Categories require at least three roll votes
and a stable majority. Import-time factory defaults are retained as the
baseline, so repeated exports do not compound the learned offset.

## Output

PNG, JPEG and TIFF always embed the bundled sRGB ICC profile, including when
no analogue metadata was entered. PNG removes conflicting sRGB/gAMA/cHRM
chunks. JPEG includes an optional, default-on gain map with Adobe gain-map XMP,
a secondary JPEG and MPF offsets. The SDR scan bytes are retained. PNG8 and
JPEG are encoded in the export worker through `OffscreenCanvas` (#250), and
the map travels in the JPEG's own `encodeImage` request: once the SDR blob is
done, the worker runs the 16-bit adjustment pass on the unadjusted plane,
`workers/gainMap.js`, and a second encode for the map. Where the worker cannot
encode (no `OffscreenCanvas.convertToBlob`, a non-opaque frame), the main
thread encodes with a canvas and the map runs beside it in the worker
(`gainMap16`). That map ends with the export: Cancel stops it, and when a
single export's canvas encode fails, disposing of the export's worker cancels
it without a fallback pass. The sRGB
EOTF comes from exact Float64 tables over the 256 and 65536 integer codes,
summed in the original order, so the map bytes and `GainMapMax` are the ones
the per-sample `** 2.4` produced. A sprocket-frame export computes no map,
since the framed image never carried one.

**Current dynamic-range limit:** the conversion pipeline's 16-bit plane is
bounded sRGB, not scene-linear HDR above reference white. The map records the
actual linear-light ratio to the SDR rendition; ordinary conversions therefore
produce an almost identity map. This container support does not recover
clipped highlights or claim new HDR headroom. A scene-linear output path and
physical HDR-display comparison remain release validation work.

Names include available roll/source, frame number and stock, with invalid path
characters removed. The old source-name fallback remains when metadata is
absent. See `simplicity-validation.md` for tested states and remaining checks.

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
WebGPU is preferred; initialization, warm-up or inference failure rebuilds on
WASM. Failure keeps statistical colour. The result is a sanitised 64 × 64 label
map stored with the photo recipe. Manual WB, a sampled grey point, manual base,
saved settings, reference locks and positive Edit only take precedence.

Person labels include clothing, so only plausible skin-coloured pixels vote
for a skin hue/chroma band. Sky uses a range, not a single blue. Vegetation and
water cannot vote as neutrals; road/wall/building pixels receive more weight.
Expired-film analysis accepts the same class weights. Source revision, model
hash, tensor contract and reproduction instructions are in
`negative2positive/public/models/README.md` and `scripts/export-semantic-model.py`.

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
a secondary JPEG and MPF offsets. The SDR scan bytes are retained.

**Current dynamic-range limit:** the conversion pipeline's 16-bit plane is
bounded sRGB, not scene-linear HDR above reference white. The map records the
actual linear-light ratio to the SDR rendition; ordinary conversions therefore
produce an almost identity map. This container support does not recover
clipped highlights or claim new HDR headroom. A scene-linear output path and
physical HDR-display comparison remain release validation work.

Names include available roll/source, frame number and stock, with invalid path
characters removed. The old source-name fallback remains when metadata is
absent. See `simplicity-validation.md` for tested states and remaining checks.

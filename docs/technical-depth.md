# Technical depth: true 16-bit, linear DNG, on-device AI repair

Roadmap items #161, #162 and #163.

## True 16-bit end-to-end (#161)

The Step-3 adjustment stage (white balance and exposure gains, contrast,
highlights / shadows, temperature and tint, saturation and vibrance, CMY,
curves, the lab-match look) used to run only as an 8-bit LUT pipeline, so a
16-bit export carried 8-bit data whenever any of those controls was active,
and the export menu said so.

`workers/pixelAdjustments16.js` is the same maths on the engine's 16-bit
RGBA plane: every stage is evaluated in floating point on the 0..255 scale
the controls are defined on, and the 256-entry curve LUTs (the user's curve,
the look curves) are interpolated linearly instead of looked up. Separable
chains (no highlights / shadows, no HSL, no look matrix) build three
65536-entry LUTs once; the rest runs per pixel. `adjustmentPipeline.js`
exposes `applyPreparedAdjustmentsToBuffer16`, the export worker has an
`applyAdjustments16` message, and `main.js` chooses the 16-bit path when the
export asks for 16 bits and the conversion produced a plane
(`applyAdjustmentsWithSettings(…, { bitDepth: 16 })`, for the open photo and
for every batch file). PNG16 and TIFF16 then encode the adjusted plane
directly. The 8-bit preview is unchanged, the `bitDepth8BitData` warning is
gone, and the dead `original16 / cropped16 / processed16` state fields with
it.

Timing on a 24 MP frame (`scripts` benchmark, Node 26, Apple silicon):

| chain | 8-bit | 16-bit |
|---|---|---|
| separable (WB, contrast, temperature, CMY, curves) | 121 ms | 170 ms |
| per pixel (vibrance, highlights, look matrix) | 655 ms | 1470 ms |

Tests: `pixelAdjustments16.test.mjs` (a 16-bit gradient with curves, WB and
CMY keeps thousands of distinct levels per channel and stays monotone; the
per-pixel path agrees with the 8-bit path within rounding). Smoke
(`scripts/technical-depth-smoke.mjs`, `--technical-only`): a 16-bit negative
exported as 16-bit PNG with a cyan shift and an exposure change decodes to
far more than 256 distinct values per channel on a row.

## Linear DNG export (#162)

**DNG** in the export format toggle writes `<name>_linear.dng`: the
geometry-applied negative inverted and film-base normalised in linear light
(`linearDng.js`: `positive = base / negative` per channel, scaled so the
99.9th percentile sits at white; slides pass through with only the white
normalisation), as a 16-bit RGB LinearRaw DNG built on the shared TIFF writer:
`DNGVersion 1.4.0.0`, `DNGBackwardVersion 1.1.0.0`, `PhotometricInterpretation
34892`, `UniqueCameraModel`, `ColorMatrix1` = XYZ→linear-sRGB with
`CalibrationIlluminant1` D65, `AsShotNeutral 1/1/1` (the base normalisation
already balanced the frame), `WhiteLevel 65535`, `BlackLevel 0`,
`BaselineExposure 0`, `DefaultCropOrigin/Size`, plus the analog metadata
(Model, DateTime, ImageDescription, XMP). No tone curve is baked in, so the
raw converter keeps its white balance and exposure latitude. Batch export
writes DNGs through the same path; sprocket borders do not apply.

Verified here by structure: `linearDng.test.mjs` parses the tags back and
checks the inversion (a dense negative becomes a bright, neutral, linear
positive), and the smoke exports one from the app and reads the tags and a
bright / dark sample. Opening in Lightroom Classic and Capture One was not
possible in this environment; the file follows the DNG 1.4 LinearRaw
requirements, and the comparison of Lightroom's default rendering with the
app's neutral rendering is still to be recorded once a licence is at hand.

## On-device AI repair (#163)

**AI repair (on-device)** in the Cleanup drawer. `aiInpaint.js` runs a
learned inpainter (the LaMa ONNX export, Apache-2.0) through onnxruntime-web
on WebGPU where the browser has it and on WASM otherwise, only over the
512-px tiles that hold masked pixels: the mask is looked at through a coarse
grid, touching cells merge into boxes grown by 64 px of context, boxes are
covered by overlapping windows kept inside the image (smaller images are
edge-padded), and each tile's output is blended back with a 4-px feather,
against the original, once per pixel. The 16-bit plane follows. The model
is fetched once from the self-hosted asset URL (`download.neoanaloglab.com`,
already in the desktop CSP) and cached in IndexedDB, or loaded from a
`.onnx` file the user picks; the onnxruntime-web wasm ships with the app, so
the desktop build needs no CDN. Same mask source as before (detection plus
brush): brush strokes preview with TELEA, the learned fill replaces TELEA
when detection commits and on export (`inpaintForCommit`). Without a model
or a runtime everything falls back to TELEA and says so.

Tests: `aiInpaint.test.mjs` (boxes, tiles, padding, feathering, blending
against the original with a fake model, 0..1 and 0..255 output scales,
progress). Smoke: the controls, a failed model load that leaves the TELEA
result in place, and, when `AI_INPAINT_MODEL` points at a LaMa ONNX file
(local runs only), a real load, inference over the sample's dust mask and
the reported tiles / milliseconds.

Status against the acceptance criteria: the runtime, tiling, blending and
fallback are done and tested; the model asset still has to be uploaded to
`download.neoanaloglab.com/models/lama_fp32.onnx` (208 MB, Apache-2.0) for
the one-click path. Measured with the local model on an Apple-silicon Mac
(headless Chrome): the WebGPU session creates in about 7 s but the first
inference fails inside LaMa's Fourier layers (`/generator/model/model.5/
conv1/ffc/convg2g/Add`: "Can't perform binary op on the given tensors",
onnxruntime-web 1.19.2), so `createInpaintSession` warms every WebGPU
session up on a blank tile and rebuilds it on WASM when that fails, and
`inpaintForCommit` does the same once at run time. On WASM the fp32 model
takes tens of seconds per 512-px tile, which is far from the 200 ms target;
a WebGPU-friendly student model (MI-GAN, no Fourier units, about 6 M
parameters) is the follow-up that makes the tile budget realistic, and the
runtime here is model-agnostic (two float32 inputs, one output).

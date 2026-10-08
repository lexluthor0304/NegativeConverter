// Provisional embedded-preview rendering: orientation (LibRaw flip parity),
// the geometry chain, the quick inversion and colour matching, and the
// environment-driven renderer with a canvas-free fake.
import assert from 'node:assert/strict';
import {
  resolvePreviewOrientation, orientationMatrix, provisionalTransform, transformPixels, applyMatrix,
  applyProvisionalTone, histograms, matchLut, stretchLut, measurementRegion, renderEmbeddedPreview,
  TILE_PREVIEW_LONG_SIDE,
} from './embeddedPreviewRender.js';
import { copyRotatedRgbaBuffer } from './imageGeometry.js';
import { buildDngWithPreviews, makeJpeg } from './rawEmbeddedPreview.fixtures.mjs';

// A grid whose every pixel is unique: R = x, G = y, B = x ^ y.
function grid(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    data[i] = x; data[i + 1] = y; data[i + 2] = (x * 7 + y * 13) & 255; data[i + 3] = 255;
  }
  return { width, height, data };
}

// ---------------------------------------------------------------------------
// Orientation: 3, 6 and 8 map a pixel grid exactly as the app's right-angle
// rotation (and LibRaw's flip: 3 = 180°, 6 = 90° CW, 8 = 90° CCW) does.
// ---------------------------------------------------------------------------
{
  const src = grid(7, 5);
  for (const [orientation, angle] of [[3, 180], [6, 90], [8, -90]]) {
    const plan = orientationMatrix(orientation, src.width, src.height);
    const oriented = transformPixels(src.data, src.width, src.height, plan);
    const reference = copyRotatedRgbaBuffer(src.data, src.width, src.height, angle);
    assert.deepEqual([oriented.width, oriented.height], [reference.width, reference.height], `orientation ${orientation} size`);
    assert.deepEqual(Array.from(oriented.data), Array.from(reference.data), `orientation ${orientation} matches the ${angle}° flip`);
  }
  // Mirrored orientations: 2 flips x, 4 flips y, 5/7 transpose.
  const two = transformPixels(src.data, 7, 5, orientationMatrix(2, 7, 5));
  assert.deepEqual(Array.from(two.data.subarray(0, 4)), Array.from(src.data.subarray(6 * 4, 6 * 4 + 4)));
  const five = transformPixels(src.data, 7, 5, orientationMatrix(5, 7, 5));
  assert.deepEqual([five.width, five.height], [5, 7]);
  assert.deepEqual(Array.from(five.data.subarray((3 * 5 + 2) * 4, (3 * 5 + 2) * 4 + 2)), [3, 2], 'transpose swaps x and y');
  const identity = transformPixels(src.data, 7, 5, orientationMatrix(1, 7, 5));
  assert.deepEqual(identity.data, src.data);
}

// A preview with its own Exif Orientation is rotated once, by the decoder.
assert.equal(resolvePreviewOrientation(6, 0), 6, 'DNG previews carry no Exif: apply the TIFF Orientation');
assert.equal(resolvePreviewOrientation(6, 1), 6, 'Exif 1 is no rotation');
assert.equal(resolvePreviewOrientation(6, 6), 1, 'createImageBitmap already applied Exif 6: never both');
assert.equal(resolvePreviewOrientation(3, 8), 1);
assert.equal(resolvePreviewOrientation(0, 0), 1);
assert.equal(resolvePreviewOrientation(9, 0), 1);

// ---------------------------------------------------------------------------
// Geometry: base -> rotation -> mirror -> crop, then fit
// ---------------------------------------------------------------------------
{
  const base = grid(40, 30);
  // Right-angle rotation, mirror, crop (in full-resolution units: raw is 4x the preview).
  const geometry = { rotationAngle: 90, mirrored: true, cropRegion: { left: 16, top: 8, width: 80, height: 120 } };
  const plan = provisionalTransform({ sourceWidth: 40, sourceHeight: 30, geometry, rawSize: { width: 160, height: 120 } });
  assert.deepEqual([plan.width, plan.height, plan.cropped], [20, 30, true]);
  const out = transformPixels(base.data, 40, 30, plan);
  // Reference chain on the grid: rotate 90 (app implementation), mirror, crop.
  const rotated = copyRotatedRgbaBuffer(base.data, 40, 30, 90);
  const mirrored = new Uint8ClampedArray(rotated.data.length);
  for (let y = 0; y < rotated.height; y++) for (let x = 0; x < rotated.width; x++) {
    mirrored.set(rotated.data.subarray((y * rotated.width + x) * 4, (y * rotated.width + x) * 4 + 4),
      (y * rotated.width + rotated.width - 1 - x) * 4);
  }
  const expected = new Uint8ClampedArray(20 * 30 * 4);
  for (let y = 0; y < 30; y++) for (let x = 0; x < 20; x++) {
    expected.set(mirrored.subarray(((y + 2) * rotated.width + x + 4) * 4, ((y + 2) * rotated.width + x + 4) * 4 + 4), (y * 20 + x) * 4);
  }
  assert.deepEqual(Array.from(out.data), Array.from(expected), 'rotation, mirror and scaled crop follow the chain order');

  // Arbitrary angles expand the canvas like applyRotationToImageData.
  const tilted = provisionalTransform({ sourceWidth: 400, sourceHeight: 300, geometry: { rotationAngle: 3 } });
  const rad = 3 * Math.PI / 180;
  assert.deepEqual([tilted.width, tilted.height], [
    Math.ceil(400 * Math.cos(rad) + 300 * Math.sin(rad)), Math.ceil(400 * Math.sin(rad) + 300 * Math.cos(rad))]);
  const centre = applyMatrix(tilted.matrix, 200, 150);
  assert.ok(Math.abs(centre[0] - tilted.width / 2) < 1e-9 && Math.abs(centre[1] - tilted.height / 2) < 1e-9, 'rotation about the centre');

  // Unanalysed frames show the full preview; the long side fits the target.
  const fit = provisionalTransform({ sourceWidth: 2112, sourceHeight: 1408, maxLongSide: 320 });
  assert.deepEqual([fit.width, fit.height, fit.cropped], [320, 213, false]);
  const noRaw = provisionalTransform({ sourceWidth: 2112, sourceHeight: 1408, geometry: { cropRegion: { left: 0, top: 0, width: 10, height: 10 } } });
  assert.equal(noRaw.cropped, false, 'without the raw size the crop cannot be mapped: show the whole preview');
  // Orientation is applied before geometry: a portrait frame keeps its crop on the oriented base.
  const portrait = provisionalTransform({ sourceWidth: 2112, sourceHeight: 1408, orientation: 6,
    geometry: { cropRegion: { left: 0, top: 0, width: 6336, height: 4768 } }, rawSize: { width: 9536, height: 6336 } });
  assert.deepEqual([portrait.width, portrait.height], [1403, 1056]);
}

// ---------------------------------------------------------------------------
// Quick inversion, B&W, positive and colour matching
// ---------------------------------------------------------------------------
{
  // An orange-masked negative ramp: inversion must yield a neutral, stretched positive.
  const width = 64, height = 32;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, t = x / (width - 1);
    data[i] = 230 - 120 * t; data[i + 1] = 170 - 110 * t; data[i + 2] = 120 - 90 * t; data[i + 3] = 255;
  }
  const inverted = data.slice();
  applyProvisionalTone(inverted, width, height, { invert: true });
  const px = x => Array.from(inverted.subarray((16 * width + x) * 4, (16 * width + x) * 4 + 3));
  assert.ok(px(8).every(v => v < 60) && px(56).every(v => v > 200), 'dense negative becomes dark, thin becomes bright');
  const mid = px(32);
  assert.ok(Math.max(...mid) - Math.min(...mid) < 20, 'per-channel stretch removes the orange mask');
  assert.ok(mid[0] > 128, 'mild gamma lift brightens the midtones');

  const mono = data.slice();
  applyProvisionalTone(mono, width, height, { invert: true, monochrome: true });
  for (let i = 0; i < mono.length; i += 4) assert.ok(mono[i] === mono[i + 1] && mono[i + 1] === mono[i + 2], 'B&W outputs luminance');

  const positive = data.slice();
  applyProvisionalTone(positive, width, height, { invert: false });
  assert.deepEqual(positive, data, 'a positive frame is shown as the camera rendered it');

  // Matching to a converted thumbnail reproduces that thumbnail's distribution.
  const target = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < target.length; i += 4) { target[i] = 100; target[i + 1] = 110; target[i + 2] = 90; target[i + 3] = 255; }
  target.fill(255, 0, 0);
  const matched = data.slice();
  applyProvisionalTone(matched, width, height, { invert: true, target: histograms(target, width, height) });
  assert.deepEqual(Array.from(matched.subarray((16 * width + 40) * 4, (16 * width + 40) * 4 + 3)), [100, 110, 90]);

  // The rebate outside the central 80 % does not set the levels.
  assert.deepEqual(measurementRegion(100, 50, false), { left: 10, top: 5, width: 80, height: 40 });
  assert.deepEqual(measurementRegion(100, 50, true), { left: 0, top: 0, width: 100, height: 50 });
  const lut = stretchLut(Float64Array.from({ length: 256 }, (_, v) => (v >= 50 && v <= 150 ? 1 : 0)));
  assert.equal(lut[50], 0); assert.equal(lut[150], 255); assert.ok(lut[100] > 128);
  const identity = matchLut(Float64Array.from({ length: 256 }, () => 1), Float64Array.from({ length: 256 }, () => 1));
  assert.deepEqual(Array.from(identity.subarray(0, 4)), [0, 1, 2, 3]);
}

// ---------------------------------------------------------------------------
// Renderer with a fake canvas environment
// ---------------------------------------------------------------------------
function fakeEnv(bitmaps) {
  const decoded = [];
  return {
    decoded,
    createCanvas(width, height) {
      const pixels = new Uint8ClampedArray(width * height * 4);
      let matrix = [1, 0, 0, 1, 0, 0];
      return { width, height, pixels, getContext: () => ({
        setTransform: (...m) => { matrix = m; },
        drawImage(bitmap) {
          const out = transformPixels(bitmap.data, bitmap.width, bitmap.height, { width, height, matrix });
          for (let i = 0; i < out.data.length; i += 4) if (out.data[i + 3]) pixels.set(out.data.subarray(i, i + 4), i);
        },
        getImageData: () => ({ width, height, data: pixels.slice() }),
        putImageData: image => pixels.set(image.data),
      }) };
    },
    async decode(blob) {
      decoded.push(blob.size);
      const bitmap = bitmaps.get(blob.size);
      assert.ok(bitmap, `unexpected decode of ${blob.size} bytes`);
      return { ...bitmap, close() {} };
    },
    finish: async canvas => ({ width: canvas.width, height: canvas.height, pixels: canvas.pixels }),
  };
}
{
  const { bytes, previews } = buildDngWithPreviews({
    previews: [[160, 120], [720, 480], [2112, 1408], [9504, 6320]]
      .map(([width, height], i) => ({ width, height, bytes: makeJpeg(width, height, { tail: 64 + i * 32 }) })),
    raw: { width: 9536, height: 6336 }, orientation: 6 });
  // Each synthetic preview has a distinct byte length; map lengths to decoded grids.
  const small = grid(72, 48), mid = grid(211, 140);
  const env = fakeEnv(new Map([[previews[1].length, { ...small, width: 72, height: 48 }], [previews[2].length, { ...mid }]]));
  assert.notEqual(previews[1].length, previews[2].length);
  const file = new Blob([bytes]);

  const tile = await renderEmbeddedPreview({ file, purpose: 'tile', geometry: { rotationAngle: 5 } }, env);
  assert.equal(tile.preview.width, 720, 'tiles decode the 720 px preview');
  assert.deepEqual([tile.output.width, tile.output.height], [48, 72], 'orientation applied, geometry ignored for tiles');
  assert.ok(tile.bytesRead <= 32 * 1024 + previews[1].length);
  assert.ok(Math.max(tile.width, tile.height) <= TILE_PREVIEW_LONG_SIDE);

  const viewer = await renderEmbeddedPreview({ file, purpose: 'viewer', longSidePx: 2200, located: tile.located,
    geometry: { rotationAngle: 0, mirrored: false, cropRegion: { left: 0, top: 0, width: 3168, height: 4768 } } }, env);
  assert.equal(viewer.preview.width, 2112, 'viewer decodes the 2112 px preview');
  assert.equal(viewer.bytesRead, previews[2].length, 'a located structure is reused: only the preview is read');
  assert.deepEqual([viewer.width, viewer.height], [70, 106], 'crop scaled by preview/raw long side on the oriented base');
  assert.deepEqual(env.decoded, [previews[1].length, previews[2].length], 'the 60 MP preview is never decoded');

  const none = await renderEmbeddedPreview({ file: new Blob([new Uint8Array(64)]), purpose: 'viewer', longSidePx: 2000 }, env);
  assert.equal(none.empty, true);
}

console.log('embeddedPreviewRender tests passed: orientation parity, geometry chain, quick inversion, renderer');

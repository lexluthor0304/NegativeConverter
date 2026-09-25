// The analyzer's size-only output (#251 part 1): the rotated frame's size
// always, its pixels only when asked for, and a deferral instead of an
// inexact rotation when the caller holds only the 8-bit plane.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

globalThis.cv = await createRequire(import.meta.url)('@techstark/opencv-js');
globalThis.ImageData = class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};
const { detectFrameAndRotation } = await import('./autoFrameAnalyzer.js');
const { applyRotationToImageData, rotatedDimensions } = await import('./imageGeometry.js');

// A dark 3:2 frame on an orange base, turned by `degrees`, with a 16-bit plane.
function frame(width, height, degrees) {
  const rad = degrees * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  const w = width * 0.6, h = w / 1.5;
  const data = new Uint8ClampedArray(width * height * 4);
  const data16 = new Uint16Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const dx = x - width / 2, dy = y - height / 2;
    const u = dx * cos + dy * sin, v = -dx * sin + dy * cos;
    const inside = Math.abs(u) < w / 2 && Math.abs(v) < h / 2;
    const rgb = inside ? [95 + ((x + y) & 15), 55, 30] : [238, 160, 100];
    const i = (y * width + x) * 4;
    for (let c = 0; c < 3; c++) { data[i + c] = rgb[c]; data16[i + c] = rgb[c] * 257; }
    data[i + 3] = 255; data16[i + 3] = 65535;
  }
  const image = new ImageData(data, width, height);
  image.__image16 = { width, height, data: data16 };
  return image;
}

const settings = { highConfidence: 0.72, minConfidence: 0.55, marginRatio: 0.02, filmType: 'color', deterministicPreview: true };
const summary = r => r && JSON.stringify([r.angle, r.cropRegion, r.confidence, r.confidenceLevel, r.detectedFormat, Boolean(r.requiresReview), r.diagnostics]);

for (const degrees of [3, 0]) {
  const image = frame(900, 640, degrees);
  const fullRotations = [];
  const rotateImageData = (source, angle) => {
    if (source === image) fullRotations.push(angle);
    return applyRotationToImageData(source, angle);
  };
  const none = detectFrameAndRotation(image, { settings, maxSide: 400, rotatedOutput: 'none', rotateImageData });
  assert.ok(none?.cropRegion, `a window is found at ${degrees} degrees`);
  assert.deepEqual(fullRotations, [], 'no full-frame rotation for the size');
  assert.equal(none.rotatedImageData, undefined);
  assert.deepEqual({ width: none.rotatedWidth, height: none.rotatedHeight }, rotatedDimensions(900, 640, none.angle));
  assert.equal(none.rotatedIsSource, none.angle === 0);
  assert.ok(none.stageMs.rotateFull <= 5, 'the size costs nothing');

  const full = detectFrameAndRotation(image, { settings, maxSide: 400, rotateImageData });
  assert.equal(summary(full), summary(none), 'the same detection either way');
  assert.deepEqual({ width: full.rotatedWidth, height: full.rotatedHeight }, { width: full.rotatedImageData.width, height: full.rotatedImageData.height });
  if (full.angle === 0) {
    assert.equal(full.rotatedImageData, image, 'angle 0: the frame is the source itself');
    assert.equal(full.rotatedIsSource, true);
  } else {
    assert.deepEqual(fullRotations, [full.angle]);
    assert.ok(full.rotatedImageData.__image16, 'the 16-bit plane is rotated with it');
    assert.equal(full.rotatedIsSource, false);
  }

  // Only the 8-bit plane at hand: a size-only request needs no pixels; a
  // request that needs the rotated planes defers instead of rotating 8 bits.
  const eightBit = { width: image.width, height: image.height, data: image.data };
  const deferredNone = detectFrameAndRotation(eightBit, { settings, maxSide: 400, rotatedOutput: 'none', deferFullResolution: true, rotateImageData: applyRotationToImageData });
  assert.equal(summary(deferredNone), summary(none));
  const deferredFull = detectFrameAndRotation(eightBit, { settings, maxSide: 400, deferFullResolution: true, rotateImageData: (source, angle) => (source === eightBit ? assert.fail('rotated the 8-bit plane') : applyRotationToImageData(source, angle)) });
  if (full.angle === 0) assert.equal(summary(deferredFull), summary(full));
  else assert.deepEqual(Object.keys(deferredFull).sort(), ['needsFullResolution', 'stageMs']);
}

// The line-search verdict is recorded with the result.
{
  const image = frame(900, 640, 2);
  const result = detectFrameAndRotation(image, { settings: { ...settings, neutralLineSearch: true }, frameFilmType: 'color', maxSide: 400, rotatedOutput: 'none', rotateImageData: applyRotationToImageData });
  assert.equal(result.diagnostics.lineSearch.reason, 'colour');
  const off = detectFrameAndRotation(image, { settings, maxSide: 400, rotatedOutput: 'none', rotateImageData: applyRotationToImageData });
  assert.deepEqual(off.diagnostics.lineSearch, { channels: 'rgb', reason: 'off', chromaP95: null });
  const bw = detectFrameAndRotation(image, { settings: { ...settings, neutralLineSearch: true }, frameFilmType: 'bw', maxSide: 400, rotatedOutput: 'none', rotateImageData: applyRotationToImageData });
  assert.equal(bw.diagnostics.lineSearch.reason, 'bw-film');
  assert.equal(summary({ ...bw, diagnostics: { ...bw.diagnostics, lineSearch: null } }), summary({ ...off, diagnostics: { ...off.diagnostics, lineSearch: null } }));
}

console.log('autoFrameAnalyzer rotated output: sizes without pixels, pixels on request, deferral on 8-bit planes, line-search verdict');

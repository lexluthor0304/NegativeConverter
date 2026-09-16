// Standalone Node test: the one-pass rotate/mirror/crop must match the
// step-by-step chain bit for bit. Run with:
// node negative2positive/src/app/imageGeometry.chain.test.mjs
import assert from 'node:assert/strict';

globalThis.ImageData = class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};
const { applyRotationToImageData, mirrorImageDataHorizontal, applyGeometryChainToImageData } = await import('./imageGeometry.js');
const { cropImageDataRegion } = await import('./imageDataOps.js');

function sanitizeCrop(cropRegion, image) {
  const left = Math.max(0, Math.min(image.width - 1, Math.floor(cropRegion.left)));
  const top = Math.max(0, Math.min(image.height - 1, Math.floor(cropRegion.top)));
  const width = Math.max(1, Math.min(image.width - left, Math.floor(cropRegion.width)));
  const height = Math.max(1, Math.min(image.height - top, Math.floor(cropRegion.height)));
  return { left, top, width, height };
}
const steps = {
  rotate: applyRotationToImageData,
  mirror: mirrorImageDataHorizontal,
  crop: (image, cropRegion, bounds = image) => {
    const rect = sanitizeCrop(cropRegion, bounds);
    return image ? cropImageDataRegion(image, rect) : rect;
  }
};

// Deterministic pseudo-random 16-bit source with an 8-bit view.
function makeSource(width, height, seed = 7) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s; };
  const data16 = new Uint16Array(width * height * 4);
  const data8 = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data16.length; i += 4) {
    for (let c = 0; c < 3; c++) { data16[i + c] = rnd() % 65536; data8[i + c] = data16[i + c] >>> 8; }
    data16[i + 3] = 65535; data8[i + 3] = 255;
  }
  const image = new ImageData(data8, width, height);
  image.__image16 = { width, height, data: data16 };
  return image;
}

function reference(image, geometry) {
  let working = image;
  if (Math.abs(geometry.rotationAngle || 0) > 0.001) working = applyRotationToImageData(working, geometry.rotationAngle);
  if (geometry.mirrored) working = mirrorImageDataHorizontal(working);
  if (geometry.cropRegion) working = cropImageDataRegion(working, sanitizeCrop(geometry.cropRegion, working));
  return working;
}

function assertSame(actual, expected, label) {
  assert.equal(actual.width, expected.width, `${label}: width`);
  assert.equal(actual.height, expected.height, `${label}: height`);
  assert.deepEqual(Array.from(actual.data), Array.from(expected.data), `${label}: 8-bit pixels`);
  assert.deepEqual(Array.from(actual.__image16.data), Array.from(expected.__image16.data), `${label}: 16-bit pixels`);
}

const source = makeSource(97, 61);
const cases = [
  { rotationAngle: 2.7, mirrored: false, cropRegion: { left: 10, top: 8, width: 60, height: 40 } },
  { rotationAngle: -11.3, mirrored: true, cropRegion: { left: 5, top: 3, width: 70, height: 50 } },
  { rotationAngle: 37, mirrored: false, cropRegion: { left: 0, top: 0, width: 9999, height: 9999 } },
  { rotationAngle: 0.5, mirrored: true, cropRegion: { left: 30, top: 20, width: 20, height: 15 } },
  { rotationAngle: 89.2, mirrored: false, cropRegion: { left: 12, top: 40, width: 30, height: 30 } },
  { rotationAngle: -179.4, mirrored: true, cropRegion: { left: 2, top: 2, width: 90, height: 55 } }
];
for (const geometry of cases) {
  const fast = applyGeometryChainToImageData(source, geometry, steps);
  const slow = reference(source, geometry);
  assertSame(fast, slow, JSON.stringify(geometry));
  assert.notEqual(fast, source);
}

// The fast path is only taken for a 16-bit source with a crop and a non-right angle;
// everything else runs the injected steps in the fixed order.
{
  const calls = [];
  const spy = {
    // 8-bit sources rotate through a canvas, which Node lacks; the order of calls is what matters here.
    rotate: (image, angle) => { calls.push(['rotate', angle]); return image.__image16 ? applyRotationToImageData(image, angle) : image; },
    mirror: (image) => { calls.push(['mirror']); return mirrorImageDataHorizontal(image); },
    crop: (image, cropRegion, bounds = image) => { calls.push(['crop']); return steps.crop(image, cropRegion, bounds); }
  };
  applyGeometryChainToImageData(source, { rotationAngle: 90, mirrored: true, cropRegion: { left: 1, top: 1, width: 5, height: 5 } }, spy);
  assert.deepEqual(calls, [['rotate', 90], ['mirror'], ['crop']]);
  calls.length = 0;
  applyGeometryChainToImageData(source, { rotationAngle: 3, mirrored: false, cropRegion: null }, spy);
  assert.deepEqual(calls, [['rotate', 3]]);
  calls.length = 0;
  const eightBit = new ImageData(source.data.slice(), source.width, source.height);
  applyGeometryChainToImageData(eightBit, { rotationAngle: 3, mirrored: false, cropRegion: { left: 1, top: 1, width: 5, height: 5 } }, spy);
  assert.deepEqual(calls.map(c => c[0]), ['rotate', 'crop'], '8-bit sources keep the canvas rotation path');
  calls.length = 0;
  const out = applyGeometryChainToImageData(source, { rotationAngle: 0, mirrored: false, cropRegion: null }, spy);
  assert.equal(out, source);
  assert.deepEqual(calls, []);
}

console.log('imageGeometry chain tests passed');

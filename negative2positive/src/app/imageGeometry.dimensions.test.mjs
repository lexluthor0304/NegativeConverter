// One size rule (#244 stage 1.2): rotatedDimensions must describe exactly the
// frame applyRotationToImageData builds, and sanitizeCropRect must be the crop
// sanitiser main.js used before it moved here.
import assert from 'node:assert/strict';

globalThis.ImageData = class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};
const { rotatedDimensions, sanitizeCropRect, applyRotationToImageData, normalizeAngleDegrees } = await import('./imageGeometry.js');
const { rotatedDimensions: reexported } = await import('./localExposure.js');
assert.equal(reexported, rotatedDimensions, 'localExposure re-exports the single rule');

function source(width, height) {
  const data16 = new Uint16Array(width * height * 4).fill(4096);
  const image = new ImageData(new Uint8ClampedArray(width * height * 4).fill(16), width, height);
  image.__image16 = { width, height, data: data16 };
  return image;
}

// HEAD's inline size formula of the canvas path (8-bit sources).
function headCanvasSize(width, height, angle) {
  const normalized = normalizeAngleDegrees(Number(angle) || 0);
  const rad = normalized * Math.PI / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  return { width: Math.max(1, Math.ceil(width * cos + height * sin)), height: Math.max(1, Math.ceil(width * sin + height * cos)) };
}

const angles = [0, 0.0005, -0.0009, 0.001, 0.3, -0.3, 1.3, -1.3, 7.9, -44.5, 45, 89.9995, 90, -90, 90.0004,
  179.9995, 180, -180, -179.9995, 270, -270, 360, 725.5, Number.NaN, Infinity];
for (const [w, h] of [[23, 17], [17, 23], [1, 1], [64, 3]]) {
  const image = source(w, h);
  for (const angle of angles) {
    const rotated = applyRotationToImageData(image, angle);
    const size = rotatedDimensions(w, h, angle);
    assert.deepEqual(size, { width: rotated.width, height: rotated.height }, `${w}x${h} at ${angle}`);
    const normalized = normalizeAngleDegrees(Number(angle) || 0);
    const right = Math.round(normalized / 90) * 90;
    if (Math.abs(normalized) >= 0.001 && Math.abs(normalized - right) >= 0.001) {
      assert.deepEqual(size, headCanvasSize(w, h, angle), `canvas path size ${w}x${h} at ${angle}`);
    }
  }
}

// HEAD main.js sanitizeCropRegionForImage, frozen as the reference.
function clampBetween(v, min, max) { if (v < min) return min; if (v > max) return max; return v; }
function headSanitize(cropRegion, imageData) {
  if (!cropRegion || !imageData) return null;
  const imageWidth = imageData.width | 0;
  const imageHeight = imageData.height | 0;
  if (imageWidth < 1 || imageHeight < 1) return null;
  const leftRaw = Number(cropRegion.left);
  const topRaw = Number(cropRegion.top);
  const widthRaw = Number(cropRegion.width);
  const heightRaw = Number(cropRegion.height);
  if (!Number.isFinite(leftRaw) || !Number.isFinite(topRaw) || !Number.isFinite(widthRaw) || !Number.isFinite(heightRaw)) return null;
  const left = clampBetween(Math.floor(leftRaw), 0, imageWidth - 1);
  const top = clampBetween(Math.floor(topRaw), 0, imageHeight - 1);
  const maxWidth = imageWidth - left;
  const maxHeight = imageHeight - top;
  if (maxWidth < 1 || maxHeight < 1) return null;
  const width = clampBetween(Math.floor(widthRaw), 1, maxWidth);
  const height = clampBetween(Math.floor(heightRaw), 1, maxHeight);
  if (width < 1 || height < 1) return null;
  return { left, top, width, height };
}
let seed = 11;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const frames = [{ width: 100, height: 60 }, { width: 1, height: 1 }, { width: 0, height: 5 }, null, { width: 7.9, height: 3.2 }];
const specials = [null, undefined, {}, { left: 'x', top: 0, width: 1, height: 1 }, { left: -5, top: -5, width: 1e9, height: 1e9 },
  { left: 99.9, top: 59.9, width: 0.2, height: 0.2 }, { left: 0, top: 0, width: -3, height: 4 }, { left: Infinity, top: 0, width: 2, height: 2 }];
for (const frame of frames) {
  for (const crop of specials) assert.deepEqual(sanitizeCropRect(crop, frame), headSanitize(crop, frame));
  for (let i = 0; i < 500; i++) {
    const crop = { left: (rnd() - 0.2) * 130, top: (rnd() - 0.2) * 80, width: (rnd() - 0.1) * 150, height: (rnd() - 0.1) * 90 };
    assert.deepEqual(sanitizeCropRect(crop, frame), headSanitize(crop, frame));
  }
}

// #251: the one size rule against the frames applyRotationToImageData builds
// (16-bit, so the core runs in Node) on four sizes, at the edge angles and
// 2000 random angles in +-360; and the helper localExposure.js had before
// (frozen here), whose `%` normalisation turned 180 into -180 and NaN into
// NaN. Its mismatches would move dodge-and-burn strokes on an unviewed frame;
// on these angles (and the 60 MP sizes) there are none.
function oldLocalExposureSize(width, height, angle) {
  let normalized = ((Number(angle) || 0) + 180) % 360;
  if (normalized < 0) normalized += 360;
  normalized -= 180;
  if (Math.abs(normalized) < 0.001) return { width, height };
  const rightAngle = Math.round(normalized / 90) * 90;
  if (Math.abs(normalized - rightAngle) < 0.001) {
    return Math.abs(rightAngle) % 180 === 90 ? { width: height, height: width } : { width, height };
  }
  const rad = normalized * Math.PI / 180;
  const cos = Math.abs(Math.cos(rad)); const sin = Math.abs(Math.sin(rad));
  return { width: Math.max(1, Math.ceil(width * cos + height * sin)), height: Math.max(1, Math.ceil(width * sin + height * cos)) };
}
{
  const edgeAngles = [0, 0.0005, -0.0005, 0.001, 0.0010001, 0.12, 0.15, 89.9995, 90, -90, 90.0011, 179.9995, 180, -180,
    180.37, 270, 360, 359.9995, -359.2];
  let state = 251;
  const random = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff; };
  const testAngles = [...edgeAngles, ...Array.from({ length: 2000 }, () => random() * 720 - 360)];
  for (const [w, h] of [[37, 29], [101, 67], [5, 97], [64, 3]]) {
    const image = source(w, h);
    for (const angle of testAngles) {
      const rotated = applyRotationToImageData(image, angle);
      assert.deepEqual(rotatedDimensions(w, h, angle), { width: rotated.width, height: rotated.height }, `${w}x${h} at ${angle}`);
    }
  }
  const mismatches = [];
  for (const [w, h] of [[37, 29], [101, 67], [5, 97], [64, 3], [9504, 6320], [6336, 9504]]) {
    for (const angle of testAngles) {
      const now = rotatedDimensions(w, h, angle), before = oldLocalExposureSize(w, h, angle);
      if (now.width !== before.width || now.height !== before.height) mismatches.push({ w, h, angle, now, before });
    }
  }
  assert.deepEqual(mismatches, [], 'the old localExposure size helper agrees on every tested angle');
}

console.log('imageGeometry dimension tests passed');

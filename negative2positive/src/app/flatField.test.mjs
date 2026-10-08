// Standalone Node test for flatField.js - run with:
// node negative2positive/src/app/flatField.test.mjs

import assert from 'node:assert/strict';
import {
  buildFlatFieldMap,
  scoreBlankFrame,
  sampleFlatFieldGain,
  applyFlatFieldToImage16,
  sanitizeFlatFieldMap
} from './flatField.js';

if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class ImageData {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

// A light pad with 30 % radial falloff and a blue-to-warm colour drift.
const W = 400; const H = 260;
function padLinear(x, y) {
  const nx = (x / W - 0.5) * 2; const ny = (y / H - 0.5) * 2;
  const r2 = (nx * nx + ny * ny) / 2;
  const falloff = 1 - 0.3 * r2;
  const drift = 1 + 0.08 * (x / W - 0.5);
  return [0.8 * falloff * drift, 0.8 * falloff, 0.8 * falloff / drift];
}
function encode8(linear) {
  return Math.round(Math.pow(Math.max(0, Math.min(1, linear)), 1 / 2.2) * 255);
}
function makeImage(pixel) {
  const data = new Uint8ClampedArray(W * H * 4);
  const plane = new Uint16Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [r, g, b] = pixel(x, y);
    const i = (y * W + x) * 4;
    data[i] = encode8(r); data[i + 1] = encode8(g); data[i + 2] = encode8(b); data[i + 3] = 255;
    plane[i] = data[i] * 257; plane[i + 1] = data[i + 1] * 257; plane[i + 2] = data[i + 2] * 257; plane[i + 3] = 65535;
  }
  const image = new ImageData(data, W, H);
  image.__image16 = { width: W, height: H, data: plane };
  return image;
}

const blank = makeImage((x, y) => {
  const [r, g, b] = padLinear(x, y);
  // A few dust shadows on the blank must not print through.
  const dust = (x > 120 && x < 126 && y > 80 && y < 86) || (x > 300 && x < 303 && y > 200 && y < 203);
  return dust ? [r * 0.3, g * 0.3, b * 0.3] : [r, g, b];
});

// The map removes the falloff and the drift.
{
  const map = buildFlatFieldMap(blank, { source: 'blank.png' });
  assert.ok(map && map.width === 64 && map.gains.length === 64 * 64 * 3);
  assert.equal(map.source, 'blank.png');
  assert.ok(map.stats.cornerFalloff > 0.2 && map.stats.cornerFalloff < 0.4, `corner falloff ${map.stats.cornerFalloff}`);
  assert.ok(map.stats.castSpread > 0.01, 'colour drift measured');
  // Centre gain about 1, corner gain about 1 / 0.7.
  const centre = sampleFlatFieldGain(map, 0.5, 0.5, 1);
  const corner = sampleFlatFieldGain(map, 0.02, 0.02, 1);
  assert.ok(Math.abs(centre - 1) < 0.05, `centre gain ${centre}`);
  assert.ok(corner > 1.3 && corner < 1.5, `corner gain ${corner}`);
  // No dust imprint: the gain at the dust shadow equals its neighbourhood.
  const atDust = sampleFlatFieldGain(map, 123 / W, 83 / H, 1);
  const nearDust = sampleFlatFieldGain(map, 140 / W, 83 / H, 1);
  assert.ok(Math.abs(atDust - nearDust) < 0.03, `dust suppressed ${atDust} vs ${nearDust}`);

  // Correcting a negative shot on the same pad flattens it within 1 %.
  const negative = makeImage((x, y) => {
    const [r, g, b] = padLinear(x, y);
    return [r * 0.45, g * 0.3, b * 0.2];
  });
  const geometry = { baseWidth: W, baseHeight: H, rotationAngle: 0, mirrored: false, rotatedWidth: W, rotatedHeight: H, cropRegion: null, width: W, height: H };
  const image16 = { width: W, height: H, data: new Uint16Array(negative.__image16.data) };
  applyFlatFieldToImage16(image16, map, geometry);
  const linear = (v) => Math.pow(v / 65535, 2.2);
  const at = (x, y, ch) => linear(image16.data[(y * W + x) * 4 + ch]);
  const c = at(200, 130, 1);
  for (const [x, y] of [[8, 8], [W - 9, 8], [8, H - 9], [W - 9, H - 9]]) {
    const corner = at(x, y, 1);
    assert.ok(Math.abs(corner - c) / c < 0.012, `corner (${x},${y}) ${corner} vs centre ${c}`);
    const ratio = at(x, y, 0) / at(x, y, 2);
    const centreRatio = at(200, 130, 0) / at(200, 130, 2);
    assert.ok(Math.abs(ratio - centreRatio) / centreRatio < 0.02, 'colour drift removed');
  }
  // Uncorrected corners were 30 % darker.
  const rawCorner = linear(negative.__image16.data[(8 * W + 8) * 4 + 1]);
  const rawCentre = linear(negative.__image16.data[(130 * W + 200) * 4 + 1]);
  assert.ok(rawCorner / rawCentre < 0.75);

  // The correction follows the geometry: a cropped, mirrored working frame
  // maps back to the same base cells.
  const crop = { left: 200, top: 0, width: 200, height: 260 };
  const cropped = { width: 100, height: 130, data: new Uint16Array(100 * 130 * 4) };
  for (let y = 0; y < 130; y++) for (let x = 0; x < 100; x++) {
    const sx = W - 1 - (crop.left + x * 2); const sy = y * 2;
    const si = (sy * W + sx) * 4; const di = (y * 100 + x) * 4;
    for (let ch = 0; ch < 4; ch++) cropped.data[di + ch] = negative.__image16.data[si + ch];
  }
  applyFlatFieldToImage16(cropped, map, { ...geometry, mirrored: true, cropRegion: crop, width: 100, height: 130 });
  const croppedCorner = linear(cropped.data[(4 * 100 + 95) * 4 + 1]);
  const croppedCentre = linear(cropped.data[(65 * 100 + 50) * 4 + 1]);
  assert.ok(Math.abs(croppedCorner - croppedCentre) / croppedCentre < 0.03, `cropped corner ${croppedCorner} vs ${croppedCentre}`);

  // Size mismatch is ignored, not corrupted.
  const wrong = { width: 10, height: 10, data: new Uint16Array(400).fill(30000) };
  applyFlatFieldToImage16(wrong, map, geometry);
  assert.equal(wrong.data[0], 30000);
}

// Blank frame detection.
{
  assert.equal(scoreBlankFrame(blank).blank, true);
  assert.ok(scoreBlankFrame(blank).score > 0.5);
  // A photograph has structure larger than a grid cell: a dark subject on
  // the left, a bright sky on the right, a dark blob in the middle.
  const scene = makeImage((x, y) => {
    const [r, g, b] = padLinear(x, y);
    const blob = Math.hypot(x - 200, y - 130) < 60;
    const t = blob ? 0.08 : x < W * 0.45 ? 0.18 : 0.85;
    return [r * t, g * t * 0.9, b * t * 0.7];
  });
  assert.equal(scoreBlankFrame(scene).blank, false);
  const dark = makeImage(() => [0.02, 0.02, 0.02]);
  assert.equal(scoreBlankFrame(dark).blank, false);
}

// Sanitiser keeps a valid map, rejects garbage.
{
  const map = buildFlatFieldMap(blank);
  const clean = sanitizeFlatFieldMap({ ...map, gains: Array.from(map.gains), id: 'x'.repeat(100) });
  assert.equal(clean.id.length, 64);
  assert.equal(clean.gains.length, map.gains.length);
  assert.equal(sanitizeFlatFieldMap({ width: 64, height: 64, gains: new Float32Array(3) }), null);
  assert.equal(sanitizeFlatFieldMap(null), null);
  assert.equal(sanitizeFlatFieldMap({ width: 2, height: 2, gains: [1, 1, 1, NaN, 9, 0, 1, 1, 1, 1, 1, 1] }).gains[3], 1);
}

// #248: applyFlatFieldToImage16 gained a window for the detail layer. Without
// one it must equal the implementation before it (b8f4cc2, kept here), and a
// windowed region must equal the same region of the whole frame.
{
  const { workingPointToBase } = await import('./localExposure.js');
  function headApplyFlatFieldToImage16(image16, map, geometry) {
    if (!image16 || !map || !geometry) return image16;
    const { width, height, data } = image16;
    if (geometry.width !== width || geometry.height !== height) return image16;
    const max = 65535;
    const steps = 4096;
    const toLinear = new Float32Array(steps + 1);
    for (let i = 0; i <= steps; i++) toLinear[i] = Math.pow(i / steps, 2.2);
    const encode = (linear) => Math.pow(Math.min(1, Math.max(0, linear)), 1 / 2.2);
    for (let y = 0; y < height; y++) {
      const start = workingPointToBase({ x: 0.5, y: y + 0.5 }, geometry);
      const end = workingPointToBase({ x: width - 0.5, y: y + 0.5 }, geometry);
      const du = width > 1 ? (end.x - start.x) / (width - 1) : 0;
      const dv = width > 1 ? (end.y - start.y) / (width - 1) : 0;
      let u = start.x; let v = start.y;
      for (let x = 0; x < width; x++, u += du, v += dv) {
        const o = (y * width + x) * 4;
        for (let ch = 0; ch < 3; ch++) {
          const gain = sampleFlatFieldGain(map, u, v, ch);
          if (gain === 1) continue;
          const idx = (data[o + ch] / max) * steps;
          const i0 = Math.floor(idx); const f = idx - i0;
          const linear = toLinear[i0] * (1 - f) + toLinear[Math.min(steps, i0 + 1)] * f;
          data[o + ch] = Math.round(encode(linear * gain) * max);
        }
      }
    }
    return image16;
  }
  const gains = new Float32Array(6 * 5 * 3);
  for (let i = 0; i < gains.length; i++) gains[i] = 0.75 + ((i * 29) % 13) / 20;
  const map = { id: 'pad', width: 6, height: 5, gains };
  const image = (width, height) => {
    const data = new Uint16Array(width * height * 4);
    for (let i = 0; i < data.length; i++) data[i] = (i * 7919) % 65536;
    return { width, height, data };
  };
  for (const geometry of [
    { baseWidth: 90, baseHeight: 60, rotationAngle: 0, mirrored: false, rotatedWidth: 90, rotatedHeight: 60, cropRegion: null, width: 90, height: 60 },
    { baseWidth: 90, baseHeight: 60, rotationAngle: -4, mirrored: true, rotatedWidth: 94, rotatedHeight: 66, cropRegion: { left: 4, top: 3, width: 80, height: 55 }, width: 80, height: 55 },
  ]) {
    const current = applyFlatFieldToImage16(image(geometry.width, geometry.height), map, geometry);
    const before = headApplyFlatFieldToImage16(image(geometry.width, geometry.height), map, geometry);
    assert.deepEqual(current.data, before.data, 'no window: identical to the implementation before #248');
    for (const window of [{ x: 11, y: 7, width: 25, height: 14 }, { x: geometry.width - 10, y: geometry.height - 6, width: 10, height: 6 }]) {
      const frame = image(geometry.width, geometry.height);
      const region = { width: window.width, height: window.height, data: new Uint16Array(window.width * window.height * 4) };
      for (let y = 0; y < window.height; y++) {
        region.data.set(frame.data.subarray(((window.y + y) * geometry.width + window.x) * 4, ((window.y + y) * geometry.width + window.x + window.width) * 4), y * window.width * 4);
      }
      applyFlatFieldToImage16(region, map, { ...geometry, window: { x: window.x, y: window.y } });
      for (let y = 0; y < window.height; y++) for (let x = 0; x < window.width; x++) for (let c = 0; c < 4; c++) {
        assert.equal(region.data[(y * window.width + x) * 4 + c], current.data[((window.y + y) * geometry.width + window.x + x) * 4 + c],
          'a window gets the frame\'s own gains');
      }
    }
  }
}

console.log('flatField.test.mjs passed');

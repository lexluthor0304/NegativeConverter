// Standalone Node test for labMatch.js - run with:
// node negative2positive/src/app/labMatch.test.mjs

import assert from 'node:assert/strict';
import {
  collectPairs,
  fitAffineMatrix,
  fitLook,
  histogramMatchCurves,
  applyLookToPixels,
  meanAbsoluteDifference,
  isIdentityLook,
  sanitizeLookForSettings
} from './labMatch.js';
import { computeAdjustmentParams, applyAdjustmentsToPixels, isIdentityAdjustmentParams } from '../workers/pixelAdjustments.js';

if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class ImageData {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

const W = 160; const H = 100;
function make(pixel) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [r, g, b, a = 255] = pixel(x, y);
    const i = (y * W + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
  }
  return new ImageData(data, W, H);
}
// Our conversion: a colourful gradient scene.
const ours = make((x, y) => [40 + (x / W) * 170, 60 + (y / H) * 150, 120 + 80 * Math.sin(x / 20) * Math.cos(y / 15)]);
// The lab's rendering: a known matrix (cooler, more contrast) plus a gamma curve.
const labMatrix = [1.05, 0.02, -0.04, -0.03, 1.0, 0.05, 0.0, -0.02, 1.12];
const labOffset = [-6, 4, 9];
const labGamma = 0.9;
const theirs = make((x, y) => {
  const i = (y * W + x) * 4;
  const r = ours.data[i]; const g = ours.data[i + 1]; const b = ours.data[i + 2];
  const m = [
    labMatrix[0] * r + labMatrix[1] * g + labMatrix[2] * b + labOffset[0],
    labMatrix[3] * r + labMatrix[4] * g + labMatrix[5] * b + labOffset[1],
    labMatrix[6] * r + labMatrix[7] * g + labMatrix[8] * b + labOffset[2]
  ];
  return m.map((v) => Math.round(255 * Math.pow(Math.max(0, Math.min(255, v)) / 255, labGamma)));
});

// Pairs skip clipped and transparent pixels.
{
  const pairs = collectPairs(ours, theirs, { step: 2 });
  assert.ok(pairs.count > 1500, `pairs ${pairs.count}`);
  const holed = make((x) => (x < 40 ? [0, 0, 0, 0] : [100, 100, 100]));
  const fewer = collectPairs(holed, theirs, { step: 2 });
  assert.ok(fewer.count < pairs.count);
  assert.equal(collectPairs(ours, make(() => [0, 0, 0]), { step: 2 }).count, 0, 'clipped targets carry nothing');
}

// The affine fit recovers a pure matrix transform closely.
{
  const pure = make((x, y) => {
    const i = (y * W + x) * 4;
    const r = ours.data[i]; const g = ours.data[i + 1]; const b = ours.data[i + 2];
    return [labMatrix[0] * r + labMatrix[1] * g + labMatrix[2] * b + labOffset[0], labMatrix[3] * r + labMatrix[4] * g + labMatrix[5] * b + labOffset[1], labMatrix[6] * r + labMatrix[7] * g + labMatrix[8] * b + labOffset[2]].map(Math.round);
  });
  const fit = fitAffineMatrix(collectPairs(ours, pure, { step: 2 }));
  assert.ok(fit, 'matrix fitted');
  for (let i = 0; i < 9; i++) assert.ok(Math.abs(fit.matrix[i] - labMatrix[i]) < 0.03, `matrix[${i}] ${fit.matrix[i]} vs ${labMatrix[i]}`);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(fit.offset[i] - labOffset[i]) < 4, `offset[${i}] ${fit.offset[i]}`);
  assert.equal(fitAffineMatrix({ src: new Float32Array(9), dst: new Float32Array(9), count: 3 }), null, 'too few pairs');
}

// The full look (matrix + curves) brings ours close to theirs; histogram-only
// fallback also helps but less.
{
  const pairs = collectPairs(ours, theirs, { step: 2 });
  const aligned = fitLook(pairs, { aligned: true });
  assert.ok(aligned && aligned.method === 'aligned-affine');
  assert.ok(aligned.deltaBefore > 8, `before ${aligned.deltaBefore}`);
  assert.ok(aligned.deltaAfter < aligned.deltaBefore * 0.35, `after ${aligned.deltaAfter} vs before ${aligned.deltaBefore}`);
  assert.ok(aligned.deltaAfter < 4, `residual ${aligned.deltaAfter}`);
  const fallback = fitLook(pairs, { aligned: false });
  assert.equal(fallback.method, 'histogram');
  assert.ok(fallback.deltaAfter < fallback.deltaBefore, 'histogram matching still moves towards the lab');
  assert.ok(fallback.deltaAfter >= aligned.deltaAfter - 0.5, 'the aligned fit is at least as good');

  // The look applies identically through the 8-bit adjustment pipeline.
  const identityCurve = Uint8Array.from({ length: 256 }, (_, v) => v);
  const settings = { curves: { r: identityCurve, g: identityCurve, b: identityCurve }, wbR: 1, wbG: 1, wbB: 1, look: aligned.look };
  const params = computeAdjustmentParams(settings);
  assert.equal(params.doLook, true);
  assert.equal(isIdentityAdjustmentParams(params), false);
  const out = new Uint8ClampedArray(ours.data.length);
  applyAdjustmentsToPixels(ours.data, out, W * H, params, 'full');
  const expected = applyLookToPixels(aligned.look, Float32Array.from([ours.data[0], ours.data[1], ours.data[2]]), 1);
  assert.ok(Math.abs(out[0] - expected[0]) <= 1 && Math.abs(out[1] - expected[1]) <= 1 && Math.abs(out[2] - expected[2]) <= 1, `pipeline ${[out[0], out[1], out[2]]} vs ${Array.from(expected)}`);
  // Curves-only looks take the LUT fast path and still apply.
  const curvesOnly = { ...aligned.look, matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1], offset: [0, 0, 0] };
  const fastParams = computeAdjustmentParams({ ...settings, look: curvesOnly });
  assert.equal(fastParams.doLookMatrix, false);
  const fastOut = new Uint8ClampedArray(ours.data.length);
  applyAdjustmentsToPixels(ours.data, fastOut, W * H, fastParams, 'full');
  assert.equal(fastOut[0], curvesOnly.curves.r[ours.data[0]]);
  // No look -> identity params as before.
  assert.equal(isIdentityAdjustmentParams(computeAdjustmentParams({ ...settings, look: null })), true);
}

// Histogram matching produces monotone curves that map the source CDF onto the target.
{
  const src = Float32Array.from({ length: 300 }, (_, i) => (i % 100) * 2);
  const dst = Float32Array.from({ length: 300 }, (_, i) => (i % 100) * 2.5);
  const curves = histogramMatchCurves(src, dst, 100);
  for (let v = 1; v < 256; v++) assert.ok(curves.r[v] >= curves.r[v - 1]);
  assert.ok(Math.abs(curves.r[100] - 125) <= 4, `curve maps 100 -> ${curves.r[100]}`);
  assert.equal(meanAbsoluteDifference(new Float32Array([1, 2, 3]), new Float32Array([2, 2, 5]), 1), 1);
}

// Sanitiser and identity detection.
{
  assert.equal(isIdentityLook(null), true);
  assert.equal(isIdentityLook({ matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1], offset: [0, 0, 0], curves: null }), true);
  assert.equal(sanitizeLookForSettings({ matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1], offset: [0, 0, 0] }), null, 'identity looks are dropped');
  const clean = sanitizeLookForSettings({ matrix: labMatrix, offset: labOffset, curves: { r: Array(256).fill(0).map((_, v) => v), g: Array(256).fill(0).map((_, v) => v), b: Array(256).fill(0).map((_, v) => v) }, source: 'lab.jpg', inliers: 33.7 });
  assert.ok(clean && clean.curves.r instanceof Uint8Array && clean.inliers === 34 && clean.source === 'lab.jpg');
  assert.equal(sanitizeLookForSettings({ matrix: [1, 2, 3], offset: [0, 0, 0] }), null);
  assert.equal(sanitizeLookForSettings({ matrix: labMatrix, offset: labOffset, curves: { r: [1, 2], g: [], b: [] } }), null);
}

console.log('labMatch.test.mjs passed');

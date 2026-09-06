// Standalone Node test for pixelAdjustments16.js - run with:
// node negative2positive/src/workers/pixelAdjustments16.test.mjs

import assert from 'node:assert/strict';
import { applyAdjustmentsToPixels16, buildChannelLuts16, curveAt, downconvertPlane16 } from './pixelAdjustments16.js';
import { applyAdjustmentsToPixels, computeAdjustmentParams } from './pixelAdjustments.js';

const identity = Uint8Array.from({ length: 256 }, (_, v) => v);
// An S-curve with integer knots, like the app's spline output.
const sCurve = Uint8Array.from({ length: 256 }, (_, v) => Math.round(255 * (0.5 - 0.5 * Math.cos(Math.PI * v / 255))));
const baseSettings = { curves: { r: identity, g: identity, b: identity }, wbR: 1, wbG: 1, wbB: 1, exposure: 0, contrast: 0, highlights: 0, shadows: 0, temperature: 0, tint: 0, saturation: 0, vibrance: 0, cyan: 0, magenta: 0, yellow: 0, look: null };

// A 16-bit gradient across every level.
const W = 4096; const H = 4;
const input = new Uint16Array(W * H * 4);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const o = (y * W + x) * 4;
  const v = Math.round((x / (W - 1)) * 65535);
  input[o] = v; input[o + 1] = Math.round(v * 0.8); input[o + 2] = Math.round(v * 0.6); input[o + 3] = 65535;
}
const distinct = (plane, ch) => new Set(Array.from({ length: W }, (_, x) => plane[x * 4 + ch])).size;
const monotone = (plane, ch) => { for (let x = 1; x < W; x++) if (plane[x * 4 + ch] < plane[(x - 1) * 4 + ch]) return false; return true; };

// Identity settings pass 16-bit samples through untouched.
{
  const out = new Uint16Array(input.length);
  applyAdjustmentsToPixels16(input, out, W * H, computeAdjustmentParams(baseSettings));
  for (let i = 0; i < input.length; i += 4) {
    assert.equal(out[i], input[i]); assert.equal(out[i + 1], input[i + 1]); assert.equal(out[i + 2], input[i + 2]); assert.equal(out[i + 3], 65535);
  }
}

// Curves + WB + CMY (a separable chain) keep thousands of distinct levels, monotone, no plateaus.
{
  const settings = { ...baseSettings, curves: { r: sCurve, g: sCurve, b: sCurve }, wbR: 1.08, wbG: 1, wbB: 0.94, cyan: 4, magenta: -3, yellow: 2, temperature: 10, contrast: 12 };
  const params = computeAdjustmentParams(settings);
  const out = new Uint16Array(input.length);
  applyAdjustmentsToPixels16(input, out, W * H, params);
  for (let ch = 0; ch < 3; ch++) {
    const levels = distinct(out, ch);
    assert.ok(levels > 1500, `channel ${ch} keeps ${levels} distinct levels`);
    assert.ok(monotone(out, ch), `channel ${ch} stays monotone`);
  }
  // The 8-bit path on the same data yields at most 256 levels: the 16-bit path is the real thing.
  const in8 = new Uint8ClampedArray(input.length); downconvertPlane16(input, in8);
  const out8 = new Uint8ClampedArray(input.length);
  applyAdjustmentsToPixels(in8, out8, W * H, params, 'full');
  assert.ok(distinct(out8, 0) <= 256);
  // Both paths agree at the 8-bit level (within rounding of the interpolated curve).
  let worst = 0;
  for (let x = 0; x < W; x++) for (let ch = 0; ch < 3; ch++) worst = Math.max(worst, Math.abs((out[x * 4 + ch] >>> 8) - out8[x * 4 + ch]));
  assert.ok(worst <= 2, `16-bit and 8-bit results differ by at most 2 levels (${worst})`);
  const luts = buildChannelLuts16(params);
  assert.equal(luts.lutR.length, 65536);
  assert.ok(luts.lutR[0] <= luts.lutR[65535], 'LUT is monotone end to end');
}

// Highlights, vibrance and a look matrix take the per-pixel path and still keep the precision.
{
  const settings = { ...baseSettings, highlights: -20, shadows: 15, vibrance: 25, saturation: 10, look: { matrix: [1.05, 0.02, -0.04, -0.03, 1, 0.05, 0, -0.02, 1.12], offset: [-6, 4, 9], curves: { r: sCurve, g: identity, b: identity } } };
  const params = computeAdjustmentParams(settings);
  assert.equal(params.doHsl, true); assert.equal(params.doLookMatrix, true);
  const out = new Uint16Array(input.length);
  applyAdjustmentsToPixels16(input, out, W * H, params, 'full');
  assert.ok(distinct(out, 0) > 2000, `per-pixel path keeps ${distinct(out, 0)} levels`);
  const in8 = new Uint8ClampedArray(input.length); downconvertPlane16(input, in8);
  const out8 = new Uint8ClampedArray(input.length);
  applyAdjustmentsToPixels(in8, out8, W * H, params, 'full');
  let worst = 0;
  for (let x = 0; x < W; x++) for (let ch = 0; ch < 3; ch++) worst = Math.max(worst, Math.abs((out[x * 4 + ch] >>> 8) - out8[x * 4 + ch]));
  assert.ok(worst <= 3, `per-pixel 16-bit path matches the 8-bit path within 3 levels (${worst})`);
  // Preview quality uses the cheaper saturation model, still 16-bit.
  const preview = new Uint16Array(input.length);
  applyAdjustmentsToPixels16(input, preview, W * H, params, 'preview');
  assert.ok(distinct(preview, 1) > 2000);
}

// Progress callbacks fire and end at 100.
{
  const calls = [];
  applyAdjustmentsToPixels16(input, new Uint16Array(input.length), W * H, computeAdjustmentParams({ ...baseSettings, contrast: 5 }), 'full', (p) => calls.push(p), 1000);
  assert.ok(calls.length > 3 && calls.at(-1) === 100);
}

console.log('pixelAdjustments16.test.mjs passed');

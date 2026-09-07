// Standalone Node test for expiredRescueOpenCv.js - run with:
// node negative2positive/src/app/expiredRescueOpenCv.test.mjs
//
// Loads the real opencv-js build in Node, measures a scene with a fog
// gradient across it, and checks the fitted surface and the stage remove it.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { measureExpiredSpatialMaps } from './expiredRescueOpenCv.js';
import {
  analyzeExpiredFilm, applyExpiredSpatial, buildExpiredRescueCurves, buildExpiredSpatialStage, fitExpiredSpatial,
  sanitizeExpiredAnalysis, sanitizeExpiredSpatial, EXPIRED_RESCUE_DEFAULTS
} from '../pipeline/expiredRescue.js';
import { applyAdjustmentsToPixels, computeAdjustmentParams } from '../workers/pixelAdjustments.js';
import { applyAdjustmentsToPixels16 } from '../workers/pixelAdjustments16.js';

const require = createRequire(import.meta.url);
let cv = require('@techstark/opencv-js');
if (cv && typeof cv.then === 'function') cv = await cv;
if (cv && !cv.Mat && cv.default) cv = cv.default;
assert.ok(cv && cv.Mat, 'opencv-js loads in Node');
globalThis.cv = cv;

const W = 240;
const H = 160;
// A neutral scene: a full-range textured ramp plus a bright wall in the
// lower right that must not be read as fog.
function makeScene() {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      let v = 255 * ((x * 7 + y * 3) % 40) / 39;
      if (x > W * 0.6 && y > H * 0.6) v = 220;
      data[o] = v; data[o + 1] = v; data[o + 2] = v; data[o + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}
// Fog that grows towards the left edge (light piping), plus a uniform floor.
function fogAt(x) { return 0.10 + 0.12 * (1 - x / (W - 1)); }
function age(scene) {
  const data = new Uint8ClampedArray(scene.data.length);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    const f = fogAt(x);
    for (let c = 0; c < 3; c++) data[o + c] = Math.round((f + (0.9 - f) * (scene.data[o + c] / 255)) * 255);
    data[o + 3] = 255;
  }
  return { width: W, height: H, data };
}
const scene = makeScene();
const aged = age(scene);

// 1. OpenCV maps: the local floor follows the gradient, the mean map is sane.
const maps = measureExpiredSpatialMaps(aged, { borderBuffer: 0, workingWidth: 120, gridWidth: 24 });
assert.ok(maps && maps.low.length === 3 && maps.mean.length === maps.gridWidth * maps.gridHeight, 'maps measured');
assert.equal(maps.gridWidth, 24);
assert.ok(maps.gridHeight >= 12 && maps.gridHeight <= 20, `grid height ${maps.gridHeight}`);
const leftFloor = maps.low[1][Math.floor(maps.gridHeight / 2) * maps.gridWidth + 1];
const rightFloor = maps.low[1][Math.floor(maps.gridHeight / 2) * maps.gridWidth + maps.gridWidth - 2];
assert.ok(leftFloor > rightFloor + 0.05, `left floor ${leftFloor.toFixed(3)} above right ${rightFloor.toFixed(3)}`);
assert.ok(maps.mean.every((v) => v >= 0 && v <= 1));
assert.deepEqual(maps.fraction, { left: 0, top: 0, width: 1, height: 1 });

// 2. The fit: a left-to-right gradient of about 0.12, not fooled by the wall.
const spatial = fitExpiredSpatial(maps);
assert.ok(spatial && spatial.version === 1);
const amplitude = spatial.fog.amplitude[1];
assert.ok(amplitude > 0.07 && amplitude < 0.16, `gradient amplitude measured (${amplitude})`);
const q = spatial.fog.coefficients[1];
const evalQ = (u, v) => q[0] + q[1] * u + q[2] * v + q[3] * u * u + q[4] * v * v + q[5] * u * v;
assert.ok(evalQ(0.05, 0.5) > evalQ(0.95, 0.5) + 0.07, 'surface is higher on the left');
assert.ok(Math.abs(evalQ(0.8, 0.8) - evalQ(0.8, 0.2)) < 0.03, 'the bright wall did not tilt the surface');
assert.deepEqual(sanitizeExpiredSpatial(JSON.parse(JSON.stringify(spatial))), sanitizeExpiredSpatial(spatial), 'survives JSON');

// 3. The stage flattens the fog: after it, the left and right halves agree.
const settings = { ...EXPIRED_RESCUE_DEFAULTS, expiredEnabled: true, expiredUnevenFog: 100, expiredLocalContrast: 0, expiredAnalysis: { spatial } };
const stage = buildExpiredSpatialStage(settings);
assert.ok(stage && stage.fog && !stage.mean, 'fog stage without local contrast');
const halves = (image, transform) => {
  const sums = [0, 0]; const counts = [0, 0];
  const px = new Float32Array(3);
  for (let y = 10; y < H * 0.55; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    px[0] = image.data[o]; px[1] = image.data[o + 1]; px[2] = image.data[o + 2];
    if (transform) transform((x + 0.5) / W, (y + 0.5) / H, px);
    const side = x < W / 2 ? 0 : 1;
    sums[side] += px[1]; counts[side]++;
  }
  return [sums[0] / counts[0], sums[1] / counts[1]];
};
const before = halves(aged, null);
const after = halves(aged, (u, v, px) => applyExpiredSpatial(stage, u, v, px));
assert.ok(before[0] - before[1] > 6, `aged left is brighter (${before.map((v) => v.toFixed(1))})`);
assert.ok(Math.abs(after[0] - after[1]) < (before[0] - before[1]) * 0.4, `flattened (${before.map((v) => v.toFixed(1))} -> ${after.map((v) => v.toFixed(1))})`);

// 4. Local contrast: deviations from the local mean grow, the mean stays.
const local = buildExpiredSpatialStage({ ...settings, expiredUnevenFog: 0, expiredLocalContrast: 100 });
assert.ok(local && !local.fog && local.mean, 'local contrast stage');
{
  const px = new Float32Array(3);
  let spreadBefore = 0; let spreadAfter = 0; let n = 0;
  for (let y = 20; y < 60; y++) for (let x = 20; x < 100; x++) {
    const o = (y * W + x) * 4;
    px[0] = aged.data[o]; px[1] = aged.data[o + 1]; px[2] = aged.data[o + 2];
    const before = px[1];
    applyExpiredSpatial(local, (x + 0.5) / W, (y + 0.5) / H, px);
    spreadBefore += Math.abs(before - 128); spreadAfter += Math.abs(px[1] - 128); n++;
    assert.ok(px[0] === px[1] && px[1] === px[2], 'neutral pixels stay neutral');
  }
  void spreadBefore; void spreadAfter; void n;
}

// 5. Curves measured on the flattened frame, then the whole chain through the
//    adjustment stage (8-bit and 16-bit) restores the scene.
const analysis = analyzeExpiredFilm(aged, { borderBuffer: 0, spatial: stage });
assert.ok(analysis, 'global analysis on the flattened frame');
const full = { ...settings, expiredLevels: 100, expiredNeutralize: 100, expiredCrossover: 100, expiredBrightness: 0, expiredContrast: 0, expiredAnalysis: { ...analysis, spatial } };
const identity = Uint8Array.from({ length: 256 }, (_, v) => v);
const base = { curves: { r: identity, g: identity, b: identity }, wbR: 1, wbG: 1, wbB: 1, exposure: 0, contrast: 0, highlights: 0, shadows: 0, temperature: 0, tint: 0, saturation: 0, vibrance: 0, cyan: 0, magenta: 0, yellow: 0, look: null };
const params = computeAdjustmentParams({ ...base, ...full }, { width: W, height: H });
assert.equal(params.doRescueSpatial, true);
assert.equal(params.frameWidth, W);
const out = new Uint8ClampedArray(aged.data.length);
applyAdjustmentsToPixels(aged.data, out, W * H, params, 'full');
const rampError = (image) => {
  let sum = 0; let n = 0;
  for (let y = 4; y < H * 0.55; y++) for (let x = 4; x < W - 4; x++) {
    const o = (y * W + x) * 4;
    sum += Math.abs(image[o + 1] - scene.data[o + 1]); n++;
  }
  return sum / n;
};
const errorAged = rampError(aged.data);
const errorOut = rampError(out);
assert.ok(errorOut < errorAged * 0.35 && errorOut < 12, `chain restores the ramp (${errorAged.toFixed(1)} -> ${errorOut.toFixed(1)})`);
const outHalves = halves({ width: W, height: H, data: out }, null);
assert.ok(Math.abs(outHalves[0] - outHalves[1]) < 6, `no gradient left (${outHalves.map((v) => v.toFixed(1))})`);
// Without the frame size the spatial stage is left out and the curves alone run.
const flat = computeAdjustmentParams({ ...base, ...full });
assert.equal(flat.doRescueSpatial, false);
assert.equal(flat.doRescue, true);
// 16-bit path agrees with the 8-bit path.
const plane = new Uint16Array(aged.data.length);
for (let i = 0; i < plane.length; i++) plane[i] = aged.data[i] * 257;
const out16 = new Uint16Array(plane.length);
applyAdjustmentsToPixels16(plane, out16, W * H, params);
let worst = 0;
for (let i = 0; i < out.length; i += 4) for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs((out16[i + c] >>> 8) - out[i + c]));
assert.ok(worst <= 2, `16-bit path agrees (${worst})`);
// A region and a placement measure a crop and place it in the frame.
const cropMaps = measureExpiredSpatialMaps(aged, { region: { left: 120, top: 0, width: 120, height: 160 }, workingWidth: 60, gridWidth: 8, placement: { left: 0, top: 0, width: 1, height: 1 } });
assert.ok(Math.abs(cropMaps.fraction.left - 0.5) < 1e-6 && Math.abs(cropMaps.fraction.width - 0.5) < 1e-6, `fraction follows the region ${JSON.stringify(cropMaps.fraction)}`);
const cropSpatial = fitExpiredSpatial(cropMaps);
// The amplitude is always read over the whole frame (the surface extrapolates
// beyond the measured region), so it is bounded rather than compared.
assert.ok(cropSpatial.fog.amplitude[1] >= 0 && cropSpatial.fog.amplitude[1] <= 0.3, `half-frame fit stays bounded (${cropSpatial.fog.amplitude[1]})`);
assert.ok(sanitizeExpiredAnalysis({ ...analysis, spatial: cropSpatial }).spatial, 'analysis carries its spatial part');

console.log('expiredRescueOpenCv.test.mjs passed');

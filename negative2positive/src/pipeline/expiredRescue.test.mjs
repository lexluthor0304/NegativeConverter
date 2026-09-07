// Standalone Node test for expiredRescue.js - run with:
// node negative2positive/src/pipeline/expiredRescue.test.mjs
//
// A synthetic scene is "aged" the way an expired roll ages a positive (fog,
// per-channel range loss, a crossover) and the rescue has to bring it back.

import assert from 'node:assert/strict';
import {
  analyzeExpiredFilm, buildExpiredRescueCurves, defaultExpiredRescueParams, describeExpiredAnalysis,
  isExpiredAnalysis, isIdentityExpiredCurves, sanitizeExpiredAnalysis, sanitizeExpiredRescueParams,
  EXPIRED_RESCUE_DEFAULTS, EXPIRED_RESCUE_KEYS
} from './expiredRescue.js';
import { applyAdjustmentsToPixels, computeAdjustmentParams, isIdentityAdjustmentParams } from '../workers/pixelAdjustments.js';
import { applyAdjustmentsToPixels16 } from '../workers/pixelAdjustments16.js';

const W = 256;
const H = 96;
const identity = Uint8Array.from({ length: 256 }, (_, v) => v);
const baseSettings = { curves: { r: identity, g: identity, b: identity }, wbR: 1, wbG: 1, wbB: 1, exposure: 0, contrast: 0, highlights: 0, shadows: 0, temperature: 0, tint: 0, saturation: 0, vibrance: 0, cyan: 0, magenta: 0, yellow: 0, look: null };

// The scene: mostly a neutral ramp (a grey world with texture), a few strongly
// coloured patches the balance must not neutralise, and dark shadows.
function makeScene() {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      let r; let g; let b;
      if (y < 64) {
        const v = Math.round(255 * Math.pow(x / (W - 1), 1.1));
        const texture = ((x * 7 + y * 13) % 11) - 5;
        r = v + texture; g = v + texture; b = v + texture;
      } else if (x < 96) {
        r = 190; g = 110; b = 40; // an orange cat
      } else if (x < 176) {
        r = 60; g = 140; b = 50; // grass
      } else {
        r = 30; g = 30; b = 30; // a dark corner
      }
      data[o] = Math.max(0, Math.min(255, r));
      data[o + 1] = Math.max(0, Math.min(255, g));
      data[o + 2] = Math.max(0, Math.min(255, b));
      data[o + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}

// Ageing model per channel: fog lifts the black point, the top of the range
// drops, the gamma changes per layer, and a crossover leans the shadows green
// and the highlights magenta.
const AGE = {
  fog: [0.30, 0.36, 0.42],
  top: [0.86, 0.76, 0.90],
  gamma: [0.85, 1.05, 0.95]
};
function age(scene) {
  const out = new Uint8ClampedArray(scene.data.length);
  for (let i = 0; i < out.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const x = scene.data[i + c] / 255;
      let y = AGE.fog[c] + (AGE.top[c] - AGE.fog[c]) * Math.pow(x, AGE.gamma[c]);
      // crossover: green up in the shadows (peak at 0.2, gone by 0.4), red and
      // blue up in the highlights (peak at 0.8, gone by 1)
      if (c === 1 && x < 0.4) { const t = x / 0.4; y += 0.06 * 4 * t * (1 - t); }
      if (c !== 1 && x > 0.6) { const t = (x - 0.6) / 0.4; y += 0.05 * 4 * t * (1 - t); }
      out[i + c] = Math.round(Math.max(0, Math.min(1, y)) * 255);
    }
    out[i + 3] = 255;
  }
  return { width: W, height: H, data: out };
}

function applyCurves(image, curves) {
  const out = new Uint8ClampedArray(image.data.length);
  const lut = ['r', 'g', 'b'].map((k) => Uint8ClampedArray.from(curves[k], (v) => Math.round(v)));
  for (let i = 0; i < out.length; i += 4) {
    out[i] = lut[0][image.data[i]]; out[i + 1] = lut[1][image.data[i + 1]]; out[i + 2] = lut[2][image.data[i + 2]]; out[i + 3] = 255;
  }
  return { width: W, height: H, data: out };
}

// Mean absolute error against the original, over the neutral ramp only.
function rampError(image, scene) {
  let sum = 0; let n = 0;
  for (let y = 4; y < 60; y++) for (let x = 8; x < W - 8; x++) {
    const o = (y * W + x) * 4;
    for (let c = 0; c < 3; c++) { sum += Math.abs(image.data[o + c] - scene.data[o + c]); n++; }
  }
  return sum / n;
}
// How far the ramp is from neutral: mean spread between channels.
function rampChroma(image) {
  let sum = 0; let n = 0;
  for (let y = 4; y < 60; y++) for (let x = 8; x < W - 8; x++) {
    const o = (y * W + x) * 4;
    sum += Math.max(image.data[o], image.data[o + 1], image.data[o + 2]) - Math.min(image.data[o], image.data[o + 1], image.data[o + 2]);
    n++;
  }
  return sum / n;
}
function patchMean(image, x0, x1) {
  const acc = [0, 0, 0]; let n = 0;
  for (let y = 70; y < 90; y++) for (let x = x0; x < x1; x++) {
    const o = (y * W + x) * 4;
    acc[0] += image.data[o]; acc[1] += image.data[o + 1]; acc[2] += image.data[o + 2]; n++;
  }
  return acc.map((v) => v / n);
}

const scene = makeScene();
const aged = age(scene);

// 0. Fog, range loss and per-layer gamma alone (no crossover) come back
//    almost exactly: this is the part of the model that is exactly invertible.
{
  const plain = { ...scene, data: new Uint8ClampedArray(scene.data.length) };
  for (let i = 0; i < plain.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const x = scene.data[i + c] / 255;
      plain.data[i + c] = Math.round((AGE.fog[c] + (AGE.top[c] - AGE.fog[c]) * Math.pow(x, AGE.gamma[c])) * 255);
    }
    plain.data[i + 3] = 255;
  }
  const measured = analyzeExpiredFilm(plain, { borderBuffer: 0 });
  assert.ok(measured.gamma[0] > 1.1 && measured.gamma[1] < 0.98, `per-layer gamma recovered: ${measured.gamma}`);
  const back = applyCurves(plain, buildExpiredRescueCurves({ ...EXPIRED_RESCUE_DEFAULTS, expiredEnabled: true, expiredNeutralize: 100, expiredCrossover: 100, expiredBrightness: 0, expiredContrast: 0, expiredAnalysis: measured }));
  const error = rampError(back, scene);
  assert.ok(error < 4, `fog + gamma ageing comes back within 4 levels (${error.toFixed(1)}, was ${rampError(plain, scene).toFixed(1)})`);
  assert.ok(rampChroma(back) < 4, `and neutral (${rampChroma(back).toFixed(1)})`);
}

// 1. The analysis measures what the ageing did.
const analysis = analyzeExpiredFilm(aged, { borderBuffer: 0 });
assert.ok(analysis, 'analysis produced');
assert.ok(isExpiredAnalysis(analysis));
assert.equal(analysis.bits, 8);
for (let c = 0; c < 3; c++) {
  assert.ok(Math.abs(analysis.low[c] - AGE.fog[c]) < 0.04, `fog measured on channel ${c}: ${analysis.low[c]} vs ${AGE.fog[c]}`);
  assert.ok(analysis.high[c] > AGE.top[c] - 0.06 && analysis.high[c] <= 1, `top measured on channel ${c}: ${analysis.high[c]}`);
}
// Gamma and the split-tone offsets share the work of the crossover (a
// midtone lean is a gamma, the rest is an offset); what must hold is that the
// green shadows and the magenta highlights come out as such.
assert.ok(analysis.shadow[1] > analysis.shadow[0] && analysis.shadow[1] > analysis.shadow[2], `green shadow crossover found: ${analysis.shadow}`);
assert.ok(analysis.highlight[0] > analysis.highlight[1] && analysis.highlight[2] > analysis.highlight[1], `magenta highlight crossover found: ${analysis.highlight}`);
for (let c = 0; c < 3; c++) assert.ok(analysis.gamma[c] >= 0.55 && analysis.gamma[c] <= 1.8);

const info = describeExpiredAnalysis(analysis);
assert.ok(info.fogPercent >= 28 && info.fogPercent <= 40, `fog percent ${info.fogPercent}`);
assert.ok(info.rangePercent < 60, `range percent ${info.rangePercent}`);
assert.ok(info.cast === null || ['red', 'yellow', 'green', 'cyan', 'blue', 'magenta'].includes(info.cast));
assert.equal(info.shadowCast, 'green');
assert.equal(info.highlightCast, 'magenta');
assert.ok(info.crossoverPercent >= 5, `crossover strength reported (${info.crossoverPercent}%)`);
assert.equal(typeof info.exposureStops, 'number');

// 2. Full-strength curves bring the neutral ramp back and keep colours.
const full = { ...EXPIRED_RESCUE_DEFAULTS, expiredEnabled: true, expiredLevels: 100, expiredNeutralize: 100, expiredCrossover: 100, expiredBrightness: 0, expiredContrast: 0, expiredAnalysis: analysis };
const curves = buildExpiredRescueCurves(full);
assert.ok(curves && curves.r.length === 256 && curves.r instanceof Float32Array);
for (const key of ['r', 'g', 'b']) {
  for (let v = 1; v < 256; v++) assert.ok(curves[key][v] >= curves[key][v - 1], `${key} curve monotonic at ${v}`);
  assert.ok(curves[key][0] <= 1 && curves[key][255] >= 250, `${key} curve spans the range`);
}
// An additive crossover also raises the luminance of the bands it touches,
// which no colour balance can know about; what the rescue owes is a neutral
// ramp and a large step back towards the original.
const rescued = applyCurves(aged, curves);
const errorBefore = rampError(aged, scene);
const errorAfter = rampError(rescued, scene);
assert.ok(errorAfter < errorBefore * 0.4, `ramp error ${errorBefore.toFixed(1)} -> ${errorAfter.toFixed(1)}`);
const chromaBefore = rampChroma(aged);
const chromaAfter = rampChroma(rescued);
assert.ok(chromaAfter < 9 && chromaAfter < chromaBefore * 0.35, `ramp is neutral again (${chromaBefore.toFixed(1)} -> ${chromaAfter.toFixed(1)})`);
const cat = patchMean(rescued, 0, 96);
const grass = patchMean(rescued, 96, 176);
assert.ok(cat[0] > cat[1] + 40 && cat[1] > cat[2] + 30, `the orange patch stays orange: ${cat.map((v) => v.toFixed(0))}`);
assert.ok(grass[1] > grass[0] + 40 && grass[1] > grass[2] + 40, `the green patch stays green: ${grass.map((v) => v.toFixed(0))}`);

// 3. Strength zero everywhere is the identity; disabled or unmeasured is null.
const off = buildExpiredRescueCurves({ ...full, expiredLevels: 0, expiredNeutralize: 0, expiredCrossover: 0, expiredBrightness: 0, expiredContrast: 0 });
assert.ok(isIdentityExpiredCurves(off), 'zero strengths leave the image alone');
assert.equal(buildExpiredRescueCurves({ ...full, expiredEnabled: false }), null);
assert.equal(buildExpiredRescueCurves({ ...full, expiredAnalysis: null }), null);
assert.equal(buildExpiredRescueCurves({ ...full, expiredAnalysis: { version: 99 } }), null);
// Partial strengths sit between the two.
const half = applyCurves(aged, buildExpiredRescueCurves({ ...full, expiredLevels: 50, expiredNeutralize: 50, expiredCrossover: 50 }));
const errorHalf = rampError(half, scene);
assert.ok(errorHalf < errorBefore && errorHalf > errorAfter, `half strength lands between: ${errorBefore.toFixed(1)} > ${errorHalf.toFixed(1)} > ${errorAfter.toFixed(1)}`);
// Brightness lifts, contrast steepens around the middle, both monotone.
const lifted = buildExpiredRescueCurves({ ...full, expiredBrightness: 40 });
assert.ok(lifted.g[128] > curves.g[128] + 10, 'brightness lifts the midtones');
const punchy = buildExpiredRescueCurves({ ...full, expiredContrast: 60 });
// Fog sits below input 76 here, so look around the input that lands mid-grey.
const midInput = curves.g.findIndex((v) => v >= 127);
assert.ok(midInput > 8 && midInput < 247, `mid-grey input found at ${midInput}`);
assert.ok(punchy.g[midInput + 8] - punchy.g[midInput - 8] > curves.g[midInput + 8] - curves.g[midInput - 8], 'contrast steepens the middle');
assert.ok(punchy.g[0] <= 1 && punchy.g[255] >= 254, 'contrast keeps the end points');

// 4. Defaults: a dark scene gets a brightness lift, a flat one more contrast.
const defaults = defaultExpiredRescueParams(analysis);
assert.equal(defaults.expiredEnabled, true);
assert.ok(defaults.expiredContrast >= 10 && defaults.expiredContrast <= 45);
assert.ok(defaults.expiredBrightness >= -25 && defaults.expiredBrightness <= 60);
const dark = defaultExpiredRescueParams({ ...analysis, leveledMedian: 0.18 });
assert.ok(dark.expiredBrightness >= 40, `underexposed midtones lift brightness: ${dark.expiredBrightness}`);
const bright = defaultExpiredRescueParams({ ...analysis, leveledMedian: 0.6 });
assert.ok(bright.expiredBrightness < 0, `bright midtones pull back: ${bright.expiredBrightness}`);
assert.deepEqual(defaultExpiredRescueParams(null), { ...EXPIRED_RESCUE_DEFAULTS, expiredEnabled: true });

// 5. Sanitisers: ranges, fallbacks and damaged input.
assert.deepEqual(sanitizeExpiredRescueParams({}), { ...EXPIRED_RESCUE_DEFAULTS });
assert.deepEqual(sanitizeExpiredRescueParams({ expiredLevels: 500, expiredBrightness: -900, expiredContrast: 'x', expiredEnabled: true, expiredLocalContrast: 130 }, { expiredContrast: 33 }),
  { expiredEnabled: true, expiredLevels: 100, expiredNeutralize: 80, expiredCrossover: 70, expiredBrightness: -100, expiredContrast: 33, expiredUnevenFog: 100, expiredLocalContrast: 100 });
assert.equal(sanitizeExpiredRescueParams({}, { expiredEnabled: true }).expiredEnabled, true);
assert.deepEqual(EXPIRED_RESCUE_KEYS, ['expiredEnabled', 'expiredLevels', 'expiredNeutralize', 'expiredCrossover', 'expiredBrightness', 'expiredContrast', 'expiredUnevenFog', 'expiredLocalContrast']);
assert.equal(sanitizeExpiredAnalysis(null), null);
assert.equal(sanitizeExpiredAnalysis({ version: 1, low: [0, 0], high: [1, 1, 1], gamma: [1, 1, 1], shadow: [0, 0, 0], highlight: [0, 0, 0], leveledMedian: 0.5 }), null);
const clamped = sanitizeExpiredAnalysis({ ...analysis, gamma: [9, 0.01, 1], shadow: [1, -1, 0], low: [0.5, 0.5, 0.5], high: [0.51, 0.9, 0.9] });
assert.deepEqual(clamped.gamma, [1.8, 0.55, 1]);
assert.deepEqual(clamped.shadow, [0.12, -0.12, 0]);
assert.deepEqual([clamped.low[0], clamped.high[0]], [0, 1], 'a collapsed channel is left alone');
const roundTrip = JSON.parse(JSON.stringify(analysis));
assert.deepEqual(sanitizeExpiredAnalysis(roundTrip), sanitizeExpiredAnalysis(analysis), 'survives JSON (project files, recipes)');

// 6. Too small a sample or a flat image yields no analysis rather than nonsense.
assert.equal(analyzeExpiredFilm({ width: 10, height: 10, data: new Uint8ClampedArray(400).fill(120) }), null);
const flat = analyzeExpiredFilm({ width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4).fill(140) });
assert.ok(flat, 'a flat frame still measures');
assert.deepEqual(flat.low, [0, 0, 0]);
assert.deepEqual(flat.high, [1, 1, 1]);
assert.ok(isIdentityExpiredCurves(buildExpiredRescueCurves({ ...full, expiredAnalysis: flat })), 'nothing to fix, nothing changed');

// 7. 16-bit input (a plane, or attached as __image16) measures the same scene.
const plane = new Uint16Array(aged.data.length);
for (let i = 0; i < plane.length; i++) plane[i] = aged.data[i] * 257;
const analysis16 = analyzeExpiredFilm({ width: W, height: H, data: plane }, { borderBuffer: 0 });
assert.equal(analysis16.bits, 16);
for (let c = 0; c < 3; c++) {
  assert.ok(Math.abs(analysis16.low[c] - analysis.low[c]) < 0.01);
  assert.ok(Math.abs(analysis16.gamma[c] - analysis.gamma[c]) < 0.03);
}
const attached = analyzeExpiredFilm({ width: W, height: H, data: aged.data, __image16: { width: W, height: H, data: plane } }, { borderBuffer: 0 });
assert.equal(attached.bits, 16);
// A region restricts the sample: the orange patch alone reads orange.
const patch = analyzeExpiredFilm(aged, { region: { left: 0, top: 64, width: 96, height: 32 }, maxSamples: 1000 });
assert.ok(patch && patch.medians[0] > patch.medians[2] + 0.15, `region limits the measurement: ${patch && patch.medians}`);
assert.ok(patch.samples <= 1300 && patch.samples >= 400, `maxSamples bounds the stride (${patch.samples})`);

// 8. Through the adjustment stage: the rescue is the first thing applied,
//    the 16-bit path agrees, and it is never mistaken for an identity.
{
  const settings = { ...baseSettings, ...full };
  const params = computeAdjustmentParams(settings);
  assert.equal(params.doRescue, true);
  assert.equal(isIdentityAdjustmentParams(params), false);
  const out = new Uint8ClampedArray(aged.data.length);
  applyAdjustmentsToPixels(aged.data, out, W * H, params, 'full');
  let worst = 0;
  for (let i = 0; i < out.length; i += 4) for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(out[i + c] - rescued.data[i + c]));
  assert.ok(worst <= 1, `LUT path matches the curves (${worst})`);
  // The per-pixel path (saturation on) applies it too.
  const hslParams = computeAdjustmentParams({ ...settings, saturation: 0.0001 });
  const hslOut = new Uint8ClampedArray(aged.data.length);
  applyAdjustmentsToPixels(aged.data, hslOut, W * H, hslParams, 'full');
  worst = 0;
  for (let i = 0; i < out.length; i += 4) for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(hslOut[i + c] - rescued.data[i + c]));
  assert.ok(worst <= 2, `per-pixel path matches the curves (${worst})`);
  // 16-bit
  const out16 = new Uint16Array(plane.length);
  applyAdjustmentsToPixels16(plane, out16, W * H, params);
  worst = 0;
  for (let i = 0; i < out16.length; i += 4) for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs((out16[i + c] >>> 8) - rescued.data[i + c]));
  assert.ok(worst <= 2, `16-bit path agrees with 8-bit (${worst})`);
  // A genuine 16-bit ramp through the aged red range keeps far more than 256 levels.
  const ramp16 = new Uint16Array(W * 4 * 4);
  for (let x = 0; x < W * 4; x++) {
    const v = Math.round((AGE.fog[0] + (AGE.top[0] - AGE.fog[0]) * (x / (W * 4 - 1))) * 65535);
    ramp16[x * 4] = v; ramp16[x * 4 + 1] = v; ramp16[x * 4 + 2] = v; ramp16[x * 4 + 3] = 65535;
  }
  const ramp16Out = new Uint16Array(ramp16.length);
  applyAdjustmentsToPixels16(ramp16, ramp16Out, W * 4, params);
  const levels = new Set();
  for (let x = 0; x < W * 4; x++) levels.add(ramp16Out[x * 4]);
  assert.ok(levels.size > 600, `16-bit output keeps fine levels (${levels.size})`);
  const highlightsParams = computeAdjustmentParams({ ...settings, highlights: -10 });
  const hi16 = new Uint16Array(plane.length);
  applyAdjustmentsToPixels16(plane, hi16, W * H, highlightsParams);
  assert.ok(hi16[4 * (W * 2 + 200)] !== out16[4 * (W * 2 + 200)], 'the non-separable 16-bit path also runs the rescue plus the control');
  // Off means the stage is untouched.
  const offParams = computeAdjustmentParams({ ...settings, expiredEnabled: false });
  assert.equal(offParams.doRescue, false);
  assert.equal(isIdentityAdjustmentParams(offParams), true);
}

console.log('expiredRescue.test.mjs passed');

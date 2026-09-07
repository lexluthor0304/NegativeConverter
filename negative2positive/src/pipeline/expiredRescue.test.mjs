// Standalone Node test for expiredRescue.js - run with:
// node negative2positive/src/pipeline/expiredRescue.test.mjs
//
// A synthetic scene is "aged" the way an expired roll ages a positive (fog,
// per-channel range loss, per-layer gamma, a crossover) and the rescue has
// to bring the neutral ramp back while coloured patches keep their colour.

import assert from 'node:assert/strict';
import {
  analyzeExpiredFilm, applyExpiredTone, buildExpiredRescueCurves, buildExpiredRescueStages, defaultExpiredRescueParams,
  describeExpiredAnalysis, isExpiredAnalysis, isIdentityExpiredCurves, sanitizeExpiredAnalysis, sanitizeExpiredRescueParams,
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
function age(scene, { crossover = true } = {}) {
  const out = new Uint8ClampedArray(scene.data.length);
  for (let i = 0; i < out.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const x = scene.data[i + c] / 255;
      let y = AGE.fog[c] + (AGE.top[c] - AGE.fog[c]) * Math.pow(x, AGE.gamma[c]);
      // crossover: green up in the shadows (peak at 0.2, gone by 0.4), red and
      // blue up in the highlights (peak at 0.8, gone by 1)
      if (crossover && c === 1 && x < 0.4) { const t = x / 0.4; y += 0.06 * 4 * t * (1 - t); }
      if (crossover && c !== 1 && x > 0.6) { const t = (x - 0.6) / 0.4; y += 0.05 * 4 * t * (1 - t); }
      out[i + c] = Math.round(Math.max(0, Math.min(1, y)) * 255);
    }
    out[i + 3] = 255;
  }
  return { width: W, height: H, data: out };
}

function applyStages(image, stages) {
  const out = new Uint8ClampedArray(image.data.length);
  const px = new Float32Array(3);
  for (let i = 0; i < out.length; i += 4) {
    px[0] = image.data[i]; px[1] = image.data[i + 1]; px[2] = image.data[i + 2];
    applyExpiredTone(stages, px);
    out[i] = Math.round(px[0]); out[i + 1] = Math.round(px[1]); out[i + 2] = Math.round(px[2]); out[i + 3] = 255;
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
const full = { ...EXPIRED_RESCUE_DEFAULTS, expiredEnabled: true, expiredLevels: 100, expiredNeutralize: 100, expiredCrossover: 100, expiredBrightness: 0, expiredContrast: 0 };

// 0. Fog, range loss and per-layer gamma alone (no crossover): the colour
//    comes back neutral and the tone close.
{
  const plain = age(scene, { crossover: false });
  const measured = analyzeExpiredFilm(plain, { borderBuffer: 0 });
  assert.ok(measured, 'plain ageing measured');
  assert.ok(measured.lumLow > 0.25 && measured.lumLow < 0.45, `luminance fog measured (${measured.lumLow})`);
  assert.ok(measured.lean[2] > measured.lean[0], `the blue layer's heavier fog reads as a blue lean (${measured.lean})`);
  const back = applyStages(plain, buildExpiredRescueStages({ ...full, expiredAnalysis: measured }));
  // The lawn and the cat share the ramp's midtone bands and, under the fog,
  // its chroma; the ramp comes most of the way back (see the note in 2).
  assert.ok(rampChroma(back) < 13 && rampChroma(back) < rampChroma(plain) * 0.5, `neutral again (${rampChroma(plain).toFixed(1)} -> ${rampChroma(back).toFixed(1)})`);
  const error = rampError(back, scene);
  assert.ok(error < rampError(plain, scene) * 0.35 && error < 14, `tone comes back (${rampError(plain, scene).toFixed(1)} -> ${error.toFixed(1)})`);
}

// 1. The analysis measures what the ageing did.
const analysis = analyzeExpiredFilm(aged, { borderBuffer: 0 });
assert.ok(analysis, 'analysis produced');
assert.ok(isExpiredAnalysis(analysis));
assert.equal(analysis.bits, 8);
assert.equal(analysis.bands.length, 8);
assert.ok(analysis.bands.filter(Boolean).length >= 6, 'most bands are populated');
for (const band of analysis.bands) if (band) assert.ok(band.share > 0 && band.lum >= 0 && band.lum <= 1 && band.mean.length === 3);

const info = describeExpiredAnalysis(analysis);
assert.ok(info.fogPercent >= 25 && info.fogPercent <= 45, `fog percent ${info.fogPercent}`);
assert.ok(info.rangePercent < 65, `range percent ${info.rangePercent}`);
assert.ok(info.cast === null || ['red', 'yellow', 'green', 'cyan', 'blue', 'magenta'].includes(info.cast));
assert.equal(info.shadowCast, 'green');
assert.equal(info.highlightCast, 'magenta');
assert.ok(info.crossoverPercent >= 4, `crossover strength reported (${info.crossoverPercent}%)`);
assert.equal(typeof info.exposureStops, 'number');
assert.equal(info.hasSpatial, false);

// 2. Full-strength stages bring the neutral ramp back and keep colours.
const stages = buildExpiredRescueStages({ ...full, expiredAnalysis: analysis });
assert.ok(stages && stages.offsets instanceof Float32Array && stages.tone.length === 256 && stages.composed === null, 'colour offsets plus a shared tone curve');
for (let v = 1; v < 256; v++) assert.ok(stages.tone[v] >= stages.tone[v - 1], `tone curve monotonic at ${v}`);
assert.ok(stages.tone[0] <= 1 && stages.tone[255] >= 250, 'tone curve spans the range');
const rescued = applyStages(aged, stages);
const errorBefore = rampError(aged, scene);
const errorAfter = rampError(rescued, scene);
assert.ok(errorAfter < errorBefore * 0.4, `ramp error ${errorBefore.toFixed(1)} -> ${errorAfter.toFixed(1)}`);
// The lawn shares the ramp's midtone band and, under the fog, its chroma;
// what is neutral there is a judgement the statistics cannot make alone, so
// the ramp is asked to come most of the way back rather than all of it.
const chromaBefore = rampChroma(aged);
const chromaAfter = rampChroma(rescued);
assert.ok(chromaAfter < 13 && chromaAfter < chromaBefore * 0.5, `ramp is neutral again (${chromaBefore.toFixed(1)} -> ${chromaAfter.toFixed(1)})`);
const cat = patchMean(rescued, 0, 96);
const grass = patchMean(rescued, 96, 176);
assert.ok(cat[0] > cat[1] + 40 && cat[1] > cat[2] + 30, `the orange patch stays orange: ${cat.map((v) => v.toFixed(0))}`);
assert.ok(grass[1] > grass[0] + 40 && grass[1] > grass[2] + 40, `the green patch stays green: ${grass.map((v) => v.toFixed(0))}`);

// 3. Strength zero everywhere is the identity; disabled or unmeasured is null.
const off = buildExpiredRescueStages({ ...full, expiredAnalysis: analysis, expiredLevels: 0, expiredNeutralize: 0, expiredCrossover: 0, expiredBrightness: 0, expiredContrast: 0 });
assert.equal(off.offsets, null, 'zero colour strengths leave the colour alone');
assert.ok(isIdentityExpiredCurves(off.composed), 'zero tone strengths leave the tone alone');
assert.equal(buildExpiredRescueStages({ ...full, expiredAnalysis: analysis, expiredEnabled: false }), null);
assert.equal(buildExpiredRescueStages({ ...full, expiredAnalysis: null }), null);
assert.equal(buildExpiredRescueStages({ ...full, expiredAnalysis: { version: 99 } }), null);
assert.equal(buildExpiredRescueCurves({ ...full, expiredAnalysis: null }), null);
// Partial strengths sit between the two.
const half = applyStages(aged, buildExpiredRescueStages({ ...full, expiredAnalysis: analysis, expiredLevels: 50, expiredNeutralize: 50, expiredCrossover: 50 }));
const chromaHalf = rampChroma(half);
assert.ok(chromaHalf < chromaBefore && chromaHalf > chromaAfter, `half strength lands between: ${chromaBefore.toFixed(1)} > ${chromaHalf.toFixed(1)} > ${chromaAfter.toFixed(1)}`);
// Brightness lifts the midtones, contrast steepens around the middle, both monotone.
const lifted = buildExpiredRescueStages({ ...full, expiredAnalysis: analysis, expiredBrightness: 40 });
const midInput = stages.tone.findIndex((v) => v >= 127);
assert.ok(midInput > 8 && midInput < 247, `mid-grey input found at ${midInput}`);
assert.ok(lifted.tone[midInput] > stages.tone[midInput] + 10, 'brightness lifts the midtones');
const punchy = buildExpiredRescueStages({ ...full, expiredAnalysis: analysis, expiredContrast: 60 });
assert.ok(punchy.tone[midInput + 8] - punchy.tone[midInput - 8] > stages.tone[midInput + 8] - stages.tone[midInput - 8], 'contrast steepens the middle');
assert.ok(punchy.tone[0] <= 1 && punchy.tone[255] >= 254, 'contrast keeps the end points');
// The colour offsets keep every pixel's luminance: neutralising does not darken or lighten.
{
  const px = new Float32Array(3);
  const colourOnly = buildExpiredRescueStages({ ...full, expiredAnalysis: analysis, expiredLevels: 0, expiredBrightness: 0, expiredContrast: 0 });
  let drift = 0; let n = 0;
  for (let y = 10; y < 60; y += 5) for (let x = 20; x < W - 20; x += 7) {
    const o = (y * W + x) * 4;
    const before = 0.2126 * aged.data[o] + 0.7152 * aged.data[o + 1] + 0.0722 * aged.data[o + 2];
    px[0] = aged.data[o]; px[1] = aged.data[o + 1]; px[2] = aged.data[o + 2];
    applyExpiredTone(colourOnly, px);
    drift += Math.abs(0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2] - before); n++;
  }
  assert.ok(drift / n < 3, `luminance kept through the colour stage (${(drift / n).toFixed(2)})`);
}

// 4. Defaults: a dark scene gets a brightness lift, a flat one more contrast.
const defaults = defaultExpiredRescueParams(analysis);
assert.equal(defaults.expiredEnabled, true);
assert.equal(defaults.expiredNeutralize, 100);
assert.equal(defaults.expiredCrossover, 100);
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
  { expiredEnabled: true, expiredLevels: 100, expiredNeutralize: 100, expiredCrossover: 100, expiredBrightness: -100, expiredContrast: 33, expiredUnevenFog: 100, expiredLocalContrast: 100 });
assert.equal(sanitizeExpiredRescueParams({}, { expiredEnabled: true }).expiredEnabled, true);
assert.deepEqual(EXPIRED_RESCUE_KEYS, ['expiredEnabled', 'expiredLevels', 'expiredNeutralize', 'expiredCrossover', 'expiredBrightness', 'expiredContrast', 'expiredUnevenFog', 'expiredLocalContrast']);
assert.equal(sanitizeExpiredAnalysis(null), null);
assert.equal(sanitizeExpiredAnalysis({ ...analysis, version: 1 }), null, 'an older measurement is re-measured, not trusted');
assert.equal(sanitizeExpiredAnalysis({ ...analysis, bands: analysis.bands.slice(1) }), null);
assert.ok(sanitizeExpiredAnalysis({ ...analysis, bands: analysis.bands.map((b) => (b ? { ...b, mean: [0.5] } : b)) }).bands.every((b) => b === null), 'damaged bands drop out one by one');
const clamped = sanitizeExpiredAnalysis({ ...analysis, lean: [9, -9, 0], lumLow: 0.5, lumHigh: 0.51 });
assert.deepEqual(clamped.lean, [1, -1, 0]);
assert.deepEqual([clamped.lumLow, clamped.lumHigh], [0, 1], 'a collapsed range is left alone');
const roundTrip = JSON.parse(JSON.stringify(analysis));
assert.deepEqual(sanitizeExpiredAnalysis(roundTrip), sanitizeExpiredAnalysis(analysis), 'survives JSON (project files, recipes)');

// 6. Too small a sample or a flat image yields no analysis rather than nonsense.
assert.equal(analyzeExpiredFilm({ width: 10, height: 10, data: new Uint8ClampedArray(400).fill(120) }), null);
const flat = analyzeExpiredFilm({ width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4).fill(140) });
assert.ok(flat, 'a flat frame still measures');
assert.deepEqual([flat.lumLow, flat.lumHigh], [0, 1]);
const flatStages = buildExpiredRescueStages({ ...full, expiredAnalysis: flat });
assert.equal(flatStages.offsets, null, 'a neutral frame gets no colour offsets');
assert.ok(isIdentityExpiredCurves(flatStages.composed), 'nothing to fix, nothing changed');

// 7. 16-bit input (a plane, or attached as __image16) measures the same scene.
const plane = new Uint16Array(aged.data.length);
for (let i = 0; i < plane.length; i++) plane[i] = aged.data[i] * 257;
const analysis16 = analyzeExpiredFilm({ width: W, height: H, data: plane }, { borderBuffer: 0 });
assert.equal(analysis16.bits, 16);
assert.ok(Math.abs(analysis16.lumLow - analysis.lumLow) < 0.01);
for (let c = 0; c < 3; c++) assert.ok(Math.abs(analysis16.lean[c] - analysis.lean[c]) < 0.01);
const attached = analyzeExpiredFilm({ width: W, height: H, data: aged.data, __image16: { width: W, height: H, data: plane } }, { borderBuffer: 0 });
assert.equal(attached.bits, 16);
// A region restricts the sample: the orange patch alone leans warm.
const patch = analyzeExpiredFilm(aged, { region: { left: 0, top: 64, width: 96, height: 32 }, maxSamples: 1000 });
assert.ok(patch && patch.lean[0] > patch.lean[2] + 0.1, `region limits the measurement: ${patch && patch.lean}`);
assert.ok(patch.samples <= 1300 && patch.samples >= 400, `maxSamples bounds the stride (${patch.samples})`);

// 8. Through the adjustment stage: the rescue is the first thing applied and
//    runs per pixel (the colour offsets depend on luminance), the 16-bit
//    path agrees, and it is never mistaken for an identity.
{
  const settings = { ...baseSettings, ...full, expiredAnalysis: analysis };
  const params = computeAdjustmentParams(settings, { width: W, height: H });
  assert.equal(params.doRescue, true);
  assert.equal(params.doRescuePixel, true);
  assert.equal(params.doRescueSpatial, false);
  assert.equal(isIdentityAdjustmentParams(params), false);
  const out = new Uint8ClampedArray(aged.data.length);
  applyAdjustmentsToPixels(aged.data, out, W * H, params, 'full');
  let worst = 0;
  for (let i = 0; i < out.length; i += 4) for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(out[i + c] - rescued.data[i + c]));
  assert.ok(worst <= 1, `per-pixel path matches the stages (${worst})`);
  // With saturation on the same per-pixel path continues into HSL.
  const hslParams = computeAdjustmentParams({ ...settings, saturation: 0.0001 });
  const hslOut = new Uint8ClampedArray(aged.data.length);
  applyAdjustmentsToPixels(aged.data, hslOut, W * H, hslParams, 'full');
  worst = 0;
  for (let i = 0; i < out.length; i += 4) for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(hslOut[i + c] - rescued.data[i + c]));
  assert.ok(worst <= 2, `HSL path matches the stages (${worst})`);
  // 16-bit
  const out16 = new Uint16Array(plane.length);
  applyAdjustmentsToPixels16(plane, out16, W * H, params);
  worst = 0;
  for (let i = 0; i < out16.length; i += 4) for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs((out16[i + c] >>> 8) - rescued.data[i + c]));
  assert.ok(worst <= 2, `16-bit path agrees with 8-bit (${worst})`);
  // A genuine 16-bit ramp keeps far more than 256 levels.
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
  // A neutral measurement composes into the LUT fast path.
  const flatParams = computeAdjustmentParams({ ...baseSettings, ...full, expiredAnalysis: flat, expiredLevels: 100, expiredContrast: 30 });
  assert.equal(flatParams.doRescue, true);
  assert.equal(flatParams.doRescuePixel, false);
  assert.ok(flatParams.rescueR && flatParams.rescueR[128] !== 128, 'the tone curve reaches the LUT path');
  // Off means the stage is untouched.
  const offParams = computeAdjustmentParams({ ...settings, expiredEnabled: false });
  assert.equal(offParams.doRescue, false);
  assert.equal(isIdentityAdjustmentParams(offParams), true);
}

console.log('expiredRescue.test.mjs passed');

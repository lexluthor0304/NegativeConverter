// Standalone Node test for multiShot.js - run with:
// node negative2positive/src/app/multiShot.test.mjs

import assert from 'node:assert/strict';
import { estimateExposureRatio, mergeFrames, mergeRows, mergeScale, image16ToImageData, coverageRect, toImage16, LIN, HAT } from './multiShot.js';
import * as head from './multiShot.reference.mjs';

if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class ImageData {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

const W = 120; const H = 80;
const encode = (linear) => Math.round(Math.pow(Math.max(0, Math.min(1, linear)), 1 / 2.2) * 65535);
const decode = (v) => Math.pow(v / 65535, 2.2);
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };

// A scene in linear light: gradient plus a bright patch that clips at the base exposure.
function sceneLinear(x, y) {
  const bright = x > 80 && y < 30;
  return bright ? 1.6 : 0.05 + 0.5 * (x / W) * (y / H);
}
function frame({ gain = 1, noise = 0, holeCorner = false } = {}) {
  const data = new Uint16Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    const base = sceneLinear(x, y) * gain;
    for (let ch = 0; ch < 3; ch++) data[o + ch] = encode(base * (1 + noise * rnd()));
    data[o + 3] = holeCorner && x < 10 && y < 10 ? 0 : 65535;
  }
  return { width: W, height: H, data };
}

// Exposure ratio between brackets is recovered from the mid-tones.
{
  const base = frame();
  const brighter = frame({ gain: 2 });
  const ratio = estimateExposureRatio(base, brighter);
  assert.ok(Math.abs(ratio - 2) < 0.05, `ratio ${ratio}`);
  assert.equal(estimateExposureRatio(base, { width: 1, height: 1, data: new Uint16Array(4) }), 1, 'size mismatch -> 1');
}

// Averaging reduces noise by about sqrt(N) and skips uncovered pixels.
{
  const noisy = [0, 1, 2, 3].map(() => ({ image16: frame({ noise: 0.3 }), ratio: 1 }));
  const clean = frame();
  const merged = mergeFrames(noisy, { mode: 'average' });
  const noiseOf = (img) => {
    let sum = 0; let n = 0;
    for (let y = 10; y < H - 10; y++) for (let x = 10; x < 70; x++) {
      const o = (y * W + x) * 4;
      sum += Math.abs(decode(img.data[o + 1]) - decode(clean.data[o + 1])); n++;
    }
    return sum / n;
  };
  const single = noiseOf(noisy[0].image16);
  const combined = noiseOf(merged);
  assert.ok(combined < single * 0.65, `noise ${single.toFixed(4)} -> ${combined.toFixed(4)}`);
  const withHole = mergeFrames([{ image16: frame({ holeCorner: true }), ratio: 1 }, { image16: frame(), ratio: 1 }], { mode: 'average' });
  assert.equal(withHole.data[3], 65535, 'covered by the second frame');
  assert.ok(Math.abs(decode(withHole.data[0]) - sceneLinear(0, 0)) < 0.01, 'hole filled from the other frame');
  const allHoles = mergeFrames([{ image16: frame({ holeCorner: true }), ratio: 1 }, { image16: frame({ holeCorner: true }), ratio: 1 }]);
  assert.equal(allHoles.data[3], 0, 'uncovered pixels stay transparent');
}

// A speck present in one of three frames is rejected by the median test.
{
  const speck = frame();
  const o = (40 * W + 40) * 4;
  speck.data[o] = speck.data[o + 1] = speck.data[o + 2] = 200;
  const merged = mergeFrames([{ image16: frame(), ratio: 1 }, { image16: speck, ratio: 1 }, { image16: frame(), ratio: 1 }], { mode: 'average' });
  assert.ok(Math.abs(decode(merged.data[o + 1]) - sceneLinear(40, 40)) < 0.01, 'speck rejected');
  const two = mergeFrames([{ image16: frame(), ratio: 1 }, { image16: speck, ratio: 1 }], { mode: 'average' });
  assert.ok(decode(two.data[o + 1]) < sceneLinear(40, 40) * 0.8, 'two frames cannot outvote, they average');
}

// HDR: a darker bracket recovers the clipped bright patch; mid-tones stay at the reference exposure.
{
  const base = frame();
  const darker = frame({ gain: 0.5 });
  const ratio = estimateExposureRatio(base, darker);
  assert.ok(Math.abs(ratio - 0.5) < 0.05, `ratio ${ratio}`);
  const merged = mergeFrames([{ image16: base, ratio: 1 }, { image16: darker, ratio }], { mode: 'hdr' });
  const patch = (15 * W + 100) * 4;
  assert.equal(base.data[patch], 65535, 'base clips the bright patch');
  // The result sits at the darker bracket's exposure, so the patch survives.
  assert.ok(Math.abs(decode(merged.data[patch]) - 1.6 * ratio) < 0.03, `patch ${decode(merged.data[patch])}`);
  // Where both frames are well exposed the merge stays close to the scene.
  const mid = (40 * W + 40) * 4;
  assert.ok(Math.abs(decode(merged.data[mid + 1]) - sceneLinear(40, 40) * ratio) < 0.02);
  const image = image16ToImageData(merged);
  assert.equal(image.width, W);
  assert.equal(image.__image16, merged);
  assert.equal(image.data[mid + 1], merged.data[mid + 1] >> 8);
}

// Coverage: a corner hole in one frame trims those rows and columns; the
// cropped, opaque merge starts at the trimmed origin.
{
  const frames = [{ image16: frame({ holeCorner: true }), ratio: 1 }, { image16: frame(), ratio: 1 }];
  const rect = coverageRect(frames);
  assert.deepEqual(rect, { left: 10, top: 10, width: W - 10, height: H - 10 });
  assert.deepEqual(coverageRect([frames[1]]), { left: 0, top: 0, width: W, height: H }, 'a single frame is fully covered');
  const merged = mergeFrames(frames, { mode: 'average', region: rect, opaque: true });
  assert.equal(merged.width, W - 10);
  assert.equal(merged.height, H - 10);
  assert.equal(merged.data[3], 65535);
  assert.ok(Math.abs(decode(merged.data[0]) - sceneLinear(10, 10)) < 0.01, 'output origin is the trimmed reference pixel');
}

// 8-bit decodes are widened to 16 bits; 16-bit planes pass through.
{
  const eight = { width: 2, height: 1, data: new Uint8ClampedArray([0, 128, 255, 255, 10, 20, 30, 255]) };
  const wide = toImage16(eight);
  assert.deepEqual(Array.from(wide.data), [0, 128 * 257, 65535, 65535, 2570, 5140, 7710, 65535]);
  const plane = frame();
  assert.equal(toImage16({ width: W, height: H, data: new Uint8ClampedArray(4), __image16: plane }), plane);
}

assert.equal(mergeFrames([]), null);
assert.equal(mergeFrames([{ image16: frame(), ratio: 1 }, { image16: { width: 1, height: 1, data: new Uint16Array(4) }, ratio: 1 }]), null);

// ---- Parity with the kernels at 1703835 (multiShot.reference.mjs) ----
// Every rewrite (tables, hoisting, row loop, insertion-sort median, typed
// ratio sort, row bands) must give the same samples and ratios.
for (let v = 0; v < 65536; v++) {
  if (LIN[v] !== head.toLinear(v)) assert.fail(`LIN[${v}] ${LIN[v]} !== toLinear ${head.toLinear(v)}`);
  if (HAT[v] !== head.hatWeight(v / 65535) + 1e-4) assert.fail(`HAT[${v}] differs`);
}

function sameSamples(actual, expected, label) {
  assert.ok(actual && expected, `${label}: both merges produced output`);
  assert.equal(actual.width, expected.width, `${label}: width`);
  assert.equal(actual.height, expected.height, `${label}: height`);
  assert.equal(actual.data.length, expected.data.length, `${label}: length`);
  for (let i = 0; i < expected.data.length; i++) {
    if (actual.data[i] !== expected.data[i]) assert.fail(`${label}: sample ${i} is ${actual.data[i]}, HEAD ${expected.data[i]}`);
  }
}

let pseed = 99;
const prnd = () => { pseed = (pseed * 1103515245 + 12345) & 0x7fffffff; return pseed / 0x7fffffff; };
const PW = 97; const PH = 61;
// A scene with a clipped patch, per-frame noise, holes along a warped edge,
// random alpha-0 pixels and (optionally) a speck that moves between shots.
function paritySource({ gain = 1, noise = 0.2, holes = 0, speckAt = null, wedge = 0, full = false } = {}) {
  const data = new Uint16Array(PW * PH * 4);
  for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
    const o = (y * PW + x) * 4;
    if (full) {
      for (let ch = 0; ch < 4; ch++) data[o + ch] = Math.floor(prnd() * 65536);
      if (prnd() < holes) data[o + 3] = 0;
      continue;
    }
    const bright = x > 60 && y < 20;
    const base = (bright ? 1.4 : 0.02 + 0.6 * (x / PW) * (y / PH)) * gain;
    for (let ch = 0; ch < 3; ch++) data[o + ch] = encode(base * (1 + noise * (prnd() - 0.5)) * (0.9 + 0.1 * ch));
    data[o + 3] = x + y < wedge || prnd() < holes ? 0 : 65535;
  }
  if (speckAt) {
    const [sx, sy] = speckAt;
    for (let y = sy; y < sy + 3; y++) for (let x = sx; x < sx + 3; x++) {
      const o = (y * PW + x) * 4; data[o] = data[o + 1] = data[o + 2] = 60000;
    }
  }
  return { width: PW, height: PH, data };
}

for (const count of [2, 3, 4, 5]) {
  const frames = [];
  for (let i = 0; i < count; i++) {
    frames.push({ image16: paritySource({ noise: 0.35, holes: 0.03, wedge: i * 6, speckAt: [10 + i * 13, 30 - i * 4] }), ratio: 1 });
  }
  sameSamples(mergeFrames(frames, { mode: 'average' }), head.mergeFrames(frames, { mode: 'average' }), `average ${count} frames`);
  const region = coverageRect(frames);
  assert.deepEqual(region, head.coverageRect(frames), `coverageRect ${count} frames`);
  sameSamples(mergeFrames(frames, { mode: 'average', region, opaque: true }), head.mergeFrames(frames, { mode: 'average', region, opaque: true }), `average ${count} frames, region`);
  // Full-range random samples, including values the scene never produces.
  const random = [];
  for (let i = 0; i < count; i++) random.push({ image16: paritySource({ full: true, holes: 0.2 }), ratio: [1, 0.7, 1.9, 0.35, 3][i] });
  sameSamples(mergeFrames(random, { mode: 'average' }), head.mergeFrames(random, { mode: 'average' }), `average ${count} random frames`);
  sameSamples(mergeFrames(random, { mode: 'hdr' }), head.mergeFrames(random, { mode: 'hdr' }), `hdr ${count} random frames`);
  sameSamples(mergeFrames(random, { mode: 'other' }), head.mergeFrames(random, { mode: 'other' }), `unknown mode ${count} random frames`);
}

// HDR brackets with clipped highlights, ratios measured by both implementations.
{
  const base = paritySource({ noise: 0.1 });
  const darker = paritySource({ gain: 0.5, noise: 0.1, wedge: 5 });
  const darkest = paritySource({ gain: 0.25, noise: 0.1, holes: 0.02 });
  for (const step of [4, 1, 3, 2.6, 0, -2]) {
    assert.equal(estimateExposureRatio(base, darker, { step }), head.estimateExposureRatio(base, darker, { step }), `ratio step ${step}`);
  }
  const r1 = estimateExposureRatio(base, darker);
  const r2 = estimateExposureRatio(base, darkest);
  assert.equal(r1, head.estimateExposureRatio(base, darker));
  assert.equal(r2, head.estimateExposureRatio(base, darkest));
  assert.ok(r1 < 0.6 && r2 < 0.35, `bracket ratios ${r1} ${r2}`);
  const frames = [{ image16: base, ratio: 1 }, { image16: darker, ratio: r1 }, { image16: darkest, ratio: r2 }];
  sameSamples(mergeFrames(frames, { mode: 'hdr' }), head.mergeFrames(frames, { mode: 'hdr' }), 'hdr brackets');
  const region = { left: 7, top: 5, width: 53, height: 40 };
  sameSamples(mergeFrames(frames, { mode: 'hdr', region, opaque: true }), head.mergeFrames(frames, { mode: 'hdr', region, opaque: true }), 'hdr brackets, region');
  // The ratio falls back to 1 when it is 0, undefined or not a number.
  const fallbacks = [{ image16: base, ratio: 0 }, { image16: darker, ratio: undefined }, { image16: darkest, ratio: NaN }];
  sameSamples(mergeFrames(fallbacks, { mode: 'hdr' }), head.mergeFrames(fallbacks, { mode: 'hdr' }), 'ratio fallbacks, hdr');
  sameSamples(mergeFrames(fallbacks, { mode: 'average' }), head.mergeFrames(fallbacks, { mode: 'average' }), 'ratio fallbacks, average');
  assert.equal(mergeScale(frames), Math.min(r1, r2));

  // Row bands of any height rebuild the whole merge.
  const rect = coverageRect(frames);
  const whole = mergeFrames(frames, { mode: 'hdr', region: rect, opaque: true });
  for (const band of [1, 7, 64]) {
    const out = new Uint16Array(rect.width * rect.height * 4);
    const scale = mergeScale(frames);
    for (let y0 = 0; y0 < rect.height; y0 += band) mergeRows(frames, rect, y0, Math.min(rect.height, y0 + band), out, { mode: 'hdr', scale, opaque: true });
    sameSamples({ width: rect.width, height: rect.height, data: out }, whole, `bands of ${band} rows`);
  }
}

// Ratio early returns: fewer than 50 usable samples, and a size mismatch.
{
  const dark = { width: 20, height: 10, data: new Uint16Array(20 * 10 * 4).fill(65535) };
  for (let i = 0; i < 12; i++) dark.data[i * 4] = dark.data[i * 4 + 1] = dark.data[i * 4 + 2] = 30000;
  assert.equal(estimateExposureRatio(dark, dark, { step: 1 }), head.estimateExposureRatio(dark, dark, { step: 1 }));
  assert.equal(estimateExposureRatio(dark, dark, { step: 1 }), 1, 'fewer than 50 samples -> 1');
  assert.equal(estimateExposureRatio(dark, frame()), 1, 'size mismatch -> 1');
  assert.equal(estimateExposureRatio(null, dark), 1);
}

console.log('multiShot.test.mjs passed');

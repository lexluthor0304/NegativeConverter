// Standalone Node test for multiShot.js - run with:
// node negative2positive/src/app/multiShot.test.mjs

import assert from 'node:assert/strict';
import { estimateExposureRatio, mergeFrames, image16ToImageData, coverageRect, toImage16 } from './multiShot.js';

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

console.log('multiShot.test.mjs passed');

// Standalone Node test for focusRecovery.js - run with:
// node negative2positive/src/render/focusRecovery.test.mjs
//
// The estimate reads a known blur, the plan undoes only what lies beyond a
// sharp frame's own, and the reference arithmetic (which the shaders repeat)
// sharpens a blurred edge without touching a flat field, colour or alpha.
// The GPU itself is checked in the browser (the smoke's focus module).
import assert from 'node:assert/strict';
import {
  focusKernel, estimateFocus, focusPlan, focusTiles, recoverFocusReference,
  FOCUS_TILE, FOCUS_HALO, FOCUS_MAX_SIGMA, FOCUS_MIN_SIGMA, FOCUS_ITERATIONS, FOCUS_DAMP_MIN, FOCUS_DAMP_MAX
} from './focusRecovery.js';

// --- the kernel ---
for (const sigma of [0.6, 1, 2.5, 5]) {
  const taps = focusKernel(sigma);
  assert.equal(taps.length % 2, 1);
  assert.ok(taps.length <= 33);
  assert.ok(Math.abs(taps.reduce((a, b) => a + b, 0) - 1) < 1e-5, 'the taps sum to one');
  assert.equal(taps[0], taps[taps.length - 1]);
}

// A scene of sharp shapes on a noisy ground, blurred by a known Gaussian.
let seed = 99;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
function scene(width, height) {
  const grey = new Float32Array(width * height).fill(70);
  for (let k = 0; k < 60; k++) {
    const x0 = Math.floor(random() * width), y0 = Math.floor(random() * height), w = 20 + Math.floor(random() * 120), h = 20 + Math.floor(random() * 120);
    const v = 40 + random() * 170;
    for (let y = y0; y < Math.min(height, y0 + h); y++) for (let x = x0; x < Math.min(width, x0 + w); x++) grey[y * width + x] = v;
  }
  return grey;
}
function blurred(grey, width, height, sigma) {
  if (!(sigma > 0)) return Float32Array.from(grey);
  const taps = focusKernel(sigma), r = taps.length >> 1, tmp = new Float32Array(grey.length), out = new Float32Array(grey.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let s = 0; for (let i = -r; i <= r; i++) s += grey[y * width + Math.min(width - 1, Math.max(0, x + i))] * taps[i + r];
    tmp[y * width + x] = s;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let s = 0; for (let i = -r; i <= r; i++) s += tmp[Math.min(height - 1, Math.max(0, y + i)) * width + x] * taps[i + r];
    out[y * width + x] = s;
  }
  return out;
}
function frameOf(grey, width, height, { grain = 0, sixteen = false, tint = [1, 0.9, 0.8] } = {}) {
  const data = new Uint8ClampedArray(width * height * 4), plane = sixteen ? new Uint16Array(width * height * 4) : null;
  for (let p = 0; p < width * height; p++) {
    const v = grey[p] + grain * (random() + random() + random() + random() - 2) * Math.sqrt(3);
    for (let c = 0; c < 3; c++) {
      const value = Math.max(0, Math.min(255, v * tint[c]));
      data[p * 4 + c] = Math.round(value);
      if (plane) plane[p * 4 + c] = Math.round(value * 257);
    }
    data[p * 4 + 3] = 255;
    if (plane) plane[p * 4 + 3] = 65535;
  }
  const frame = { width, height, data };
  if (plane) frame.__image16 = { width, height, data: plane };
  return frame;
}

// --- the estimate reads the blur that was put in, 8 and 16 bits, with grain on top ---
const W = 900, H = 700;
const sharp = scene(W, H);
for (const sigma of [1.5, 2.5, 4]) {
  for (const sixteen of [false, true]) {
    const estimate = estimateFocus(frameOf(blurred(sharp, W, H, sigma), W, H, { grain: 2, sixteen }));
    assert.ok(Math.abs(estimate.sigma - sigma) < 0.2 * sigma + 0.25, `sigma ${sigma} read as ${estimate.sigma.toFixed(2)} (${sixteen ? 16 : 8} bits)`);
    assert.ok(estimate.grain > 0.5 * 2 / 255 && estimate.grain < 2 * 2 / 255, `grain of two levels read as ${(estimate.grain * 255).toFixed(2)}`);
  }
}
assert.ok(estimateFocus(frameOf(blurred(sharp, W, H, 2), W, H)).sigma < estimateFocus(frameOf(blurred(sharp, W, H, 3.5), W, H)).sigma, 'more blur reads wider');
assert.equal(estimateFocus(frameOf(new Float32Array(W * H).fill(90), W, H)), null, 'a flat frame has no edge to read');
assert.equal(estimateFocus(frameOf(new Float32Array(40 * 40).fill(90), 40, 40)), null, 'nor a tiny one');

// --- the plan: only the blur beyond a sharp frame's own, a share of it, within the limits ---
assert.equal(focusPlan(9324, 6215, { sigma: 2.6, grain: 3 / 255 }, 1), null, 'a frame as sharp as its scan allows has nothing to undo');
assert.equal(focusPlan(9324, 6215, { sigma: 6, grain: 3 / 255 }, 0), null, 'strength 0 is off');
assert.equal(focusPlan(9324, 6215, null, 1), null);
const full = focusPlan(9324, 6215, { sigma: 6, grain: 3 / 255 }, 1), part = focusPlan(9324, 6215, { sigma: 6, grain: 3 / 255 }, 0.6);
assert.ok(Math.abs(full.base - 2.61) < 0.02 && Math.abs(full.excess - Math.sqrt(36 - 2.61 ** 2)) < 0.02);
assert.ok(full.sigma === FOCUS_MAX_SIGMA && Math.abs(part.sigma - 0.6 * full.excess) < 0.02, 'the strength takes a share of the excess, capped');
assert.equal(full.iterations, FOCUS_ITERATIONS);
assert.equal(focusPlan(9324, 6215, { sigma: 6, grain: 0 }, 1).damp, Math.round(FOCUS_DAMP_MIN * 10000) / 10000);
assert.equal(focusPlan(9324, 6215, { sigma: 6, grain: 1 }, 1).damp, Math.round(FOCUS_DAMP_MAX * 10000) / 10000);
assert.equal(focusPlan(3000, 2000, { sigma: 1.1, grain: 0 }, 1), null, `an excess below ${FOCUS_MIN_SIGMA} px is not worth undoing`);
assert.ok(focusPlan(3000, 2000, { sigma: 2.5, grain: 0 }, 1).base === 1, 'a small frame is never taken for sharper than one px');

// --- the tiles cover the frame once, each with its halo inside the frame ---
for (const [w, h] of [[9536, 6336], [2048, 2048], [2049, 100], [300, 5000]]) {
  const tiles = focusTiles(w, h);
  let own = 0;
  for (const tile of tiles) {
    own += tile.own.width * tile.own.height;
    assert.ok(tile.x >= 0 && tile.y >= 0 && tile.x + tile.width <= w && tile.y + tile.height <= h);
    assert.ok(tile.width <= FOCUS_TILE + 2 * FOCUS_HALO && tile.height <= FOCUS_TILE + 2 * FOCUS_HALO);
    assert.ok(tile.own.x - tile.x === Math.min(FOCUS_HALO, tile.own.x) && tile.own.y - tile.y === Math.min(FOCUS_HALO, tile.own.y));
  }
  assert.equal(own, w * h, `tiles of ${w}x${h} cover it once`);
}

// --- the reference: a blurred edge gets steeper, a flat field, the colour and alpha stay ---
{
  const w = 240, h = 160, sigma = 2.5;
  const grey = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) grey[y * w + x] = x < 120 ? 60 : 180;
  for (const sixteen of [false, true]) {
    const soft = frameOf(blurred(grey, w, h, sigma), w, h, { sixteen });
    const before = Uint8ClampedArray.from(soft.data);
    const plan = { sigma, damp: FOCUS_DAMP_MIN, iterations: FOCUS_ITERATIONS };
    const out = recoverFocusReference(soft, plan);
    assert.deepEqual(soft.data, before, 'the input is not modified');
    const row = 80 * w * 4;
    const rise = (data) => { let a = 0, b = 0; for (let x = 0; x < w; x++) { const v = data[row + x * 4]; if (!a && v > 60 + 12) a = x; if (!b && v > 180 - 12) b = x; } return b - a; };
    assert.ok(rise(out.data) < rise(soft.data) * 0.7, `the edge's rise narrows (${rise(soft.data)} -> ${rise(out.data)} px, ${sixteen ? 16 : 8} bits)`);
    for (const x of [20, 220]) for (let c = 0; c < 3; c++) assert.ok(Math.abs(out.data[row + x * 4 + c] - soft.data[row + x * 4 + c]) <= 1, 'flat ground stays');
    const p = row + 20 * 4;
    assert.ok(Math.abs(out.data[p + 1] / out.data[p] - 0.9) < 0.03 && Math.abs(out.data[p + 2] / out.data[p] - 0.8) < 0.03, 'the channels keep their ratio');
    assert.equal(out.data[p + 3], 255);
    if (sixteen) {
      assert.equal(out.__image16.data[p + 3], 65535);
      for (let i = 0; i < out.data.length; i += 97) assert.equal(out.data[i], out.__image16.data[i] >>> 8, 'the 8-bit data follows the 16-bit plane');
    }
    const same = recoverFocusReference(soft, null);
    assert.deepEqual(same.data, soft.data, 'no plan: the frame as it is, in a new object');
    assert.notEqual(same.data, soft.data);
  }
}

// --- damping: grain-sized differences are left, where plain iterations would amplify them ---
{
  const w = 200, h = 200;
  const noisy = frameOf(new Float32Array(w * h).fill(100), w, h, { grain: 2 });
  const spread = (frame) => { let s = 0, q = 0, n = 0; for (let i = 0; i < frame.data.length; i += 4) { s += frame.data[i]; q += frame.data[i] ** 2; n++; } return Math.sqrt(q / n - (s / n) ** 2); };
  const damped = recoverFocusReference(noisy, { sigma: 2.5, damp: FOCUS_DAMP_MAX, iterations: FOCUS_ITERATIONS });
  const plain = recoverFocusReference(noisy, { sigma: 2.5, damp: 1e-6, iterations: FOCUS_ITERATIONS });
  assert.ok(spread(damped) < spread(noisy) * 1.6, `damped grain grows little (${spread(noisy).toFixed(2)} -> ${spread(damped).toFixed(2)})`);
  assert.ok(spread(plain) > spread(damped) * 1.1, `undamped it grows more (${spread(damped).toFixed(2)} against ${spread(plain).toFixed(2)})`);
}

console.log('focusRecovery: kernel, estimate, plan, tiles and the reference arithmetic');

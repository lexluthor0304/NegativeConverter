// Tests for the automatic gray-point estimator.
// Standalone node assert script, discovered by scripts/run-tests.mjs.
import assert from 'node:assert/strict';
import { estimateAutoWhiteBalance } from './autoWhiteBalance.js';

// --- helpers ---------------------------------------------------------------

function makeImage(width, height) {
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}

function setPixel(img, x, y, r, g, b) {
  const i = (y * img.width + x) * 4;
  img.data[i] = r;
  img.data[i + 1] = g;
  img.data[i + 2] = b;
  img.data[i + 3] = 255;
}

// Deterministic pseudo-random (no Math.random so failures reproduce).
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

const clamp8 = (v) => Math.max(0, Math.min(255, Math.round(v)));

/**
 * Scene: colored blocks + a real gray region, under a per-channel cast.
 * grayFraction of rows are neutral gray; the rest cycle saturated colors.
 */
function makeCastScene({ castR = 1, castB = 1, grayFraction = 0.3, size = 128, seed = 7 } = {}) {
  const img = makeImage(size, size);
  const rng = makeRng(seed);
  const grayRows = Math.round(size * grayFraction);
  const palette = [
    [190, 70, 60], [60, 170, 80], [70, 90, 200], [200, 160, 60],
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r;
      let g;
      let b;
      if (y < grayRows) {
        const v = 90 + Math.floor(rng() * 70); // mid-tone gray, slight variation
        r = v; g = v; b = v;
      } else {
        const c = palette[(Math.floor(x / 16) + Math.floor(y / 16)) % palette.length];
        const jitter = () => Math.floor(rng() * 20) - 10;
        r = c[0] + jitter(); g = c[1] + jitter(); b = c[2] + jitter();
      }
      setPixel(img, x, y, clamp8(r * castR), clamp8(g), clamp8(b * castB));
    }
  }
  return img;
}

function applyGains(img, { wbR, wbG, wbB }) {
  const out = makeImage(img.width, img.height);
  for (let i = 0; i < img.data.length; i += 4) {
    out.data[i] = clamp8(img.data[i] * wbR);
    out.data[i + 1] = clamp8(img.data[i + 1] * wbG);
    out.data[i + 2] = clamp8(img.data[i + 2] * wbB);
    out.data[i + 3] = 255;
  }
  return out;
}

const between = (v, lo, hi) => v >= lo && v <= hi;

// --- 1. warm cast over a scene with a gray region → recovered, high ---------
{
  // cast R×1.25 B×0.8 → ideal gains wbR=0.8 wbB=1.25 (G-normalized),
  // damped at 0.9 → wbR≈0.818, wbB≈1.222.
  const img = makeCastScene({ castR: 1.25, castB: 0.8 });
  const est = estimateAutoWhiteBalance(img);
  assert.equal(est.confidence, 'high', `expected high, got ${est.confidence} (coverage=${est.coverage.toFixed(3)}, disagreement=${est.disagreement.toFixed(3)})`);
  assert.ok(between(est.wbR, 0.78, 0.86), `wbR ${est.wbR}`);
  assert.ok(between(est.wbB, 1.17, 1.28), `wbB ${est.wbB}`);
  assert.equal(est.wbG, 1);

  // Applying the gains must actually neutralize the gray region (≤5% residual
  // channel imbalance — the 90% damping leaves ~2%).
  const corrected = applyGains(img, est);
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  const grayRows = Math.round(img.height * 0.3);
  for (let y = 0; y < grayRows; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      sumR += corrected.data[i]; sumG += corrected.data[i + 1]; sumB += corrected.data[i + 2];
    }
  }
  assert.ok(Math.abs(sumR / sumG - 1) < 0.05, `residual R/G ${(sumR / sumG).toFixed(3)}`);
  assert.ok(Math.abs(sumB / sumG - 1) < 0.05, `residual B/G ${(sumB / sumG).toFixed(3)}`);
}

// --- 2. cool cast recovers symmetrically ------------------------------------
{
  const img = makeCastScene({ castR: 0.82, castB: 1.2 });
  const est = estimateAutoWhiteBalance(img);
  assert.equal(est.confidence, 'high');
  assert.ok(est.wbR > 1.1, `wbR ${est.wbR}`);
  assert.ok(est.wbB < 0.92, `wbB ${est.wbB}`);
}

// --- 3. saturated scene with no neutrals → low, identity --------------------
{
  const img = makeCastScene({ grayFraction: 0 });
  const est = estimateAutoWhiteBalance(img);
  assert.equal(est.confidence, 'low');
  assert.deepEqual([est.wbR, est.wbG, est.wbB], [1, 1, 1]);
}

// --- 4. already-neutral image → identity-ish, high --------------------------
{
  const img = makeImage(96, 96);
  const rng = makeRng(3);
  for (let y = 0; y < 96; y++) {
    for (let x = 0; x < 96; x++) {
      const v = 40 + Math.floor(rng() * 170);
      setPixel(img, x, y, v, v, v);
    }
  }
  const est = estimateAutoWhiteBalance(img);
  assert.equal(est.confidence, 'high');
  assert.ok(Math.abs(est.wbR - 1) < 0.02, `wbR ${est.wbR}`);
  assert.ok(Math.abs(est.wbB - 1) < 0.02, `wbB ${est.wbB}`);
}

// --- 5. blown highlights with their own tint don't pollute the estimate -----
{
  const img = makeCastScene({ castR: 1.25, castB: 0.8 });
  // Overwrite a 12% band with near-clipped, blue-tinted "sky": outside the
  // luma window, so it must not shift the gains (and small enough to stay
  // under the clipped-frame pathology gate).
  const start = Math.round(img.height * 0.88);
  for (let y = start; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      setPixel(img, x, y, 246, 250, 255);
    }
  }
  const est = estimateAutoWhiteBalance(img);
  assert.equal(est.confidence, 'high');
  assert.ok(between(est.wbR, 0.78, 0.86), `wbR ${est.wbR}`);
  assert.ok(between(est.wbB, 1.17, 1.28), `wbB ${est.wbB}`);
}

// --- 5b. mostly-blown frame (thin negative) → low, untouched ----------------
{
  const img = makeCastScene({ castR: 1.25, castB: 0.8 });
  // Blow out 40% of the frame — a pathological conversion (e.g. underexposed
  // Harman Phoenix measured at 43% blown). The estimator must refuse.
  const start = Math.round(img.height * 0.6);
  for (let y = start; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      setPixel(img, x, y, 252, 248, 244);
    }
  }
  const est = estimateAutoWhiteBalance(img);
  assert.equal(est.confidence, 'low');
  assert.ok(est.clippedHigh > 0.2, `clippedHigh ${est.clippedHigh}`);
  assert.deepEqual([est.wbR, est.wbG, est.wbB], [1, 1, 1]);
}

// --- 6. idempotence: correcting then re-estimating lands near identity ------
{
  const img = makeCastScene({ castR: 1.25, castB: 0.8 });
  const first = estimateAutoWhiteBalance(img);
  const corrected = applyGains(img, first);
  const second = estimateAutoWhiteBalance(corrected);
  assert.ok(Math.abs(second.wbR - 1) < 0.05, `second wbR ${second.wbR}`);
  assert.ok(Math.abs(second.wbB - 1) < 0.05, `second wbB ${second.wbB}`);
}

// --- 7. degenerate inputs never throw, always low ---------------------------
{
  assert.equal(estimateAutoWhiteBalance(null).confidence, 'low');
  assert.equal(estimateAutoWhiteBalance({}).confidence, 'low');
  assert.equal(estimateAutoWhiteBalance(makeImage(4, 4)).confidence, 'low'); // tiny
  const black = makeImage(64, 64); // all pixels below lumaMin
  assert.equal(estimateAutoWhiteBalance(black).confidence, 'low');
}

// --- 8. gains always land inside the slider range ---------------------------
{
  const img = makeCastScene({ castR: 1.9, castB: 0.55 }); // absurd cast
  const est = estimateAutoWhiteBalance(img);
  // Whatever the verdict, outputs must respect [0.5, 2].
  assert.ok(est.wbR >= 0.5 && est.wbR <= 2, `wbR ${est.wbR}`);
  assert.ok(est.wbB >= 0.5 && est.wbB <= 2, `wbB ${est.wbB}`);
}

console.log('autoWhiteBalance tests: all passed');

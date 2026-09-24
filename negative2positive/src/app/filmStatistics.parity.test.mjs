// Parity test for the typed-array film statistics (#232 part 4a): the new
// sampleFilmBase / autoDetectFilmBase / detectFilmType must deep-equal the
// 1703835 comparator implementations (frozen in filmStatistics.reference.mjs)
// on 8-bit and 16-bit sources, alpha-0 pixels, images smaller than the radius
// cap and frames whose edge sets are empty.
import assert from 'node:assert/strict';
import { sampleFilmBase, autoDetectFilmBase } from './filmBaseDetection.js';
import { detectFilmType } from './filmTypeDetection.js';
import {
  sampleFilmBaseReference,
  autoDetectFilmBaseReference,
  detectFilmTypeReference
} from './filmStatistics.reference.mjs';

function makeRng(seed) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// scene(x, y, rnd) → [r, g, b, a] in 0..1 (a = 0 or 1)
function makeImage(width, height, scene, rnd, { sixteen = false, attach8 = true } = {}) {
  const data8 = new Uint8ClampedArray(width * height * 4);
  const data16 = sixteen ? new Uint16Array(width * height * 4) : null;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = scene(x, y, rnd);
      const i = (y * width + x) * 4;
      const vals = [r, g, b].map((v) => Math.max(0, Math.min(1, v)));
      for (let c = 0; c < 3; c++) {
        if (data16) data16[i + c] = Math.round(vals[c] * 65535);
        data8[i + c] = data16 ? data16[i + c] >>> 8 : Math.round(vals[c] * 255);
      }
      data8[i + 3] = a ? 255 : 0;
      if (data16) data16[i + 3] = a ? 65535 : 0;
    }
  }
  const image = { width, height, data: attach8 ? data8 : data16 || data8 };
  if (data16) image.__image16 = { width, height, data: data16 };
  return image;
}

const noisy = (rnd, v, amp) => v * (1 + (rnd() - 0.5) * amp);

const SCENES = {
  // orange rebate around a darker frame, with grain
  rebate: (edgeFrac) => (x, y, rnd, w, h) => {
    const edge = x < w * edgeFrac || x >= w * (1 - edgeFrac) || y < h * edgeFrac || y >= h * (1 - edgeFrac);
    return edge
      ? [noisy(rnd, 0.9, 0.04), noisy(rnd, 0.62, 0.04), noisy(rnd, 0.34, 0.04), 1]
      : [noisy(rnd, 0.5 + 0.2 * Math.sin(x / 9), 0.2), noisy(rnd, 0.3, 0.2), noisy(rnd, 0.15, 0.2), 1];
  },
  // borderless masked negative, orange and magenta regions
  mask: () => (x, y, rnd, w) => (x < w * 0.6
    ? [noisy(rnd, 0.72, 0.1), noisy(rnd, 0.38, 0.1), noisy(rnd, 0.2, 0.1), 1]
    : [noisy(rnd, 0.6, 0.1), noisy(rnd, 0.3, 0.1), noisy(rnd, 0.42, 0.1), 1]),
  // neutral B&W with clear thin rebates on two sides (and some clipped clear film)
  bw: () => (x, y, rnd, w) => {
    if (x < w * 0.02 || x >= w * 0.98) { const v = rnd() < 0.1 ? 1 : noisy(rnd, 0.88, 0.02); return [v, v, v, 1]; }
    const v = noisy(rnd, 0.15 + 0.4 * ((x + y) % 50) / 50, 0.05); return [v, v * 1.01, v * 0.99, 1];
  },
  // monochrome without rebate, tinted
  mono: () => (x, y, rnd) => { const v = noisy(rnd, 0.2 + 0.5 * ((x * 3 + y) % 80) / 80, 0.03); return [v * 1.1, v, v * 0.93, 1]; },
  // ordinary positive
  positive: () => (x, y, rnd, w, h) => (x < w / 3 ? [noisy(rnd, 0.27, 0.3), noisy(rnd, 0.5, 0.3), noisy(rnd, 0.75, 0.3), 1]
    : y < h / 2 ? [noisy(rnd, 0.16, 0.3), noisy(rnd, 0.6, 0.3), noisy(rnd, 0.2, 0.3), 1]
      : [noisy(rnd, 0.63, 0.3), noisy(rnd, 0.4, 0.3), noisy(rnd, 0.24, 0.3), 1]),
  // warm scene
  warm: () => (x, y, rnd, w) => (x < w * 0.55 ? [noisy(rnd, 0.7, 0.2), noisy(rnd, 0.42, 0.2), noisy(rnd, 0.2, 0.2), 1]
    : [noisy(rnd, 0.4, 0.2), noisy(rnd, 0.4, 0.2), noisy(rnd, 0.4, 0.2), 1]),
  // alpha-0 and black borders: edge sets end up empty
  holes: () => (x, y, rnd, w, h) => {
    const border = x < w * 0.06 || x >= w * 0.94 || y < h * 0.06 || y >= h * 0.94;
    if (border) return rnd() < 0.5 ? [0.5, 0.3, 0.2, 0] : [0.005, 0.004, 0.001, 1];
    if (rnd() < 0.05) return [0.5, 0.3, 0.2, 0];
    return [noisy(rnd, 0.6, 0.2), noisy(rnd, 0.35, 0.2), noisy(rnd, 0.2, 0.2), 1];
  },
  // coarse quantised steps: long runs of equal samples for the selection
  steps: () => (x, y, rnd) => { const v = Math.floor(rnd() * 4) / 4 + 0.1; return [v, v * 0.7, v * 0.4, 1]; },
  // flat field
  flat: () => () => [0.8, 0.55, 0.3, 1],
  // clipped highlights and deep shadows mixed
  extremes: () => (x, y, rnd) => (rnd() < 0.3 ? [1, 1, 1, 1] : rnd() < 0.3 ? [0, 0, 0, 1] : [rnd(), rnd(), rnd(), 1]),
};

const SIZES = [[7, 5], [20, 30], [64, 48], [160, 120], [211, 97], [301, 203]];
const BUFFERS = [0, 0.3, 5, 10, 12.5, 30, 45, -3, NaN, undefined];

let checks = 0;
const reasons = new Set();
let seed = 0;
for (const [name, factory] of Object.entries(SCENES)) {
  for (const [w, h] of SIZES) {
    for (const sixteen of [false, true]) {
      seed++;
      const rnd = makeRng(seed);
      const scene = factory(0.04 + rnd() * 0.08);
      const image = makeImage(w, h, (x, y, r) => scene(x, y, r, w, h), rnd, { sixteen });

      for (const buffer of BUFFERS.filter((_, k) => (k + seed) % 3 === 0 || k === 0 || k === 3 || k === 5)) {
        assert.deepEqual(autoDetectFilmBase(image, buffer), autoDetectFilmBaseReference(image, buffer),
          `autoDetectFilmBase ${name} ${w}x${h} ${sixteen ? 16 : 8}-bit buffer ${buffer}`);
        checks++;
      }
      for (let k = 0; k < 4; k++) {
        const x = Math.floor(rnd() * (w + 20)) - 10;
        const y = Math.floor(rnd() * (h + 20)) - 10;
        const radius = [1, 10, 40, 150][k];
        const options = k % 2 === 0 ? {} : { maxSamples: 64 + Math.floor(rnd() * 2000), trim: rnd() * 0.5 };
        assert.deepEqual(sampleFilmBase(image, x, y, radius, options), sampleFilmBaseReference(image, x, y, radius, options),
          `sampleFilmBase ${name} ${w}x${h} at ${x},${y} r${radius}`);
        checks++;
      }
      const want = detectFilmTypeReference(image);
      assert.deepEqual(detectFilmType(image), want, `detectFilmType ${name} ${w}x${h} ${sixteen ? 16 : 8}-bit`);
      if (w * h < 20000) assert.deepEqual(detectFilmType(image, { fallback: 'bw' }), detectFilmTypeReference(image, { fallback: 'bw' }));
      reasons.add(want.reason);
      checks += 2;
    }
  }
}

// A plain object without __image16 but with 16-bit data is read directly.
{
  const rnd = makeRng(999);
  const image = makeImage(300, 200, (x, y, r) => SCENES.rebate(0.08)(x, y, r, 300, 200), rnd, { sixteen: true, attach8: false });
  delete image.__image16;
  assert.deepEqual(detectFilmType(image), detectFilmTypeReference(image));
  assert.deepEqual(autoDetectFilmBase(image, 10), autoDetectFilmBaseReference(image, 10));
}

// Non-integer planes (not produced by the app) keep the plain sorts.
for (const Type of [Float64Array, Array]) {
  const rnd = makeRng(4242);
  const w = 120, h = 90;
  const data = new Type(w * h * 4);
  for (let i = 0; i < w * h * 4; i++) data[i] = (i & 3) === 3 ? (rnd() < 0.05 ? 0 : 255) : rnd() * 255;
  const image = { width: w, height: h, data };
  assert.deepEqual(detectFilmType(image), detectFilmTypeReference(image));
  for (const buffer of [0, 10, 30]) assert.deepEqual(autoDetectFilmBase(image, buffer), autoDetectFilmBaseReference(image, buffer));
  assert.deepEqual(sampleFilmBase(image, 60, 45, 30), sampleFilmBaseReference(image, 60, 45, 30));
}

// Every classifier branch was reached.
for (const reason of ['orangeRebate', 'orangeMask', 'clearRebate', 'monochrome', 'noMask', 'empty']) {
  assert.ok(reasons.has(reason), `no fixture reached ${reason} (got ${[...reasons].join(', ')})`);
}

// Degenerate inputs.
for (const input of [null, {}, { width: 0, height: 0, data: new Uint8ClampedArray(0) }]) {
  assert.deepEqual(detectFilmType(input), detectFilmTypeReference(input));
  assert.deepEqual(autoDetectFilmBase(input, 10), autoDetectFilmBaseReference(input, 10));
}

console.log(`film statistics parity passed (${checks} checks, reasons: ${[...reasons].sort().join(', ')})`);

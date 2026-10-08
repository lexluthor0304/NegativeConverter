// Standalone Node test for linearDng.js - run with:
// node negative2positive/src/app/linearDng.test.mjs

import assert from 'node:assert/strict';
import { buildLinearPositive, buildLinearPositiveAsync, buildLinearDngParts, encodeLinearDngBlob, DNG_TAGS, PHOTOMETRIC_LINEAR_RAW, XYZ_TO_LINEAR_SRGB, LITTLE_ENDIAN_HOST } from './linearDng.js';
import { parseTiff, TIFF_TAGS } from '../workers/tiffWriter.js';

const encode = (linear) => Math.round(Math.pow(Math.max(0, Math.min(1, linear)), 1 / 2.2) * 65535);
const W = 64; const H = 32;

// A synthetic negative: an orange base (transmittance 0.6/0.4/0.25) with a
// scene whose density rises left to right; a dense (dark) negative pixel is
// a bright positive pixel.
const base = { r: 0.6, g: 0.4, b: 0.25 };
const negative = new Uint16Array(W * H * 4);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const o = (y * W + x) * 4;
  const scene = 0.05 + 0.95 * (x / (W - 1)); // linear scene luminance
  // negative transmittance = base * (1 / scene) clipped: bright scene -> dense negative
  const t = Math.min(1, 0.06 / scene);
  negative[o] = encode(base.r * t); negative[o + 1] = encode(base.g * t); negative[o + 2] = encode(base.b * t); negative[o + 3] = 65535;
}
const filmBase = { r: encode(base.r) / 257, g: encode(base.g) / 257, b: encode(base.b) / 257 };

// Inversion: brighter scene -> brighter positive, neutral (the base colour is divided out).
{
  const positive = buildLinearPositive({ width: W, height: H, data: negative }, filmBase);
  assert.equal(positive.data.length, W * H * 3);
  const at = (x) => [positive.data[x * 3], positive.data[x * 3 + 1], positive.data[x * 3 + 2]];
  const dark = at(0); const bright = at(W - 1);
  assert.ok(bright[1] > dark[1] * 5, `bright end ${bright[1]} vs dark end ${dark[1]}`);
  assert.ok(bright[1] >= 65000, 'the brightest pixels sit at white');
  for (let x = 0; x < W; x += 8) {
    const [r, g, b] = at(x);
    assert.ok(Math.abs(r - g) < g * 0.03 + 60 && Math.abs(b - g) < g * 0.03 + 60, `neutral after base normalisation at ${x}: ${r},${g},${b}`);
  }
  // Monotone along the gradient.
  for (let x = 1; x < W; x++) assert.ok(positive.data[x * 3 + 1] >= positive.data[(x - 1) * 3 + 1]);
  // Linear: the positive tracks the scene luminance linearly, not through a gamma.
  const mid = positive.data[(W >> 1) * 3 + 1] / positive.data[(W - 1) * 3 + 1];
  const sceneMid = (0.05 + 0.95 * ((W >> 1) / (W - 1))) / 1.0;
  assert.ok(Math.abs(mid - sceneMid) < 0.08, `mid-grey ratio ${mid.toFixed(3)} vs scene ${sceneMid.toFixed(3)}`);
  // Without a film base the brightest samples stand in for it.
  const noBase = buildLinearPositive({ width: W, height: H, data: negative }, null);
  assert.ok(noBase.data[(W - 1) * 3 + 1] >= 65000);
  // A positive source passes through with only the white normalisation.
  const slide = buildLinearPositive({ width: W, height: H, data: negative }, null, { positive: true });
  assert.ok(slide.data[0] > slide.data[(W - 1) * 3], 'a positive keeps its orientation');
}

// DNG structure: the tags Lightroom needs to accept a LinearRaw file.
{
  const positive = buildLinearPositive({ width: W, height: H, data: negative }, filmBase);
  const parts = buildLinearDngParts(positive, { metadata: { exif: { model: 'Nikon FM2', dateTime: '2026:09:06 00:00:00' }, xmp: '<x:xmpmeta/>' } });
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { bytes.set(p, o); o += p.length; }
  const { ifd0 } = parseTiff(bytes);
  assert.deepEqual(ifd0[TIFF_TAGS.PhotometricInterpretation].values, [PHOTOMETRIC_LINEAR_RAW]);
  assert.deepEqual(ifd0[TIFF_TAGS.BitsPerSample].values, [16, 16, 16]);
  assert.deepEqual(ifd0[TIFF_TAGS.SamplesPerPixel].values, [3]);
  assert.deepEqual(Array.from(ifd0[DNG_TAGS.DNGVersion].raw), [1, 4, 0, 0]);
  assert.deepEqual(Array.from(ifd0[DNG_TAGS.DNGBackwardVersion].raw), [1, 1, 0, 0]);
  assert.equal(ifd0[DNG_TAGS.UniqueCameraModel].values, 'NeoAnalogLab Negative Converter');
  assert.equal(ifd0[DNG_TAGS.ColorMatrix1].count, 9);
  assert.ok(Math.abs(ifd0[DNG_TAGS.ColorMatrix1].values[0][0] / ifd0[DNG_TAGS.ColorMatrix1].values[0][1] - XYZ_TO_LINEAR_SRGB[0]) < 1e-3);
  assert.deepEqual(ifd0[DNG_TAGS.AsShotNeutral].values, [[1, 1], [1, 1], [1, 1]]);
  assert.deepEqual(ifd0[DNG_TAGS.WhiteLevel].values, [65535, 65535, 65535]);
  assert.deepEqual(ifd0[DNG_TAGS.BlackLevel].values, [[0, 1], [0, 1], [0, 1]]);
  assert.deepEqual(ifd0[DNG_TAGS.CalibrationIlluminant1].values, [21]);
  assert.deepEqual(ifd0[DNG_TAGS.DefaultCropSize].values, [W, H]);
  assert.equal(ifd0[TIFF_TAGS.Model].values, 'Nikon FM2');
  assert.equal(ifd0[TIFF_TAGS.DateTime].values, '2026:09:06 00:00:00');
  assert.equal(new TextDecoder().decode(ifd0[TIFF_TAGS.XMP].raw), '<x:xmpmeta/>');
  assert.deepEqual(ifd0[TIFF_TAGS.StripByteCounts].values, [W * H * 3 * 2]);
  const stripOffset = ifd0[TIFF_TAGS.StripOffsets].values[0];
  const first = bytes[stripOffset] | (bytes[stripOffset + 1] << 8);
  assert.equal(first, positive.data[0], 'strip holds little-endian 16-bit samples');
  const blob = encodeLinearDngBlob(positive);
  assert.equal(blob.type, 'image/x-adobe-dng');
  assert.equal(blob.size, bytes.length - (parts[0].length - buildLinearDngParts(positive)[0].length));
}

// ---------------------------------------------------------------------------
// #257: the table kernel against a frozen copy of the per-pixel kernel it
// replaced, on seeded random frames of 2 MP and more. `data` and `gain` must
// be identical element by element, and so must the DNG bytes.
const HEAD = (() => {
  const STEPS = 4096;
  const LINEAR = new Float32Array(STEPS + 1);
  for (let i = 0; i <= STEPS; i++) LINEAR[i] = Math.pow(i / STEPS, 2.2);
  const toLinear16 = (value) => {
    const idx = (value / 65535) * STEPS;
    const i0 = idx | 0;
    const f = idx - i0;
    return LINEAR[i0] * (1 - f) + LINEAR[Math.min(STEPS, i0 + 1)] * f;
  };
  function buildLinearPositive(image16, filmBase, { whitePercentile = 0.999, positive = false } = {}) {
    const { width, height, data } = image16;
    const pixels = width * height;
    const out = new Uint16Array(pixels * 3);
    const base = filmBase && [filmBase.r, filmBase.g, filmBase.b].every((v) => Number.isFinite(v) && v > 0)
      ? [filmBase.r, filmBase.g, filmBase.b].map((v) => Math.max(1e-4, toLinear16(Math.min(255, v) * 257)))
      : null;
    const linear = new Float32Array(pixels * 3);
    const floor = 1 / 65535;
    for (let p = 0; p < pixels; p++) {
      const o = p * 4;
      for (let c = 0; c < 3; c++) {
        const neg = Math.max(floor, toLinear16(data[o + c]));
        linear[p * 3 + c] = positive ? neg : (base ? base[c] / neg : 1 / neg);
      }
    }
    const gain = [1, 1, 1];
    const sampleStep = Math.max(1, Math.floor(pixels / 200000));
    for (let c = 0; c < 3; c++) {
      const samples = [];
      for (let p = 0; p < pixels; p += sampleStep) samples.push(linear[p * 3 + c]);
      samples.sort((a, b) => a - b);
      const white = samples[Math.min(samples.length - 1, Math.floor(samples.length * whitePercentile))] || 1;
      gain[c] = 1 / white;
    }
    for (let p = 0; p < pixels; p++) {
      for (let c = 0; c < 3; c++) {
        const v = linear[p * 3 + c] * gain[c];
        out[p * 3 + c] = v >= 1 ? 65535 : v <= 0 ? 0 : Math.round(v * 65535);
      }
    }
    return { width, height, data: out, gain };
  }
  function stripOf(data) {
    const strip = new Uint8Array(data.length * 2);
    const view = new DataView(strip.buffer);
    for (let i = 0; i < data.length; i++) view.setUint16(i * 2, data[i], true);
    return strip;
  }
  return { buildLinearPositive, stripOf };
})();

const concat = (parts) => {
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { bytes.set(p, at); at += p.length; }
  return bytes;
};
const sameElements = (a, b, label) => {
  assert.equal(a.length, b.length, `${label}: length`);
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) assert.fail(`${label}: element ${i} is ${a[i]}, HEAD ${b[i]}`);
  }
};

let seed = 0x2570;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed;
};
function randomNegative(width, height, { extremes = false } = {}) {
  const data = new Uint16Array(width * height * 4);
  for (let i = 0; i < data.length; i++) {
    if (i % 4 === 3) { data[i] = 65535; continue; }
    const r = random();
    // Mostly a mid-density negative, with the whole range represented.
    data[i] = extremes && (r & 15) === 0 ? ((r >>> 4) & 1 ? 65535 : 0) : (r & 3) === 0 ? r >>> 16 : 8000 + ((r >>> 16) % 30000);
  }
  return { width, height, data };
}

const RealFloat32Array = globalThis.Float32Array;
const RealUint8Array = globalThis.Uint8Array;
{
  const W2 = 1733, H2 = 1201; // 2.08 MP, odd sizes
  const cases = [
    ['film base', randomNegative(W2, H2), { r: 212, g: 131, b: 77 }, {}],
    ['no film base', randomNegative(W2, H2), null, {}],
    ['positive', randomNegative(W2, H2), null, { positive: true }],
    ['0 and 65535 samples', randomNegative(W2, H2, { extremes: true }), { r: 255, g: 1, b: 0.5 }, {}],
    // Smaller frames for the remaining branches.
    ['positive with a base', randomNegative(701, 433), { r: 200, g: 120, b: 60 }, { positive: true }],
    ['0 and 65535, no base', randomNegative(701, 433, { extremes: true }), null, {}],
    ['invalid base ignored', randomNegative(333, 211), { r: 0, g: 40, b: NaN }, { whitePercentile: 0.99 }]
  ];
  for (const [label, image, base, options] of cases) {
    const { width, height } = image;
    const head = HEAD.buildLinearPositive(image, base, options);
    // No pixels*3 Float32Array and no second pixels*6-byte strip.
    const allocations = [];
    globalThis.Float32Array = class extends RealFloat32Array {
      constructor(...args) { super(...args); if (typeof args[0] === 'number') allocations.push(['Float32Array', args[0]]); }
    };
    globalThis.Uint8Array = class extends RealUint8Array {
      constructor(...args) { super(...args); if (typeof args[0] === 'number') allocations.push(['Uint8Array', args[0]]); }
    };
    let table, parts;
    try {
      table = buildLinearPositive(image, base, options);
      parts = buildLinearDngParts(table);
    } finally {
      globalThis.Float32Array = RealFloat32Array;
      globalThis.Uint8Array = RealUint8Array;
    }
    const pixels = width * height;
    const frameSized = allocations.filter(([type, length]) => (type === 'Float32Array' ? length >= pixels * 3 : length >= pixels * 6));
    assert.deepEqual(frameSized, [], `${label}: no pixels*3 Float32Array and no second pixels*6-byte strip`);
    sameElements(table.gain, head.gain, `${label} gain`);
    sameElements(table.data, head.data, `${label} data`);
    // DNG bytes: header plus strip, identical to HEAD's DataView strip.
    const headParts = buildLinearDngParts(head, { littleEndianHost: false });
    const bytes = concat(parts);
    assert.deepEqual(bytes, concat(headParts), `${label}: DNG bytes`);
    assert.deepEqual(concat(headParts).subarray(parts[0].length, parts[0].length + head.data.length * 2), HEAD.stripOf(head.data));
    // The forced big-endian fallback writes the same bytes.
    assert.deepEqual(concat(buildLinearDngParts(table, { littleEndianHost: false })), bytes, `${label}: big-endian fallback`);
    // The yielding batch build: same result, in several slices.
    let clock = 0;
    let yields = 0;
    const sliced = await buildLinearPositiveAsync(image, base, options, {
      sliceMs: 16,
      now: () => (clock += 20), // every check is past the slice budget
      yieldTask: async () => { yields++; }
    });
    // Three percentile steps, then one slice per 8 rows of the output pass.
    assert.equal(yields, 3 + Math.floor((height - 1) / 8), `${label}: the output pass yields between row slices`);
    sameElements(sliced.gain, head.gain, `${label} async gain`);
    sameElements(sliced.data, head.data, `${label} async data`);
  }
  // With a real clock and task, a batch build still matches and can be cancelled between slices.
  const image = randomNegative(640, 480);
  const real = await buildLinearPositiveAsync(image, { r: 190, g: 120, b: 70 }, {}, { sliceMs: 1 });
  sameElements(real.data, HEAD.buildLinearPositive(image, { r: 190, g: 120, b: 70 }).data, 'real-clock async');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(buildLinearPositiveAsync(image, null, {}, { signal: controller.signal }), (err) => err.name === 'AbortError');
  assert.equal(LITTLE_ENDIAN_HOST, true, 'every shipped target is little-endian');
}

console.log('linearDng.test.mjs passed');

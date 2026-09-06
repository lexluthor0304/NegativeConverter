// Standalone Node test for linearDng.js - run with:
// node negative2positive/src/app/linearDng.test.mjs

import assert from 'node:assert/strict';
import { buildLinearPositive, buildLinearDngParts, encodeLinearDngBlob, DNG_TAGS, PHOTOMETRIC_LINEAR_RAW, XYZ_TO_LINEAR_SRGB } from './linearDng.js';
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

console.log('linearDng.test.mjs passed');

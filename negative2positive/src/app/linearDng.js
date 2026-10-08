// Linear DNG export: the negative inverted and film-base normalised in
// linear light, written as a demosaiced 16-bit LinearRaw DNG so Lightroom
// and Capture One open it as raw with white balance and exposure latitude
// intact. No tone curve is baked in. Pure functions; the TIFF structure
// comes from workers/tiffWriter.js.

import {
  buildTiffParts, asciiEntry, shortEntry, longEntry, bytesEntry, rationalEntry, srationalEntry, TIFF_TAGS, TIFF_TYPES
} from '../workers/tiffWriter.js';

export const DNG_TAGS = Object.freeze({
  DNGVersion: 50706, DNGBackwardVersion: 50707, UniqueCameraModel: 50708, BlackLevel: 50714,
  WhiteLevel: 50717, DefaultCropOrigin: 50719, DefaultCropSize: 50720, ColorMatrix1: 50721,
  AsShotNeutral: 50728, BaselineExposure: 50730, CalibrationIlluminant1: 50778
});
export const PHOTOMETRIC_LINEAR_RAW = 34892;

// XYZ (D65) -> linear sRGB. The DNG "camera" space of the file is linear
// sRGB, so ColorMatrix1 (XYZ -> camera) is exactly this matrix.
export const XYZ_TO_LINEAR_SRGB = Object.freeze([
  3.2406, -1.5372, -0.4986,
  -0.9689, 1.8758, 0.0415,
  0.0557, -0.2040, 1.0570
]);

const STEPS = 4096;
const LINEAR = new Float32Array(STEPS + 1);
for (let i = 0; i <= STEPS; i++) LINEAR[i] = Math.pow(i / STEPS, 2.2);

function toLinear16(value) {
  const idx = (value / 65535) * STEPS;
  const i0 = idx | 0;
  const f = idx - i0;
  return LINEAR[i0] * (1 - f) + LINEAR[Math.min(STEPS, i0 + 1)] * f;
}

/** True when typed arrays store 16-bit samples little-endian (every shipped target). */
export const LITTLE_ENDIAN_HOST = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

// Once the film base, film type and gain are fixed, an output sample depends
// only on its channel and its 16-bit input code, so the kernel is two table
// lookups. `linLut[c][v]` holds exactly the Float32 value the per-pixel
// buffer used to hold for that code (a Float32Array store rounds the same
// way), and `outLut[c][v]` applies the gain and rounding to it, so the output
// is bit-identical to the per-pixel kernel it replaced (#257).
function linearTables(filmBase, positive) {
  const base = filmBase && [filmBase.r, filmBase.g, filmBase.b].every((v) => Number.isFinite(v) && v > 0)
    ? [filmBase.r, filmBase.g, filmBase.b].map((v) => Math.max(1e-4, toLinear16(Math.min(255, v) * 257)))
    : null;
  const floor = 1 / 65535;
  const neg = new Float64Array(65536);
  for (let v = 0; v < 65536; v++) neg[v] = Math.max(floor, toLinear16(v));
  const shared = !base ? new Float32Array(65536) : null;
  if (shared) for (let v = 0; v < 65536; v++) shared[v] = positive ? neg[v] : 1 / neg[v];
  return [0, 1, 2].map((c) => {
    if (shared) return shared;
    const table = new Float32Array(65536);
    for (let v = 0; v < 65536; v++) table[v] = positive ? neg[v] : base[c] / neg[v];
    return table;
  });
}

// The kernel as steps: it yields after each channel's percentile and, when
// `shouldYield()` says so, between rows of the output pass. The synchronous
// build runs every step at once; the batch build waits a task in between.
function* linearPositiveSteps(image16, filmBase, { whitePercentile = 0.999, positive = false } = {}, shouldYield = () => false) {
  const { width, height, data } = image16;
  const pixels = width * height;
  const linLut = linearTables(filmBase, positive);
  // White per channel from the percentile so a few specular holes do not
  // decide the exposure; the gain is reported for the metadata. The samples
  // are the same strided positions as before; every value is finite and
  // positive, so the typed array's numeric sort puts the same element at the
  // percentile index as a comparator sort.
  const gain = [1, 1, 1];
  const sampleStep = Math.max(1, Math.floor(pixels / 200000));
  const sampleCount = Math.ceil(pixels / sampleStep);
  for (let c = 0; c < 3; c++) {
    const lut = linLut[c];
    const samples = new Float32Array(sampleCount);
    for (let p = 0, i = 0; p < pixels; p += sampleStep, i++) samples[i] = lut[data[p * 4 + c]];
    samples.sort();
    const white = samples[Math.min(samples.length - 1, Math.floor(samples.length * whitePercentile))] || 1;
    gain[c] = 1 / white;
    yield;
  }
  const outLut = linLut.map((lut, c) => {
    const table = new Uint16Array(65536);
    for (let v = 0; v < 65536; v++) {
      const x = lut[v] * gain[c];
      table[v] = x >= 1 ? 65535 : x <= 0 ? 0 : Math.round(x * 65535);
    }
    return table;
  });
  const [outR, outG, outB] = outLut;
  const out = new Uint16Array(pixels * 3);
  for (let y = 0; y < height; y++) {
    for (let o = y * width * 4, q = y * width * 3, end = o + width * 4; o < end; o += 4, q += 3) {
      out[q] = outR[data[o]];
      out[q + 1] = outG[data[o + 1]];
      out[q + 2] = outB[data[o + 2]];
    }
    if ((y & 7) === 7 && y + 1 < height && shouldYield()) yield;
  }
  return { width, height, data: out, gain };
}

/**
 * Inverts a negative into a linear positive, normalised by the film base:
 * positive = base / negative in linear light per channel, then scaled so the
 * `whitePercentile` brightest pixels sit at the white level. The film base
 * is what the unexposed rebate transmits (0..255 per channel, as the app
 * samples it); when it is missing, the brightest pixels stand in for it.
 *
 * @param {{width:number,height:number,data:Uint16Array}} image16 RGBA negative
 * @param {{r:number,g:number,b:number}|null} filmBase 0..255 per channel
 * @returns {{width:number,height:number,data:Uint16Array,gain:number[]}} RGB (3 samples) linear positive
 */
export function buildLinearPositive(image16, filmBase, options = {}) {
  const steps = linearPositiveSteps(image16, filmBase, options);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

// A message task rather than a timer: hidden windows throttle timers, and a
// desktop batch may run in one (#241).
function yieldToEventLoop() {
  if (typeof MessageChannel !== 'function') return new Promise((resolve) => setTimeout(resolve, 0));
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/**
 * `buildLinearPositive` in slices of about `sliceMs`, waiting a task between
 * them, for the desktop batch, whose editor stays live while frames build.
 * Same result. The caller must own `image16` for the duration (the batch's
 * own decoded source), since other tasks run between slices.
 *
 * @param {object} [schedule]
 * @param {number} [schedule.sliceMs]
 * @param {() => Promise<void>} [schedule.yieldTask]
 * @param {() => number} [schedule.now]
 * @param {AbortSignal} [schedule.signal] checked between slices
 */
export async function buildLinearPositiveAsync(image16, filmBase, options = {}, {
  sliceMs = 16,
  yieldTask = yieldToEventLoop,
  now = () => performance.now(),
  signal = null
} = {}) {
  let sliceStart = now();
  const steps = linearPositiveSteps(image16, filmBase, options, () => now() - sliceStart >= sliceMs);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    await yieldTask();
    if (signal && signal.aborted) {
      const err = new Error('Linear DNG build cancelled');
      err.name = 'AbortError';
      throw err;
    }
    sliceStart = now();
  }
}

/**
 * Writes a LinearRaw DNG (DNG 1.4, backward 1.1): 16-bit RGB, no CFA, white
 * level 65535, black level 0, D65 colour matrix for linear sRGB primaries,
 * AsShotNeutral 1/1/1 because the film base normalisation already balanced
 * the frame. `metadata` (analog EXIF fields + XMP) is optional.
 *
 * @returns {Uint8Array[]} parts for a Blob
 */
export function buildLinearDngParts(linear, { metadata = null, software = 'NeoAnalogLab Negative Converter', model = 'NeoAnalogLab Negative Converter', littleEndianHost = LITTLE_ENDIAN_HOST } = {}) {
  const { width, height, data } = linear;
  // The strip is little-endian 16-bit samples: on a little-endian host that is
  // exactly the bytes of `data`, so the strip is a view of it, not a copy.
  let strip;
  if (littleEndianHost) {
    strip = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else {
    strip = new Uint8Array(data.length * 2);
    const view = new DataView(strip.buffer);
    for (let i = 0; i < data.length; i++) view.setUint16(i * 2, data[i], true);
  }
  const exif = metadata?.exif || {};
  const entries = [
    longEntry(TIFF_TAGS.NewSubfileType, 0),
    longEntry(TIFF_TAGS.ImageWidth, width),
    longEntry(TIFF_TAGS.ImageLength, height),
    shortEntry(TIFF_TAGS.BitsPerSample, [16, 16, 16]),
    shortEntry(TIFF_TAGS.Compression, 1),
    shortEntry(TIFF_TAGS.PhotometricInterpretation, PHOTOMETRIC_LINEAR_RAW),
    asciiEntry(TIFF_TAGS.Make, exif.make || 'NeoAnalogLab'),
    asciiEntry(TIFF_TAGS.Model, exif.model || model),
    shortEntry(TIFF_TAGS.Orientation, 1),
    shortEntry(TIFF_TAGS.SamplesPerPixel, 3),
    longEntry(TIFF_TAGS.RowsPerStrip, height),
    longEntry(TIFF_TAGS.StripByteCounts, strip.length),
    shortEntry(TIFF_TAGS.PlanarConfiguration, 1),
    asciiEntry(TIFF_TAGS.Software, exif.software || software),
    bytesEntry(DNG_TAGS.DNGVersion, new Uint8Array([1, 4, 0, 0]), TIFF_TYPES.BYTE),
    bytesEntry(DNG_TAGS.DNGBackwardVersion, new Uint8Array([1, 1, 0, 0]), TIFF_TYPES.BYTE),
    asciiEntry(DNG_TAGS.UniqueCameraModel, model),
    rationalEntry(DNG_TAGS.BlackLevel, [[0, 1], [0, 1], [0, 1]]),
    longEntry(DNG_TAGS.WhiteLevel, [65535, 65535, 65535]),
    longEntry(DNG_TAGS.DefaultCropOrigin, [0, 0]),
    longEntry(DNG_TAGS.DefaultCropSize, [width, height]),
    srationalEntry(DNG_TAGS.ColorMatrix1, XYZ_TO_LINEAR_SRGB.map((v) => [Math.round(v * 10000), 10000])),
    rationalEntry(DNG_TAGS.AsShotNeutral, [[1, 1], [1, 1], [1, 1]]),
    srationalEntry(DNG_TAGS.BaselineExposure, [[0, 100]]),
    shortEntry(DNG_TAGS.CalibrationIlluminant1, 21)
  ];
  if (exif.dateTime) entries.push(asciiEntry(TIFF_TAGS.DateTime, exif.dateTime));
  if (exif.imageDescription) entries.push(asciiEntry(TIFF_TAGS.ImageDescription, exif.imageDescription));
  if (metadata?.xmp) entries.push(bytesEntry(TIFF_TAGS.XMP, new TextEncoder().encode(metadata.xmp), TIFF_TYPES.BYTE));
  return buildTiffParts({ entries, blocks: [{ tag: TIFF_TAGS.StripOffsets, bytes: strip }] });
}

export function encodeLinearDngBlob(linear, options = {}) {
  return new Blob(buildLinearDngParts(linear, options), { type: 'image/x-adobe-dng' });
}

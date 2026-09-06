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
export function buildLinearPositive(image16, filmBase, { whitePercentile = 0.999, positive = false } = {}) {
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
  // White per channel from the percentile so a few specular holes do not
  // decide the exposure; the gain is reported for the metadata.
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

/**
 * Writes a LinearRaw DNG (DNG 1.4, backward 1.1): 16-bit RGB, no CFA, white
 * level 65535, black level 0, D65 colour matrix for linear sRGB primaries,
 * AsShotNeutral 1/1/1 because the film base normalisation already balanced
 * the frame. `metadata` (analog EXIF fields + XMP) is optional.
 *
 * @returns {Uint8Array[]} parts for a Blob
 */
export function buildLinearDngParts(linear, { metadata = null, software = 'NeoAnalogLab Negative Converter', model = 'NeoAnalogLab Negative Converter' } = {}) {
  const { width, height, data } = linear;
  const strip = new Uint8Array(data.length * 2);
  const view = new DataView(strip.buffer);
  for (let i = 0; i < data.length; i++) view.setUint16(i * 2, data[i], true);
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

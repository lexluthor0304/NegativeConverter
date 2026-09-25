// Deterministic synthetic benchmark fixtures (docs/performance-benchmark.md).
//
//   node scripts/perf/fixtures.mjs [--out DIR] [--only a,b] [--jpeg chrome|stub]
//
// The scene extends the orange-mask gradient of make-technical-fixtures.mjs
// with a film rebate (sprocket holes through to the light source), frame
// edges and grain, so film-base, auto-frame and edge analysis run on
// realistic input. Rows are generated and written in bands, so the generator
// stays far below 300 MB RSS at 60 MP.
//
// - 16-bit RGB colour-negative TIFFs (24 and 60 MP) and a 60 MP B&W one.
// - RGGB CFA DNGs (24 and 60 MP) with 12-bit packed samples, so a 60 MP file
//   is about 86 MiB and stays under the 100 MiB heavy-RAW threshold (the M11
//   files take the full-decode route too). The header and IFD0 come from the
//   app's own buildTiffParts; the strip is streamed after them. Three JPEG
//   previews like the M11's (full size, 2112×1408, 720×480) hang off
//   SubIFDs. The repo has no JPEG encoder, so the harness's Chrome encodes
//   them; their bytes are stable per Chrome version.
// - A 12-frame roll of the 60 MP DNG with different seeds.
// Nothing in the first 1000 bytes says "iPhone" (that routes DNGs to UTIF).

import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTiffParts, asciiEntry, shortEntry, longEntry, bytesEntry, rationalEntry, srationalEntry, TIFF_TAGS, TIFF_TYPES
} from '../../negative2positive/src/workers/tiffWriter.js';
import { DNG_TAGS, XYZ_TO_LINEAR_SRGB } from '../../negative2positive/src/app/linearDng.js';
import { freeDiskBytes, MIN_FREE_DISK_BYTES, GiB } from './lib/guards.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const GENERATOR_VERSION = 1;
export const SIZE_60MP = Object.freeze({ width: 9536, height: 6336 });
export const SIZE_24MP = Object.freeze({ width: 6000, height: 4000 });
export const HEAVY_RAW_BYTES = 100 * 1024 * 1024;
const BAND_ROWS = 64;

export const CFA_TAGS = Object.freeze({ CFARepeatPatternDim: 33421, CFAPattern: 33422, SubIFDs: 330, CFAPlaneColor: 50710, CFALayout: 50711 });

/**
 * The scene: what the scanner/camera sees through the negative, as linear
 * transmittance 0..1 per channel. Self-contained (no outer references) so
 * the harness can ship its source to Chrome for the JPEG previews.
 */
export function sceneSample(out, x, y, width, height, seed, kind, grain) {
  function noise(ix, iy) {
    var h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  var u = x / width, v = y / height;
  var bw = kind === 'bw';
  var baseR = bw ? 0.80 : 0.93, baseG = bw ? 0.80 : 0.62, baseB = bw ? 0.78 : 0.40;
  var top = 0.085, bottom = 0.915, left = 0.022, right = 0.978;
  var g = grain ? 1 + grain * (noise(x, y) - 0.5) : 1;
  if (v < top || v > bottom) {
    // Rebate with sprocket holes (8 per frame) through to the light source.
    var band = v < top ? v / top : (v - bottom) / (1 - bottom);
    var phase = ((u + 0.031 + (seed % 7) * 0.002) % 0.125) / 0.125;
    if (band > 0.3 && band < 0.72 && phase > 0.24 && phase < 0.63) { out[0] = 0.985; out[1] = 0.985; out[2] = 0.985; return out; }
    out[0] = baseR * g; out[1] = baseG * g; out[2] = baseB * g;
    return out;
  }
  if (u < left || u > right) { out[0] = baseR * g; out[1] = baseG * g; out[2] = baseB * g; return out; }
  // Image area: a positive scene (sky, sun, horizon, a building, bars).
  var fu = (u - left) / (right - left), fv = (v - top) / (bottom - top);
  var shift = ((seed * 2654435761) >>> 0) / 4294967296;
  var horizon = 0.55 + 0.08 * Math.sin(fu * 6.283 + shift * 6.283);
  var r, gg, b;
  if (fv < horizon) {
    var sky = 0.35 + 0.5 * (1 - fv / horizon);
    r = sky * 0.70; gg = sky * 0.82; b = sky;
    var dx = fu - (0.62 + 0.2 * shift), dy = (fv - 0.25) * (height / width) * 1.5;
    var sun = Math.sqrt(dx * dx + dy * dy);
    if (sun < 0.06) { r = 0.98; gg = 0.95; b = 0.85; } else if (sun < 0.12) { var k = (0.12 - sun) / 0.06; r += 0.4 * k; gg += 0.35 * k; b += 0.2 * k; }
  } else {
    var ground = 0.18 + 0.35 * ((fv - horizon) / (1 - horizon)) + 0.08 * Math.sin(fu * 40 + fv * 25);
    r = ground * 0.85; gg = ground; b = ground * 0.55;
  }
  if (fu > 0.12 && fu < 0.3 && fv > horizon - 0.25 && fv < horizon + 0.05) { r = 0.55; gg = 0.42; b = 0.36; if (((fu * 60) | 0) % 3 === 0 && ((fv * 50) | 0) % 2 === 0) { r = 0.9; gg = 0.85; b = 0.55; } }
  if (fv > 0.86 && fv < 0.93) { var bar = (fu * 8) | 0; r = bar / 7; gg = bar / 7; b = bar / 7; }
  if (bw) { var l = 0.3 * r + 0.59 * gg + 0.11 * b; r = l; gg = l; b = l; }
  r = r > 1 ? 1 : r; gg = gg > 1 ? 1 : gg; b = b > 1 ? 1 : b;
  // Negative: dense where the scene is bright, on top of the film base.
  out[0] = baseR * (1 - 0.86 * Math.pow(r, 0.8)) * g;
  out[1] = baseG * (1 - 0.86 * Math.pow(gg, 0.8)) * g;
  out[2] = baseB * (1 - 0.86 * Math.pow(b, 0.8)) * g;
  return out;
}

const GRAIN = 0.03;

export function previewSizes({ width, height }) {
  const full = { width: width - 32, height: height - 16, role: 'full' };
  return [full, { width: 2112, height: 1408, role: 'medium' }, { width: 720, height: 480, role: 'small' }];
}

export function syntheticFixtureSpecs({ rollSize = 12 } = {}) {
  const specs = [
    { name: 'synthetic-24mp-color.tif', format: 'tiff', kind: 'color', seed: 11, ...SIZE_24MP },
    { name: 'synthetic-60mp-color.tif', format: 'tiff', kind: 'color', seed: 12, ...SIZE_60MP },
    { name: 'synthetic-60mp-bw.tif', format: 'tiff', kind: 'bw', seed: 13, ...SIZE_60MP },
    { name: 'synthetic-24mp-cfa.dng', format: 'dng', kind: 'color', seed: 21, ...SIZE_24MP },
    { name: 'synthetic-60mp-cfa.dng', format: 'dng', kind: 'color', seed: 22, ...SIZE_60MP }
  ];
  for (let i = 1; i <= rollSize; i++) {
    specs.push({ name: `synthetic-roll-${String(i).padStart(2, '0')}.dng`, format: 'dng', kind: 'color', seed: 100 + i, roll: true, ...SIZE_60MP });
  }
  return specs;
}

export function tiffStripBytes({ width, height }) {
  return width * height * 6;
}

export function cfaStripBytes({ width, height }) {
  if (width % 2) throw new Error('12-bit packing needs an even width');
  return width * height * 3 / 2;
}

/** Upper bound of a DNG's size before its previews are encoded. */
export function estimateDngBytes(size, previewBytes = [6 * 1024 * 1024, 450 * 1024, 60 * 1024]) {
  return cfaStripBytes(size) + previewBytes.reduce((a, b) => a + b, 0) + 16 * 1024;
}

function writeAll(fd, hash, bytes) {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
  hash.update(bytes);
}

// ---- TIFF (16-bit RGB) ----

function tiffEntries({ width, height, kind, seed }, stripLength) {
  return [
    longEntry(TIFF_TAGS.NewSubfileType, 0),
    longEntry(TIFF_TAGS.ImageWidth, width),
    longEntry(TIFF_TAGS.ImageLength, height),
    shortEntry(TIFF_TAGS.BitsPerSample, [16, 16, 16]),
    shortEntry(TIFF_TAGS.Compression, 1),
    shortEntry(TIFF_TAGS.PhotometricInterpretation, 2),
    asciiEntry(TIFF_TAGS.ImageDescription, `NeoAnalogLab synthetic ${kind} negative, seed ${seed}`),
    shortEntry(TIFF_TAGS.Orientation, 1),
    shortEntry(TIFF_TAGS.SamplesPerPixel, 3),
    longEntry(TIFF_TAGS.RowsPerStrip, height),
    longEntry(TIFF_TAGS.StripByteCounts, stripLength),
    shortEntry(TIFF_TAGS.PlanarConfiguration, 1),
    asciiEntry(TIFF_TAGS.Software, `NeoAnalogLab perf fixtures v${GENERATOR_VERSION}`)
  ];
}

export function writeSyntheticTiff(path, spec) {
  const { width, height, seed, kind } = spec;
  const stripLength = tiffStripBytes(spec);
  // buildTiffParts only reads each block's length for the layout.
  const [header] = buildTiffParts({ entries: tiffEntries(spec, stripLength), blocks: [{ tag: TIFF_TAGS.StripOffsets, bytes: { length: stripLength } }] });
  const hash = createHash('sha256');
  const fd = openSync(path, 'w');
  try {
    writeAll(fd, hash, header);
    const sample = new Float64Array(3);
    const band = new Uint8Array(width * 6 * BAND_ROWS);
    const view = new DataView(band.buffer);
    for (let y0 = 0; y0 < height; y0 += BAND_ROWS) {
      const rows = Math.min(BAND_ROWS, height - y0);
      let o = 0;
      for (let y = y0; y < y0 + rows; y++) {
        for (let x = 0; x < width; x++) {
          sceneSample(sample, x, y, width, height, seed, kind, GRAIN);
          for (let c = 0; c < 3; c++) {
            const t = sample[c] <= 0 ? 0 : sample[c] >= 1 ? 1 : sample[c];
            view.setUint16(o, Math.round(Math.pow(t, 1 / 2.2) * 65535), true);
            o += 2;
          }
        }
      }
      writeAll(fd, hash, band.subarray(0, o));
    }
  } finally {
    closeSync(fd);
  }
  return { sha256: hash.digest('hex'), bytes: header.length + stripLength };
}

// ---- DNG (12-bit packed RGGB CFA) ----

function dngEntries({ width, height, seed }, stripLength) {
  return [
    longEntry(TIFF_TAGS.NewSubfileType, 0),
    longEntry(TIFF_TAGS.ImageWidth, width),
    longEntry(TIFF_TAGS.ImageLength, height),
    shortEntry(TIFF_TAGS.BitsPerSample, 12),
    shortEntry(TIFF_TAGS.Compression, 1),
    shortEntry(TIFF_TAGS.PhotometricInterpretation, 32803),
    asciiEntry(TIFF_TAGS.Make, 'NeoAnalogLab'),
    asciiEntry(TIFF_TAGS.Model, 'Synthetic CFA'),
    shortEntry(TIFF_TAGS.Orientation, 1),
    shortEntry(TIFF_TAGS.SamplesPerPixel, 1),
    longEntry(TIFF_TAGS.RowsPerStrip, height),
    longEntry(TIFF_TAGS.StripByteCounts, stripLength),
    shortEntry(TIFF_TAGS.PlanarConfiguration, 1),
    asciiEntry(TIFF_TAGS.Software, `NeoAnalogLab perf fixtures v${GENERATOR_VERSION} seed ${seed}`),
    shortEntry(CFA_TAGS.CFARepeatPatternDim, [2, 2]),
    bytesEntry(CFA_TAGS.CFAPattern, new Uint8Array([0, 1, 1, 2]), TIFF_TYPES.BYTE),
    bytesEntry(DNG_TAGS.DNGVersion, new Uint8Array([1, 4, 0, 0]), TIFF_TYPES.BYTE),
    bytesEntry(DNG_TAGS.DNGBackwardVersion, new Uint8Array([1, 1, 0, 0]), TIFF_TYPES.BYTE),
    asciiEntry(DNG_TAGS.UniqueCameraModel, 'NeoAnalogLab Synthetic CFA'),
    bytesEntry(CFA_TAGS.CFAPlaneColor, new Uint8Array([0, 1, 2]), TIFF_TYPES.BYTE),
    shortEntry(CFA_TAGS.CFALayout, 1),
    shortEntry(DNG_TAGS.BlackLevel, 0),
    shortEntry(DNG_TAGS.WhiteLevel, 4095),
    longEntry(DNG_TAGS.DefaultCropOrigin, [0, 0]),
    longEntry(DNG_TAGS.DefaultCropSize, [width, height]),
    srationalEntry(DNG_TAGS.ColorMatrix1, XYZ_TO_LINEAR_SRGB.map(value => [Math.round(value * 10000), 10000])),
    rationalEntry(DNG_TAGS.AsShotNeutral, [[1, 1], [1, 1], [1, 1]]),
    srationalEntry(DNG_TAGS.BaselineExposure, [[0, 100]]),
    shortEntry(DNG_TAGS.CalibrationIlluminant1, 21)
  ];
}

function ifdSize(entries) {
  let size = 2 + entries.length * 12 + 4;
  for (const entry of entries) if (entry.data.length > 4) size += entry.data.length + (entry.data.length & 1);
  return size;
}

// One IFD at an absolute file offset (the SubIFD blocks).
function serializeIfd(entries, absoluteOffset) {
  const out = new Uint8Array(ifdSize(entries));
  const view = new DataView(out.buffer);
  const sorted = [...entries].sort((a, b) => a.tag - b.tag);
  view.setUint16(0, sorted.length, true);
  let entryOffset = 2;
  let valueOffset = 2 + sorted.length * 12 + 4;
  for (const entry of sorted) {
    view.setUint16(entryOffset, entry.tag, true);
    view.setUint16(entryOffset + 2, entry.type, true);
    view.setUint32(entryOffset + 4, entry.count, true);
    if (entry.data.length <= 4) out.set(entry.data, entryOffset + 8);
    else {
      view.setUint32(entryOffset + 8, absoluteOffset + valueOffset, true);
      out.set(entry.data, valueOffset);
      valueOffset += entry.data.length + (entry.data.length & 1);
    }
    entryOffset += 12;
  }
  view.setUint32(entryOffset, 0, true);
  return out;
}

function previewIfdEntries(preview, jpegOffset) {
  return [
    longEntry(TIFF_TAGS.NewSubfileType, 1),
    longEntry(TIFF_TAGS.ImageWidth, preview.width),
    longEntry(TIFF_TAGS.ImageLength, preview.height),
    shortEntry(TIFF_TAGS.BitsPerSample, [8, 8, 8]),
    shortEntry(TIFF_TAGS.Compression, 7),
    shortEntry(TIFF_TAGS.PhotometricInterpretation, 6),
    longEntry(TIFF_TAGS.StripOffsets, jpegOffset),
    shortEntry(TIFF_TAGS.SamplesPerPixel, 3),
    longEntry(TIFF_TAGS.RowsPerStrip, preview.height),
    longEntry(TIFF_TAGS.StripByteCounts, preview.jpeg.length),
    shortEntry(TIFF_TAGS.PlanarConfiguration, 1)
  ];
}

function previewBlock(preview, absoluteOffset) {
  const entries = previewIfdEntries(preview, 0);
  const size = ifdSize(entries);
  const ifd = serializeIfd(previewIfdEntries(preview, absoluteOffset + size), absoluteOffset);
  const block = new Uint8Array(size + preview.jpeg.length);
  block.set(ifd, 0);
  block.set(preview.jpeg, size);
  return block;
}

/** Pack 12-bit samples MSB first (two samples in three bytes), as LibRaw reads them. */
export function pack12(samples, out, outOffset = 0) {
  let o = outOffset;
  for (let i = 0; i < samples.length; i += 2) {
    const a = samples[i], b = samples[i + 1];
    out[o++] = a >> 4;
    out[o++] = ((a & 15) << 4) | (b >> 8);
    out[o++] = b & 255;
  }
  return o;
}

export function unpack12(bytes, count, offset = 0) {
  const out = new Uint16Array(count);
  let o = offset;
  for (let i = 0; i < count; i += 2) {
    const b0 = bytes[o++], b1 = bytes[o++], b2 = bytes[o++];
    out[i] = (b0 << 4) | (b1 >> 4);
    out[i + 1] = ((b1 & 15) << 8) | b2;
  }
  return out;
}

/** Linear 12-bit CFA value of one photosite (R at even/even, B at odd/odd). */
export function cfaValue(sample, x, y) {
  const channel = (y & 1) === 0 ? ((x & 1) === 0 ? 0 : 1) : ((x & 1) === 0 ? 1 : 2);
  const t = sample[channel];
  return Math.max(0, Math.min(4095, Math.round((t <= 0 ? 0 : t >= 1 ? 1 : t) * 3900 + 64)));
}

/**
 * previews: [{ width, height, role, jpeg: Uint8Array }] (may be empty).
 */
export function writeSyntheticDng(path, spec, previews = []) {
  const { width, height, seed, kind } = spec;
  const stripLength = cfaStripBytes(spec);
  const blocks = [
    ...previews.map(preview => ({ tag: CFA_TAGS.SubIFDs, bytes: { length: ifdSize(previewIfdEntries(preview, 0)) + preview.jpeg.length } })),
    { tag: TIFF_TAGS.StripOffsets, bytes: { length: stripLength } }
  ];
  const [header] = buildTiffParts({ entries: dngEntries(spec, stripLength), blocks });
  // Absolute offsets of the SubIFD blocks, in the order buildTiffParts laid them out.
  let offset = header.length;
  const hash = createHash('sha256');
  const fd = openSync(path, 'w');
  try {
    writeAll(fd, hash, header);
    for (const preview of previews) {
      const block = previewBlock(preview, offset);
      writeAll(fd, hash, block);
      if (block.length & 1) writeAll(fd, hash, new Uint8Array(1));
      offset += block.length + (block.length & 1);
    }
    const sample = new Float64Array(3);
    const row = new Uint16Array(width);
    const band = new Uint8Array((width * 3 / 2) * BAND_ROWS);
    for (let y0 = 0; y0 < height; y0 += BAND_ROWS) {
      const rows = Math.min(BAND_ROWS, height - y0);
      let o = 0;
      for (let y = y0; y < y0 + rows; y++) {
        for (let x = 0; x < width; x++) {
          sceneSample(sample, x, y, width, height, seed, kind, GRAIN);
          row[x] = cfaValue(sample, x, y);
        }
        o = pack12(row, band, o);
      }
      writeAll(fd, hash, band.subarray(0, o));
    }
    if (stripLength & 1) writeAll(fd, hash, new Uint8Array(1));
  } finally {
    closeSync(fd);
  }
  return { sha256: hash.digest('hex'), bytes: offset + stripLength + (stripLength & 1) };
}

// ---- JPEG previews ----

/** Rendering code sent to Chrome: the scene at preview size, gamma-encoded. */
export function previewRenderSource() {
  return `async (width, height, sourceWidth, sourceHeight, seed, kind, quality) => {
    const sceneSample = ${sceneSample.toString()};
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    const image = context.createImageData(width, height);
    const out = new Float64Array(3);
    let i = 0;
    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        sceneSample(out, (px + 0.5) * sourceWidth / width, (py + 0.5) * sourceHeight / height, sourceWidth, sourceHeight, seed, kind, 0);
        for (let c = 0; c < 3; c++) image.data[i + c] = Math.round(255 * Math.pow(Math.min(1, Math.max(0, out[c])), 1 / 2.2));
        image.data[i + 3] = 255;
        i += 4;
      }
    }
    context.putImageData(image, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let j = 0; j < bytes.length; j += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(j, j + 0x8000));
    return btoa(binary);
  }`;
}

/** A minimal SOI/SOF0/EOI stream with the right dimensions (tests only). */
export function stubJpeg(width, height) {
  return new Uint8Array([
    0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03,
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xFF, 0xD9
  ]);
}

/** Encoder backed by a CDP page session (`session.evaluate`). */
export function chromeJpegEncoder(session, { quality = 0.92 } = {}) {
  const source = previewRenderSource();
  return async ({ width, height, sourceWidth, sourceHeight, seed, kind }) => {
    const base64 = await session.evaluate(`(${source})(${width}, ${height}, ${sourceWidth}, ${sourceHeight}, ${seed}, ${JSON.stringify(kind)}, ${quality})`, { timeoutMs: 300_000 });
    return new Uint8Array(Buffer.from(base64, 'base64'));
  };
}

export const stubJpegEncoder = async ({ width, height }) => stubJpeg(width, height);

// ---- generation with a manifest ----

export function fixtureDir(root, env = process.env) {
  return resolve(env.NC_PERF_FIXTURE_DIR || join(root, 'output', 'perf', 'fixtures'));
}

export function readManifest(dir) {
  try { return JSON.parse(readFileSync(join(dir, 'fixtures.json'), 'utf8')); } catch { return { version: GENERATOR_VERSION, fixtures: {} }; }
}

/**
 * Generate the named fixtures that are missing (or stale) in `dir`.
 * `encodeJpeg` renders previews (Chrome in the harness, a stub in tests).
 */
export async function ensureFixtures({ dir, specs, encodeJpeg = null, encoderLabel = 'none', force = false, log = () => {}, checkDisk = true }) {
  mkdirSync(dir, { recursive: true });
  const manifest = readManifest(dir);
  const todo = specs.filter(spec => force || !existsSync(join(dir, spec.name))
    || manifest.fixtures[spec.name]?.version !== GENERATOR_VERSION
    || (spec.format === 'dng' && manifest.fixtures[spec.name]?.encoder !== encoderLabel));
  const needed = todo.reduce((total, spec) => total + (spec.format === 'dng' ? estimateDngBytes(spec) : tiffStripBytes(spec)), 0);
  if (checkDisk && todo.length) {
    const free = freeDiskBytes(dir);
    if (Number.isFinite(free) && free - needed < MIN_FREE_DISK_BYTES) {
      throw new Error(`generating ${todo.length} fixtures needs ${(needed / GiB).toFixed(1)} GB; free disk ${(free / GiB).toFixed(1)} GB would fall below ${(MIN_FREE_DISK_BYTES / GiB).toFixed(0)} GB`);
    }
  }
  for (const spec of todo) {
    const started = Date.now();
    const path = join(dir, spec.name);
    const partial = `${path}.partial`;
    let result;
    let previews = [];
    if (spec.format === 'tiff') {
      result = writeSyntheticTiff(partial, spec);
    } else {
      if (encodeJpeg) {
        for (const size of previewSizes(spec)) {
          const jpeg = await encodeJpeg({ ...size, sourceWidth: spec.width, sourceHeight: spec.height, seed: spec.seed, kind: spec.kind });
          previews.push({ ...size, jpeg });
        }
      }
      result = writeSyntheticDng(partial, spec, previews);
      if (result.bytes >= HEAVY_RAW_BYTES) throw new Error(`${spec.name} is ${result.bytes} bytes; it must stay under 100 MiB`);
    }
    renameSync(partial, path);
    manifest.fixtures[spec.name] = {
      version: GENERATOR_VERSION, format: spec.format, kind: spec.kind, seed: spec.seed, width: spec.width, height: spec.height,
      bytes: result.bytes, sha256: result.sha256, encoder: spec.format === 'dng' ? encoderLabel : null,
      previews: previews.map(preview => ({ role: preview.role, width: preview.width, height: preview.height, bytes: preview.jpeg.length }))
    };
    writeFileSync(join(dir, 'fixtures.json'), JSON.stringify(manifest, null, 2));
    log(`fixture ${spec.name}: ${(result.bytes / 1024 / 1024).toFixed(1)} MiB in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  }
  return Object.fromEntries(specs.map(spec => [spec.name, { path: join(dir, spec.name), ...manifest.fixtures[spec.name] }]));
}

// ---- CLI ----
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const root = resolve(here, '..', '..');
  const dir = value('--out') ? resolve(value('--out')) : fixtureDir(root);
  const only = value('--only') ? value('--only').split(',') : null;
  const specs = syntheticFixtureSpecs().filter(spec => !only || only.includes(spec.name));
  const encoderName = value('--jpeg') || 'chrome';
  let encodeJpeg = stubJpegEncoder;
  let encoderLabel = 'stub';
  let close = async () => {};
  if (encoderName === 'chrome') {
    const { openJpegEncoderBrowser } = await import('./lib/fixture-browser.mjs');
    ({ encodeJpeg, encoderLabel, close } = await openJpegEncoderBrowser({ log: console.log }));
  }
  try {
    const result = await ensureFixtures({ dir, specs, encodeJpeg, encoderLabel, force: args.includes('--force'), log: console.log });
    console.log(JSON.stringify(Object.fromEntries(Object.entries(result).map(([name, entry]) => [name, entry.sha256])), null, 2));
  } finally {
    await close();
  }
}

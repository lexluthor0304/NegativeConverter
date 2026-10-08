// Standalone Node test for png16Bands.js - run with:
// node negative2positive/src/workers/png16Bands.test.mjs
//
// The band encoder changes the compressed bytes of a 16-bit PNG, never its
// samples (#257). Every file here is checked two ways against the one-shot
// encoder it replaced (kept below as a frozen copy): UPNG decodes it, and an
// independent path verifies every chunk CRC, inflates the IDAT stream with
// Node's zlib (which verifies the Adler-32) and undoes the Sub filter.
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import * as pako from 'pako';
import {
  planPng16Bands, zlibHeader, encodePng16Band, encodePng16BandsSerially, combineBandAdlers,
  assemblePng16Blob, PNG16_BAND_TARGET_BYTES, Z_RLE
} from './png16Bands.js';
import { encodePng16Blob, exportChannelCount } from './imageEncoders.js';
import { attachMetadataToBlob, listPngChunks } from '../app/exportMetadata.js';

const UPNG = createRequire(import.meta.url)('upng-js');

// ------------------------------------------------ HEAD encoder (frozen copy)

function headEncodePng16(pixelData, width, height) {
  const is16 = pixelData instanceof Uint16Array;
  const channels = exportChannelCount(pixelData);
  const rowBytes = width * channels * 2;
  const raw = new Uint8Array((rowBytes + 1) * height);
  let rawIndex = 0;
  for (let y = 0; y < height; y++) {
    raw[rawIndex++] = 1;
    for (let x = 0; x < width; x++) {
      const source = (y * width + x) * 4;
      for (let c = 0; c < channels; c++) {
        const u16 = is16 ? pixelData[source + c] : pixelData[source + c] * 257;
        const left = x === 0 ? 0 : is16 ? pixelData[source + c - 4] : pixelData[source + c - 4] * 257;
        raw[rawIndex++] = (u16 >>> 8) - (left >>> 8);
        raw[rawIndex++] = (u16 & 0xFF) - (left & 0xFF);
      }
    }
  }
  const compressed = pako.deflate(raw, { level: 6 });
  const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length, false);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(8 + data.length, zlib.crc32(out.subarray(4, 8 + data.length)) >>> 0, false);
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, width, false);
  new DataView(ihdr.buffer).setUint32(4, height, false);
  ihdr[8] = 16;
  ihdr[9] = channels === 3 ? 2 : 6;
  return new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', new Uint8Array(0))], { type: 'image/png' });
}

// ---------------------------------------------------------------- decoders

const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());

function upngSamples(bytes) {
  const decoded = UPNG.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.equal(decoded.depth, 16);
  const channels = decoded.ctype === 2 ? 3 : 4;
  const out = new Uint16Array(decoded.width * decoded.height * 4);
  for (let i = 0; i < out.length; i++) {
    const offset = (Math.floor(i / 4) * channels + i % 4) * 2;
    out[i] = i % 4 === 3 && channels === 3 ? 65535 : (decoded.data[offset] << 8) | decoded.data[offset + 1];
  }
  return { width: decoded.width, height: decoded.height, samples: out };
}

// Chunk walk with every CRC verified, zlib inflate with the Adler-32
// verified, then the Sub filter undone by hand.
function strictDecode(bytes) {
  assert.deepEqual(Array.from(bytes.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const types = [];
  const idat = [];
  let ihdr = null;
  for (let at = 8; at < bytes.length;) {
    const length = view.getUint32(at, false);
    const type = new TextDecoder().decode(bytes.subarray(at + 4, at + 8));
    const crc = view.getUint32(at + 8 + length, false);
    assert.equal(zlib.crc32(bytes.subarray(at + 4, at + 8 + length)) >>> 0, crc, `CRC of ${type} at ${at}`);
    types.push(type);
    if (type === 'IHDR') ihdr = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'IDAT') idat.push(bytes.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  assert.equal(types[0], 'IHDR');
  assert.equal(types.at(-1), 'IEND');
  const width = new DataView(ihdr.buffer, ihdr.byteOffset).getUint32(0, false);
  const height = new DataView(ihdr.buffer, ihdr.byteOffset).getUint32(4, false);
  const channels = ihdr[9] === 2 ? 3 : 4;
  const stream = Buffer.concat(idat.map((d) => Buffer.from(d.buffer, d.byteOffset, d.length)));
  const filtered = new Uint8Array(zlib.inflateSync(stream)); // throws on a wrong Adler-32
  const rowBytes = width * channels * 2;
  assert.equal(filtered.length, (rowBytes + 1) * height);
  const samples = new Uint16Array(width * height * 4);
  const row = new Uint8Array(rowBytes);
  for (let y = 0; y < height; y++) {
    const base = y * (rowBytes + 1);
    assert.equal(filtered[base], 1, 'every row is Sub-filtered');
    for (let i = 0; i < rowBytes; i++) {
      row[i] = (filtered[base + 1 + i] + (i >= channels * 2 ? row[i - channels * 2] : 0)) & 0xFF;
    }
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 4; c++) {
        samples[(y * width + x) * 4 + c] = c === 3 && channels === 3 ? 65535 : (row[(x * channels + c) * 2] << 8) | row[(x * channels + c) * 2 + 1];
      }
    }
  }
  return { width, height, channels, samples, types, filtered, stream };
}

const expectedSamples = (pixels) => {
  const is16 = pixels instanceof Uint16Array;
  const channels = exportChannelCount(pixels);
  return Uint16Array.from(pixels, (v, i) => i % 4 === 3 && channels === 3 ? 65535 : (is16 ? v : v * 257));
};

let seed = 1;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed;
};
// Photo-like 16-bit content: smooth gradients plus seeded grain.
function photoLike16(width, height) {
  const pixels = new Uint16Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const o = (y * width + x) * 4;
    const t = (x / Math.max(1, width - 1)) * 0.7 + (y / Math.max(1, height - 1)) * 0.3;
    for (let c = 0; c < 3; c++) {
      const grain = ((random() >>> 20) & 0x3FF) - 512;
      pixels[o + c] = Math.max(0, Math.min(65535, Math.round(t * (52000 - c * 7000)) + 3000 + grain));
    }
    pixels[o + 3] = 65535;
  }
  return pixels;
}
const random8 = (width, height, alpha) => Uint8ClampedArray.from({ length: width * height * 4 },
  (_, i) => i % 4 === 3 ? (alpha ? random() >>> 24 : 255) : random() >>> 24);

async function assertSameSamplesAsHead(pixels, width, height, options = {}) {
  const head = await bytesOf(headEncodePng16(pixels, width, height));
  const blob = encodePng16Blob(pixels, width, height, pako, options);
  assert.equal(blob.type, 'image/png');
  const bytes = await bytesOf(blob);
  const expected = expectedSamples(pixels);
  const upng = upngSamples(bytes);
  assert.equal(upng.width, width);
  assert.equal(upng.height, height);
  assert.deepEqual(upng.samples, expected, 'UPNG samples');
  assert.deepEqual(upng.samples, upngSamples(head).samples, 'UPNG samples equal HEAD');
  const strict = strictDecode(bytes);
  assert.deepEqual(strict.samples, expected, 'strict samples');
  assert.deepEqual(strict.filtered, strictDecode(head).filtered, 'identical filtered stream');
  const plan = planPng16Bands(width, height, exportChannelCount(pixels), options);
  assert.deepEqual(strict.types, ['IHDR', ...Array(plan.bands.length + 1).fill('IDAT'), 'IEND']);
  return { bytes, head, plan, strict };
}

// ------------------------------------------------------------------ layout

{
  // The issue's numbers: 60 MP (both roll sizes) and 24 MP, RGB16.
  const m11 = planPng16Bands(9504, 6320, 3);
  assert.equal(m11.filteredRowBytes, 57025);
  assert.equal(m11.rowsPerBand, 294);
  assert.equal(m11.bands.length, 22);
  assert.equal(planPng16Bands(9536, 6336, 3).bands.length, 22);
  assert.equal(planPng16Bands(6048, 4032, 3).bands.length, 9);
  // Whole rows, in order, covering the frame, every band but the last full.
  for (const [w, h, c] of [[9504, 6320, 3], [1, 1, 3], [1, 70000, 4], [70000, 1, 3], [3000000, 3, 4]]) {
    const { bands, rowsPerBand } = planPng16Bands(w, h, c);
    let y = 0;
    bands.forEach((band, i) => {
      assert.equal(band.index, i);
      assert.equal(band.y, y);
      assert.ok(band.rows >= 1);
      if (i < bands.length - 1) assert.equal(band.rows, rowsPerBand);
      y += band.rows;
    });
    assert.equal(y, h);
    assert.ok(rowsPerBand * (w * c * 2 + 1) <= PNG16_BAND_TARGET_BYTES || rowsPerBand === 1);
  }
  // A row larger than a band is still one band per row.
  assert.equal(planPng16Bands(3000000, 3, 4).rowsPerBand, 1);
  assert.throws(() => planPng16Bands(-1, 1, 3), RangeError);
  assert.throws(() => planPng16Bands(1, 0, 3), RangeError);
  assert.throws(() => planPng16Bands(1, 1, 2), RangeError);
}

// ------------------------------------------- zlib header per level/strategy

for (let level = 0; level <= 9; level++) {
  for (const strategy of [0, 1, 2, 3, 4]) {
    const z = pako.deflate(new Uint8Array([1, 2, 3]), { level, strategy });
    assert.deepEqual(Array.from(zlibHeader(level, strategy)), [z[0], z[1]], `header at level ${level}, strategy ${strategy}`);
  }
}
assert.deepEqual(Array.from(zlibHeader(6, 0)), [0x78, 0x9C]);
assert.deepEqual(Array.from(zlibHeader(6, Z_RLE)), [0x78, 0x01]);

// ----------------------------------------------- samples identical to HEAD

// Several bands at the real 16 MiB layout, the last one partial.
{
  const width = 2000, height = 1500;
  const pixels = photoLike16(width, height);
  const { bytes, head, plan } = await assertSameSamplesAsHead(pixels, width, height);
  assert.equal(plan.bands.length, 2);
  assert.notEqual(height % plan.rowsPerBand, 0, 'height is not a multiple of the band height');
  // Size: the sync flushes cost a few bytes per band.
  const growth = (bytes.length - head.length) / head.length;
  assert.ok(growth < 0.001, `file grew by ${(growth * 100).toFixed(4)} %`);
  console.log(`2-band 3 MP photo-like PNG16: HEAD ${head.length} B, bands ${bytes.length} B (${(growth * 100).toFixed(4)} %)`);
}

// Small frames with a test-sized band: heights that are not multiples of the
// band height, one-row bands, one band, one row, one column, RGBA16 input.
{
  const cases = [
    [37, 29, 1500], // 29 rows, 6 per band (+5)
    [37, 29, 100], // bands of one row (a row is 223 bytes)
    [37, 29, 1 << 30], // a single band
    [53, 1, 64], // one row
    [1, 41, 30], // one column: 7-byte rows, 4 per band
    [1, 1, 1] // one pixel
  ];
  for (const [width, height, bandBytes] of cases) {
    const pixels = photoLike16(width, height);
    const { plan } = await assertSameSamplesAsHead(pixels, width, height, { bandBytes });
    if (bandBytes === 100) assert.equal(plan.rowsPerBand, 1);
    if (bandBytes === 1 << 30) assert.equal(plan.bands.length, 1);
  }
}

// The 8-bit fallbacks (v * 257): opaque (RGB) and with real alpha (RGBA).
for (const alpha of [false, true]) {
  const width = 41, height = 23;
  const pixels = random8(width, height, alpha);
  const { strict } = await assertSameSamplesAsHead(pixels, width, height, { bandBytes: 700 });
  assert.equal(strict.channels, alpha ? 4 : 3);
  // A plain Uint8Array behaves like the clamped one.
  await assertSameSamplesAsHead(new Uint8Array(pixels), width, height, { bandBytes: 700 });
}

// Extremes of the 16-bit range, which wrap in the Sub filter.
{
  const width = 17, height = 9;
  const pixels = Uint16Array.from({ length: width * height * 4 }, (_, i) => [0, 65535, 1, 65534, 0x8000, 0x7FFF][i % 6]);
  await assertSameSamplesAsHead(pixels, width, height, { bandBytes: 300 });
}

// Z_RLE is lossless too (flagged, not the default).
{
  const width = 64, height = 50;
  const pixels = photoLike16(width, height);
  const bytes = await bytesOf(encodePng16Blob(pixels, width, height, pako, { strategy: Z_RLE, bandBytes: 4000 }));
  assert.deepEqual(Array.from(bytes.subarray(41, 43)), [0x78, 0x01], 'RLE zlib header in the first IDAT');
  assert.deepEqual(strictDecode(bytes).samples, expectedSamples(pixels));
}

// ------------------------------------------------ bands are independent

{
  // Encoding the bands out of order, one by one, then assembling gives the
  // same file as the serial encoder: a band depends on its rows only.
  const width = 29, height = 31, bandBytes = 800;
  const pixels = photoLike16(width, height);
  const { bands } = planPng16Bands(width, height, 3, { bandBytes });
  const results = new Array(bands.length);
  for (const band of [...bands].reverse()) {
    const samples = pixels.slice(band.y * width * 4, (band.y + band.rows) * width * 4);
    results[band.index] = encodePng16Band({ samples, width, rows: band.rows, channels: 3, index: band.index, isLast: band.index === bands.length - 1 }, pako.Deflate);
  }
  const assembled = await bytesOf(assemblePng16Blob({ width, height, channels: 3, idats: results.map((r) => new Blob(r.parts)), adler: combineBandAdlers(results) }));
  assert.deepEqual(assembled, await bytesOf(encodePng16Blob(pixels, width, height, pako, { bandBytes })));

  // A wrong Adler-32 is caught by the strict decoder, which is what makes the
  // checks above meaningful (UPNG does not verify it).
  const broken = assembled.slice();
  const trailerAt = broken.length - 12 - 16 + 8; // IDAT(4) data before IEND
  broken[trailerAt] ^= 1;
  const trailerChunk = broken.subarray(trailerAt - 4, trailerAt + 4);
  new DataView(broken.buffer).setUint32(trailerAt + 4, zlib.crc32(trailerChunk) >>> 0, false);
  assert.throws(() => strictDecode(broken), /incorrect data check|unexpected end/i);
}

// Bad inputs are errors, not garbage files.
assert.throws(() => encodePng16Band({ samples: new Uint16Array(8), width: 2, rows: 2, channels: 3, index: 0, isLast: true }, pako), RangeError);
assert.throws(() => encodePng16Band({ samples: new Uint16Array(8), width: 2, rows: 1, channels: 3, index: 0, isLast: true }, pako.deflate), TypeError);
assert.throws(() => encodePng16Blob(new Uint16Array(8), 2, 2, pako), RangeError);

// ------------------------------------------- metadata keeps the chunk order

{
  const width = 20, height = 15;
  const pixels = photoLike16(width, height);
  const png = encodePng16Blob(pixels, width, height, pako, { bandBytes: 300 });
  const withMeta = await attachMetadataToBlob(png, 'png', { exif: { make: 'Test', model: 'Band' }, xmp: '<x:xmpmeta/>' });
  const bytes = await bytesOf(withMeta);
  const types = listPngChunks(bytes).map((c) => c.type);
  const idats = types.filter((t) => t === 'IDAT').length;
  assert.ok(idats > 2);
  assert.deepEqual(types, ['IHDR', 'iCCP', 'eXIf', 'iTXt', ...Array(idats).fill('IDAT'), 'IEND']);
  assert.deepEqual(strictDecode(bytes).samples, expectedSamples(pixels));
}

console.log('png16Bands.test.mjs passed');

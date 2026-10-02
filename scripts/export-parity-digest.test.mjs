// Standalone Node test for export-parity-digest.mjs: the digests the import
// parity and gain-map smokes compare (#229 review, R1-100, R1-144). Run by
// run-tests.mjs; no browser (the page's JPEG decode is the smokes' part).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import * as pako from 'pako';
import { exportParityDigest, PAGE_EXPORT_DIGEST } from './export-parity-digest.mjs';
import { jpegGainMap } from './perf/lib/export-verify.mjs';

globalThis.ImageData ??= class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};
const { encodePng16Blob } = await import('../negative2positive/src/app/exportImageEncoders.js');
const { attachMetadataToBlob } = await import('../negative2positive/src/app/exportMetadata.js');
const { packGainMapJpeg } = await import('../negative2positive/src/app/gainMapJpeg.js');

const UPNG = createRequire(import.meta.url)('upng-js');
const hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha256 = async (bytes) => hex(bytes);
const noJpeg = async () => { throw new Error('no JPEG expected'); };
const io = { UPNG, sha256, decodeJpeg: noJpeg };
const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};

let seed = 11;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);

// ---- PNG16: #257's band stream is not a sample change ----
const W = 37, H = 23; // odd sizes: several bands, no row alignment
const plane = new Uint16Array(W * H * 4);
for (let i = 0; i < plane.length; i++) plane[i] = i % 4 === 3 ? 65535 : random() >>> 16;
const image16 = (data) => {
  const image = new ImageData(Uint8ClampedArray.from(data, (v) => v >>> 8), W, H);
  image.__image16 = { width: W, height: H, data };
  return image;
};
const banded = await bytesOf(encodePng16Blob(image16(plane), { bandBytes: 500 }));
const whole = await bytesOf(encodePng16Blob(image16(plane), {}));
assert.notDeepEqual(banded, whole, 'the two band layouts must give different files');
const a = await exportParityDigest(banded, io);
const b = await exportParityDigest(whole, io);
assert.deepEqual(a, b, 'same samples, other band layout: same digest');
assert.equal(a.format, 'png');
assert.deepEqual([a.width, a.height, a.depth, a.ctype, a.chunks], [W, H, 16, 2, 'IHDR']);
// The samples digest is exactly the big-endian RGB rows of the plane.
const rows = new Uint8Array(W * H * 6);
for (let p = 0, o = 0; p < W * H; p++) {
  for (let c = 0; c < 3; c++, o += 2) { rows[o] = plane[p * 4 + c] >>> 8; rows[o + 1] = plane[p * 4 + c] & 255; }
}
assert.equal(a.samples, hex(rows), 'samples digest = SHA-256 of the 16-bit rows');
// One sample one code value off is a different digest, nothing else moves.
const altered = plane.slice();
altered[(11 * W + 7) * 4 + 1] ^= 1;
const c = await exportParityDigest(await bytesOf(encodePng16Blob(image16(altered), { bandBytes: 500 })), io);
assert.notEqual(c.samples, a.samples, 'one altered 16-bit sample must change the samples digest');
assert.deepEqual({ ...c, samples: a.samples }, a);
// Metadata chunks count, in order; a clock time (tIME) does not.
const tagged = await bytesOf(await attachMetadataToBlob(new Blob([banded]), 'png', { xmp: '<x:xmpmeta xmlns:x="adobe:ns:meta/"/>' }));
const d = await exportParityDigest(tagged, io);
assert.equal(d.samples, a.samples);
assert.equal(d.chunks, 'IHDR,iCCP,iTXt');
assert.notEqual(d.metadata, a.metadata, 'an added XMP chunk must change the metadata digest');
function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xEDB88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
const iend = tagged.length - 12;
const timed = concat(tagged.subarray(0, iend), chunk('tIME', new Uint8Array([7, 234, 10, 3, 1, 2, 3])), tagged.subarray(iend));
assert.deepEqual(await exportParityDigest(timed, io), d, 'tIME is a clock time, not metadata');

// ---- PNG8: another filter on the same pixels ----
// UPNG leaves the last row's filtered bytes after the rows, so its whole
// `data` follows the encoder's filter choice; the digest stops at the rows.
const rgba = Uint8Array.from({ length: W * H * 4 }, () => random() >>> 24);
function png8(filter) {
  const stride = W * 4;
  const raw = new Uint8Array((stride + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const v = rgba[y * stride + x];
      raw[y * (stride + 1) + 1 + x] = filter === 1 ? (v - (x >= 4 ? rgba[y * stride + x - 4] : 0)) & 255 : v;
    }
  }
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, W);
  new DataView(ihdr.buffer).setUint32(4, H);
  ihdr[8] = 8; ihdr[9] = 6;
  return concat(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', pako.deflate(raw)), chunk('IEND', new Uint8Array(0)));
}
const none = png8(0), sub = png8(1);
assert.notDeepEqual(UPNG.decode(none.slice().buffer).data, UPNG.decode(sub.slice().buffer).data, "UPNG's data carries the last row's filtered bytes");
const e = await exportParityDigest(none, io);
assert.deepEqual(await exportParityDigest(sub, io), e, 'same pixels, other filter: same digest');
assert.equal(e.samples, hex(rgba));
assert.deepEqual([e.depth, e.ctype], [8, 6]);

// ---- TIFF and anything else: the whole file ----
const tiff = Uint8Array.from([0x49, 0x49, 42, 0, 8, 0, 0, 0, 0, 0, 1, 2, 3]);
assert.deepEqual(await exportParityDigest(tiff, io), { format: 'tiff', size: tiff.length, file: hex(tiff) });
assert.equal((await exportParityDigest(Uint8Array.from([1, 2, 3, 4, 5, 6]), io)).format, 'file');

// ---- JPEG: decoded primary, its metadata without the MPF index, gain-map bytes ----
const segment = (marker, payload) => concat(Uint8Array.of(0xFF, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255), payload);
const jpeg = (scan, ...segments) => concat(Uint8Array.of(0xFF, 0xD8), ...segments, Uint8Array.of(0xFF, 0xDA, 0, 2), scan, Uint8Array.of(0xFF, 0xD9));
const exif = segment(0xE1, concat(new TextEncoder().encode('Exif\0\0'), Uint8Array.of(1, 2, 3, 4)));
const base = jpeg(Uint8Array.of(10, 20, 30, 40, 50), exif);
const gainImage = jpeg(Uint8Array.of(60, 70, 80));
const packed = await bytesOf(await packGainMapJpeg(new Blob([base]), new Blob([gainImage]), { gainMax: 2 }));
const decoded = [];
const fakeDecode = async (bytes) => { decoded.push(bytes.slice()); return { width: 1, height: 1, data: new Uint8ClampedArray(createHash('sha256').update(bytes.subarray(bytes.length - 7)).digest()) }; };
const jio = { UPNG, sha256, decodeJpeg: fakeDecode };
const f = await exportParityDigest(packed, jio);
const reference = jpegGainMap(packed); // scripts/perf/lib/export-verify.mjs, read-only
assert.deepEqual(f.gainMap, { bytes: reference.bytes, sha256: reference.sha256 }, 'gain-map bytes as export-verify reads them');
assert.deepEqual(decoded[0], packed.subarray(0, reference.primaryBytes), 'only the primary image is decoded');
assert.equal(f.segments, 'APP1,APP1', 'EXIF and the container XMP; the MPF index is left out');
// One gain-map byte: only the gain map moves.
const flipped = packed.slice();
flipped[packed.length - 4] ^= 1;
const g = await exportParityDigest(flipped, jio);
assert.notEqual(g.gainMap.sha256, f.gainMap.sha256, 'one changed gain-map byte must change its digest');
assert.deepEqual({ ...g, gainMap: f.gainMap }, f);
// A longer primary stream moves the MPF offsets but not the metadata.
const longer = await bytesOf(await packGainMapJpeg(new Blob([jpeg(Uint8Array.of(10, 20, 30, 40, 41, 50), exif)]), new Blob([gainImage]), { gainMax: 2 }));
const h = await exportParityDigest(longer, jio);
assert.equal(h.metadata, f.metadata);
assert.deepEqual(h.gainMap, f.gainMap);
// Other EXIF is other metadata.
const otherExif = await bytesOf(await packGainMapJpeg(new Blob([jpeg(Uint8Array.of(10, 20, 30, 40, 50), segment(0xE1, concat(new TextEncoder().encode('Exif\0\0'), Uint8Array.of(1, 2, 3, 5))))]), new Blob([gainImage]), { gainMax: 2 }));
assert.notEqual((await exportParityDigest(otherExif, jio)).metadata, f.metadata);
// No MPF index: the whole file is the primary and there is no gain map.
const plain = await exportParityDigest(base, jio);
assert.equal(plain.gainMap, null);
assert.deepEqual(decoded.at(-1), base);

// ---- the page installer: UPNG and pako load without a module system ----
const scope = {};
new Function('window', PAGE_EXPORT_DIGEST)(scope);
assert.equal(typeof scope.__ncExportDigest, 'function');
assert.deepEqual(await scope.__ncExportDigest(banded), a, 'the page digest matches Node for PNG16');
assert.deepEqual(await scope.__ncExportDigest(sub), e, 'the page digest matches Node for PNG8');
assert.deepEqual(await scope.__ncExportDigest(tiff), { format: 'tiff', size: tiff.length, file: hex(tiff) });

console.log('export parity digests passed');

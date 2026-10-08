import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { verifyExport, verifyDecodedExport, zipEntries, jpegGainMap, sniffFormat, tiffPixels } from './export-verify.mjs';
import { encodePng16Blob, encodeTiffBlob } from '../../../negative2positive/src/workers/imageEncoders.js';
import * as pako from 'pako';
import { ZipStoreWriter } from '../../../negative2positive/src/app/zipStoreWriter.js';

const UPNG = createRequire(import.meta.url)('upng-js');

// A 16-bit TIFF from the app's own encoder: bit depth and a pixel hash that
// depends only on the samples.
const width = 5, height = 3;
const rgba16 = new Uint16Array(width * height * 4).map((_, i) => (i * 4099) & 0xFFFF);
const tiffBlob = await encodeTiff16Maybe(rgba16, width, height);
const tiff = new Uint8Array(await tiffBlob.arrayBuffer());
assert.equal(sniffFormat(tiff), 'tiff');
const tiffInfo = tiffPixels(tiff);
assert.equal(tiffInfo.bitDepth, 16, 'TIFF16 is really 16-bit');
assert.equal(tiffInfo.width, 5);
const changed = rgba16.slice(); changed[0] ^= 1;
assert.notEqual(tiffPixels(new Uint8Array(await (await encodeTiff16Maybe(changed, width, height)).arrayBuffer())).sha256, tiffInfo.sha256, 'one sample changes the hash');

// PNG: decoded samples, not file bytes (a different zlib level must not matter).
const rgba8 = new Uint8Array(width * height * 4).map((_, i) => (i * 37) & 255);
const pngA = new Uint8Array(UPNG.encode([rgba8.buffer], width, height, 0));
const pngB = new Uint8Array(UPNG.encode([rgba8.slice().buffer], width, height, 0));
assert.equal(verifyExport(pngA).sha256, verifyExport(pngB).sha256);
assert.ok(Number.isInteger(verifyExport(pngA).bitDepth), 'PNG bit depth is reported');

// PNG16 hashes all decoded 16-bit samples, including their low bits. A zlib
// level change affects file bytes but must leave the sample comparison equal.
const png16A = new Uint8Array(await encodePng16Blob(rgba16, width, height, pako, { level: 1 }).arrayBuffer());
const png16B = new Uint8Array(await encodePng16Blob(rgba16, width, height, pako, { level: 6 }).arrayBuffer());
const png16Changed = new Uint8Array(await encodePng16Blob(changed, width, height, pako).arrayBuffer());
assert.equal(verifyExport(png16A).bitDepth, 16);
assert.equal(verifyExport(png16A).sha256, verifyExport(png16B).sha256);
assert.notEqual(verifyExport(png16A).sha256, verifyExport(png16Changed).sha256);

// JPEG with an MPF index: the gain map is the secondary image.
function app2Mpf(primarySize, secondarySize) {
  // Little-endian TIFF with one IFD holding MPEntry (0xB002), two 16-byte entries.
  const tiffBytes = new Uint8Array(8 + 2 + 12 + 4 + 32);
  const v = new DataView(tiffBytes.buffer);
  tiffBytes.set([0x49, 0x49, 0x2A, 0x00]); v.setUint32(4, 8, true);
  v.setUint16(8, 1, true);
  v.setUint16(10, 0xB002, true); v.setUint16(12, 7, true); v.setUint32(14, 32, true); v.setUint32(18, 26, true);
  v.setUint32(22, 0, true);
  v.setUint32(26 + 4, primarySize, true);
  v.setUint32(26 + 20, secondarySize, true);
  v.setUint32(26 + 24, primarySize - 10, true);
  const payload = new Uint8Array(4 + tiffBytes.length);
  payload.set([0x4D, 0x50, 0x46, 0x00]); payload.set(tiffBytes, 4);
  const segment = new Uint8Array(4 + payload.length);
  segment.set([0xFF, 0xE2, (payload.length + 2) >> 8, (payload.length + 2) & 255]); segment.set(payload, 4);
  return segment;
}
const secondary = new Uint8Array([0xFF, 0xD8, 9, 9, 9, 0xFF, 0xD9]);
const body = new Uint8Array([0xFF, 0xDA, 0x00, 0x02, 1, 2, 3, 0xFF, 0xD9]);
const primarySize = 2 + app2Mpf(0, 0).length + body.length;
const jpeg = new Uint8Array([0xFF, 0xD8, ...app2Mpf(primarySize, secondary.length), ...body, ...secondary]);
const gain = jpegGainMap(jpeg);
assert.equal(gain.bytes, secondary.length);
assert.equal(gain.primaryBytes, primarySize);
assert.equal(verifyExport(jpeg).format, 'jpeg');
assert.equal(jpegGainMap(new Uint8Array([0xFF, 0xD8, 0xFF, 0xDA, 0, 2, 0xFF, 0xD9])), null, 'no MPF, no gain map');

// ZIP from the app's own streaming writer; entries decode like single files.
const chunks = [];
const writer = new ZipStoreWriter({ write: async chunk => { chunks.push(new Uint8Array(chunk)); } }, { now: new Date('2026-09-23T00:00:00Z') });
await writer.addBlob('a.tif', tiffBlob);
await writer.addBlob('b.png', new Blob([pngA]));
await writer.addBlob('c.jpg', new Blob([jpeg]));
await writer.close();
const zip = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
let at = 0; for (const c of chunks) { zip.set(c, at); at += c.length; }
const entries = zipEntries(zip);
assert.deepEqual(entries.map(entry => [entry.name, entry.method]), [['a.tif', 0], ['b.png', 0], ['c.jpg', 0]]);
const zipInfo = verifyExport(zip, 'roll.zip');
assert.equal(zipInfo.entries[0].sha256, tiffInfo.sha256, 'a ZIP entry hashes like the single export');
assert.equal(zipInfo.entries[1].sha256, verifyExport(pngA).sha256);
let jpegDecodes = 0;
const decodedZip = await verifyDecodedExport(zip, 'roll.zip', async bytes => {
  assert.deepEqual(bytes, jpeg); jpegDecodes++; return { sha256: 'page-decoded-primary', width: 5, height: 3 };
});
assert.equal(jpegDecodes, 1);
assert.equal(decodedZip.entries[2].sha256, 'page-decoded-primary');
assert.equal(decodedZip.entries[2].gainMap.sha256, gain.sha256);
// ZIP64 records are read too.
const chunks64 = [];
const writer64 = new ZipStoreWriter({ write: async chunk => { chunks64.push(new Uint8Array(chunk)); } }, { forceZip64: true });
await writer64.addBlob('a.tif', tiffBlob);
await writer64.close();
const zip64 = Buffer.concat(chunks64.map(c => Buffer.from(c)));
assert.equal(verifyExport(new Uint8Array(zip64)).entries[0].sha256, tiffInfo.sha256);

// The app's TIFF encoder takes RGBA samples and a bit depth.
async function encodeTiff16Maybe(data, w, h) {
  return encodeTiffBlob(data, w, h, 16);
}

console.log('export-verify: TIFF16 depth and pixels, PNG, JPEG gain map, ZIP and ZIP64 tests passed');

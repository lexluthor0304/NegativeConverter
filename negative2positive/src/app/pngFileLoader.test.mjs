// Standalone Node test for pngFileLoader.js - run with:
// node negative2positive/src/app/pngFileLoader.test.mjs

import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';

import { loadPngFile, pngChannelCount, isNativeSixteenBitPng } from './pngFileLoader.js';
import { isPngFile, loadPngImageData, loadStandardImage } from './imageFileLoaders.js';

if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class ImageData {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

// --- minimal PNG writer (only what these fixtures need) ---------------------
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, payload) {
  const typeBytes = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBytes, Buffer.from(payload)]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(payload.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/**
 * @param {{width, height, depth, colorType, rows: number[][], palette?: number[]}} spec
 *        `rows` holds the already-packed bytes of each scanline (no filter byte).
 */
function buildPng(spec) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(spec.width, 0);
  ihdr.writeUInt32BE(spec.height, 4);
  ihdr[8] = spec.depth;
  ihdr[9] = spec.colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.concat(spec.rows.map((row) => Buffer.concat([Buffer.from([0]), Buffer.from(row)])));
  const parts = [
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr)
  ];
  if (spec.palette) parts.push(chunk('PLTE', Buffer.from(spec.palette)));
  parts.push(chunk('IDAT', deflateSync(raw)));
  parts.push(chunk('IEND', Buffer.alloc(0)));

  const png = Buffer.concat(parts);
  return png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength);
}

// --- pure helpers -----------------------------------------------------------
assert.equal(pngChannelCount(0), 1);
assert.equal(pngChannelCount(2), 3);
assert.equal(pngChannelCount(3), 1, 'palette PNGs store ONE index byte per pixel, not three');
assert.equal(pngChannelCount(4), 2);
assert.equal(pngChannelCount(6), 4);
assert.equal(pngChannelCount(9), 0);

assert.equal(isNativeSixteenBitPng(2, 16), true);
assert.equal(isNativeSixteenBitPng(0, 16), true);
assert.equal(isNativeSixteenBitPng(2, 8), false);
assert.equal(isNativeSixteenBitPng(3, 8), false, 'palette is never a raw 16-bit plane');
assert.equal(isNativeSixteenBitPng(0, 4), false);

// --- 16-bit RGB keeps every bit --------------------------------------------
{
  // Two pixels whose low bytes matter: 0x1234 and 0xFEDC.
  const row = [0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC, 0xFE, 0xDC, 0x00, 0x01, 0xFF, 0xFF];
  const png = buildPng({ width: 2, height: 1, depth: 16, colorType: 2, rows: [row] });
  const imageData = loadPngFile(png);
  const file = new File([png], 'SCAN.PNG', { type: '' });
  assert.equal(isPngFile(file), true);
  const dispatched = await loadPngImageData(await file.arrayBuffer());
  const sniffed = await loadStandardImage(new File([png], 'no-extension', { type: '' }));
  assert.deepEqual(dispatched.__image16.data, imageData.__image16.data);
  assert.deepEqual(sniffed.__image16.data, imageData.__image16.data);

  assert.equal(imageData.width, 2);
  assert.ok(imageData.__image16, '16-bit PNG must carry a 16-bit plane');
  assert.deepEqual(
    Array.from(imageData.__image16.data),
    [0x1234, 0x5678, 0x9ABC, 65535, 0xFEDC, 0x0001, 0xFFFF, 65535]
  );
  assert.deepEqual(Array.from(imageData.data), [0x12, 0x56, 0x9A, 255, 0xFE, 0x00, 0xFF, 255]);
}

// --- 16-bit greyscale replicates into RGB -----------------------------------
{
  const png = buildPng({ width: 2, height: 1, depth: 16, colorType: 0, rows: [[0xAB, 0xCD, 0x00, 0x10]] });
  const imageData = loadPngFile(png);
  assert.deepEqual(
    Array.from(imageData.__image16.data),
    [0xABCD, 0xABCD, 0xABCD, 65535, 0x0010, 0x0010, 0x0010, 65535]
  );
}

// --- 8-bit RGB gets no fake 16-bit mirror -----------------------------------
{
  const png = buildPng({ width: 2, height: 1, depth: 8, colorType: 2, rows: [[10, 20, 30, 200, 100, 50]] });
  const imageData = loadPngFile(png);
  assert.equal(imageData.__image16, undefined, '8-bit PNG must not claim 16-bit precision');
  assert.deepEqual(Array.from(imageData.data), [10, 20, 30, 255, 200, 100, 50, 255]);
}

// --- palette PNGs decode through the palette, not as packed RGB -------------
{
  const png = buildPng({
    width: 3,
    height: 1,
    depth: 8,
    colorType: 3,
    palette: [255, 0, 0, 0, 255, 0, 0, 0, 255],
    rows: [[2, 0, 1]]
  });
  const imageData = loadPngFile(png);
  assert.equal(imageData.__image16, undefined);
  assert.deepEqual(
    Array.from(imageData.data),
    [0, 0, 255, 255, 255, 0, 0, 255, 0, 255, 0, 255]
  );
}

// --- sub-byte bit depths are unpacked, not read as one sample per byte ------
{
  // 4-bit greyscale, four pixels in two bytes: 0x0, 0xF, 0x8, 0x4.
  const png = buildPng({ width: 4, height: 1, depth: 4, colorType: 0, rows: [[0x0F, 0x84]] });
  const imageData = loadPngFile(png);
  assert.equal(imageData.__image16, undefined);
  const greys = [0, 4, 8, 12].map((i) => imageData.data[i]);
  assert.deepEqual(greys, [0, 255, 136, 68]);
  assert.deepEqual([3, 7, 11, 15].map((i) => imageData.data[i]), [255, 255, 255, 255]);
}

console.log('pngFileLoader.test.mjs passed');

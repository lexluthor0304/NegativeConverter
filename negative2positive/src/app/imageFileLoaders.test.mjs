import assert from 'node:assert/strict';

import {
  isRawLikeFileName,
  isPngFile,
  RAW_LIKE_EXTENSIONS,
  sniffImageKind,
  assertCanvasSize,
  looksLikeBlankReadback,
  MAX_CANVAS_SIDE,
  CANVAS_BLANK_PROBE_AREA
} from './imageFileLoaders.js';

assert.equal(isRawLikeFileName('scan.NEF'), true);
assert.equal(isRawLikeFileName('/tmp/roll_01.TIFF'), true);
assert.equal(isRawLikeFileName('converted.png'), false);
assert.equal(isRawLikeFileName('archive.nef.zip'), false);
assert.ok(RAW_LIKE_EXTENSIONS.includes('.dng'));
assert.equal(isPngFile({ name: 'SCAN.PNG', type: '' }), true);
assert.equal(isPngFile({ name: 'scan', type: 'image/png' }), true);
assert.equal(isPngFile({ name: 'scan.png.jpg', type: 'image/jpeg' }), false);
assert.equal(isPngFile(null), false);

// --- magic-byte sniffing ----------------------------------------------------
function pngHeader(depth, colorType) {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0D], 8);       // IHDR length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);      // "IHDR"
  bytes[24] = depth;
  bytes[25] = colorType;
  return bytes;
}

assert.deepEqual(sniffImageKind(pngHeader(16, 2)), { kind: 'png', depth: 16, colorType: 2 });
assert.deepEqual(sniffImageKind(pngHeader(8, 3)), { kind: 'png', depth: 8, colorType: 3 });
assert.equal(sniffImageKind(pngHeader(16, 2).buffer).depth, 16, 'accepts an ArrayBuffer too');

assert.deepEqual(sniffImageKind(new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 0])), { kind: 'jpeg' });
assert.deepEqual(sniffImageKind(new Uint8Array([0x49, 0x49, 0x2A, 0x00])), { kind: 'tiff', littleEndian: true });
assert.deepEqual(sniffImageKind(new Uint8Array([0x4D, 0x4D, 0x00, 0x2A])), { kind: 'tiff', littleEndian: false });

const heic = new Uint8Array(16);
heic.set([0x66, 0x74, 0x79, 0x70], 4);
heic.set([0x68, 0x65, 0x69, 0x63], 8); // "heic"
assert.equal(sniffImageKind(heic).kind, 'heif');

assert.equal(sniffImageKind(new Uint8Array([1, 2, 3, 4, 5, 6])), null);
assert.equal(sniffImageKind(new Uint8Array([1, 2])), null);
assert.equal(sniffImageKind(null), null);

// --- canvas size guard ------------------------------------------------------
assert.equal(assertCanvasSize(8000, 6000), true);
assert.throws(() => assertCanvasSize(MAX_CANVAS_SIDE + 1, 10), (err) => err.code === 'IMAGE_TOO_LARGE');
assert.throws(() => assertCanvasSize(30000, 30000), (err) => err.code === 'IMAGE_TOO_LARGE');
assert.throws(() => assertCanvasSize(0, 100), (err) => err.code === 'IMAGE_TOO_LARGE');
assert.throws(() => assertCanvasSize(NaN, NaN), (err) => err.code === 'IMAGE_TOO_LARGE');

// --- blank read-back detection (a dead canvas returns transparent black) ----
{
  const smallArea = 64 * 64;
  assert.equal(looksLikeBlankReadback(new Uint8ClampedArray(smallArea * 4), 64, 64), false,
    'small transparent images must not be rejected');

  const width = 6000;
  const height = Math.ceil((CANVAS_BLANK_PROBE_AREA + 1) / width);
  const blank = new Uint8ClampedArray(width * height * 4);
  assert.equal(looksLikeBlankReadback(blank, width, height), true);

  const opaque = new Uint8ClampedArray(width * height * 4);
  opaque.fill(255);
  assert.equal(looksLikeBlankReadback(opaque, width, height), false);
}

console.log('imageFileLoaders tests passed');

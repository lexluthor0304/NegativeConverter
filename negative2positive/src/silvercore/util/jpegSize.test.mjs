// Standalone Node test for the JPEG SOF marker parser inside nefJpegPreview.
// Run with: node jpegSize.test.mjs
//
// We import readJpegDimensionsFromSOF directly to avoid pulling in `utif`
// at module-load time (which expects a browser-ish environment in some paths).

import assert from 'node:assert/strict';
import { readJpegDimensionsFromSOF } from '../../app/nefJpegPreview.js';

// Build a minimal valid JPEG: SOI + APP0 (ignored segment) + SOF0 + EOI.
// SOF0 layout: FF C0 LL LL  P  HH HH WW WW NC ...
function buildMiniJpeg(width, height) {
  // SOF0 segment payload: precision(1) + height(2) + width(2) + components(1) + 3 bytes per component.
  // We use 1 component for simplicity: total payload bytes = 1+2+2+1+3 = 9.
  // segLen field includes its own 2 bytes → 11.
  const sof = [
    0xFF, 0xC0, 0x00, 0x0B,
    0x08,
    (height >> 8) & 0xFF, height & 0xFF,
    (width >> 8) & 0xFF, width & 0xFF,
    0x01,
    0x01, 0x11, 0x00,
  ];
  // APP0 stub: FF E0 LL LL "JFIF\0" + payload (16 bytes total payload).
  const app0 = [0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00,
                0x01, 0x01, 0x00, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00];
  const soi = [0xFF, 0xD8];
  const eoi = [0xFF, 0xD9];
  return new Uint8Array([...soi, ...app0, ...sof, ...eoi]);
}

// 1. Standard JPEG with SOF0 → returns correct dimensions
{
  const jpg = buildMiniJpeg(1234, 567);
  const dims = readJpegDimensionsFromSOF(jpg.buffer, jpg.byteOffset, jpg.byteLength);
  assert.deepEqual(dims, { w: 1234, h: 567 });
}

// 2. Embedded inside a larger buffer (simulating NEF: JPEG at non-zero offset)
{
  const jpg = buildMiniJpeg(800, 600);
  const padded = new Uint8Array(jpg.length + 100);
  padded.set(jpg, 50);  // place at offset 50
  const dims = readJpegDimensionsFromSOF(padded.buffer, padded.byteOffset + 50, jpg.length);
  assert.deepEqual(dims, { w: 800, h: 600 });
}

// 3. Large dimensions (full-resolution camera preview)
{
  const jpg = buildMiniJpeg(6064, 4040);
  const dims = readJpegDimensionsFromSOF(jpg.buffer, jpg.byteOffset, jpg.byteLength);
  assert.deepEqual(dims, { w: 6064, h: 4040 });
}

// 4. Non-JPEG input (TIFF magic) → null
{
  const tiff = new Uint8Array([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00]);
  assert.equal(readJpegDimensionsFromSOF(tiff.buffer, 0, tiff.length), null);
}

// 5. Empty / too-short buffer → null
{
  const empty = new Uint8Array(0);
  assert.equal(readJpegDimensionsFromSOF(empty.buffer, 0, 0), null);
  const tiny = new Uint8Array([0xFF, 0xD8]);
  assert.equal(readJpegDimensionsFromSOF(tiny.buffer, 0, tiny.length), null);
}

// 6. Buffer truncated before SOF (only SOI + APP0 + EOI without SOF) → null
{
  const truncated = new Uint8Array([
    0xFF, 0xD8,
    0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x01, 0x00, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00,
    0xFF, 0xD9,
  ]);
  assert.equal(readJpegDimensionsFromSOF(truncated.buffer, 0, truncated.length), null);
}

// 7. Bad arguments → null (no throw)
{
  assert.equal(readJpegDimensionsFromSOF(null, 0, 0), null);
  assert.equal(readJpegDimensionsFromSOF(new Uint8Array(20).buffer, -1, 10), null);
  assert.equal(readJpegDimensionsFromSOF(new Uint8Array(20).buffer, 0, 0), null);
}

// 8. SOF2 (progressive) is also recognized
{
  const jpg = buildMiniJpeg(500, 400);
  // mutate SOF0 (0xC0) to SOF2 (0xC2) — same payload layout
  for (let i = 0; i < jpg.length - 1; i++) {
    if (jpg[i] === 0xFF && jpg[i + 1] === 0xC0) {
      jpg[i + 1] = 0xC2;
      break;
    }
  }
  const dims = readJpegDimensionsFromSOF(jpg.buffer, jpg.byteOffset, jpg.byteLength);
  assert.deepEqual(dims, { w: 500, h: 400 });
}

console.log('jpegSize tests: all passed');

// Tests for the embedded-JPEG preview extractor.
// Standalone node assert script, discovered by scripts/run-tests.mjs.
//
// The detach test documents the failure mode behind the Zf/Z8/Z9 fallback
// regression: LibRaw transfers the container ArrayBuffer to its worker, so
// extraction attempted AFTER open() sees a zero-length buffer and finds
// nothing. rawFileLoader must extract BEFORE handing the buffer to LibRaw.
import assert from 'node:assert/strict';
import { extractNefPreviewJpeg, readJpegDimensionsFromSOF } from './nefJpegPreview.js';

// Minimal well-formed JPEG header: SOI + APP0(JFIF) + SOF0 (1620x1080, 3 comp).
function makeJpegHeader(width, height) {
  const app0 = [0xFF, 0xE0, 0x00, 0x10,
    0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  // fix APP0 length: segment is 16 bytes (0x10) => payload 14 bytes after len
  const sof0 = [0xFF, 0xC0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xFF, height & 0xFF,
    (width >> 8) & 0xFF, width & 0xFF,
    0x03,
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  return Uint8Array.from([0xFF, 0xD8, ...app0, ...sof0]);
}

/** A fake RAW container: junk, a small thumbnail, junk, a big preview, junk. */
function makeContainer() {
  const container = new Uint8Array(64 * 1024);
  for (let i = 0; i < container.length; i++) container[i] = (i * 31) & 0xFF;
  // Erase accidental FF D8 FF patterns from the junk fill
  for (let i = 0; i < container.length - 2; i++) {
    if (container[i] === 0xFF && container[i + 1] === 0xD8) container[i + 1] = 0x00;
  }
  const thumb = makeJpegHeader(320, 240);   // below MIN_PREVIEW_WIDTH — must be skipped
  const preview = makeJpegHeader(1620, 1080);
  container.set(thumb, 1024);
  const previewOffset = 32 * 1024;
  container.set(preview, previewOffset);
  return { buffer: container.buffer, previewOffset };
}

// --- SOF parser reads dimensions -------------------------------------------
{
  const jpeg = makeJpegHeader(1620, 1080);
  const dims = readJpegDimensionsFromSOF(jpeg.buffer, 0, jpeg.byteLength);
  assert.deepEqual(dims, { w: 1620, h: 1080 });
}

// --- extractor finds the largest usable preview, skipping thumbnails --------
{
  const { buffer, previewOffset } = makeContainer();
  const extracted = extractNefPreviewJpeg(buffer);
  assert.ok(extracted, 'expected a preview');
  assert.equal(extracted.width, 1620);
  assert.equal(extracted.height, 1080);
  // jpegBytes must start at the preview's SOI
  assert.equal(extracted.jpegBytes[0], 0xFF);
  assert.equal(extracted.jpegBytes[1], 0xD8);
  assert.equal(extracted.jpegBytes.byteOffset, previewOffset);
}

// --- a detached container yields null (the LibRaw-transfer failure mode) ----
{
  const { buffer } = makeContainer();
  assert.ok(extractNefPreviewJpeg(buffer), 'sanity: works before detach');
  if (typeof buffer.transfer === 'function') {
    buffer.transfer(); // detaches `buffer`, like postMessage with a transfer list
    assert.equal(buffer.byteLength, 0, 'buffer must be detached');
    assert.equal(extractNefPreviewJpeg(buffer), null,
      'extraction after detach must return null — callers must stash BEFORE LibRaw.open()');
  }
}

// --- degenerate inputs ------------------------------------------------------
{
  assert.equal(extractNefPreviewJpeg(null), null);
  assert.equal(extractNefPreviewJpeg(new ArrayBuffer(8)), null);
  const noJpeg = new Uint8Array(4096).fill(0x42);
  assert.equal(extractNefPreviewJpeg(noJpeg.buffer), null);
}

console.log('nefJpegPreview tests: all passed');

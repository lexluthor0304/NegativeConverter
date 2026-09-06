// Tests for the embedded-JPEG preview extractor.
// Standalone node assert script, discovered by scripts/run-tests.mjs.
//
// The detach test documents the failure mode behind the Zf/Z8/Z9 fallback
// regression: LibRaw transfers the container ArrayBuffer to its worker, so
// extraction attempted AFTER open() sees a zero-length buffer and finds
// nothing. rawFileLoader must extract BEFORE handing the buffer to LibRaw.
import assert from 'node:assert/strict';
import { extractNefPreviewJpeg, readJpegDimensionsFromSOF, findJpegEndOffset } from './nefJpegPreview.js';

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

// --- only browser-decodable frame types count as previews -------------------
// SOF3 (lossless) and SOF9/SOF11 (arithmetic) are how CR2/DNG store the raw
// mosaic. Accepting one meant picking a sensor-sized stream that
// createImageBitmap can never decode, over the real baseline preview.
{
  function makeSofVariant(marker, precision, width, height) {
    const sof = [0xFF, marker, 0x00, 0x11, precision,
      (height >> 8) & 0xFF, height & 0xFF,
      (width >> 8) & 0xFF, width & 0xFF,
      0x03,
      0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
    return Uint8Array.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00, ...sof]);
  }

  for (const marker of [0xC0, 0xC1, 0xC2]) {
    const jpeg = makeSofVariant(marker, 8, 4000, 3000);
    assert.deepEqual(
      readJpegDimensionsFromSOF(jpeg.buffer, 0, jpeg.byteLength),
      { w: 4000, h: 3000 },
      `SOF marker C${(marker & 0xF).toString(16)} must be accepted`
    );
  }

  for (const marker of [0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF]) {
    const jpeg = makeSofVariant(marker, 8, 6000, 4000);
    assert.equal(
      readJpegDimensionsFromSOF(jpeg.buffer, 0, jpeg.byteLength),
      null,
      `lossless/arithmetic SOF ${marker.toString(16)} must be rejected`
    );
  }

  // 12-bit precision is not decodable by any browser either.
  const twelveBit = makeSofVariant(0xC0, 12, 5000, 4000);
  assert.equal(readJpegDimensionsFromSOF(twelveBit.buffer, 0, twelveBit.byteLength), null);
}

// --- the preview copy stops at EOI, not at the end of the container ---------
{
  function makeCompleteJpeg(width, height) {
    const header = makeJpegHeader(width, height);
    // SOS, then entropy data containing a stuffed FF 00 and a restart marker,
    // then an FF fill byte before EOI. (A bare FF FF cannot occur inside
    // entropy data — every literal FF there is stuffed with a following 00.)
    const sos = [0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00];
    const scan = [0x12, 0xFF, 0x00, 0x34, 0xFF, 0xD0, 0x56, 0x78];
    return Uint8Array.from([...header, ...sos, ...scan, 0xFF, 0xFF, 0xD9]);
  }

  const preview = makeCompleteJpeg(1620, 1080);
  assert.equal(findJpegEndOffset(preview, 0), preview.length, 'EOI is the end of the stream');

  // Bury it near the START of a big container, the way Nikon/Phase One do.
  const container = new Uint8Array(200 * 1024);
  for (let i = 0; i < container.length; i++) container[i] = (i * 31) & 0xFF;
  for (let i = 0; i < container.length - 2; i++) {
    if (container[i] === 0xFF && container[i + 1] === 0xD8) container[i + 1] = 0x00;
  }
  const previewOffset = 1024;
  container.set(preview, previewOffset);

  const extracted = extractNefPreviewJpeg(container.buffer);
  assert.ok(extracted, 'expected a preview');
  assert.equal(extracted.jpegBytes.byteOffset, previewOffset);
  assert.equal(extracted.jpegBytes.byteLength, preview.length,
    'copy must span SOI..EOI, not SOI..end-of-container');
  assert.ok(extracted.jpegBytes.byteLength < container.byteLength / 100);
  assert.equal(extracted.jpegBytes[extracted.jpegBytes.length - 2], 0xFF);
  assert.equal(extracted.jpegBytes[extracted.jpegBytes.length - 1], 0xD9);
}

// --- no EOI (truncated file): fall back to end-of-buffer so the preview lives
{
  const { buffer, previewOffset } = makeContainer();
  const extracted = extractNefPreviewJpeg(buffer);
  assert.equal(extracted.jpegBytes.byteLength, buffer.byteLength - previewOffset);
  assert.equal(findJpegEndOffset(new Uint8Array(buffer), previewOffset), -1);
}

assert.equal(findJpegEndOffset(new Uint8Array([1, 2, 3, 4]), 0), -1);
assert.equal(findJpegEndOffset(null, 0), -1);

console.log('nefJpegPreview tests: all passed');

// Hard regression: PR #81's NEF fallback could not select a usable IFD on
// `DSC_4127.NEF` because all of its embedded JPEG IFDs lacked t256/t257.
// This smoke loads the real fixture and asserts the synchronous extraction
// step (`extractNefPreviewJpeg`) finds a full-resolution preview. The actual
// JPEG decode happens in the browser via `createImageBitmap` and isn't
// exercised here — but if extraction returns the right offset/size with
// the right SOF dimensions, the browser layer is trivial to verify.
//
// Run: node negative2positive/src/silvercore/util/nef-fixture.smoke.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const { extractNefPreviewJpeg } = await import('../../app/nefJpegPreview.js');

const FIXTURE = path.resolve(process.cwd(), 'DSC_4127.NEF');
if (!fs.existsSync(FIXTURE)) {
  console.warn(`[skip] ${FIXTURE} not found — drop a Nikon Z f NEF here to run this smoke`);
  process.exit(0);
}

const buf = fs.readFileSync(FIXTURE);
const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

console.log(`Input: ${path.basename(FIXTURE)} (${(buf.byteLength / 1024 / 1024).toFixed(1)} MB)`);

const start = Date.now();
const extracted = extractNefPreviewJpeg(arrayBuffer);
const elapsed = Date.now() - start;

console.log(`extractNefPreviewJpeg returned in ${elapsed}ms`);

assert.ok(extracted, 'extractNefPreviewJpeg returned null — IFD selection still broken');
assert.ok(extracted.jpegBytes instanceof Uint8Array, 'jpegBytes is not Uint8Array');
assert.ok(extracted.jpegBytes.byteLength > 100_000, `jpeg too small: ${extracted.jpegBytes.byteLength} bytes — likely picked a thumbnail`);

// Verify it's actually a JPEG (SOI marker)
assert.equal(extracted.jpegBytes[0], 0xFF, 'first byte is not 0xFF');
assert.equal(extracted.jpegBytes[1], 0xD8, 'second byte is not 0xD8 (not a JPEG)');

assert.ok(extracted.width >= 1000, `expected width >= 1000, got ${extracted.width}`);
assert.ok(extracted.height >= 700, `expected height >= 700, got ${extracted.height}`);

// Sanity: the embedded camera preview should be at least 1/4 the original 6064x4040
// RAW resolution. If we accidentally selected a thumbnail, this catches it.
const RAW_PIXELS = 6064 * 4040;
const previewPixels = extracted.width * extracted.height;
const ratio = previewPixels / RAW_PIXELS;
console.log(`Output: ${extracted.width}×${extracted.height} (${(ratio * 100).toFixed(1)}% of raw resolution, ${(extracted.jpegBytes.byteLength / 1024 / 1024).toFixed(2)} MB JPEG)`);
assert.ok(ratio >= 0.5, `preview ratio ${ratio.toFixed(2)} suggests we picked the wrong IFD`);

console.log('✓ DSC_4127.NEF smoke passed — extracted full-resolution preview JPEG');

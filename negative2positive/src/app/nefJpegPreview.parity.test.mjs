// Parity: the HE NEF fallback is an export source, and which embedded JPEG it
// decodes is decided by readJpegDimensionsFromSOF. #235 moved its body into
// the shared parseJpegFrameHeader; this keeps HEAD's implementation (1703835)
// as the reference and requires identical answers on synthetic and fuzzed
// streams, so extractNefPreviewJpeg keeps picking the same preview.
import assert from 'node:assert/strict';
import { readJpegDimensionsFromSOF, extractNefPreviewJpeg } from './nefJpegPreview.js';

const REFERENCE_SCAN_LIMIT = 65_536;
const REFERENCE_MIN_WIDTH = 1000;
function referenceReadJpegDimensionsFromSOF(buffer, offset, length) {
  if (!buffer || typeof offset !== 'number' || typeof length !== 'number') return null;
  if (offset < 0 || length <= 4) return null;
  const end = Math.min(offset + Math.min(length, REFERENCE_SCAN_LIMIT), buffer.byteLength);
  if (end - offset < 4) return null;
  const bytes = new Uint8Array(buffer, offset, end - offset);

  // Verify SOI (Start Of Image)
  if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null;

  let p = 2;
  while (p + 1 < bytes.length) {
    if (bytes[p] !== 0xFF) return null;
    // Skip marker padding bytes (0xFF fill before the actual marker code)
    let q = p + 1;
    while (q < bytes.length && bytes[q] === 0xFF) q++;
    if (q >= bytes.length) return null;
    const marker = bytes[q];
    p = q;

    // Standalone markers — no segment length, just the 2 bytes
    if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) {
      p += 1;
      continue;
    }

    // Start Of Frame markers (carry width/height).
    // Only SOF0/1/2 (baseline, extended sequential, progressive) at 8-bit
    // precision are decodable by a browser. SOF3 and the 5-7/9-11/13-15 range
    // are lossless/arithmetic frames — that is exactly how Canon CR2 and many
    // DNGs store the raw mosaic, and picking one as "the largest preview"
    // hands createImageBitmap a stream it can never decode.
    // C4 (DHT), C8 (JPG reserved) and CC (DAC) are not frames at all and fall
    // through to the generic segment skip below.
    const isFrameMarker = marker >= 0xC0 && marker <= 0xCF
      && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
    if (isFrameMarker) {
      if (marker > 0xC2) return null;
      // Layout from marker byte: marker(1) + segLen(2) + precision(1) + height(2) + width(2) + numComponents(1)
      if (p + 8 >= bytes.length) return null;
      const segLen = (bytes[p + 1] << 8) | bytes[p + 2];
      const precision = bytes[p + 3];
      const height = (bytes[p + 4] << 8) | bytes[p + 5];
      const width = (bytes[p + 6] << 8) | bytes[p + 7];
      const numComponents = bytes[p + 8];

      // Validate: 8-bit precision only, segment length must match the number
      // of components, dimensions must be plausible for a camera preview.
      if (precision !== 8) return null;
      if (segLen < 8) return null;
      // Expected segLen = 8 + 3*numComponents (8 = marker+segLen+precision+h+w)
      // Allow some tolerance for different JPEG variants.
      const expectedSegLen = 8 + 3 * numComponents;
      if (segLen !== expectedSegLen && segLen !== expectedSegLen + 1) return null;
      if (width < REFERENCE_MIN_WIDTH || height < 300) return null;
      if (width > 20000 || height > 20000) return null;

      return { w: width, h: height };
    }

    // SOS = Start Of Scan = compressed image data. If we hit it before any
    // SOF, the JPEG is malformed for our purposes.
    if (marker === 0xDA) return null;

    // Otherwise: variable-length segment, skip it
    if (p + 3 >= bytes.length) return null;
    const segLen = (bytes[p + 1] << 8) | bytes[p + 2];
    if (segLen < 2) return null;
    p = p + 1 + segLen;
  }
  return null;
}

function header(width, height, { sof = 0xC0, precision = 8, components = 3, segExtra = 0, app = 0, fill = 0 } = {}) {
  const out = [0xFF, 0xD8];
  if (app) { const n = app + 2; out.push(0xFF, 0xE1, n >> 8, n & 0xFF, ...new Array(app).fill(0x41)); }
  for (let i = 0; i < fill; i++) out.push(0xFF);
  const seg = 8 + 3 * components + segExtra;
  out.push(0xFF, sof, seg >> 8, seg & 0xFF, precision, height >> 8, height & 0xFF, width >> 8, width & 0xFF, components);
  for (let c = 0; c < components; c++) out.push(c + 1, 0x11, 0);
  out.push(0xFF, 0xDA, 0, 8, 1, 1, 0, 0, 0x3F, 0, 1, 2, 3, 0xFF, 0xD9);
  return Uint8Array.from(out);
}

let seed = 235;
const random = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
const same = (bytes, offset, length, label) => {
  assert.deepEqual(readJpegDimensionsFromSOF(bytes.buffer, offset, length),
    referenceReadJpegDimensionsFromSOF(bytes.buffer, offset, length), label);
};

const shapes = [];
for (const [w, h] of [[1620, 1080], [999, 800], [1000, 300], [1000, 299], [20000, 400], [20001, 400], [6048, 4032], [720, 480]]) {
  for (const sof of [0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC9, 0xC4, 0xCC]) {
    for (const precision of [8, 12]) {
      for (const segExtra of [0, 1, 2, -1]) shapes.push(header(w, h, { sof, precision, segExtra }));
    }
  }
  shapes.push(header(w, h, { app: 70_000 }), header(w, h, { app: 3000, fill: 3 }), header(w, h, { components: 1 }));
}
for (const [i, bytes] of shapes.entries()) {
  for (const length of [0, 3, 4, 5, 9, 20, 25, bytes.length - 1, bytes.length, bytes.length + 100]) {
    same(bytes, 0, length, `shape ${i} length ${length}`);
  }
  same(bytes, -1, bytes.length, 'negative offset');
  same(bytes, 2, bytes.length, 'offset past SOI');
}
// Fuzz: random bit flips and truncations of valid headers inside a container.
for (let n = 0; n < 20000; n++) {
  const base = shapes[Math.floor(random() * shapes.length)];
  const container = new Uint8Array(base.length + 64);
  const at = Math.floor(random() * 32);
  container.set(base, at);
  for (let flips = Math.floor(random() * 4); flips > 0; flips--) {
    container[Math.floor(random() * container.length)] = Math.floor(random() * 256);
  }
  same(container, at, Math.floor(random() * (container.length - at + 8)), `fuzz ${n}`);
}
// The whole-buffer extractor therefore chooses the same preview.
{
  const container = new Uint8Array(200_000);
  container.set(header(160, 120), 1000);
  container.set(header(1620, 1080), 20_000);
  container.set(header(6048, 4032, { app: 4000 }), 90_000);
  container.set(header(6048, 4032, { sof: 0xC3 }), 150_000);
  const found = extractNefPreviewJpeg(container.buffer);
  assert.deepEqual([found.width, found.height, found.jpegBytes.byteOffset], [6048, 4032, 90_000]);
}
console.log('nefJpegPreview parity tests passed: shared SOF parser matches HEAD');

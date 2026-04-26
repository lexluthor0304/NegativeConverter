// Fallback decoder for Nikon NEF (and other TIFF-based RAWs) when LibRaw can't
// decode the proprietary Bayer stream — most commonly Z9/Z8/Zf in
// "high-efficiency (HE/HE*)" compression mode.
//
// Approach: every NEF/TIFF-based RAW carries one or more camera-rendered JPEG
// previews inside the container. Rather than parsing the TIFF IFD tree to
// locate them, we scan the buffer for the JPEG SOI marker pattern (0xFF 0xD8
// 0xFF) and run each candidate through a SOF marker parser to get its real
// width/height. The browser's native JPEG decoder (`createImageBitmap`) then
// stops at EOI on its own, so we don't even need to find the JPEG end —
// passing it everything from SOI to end-of-buffer works.
//
// This eliminates the dependency on UTIF for this path. Container-level
// IFD parsing is no longer needed for the simple "find largest embedded
// preview" task.

const SOF_PARSER_SCAN_LIMIT = 65_536; // SOF is always near the JPEG header
const MIN_PREVIEW_WIDTH = 1000;       // skip tiny thumbnails (320x240 etc.)

/**
 * Read width/height from a JPEG byte stream's SOF (Start Of Frame) marker.
 *
 * @param {ArrayBuffer} buffer  full container buffer
 * @param {number} offset       byte offset of the JPEG within the container
 * @param {number} length       byte length of JPEG bytes available from offset
 * @returns {{w: number, h: number} | null}
 */
export function readJpegDimensionsFromSOF(buffer, offset, length) {
  if (!buffer || typeof offset !== 'number' || typeof length !== 'number') return null;
  if (offset < 0 || length <= 4) return null;
  const end = Math.min(offset + Math.min(length, SOF_PARSER_SCAN_LIMIT), buffer.byteLength);
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
    // Range C0–CF, but C4 (DHT), C8 (JPG reserved), CC (DAC) are NOT frames.
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      // Layout from marker byte: marker(1) + segLen(2) + precision(1) + height(2) + width(2)
      if (p + 7 >= bytes.length) return null;
      const height = (bytes[p + 4] << 8) | bytes[p + 5];
      const width = (bytes[p + 6] << 8) | bytes[p + 7];
      if (width <= 0 || height <= 0) return null;
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

/**
 * Find every position in the buffer that begins with the canonical JPEG
 * "FF D8 FF" SOI-followed-by-marker pattern. Cheap O(n) scan, ~30 ms on a
 * 20 MB NEF.
 */
function findJpegSoiPositions(arrayBuffer) {
  const u8 = new Uint8Array(arrayBuffer);
  const positions = [];
  const limit = u8.length - 2;
  for (let i = 0; i < limit; i++) {
    if (u8[i] === 0xFF && u8[i + 1] === 0xD8 && u8[i + 2] === 0xFF) {
      positions.push(i);
    }
  }
  return positions;
}

/**
 * Find the embedded full-resolution JPEG preview inside a TIFF-based RAW
 * (NEF, IIQ, etc.) and return its starting bytes plus dimensions, without
 * decoding the JPEG. Pure synchronous parsing — usable from Node tests.
 *
 * `jpegBytes` is a Uint8Array view that starts at the JPEG's SOI and runs
 * to the end of the container; the browser JPEG decoder stops at EOI so
 * trailing container bytes are harmless.
 *
 * @param {ArrayBuffer} arrayBuffer
 * @returns {{ jpegBytes: Uint8Array, width: number, height: number } | null}
 */
export function extractNefPreviewJpeg(arrayBuffer) {
  if (!arrayBuffer || arrayBuffer.byteLength < 64) return null;
  const positions = findJpegSoiPositions(arrayBuffer);
  if (positions.length === 0) return null;

  let best = null;
  let bestPixels = 0;
  for (const offset of positions) {
    const remaining = arrayBuffer.byteLength - offset;
    const dims = readJpegDimensionsFromSOF(arrayBuffer, offset, remaining);
    if (!dims || dims.w < MIN_PREVIEW_WIDTH) continue;
    const pixels = dims.w * dims.h;
    if (pixels > bestPixels) {
      bestPixels = pixels;
      best = { offset, width: dims.w, height: dims.h };
    }
  }
  if (!best) return null;

  const jpegBytes = new Uint8Array(arrayBuffer, best.offset, arrayBuffer.byteLength - best.offset);
  return { jpegBytes, width: best.width, height: best.height };
}

/**
 * Try to extract a usable embedded JPEG preview from a TIFF-based RAW (NEF, etc.)
 * and decode it via the browser's native JPEG decoder. Returns an `ImageData`
 * on success, or `null` if no suitable preview was found / decoding failed.
 * Never throws.
 *
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Promise<ImageData | null>}
 */
export async function tryNefJpegPreview(arrayBuffer) {
  const extracted = extractNefPreviewJpeg(arrayBuffer);
  if (!extracted) return null;
  const { jpegBytes, width, height } = extracted;

  // Slice into a standalone ArrayBuffer so the Blob doesn't pin the entire
  // RAW container in memory while createImageBitmap is decoding.
  let blob;
  try {
    const standalone = new Uint8Array(jpegBytes.byteLength);
    standalone.set(jpegBytes);
    blob = new Blob([standalone], { type: 'image/jpeg' });
  } catch (err) {
    console.warn('[NEF fallback] failed to wrap JPEG bytes:', err);
    return null;
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (err) {
    console.warn('[NEF fallback] createImageBitmap failed:', err);
    return null;
  }

  try {
    const w = bitmap.width || width;
    const h = bitmap.height || height;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, w, h);
  } catch (err) {
    console.warn('[NEF fallback] canvas paint/getImageData failed:', err);
    return null;
  } finally {
    try { bitmap.close?.(); } catch {}
  }
}

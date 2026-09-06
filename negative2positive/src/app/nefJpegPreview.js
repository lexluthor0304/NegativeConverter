// Fallback decoder for Nikon NEF (and other TIFF-based RAWs) when LibRaw can't
// decode the proprietary Bayer stream — most commonly Z9/Z8/Zf in
// "high-efficiency (HE/HE*)" compression mode.
//
// Approach: every NEF/TIFF-based RAW carries one or more camera-rendered JPEG
// previews inside the container. Rather than parsing the TIFF IFD tree to
// locate them, we scan the buffer for the JPEG SOI marker pattern (0xFF 0xD8
// 0xFF) and run each candidate through a SOF marker parser to get its real
// width/height. The browser's native JPEG decoder (`createImageBitmap`) then
// would stop at EOI on its own, but we locate the EOI anyway so the copy we
// hand it is the preview and not the rest of the container.
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
      if (width < MIN_PREVIEW_WIDTH || height < 300) return null;
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

/**
 * Find every position in the buffer that begins with the canonical JPEG
 * "FF D8 FF" SOI-followed-by-marker pattern. Cheap O(n) scan, ~30 ms on a
 * 20 MB NEF.
 */
function findJpegSoiPositions(u8) {
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
 * Byte offset just past the JPEG's EOI marker, starting from an SOI at
 * `start`. Returns -1 when the stream has no reachable EOI.
 *
 * Inside entropy-coded data a 0xFF byte is always followed by 0x00 (a stuffed
 * byte), a restart marker (D0–D7) or another 0xFF fill byte, so the first
 * other marker really is a segment boundary — which is what lets us stop at
 * the true end of a preview instead of copying the rest of the container.
 *
 * @param {Uint8Array} bytes
 * @param {number} start offset of the SOI
 * @returns {number} offset one past EOI, or -1
 */
export function findJpegEndOffset(bytes, start = 0) {
  if (!bytes || start < 0 || start + 3 >= bytes.length) return -1;
  if (bytes[start] !== 0xFF || bytes[start + 1] !== 0xD8) return -1;

  const n = bytes.length;
  let p = start + 2;
  while (p + 1 < n) {
    if (bytes[p] !== 0xFF) return -1;
    let q = p + 1;
    while (q < n && bytes[q] === 0xFF) q++;
    if (q >= n) return -1;
    const marker = bytes[q];
    p = q + 1;

    if (marker === 0xD9) return p;                                  // EOI
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) continue;
    if (marker === 0xD8) continue;                                  // nested SOI

    if (p + 1 >= n) return -1;
    const segLen = (bytes[p] << 8) | bytes[p + 1];
    if (segLen < 2) return -1;
    p += segLen;

    if (marker === 0xDA) {
      // Skip the entropy-coded scan until the next real marker.
      while (p + 1 < n) {
        if (bytes[p] !== 0xFF) { p++; continue; }
        const next = bytes[p + 1];
        if (next === 0x00 || (next >= 0xD0 && next <= 0xD7)) { p += 2; continue; }
        if (next === 0xFF) { p += 1; continue; }
        break;
      }
    }
  }
  return -1;
}

/**
 * Find the embedded full-resolution JPEG preview inside a TIFF-based RAW
 * (NEF, IIQ, etc.) and return its starting bytes plus dimensions, without
 * decoding the JPEG. Pure synchronous parsing — usable from Node tests.
 *
 * `jpegBytes` is a Uint8Array view that starts at the JPEG's SOI and ends at
 * its EOI (or at the end of the container when no EOI can be found).
 *
 * @param {ArrayBuffer} arrayBuffer
 * @returns {{ jpegBytes: Uint8Array, width: number, height: number } | null}
 */
export function extractNefPreviewJpeg(arrayBuffer) {
  if (!arrayBuffer || arrayBuffer.byteLength < 64) return null;
  const u8 = new Uint8Array(arrayBuffer);
  const positions = findJpegSoiPositions(u8);
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

  // Copy only as far as the JPEG's own EOI. Nikon/Phase One put the full-size
  // preview near the START of the container, so spanning to end-of-buffer
  // pinned tens to hundreds of MB for the whole LibRaw decode.
  const end = findJpegEndOffset(u8, best.offset);
  const length = end > best.offset
    ? end - best.offset
    : arrayBuffer.byteLength - best.offset;

  const jpegBytes = new Uint8Array(arrayBuffer, best.offset, length);
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

  // Slice into a standalone ArrayBuffer so the Blob doesn't pin the entire
  // RAW container in memory while createImageBitmap is decoding.
  let standalone;
  try {
    standalone = new Uint8Array(extracted.jpegBytes.byteLength);
    standalone.set(extracted.jpegBytes);
  } catch (err) {
    console.warn('[NEF fallback] failed to wrap JPEG bytes:', err);
    return null;
  }
  return decodeNefPreviewJpeg({
    jpegBytes: standalone,
    width: extracted.width,
    height: extracted.height,
  });
}

/**
 * Decode an already-extracted (and already-standalone) preview JPEG into
 * ImageData. Split from tryNefJpegPreview so callers can stash the extracted
 * bytes BEFORE handing the container to LibRaw — LibRaw transfers the
 * container ArrayBuffer to its worker, which detaches it on this thread and
 * makes any later extraction from it silently return nothing.
 *
 * @param {{ jpegBytes: Uint8Array, width?: number, height?: number } | null} extracted
 * @returns {Promise<ImageData | null>}
 */
export async function decodeNefPreviewJpeg(extracted) {
  if (!extracted || !extracted.jpegBytes || extracted.jpegBytes.byteLength < 4) return null;
  const { jpegBytes, width, height } = extracted;

  let blob;
  try {
    blob = new Blob([jpegBytes], { type: 'image/jpeg' });
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

// Fallback decoder for Nikon NEF (and other TIFF-based RAWs) when LibRaw can't
// decode the proprietary Bayer stream — most commonly Z9/Z8/Zf in
// "high-efficiency (HE/HE*)" compression mode. Every NEF carries a
// camera-rendered JPEG preview inside a SubIFD; we walk the TIFF container,
// find the largest JPEG-compressed image, and decode it with the browser's
// native JPEG decoder via `createImageBitmap`.
//
// We deliberately do NOT use `UTIF.decodeImage` for the preview step:
// camera-embedded preview IFDs typically only carry t513/t514 (JPEG offset +
// length) and omit t256/t257/t258 plus the strip-based (t273/t279) fields
// that UTIF expects. UTIF silently no-ops in that shape. Slicing the bytes
// out and handing them to the browser's JPEG decoder is more reliable.

import UTIFImport from 'utif';

const UTIF = (UTIFImport && typeof UTIFImport.decode === 'function')
  ? UTIFImport
  : (UTIFImport && UTIFImport.default && typeof UTIFImport.default.decode === 'function'
    ? UTIFImport.default
    : UTIFImport);

const TIFF_TAG_IMAGE_WIDTH = 't256';
const TIFF_TAG_IMAGE_LENGTH = 't257';
const TIFF_TAG_COMPRESSION = 't259';
const TIFF_TAG_JPEG_OFFSET = 't513';
const TIFF_TAG_JPEG_LENGTH = 't514';
const COMPRESSION_OLD_JPEG = 6;
const COMPRESSION_NEW_JPEG = 7;

// Embedded preview must be at least this wide to be useful; tiny thumbnails
// (320×240 etc.) would just give the user a blurry mess so we skip them and
// let the caller throw a friendly error instead.
const MIN_PREVIEW_WIDTH = 1000;

/**
 * Read width/height from a JPEG byte stream's SOF (Start Of Frame) marker.
 * Many camera-embedded preview JPEGs in NEFs don't carry t256/t257 in their
 * IFD — the only place to get true dimensions is parsing the JPEG itself.
 *
 * @param {ArrayBuffer} buffer  full container buffer
 * @param {number} offset       byte offset of the JPEG within the container
 * @param {number} length       byte length of the JPEG
 * @returns {{w: number, h: number} | null}
 */
export function readJpegDimensionsFromSOF(buffer, offset, length) {
  if (!buffer || typeof offset !== 'number' || typeof length !== 'number') return null;
  if (offset < 0 || length <= 4) return null;
  const end = Math.min(offset + length, buffer.byteLength);
  if (end - offset < 4) return null;
  const bytes = new Uint8Array(buffer, offset, end - offset);

  // Verify SOI (Start Of Image)
  if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null;

  let p = 2;
  // Each segment is `FF Mn LL LL [payload]`, except standalone markers
  // (SOI/EOI/RSTn/TEM) which are just `FF Mn`. SOF markers carry dimensions
  // at a fixed offset within the payload.
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
      p += 1;  // already at marker byte; advance past it
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

    // SOS = Start Of Scan = compressed image data begins.
    // If we hit it before any SOF, the JPEG is malformed for our purposes.
    if (marker === 0xDA) return null;

    // Otherwise: variable-length segment, skip it
    if (p + 3 >= bytes.length) return null;
    const segLen = (bytes[p + 1] << 8) | bytes[p + 2];
    if (segLen < 2) return null;
    p = p + 1 + segLen;  // marker byte + segment payload
  }
  return null;
}

function collectAllIfds(topIfds) {
  const out = [];
  const visited = new WeakSet();
  function walk(ifd) {
    if (!ifd || typeof ifd !== 'object' || visited.has(ifd)) return;
    visited.add(ifd);
    out.push(ifd);
    if (Array.isArray(ifd.subIFD)) {
      for (const sub of ifd.subIFD) walk(sub);
    }
    if (ifd.exifIFD) walk(ifd.exifIFD);
  }
  for (const ifd of topIfds) walk(ifd);
  return out;
}

function getIfdDim(ifd, key) {
  const v = ifd[key];
  return Array.isArray(v) && v.length > 0 ? Number(v[0]) || 0 : 0;
}

function getIfdJpegPointer(ifd) {
  const offset = ifd[TIFF_TAG_JPEG_OFFSET]?.[0];
  const length = ifd[TIFF_TAG_JPEG_LENGTH]?.[0];
  if (typeof offset !== 'number' || typeof length !== 'number') return null;
  return { offset, length };
}

function getIfdJpegDimensions(ifd, arrayBuffer) {
  // 1) Prefer the IFD's own t256/t257 when present (cheap, exact)
  const tw = getIfdDim(ifd, TIFF_TAG_IMAGE_WIDTH);
  const th = getIfdDim(ifd, TIFF_TAG_IMAGE_LENGTH);
  if (tw > 0 && th > 0) return { w: tw, h: th };

  // 2) Fall back to parsing the JPEG byte stream's SOF marker. Most NEF
  //    camera-rendered preview IFDs (top0 / first subIFD) leave t256/t257
  //    blank and only encode dimensions inside the JPEG itself.
  const ptr = getIfdJpegPointer(ifd);
  if (!ptr) return null;
  return readJpegDimensionsFromSOF(arrayBuffer, ptr.offset, ptr.length);
}

function isJpegIfd(ifd) {
  const cmpr = ifd[TIFF_TAG_COMPRESSION]?.[0];
  if (cmpr === COMPRESSION_OLD_JPEG || cmpr === COMPRESSION_NEW_JPEG) return true;
  return !!getIfdJpegPointer(ifd);
}

/**
 * Pick the largest JPEG-compressed IFD (the camera-rendered preview).
 * Exported for testing.
 */
export function pickLargestJpegIfd(ifds, arrayBuffer) {
  let best = null;
  let bestPixels = 0;
  for (const ifd of ifds) {
    if (!isJpegIfd(ifd)) continue;
    const dims = getIfdJpegDimensions(ifd, arrayBuffer);
    if (!dims || dims.w < MIN_PREVIEW_WIDTH) continue;
    const pixels = dims.w * dims.h;
    if (pixels > bestPixels) {
      bestPixels = pixels;
      best = { ifd, w: dims.w, h: dims.h, pointer: getIfdJpegPointer(ifd) };
    }
  }
  return best;
}

/**
 * Find the embedded full-resolution JPEG preview inside a TIFF-based RAW
 * (NEF, IIQ, etc.) and return its raw bytes plus dimensions, without
 * decoding them. Pure synchronous parsing — usable from Node tests.
 *
 * @param {ArrayBuffer} arrayBuffer
 * @returns {{ jpegBytes: Uint8Array, width: number, height: number } | null}
 */
export function extractNefPreviewJpeg(arrayBuffer) {
  let topIfds;
  try {
    topIfds = UTIF.decode(arrayBuffer);
  } catch (err) {
    console.warn('[NEF fallback] UTIF.decode failed:', err);
    return null;
  }
  if (!Array.isArray(topIfds) || topIfds.length === 0) return null;

  const allIfds = collectAllIfds(topIfds);
  const choice = pickLargestJpegIfd(allIfds, arrayBuffer);
  if (!choice || !choice.pointer) return null;

  const { offset, length } = choice.pointer;
  if (offset < 0 || length <= 0 || offset + length > arrayBuffer.byteLength) return null;
  // Slice into a fresh buffer so the caller can hand it to Blob/Worker
  // without retaining the entire RAW container in memory.
  const jpegBytes = new Uint8Array(arrayBuffer, offset, length);
  return { jpegBytes, width: choice.w, height: choice.h };
}

/**
 * Try to extract a usable embedded JPEG preview from a TIFF-based RAW (NEF, etc.)
 * and decode it via the browser's native JPEG decoder. Returns an `ImageData`
 * on success, or `null` if no suitable preview was found / decoding failed.
 * Never throws.
 *
 * Async because `createImageBitmap` is async — callers (loadRawFile) already
 * run inside an async function.
 *
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Promise<ImageData | null>}
 */
export async function tryNefJpegPreview(arrayBuffer) {
  const extracted = extractNefPreviewJpeg(arrayBuffer);
  if (!extracted) return null;
  const { jpegBytes, width, height } = extracted;

  // Hand the JPEG to the browser. Slice into a standalone ArrayBuffer so the
  // Blob doesn't pin the whole RAW container.
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

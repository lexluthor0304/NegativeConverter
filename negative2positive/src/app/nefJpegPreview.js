// Fallback decoder for Nikon NEF (and other TIFF-based RAWs) when LibRaw can't
// decode the proprietary Bayer stream — most commonly Z9/Z8/Zf in
// "high-efficiency (HE/HE*)" compression mode. Every NEF carries a
// camera-rendered, full-resolution JPEG preview inside a SubIFD; we walk the
// TIFF container, find the largest JPEG-compressed image, and let UTIF decode
// it. Same three-step pattern as the iPhone ProRaw fallback already in
// `loadRawFile`, only the IFD selection is different.

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

function pickLargestJpegIfd(ifds) {
  let best = null;
  let bestPixels = 0;
  for (const ifd of ifds) {
    const cmprArr = ifd[TIFF_TAG_COMPRESSION];
    const cmpr = Array.isArray(cmprArr) ? cmprArr[0] : null;
    const hasJpegPointer = ifd[TIFF_TAG_JPEG_OFFSET] && ifd[TIFF_TAG_JPEG_LENGTH];
    const isJpeg = cmpr === COMPRESSION_OLD_JPEG || cmpr === COMPRESSION_NEW_JPEG;
    if (!isJpeg && !hasJpegPointer) continue;

    const w = getIfdDim(ifd, TIFF_TAG_IMAGE_WIDTH);
    const h = getIfdDim(ifd, TIFF_TAG_IMAGE_LENGTH);
    if (w < MIN_PREVIEW_WIDTH) continue;

    const pixels = w * h;
    if (pixels > bestPixels) {
      bestPixels = pixels;
      best = ifd;
    }
  }
  return best;
}

/**
 * Try to extract a usable embedded JPEG preview from a TIFF-based RAW (NEF, etc.).
 * Returns an `ImageData` on success, or `null` if no suitable preview was
 * found / decoding failed. Never throws.
 */
export function tryNefJpegPreview(arrayBuffer) {
  let topIfds;
  try {
    topIfds = UTIF.decode(arrayBuffer);
  } catch (err) {
    console.warn('[NEF fallback] UTIF.decode failed:', err);
    return null;
  }
  if (!Array.isArray(topIfds) || topIfds.length === 0) return null;

  const allIfds = collectAllIfds(topIfds);
  const previewIfd = pickLargestJpegIfd(allIfds);
  if (!previewIfd) return null;

  try {
    UTIF.decodeImage(arrayBuffer, previewIfd, topIfds);
    const rgba = UTIF.toRGBA8(previewIfd);
    const w = previewIfd.width || getIfdDim(previewIfd, TIFF_TAG_IMAGE_WIDTH);
    const h = previewIfd.height || getIfdDim(previewIfd, TIFF_TAG_IMAGE_LENGTH);
    if (!w || !h || !rgba || rgba.length !== w * h * 4) return null;
    return new ImageData(new Uint8ClampedArray(rgba), w, h);
  } catch (err) {
    console.warn('[NEF fallback] UTIF.decodeImage failed:', err);
    return null;
  }
}

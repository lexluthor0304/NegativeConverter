// JPEG frame-header parsing shared by the whole-buffer HE NEF fallback scan
// (nefJpegPreview.js) and the random-access embedded preview locator
// (rawEmbeddedPreview.js). Pure: no DOM, no workers, safe in any worker.

export const SOF_PARSER_SCAN_LIMIT = 65_536; // SOF is always near the JPEG header
const MAX_PREVIEW_SIDE = 20000;

// EXIF Orientation from an APP1 "Exif\0\0" payload. Only IFD0 is read, and
// every access is bounded by the bytes we actually hold: the segment may be
// longer than the slice that was read.
function readExifOrientation(bytes, start, end) {
  if (end - start < 14) return 0;
  if (bytes[start] !== 0x45 || bytes[start + 1] !== 0x78 || bytes[start + 2] !== 0x69
    || bytes[start + 3] !== 0x66 || bytes[start + 4] !== 0 || bytes[start + 5] !== 0) return 0;
  const tiff = start + 6;
  const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
  if (!little && !(bytes[tiff] === 0x4D && bytes[tiff + 1] === 0x4D)) return 0;
  const u16 = at => (little ? bytes[at] | (bytes[at + 1] << 8) : (bytes[at] << 8) | bytes[at + 1]);
  const u32 = at => (little
    ? (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0
    : ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0);
  if (u16(tiff + 2) !== 42) return 0;
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return 0;
  const count = u16(ifd);
  for (let i = 0; i < count && i < 512; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return 0;
    if (u16(entry) === 0x0112 && u16(entry + 2) === 3) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 0;
    }
  }
  return 0;
}

/**
 * Parse a JPEG stream's header up to its frame (SOF) marker.
 *
 * Shared by the whole-buffer NEF fallback scan and the random-access embedded
 * preview locator (rawEmbeddedPreview.js), which differ only in the size floor.
 *
 * @param {Uint8Array} bytes  bytes starting at the JPEG's SOI (may be a prefix)
 * @param {{ minWidth?: number, minHeight?: number }} [options]
 * @returns {{ width: number, height: number, marker: number, components: number, orientation: number }
 *   | { truncated: true } | null}
 *   `truncated` means the prefix ended before the frame header: a longer read
 *   may still succeed. null means the stream is not a browser-decodable
 *   8-bit baseline/extended/progressive JPEG of an acceptable size.
 */
export function parseJpegFrameHeader(bytes, { minWidth = 1, minHeight = 1 } = {}) {
  if (!bytes || bytes.length < 4) return bytes && bytes.length ? { truncated: true } : null;
  // Verify SOI (Start Of Image)
  if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null;
  const truncated = { truncated: true };
  let orientation = 0;

  let p = 2;
  while (p + 1 < bytes.length) {
    if (bytes[p] !== 0xFF) return null;
    // Skip marker padding bytes (0xFF fill before the actual marker code)
    let q = p + 1;
    while (q < bytes.length && bytes[q] === 0xFF) q++;
    if (q >= bytes.length) return truncated;
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
      if (p + 8 >= bytes.length) return truncated;
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
      if (width < minWidth || height < minHeight) return null;
      if (width > MAX_PREVIEW_SIDE || height > MAX_PREVIEW_SIDE) return null;

      return { width, height, marker, components: numComponents, orientation };
    }

    // SOS = Start Of Scan = compressed image data. If we hit it before any
    // SOF, the JPEG is malformed for our purposes.
    if (marker === 0xDA) return null;

    // Otherwise: variable-length segment, skip it
    if (p + 3 >= bytes.length) return truncated;
    const segLen = (bytes[p + 1] << 8) | bytes[p + 2];
    if (segLen < 2) return null;
    if (marker === 0xE1 && !orientation) {
      orientation = readExifOrientation(bytes, p + 3, Math.min(bytes.length, p + 1 + segLen));
    }
    p = p + 1 + segLen;
  }
  return truncated;
}

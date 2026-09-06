// Attaches analog metadata to an encoded export without re-encoding it:
// PNG gets an eXIf and an iTXt (XMP) chunk right after IHDR, JPEG gets two
// APP1 segments (EXIF, XMP) after SOI/JFIF. TIFF carries its metadata in the
// IFD, which the encoder writes itself (imageEncoders.encodeTiffBlob). The
// Blob is spliced, so a large image is never copied.

import { buildExifPayload, jpegApp1Exif, jpegApp1Xmp, jpegInsertOffset } from '../workers/exifWriter.js';
import { pngExifChunk, pngXmpChunk, PNG_HEADER_LENGTH } from '../workers/imageEncoders.js';

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

async function headBytes(blob, length) {
  return new Uint8Array(await blob.slice(0, Math.min(length, blob.size)).arrayBuffer());
}

/**
 * @param {Blob} blob encoded image
 * @param {'png'|'jpeg'|'tiff'} format
 * @param {{exif?: object, xmp?: string}|null} metadata from analogMetadata.buildExportMetadata
 * @returns {Promise<Blob>} the same blob when there is nothing to add
 */
export async function attachMetadataToBlob(blob, format, metadata) {
  if (!metadata || !(blob instanceof Blob)) return blob;
  const exifPayload = metadata.exif ? buildExifPayload(metadata.exif) : null;
  if (format === 'png') {
    const head = await headBytes(blob, PNG_HEADER_LENGTH);
    if (head.length < PNG_HEADER_LENGTH || PNG_SIGNATURE.some((b, i) => head[i] !== b)) return blob;
    const parts = [blob.slice(0, PNG_HEADER_LENGTH)];
    if (exifPayload) parts.push(pngExifChunk(exifPayload));
    if (metadata.xmp) parts.push(pngXmpChunk(metadata.xmp));
    parts.push(blob.slice(PNG_HEADER_LENGTH));
    return new Blob(parts, { type: blob.type || 'image/png' });
  }
  if (format === 'jpeg') {
    const head = await headBytes(blob, 64);
    let offset;
    try { offset = jpegInsertOffset(head); } catch { return blob; }
    const parts = [blob.slice(0, offset)];
    if (exifPayload) parts.push(jpegApp1Exif(exifPayload));
    if (metadata.xmp) parts.push(jpegApp1Xmp(metadata.xmp));
    parts.push(blob.slice(offset));
    return new Blob(parts, { type: blob.type || 'image/jpeg' });
  }
  return blob;
}

// ---- readers used by tests and diagnostics ----

/** PNG chunks as [{ type, data }] (no CRC check). */
export function listPngChunks(bytes) {
  const chunks = [];
  let p = 8;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (p + 8 <= bytes.length) {
    const length = view.getUint32(p, false);
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    chunks.push({ type, data: bytes.subarray(p + 8, p + 8 + length) });
    p += 12 + length;
    if (type === 'IEND') break;
  }
  return chunks;
}

/** JPEG segments before the scan as [{ marker, data }]. */
export function listJpegSegments(bytes) {
  const segments = [];
  let p = 2;
  while (p + 4 <= bytes.length && bytes[p] === 0xFF) {
    const marker = bytes[p + 1];
    if (marker === 0xDA) break; // SOS: entropy-coded data follows
    const length = (bytes[p + 2] << 8) | bytes[p + 3];
    segments.push({ marker, data: bytes.subarray(p + 4, p + 2 + length) });
    p += 2 + length;
  }
  return segments;
}

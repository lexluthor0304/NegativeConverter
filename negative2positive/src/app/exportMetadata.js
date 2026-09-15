import { SRGB_PROFILE } from './srgbProfile.js';
import { deflate } from 'pako';
// Attaches analog metadata to an encoded export without re-encoding it:
// PNG gets an eXIf and an iTXt (XMP) chunk right after IHDR, JPEG gets two
// APP1 segments (EXIF, XMP) after SOI/JFIF. TIFF carries its metadata in the
// IFD, which the encoder writes itself (imageEncoders.encodeTiffBlob). The
// Blob is spliced, so a large image is never copied.

import { buildExifPayload, jpegApp1Exif, jpegApp1Xmp, jpegInsertOffset } from '../workers/exifWriter.js';
import { createPngChunk, pngExifChunk, pngXmpChunk, PNG_HEADER_LENGTH } from '../workers/imageEncoders.js';

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
  if (!(blob instanceof Blob)) return blob;
  metadata ||= {};
  const exifPayload = metadata.exif ? buildExifPayload(metadata.exif) : null;
  if (format === 'png') {
    const head = await headBytes(blob, PNG_HEADER_LENGTH);
    if (head.length < PNG_HEADER_LENGTH || PNG_SIGNATURE.some((b, i) => head[i] !== b)) return blob;
    const name = new TextEncoder().encode('sRGB\0\0');
    const compressed = deflate(SRGB_PROFILE);
    const iccp = new Uint8Array(name.length + compressed.length);
    iccp.set(name); iccp.set(compressed, name.length);
    const parts = [blob.slice(0, PNG_HEADER_LENGTH), createPngChunk('iCCP', iccp)];
    if (exifPayload) parts.push(pngExifChunk(exifPayload));
    if (metadata.xmp) parts.push(pngXmpChunk(metadata.xmp));
    // iCCP replaces browser-written sRGB/gAMA/cHRM chunks, which describe
    // an alternative colour space and must not contradict the ICC profile.
    let cursor = PNG_HEADER_LENGTH;
    while (cursor + 12 <= blob.size) {
      const chunk = await headBytes(blob.slice(cursor), 8);
      const length = new DataView(chunk.buffer).getUint32(0);
      const type = String.fromCharCode(...chunk.subarray(4));
      if (cursor + length + 12 > blob.size) throw new Error('Invalid PNG chunk');
      // PNG colour-space chunks precede IDAT. Keep the encoded image tail
      // intact instead of creating and reading a Blob for every IDAT chunk.
      // Camera-sized canvas PNGs can contain thousands of those chunks.
      if (type === 'IDAT') {
        parts.push(blob.slice(cursor));
        break;
      }
      if (!['iCCP', 'sRGB', 'gAMA', 'cHRM'].includes(type)) parts.push(blob.slice(cursor, cursor + length + 12));
      cursor += length + 12;
      if (type === 'IEND') break;
    }
    return new Blob(parts, { type: blob.type || 'image/png' });
  }
  if (format === 'jpeg') {
    const head = await headBytes(blob, 64);
    let offset;
    try { offset = jpegInsertOffset(head); } catch { return blob; }
    const payload = new Uint8Array(14 + SRGB_PROFILE.length);
    payload.set(new TextEncoder().encode('ICC_PROFILE\0')); payload[12] = 1; payload[13] = 1;
    payload.set(SRGB_PROFILE, 14);
    const app2 = new Uint8Array(payload.length + 4);
    app2.set([255, 226, (payload.length + 2) >> 8, (payload.length + 2) & 255]); app2.set(payload, 4);
    const parts = [blob.slice(0, offset), app2];
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

// EXIF payloads and the JPEG segments that carry EXIF and XMP. The same IFD
// entries feed the TIFF export (imageEncoders.js) and the standalone
// TIFF-structured payload that PNG (eXIf chunk) and JPEG (APP1) embed.
// No DOM: usable from workers, the main thread and Node.

import {
  buildTiff, asciiEntry, shortEntry, bytesEntry, TIFF_TAGS, EXIF_TAGS, TIFF_TYPES
} from './tiffWriter.js';

const encoder = new TextEncoder();

/** IFD0 entries for the descriptive fields; `xmp` (a packet string) adds tag 700. */
export function exifIfd0Entries(fields = {}, { xmp = null } = {}) {
  const entries = [];
  if (fields.imageDescription) entries.push(asciiEntry(TIFF_TAGS.ImageDescription, fields.imageDescription));
  if (fields.make) entries.push(asciiEntry(TIFF_TAGS.Make, fields.make));
  if (fields.model) entries.push(asciiEntry(TIFF_TAGS.Model, fields.model));
  if (fields.software) entries.push(asciiEntry(TIFF_TAGS.Software, fields.software));
  if (fields.dateTime) entries.push(asciiEntry(TIFF_TAGS.DateTime, fields.dateTime));
  if (xmp) entries.push(bytesEntry(TIFF_TAGS.XMP, encoder.encode(xmp), TIFF_TYPES.BYTE));
  return entries;
}

// UserComment: 8-byte character code then the text. UNICODE follows the TIFF
// byte order, little-endian here.
function userCommentBytes(text) {
  const code = new Uint8Array([0x55, 0x4E, 0x49, 0x43, 0x4F, 0x44, 0x45, 0x00]); // "UNICODE\0"
  const units = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    units[i * 2] = c & 0xFF;
    units[i * 2 + 1] = c >> 8;
  }
  const out = new Uint8Array(code.length + units.length);
  out.set(code); out.set(units, code.length);
  return out;
}

/** Exif sub-IFD entries: version, ISO, dates, lens, comment. */
export function exifSubIfdEntries(fields = {}) {
  const entries = [bytesEntry(EXIF_TAGS.ExifVersion, new Uint8Array([0x30, 0x32, 0x33, 0x32]))]; // "0232"
  if (fields.iso > 0) entries.push(shortEntry(EXIF_TAGS.ISOSpeedRatings, [Math.min(65535, Math.round(fields.iso))]));
  if (fields.dateTimeOriginal) {
    entries.push(asciiEntry(EXIF_TAGS.DateTimeOriginal, fields.dateTimeOriginal));
    entries.push(asciiEntry(EXIF_TAGS.DateTimeDigitized, fields.dateTimeOriginal));
  }
  if (fields.lensModel) entries.push(asciiEntry(EXIF_TAGS.LensModel, fields.lensModel));
  if (fields.userComment) entries.push(bytesEntry(EXIF_TAGS.UserComment, userCommentBytes(fields.userComment)));
  return entries;
}

/** The TIFF-structured EXIF payload PNG and JPEG embed (no XMP inside it). */
export function buildExifPayload(fields = {}) {
  return buildTiff({ entries: exifIfd0Entries(fields), exif: exifSubIfdEntries(fields) });
}

// ---- JPEG segments ----
const JPEG_SEGMENT_MAX = 65533;

function app1Segment(header, body) {
  const length = 2 + header.length + body.length;
  if (length > JPEG_SEGMENT_MAX) throw new Error('APP1 segment too large');
  const out = new Uint8Array(2 + length);
  out[0] = 0xFF; out[1] = 0xE1;
  out[2] = (length >> 8) & 0xFF; out[3] = length & 0xFF;
  out.set(header, 4);
  out.set(body, 4 + header.length);
  return out;
}

export function jpegApp1Exif(payload) {
  return app1Segment(new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]), payload); // "Exif\0\0"
}

export function jpegApp1Xmp(xml) {
  return app1Segment(encoder.encode('http://ns.adobe.com/xap/1.0/\0'), encoder.encode(xml));
}

/**
 * Where new APP1 segments go in a JPEG: right after SOI, or after a leading
 * JFIF APP0 so the file keeps the layout most writers produce. `head` is the
 * first few kilobytes of the file.
 */
export function jpegInsertOffset(head) {
  if (head.length < 4 || head[0] !== 0xFF || head[1] !== 0xD8) throw new Error('not a JPEG');
  let offset = 2;
  if (head[2] === 0xFF && head[3] === 0xE0 && head.length >= 6) {
    const length = (head[4] << 8) | head[5];
    offset = 4 + length;
  }
  return offset;
}

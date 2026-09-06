// Little-endian TIFF structure writer shared by the TIFF export, the EXIF
// payloads that go into PNG (eXIf) and JPEG (APP1) files, and the linear DNG
// writer. It lays out IFD0, an optional Exif sub-IFD and any number of data
// blocks (image strips) whose offsets are written back into the tags that
// point at them. No DOM: usable from workers and Node.

export const TIFF_TYPES = Object.freeze({
  BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4, RATIONAL: 5, SBYTE: 6, UNDEFINED: 7,
  SSHORT: 8, SLONG: 9, SRATIONAL: 10, FLOAT: 11, DOUBLE: 12
});
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

export const TIFF_TAGS = Object.freeze({
  NewSubfileType: 254, ImageWidth: 256, ImageLength: 257, BitsPerSample: 258, Compression: 259,
  PhotometricInterpretation: 262, ImageDescription: 270, Make: 271, Model: 272, StripOffsets: 273,
  Orientation: 274, SamplesPerPixel: 277, RowsPerStrip: 278, StripByteCounts: 279,
  PlanarConfiguration: 284, Software: 305, DateTime: 306, ExtraSamples: 338, SampleFormat: 339,
  XMP: 700, ExifIFD: 34665
});

export const EXIF_TAGS = Object.freeze({
  ExposureTime: 33434, FNumber: 33437, ISOSpeedRatings: 34855, ExifVersion: 36864,
  DateTimeOriginal: 36867, DateTimeDigitized: 36868, UserComment: 37510,
  LensMake: 42035, LensModel: 42036
});

// ---- entry constructors ----
export function asciiEntry(tag, text) {
  const bytes = new TextEncoder().encode(String(text ?? ''));
  const data = new Uint8Array(bytes.length + 1);
  data.set(bytes);
  return { tag, type: TIFF_TYPES.ASCII, count: data.length, data };
}

export function bytesEntry(tag, bytes, type = TIFF_TYPES.UNDEFINED) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return { tag, type, count: data.length, data };
}

export function shortEntry(tag, values) {
  const list = Array.isArray(values) ? values : [values];
  const data = new Uint8Array(list.length * 2);
  const view = new DataView(data.buffer);
  list.forEach((v, i) => view.setUint16(i * 2, v & 0xFFFF, true));
  return { tag, type: TIFF_TYPES.SHORT, count: list.length, data };
}

export function longEntry(tag, values) {
  const list = Array.isArray(values) ? values : [values];
  const data = new Uint8Array(list.length * 4);
  const view = new DataView(data.buffer);
  list.forEach((v, i) => view.setUint32(i * 4, v >>> 0, true));
  return { tag, type: TIFF_TYPES.LONG, count: list.length, data };
}

// pairs: [[numerator, denominator], ...] or a flat list of numbers turned into
// rationals with a 10000 denominator (enough for lens and colour data).
function rationalPairs(values, signed) {
  const list = Array.isArray(values) ? values : [values];
  return list.map((v) => {
    if (Array.isArray(v)) return [v[0], v[1]];
    const den = 10000;
    return [Math.round(v * den), den];
  }).map(([n, d]) => (signed ? [n, d] : [Math.max(0, n), Math.max(1, d)]));
}

export function rationalEntry(tag, values) {
  const pairs = rationalPairs(values, false);
  const data = new Uint8Array(pairs.length * 8);
  const view = new DataView(data.buffer);
  pairs.forEach(([n, d], i) => { view.setUint32(i * 8, n >>> 0, true); view.setUint32(i * 8 + 4, d >>> 0, true); });
  return { tag, type: TIFF_TYPES.RATIONAL, count: pairs.length, data };
}

export function srationalEntry(tag, values) {
  const pairs = rationalPairs(values, true);
  const data = new Uint8Array(pairs.length * 8);
  const view = new DataView(data.buffer);
  pairs.forEach(([n, d], i) => { view.setInt32(i * 8, n | 0, true); view.setInt32(i * 8 + 4, d | 0, true); });
  return { tag, type: TIFF_TYPES.SRATIONAL, count: pairs.length, data };
}

export function doubleEntry(tag, values) {
  const list = Array.isArray(values) ? values : [values];
  const data = new Uint8Array(list.length * 8);
  const view = new DataView(data.buffer);
  list.forEach((v, i) => view.setFloat64(i * 8, v, true));
  return { tag, type: TIFF_TYPES.DOUBLE, count: list.length, data };
}

// ---- layout ----
function pad2(n) { return n + (n & 1); }

function ifdSize(entries) {
  let size = 2 + entries.length * 12 + 4;
  for (const entry of entries) if (entry.data.length > 4) size += pad2(entry.data.length);
  return size;
}

// Writes one IFD at `offset` into `out`; out-of-line values follow the table.
function writeIfd(out, offset, entries, nextIfd = 0) {
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const sorted = [...entries].sort((a, b) => a.tag - b.tag);
  view.setUint16(offset, sorted.length, true);
  let entryOffset = offset + 2;
  let valueOffset = offset + 2 + sorted.length * 12 + 4;
  for (const entry of sorted) {
    view.setUint16(entryOffset, entry.tag, true);
    view.setUint16(entryOffset + 2, entry.type, true);
    view.setUint32(entryOffset + 4, entry.count, true);
    if (entry.data.length <= 4) {
      out.set(entry.data, entryOffset + 8);
    } else {
      view.setUint32(entryOffset + 8, valueOffset, true);
      out.set(entry.data, valueOffset);
      valueOffset += pad2(entry.data.length);
    }
    entryOffset += 12;
  }
  view.setUint32(entryOffset, nextIfd, true);
  return valueOffset;
}

/**
 * Builds a complete TIFF-structured byte array.
 *
 * @param {object} spec
 * @param {Array} spec.entries  IFD0 entries (without ExifIFD / StripOffsets)
 * @param {Array} [spec.exif]   Exif sub-IFD entries; adds the ExifIFD pointer
 * @param {Array<{tag:number, bytes:Uint8Array}>} [spec.blocks]  data blocks
 *   appended after the IFDs; each block's absolute offset is written into a
 *   LONG entry with `tag` (StripOffsets for image strips). Several blocks with
 *   the same tag become one LONG array.
 * @returns {Uint8Array}
 */
export function buildTiff(spec = {}) {
  const parts = buildTiffParts(spec);
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

/**
 * Same layout as buildTiff, returned as parts (header + IFDs, then each data
 * block with its padding) so a Blob can join them without copying a large
 * strip a second time.
 */
export function buildTiffParts({ entries = [], exif = null, blocks = [] } = {}) {
  const ifd0 = [...entries];
  const blockTags = new Map();
  for (const block of blocks) {
    if (!blockTags.has(block.tag)) blockTags.set(block.tag, []);
    blockTags.get(block.tag).push(block);
  }
  for (const [tag, list] of blockTags) ifd0.push(longEntry(tag, list.map(() => 0)));
  if (exif) ifd0.push(longEntry(TIFF_TAGS.ExifIFD, 0));
  const ifd0Offset = 8;
  const ifd0Size = ifdSize(ifd0);
  const exifOffset = exif ? ifd0Offset + ifd0Size : 0;
  const exifSize = exif ? ifdSize(exif) : 0;
  let dataOffset = ifd0Offset + ifd0Size + exifSize;
  const blockOffsets = new Map();
  for (const [tag, list] of blockTags) {
    const offsets = [];
    for (const block of list) {
      offsets.push(dataOffset);
      dataOffset += pad2(block.bytes.length);
    }
    blockOffsets.set(tag, offsets);
  }
  const headerSize = ifd0Offset + ifd0Size + exifSize;
  const out = new Uint8Array(headerSize);
  const view = new DataView(out.buffer);
  out[0] = 0x49; out[1] = 0x49;
  view.setUint16(2, 42, true);
  view.setUint32(4, ifd0Offset, true);
  // Fill pointer values now that the layout is known.
  for (const entry of ifd0) {
    if (blockOffsets.has(entry.tag)) {
      const offsets = blockOffsets.get(entry.tag);
      const dv = new DataView(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength);
      offsets.forEach((o, i) => dv.setUint32(i * 4, o, true));
    } else if (exif && entry.tag === TIFF_TAGS.ExifIFD) {
      new DataView(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength).setUint32(0, exifOffset, true);
    }
  }
  writeIfd(out, ifd0Offset, ifd0);
  if (exif) writeIfd(out, exifOffset, exif);
  const parts = [out];
  for (const [, list] of blockTags) {
    for (const block of list) {
      parts.push(block.bytes);
      if (block.bytes.length & 1) parts.push(new Uint8Array(1));
    }
  }
  return parts;
}

// ---- reader (tests, diagnostics) ----
function decodeValues(view, type, count, offset) {
  const size = TYPE_SIZE[type] || 1;
  const values = [];
  for (let i = 0; i < count; i++) {
    const o = offset + i * size;
    switch (type) {
      case 1: case 7: values.push(view.getUint8(o)); break;
      case 2: values.push(view.getUint8(o)); break;
      case 3: values.push(view.getUint16(o, true)); break;
      case 4: values.push(view.getUint32(o, true)); break;
      case 5: values.push([view.getUint32(o, true), view.getUint32(o + 4, true)]); break;
      case 6: values.push(view.getInt8(o)); break;
      case 8: values.push(view.getInt16(o, true)); break;
      case 9: values.push(view.getInt32(o, true)); break;
      case 10: values.push([view.getInt32(o, true), view.getInt32(o + 4, true)]); break;
      case 11: values.push(view.getFloat32(o, true)); break;
      case 12: values.push(view.getFloat64(o, true)); break;
      default: values.push(view.getUint8(o));
    }
  }
  if (type === 2) {
    const bytes = new Uint8Array(values);
    const end = bytes.indexOf(0);
    return new TextDecoder().decode(end >= 0 ? bytes.subarray(0, end) : bytes);
  }
  return values;
}

function readIfd(bytes, view, offset) {
  const count = view.getUint16(offset, true);
  const tags = {};
  for (let i = 0; i < count; i++) {
    const e = offset + 2 + i * 12;
    const tag = view.getUint16(e, true);
    const type = view.getUint16(e + 2, true);
    const n = view.getUint32(e + 4, true);
    const size = (TYPE_SIZE[type] || 1) * n;
    const valueOffset = size <= 4 ? e + 8 : view.getUint32(e + 8, true);
    const values = decodeValues(view, type, n, valueOffset);
    tags[tag] = { type, count: n, values, raw: type === 7 || type === 1 ? bytes.subarray(valueOffset, valueOffset + n) : null };
  }
  return { tags, next: view.getUint32(offset + 2 + count * 12, true) };
}

/** Parses a little-endian TIFF structure: IFD0 tags and the Exif sub-IFD if present. */
export function parseTiff(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== 0x49 || bytes[1] !== 0x49 || view.getUint16(2, true) !== 42) throw new Error('not a little-endian TIFF');
  const ifd0 = readIfd(bytes, view, view.getUint32(4, true));
  const exifPointer = ifd0.tags[TIFF_TAGS.ExifIFD];
  const exif = exifPointer ? readIfd(bytes, view, exifPointer.values[0]).tags : null;
  return { ifd0: ifd0.tags, exif };
}

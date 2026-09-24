// Synthetic TIFF-container RAW builders shared by the locator/render unit
// tests and the embedded-preview browser smoke (served by Vite). Test-only:
// nothing in the app imports this module.

export function exifApp1(orientation, little = true) {
  // "Exif\0\0" + TIFF header + IFD0 with one Orientation entry.
  const tiff = new Uint8Array(8 + 2 + 12 + 4);
  const dv = new DataView(tiff.buffer);
  tiff[0] = tiff[1] = little ? 0x49 : 0x4D;
  dv.setUint16(2, 42, little); dv.setUint32(4, 8, little);
  dv.setUint16(8, 1, little);
  dv.setUint16(10, 0x0112, little); dv.setUint16(12, 3, little); dv.setUint32(14, 1, little);
  dv.setUint16(18, orientation, little);
  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const length = payload.length + 2;
  return [0xFF, 0xE1, length >> 8, length & 0xFF, ...payload];
}

export function makeJpeg(width, height, { sof = 0xC0, precision = 8, orientation = 0, padding = 0, tail = 64 } = {}) {
  const parts = [0xFF, 0xD8];
  if (orientation) parts.push(...exifApp1(orientation));
  if (padding) {
    // An APP2 segment large enough to push the SOF past the first 2 KiB.
    const length = padding + 2;
    parts.push(0xFF, 0xE2, length >> 8, length & 0xFF, ...new Array(padding).fill(0x20));
  }
  parts.push(0xFF, sof, 0x00, 0x11, precision, height >> 8, height & 0xFF, width >> 8, width & 0xFF, 3,
    1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1);
  parts.push(0xFF, 0xDA, 0x00, 0x0C, 3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3F, 0);
  for (let i = 0; i < tail; i++) parts.push(i & 0x7F);
  parts.push(0xFF, 0xD9);
  return Uint8Array.from(parts);
}

export const SHORT = 3, LONG = 4;

// Build a TIFF container. `ifds` entries: { at, entries: [{ tag, type, values, at? }], next }.
// Out-of-line values need an explicit `at`. Payloads are { at, bytes }.
export function buildTiff({ little = true, magic = 42, ifd0, size, ifds, payloads = [] }) {
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out[0] = out[1] = little ? 0x49 : 0x4D;
  dv.setUint16(2, magic, little);
  dv.setUint32(4, ifd0, little);
  for (const { at, bytes } of payloads) out.set(bytes, at);
  for (const ifd of ifds) {
    const entries = [...ifd.entries].sort((a, b) => a.tag - b.tag);
    dv.setUint16(ifd.at, entries.length, little);
    entries.forEach((entry, i) => {
      const e = ifd.at + 2 + i * 12;
      const values = Array.isArray(entry.values) ? entry.values : [entry.values];
      const width = entry.type === SHORT ? 2 : 4;
      dv.setUint16(e, entry.tag, little); dv.setUint16(e + 2, entry.type, little);
      dv.setUint32(e + 4, values.length, little);
      const inline = values.length * width <= 4;
      const base = inline ? e + 8 : entry.at;
      if (!inline) {
        if (!Number.isInteger(entry.at)) throw new Error(`tag ${entry.tag} needs an out-of-line offset`);
        dv.setUint32(e + 8, entry.at, little);
      }
      values.forEach((value, j) => {
        if (width === 2) dv.setUint16(base + j * 2, value, little);
        else dv.setUint32(base + j * 4, value, little);
      });
    });
    dv.setUint32(ifd.at + 2 + entries.length * 12, ifd.next || 0, little);
  }
  return out;
}

export const previewIfd = (at, width, height, offset, length, extra = []) => ({ at, entries: [
  { tag: 254, type: LONG, values: 1 }, { tag: 256, type: SHORT, values: width },
  { tag: 257, type: SHORT, values: height }, { tag: 259, type: SHORT, values: 7 },
  { tag: 262, type: SHORT, values: 6 }, { tag: 273, type: LONG, values: offset },
  { tag: 279, type: LONG, values: length }, ...extra] });

/**
 * An M11-style DNG: IFD0 is the Compression-7 CFA raw (Photometric 32803),
 * SubIFDs hold baseline JPEG previews. `previews` maps each preview to
 * { width, height, bytes? } (header-only JPEGs when no bytes are given).
 */
export function buildDngWithPreviews({ previews, raw = { width: 9536, height: 6336 }, orientation = 1,
  little = true, extraIfd0 = [] } = {}) {
  const payloads = [];
  const ifds = [];
  let cursor = 16384;
  const subOffsets = previews.map((_, i) => 600 + i * 150);
  const entries = previews.map((preview, i) => {
    const bytes = preview.bytes || makeJpeg(preview.width, preview.height);
    const at = cursor;
    cursor += bytes.length + 64;
    payloads.push({ at, bytes });
    ifds.push(previewIfd(subOffsets[i], preview.width, preview.height, at, bytes.length));
    return { at, length: bytes.length };
  });
  const rawStrip = makeJpeg(raw.width, raw.height, { sof: 0xC3, precision: 14 });
  const rawAt = cursor;
  cursor += rawStrip.length + 1024;
  payloads.push({ at: rawAt, bytes: rawStrip });
  ifds.unshift({ at: 12, entries: [
    { tag: 254, type: LONG, values: 0 }, { tag: 256, type: LONG, values: raw.width }, { tag: 257, type: LONG, values: raw.height },
    { tag: 259, type: SHORT, values: 7 }, { tag: 262, type: SHORT, values: 32803 }, { tag: 274, type: SHORT, values: orientation },
    { tag: 273, type: LONG, values: rawAt }, { tag: 279, type: LONG, values: rawStrip.length },
    { tag: 330, type: LONG, values: subOffsets, at: 400 }, ...extraIfd0] });
  return { bytes: buildTiff({ little, ifd0: 12, size: cursor, ifds, payloads }), previews: entries, rawAt };
}

/**
 * A small ".dng" whose IFD0 is a plain 8-bit RGB image that UTIF renders
 * (the app's iPhone DNG route: "iPhone" appears in the first 1000 bytes), with
 * baseline JPEG previews in SubIFDs. The browser smoke uses it to drive the
 * provisional frame and tile paths end to end on a file every build decodes.
 */
export function buildRgbDngWithPreviews({ width, height, rgb, previews, orientation = 1, little = true }) {
  if (rgb.length !== width * height * 3) throw new Error('rgb must hold width*height*3 bytes');
  const payloads = [{ at: 300, bytes: new TextEncoder().encode('Apple iPhone synthetic\0') }];
  const ifds = [];
  let cursor = 16384;
  const subOffsets = previews.map((_, i) => 700 + i * 150);
  const entries = previews.map((preview, i) => {
    const bytes = preview.bytes || makeJpeg(preview.width, preview.height);
    const at = cursor;
    cursor += bytes.length + 64;
    payloads.push({ at, bytes });
    ifds.push(previewIfd(subOffsets[i], preview.width, preview.height, at, bytes.length));
    return { at, length: bytes.length, width: preview.width, height: preview.height };
  });
  const imageAt = cursor;
  cursor += rgb.length;
  payloads.push({ at: imageAt, bytes: rgb });
  ifds.unshift({ at: 12, entries: [
    { tag: 254, type: LONG, values: 0 }, { tag: 256, type: LONG, values: width }, { tag: 257, type: LONG, values: height },
    { tag: 258, type: SHORT, values: [8, 8, 8], at: 360 }, { tag: 259, type: SHORT, values: 1 },
    { tag: 262, type: SHORT, values: 2 }, { tag: 273, type: LONG, values: imageAt }, { tag: 274, type: SHORT, values: orientation },
    { tag: 277, type: SHORT, values: 3 }, { tag: 278, type: LONG, values: height },
    { tag: 279, type: LONG, values: rgb.length }, { tag: 284, type: SHORT, values: 1 },
    { tag: 330, type: LONG, values: subOffsets, at: 400 }] });
  return { bytes: buildTiff({ little, ifd0: 12, size: cursor, ifds, payloads }), previews: entries };
}

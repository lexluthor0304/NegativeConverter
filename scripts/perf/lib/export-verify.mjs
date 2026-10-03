// S9 export parity: SHA-256 of *decoded* pixels (whole-file hashes are not
// comparable: ZIP entries carry the current time), plus the bit depth of
// TIFFs and the gain-map bytes of JPEGs. PNG and TIFF decode in Node with the
// repo's own dependencies; JPEG pixels are decoded in the page after the
// measurement window (the probe's exports.jpegSha256).

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { parseTiff } from '../../../negative2positive/src/workers/tiffWriter.js';

const require = createRequire(import.meta.url);
const UPNG = require('upng-js');
const UTIF = require('utif');

const sha = (...parts) => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest('hex');
};

export function sniffFormat(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'png';
  if ((bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4D && bytes[1] === 0x4D)) return 'tiff';
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) return 'jpeg';
  if (bytes[0] === 0x50 && bytes[1] === 0x4B) return 'zip';
  return 'unknown';
}

export function pngPixels(bytes) {
  const png = UPNG.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const header = Buffer.from(`png:${png.width}x${png.height}:depth${png.depth}:ctype${png.ctype}:`);
  return { width: png.width, height: png.height, bitDepth: png.depth, sha256: sha(header, new Uint8Array(png.data)) };
}

/** Uncompressed strips hash as they are; anything else goes through UTIF. */
export function tiffPixels(bytes) {
  const { ifd0 } = parseTiff(bytes);
  const width = ifd0[256].values[0], height = ifd0[257].values[0];
  const bits = ifd0[258].values;
  const compression = ifd0[259]?.values[0] ?? 1;
  const header = Buffer.from(`tiff:${width}x${height}:bits${bits.join(',')}:`);
  if (compression === 1 && ifd0[273] && ifd0[279]) {
    const hash = createHash('sha256');
    hash.update(header);
    ifd0[273].values.forEach((offset, i) => hash.update(bytes.subarray(offset, offset + ifd0[279].values[i])));
    return { width, height, bitDepth: bits[0], sha256: hash.digest('hex') };
  }
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const ifds = UTIF.decode(buffer);
  UTIF.decodeImage(buffer, ifds[0]);
  return { width, height, bitDepth: bits[0], sha256: sha(header, new Uint8Array(ifds[0].data)) };
}

/** Secondary image of a JPEG with an MPF (APP2) index: the HDR gain map. */
export function jpegGainMap(bytes) {
  let p = 2;
  while (p + 4 < bytes.length && bytes[p] === 0xFF) {
    const marker = bytes[p + 1];
    const length = (bytes[p + 2] << 8) | bytes[p + 3];
    if (marker === 0xDA) break;
    if (marker === 0xE2 && bytes[p + 4] === 0x4D && bytes[p + 5] === 0x50 && bytes[p + 6] === 0x46 && bytes[p + 7] === 0x00) {
      const tiffStart = p + 8;
      const view = new DataView(bytes.buffer, bytes.byteOffset + tiffStart);
      const little = bytes[tiffStart] === 0x49;
      const ifd = view.getUint32(4, little);
      const count = view.getUint16(ifd, little);
      for (let i = 0; i < count; i++) {
        const entry = ifd + 2 + i * 12;
        if (view.getUint16(entry, little) !== 0xB002) continue;
        const n = view.getUint32(entry + 4, little);
        const valueOffset = view.getUint32(entry + 8, little);
        const images = [];
        for (let j = 0; j < n / 16; j++) {
          const e = valueOffset + j * 16;
          images.push({ size: view.getUint32(e + 4, little), offset: view.getUint32(e + 8, little) });
        }
        const secondary = images[1];
        if (!secondary) return null;
        const start = tiffStart + secondary.offset;
        const gain = bytes.subarray(start, start + secondary.size);
        return { bytes: gain.length, sha256: sha(gain), primaryBytes: images[0].size };
      }
    }
    p += 2 + length;
  }
  return null;
}

/** Central-directory walk of a stored (uncompressed) ZIP, ZIP64 aware. */
export function zipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054B50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a ZIP (no end of central directory)');
  let count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (offset === 0xFFFFFFFF || count === 0xFFFF) {
    const locator = eocd - 20;
    if (view.getUint32(locator, true) === 0x07064B50) {
      const zip64 = Number(view.getBigUint64(locator + 8, true));
      count = Number(view.getBigUint64(zip64 + 32, true));
      offset = Number(view.getBigUint64(zip64 + 48, true));
    }
  }
  const entries = [];
  let p = offset;
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014B50) throw new Error('corrupt central directory');
    const method = view.getUint16(p + 10, true);
    let size = view.getUint32(p + 20, true);
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    let local = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLength));
    let e = p + 46 + nameLength;
    const extraEnd = e + extraLength;
    while (e + 4 <= extraEnd) {
      const id = view.getUint16(e, true), len = view.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (view.getUint32(p + 24, true) === 0xFFFFFFFF) q += 8;
        if (size === 0xFFFFFFFF) { size = Number(view.getBigUint64(q, true)); q += 8; }
        if (local === 0xFFFFFFFF) local = Number(view.getBigUint64(q, true));
      }
      e += 4 + len;
    }
    const localName = view.getUint16(local + 26, true);
    const localExtra = view.getUint16(local + 28, true);
    const start = local + 30 + localName + localExtra;
    entries.push({ name, method, size, data: bytes.subarray(start, start + size) });
    p = extraEnd + commentLength;
  }
  return entries;
}

/** Decoded-pixel summary of one exported file or every entry of a ZIP. */
export function verifyExport(bytes, name = '') {
  const format = sniffFormat(bytes);
  if (format === 'png') return { name, format, ...pngPixels(bytes) };
  if (format === 'tiff') return { name, format, ...tiffPixels(bytes) };
  if (format === 'jpeg') return { name, format, gainMap: jpegGainMap(bytes) };
  if (format === 'zip') return { name, format, entries: zipEntries(bytes).map(entry => verifyExport(entry.data, entry.name)) };
  return { name, format };
}

/** JPEG primary samples use the same page decoder for singles and ZIP entries. */
export async function verifyDecodedExport(bytes, name, decodeJpeg) {
  const format = sniffFormat(bytes);
  if (format === 'zip') {
    const entries = [];
    for (const entry of zipEntries(bytes)) {
      if (entry.method !== 0) throw new Error(`unsupported compressed ZIP entry: ${entry.name}`);
      entries.push(await verifyDecodedExport(entry.data, entry.name, decodeJpeg));
    }
    return { name, format, entries };
  }
  const info = verifyExport(bytes, name);
  if (format === 'jpeg') {
    const decoded = await decodeJpeg(bytes, name);
    if (!decoded?.sha256) throw new Error(`JPEG pixel decode failed: ${name}`);
    Object.assign(info, decoded);
  }
  return info;
}

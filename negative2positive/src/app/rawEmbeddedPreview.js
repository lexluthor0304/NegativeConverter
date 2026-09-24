// Random-access locator for the camera JPEG previews inside TIFF-container
// RAWs (DNG, NEF, CR2, ARW, RW2 ...).
//
// Unlike the whole-buffer SOI scan in nefJpegPreview.js, this reads only small
// Blob slices: a 16 KiB head, any IFD that lies outside it (IFD0 at the file
// tail, NEF SubIFDs past 256 KiB), and a 2 KiB head of each candidate JPEG for
// its SOF check. The container itself is never read in full, so a preview can
// be shown while the exact decode has not even issued its read.
//
// Everything found here is presentation-only: previews are camera renderings
// of the negative, never a conversion, analysis or export source.
import { parseJpegFrameHeader, SOF_PARSER_SCAN_LIMIT } from './nefJpegPreview.js';

export const TIFF_HEAD_BYTES = 16 * 1024;
export const JPEG_HEAD_BYTES = 2 * 1024;
// Out-of-head IFDs are read in one chunk that fits typical directories.
const IFD_CHUNK_BYTES = 4 * 1024;
const MAX_IFDS = 64;
const MAX_IFD_ENTRIES = 4096;
const MAX_SUB_IFDS = 64;
const MAX_CANDIDATES = 24;
// Display previews stay small enough to decode in ~10-20 ms. The 60 MP and
// 24 MP previews take 145-239 ms even off-thread and are never displayed.
export const MAX_DISPLAY_PREVIEW_PIXELS = 4_000_000;

const PHOTOMETRIC_CFA = 32803;
const PHOTOMETRIC_LINEAR_RAW = 34892;
const JPEG_COMPRESSIONS = new Set([6, 7]);
const PREVIEW_PHOTOMETRIC = new Set([2, 6]);

// TIFF-family RAW containers this locator understands. CR3/RAF/X3F and other
// non-TIFF containers keep their numbered tile.
const TIFF_RAW_EXTENSIONS = new Set(['dng', 'nef', 'nrw', 'cr2', 'arw', 'srf', 'sr2', 'rw2', 'rwl',
  'pef', 'srw', '3fr', 'mef', 'iiq', 'kdc', 'dcr', 'erf', 'mos', 'raw']);

export function isTiffContainerRawName(name) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  return TIFF_RAW_EXTENSIONS.has(ext);
}

function createReader(blob) {
  const size = Number(blob?.size) || 0;
  const chunks = [];
  let bytesRead = 0;
  async function load(offset, length) {
    const end = Math.min(size, offset + length);
    if (offset < 0 || end <= offset) return null;
    const bytes = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
    bytesRead += bytes.byteLength;
    const chunk = { start: offset, bytes };
    chunks.push(chunk);
    return chunk;
  }
  // Returns a DataView-like accessor over [offset, offset+length) or null.
  async function view(offset, length, { chunk = 0 } = {}) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) return null;
    if (offset + length > size) return null;
    let found = chunks.find(c => offset >= c.start && offset + length <= c.start + c.bytes.byteLength);
    if (!found) found = await load(offset, Math.max(length, chunk));
    if (!found || offset + length > found.start + found.bytes.byteLength) return null;
    return { bytes: found.bytes, at: offset - found.start };
  }
  return { size, load, view, get bytesRead() { return bytesRead; } };
}

function typeSize(type) {
  if (type === 1 || type === 2 || type === 6 || type === 7) return 1;
  if (type === 3 || type === 8) return 2;
  if (type === 4 || type === 9 || type === 13) return 4;
  return 0;
}

async function readIfd(reader, offset, little) {
  const countView = await reader.view(offset, 2, { chunk: IFD_CHUNK_BYTES });
  if (!countView) return null;
  const { bytes: cb, at: ca } = countView;
  const count = little ? cb[ca] | (cb[ca + 1] << 8) : (cb[ca] << 8) | cb[ca + 1];
  if (!count || count > MAX_IFD_ENTRIES) return null;
  const table = await reader.view(offset, 2 + count * 12 + 4, { chunk: IFD_CHUNK_BYTES });
  if (!table) return null;
  const { bytes, at } = table;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    const e = at + 2 + i * 12;
    const tag = dv.getUint16(e, little);
    const type = dv.getUint16(e + 2, little);
    const n = dv.getUint32(e + 4, little);
    const size = typeSize(type);
    if (!size || !n) continue;
    entries.set(tag, { type, n, size, inline: n * size <= 4, valueAt: e + 8, raw: dv.getUint32(e + 8, little) });
  }
  const next = dv.getUint32(at + 2 + count * 12, little);
  return { entries, next, dv, little };
}

// First value of an entry (inline values only need the table bytes).
function firstValue(ifd, tag) {
  const entry = ifd.entries.get(tag);
  if (!entry || !entry.inline) return undefined;
  const { dv, little } = ifd;
  if (entry.size === 1) return dv.getUint8(entry.valueAt);
  if (entry.size === 2) return dv.getUint16(entry.valueAt, little);
  return dv.getUint32(entry.valueAt, little);
}

async function valuesOf(reader, ifd, tag, limit) {
  const entry = ifd.entries.get(tag);
  if (!entry || entry.size < 2) return [];
  const n = Math.min(entry.n, limit);
  let dv, base;
  if (entry.inline) {
    dv = ifd.dv; base = entry.valueAt;
  } else {
    const view = await reader.view(entry.raw, n * entry.size);
    if (!view) return [];
    dv = new DataView(view.bytes.buffer, view.bytes.byteOffset, view.bytes.byteLength); base = view.at;
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(entry.size === 2 ? dv.getUint16(base + i * 2, ifd.little) : dv.getUint32(base + i * 4, ifd.little));
  }
  return out;
}

async function checkJpeg(reader, candidate) {
  let length = Math.min(candidate.length, JPEG_HEAD_BYTES);
  let view = await reader.view(candidate.offset, length);
  if (!view) return null;
  let header = parseJpegFrameHeader(view.bytes.subarray(view.at, view.at + length));
  if (header?.truncated && candidate.length > length) {
    // APP segments (Exif, maker data) can push the SOF past the first 2 KiB.
    length = Math.min(candidate.length, SOF_PARSER_SCAN_LIMIT);
    view = await reader.view(candidate.offset, length);
    if (!view) return null;
    header = parseJpegFrameHeader(view.bytes.subarray(view.at, view.at + length));
  }
  if (!header || header.truncated) return null;
  return {
    offset: candidate.offset, length: candidate.length,
    width: header.width, height: header.height,
    exifOrientation: header.orientation || 0,
  };
}

/**
 * Locate the embedded JPEG previews of a TIFF-container RAW.
 *
 * Pure and async; uses only `blob.slice(a, b).arrayBuffer()`. Malformed or
 * non-TIFF input returns null and never throws, as does a container with no
 * usable (browser-decodable baseline JPEG) preview.
 *
 * @param {Blob} blob
 * @returns {Promise<null | {
 *   previews: Array<{ offset: number, length: number, width: number, height: number, exifOrientation: number }>,
 *   orientation: number, rawSize: { width: number, height: number } | null, bytesRead: number
 * }>}
 */
export async function locateEmbeddedPreviews(blob, { headBytes = TIFF_HEAD_BYTES } = {}) {
  try {
    return await locate(blob, headBytes);
  } catch {
    return null;
  }
}

async function locate(blob, headBytes) {
  if (!blob || typeof blob.slice !== 'function') return null;
  const reader = createReader(blob);
  if (reader.size < 16) return null;
  const head = await reader.load(0, headBytes);
  if (!head || head.bytes.byteLength < 8) return null;
  const b = head.bytes;
  const little = b[0] === 0x49 && b[1] === 0x49;
  if (!little && !(b[0] === 0x4D && b[1] === 0x4D)) return null;
  const hv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const magic = hv.getUint16(2, little);
  // 0x2A: TIFF/DNG/NEF/CR2/ARW. 0x55: Panasonic RW2. ('RO' ORF is not handled.)
  if (magic !== 0x2A && magic !== 0x55) return null;
  const ifd0 = hv.getUint32(4, little);

  const queue = [ifd0];
  const visited = new Set();
  const candidates = new Map();
  let orientation = 0;
  let rawSize = null;
  let first = true;
  while (queue.length && visited.size < MAX_IFDS) {
    const offset = queue.shift();
    if (!offset || offset < 8 || offset + 2 > reader.size || visited.has(offset)) {
      if (first) return null;
      continue;
    }
    visited.add(offset);
    const ifd = await readIfd(reader, offset, little);
    if (!ifd) {
      if (first) return null;
      continue;
    }
    if (first) {
      const value = firstValue(ifd, 274);
      orientation = value >= 1 && value <= 8 ? value : 1;
      first = false;
    }
    const width = firstValue(ifd, 256);
    const height = firstValue(ifd, 257);
    const compression = firstValue(ifd, 259);
    const photometric = firstValue(ifd, 262);
    const isRaw = photometric === PHOTOMETRIC_CFA || photometric === PHOTOMETRIC_LINEAR_RAW;
    // The main image (NewSubFileType bit 0 clear) sets the geometry scale;
    // Adobe's JPEG XL previews are LinearRaw too, but reduced-resolution.
    const reduced = (firstValue(ifd, 254) ?? 0) & 1;
    if (isRaw && !reduced && width > 0 && height > 0 && (!rawSize || width * height > rawSize.width * rawSize.height)) {
      rawSize = { width, height };
    }
    const tiled = ifd.entries.has(322) || ifd.entries.has(324);
    const strips = ifd.entries.get(273);
    const counts = ifd.entries.get(279);
    // The Photometric rule keeps the CFA raw itself out before any read: on
    // the M11 IFD0 is a 72 MB Compression-7 lossless-JPEG strip. NewSubFileType
    // is deliberately not required (CR2-style IFD0 previews omit it).
    if (!isRaw && !tiled && JPEG_COMPRESSIONS.has(compression)
      && (photometric === undefined || PREVIEW_PHOTOMETRIC.has(photometric))
      && strips?.n === 1 && counts?.n === 1 && strips.inline && counts.inline) {
      const start = firstValue(ifd, 273), length = firstValue(ifd, 279);
      if (start >= 8 && length > 4 && start + length <= reader.size) candidates.set(start, { offset: start, length });
    }
    if (!isRaw && ifd.entries.has(513) && ifd.entries.has(514)) {
      const start = firstValue(ifd, 513), length = firstValue(ifd, 514);
      if (start >= 8 && length > 4 && start + length <= reader.size) candidates.set(start, { offset: start, length });
    }
    for (const sub of await valuesOf(reader, ifd, 330, MAX_SUB_IFDS)) queue.push(sub);
    if (ifd.next) queue.push(ifd.next);
  }

  const previews = [];
  for (const candidate of Array.from(candidates.values()).slice(0, MAX_CANDIDATES)) {
    const preview = await checkJpeg(reader, candidate);
    if (preview) previews.push(preview);
  }
  if (!previews.length) return null;
  previews.sort((a, b) => a.width * a.height - b.width * b.height || a.offset - b.offset);
  return { previews, orientation: orientation || 1, rawSize, bytesRead: reader.bytesRead };
}

const longSide = preview => Math.max(preview.width, preview.height);
const pixels = preview => preview.width * preview.height;

/**
 * Viewer preview: among previews of at most 4 MP, the smallest whose long side
 * reaches 0.8 x the viewer's device-pixel long side, otherwise the largest of
 * at most 4 MP. The M11 gets 2112x1408, a NEF 1620x1080.
 */
export function pickForViewer(previews, longSidePx) {
  const usable = (previews || []).filter(p => pixels(p) <= MAX_DISPLAY_PREVIEW_PIXELS)
    .sort((a, b) => pixels(a) - pixels(b));
  if (!usable.length) return null;
  const need = 0.8 * (Number(longSidePx) || 0);
  return usable.find(p => longSide(p) >= need) || usable[usable.length - 1];
}

/**
 * Tile preview: the smallest preview whose long side reaches `minLongSide`
 * (720x480 on the M11), never one above 4 MP. Smaller-only files use their
 * largest preview.
 */
export function pickForTile(previews, minLongSide = 288) {
  const usable = (previews || []).filter(p => pixels(p) <= MAX_DISPLAY_PREVIEW_PIXELS)
    .sort((a, b) => pixels(a) - pixels(b));
  if (!usable.length) return null;
  return usable.find(p => longSide(p) >= minLongSide) || usable[usable.length - 1];
}

import { isRawLikeFileName } from './imageFileLoaders.js';

const HEADER_BYTES = 256 * 1024;
const dimensions = new WeakMap();
export const UNKNOWN_IMAGE_PIXELS = 150_000_000;
// The compressed size above which a RAW whose header gives no pixel count
// takes the two-stage decode (half-size stand-in first, #255). The only copy:
// rawFileLoader.js imports it for its heavy-IIQ shortcut.
export const RAW_SIZE_HEAVY = 100 * 1024 * 1024;
// PhotometricInterpretation of a colour-filter-array (mosaic) raw IFD.
// LinearRaw (34892) is demosaiced already: LibRaw cannot shrink it.
export const PHOTOMETRIC_CFA = 32803;
export const PHOTOMETRIC_LINEAR_RAW = 34892;
const MAX_IFDS = 64;
// Header-only reads past the first 256 KiB: aligned 64 KiB blocks (more when
// one IFD needs it), so neighbouring IFDs and their out-of-line values share
// a read; at most this many.
const IFD_READ_BYTES = 64 * 1024;
const MAX_IFD_READS = 2 * MAX_IFDS;

function valid(width, height) {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
    && Number.isSafeInteger(width * height) ? { width, height } : null;
}

// The TIFF IFD walk behind both header readers. It yields [offset, length]
// and is sent a DataView of exactly those bytes, or null when they lie past
// the end: a buffer answers at once, a File with small slice() reads.
// Every IFD is visited once (at most 64); SubIFDs (330) are followed. The
// largest image found wins; with `raw` only CFA and LinearRaw IFDs count.
function* tiffDimensionsWalk(raw) {
  const head = yield [0, 8];
  if (!head) return null;
  const little = head.getUint8(0) === 0x49 && head.getUint8(1) === 0x49;
  if (!little && !(head.getUint8(0) === 0x4d && head.getUint8(1) === 0x4d)) return null;
  if (head.getUint16(2, little) !== 42) return null;
  const offsets = [head.getUint32(4, little)], visited = new Set();
  let best = null;
  while (offsets.length && visited.size < MAX_IFDS) {
    const offset = offsets.pop();
    if (!offset || visited.has(offset)) continue;
    const countView = yield [offset, 2];
    if (!countView) continue;
    visited.add(offset);
    const count = countView.getUint16(0, little);
    if (count > 4096) continue;
    const entries = yield [offset + 2, count * 12 + 4];
    if (!entries) continue;
    let width, height, photo;
    for (let i = 0; i < count; i++) {
      const entry = i * 12;
      const tag = entries.getUint16(entry, little), type = entries.getUint16(entry + 2, little);
      const n = entries.getUint32(entry + 4, little);
      const size = type === 3 ? 2 : type === 4 || type === 13 ? 4 : 0;
      if (!size || !n || n > 64) continue;
      if (tag !== 256 && tag !== 257 && tag !== 262 && tag !== 330) continue;
      let values = entries, at = entry + 8;
      if (n * size > 4) {
        values = yield [entries.getUint32(entry + 8, little), n * size];
        if (!values) continue;
        at = 0;
      }
      const read = j => size === 2 ? values.getUint16(at + j * size, little) : values.getUint32(at + j * size, little);
      if (tag === 256) width = read(0);
      if (tag === 257) height = read(0);
      if (tag === 262) photo = read(0);
      if (tag === 330) for (let j = 0; j < n; j++) offsets.push(read(j));
    }
    const found = valid(width, height);
    if (found && (!raw || photo === PHOTOMETRIC_CFA || photo === PHOTOMETRIC_LINEAR_RAW)
      && (!best || found.width * found.height > best.width * best.height)) {
      best = photo === undefined ? found : { ...found, photometric: photo };
    }
    offsets.push(entries.getUint32(count * 12, little));
  }
  return best;
}

function walkBuffer(walk, buffer) {
  const length = buffer.byteLength;
  let step = walk.next();
  while (!step.done) {
    const [offset, size] = step.value;
    step = walk.next(offset >= 0 && offset + size <= length ? new DataView(buffer, offset, size) : null);
  }
  return step.value;
}

// The same walk over a File/Blob: `head` (its first bytes) answers what it
// can, everything else is a bounded slice() read.
async function walkFile(walk, file, head) {
  const chunks = [{ start: 0, bytes: head }];
  let reads = 0;
  const view = async (offset, size) => {
    if (!(offset >= 0) || offset + size > file.size) return null;
    for (const chunk of chunks) {
      if (offset >= chunk.start && offset + size <= chunk.start + chunk.bytes.byteLength) {
        return new DataView(chunk.bytes, offset - chunk.start, size);
      }
    }
    if (reads >= MAX_IFD_READS) return null;
    reads++;
    const start = Math.floor(offset / IFD_READ_BYTES) * IFD_READ_BYTES;
    const bytes = await file.slice(start, Math.min(file.size, Math.max(start + IFD_READ_BYTES, offset + size))).arrayBuffer();
    if (bytes.byteLength < offset - start + size) return null;
    chunks.push({ start, bytes });
    return new DataView(bytes, offset - start, size);
  };
  let step = walk.next();
  while (!step.done) step = walk.next(await view(...step.value));
  return step.value;
}

// Read headers only: no canvas allocation, decompression or RAW demosaic.
// A TIFF answer carries the matched IFD's PhotometricInterpretation
// (`photometric`) when the IFD has one.
export function parseImageDimensions(buffer, { raw = false } = {}) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a) {
    return valid(view.getUint32(16), view.getUint32(20));
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 4 <= bytes.length) {
      if (bytes[at++] !== 0xff) return null;
      while (bytes[at] === 0xff) at++;
      const marker = bytes[at++];
      if (marker === 0xd9 || marker === 0xda) return null;
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (at + 2 > bytes.length) return null;
      const length = view.getUint16(at);
      if (length < 2 || at + length > bytes.length) return null;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return length >= 7 ? valid(view.getUint16(at + 5), view.getUint16(at + 3)) : null;
      }
      at += length;
    }
    return null;
  }
  return walkBuffer(tiffDimensionsWalk(raw), buffer);
}

function isTiffHeader(buffer) {
  if (buffer.byteLength < 4) return false;
  const bytes = new Uint8Array(buffer, 0, 4);
  return (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 42 && bytes[3] === 0)
    || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && bytes[3] === 42);
}

/**
 * parseImageDimensions for a File from its header: the first 256 KiB, and
 * for a TIFF container whose IFDs lie beyond them (an M11 DNG written by
 * some tools keeps IFD0 at the end of the file) bounded slice() reads at
 * the IFD offsets. Nothing is copied or decoded. `head` may pass the first
 * bytes already read.
 */
export async function readImageHeaderDimensions(file, { raw = false, head = null } = {}) {
  const bytes = head || await file.slice(0, HEADER_BYTES).arrayBuffer();
  const found = parseImageDimensions(bytes, { raw });
  if (found || !isTiffHeader(bytes) || !(file.size > bytes.byteLength)) return found;
  return walkFile(tiffDimensionsWalk(raw), file, bytes);
}

// The same test as rawFileLoader's UTIF route for iPhone ProRAW DNGs.
export function isIPhoneDngHeader(buffer) {
  const length = Math.min(1000, buffer?.byteLength || 0);
  return length > 0 && new TextDecoder().decode(new Uint8Array(buffer, 0, length)).includes('iPhone');
}

/**
 * How a RAW import decodes (#255): `{ stages: 2 }` shows a half-size 16-bit
 * stand-in first and decodes the exact full resolution behind it; every
 * other file decodes once. Two stages for a CFA mosaic whose header reports
 * at least `minPixels`, whatever its compressed size. LinearRaw (LibRaw
 * cannot shrink it), TIFFs and iPhone DNGs (UTIF) never. A header that
 * cannot be read keeps the compressed-size rule (> RAW_SIZE_HEAVY), and so
 * does every file while `minPixels` is off (null or 0): the plan behind
 * the `twoStageMinMp` flag.
 *
 * `buffer` is the whole file when the caller has read it already, so an
 * IFD0 stored at the end is found without another read; otherwise the
 * header is read (see readImageHeaderDimensions). The answer includes the
 * header's width, height and photometric when it had them.
 */
export async function rawDecodePlan(file, { buffer = null, minPixels = 40e6 } = {}) {
  const name = String(file?.name || '').toLowerCase();
  if (!isRawLikeFileName(name) || /\.tiff?$/.test(name)) return { stages: 1 };
  const head = buffer || await file.slice(0, HEADER_BYTES).arrayBuffer();
  if (name.endsWith('.dng') && isIPhoneDngHeader(head)) return { stages: 1 };
  const bytes = buffer ? buffer.byteLength : file.size;
  const sizeRule = { stages: bytes > RAW_SIZE_HEAVY ? 2 : 1 };
  if (!(minPixels > 0)) return sizeRule;
  let dims = null;
  try {
    dims = buffer ? parseImageDimensions(buffer, { raw: true }) : await readImageHeaderDimensions(file, { raw: true, head });
  } catch { dims = null; }
  if (!dims) return sizeRule;
  const cfa = dims.photometric === PHOTOMETRIC_CFA;
  return { stages: cfa && dims.width * dims.height >= minPixels ? 2 : 1, ...dims };
}

// Files whose size comes from a decode (not from their header).
const decodedFiles = new WeakSet();

export function rememberImageDimensions(file, image) {
  const size = valid(image?.width, image?.height);
  if (file && size) {
    dimensions.set(file, size);
    decodedFiles.add(file);
  }
}

// The size a full decode of `file` produced this session, or null.
export function knownImageDimensions(file) {
  const size = file && decodedFiles.has(file) ? dimensions.get(file) : null;
  return size ? { width: size.width, height: size.height } : null;
}

// Files whose header yields no size; they are not read again.
const headerless = new WeakSet();

async function headerDimensions(file) {
  let size = dimensions.get(file);
  if (!size && !headerless.has(file)) {
    try {
      const raw = isRawLikeFileName(file.name) && !/\.tiff?$/i.test(file.name || '');
      size = parseImageDimensions(await file.slice(0, HEADER_BYTES).arrayBuffer(), { raw });
      if (size) dimensions.set(file, size);
      else headerless.add(file);
    } catch { /* Unsupported/truncated headers use a conservative memory budget. */ }
  }
  return size || null;
}

export async function imagePixelsForBatch(file) {
  const size = await headerDimensions(file);
  return size ? size.width * size.height : UNKNOWN_IMAGE_PIXELS;
}

function extensionOf(name) {
  const match = /\.([^./\\]+)$/.exec(String(name || '').toLowerCase());
  return match ? match[1] : '';
}

/**
 * Pixels to plan or reserve memory for (#258): the header's size; when the
 * header has none, the size a full decode of another file with the same
 * extension produced this session (one camera, one roll: #252's rule); else
 * the conservative UNKNOWN_IMAGE_PIXELS.
 */
export async function imagePixelsWithSiblings(file, siblings = []) {
  const pixels = await imagePixelsForBatch(file);
  if (dimensions.has(file)) return pixels;
  const extension = extensionOf(file?.name);
  if (!extension) return pixels;
  for (const other of siblings) {
    if (!other || other === file || extensionOf(other.name) !== extension) continue;
    const size = dimensions.get(other);
    if (size) return size.width * size.height;
  }
  return pixels;
}

/**
 * The largest frame of `files`, for roll-analysis planning (#252). A RAW
 * whose header yields no size (no CFA or LinearRaw IFD) would count as
 * UNKNOWN_IMAGE_PIXELS and hold the whole roll at one lane; once another
 * file of the same import (`siblings`, which may include the photo the
 * foreground decoded) and extension has been decoded, it takes that file's
 * decoded size instead (the largest such size). The lane's decode
 * slot still reserves each frame's real size before its demosaic, so a
 * larger frame waits there instead of overcommitting.
 */
export async function importPixelsForRoll(files, { siblings = files } = {}) {
  const decodedByExtension = new Map();
  for (const file of siblings) {
    const known = dimensions.get(file);
    if (!known || !decodedFiles.has(file)) continue;
    const ext = extensionOf(file?.name);
    const pixels = known.width * known.height;
    if (ext && pixels > (decodedByExtension.get(ext) || 0)) decodedByExtension.set(ext, pixels);
  }
  let largest = 0;
  for (const file of files) {
    const size = await headerDimensions(file);
    const pixels = size ? size.width * size.height
      : decodedByExtension.get(extensionOf(file?.name)) || UNKNOWN_IMAGE_PIXELS;
    largest = Math.max(largest, pixels);
  }
  return largest;
}

/**
 * The full size behind a half-size LibRaw decode of `width` x `height`.
 * LibRaw halves only mosaic (CFA) data, each side rounding up; LinearRaw,
 * monochrome-sensor and sRAW data come back at full size. `metaWidth` x
 * `metaHeight` is the full size LibRaw's metadata reports (either way
 * round), or a file header's raw IFD when the metadata has none, with that
 * IFD's `photometric`. A decode at the reported size, or of a LinearRaw IFD,
 * is its own full size (#229 review R1-080: never doubled); one at half the
 * reported size has that size. Without a matching finite report, use the
 * decoded size: a half-size request alone cannot prove LibRaw shrank it.
 */
export function halfDecodeFullSize(width, height, metaWidth = 0, metaHeight = 0, { photometric = null } = {}) {
  if (photometric === PHOTOMETRIC_LINEAR_RAW) return { width, height };
  return matchingHalfDecodeSize(width, height, metaWidth, metaHeight) || { width, height };
}

function matchingHalfDecodeSize(width, height, metaWidth, metaHeight) {
  if (valid(metaWidth, metaHeight)) {
    const near = (w, h) => Math.abs(width - w) <= 1 && Math.abs(height - h) <= 1;
    if (near(metaWidth, metaHeight) || near(metaHeight, metaWidth)) return { width, height };
    const halves = (w, h) => Math.abs(width - Math.ceil(w / 2)) <= 1 && Math.abs(height - Math.ceil(h / 2)) <= 1;
    if (halves(metaWidth, metaHeight)) return { width: metaWidth, height: metaHeight };
    if (halves(metaHeight, metaWidth)) return { width: metaHeight, height: metaWidth };
  }
  return null;
}

// Unlike halfDecodeFullSize's geometry fallback, null means the request's
// shrinkage is unknown and its caller must use a full decode. A previous
// full decode takes precedence over metadata; raw-IFD evidence is checked
// independently, so a matching CFA header cannot be hidden by metadata.
export function resolveHalfDecodeFullSize(width, height, { knownFullSize = null, headerSize = null, metadataSize = null } = {}) {
  if (valid(knownFullSize?.width, knownFullSize?.height)) {
    return matchingHalfDecodeSize(width, height, knownFullSize.width, knownFullSize.height);
  }
  if (headerSize?.photometric === PHOTOMETRIC_LINEAR_RAW) return { width, height };
  for (const report of [headerSize, metadataSize]) {
    const full = matchingHalfDecodeSize(width, height, report?.width, report?.height);
    if (full) return full;
  }
  return null;
}

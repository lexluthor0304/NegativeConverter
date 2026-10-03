import { allocPlane16, sharedPlanesAvailable, markDerivedEightBit } from './crossOriginIsolation.js';

export const RAW_LIKE_EXTENSIONS = [
  '.cr2', '.cr3', '.crw', '.nef', '.nrw', '.arw', '.dng', '.raf', '.raw', '.rw2',
  '.pef', '.srw', '.3fr', '.mef', '.orf', '.rwl', '.iiq', '.x3f', '.mrw', '.kdc',
  '.dcr', '.tif', '.tiff'
];

export function isRawLikeFileName(fileName) {
  const normalized = String(fileName || '').toLowerCase();
  return RAW_LIKE_EXTENSIONS.some((ext) => normalized.endsWith(ext));
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

// Enough for the PNG signature + IHDR chunk header + IHDR payload.
export const IMAGE_SNIFF_BYTES = 128;

function asBytes(source) {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  return null;
}

/**
 * Identify an image container from its leading bytes.
 *
 * Extension/MIME dispatch is not enough on its own: `File.type` is empty for
 * some drag-and-drop sources, so a 48-bit PNG scan can silently land in the
 * browser decoder and lose half its precision. This only classifies containers
 * we can act on — TIFF-based RAW containers (NEF/CR2/ARW/DNG…) all share the
 * plain TIFF magic, so extension routing stays authoritative for those.
 *
 * @param {ArrayBuffer|Uint8Array} source first bytes of the file
 * @returns {{kind: string, depth?: number, colorType?: number, littleEndian?: boolean} | null}
 */
export function sniffImageKind(source) {
  const bytes = asBytes(source);
  if (!bytes || bytes.length < 4) return null;

  if (bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
    // IHDR payload starts at 16: 8 signature + 4 length + 4 type.
    if (bytes.length >= 26 && bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52) {
      return { kind: 'png', depth: bytes[24], colorType: bytes[25] };
    }
    return { kind: 'png' };
  }

  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return { kind: 'jpeg' };

  if (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2A && bytes[3] === 0x00) {
    return { kind: 'tiff', littleEndian: true };
  }
  if (bytes[0] === 0x4D && bytes[1] === 0x4D && bytes[2] === 0x00 && bytes[3] === 0x2A) {
    return { kind: 'tiff', littleEndian: false };
  }

  if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (/^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|heif|mif1|msf1)$/.test(brand)) return { kind: 'heif', brand };
    if (/^avi[fs]$/.test(brand)) return { kind: 'avif', brand };
    return { kind: 'iso-bmff', brand };
  }

  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return { kind: 'gif' };
  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return { kind: 'webp' };
  }

  return null;
}

// Every engine refuses beyond one of these; Chrome's 256 MP area cap is the
// most generous, Safari's 32767 px side the tightest of the ones that throw.
export const MAX_CANVAS_SIDE = 32767;
export const MAX_CANVAS_AREA = 268_435_456;
// iOS Safari historically silently produces a blank backing store past this
// area instead of throwing, so anything larger gets a read-back sanity check.
export const CANVAS_BLANK_PROBE_AREA = 16_777_216;

export function imageTooLargeError(width, height) {
  const err = new Error(`Image is too large for this browser to process (${width}x${height}).`);
  err.code = 'IMAGE_TOO_LARGE';
  err.width = width;
  err.height = height;
  return err;
}

/**
 * Throw a coded, translatable error instead of handing an over-limit size to a
 * canvas, which either throws a raw DOM error or silently returns black.
 */
export function assertCanvasSize(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw imageTooLargeError(width, height);
  }
  if (width > MAX_CANVAS_SIDE || height > MAX_CANVAS_SIDE || width * height > MAX_CANVAS_AREA) {
    throw imageTooLargeError(width, height);
  }
  return true;
}

/**
 * A canvas that exceeded the platform limit reads back as transparent black.
 * Sampling the alpha channel catches that; scans are never fully transparent,
 * and we only probe past the size where the failure actually happens.
 */
export function looksLikeBlankReadback(data, width, height) {
  if (!data || width * height <= CANVAS_BLANK_PROBE_AREA) return false;
  const pixelCount = width * height;
  const samples = 512;
  const step = Math.max(1, Math.floor(pixelCount / samples));
  for (let i = 0; i < pixelCount; i += step) {
    if (data[i * 4 + 3] !== 0) return false;
  }
  return true;
}

export function isPngFile(file) {
  return String(file?.type || '').toLowerCase() === 'image/png'
    || /\.png$/i.test(String(file?.name || ''));
}

export async function loadRawImageData(buffer, fileName, options) {
  const { loadRawFile } = await import('./rawFileLoader.js');
  return loadRawFile(buffer, fileName, options);
}

export async function loadRawImageDataPreview(buffer, fileName, options) {
  const { loadRawFile } = await import('./rawFileLoader.js');
  return loadRawFile(buffer, fileName, { ...options, preview: true });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason?.name === 'AbortError' ? signal.reason
    : new DOMException('Image decode was aborted', 'AbortError');
}

/**
 * Decode a PNG buffer.
 *
 * Only genuinely 16-bit PNGs go through UPNG in a disposable decode worker
 * (with a synchronous fallback when workers are unavailable). Everything else — 8-bit, palette,
 * 1/2/4-bit, interlaced, tRNS — is handed to the browser decoder, which is
 * off-thread, handles every colour type correctly and costs ~1/5 the memory.
 */
export async function loadPngImageData(buffer, { signal = null, sharedPlanes = false, reserveDecode = null } = {}) {
  const aborted = () => signal?.reason?.name === 'AbortError' ? signal.reason
    : new DOMException('PNG decode was aborted', 'AbortError');
  if (signal?.aborted) throw aborted();
  let admissionError = null;
  const admit = async (size) => {
    throwIfAborted(signal);
    try { if (reserveDecode) await reserveDecode(size); }
    catch (error) { admissionError = error; throw error; }
    throwIfAborted(signal);
  };
  const options = { signal, sharedPlanes, ...(reserveDecode ? { reserveDecode: admit } : {}) };
  const header = sniffImageKind(buffer);
  const sixteenBit = header?.kind === 'png' && header.depth === 16;

  if (!sixteenBit && typeof createImageBitmap === 'function' && typeof Blob === 'function') {
    try {
      const image = await loadStandardImage(new Blob([buffer], { type: 'image/png' }), options);

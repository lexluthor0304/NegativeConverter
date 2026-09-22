import { isRawLikeFileName } from './imageFileLoaders.js';

const HEADER_BYTES = 256 * 1024;
const dimensions = new WeakMap();
export const UNKNOWN_IMAGE_PIXELS = 150_000_000;

function valid(width, height) {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
    && Number.isSafeInteger(width * height) ? { width, height } : null;
}

// Read headers only: no canvas allocation, decompression or RAW demosaic.
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
  if (bytes.length < 8) return null;
  const little = bytes[0] === 0x49 && bytes[1] === 0x49;
  if (!little && !(bytes[0] === 0x4d && bytes[1] === 0x4d)) return null;
  if (view.getUint16(2, little) !== 42) return null;
  const offsets = [view.getUint32(4, little)], visited = new Set();
  let best = null;
  while (offsets.length && visited.size < 64) {
    const offset = offsets.pop();
    if (!offset || visited.has(offset) || offset + 2 > bytes.length) continue;
    visited.add(offset);
    const count = view.getUint16(offset, little);
    if (count > 4096 || offset + 2 + count * 12 + 4 > bytes.length) continue;
    let width, height, photo;
    for (let i = 0; i < count; i++) {
      const entry = offset + 2 + i * 12;
      const tag = view.getUint16(entry, little), type = view.getUint16(entry + 2, little);
      const n = view.getUint32(entry + 4, little);
      const size = type === 3 ? 2 : type === 4 || type === 13 ? 4 : 0;
      if (!size || !n || n > 64) continue;
      const start = n * size <= 4 ? entry + 8 : view.getUint32(entry + 8, little);
      if (start + n * size > bytes.length) continue;
      const read = j => size === 2 ? view.getUint16(start + j * size, little) : view.getUint32(start + j * size, little);
      if (tag === 256) width = read(0);
      if (tag === 257) height = read(0);
      if (tag === 262) photo = read(0);
      if (tag === 330) for (let j = 0; j < n; j++) offsets.push(read(j));
    }
    const found = valid(width, height);
    if (found && (!raw || photo === 32803 || photo === 34892)
      && (!best || found.width * found.height > best.width * best.height)) best = found;
    offsets.push(view.getUint32(offset + 2 + count * 12, little));
  }
  return best;
}

export function rememberImageDimensions(file, image) {
  const size = valid(image?.width, image?.height);
  if (file && size) dimensions.set(file, size);
}

export async function imagePixelsForBatch(file) {
  let size = dimensions.get(file);
  if (!size) {
    try {
      const raw = isRawLikeFileName(file.name) && !/\.tiff?$/i.test(file.name || '');
      size = parseImageDimensions(await file.slice(0, HEADER_BYTES).arrayBuffer(), { raw });
      if (size) dimensions.set(file, size);
    } catch { /* Unsupported/truncated headers use a conservative memory budget. */ }
  }
  return size ? size.width * size.height : UNKNOWN_IMAGE_PIXELS;
}

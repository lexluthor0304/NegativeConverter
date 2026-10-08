// Retained tile sources (#247): per queue item, the geometry-applied working
// image (long side at most 288 px) a canonical light-table tile was converted
// from, a small 16-bit analysis reference of the frame's image area and the
// geometry both belong to. A recipe change that keeps the geometry (Sync
// colours, Apply to selected without crop, the dust toggle, an AI-repair
// revision, a film-type change) re-renders the tile from here instead of
// decoding the original again.
//
// Session RAM only, bounded per entry and in total, least recently used
// first out. Entries are stored compactly: a 16-bit plane keeps its RGB
// samples and, when some pixels are transparent (a rotation's corners, a
// reference sample outside the frame), a one-bit opacity mask, since its
// alpha is only ever 0 or 65535; an 8-bit plane is copied as it is. A 3:2
// frame with a reference takes about 0.43 MB, so 151 frames fit in 65 MB.

export const TILE_ANALYSIS_REFERENCE_PIXELS = 16384;
export const TILE_SOURCE_MAX_ENTRY_BYTES = 600_000;
export const TILE_SOURCE_MAX_BYTES = 100_000_000;

function exactPlane16(image) {
  const plane = image?.__image16 || (image?.data instanceof Uint16Array ? image : null);
  return plane && plane.data instanceof Uint16Array && plane.width === image.width && plane.height === image.height
    && plane.data.length === image.width * image.height * 4 ? plane : null;
}

function packPlane16(width, height, data) {
  const pixels = width * height;
  let binaryAlpha = true;
  let transparent = false;
  for (let i = 3; i < data.length; i += 4) {
    const alpha = data[i];
    if (alpha === 0) transparent = true;
    else if (alpha !== 65535) { binaryAlpha = false; break; }
  }
  // Any other alpha value: keep the plane whole (never happens for decoded,
  // resampled or sampled frames, but the store must stay lossless).
  if (!binaryAlpha) return { kind: 16, width, height, rgba: data.slice(), bytes: data.byteLength };
  const rgb = new Uint16Array(pixels * 3);
  for (let p = 0, i = 0, o = 0; p < pixels; p++, i += 4, o += 3) {
    rgb[o] = data[i]; rgb[o + 1] = data[i + 1]; rgb[o + 2] = data[i + 2];
  }
  let opaque = null;
  if (transparent) {
    opaque = new Uint8Array(Math.ceil(pixels / 8));
    for (let p = 0; p < pixels; p++) if (data[p * 4 + 3]) opaque[p >> 3] |= 1 << (p & 7);
  }
  return { kind: 16, width, height, rgb, opaque, bytes: rgb.byteLength + (opaque ? opaque.byteLength : 0) };
}

function unpackPlane16(packed) {
  if (packed.rgba) return packed.rgba.slice();
  const pixels = packed.width * packed.height;
  const data = new Uint16Array(pixels * 4);
  const { rgb, opaque } = packed;
  for (let p = 0, i = 0, o = 0; p < pixels; p++, i += 4, o += 3) {
    data[i] = rgb[o]; data[i + 1] = rgb[o + 1]; data[i + 2] = rgb[o + 2];
    data[i + 3] = !opaque || (opaque[p >> 3] & (1 << (p & 7))) ? 65535 : 0;
  }
  return data;
}

function packImage(image) {
  const plane = exactPlane16(image);
  if (plane) return packPlane16(image.width, image.height, plane.data);
  const data = image.data.slice();
  return { kind: 8, width: image.width, height: image.height, data, bytes: data.byteLength };
}

function wrapImage(data8, width, height) {
  return typeof ImageData === 'function' ? new ImageData(data8, width, height) : { data: data8, width, height };
}

// The conversion reads a 16-bit plane when there is one: the 8-bit view of
// a packed frame is only derived for readers that need a complete image.
function unpackImage(packed) {
  if (packed.kind === 8) return wrapImage(packed.data.slice(), packed.width, packed.height);
  const data16 = unpackPlane16(packed);
  const data8 = new Uint8ClampedArray(data16.length);
  for (let i = 0; i < data16.length; i++) data8[i] = data16[i] >>> 8;
  const image = wrapImage(data8, packed.width, packed.height);
  image.__image16 = { width: packed.width, height: packed.height, data: data16 };
  return image;
}

// An analysis reference is a bare { width, height, data: Uint16Array } plane.
function packReference(reference) {
  if (!reference || !(reference.data instanceof Uint16Array)) return null;
  return packPlane16(reference.width, reference.height, reference.data);
}

function unpackReference(packed) {
  return packed ? { width: packed.width, height: packed.height, data: unpackPlane16(packed) } : null;
}

/**
 * put(key, { working, reference, baseSize, geometryKey }) stores copies and
 * refuses an entry over `maxEntryBytes`. lookup(key, keyFor) returns fresh,
 * unshared planes `{ working, reference, baseSize }` when
 * keyFor(entry.baseSize) equals the stored geometry key, and drops an entry
 * whose geometry moved on (the next decode refills it).
 */
export function createThumbnailSourceCache({ maxBytes = TILE_SOURCE_MAX_BYTES, maxEntryBytes = TILE_SOURCE_MAX_ENTRY_BYTES } = {}) {
  const entries = new Map();
  let bytes = 0;
  const remove = (key) => {
    const entry = entries.get(key);
    if (!entry) return false;
    entries.delete(key);
    bytes -= entry.bytes;
    return true;
  };
  return {
    put(key, { working, reference = null, baseSize, geometryKey } = {}) {
      remove(key);
      if (!working || !baseSize || typeof geometryKey !== 'string') return false;
      const packedWorking = packImage(working);
      const packedReference = packReference(reference);
      const size = packedWorking.bytes + (packedReference ? packedReference.bytes : 0);
      if (size > maxEntryBytes || size > maxBytes) return false;
      while (bytes + size > maxBytes && entries.size) remove(entries.keys().next().value);
      entries.set(key, {
        working: packedWorking, reference: packedReference, geometryKey,
        baseSize: { width: baseSize.width, height: baseSize.height }, bytes: size
      });
      bytes += size;
      return true;
    },
    lookup(key, keyFor) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (keyFor(entry.baseSize) !== entry.geometryKey) { remove(key); return null; }
      entries.delete(key);
      entries.set(key, entry);
      return {
        working: unpackImage(entry.working), reference: unpackReference(entry.reference),
        baseSize: { ...entry.baseSize }
      };
    },
    has(key) { return entries.has(key); },
    delete(key) { return remove(key); },
    clear() { entries.clear(); bytes = 0; },
    retainKeys(keys) {
      const retained = new Set(keys);
      for (const key of [...entries.keys()]) if (!retained.has(key)) remove(key);
    },
    buffers() {
      const buffers = [];
      for (const entry of entries.values()) {
        for (const packed of [entry.working, entry.reference]) {
          for (const array of [packed?.rgb, packed?.opaque, packed?.rgba, packed?.data]) if (array) buffers.push(array.buffer);
        }
      }
      return buffers;
    },
    get bytes() { return bytes; },
    get size() { return entries.size; }
  };
}

// Display proxies (#249). Above 16 MP without repairs, the settled view of a
// photo is the preview conversion of its display preview
// (`conversionPreviewImageData`, resizeDisplayPreview of the conversion
// source) with the base's colour-analysis sample. A proxy keeps exactly
// those inputs: the 16-bit display preview and the sample, so a revisit can
// convert again without a decode. It is display-only: it never becomes a
// base, a geometry plane or a conversion source, and every export still
// waits for the real source.
//
// This module holds the pure parts: the proxy key, the compact plane format
// (RGB16 when the alpha plane is uniformly opaque), the record format of the
// spill and the persistent store, and its checksum.

export const DISPLAY_PROXY_VERSION = 1;
const RECORD_MAGIC = 0x5044434e; // 'NCDP' little-endian
const HEADER_WORDS = 4; // magic, version, header bytes, reserved

// The geometry, lens, analysis-area and target parts of the key. The colour
// recipe, film type and flat field are conversion inputs, not key parts: a
// proxy converts under whatever recipe the photo has now. Callers pass
// values already sanitised the way the editor builds the planes (effective
// angle, crop sanitised against the rotated frame, the lens signature only
// when correction is active).
export function displayProxyKey({
  id = null, route = null, base = null, rotationAngle = 0, mirrored = false, cropRegion = null,
  lens = null, area = null, target = null
} = {}) {
  const crop = cropRegion ? [cropRegion.left, cropRegion.top, cropRegion.width, cropRegion.height] : null;
  const size = target ? [target.width, target.height] : null;
  const inputs = target ? [target.viewportWidth, target.viewportHeight, target.dpr, target.zoom,
    target.maxPixels, target.maxDimension] : null;
  return JSON.stringify([DISPLAY_PROXY_VERSION, id, route, base ? [base.width, base.height, Boolean(base.has16)] : null,
    Number(rotationAngle) || 0, Boolean(mirrored), crop, lens ?? null, area ?? null, size, inputs]);
}

// Whether every 8-bit value of `image` is resizeDisplayPreview's own
// Math.round(v / 257) of its 16-bit value, so the 16-bit plane alone
// rebuilds both planes exactly.
export function derivesEightBit(image) {
  const plane = image?.__image16?.data;
  const data = image?.data;
  if (!(plane instanceof Uint16Array) || !data || plane.length !== data.length) return false;
  for (let i = 0; i < plane.length; i++) if (data[i] !== Math.round(plane[i] / 257)) return false;
  return true;
}

function opaqueAlpha(values, max) {
  for (let i = 3; i < values.length; i += 4) if (values[i] !== max) return false;
  return true;
}

function dropAlpha(values, Type) {
  const pixels = values.length / 4;
  const out = new Type(pixels * 3);
  for (let i = 0, o = 0; i < values.length; i += 4, o += 3) {
    out[o] = values[i]; out[o + 1] = values[i + 1]; out[o + 2] = values[i + 2];
  }
  return out;
}

/**
 * The compact form of a display plane: RGB16 when the 16-bit alpha is
 * uniformly 0xFFFF, RGBA16 otherwise (a crop can keep a rotation's
 * transparent corners). The 8-bit plane is stored as well only when it is
 * not derived from the 16-bit one; an 8-bit-only image stores RGB8/RGBA8.
 */
export function packDisplayPlane(image) {
  const { width, height } = image;
  const plane = image.__image16?.data;
  if (plane instanceof Uint16Array && plane.length === width * height * 4) {
    const opaque = opaqueAlpha(plane, 65535);
    const packed = { width, height, bits: 16, channels: opaque ? 3 : 4, data: opaque ? dropAlpha(plane, Uint16Array) : new Uint16Array(plane) };
    // A display level (#248) is a 16-bit plane only.
    if (!image.data) packed.only16 = true;
    else if (!derivesEightBit(image)) packed.data8 = new Uint8Array(image.data.buffer.slice(image.data.byteOffset, image.data.byteOffset + image.data.byteLength));
    return packed;
  }
  const data = image.data;
  const opaque = opaqueAlpha(data, 255);
  return { width, height, bits: 8, channels: opaque ? 3 : 4,
    data: opaque ? dropAlpha(data, Uint8Array) : new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)) };
}

function createImage(ImageDataCtor, width, height) {
  if (typeof ImageDataCtor === 'function') {
    try { return new ImageDataCtor(width, height); } catch { /* fall through to a plain object */ }
  }
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

function expand16(data, channels, pixels) {
  const plane = new Uint16Array(pixels * 4);
  if (channels === 4) { plane.set(data); return plane; }
  for (let p = 0, i = 0, o = 0; p < pixels; p++, i += 3, o += 4) {
    plane[o] = data[i]; plane[o + 1] = data[i + 1]; plane[o + 2] = data[i + 2]; plane[o + 3] = 65535;
  }
  return plane;
}

/** The ImageData packDisplayPlane was given, byte for byte (a 16-bit-only level as { width, height, __image16 }). */
export function unpackDisplayPlane(packed, ImageDataCtor = globalThis.ImageData) {
  const { width, height, bits, channels, data } = packed;
  const pixels = width * height;
  if (bits === 16 && packed.only16) return { width, height, __image16: { width, height, data: expand16(data, channels, pixels) } };
  const image = createImage(ImageDataCtor, width, height);
  const out8 = image.data;
  if (bits === 16) {
    const plane = new Uint16Array(pixels * 4);
    if (channels === 4) plane.set(data);
    else {
      for (let p = 0, i = 0, o = 0; p < pixels; p++, i += 3, o += 4) {
        plane[o] = data[i]; plane[o + 1] = data[i + 1]; plane[o + 2] = data[i + 2]; plane[o + 3] = 65535;
      }
    }
    if (packed.data8) out8.set(packed.data8);
    else for (let i = 0; i < plane.length; i++) out8[i] = Math.round(plane[i] / 257);
    image.__image16 = { width, height, data: plane };
    return image;
  }
  if (channels === 4) out8.set(data);
  else {
    for (let p = 0, i = 0, o = 0; p < pixels; p++, i += 3, o += 4) {
      out8[o] = data[i]; out8[o + 1] = data[i + 1]; out8[o + 2] = data[i + 2]; out8[o + 3] = 255;
    }
  }
  return image;
}

/** FNV-1a over 32-bit words (then the tail bytes): a fast integrity check. */
export function checksum32(bytes, seed = 0x811c9dc5) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength);
  let hash = seed >>> 0;
  const words = Math.floor(view.byteLength / 4);
  if (view.byteOffset % 4 === 0 && words) {
    const u32 = new Uint32Array(view.buffer, view.byteOffset, words);
    for (let i = 0; i < u32.length; i++) hash = Math.imul(hash ^ u32[i], 16777619) >>> 0;
  } else {
    for (let i = 0; i < words; i++) {
      const o = i * 4;
      const word = view[o] | (view[o + 1] << 8) | (view[o + 2] << 16) | (view[o + 3] << 24);
      hash = Math.imul(hash ^ (word >>> 0), 16777619) >>> 0;
    }
  }
  for (let i = words * 4; i < view.byteLength; i++) hash = Math.imul(hash ^ view[i], 16777619) >>> 0;
  return hash >>> 0;
}

/** A plane's identity: hash of its 16-bit plane, else of its 8-bit one. */
export function displayPlaneHash(image) {
  const plane = image?.__image16?.data || image?.data;
  if (!plane) return null;
  return checksum32(new Uint8Array(plane.buffer, plane.byteOffset, plane.byteLength));
}

function bytesOf(array) {
  return new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
}

function align8(value) {
  return (value + 7) & ~7;
}

/**
 * One self-contained record: a JSON header (key, metadata, section layout)
 * and the binary sections, followed by a checksum of everything before it.
 * Section offsets count from the first 8-byte boundary after the header.
 * `sample` is the colour-analysis sample ({ width, height, data: Uint16Array })
 * or null. Returns an ArrayBuffer.
 */
export function encodeDisplayProxyRecord({ key, meta = {}, plane, sample = null }) {
  const sections = [];
  const layout = {};
  let offset = 0;
  const add = (name, array) => {
    layout[name] = { type: array instanceof Uint16Array ? 'u16' : 'u8', length: array.length, offset };
    sections.push([name, bytesOf(array)]);
    offset = align8(offset + array.byteLength);
  };
  add('plane', plane.data);
  if (plane.data8) add('plane8', plane.data8);
  if (sample?.data) add('sample', sample.data);
  const header = new TextEncoder().encode(JSON.stringify({
    key, meta,
    plane: { width: plane.width, height: plane.height, bits: plane.bits, channels: plane.channels, ...(plane.only16 ? { only16: true } : {}) },
    sample: sample?.data ? { width: sample.width, height: sample.height } : null,
    sections: layout
  }));
  const dataStart = align8(HEADER_WORDS * 4 + header.byteLength);
  const total = dataStart + offset + 4;
  const buffer = new ArrayBuffer(total);
  const words = new Uint32Array(buffer, 0, HEADER_WORDS);
  words[0] = RECORD_MAGIC; words[1] = DISPLAY_PROXY_VERSION; words[2] = header.byteLength; words[3] = 0;
  const out = new Uint8Array(buffer);
  out.set(header, HEADER_WORDS * 4);
  for (const [name, bytes] of sections) out.set(bytes, dataStart + layout[name].offset);
  new DataView(buffer).setUint32(total - 4, checksum32(new Uint8Array(buffer, 0, total - 4)), true);
  return buffer;
}

/**
 * The record encodeDisplayProxyRecord wrote, or null when it is truncated,
 * corrupted, of another version, or (with `expectKey`) of another key.
 * Returns { key, meta, plane, sample } with `plane` in packDisplayPlane's form.
 */
export function decodeDisplayProxyRecord(buffer, { expectKey = null } = {}) {
  try {
    const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    if (bytes.byteLength < HEADER_WORDS * 4 + 4) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== RECORD_MAGIC || view.getUint32(4, true) !== DISPLAY_PROXY_VERSION) return null;
    const stored = view.getUint32(bytes.byteLength - 4, true);
    if (checksum32(bytes.subarray(0, bytes.byteLength - 4)) !== stored) return null;
    const headerLength = view.getUint32(8, true);
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(HEADER_WORDS * 4, HEADER_WORDS * 4 + headerLength)));
    const dataStart = align8(HEADER_WORDS * 4 + headerLength);
    if (expectKey !== null && header.key !== expectKey) return null;
    // Copies, so the result owns aligned buffers of its own.
    const read = name => {
      const section = header.sections?.[name];
      if (!section) return null;
      const size = section.length * (section.type === 'u16' ? 2 : 1);
      const at = dataStart + section.offset;
      if (at + size > bytes.byteLength - 4) throw new RangeError('Display proxy section out of range');
      const copy = bytes.slice(at, at + size);
      return section.type === 'u16' ? new Uint16Array(copy.buffer) : copy;
    };
    const planeData = read('plane');
    const expected = header.plane.width * header.plane.height * header.plane.channels;
    if (!planeData || planeData.length !== expected) return null;
    const plane = { ...header.plane, data: planeData };
    const plane8 = read('plane8');
    if (plane8) plane.data8 = plane8;
    const sampleData = read('sample');
    const sample = header.sample && sampleData ? { width: header.sample.width, height: header.sample.height, data: sampleData } : null;
    return { key: header.key, meta: header.meta || {}, plane, sample };
  } catch {
    return null;
  }
}

// Bytes a packed plane and sample occupy (the spill's and store's unit).
export function displayProxyBytes(plane, sample = null) {
  let bytes = plane.data.byteLength + (plane.data8?.byteLength || 0);
  if (sample?.data) bytes += sample.data.byteLength;
  return bytes;
}

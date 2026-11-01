// 16-bit RGBA image container.
// Shape mirrors the browser's ImageData: { width, height, data } — but
// `data` is a Uint16Array in [0, 65535] instead of Uint8ClampedArray in [0, 255].
// Always RGBA, always non-premultiplied.

export const IMAGE16_MAX = 65535;

// Byte order of typed-array views. Packed 32-bit loops below and in the engine assume
// little-endian words (every shipping platform); elsewhere they fall back to plain
// per-sample loops.
export const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

// Whether a typed array can be viewed as whole 32-bit words.
export function wordAligned(array) {
  return array.byteOffset % 4 === 0 && array.byteLength % 4 === 0;
}

export function createImage16(width, height) {
  return {
    width,
    height,
    data: new Uint16Array(width * height * 4),
  };
}

// Wrap an existing Uint16Array as Image16 without copying.
export function wrapImage16(width, height, data) {
  if (!(data instanceof Uint16Array)) {
    throw new TypeError('wrapImage16 expects a Uint16Array');
  }
  if (data.length !== width * height * 4) {
    throw new RangeError(`Uint16Array length ${data.length} does not match RGBA ${width}x${height}`);
  }
  return { width, height, data };
}

// 8 → 16 bit upscale using ×257 (replicates the byte: 0xAB → 0xABAB).
// This guarantees 0 → 0 and 255 → 65535 with linear spacing.
export function fromImageData8(imageData) {
  const { width, height, data: src } = imageData;
  const dst = new Uint16Array(width * height * 4);
  let i = 0;
  if (LITTLE_ENDIAN && src.byteOffset % 4 === 0) {
    // Four samples in, two words out: spread the bytes into 16-bit lanes and
    // multiply once, b * 257 = b | b << 8 per lane, no carry across lanes.
    const words = Math.min(src.length, dst.length) >>> 2;
    const s32 = new Uint32Array(src.buffer, src.byteOffset, words);
    const d32 = new Uint32Array(dst.buffer, 0, words * 2);
    for (let k = 0, o = 0; k < words; k++, o += 2) {
      const w = s32[k];
      d32[o] = ((w & 0xFF) | ((w & 0xFF00) << 8)) * 257;
      d32[o + 1] = (((w >>> 16) & 0xFF) | ((w >>> 8) & 0xFF0000)) * 257;
    }
    i = words * 4;
  }
  for (; i < src.length; i++) {
    dst[i] = src[i] * 257;
  }
  return { width, height, data: dst };
}

// 16 → 8 bit downscale using >>>8 (drops the low byte, equivalent to floor(v/256)
// which is the inverse of ×257 in the round-trip sense — fromImageData8 then
// toImageData8 is lossless for any 8-bit input).
// Always sets alpha to 255 unless the source already has full-range alpha.
// The values are already 0–255, so the clamped stores would do no useful work: the
// bytes are written through plain views, four samples per 32-bit word where the
// platform is little-endian (the high byte of each 16-bit sample, in order).
export function toImageData8(image16) {
  const { width, height } = image16;
  return new ImageData(highBytesOf(image16), width, height);
}

// The same bytes as a plain { width, height, data } (no ImageData global
// needed): the RAW post-decode worker's 8-bit mirror and Node tests.
export function toRGBA8(image16) {
  const { width, height } = image16;
  return { width, height, data: highBytesOf(image16) };
}

// The high byte of every sample, as a fresh Uint8ClampedArray of width x
// height x 4.
function highBytesOf(image16) {
  const { width, height, data: src } = image16;
  const dst = new Uint8ClampedArray(width * height * 4);
  if (LITTLE_ENDIAN && wordAligned(src) && src.length === dst.length) {
    const s32 = new Uint32Array(src.buffer, src.byteOffset, src.length >>> 1);
    const d32 = new Uint32Array(dst.buffer, 0, dst.length >>> 2);
    for (let i = 0, j = 0; i < d32.length; i++, j += 2) {
      const lo = s32[j], hi = s32[j + 1];
      d32[i] = ((lo >>> 8) & 0xFF) | ((lo >>> 16) & 0xFF00) | ((hi << 8) & 0xFF0000) | (hi & 0xFF000000);
    }
  } else {
    const out = new Uint8Array(dst.buffer);
    const n = Math.min(src.length, out.length);
    for (let i = 0; i < n; i++) {
      out[i] = src[i] >>> 8;
    }
  }
  return dst;
}

export function cloneImage16(image16) {
  return {
    width: image16.width,
    height: image16.height,
    data: new Uint16Array(image16.data),
  };
}

// Pack {data: Uint16Array RGB or RGBA, channels} into a full RGBA Image16.
// Used by loaders that get RGB-only output from a decoder. `alloc(length)`
// makes the RGBA plane (#264: the RAW post-decode worker's shared plane); a
// 4-channel source is wrapped as it is unless an allocator is given.
export function packRGBToImage16(width, height, rgb16, channels, alloc = null) {
  if (channels === 4) {
    if (!alloc) return wrapImage16(width, height, rgb16);
    const plane = alloc(width * height * 4);
    plane.set(rgb16.subarray(0, width * height * 4));
    return wrapImage16(width, height, plane);
  }
  if (channels !== 3 && channels !== 1) {
    throw new RangeError(`packRGBToImage16: unsupported channel count ${channels}`);
  }
  const pixelCount = width * height;
  const dst = alloc ? alloc(pixelCount * 4) : new Uint16Array(pixelCount * 4);
  if (channels === 3) {
    let i = 0;
    if (LITTLE_ENDIAN && rgb16.byteOffset % 4 === 0 && dst.byteOffset % 4 === 0) {
      // Two pixels per step as whole words: R0G0 B0R1 G1B1 in, R0G0 B0A R1G1 B1A out.
      const pairs = pixelCount >>> 1;
      const s32 = new Uint32Array(rgb16.buffer, rgb16.byteOffset, pairs * 3);
      const d32 = new Uint32Array(dst.buffer, dst.byteOffset, pairs * 4);
      for (let q = 0, k = 0, o = 0; q < pairs; q++, k += 3, o += 4) {
        const w0 = s32[k], w1 = s32[k + 1], w2 = s32[k + 2];
        d32[o] = w0;
        d32[o + 1] = (w1 & 0xFFFF) | 0xFFFF0000;
        d32[o + 2] = (w1 >>> 16) | (w2 << 16);
        d32[o + 3] = (w2 >>> 16) | 0xFFFF0000;
      }
      i = pairs * 2;
    }
    for (; i < pixelCount; i++) {
      dst[i * 4]     = rgb16[i * 3];
      dst[i * 4 + 1] = rgb16[i * 3 + 1];
      dst[i * 4 + 2] = rgb16[i * 3 + 2];
      dst[i * 4 + 3] = IMAGE16_MAX;
    }
  } else {
    for (let i = 0; i < pixelCount; i++) {
      const v = rgb16[i];
      dst[i * 4]     = v;
      dst[i * 4 + 1] = v;
      dst[i * 4 + 2] = v;
      dst[i * 4 + 3] = IMAGE16_MAX;
    }
  }
  return { width, height, data: dst };
}

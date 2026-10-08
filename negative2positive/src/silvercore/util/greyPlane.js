// B&W conversion from one grey value per pixel (#238).
//
// After the channel mix every B&W stage maps a pixel from its grey value alone: the
// pre-saturation, the dodge-and-burn stops, the tone curves, the 3D profile,
// saturation, paper and toning (Engine.buildGreyTable). So the adapter keeps a Uint16
// grey plane instead of an RGBA16 one and writes the output through a 65536-entry
// grey → RGB table. Every function here reproduces the RGBA stages bit for bit.
//
// The hot loops are kept monomorphic (one loop per case, no per-pixel mode tests):
// a generic loop with those tests measured two to four times slower in V8.

import { exposeGreyValue, isTiledStops, exposureStopsCover } from './localExposure.js';
import { LITTLE_ENDIAN } from './image16.js';

export { LITTLE_ENDIAN };

// toGrayscaleInPlace's mix (same Math.round, same operand order) and then the
// pre-saturation ramp (Engine.preSaturationRamp), into `out` (one value per pixel).
// `& 0xFFFF` is what the Uint16Array store in toGrayscaleInPlace does.
export function mixToGrey(src, weights, preSatRamp, out) {
  const wr = weights.r, wg = weights.g, wb = weights.b;
  const n = out.length;
  if (preSatRamp) {
    for (let p = 0; p < n; p++) {
      const i = p << 2;
      out[p] = preSatRamp[Math.round(src[i] * wr + src[i + 1] * wg + src[i + 2] * wb) & 0xFFFF];
    }
  } else {
    for (let p = 0; p < n; p++) {
      const i = p << 2;
      out[p] = Math.round(src[i] * wr + src[i + 1] * wg + src[i + 2] * wb);
    }
  }
  return out;
}

export function allOpaque(data) {
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 65535) return false;
  return true;
}

// Packed forms of Engine.buildGreyTable's { r, g, b } for the output loops, with
// `through` (the pre-saturation ramp) composed in front when given: T[S[v]].
export function packGreyTable(table, through = null) {
  const r = new Uint16Array(65536), g = new Uint16Array(65536), b = new Uint16Array(65536);
  const lo = new Uint32Array(65536);       // R | G << 16 (little-endian RGBA16 words)
  const hiOpaque = new Uint32Array(65536); // B | 0xFFFF << 16
  const rgb8 = new Uint32Array(65536);     // R8 | G8 << 8 | B8 << 16
  const rgba8Opaque = new Uint32Array(65536);
  for (let v = 0; v < 65536; v++) {
    const y = through ? through[v] : v;
    const R = table.r[y], G = table.g[y], B = table.b[y];
    r[v] = R; g[v] = G; b[v] = B;
    lo[v] = R | (G << 16);
    hiOpaque[v] = B | 0xFFFF0000;
    rgb8[v] = (R >>> 8) | ((G >>> 8) << 8) | ((B >>> 8) << 16);
    rgba8Opaque[v] = rgb8[v] | 0xFF000000;
  }
  return { r, g, b, lo, hiOpaque, rgb8, rgba8Opaque };
}

/**
 * The RGBA16 and RGBA8 output of a grey plane: table RGB plus the source alpha
 * (`alphaData` is an RGBA16 plane, or null when every pixel is opaque), as
 * _applyLuts and toImageData8 would produce them from the RGBA grey image. On a
 * little-endian platform each pixel is two 32-bit stores for 16 bits and one for 8;
 * elsewhere (and in the tests' cross-check) per-channel stores.
 */
export function writeGreyOutput(grey, alphaData, packed, out16, out8, littleEndian = LITTLE_ENDIAN) {
  const n = grey.length;
  if (!littleEndian) {
    writeGreyChannels(grey, alphaData, packed, out16, out8);
    return;
  }
  const o16 = new Uint32Array(out16.buffer, out16.byteOffset, n * 2);
  const o8 = new Uint32Array(out8.buffer, out8.byteOffset, n);
  const { lo, b } = packed;
  if (!alphaData) {
    const { hiOpaque, rgba8Opaque } = packed;
    for (let p = 0; p < n; p++) {
      const y = grey[p];
      o16[2 * p] = lo[y];
      o16[2 * p + 1] = hiOpaque[y];
      o8[p] = rgba8Opaque[y];
    }
  } else {
    const { rgb8 } = packed;
    for (let p = 0; p < n; p++) {
      const y = grey[p];
      const a = alphaData[(p << 2) + 3];
      o16[2 * p] = lo[y];
      o16[2 * p + 1] = b[y] | (a << 16);
      o8[p] = rgb8[y] | ((a >>> 8) << 24);
    }
  }
}

function writeGreyChannels(grey, alphaData, packed, out16, out8) {
  const { r, g, b } = packed;
  const o8 = new Uint8Array(out8.buffer, out8.byteOffset, out8.length);
  for (let p = 0; p < grey.length; p++) {
    const i = p << 2;
    const y = grey[p];
    const a = alphaData ? alphaData[i + 3] : 65535;
    out16[i] = r[y]; out16[i + 1] = g[y]; out16[i + 2] = b[y]; out16[i + 3] = a;
    o8[i] = r[y] >>> 8; o8[i + 1] = g[y] >>> 8; o8[i + 2] = b[y] >>> 8; o8[i + 3] = a >>> 8;
  }
}

/**
 * One fused pass from an RGBA16 source: mix → pre-saturation → stops → table, written
 * as RGBA16 and RGBA8. `out16` may be `src` itself (each pixel is read before it is
 * written). Used where no grey plane is kept. Without stops, pass the pre-saturation
 * ramp composed into the table (packGreyTable's `through`) and null here: that case
 * runs the lean loop.
 */
export function convertGreyFromSource(src, weights, preSatRamp, stops, packed, out16, out8, littleEndian = LITTLE_ENDIAN, width = 0) {
  const n = src.length >>> 2;
  // A tiled map (#254) of the `width`-wide frame: the same per-pixel steps, with
  // the stops of the tiles a row crosses (none outside them).
  if (isTiledStops(stops) && width > 0 && exposureStopsCover(stops, width, n / width)) {
    convertGreyTiled(src, weights, preSatRamp, stops, packed, out16, out8, littleEndian);
    return;
  }
  if (!littleEndian || preSatRamp || (stops && stops.length === n)) {
    convertGreyGeneral(src, weights, preSatRamp, stops && stops.length === n ? stops : null, packed, out16, out8, littleEndian);
    return;
  }
  const wr = weights.r, wg = weights.g, wb = weights.b;
  const o16 = new Uint32Array(out16.buffer, out16.byteOffset, n * 2);
  const o8 = new Uint32Array(out8.buffer, out8.byteOffset, n);
  const { lo, b, rgb8 } = packed;
  for (let p = 0; p < n; p++) {
    const i = p << 2;
    const y = Math.round(src[i] * wr + src[i + 1] * wg + src[i + 2] * wb) & 0xFFFF;
    const a = src[i + 3];
    o16[2 * p] = lo[y];
    o16[2 * p + 1] = b[y] | (a << 16);
    o8[p] = rgb8[y] | ((a >>> 8) << 24);
  }
}

function greyOutputViews(out16, out8, n, littleEndian) {
  return {
    o16: littleEndian ? new Uint32Array(out16.buffer, out16.byteOffset, n * 2) : null,
    o8: littleEndian ? new Uint32Array(out8.buffer, out8.byteOffset, n) : null,
    b8: littleEndian ? null : new Uint8Array(out8.buffer, out8.byteOffset, n * 4),
  };
}

// Every other case, per pixel: the ramp, the stops (only where non-zero) and the stores.
function convertGreyGeneral(src, weights, preSatRamp, stops, packed, out16, out8, littleEndian) {
  const n = src.length >>> 2;
  convertGreyRun(src, weights, preSatRamp, stops, 0, packed, out16, greyOutputViews(out16, out8, n, littleEndian), 0, n);
}

// convertGreyGeneral over the pixels [p0, p0 + count), with stops[q0...] (or none).
function convertGreyRun(src, weights, preSatRamp, stops, q0, packed, out16, views, p0, count) {
  const wr = weights.r, wg = weights.g, wb = weights.b;
  const { r, g, b, lo, rgb8 } = packed;
  const { o16, o8, b8 } = views;
  for (let p = p0, q = q0, end = p0 + count; p < end; p++, q++) {
    const i = p << 2;
    let y = Math.round(src[i] * wr + src[i + 1] * wg + src[i + 2] * wb) & 0xFFFF;
    const a = src[i + 3];
    if (preSatRamp) y = preSatRamp[y];
    if (stops) {
      const s = stops[q];
      if (s !== 0) y = exposeGreyValue(y, s) & 0xFFFF;
    }
    if (o16) {
      o16[2 * p] = lo[y];
      o16[2 * p + 1] = b[y] | (a << 16);
      o8[p] = rgb8[y] | ((a >>> 8) << 24);
    } else {
      out16[i] = r[y]; out16[i + 1] = g[y]; out16[i + 2] = b[y]; out16[i + 3] = a;
      b8[i] = r[y] >>> 8; b8[i + 1] = g[y] >>> 8; b8[i + 2] = b[y] >>> 8; b8[i + 3] = a >>> 8;
    }
  }
}

// convertGreyGeneral with a tiled map: each row in runs of one tile column.
function convertGreyTiled(src, weights, preSatRamp, stops, packed, out16, out8, littleEndian) {
  const { width, height, tileSize, columns, tiles } = stops;
  const views = greyOutputViews(out16, out8, width * height, littleEndian);
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / tileSize);
    const ty = y - row * tileSize;
    for (let column = 0; column < columns; column++) {
      const x0 = column * tileSize;
      const count = Math.min(tileSize, width - x0);
      const tile = tiles[row * columns + column];
      convertGreyRun(src, weights, preSatRamp, tile, ty * tileSize, packed, out16, views, y * width + x0, count);
    }
  }
}

let identityRamp = null;

// The analysis histogram of the pre-saturated grey values without a plane: the same
// crop and transparent-pixel rule as analyzeImage (see analyzeGreyImage).
export function greyHistogramFromSource(src, width, bounds, weights, preSatRamp, skipTransparent) {
  if (!preSatRamp) {
    if (!identityRamp) {
      identityRamp = new Uint16Array(65536);
      for (let v = 0; v < 65536; v++) identityRamp[v] = v;
    }
    preSatRamp = identityRamp;
  }
  const hist = new Uint32Array(256);
  const wr = weights.r, wg = weights.g, wb = weights.b;
  let total = 0;
  for (let y = bounds.top; y < bounds.top + bounds.height; y++) {
    const rowEnd = (y * width + bounds.left + bounds.width) * 4;
    for (let i = (y * width + bounds.left) * 4; i < rowEnd; i += 4) {
      if (skipTransparent && src[i + 3] === 0) continue;
      hist[preSatRamp[Math.round(src[i] * wr + src[i + 1] * wg + src[i + 2] * wb) & 0xFFFF] >>> 8]++;
      total++;
    }
  }
  return { hist, total };
}

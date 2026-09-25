import { createImageCanvas } from './imageDataOps.js';

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
// Alpha is the fourth byte of an RGBA8 pixel, i.e. the top byte of its word.
const OPAQUE_ALPHA_WORD = LITTLE_ENDIAN ? 0xFF000000 : 0x000000FF;

// Full-resolution geometry builds run on this thread, for tests and the smoke
// run: `rotations` counts builds that resample or permute by an angle,
// `copies` mirror/crop-only builds.
export const geometryCounters = { rotations: 0, copies: 0 };

export function normalizeAngleDegrees(angle) {
  let normalized = Number.isFinite(angle) ? angle : 0;
  while (normalized > 180) normalized -= 360;
  while (normalized <= -180) normalized += 360;
  return normalized;
}

// Size of the frame applyRotationToImageData produces: nothing below 0.001°,
// right angles swap the sides, other angles grow the canvas to the rotated
// bounds. Readers that only need the frame's size use this instead of
// rotating pixels.
export function rotatedDimensions(width, height, angle) {
  const normalized = normalizeAngleDegrees(Number(angle) || 0);
  if (Math.abs(normalized) < 0.001) return { width, height };
  const rightAngle = Math.round(normalized / 90) * 90;
  if (Math.abs(normalized - rightAngle) < 0.001 && Math.abs(rightAngle) % 90 === 0) {
    return Math.abs(rightAngle) === 90 ? { width: height, height: width } : { width, height };
  }
  const rad = normalized * Math.PI / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  return { width: Math.max(1, Math.ceil(width * cos + height * sin)), height: Math.max(1, Math.ceil(width * sin + height * cos)) };
}

// Integer crop rectangle inside a frame of `frame.width` x `frame.height`, or
// null when nothing usable remains (main.js sanitizeCropRegionForImage).
export function sanitizeCropRect(cropRegion, frame) {
  if (!cropRegion || !frame) return null;
  const imageWidth = frame.width | 0;
  const imageHeight = frame.height | 0;
  if (imageWidth < 1 || imageHeight < 1) return null;
  const leftRaw = Number(cropRegion.left);
  const topRaw = Number(cropRegion.top);
  const widthRaw = Number(cropRegion.width);
  const heightRaw = Number(cropRegion.height);
  if (!Number.isFinite(leftRaw) || !Number.isFinite(topRaw) || !Number.isFinite(widthRaw) || !Number.isFinite(heightRaw)) {
    return null;
  }
  const clamp = (v, min, max) => (v < min ? min : (v > max ? max : v));
  const left = clamp(Math.floor(leftRaw), 0, imageWidth - 1);
  const top = clamp(Math.floor(topRaw), 0, imageHeight - 1);
  const maxWidth = imageWidth - left;
  const maxHeight = imageHeight - top;
  if (maxWidth < 1 || maxHeight < 1) return null;
  const width = clamp(Math.floor(widthRaw), 1, maxWidth);
  const height = clamp(Math.floor(heightRaw), 1, maxHeight);
  if (width < 1 || height < 1) return null;
  return { left, top, width, height };
}

export function copyRotatedRgbaBuffer(source, width, height, angle) {
  const normalized = normalizeAngleDegrees(angle);
  const rightAngle = Math.round(normalized / 90) * 90;
  const dstWidth = Math.abs(rightAngle) === 90 ? height : width;
  const dstHeight = Math.abs(rightAngle) === 90 ? width : height;
  const output = source instanceof Uint16Array
    ? new Uint16Array(source.length)
    : new Uint8ClampedArray(source.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let dstX;
      let dstY;
      if (rightAngle === 90) {
        dstX = height - 1 - y;
        dstY = x;
      } else if (rightAngle === -90) {
        dstX = y;
        dstY = width - 1 - x;
      } else {
        dstX = width - 1 - x;
        dstY = height - 1 - y;
      }

      const srcIdx = (y * width + x) * 4;
      const dstIdx = (dstY * dstWidth + dstX) * 4;
      output[dstIdx] = source[srcIdx];
      output[dstIdx + 1] = source[srcIdx + 1];
      output[dstIdx + 2] = source[srcIdx + 2];
      output[dstIdx + 3] = source[srcIdx + 3];
    }
  }

  return { width: dstWidth, height: dstHeight, data: output };
}

// The copies below serve only images whose 16-bit plane disagrees with the
// 8-bit view in size; every consistent image goes through the core.
function copyMirroredRgbaBuffer(source, width, height) {
  const output = source instanceof Uint16Array
    ? new Uint16Array(source.length)
    : new Uint8ClampedArray(source.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 4;
      const dstIdx = (y * width + (width - 1 - x)) * 4;
      output[dstIdx] = source[srcIdx];
      output[dstIdx + 1] = source[srcIdx + 1];
      output[dstIdx + 2] = source[srcIdx + 2];
      output[dstIdx + 3] = source[srcIdx + 3];
    }
  }

  return { width, height, data: output };
}

function attachTransformedImage16(target, sourceImageData, transform) {
  const source16 = sourceImageData?.__image16;
  if (!source16 || !(source16.data instanceof Uint16Array)) return target;
  target.__image16 = transform(source16.data, source16.width, source16.height);
  return target;
}

function hasExactImage16(imageData) {
  const plane = imageData?.__image16;
  return Boolean(plane && plane.data instanceof Uint16Array && plane.width === imageData.width
    && plane.height === imageData.height && plane.data.length === imageData.data?.length);
}

// ---------------------------------------------------------------------------
// The geometry core (#244). One plan describes base -> rotation -> mirror ->
// crop as a window of output rows; one row-range renderer builds any band of
// it from any source rectangle that contains the pixels the band reads. The
// synchronous exports below, the worker pool and its fallback all run it, so
// banded output is the whole output by construction.
// ---------------------------------------------------------------------------

/**
 * Plans the chain for `source`. Returns null when the core cannot build it
 * exactly: an 8-bit source at a non-right angle (the 2D canvas owns that
 * rotation) or a 16-bit plane whose size disagrees with the 8-bit view.
 *
 * `step` > 1 plans the chain followed by downsampleImageDataByStep(step):
 * output pixel (x, y) is window pixel (x * step, y * step), 8-bit alpha 255.
 *
 * The chain and restoreSettings have always ignored angles up to 0.001°;
 * applyRotationToImageData rotates from 0.001° on (`rotateAtThreshold`).
 *
 * @param {{width:number, height:number, data:ArrayLike<number>, __image16?:object}} source
 * @param {{rotationAngle?:number, mirrored?:boolean, cropRegion?:object|null}} geometry
 * @param {{sanitizeCrop?:Function, step?:number, rotateAtThreshold?:boolean}} [options]
 */
export function planGeometry(source, geometry = {}, { sanitizeCrop = sanitizeCropRect, step = 1, rotateAtThreshold = false } = {}) {
  if (!source) return null;
  const w = source.width | 0;
  const h = source.height | 0;
  if (w < 1 || h < 1) return null;
  const angle = normalizeAngleDegrees(Number(geometry?.rotationAngle) || 0);
  const mirrored = Boolean(geometry?.mirrored);
  const rotates = rotateAtThreshold ? Math.abs(angle) >= 0.001 : Math.abs(angle) > 0.001;
  const rightAngle = Math.round(angle / 90) * 90;
  const arbitrary = rotates && Math.abs(angle - rightAngle) >= 0.001;
  const plane = source.__image16;
  const hasPlane = Boolean(plane && plane.data instanceof Uint16Array);
  const has16 = hasExactImage16(source);
  if ((hasPlane && !has16) || (arbitrary && !has16)) return null;
  const frame = rotates ? rotatedDimensions(w, h, angle) : { width: w, height: h };
  const crop = geometry?.cropRegion ? sanitizeCrop(geometry.cropRegion, { width: frame.width, height: frame.height }) : null;
  const window = crop
    ? { left: crop.left, top: crop.top, width: crop.width, height: crop.height }
    : { left: 0, top: 0, width: frame.width, height: frame.height };
  const stride = Math.max(1, Math.floor(Number(step) || 1));
  const quarter = rotates && !arbitrary ? (rightAngle === -180 ? 180 : rightAngle) : 0;
  return {
    kind: arbitrary ? 'bilinear' : 'index',
    angle: arbitrary ? angle : 0,
    quarter,
    mirrored,
    baseWidth: w,
    baseHeight: h,
    frameWidth: frame.width,
    frameHeight: frame.height,
    window,
    cropped: Boolean(crop),
    step: stride,
    outWidth: stride > 1 ? Math.max(1, Math.floor(window.width / stride)) : window.width,
    outHeight: stride > 1 ? Math.max(1, Math.floor(window.height / stride)) : window.height,
    // cropImageDataRegion and the downsampler make the 8-bit copy opaque;
    // the 16-bit plane keeps the rotation's transparent corners.
    opaque8: Boolean(crop) || stride > 1,
    has16,
    rotates: arbitrary || quarter !== 0,
    identity: !rotates && !mirrored && !crop && stride === 1
  };
}

// Source position of output pixel (x, y): floats for bilinear plans.
function sourcePoint(plan, x, y) {
  const ry = plan.window.top + y * plan.step;
  const wx = plan.window.left + x * plan.step;
  const rx = plan.mirrored ? plan.frameWidth - 1 - wx : wx;
  if (plan.kind === 'bilinear') {
    const rad = plan.angle * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const u = rx + 0.5 - plan.frameWidth / 2;
    const v = ry + 0.5 - plan.frameHeight / 2;
    return [plan.baseWidth / 2 + u * cos + v * sin - 0.5, plan.baseHeight / 2 - u * sin + v * cos - 0.5];
  }
  switch (plan.quarter) {
    case 90: return [ry, plan.baseHeight - 1 - rx];
    case -90: return [plan.baseWidth - 1 - ry, rx];
    case 180: return [plan.baseWidth - 1 - rx, plan.baseHeight - 1 - ry];
    default: return [rx, ry];
  }
}

/**
 * The base rectangle output rows [y0, y1) read: the bounding box of the
 * source positions of the band's four corner pixels, padded by two pixels
 * for bilinear plans (one for the second tap, one for floating-point slack)
 * and clamped to the base. The map is affine, so the corners bound it.
 */
export function geometrySourceRect(plan, y0, y1) {
  const corners = [[0, y0], [plan.outWidth - 1, y0], [0, y1 - 1], [plan.outWidth - 1, y1 - 1]];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of corners) {
    const [sx, sy] = sourcePoint(plan, x, y);
    if (sx < minX) minX = sx;
    if (sx > maxX) maxX = sx;
    if (sy < minY) minY = sy;
    if (sy > maxY) maxY = sy;
  }
  const w = plan.baseWidth;
  const h = plan.baseHeight;
  const clamp = (v, max) => (v < 0 ? 0 : (v > max ? max : v));
  const bilinear = plan.kind === 'bilinear';
  const x0 = clamp(bilinear ? Math.floor(minX) - 2 : minX, w - 1);
  const x1 = clamp(bilinear ? Math.floor(maxX) + 3 : maxX, w - 1);
  const top = clamp(bilinear ? Math.floor(minY) - 2 : minY, h - 1);
  const bottom = clamp(bilinear ? Math.floor(maxY) + 3 : maxY, h - 1);
  return { x: x0, y: top, width: x1 - x0 + 1, height: bottom - top + 1 };
}

// Splits the output into at most `count` row bands, each with its source
// rectangle.
export function planGeometryBands(plan, count = 1, align = 1) {
  const bands = Math.max(1, Math.min(plan.outHeight, Math.floor(count) || 1));
  let rows = Math.ceil(plan.outHeight / bands);
  // Bands that start on multiples of `align` (#248: the display level's box
  // rows, built per band). Where a band ends does not change its pixels.
  if (align > 1) rows = Math.ceil(rows / align) * align;
  const result = [];
  for (let y0 = 0; y0 < plan.outHeight; y0 += rows) {
    const y1 = Math.min(plan.outHeight, y0 + rows);
    result.push({ y0, y1, rect: geometrySourceRect(plan, y0, y1) });
  }
  return result;
}

function copyRect(array, stride, rect, Type) {
  const rowLength = rect.width * 4;
  if (rect.x === 0 && rect.width === stride) {
    return array.slice(rect.y * stride * 4, (rect.y + rect.height) * stride * 4);
  }
  const out = new Type(rowLength * rect.height);
  for (let row = 0; row < rect.height; row++) {
    const start = ((rect.y + row) * stride + rect.x) * 4;
    out.set(array.subarray(start, start + rowLength), row * rowLength);
  }
  return out;
}

/**
 * Copies the pixels a band reads, row by row. Bilinear plans read only the
 * 16-bit plane; index plans copy both planes.
 */
export function sliceGeometrySource(source, plan, rect) {
  const data8 = plan.kind === 'index' ? copyRect(source.data, plan.baseWidth, rect, Uint8ClampedArray) : null;
  const data16 = plan.has16 ? copyRect(source.__image16.data, plan.baseWidth, rect, Uint16Array) : null;
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, data8, data16 };
}

// Bilinear inverse map of translate(newW/2, newH/2) -> rotate(rad) ->
// drawImage(src, -w/2, -h/2), the canvas transform of the 8-bit path, read
// from the 16-bit plane; the 8-bit view is derived from the 16-bit result.
function renderBilinearRows(plan, src, out, y0, y1) {
  const w = plan.baseWidth;
  const h = plan.baseHeight;
  const rad = plan.angle * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const halfW = w / 2;
  const halfH = h / 2;
  const frameW = plan.frameWidth;
  const frameH = plan.frameHeight;
  const left = plan.window.left;
  const top = plan.window.top;
  const step = plan.step;
  const outW = plan.outWidth;
  const mirrored = plan.mirrored;
  const opaque = plan.opaque8;
  const data = src.data16;
  const ox = src.x;
  const oy = src.y;
  const sw = src.width;
  const out16 = out.data16;
  const out8 = out.data8;
  const halfFrameW = frameW / 2;
  const halfFrameH = frameH / 2;
  const lastColumn = frameW - 1;
  for (let y = y0; y < y1; y++) {
    const ry = top + y * step;
    const v = ry + 0.5 - halfFrameH;
    // Same products and the same order of additions as per pixel: exact.
    const vSin = v * sin;
    const vCos = v * cos;
    let outIdx = (y - y0) * outW * 4;
    let wx = left;
    for (let x = 0; x < outW; x++, outIdx += 4, wx += step) {
      // Mirror flips the rotated frame before the crop is taken.
      const rx = mirrored ? lastColumn - wx : wx;
      const u = rx + 0.5 - halfFrameW;
      // Source pixel-centre coordinates, shifted to array indices.
      const sx = halfW + u * cos + vSin - 0.5;
      const sy = halfH - u * sin + vCos - 0.5;
      if (opaque) out8[outIdx + 3] = 255;
      if (sx < -0.5 || sy < -0.5 || sx > w - 0.5 || sy > h - 0.5) {
        continue; // outside the source: transparent, as the canvas path leaves it
      }
      const x0 = Math.max(0, Math.min(w - 1, Math.floor(sx)));
      const ys0 = Math.max(0, Math.min(h - 1, Math.floor(sy)));
      const x1 = Math.min(w - 1, x0 + 1);
      const ys1 = Math.min(h - 1, ys0 + 1);
      const fx = Math.max(0, Math.min(1, sx - x0));
      const fy = Math.max(0, Math.min(1, sy - ys0));
      const row0 = (ys0 - oy) * sw - ox;
      const row1 = (ys1 - oy) * sw - ox;
      const i00 = (row0 + x0) * 4;
      const i10 = (row0 + x1) * 4;
      const i01 = (row1 + x0) * 4;
      const i11 = (row1 + x1) * 4;
      for (let c = 0; c < 3; c++) {
        const upper = data[i00 + c] + (data[i10 + c] - data[i00 + c]) * fx;
        const lower = data[i01 + c] + (data[i11 + c] - data[i01 + c]) * fx;
        const value = Math.round(upper + (lower - upper) * fy);
        const clamped = value < 0 ? 0 : (value > 65535 ? 65535 : value);
        out16[outIdx + c] = clamped;
        out8[outIdx + c] = clamped >>> 8;
      }
      out16[outIdx + 3] = 65535;
      out8[outIdx + 3] = 255;
    }
  }
}

function wordView(array) {
  if (!array || array.byteOffset % 4 !== 0 || array.byteLength % 4 !== 0) return null;
  return new Uint32Array(array.buffer, array.byteOffset, array.byteLength >>> 2);
}

// Right angles, mirror and crop are pure index maps. Pixels move as whole
// words: one per 8-bit pixel, two per 16-bit pixel. Never Float64Array: a
// 16-bit RGBA pixel with alpha 0xFFFF is a NaN bit pattern that an engine
// may canonicalise.
function renderIndexRows(plan, src, out, y0, y1) {
  if (plan.quarter === 0 && !plan.mirrored && plan.step === 1) {
    renderCopyRows(plan, src, out, y0, y1);
    return;
  }
  const in8 = wordView(src.data8);
  const out8 = wordView(out.data8);
  const in16 = plan.has16 ? wordView(src.data16) : null;
  const out16 = plan.has16 ? wordView(out.data16) : null;
  if (!in8 || !out8 || (plan.has16 && (!in16 || !out16))) {
    renderIndexRowsScalar(plan, src, out, y0, y1);
    return;
  }
  const w = plan.baseWidth;
  const h = plan.baseHeight;
  const frameW = plan.frameWidth;
  const left = plan.window.left;
  const top = plan.window.top;
  const step = plan.step;
  const outW = plan.outWidth;
  const quarter = plan.quarter;
  const mirrored = plan.mirrored;
  const opaque = plan.opaque8;
  const ox = src.x;
  const oy = src.y;
  const sw = src.width;
  for (let y = y0; y < y1; y++) {
    const ry = top + y * step;
    let di = (y - y0) * outW;
    for (let x = 0; x < outW; x++, di++) {
      const wx = left + x * step;
      const rx = mirrored ? frameW - 1 - wx : wx;
      let sx;
      let sy;
      if (quarter === 90) { sx = ry; sy = h - 1 - rx; }
      else if (quarter === -90) { sx = w - 1 - ry; sy = rx; }
      else if (quarter === 180) { sx = w - 1 - rx; sy = h - 1 - ry; }
      else { sx = rx; sy = ry; }
      const si = (sy - oy) * sw + (sx - ox);
      out8[di] = opaque ? (in8[si] | OPAQUE_ALPHA_WORD) : in8[si];
      if (in16) {
        out16[di * 2] = in16[si * 2];
        out16[di * 2 + 1] = in16[si * 2 + 1];
      }
    }
  }
}

// Crop only: whole rows, as cropImageDataRegion copies them.
function renderCopyRows(plan, src, out, y0, y1) {
  const rowLength = plan.outWidth * 4;
  const out32 = plan.opaque8 ? wordView(out.data8) : null;
  for (let y = y0; y < y1; y++) {
    const start = ((plan.window.top + y - src.y) * src.width + (plan.window.left - src.x)) * 4;
    const dst = (y - y0) * rowLength;
    out.data8.set(src.data8.subarray(start, start + rowLength), dst);
    if (plan.has16) out.data16.set(src.data16.subarray(start, start + rowLength), dst);
    if (!plan.opaque8) continue;
    if (out32) {
      for (let i = dst >>> 2, end = (dst + rowLength) >>> 2; i < end; i++) out32[i] |= OPAQUE_ALPHA_WORD;
    } else {
      for (let alpha = dst + 3; alpha < dst + rowLength; alpha += 4) out.data8[alpha] = 255;
    }
  }
}

function renderIndexRowsScalar(plan, src, out, y0, y1) {
  const w = plan.baseWidth;
  const h = plan.baseHeight;
  const outW = plan.outWidth;
  for (let y = y0; y < y1; y++) {
    const ry = plan.window.top + y * plan.step;
    for (let x = 0; x < outW; x++) {
      const wx = plan.window.left + x * plan.step;
      const rx = plan.mirrored ? plan.frameWidth - 1 - wx : wx;
      let sx;
      let sy;
      if (plan.quarter === 90) { sx = ry; sy = h - 1 - rx; }
      else if (plan.quarter === -90) { sx = w - 1 - ry; sy = rx; }
      else if (plan.quarter === 180) { sx = w - 1 - rx; sy = h - 1 - ry; }
      else { sx = rx; sy = ry; }
      const si = ((sy - src.y) * src.width + (sx - src.x)) * 4;
      const di = ((y - y0) * outW + x) * 4;
      for (let c = 0; c < 4; c++) {
        out.data8[di + c] = src.data8[si + c];
        if (plan.has16) out.data16[di + c] = src.data16[si + c];
      }
      if (plan.opaque8) out.data8[di + 3] = 255;
    }
  }
}

/**
 * Renders output rows [y0, y1) of `plan` into `out.data8` / `out.data16`,
 * whose first row is output row y0. `src` holds the base pixels of the
 * rectangle (src.x, src.y, src.width, src.height), which must contain every
 * pixel the rows read (geometrySourceRect).
 */
export function renderGeometryRows(plan, src, out, y0 = 0, y1 = plan.outHeight) {
  if (plan.kind === 'bilinear') renderBilinearRows(plan, src, out, y0, y1);
  else renderIndexRows(plan, src, out, y0, y1);
}

// Rows per band when the 16-bit output is rendered into a scratch buffer and
// dropped (renderGeometry's `with16: false`).
const SCRATCH16_ROWS = 64;

// Builds the whole output of `plan` on this thread. `with16: false` returns
// the 8-bit view only: the kernels still compute the 16-bit samples (the
// 8-bit bytes derive from them), band by band into one reused scratch buffer,
// so the 8-bit bytes are the same and no 16-bit plane is allocated.
export function renderGeometry(source, plan, { with16 = true } = {}) {
  if (plan.identity) return source;
  const out8 = new Uint8ClampedArray(plan.outWidth * plan.outHeight * 4);
  const src = {
    x: 0, y: 0, width: plan.baseWidth, height: plan.baseHeight,
    data8: source.data, data16: plan.has16 ? source.__image16.data : null
  };
  if (plan.has16 && !with16) {
    const rowLength = plan.outWidth * 4;
    const scratch = new Uint16Array(Math.min(plan.outHeight, SCRATCH16_ROWS) * rowLength);
    for (let y0 = 0; y0 < plan.outHeight; y0 += SCRATCH16_ROWS) {
      const y1 = Math.min(plan.outHeight, y0 + SCRATCH16_ROWS);
      renderGeometryRows(plan, src, { data8: out8.subarray(y0 * rowLength, y1 * rowLength), data16: scratch }, y0, y1);
    }
    if (plan.step === 1) {
      if (plan.rotates) geometryCounters.rotations++;
      else geometryCounters.copies++;
    }
    return new ImageData(out8, plan.outWidth, plan.outHeight);
  }
  const out16 = plan.has16 ? new Uint16Array(out8.length) : null;
  renderGeometryRows(plan, src, { data8: out8, data16: out16 }, 0, plan.outHeight);
  if (plan.step === 1) {
    if (plan.rotates) geometryCounters.rotations++;
    else geometryCounters.copies++;
  }
  return wrapGeometryOutput(plan, out8, out16);
}

export function wrapGeometryOutput(plan, out8, out16) {
  const result = new ImageData(out8, plan.outWidth, plan.outHeight);
  if (out16) result.__image16 = { width: plan.outWidth, height: plan.outHeight, data: out16 };
  return result;
}

export function rotateImageDataRightAngle(imageData, angle) {
  const plan = planGeometry(imageData, { rotationAngle: angle }, { rotateAtThreshold: true });
  if (plan && plan.kind === 'index' && plan.quarter !== 0) return renderGeometry(imageData, plan);
  const rotated = copyRotatedRgbaBuffer(imageData.data, imageData.width, imageData.height, angle);
  const result = new ImageData(rotated.data, rotated.width, rotated.height);
  return attachTransformedImage16(result, imageData, (data, width, height) => {
    const image16 = copyRotatedRgbaBuffer(data, width, height, angle);
    return { width: image16.width, height: image16.height, data: image16.data };
  });
}

export function mirrorImageDataHorizontal(imageData) {
  const plan = planGeometry(imageData, { mirrored: true });
  if (plan) return renderGeometry(imageData, plan);
  const mirrored = copyMirroredRgbaBuffer(imageData.data, imageData.width, imageData.height);
  const result = new ImageData(mirrored.data, mirrored.width, mirrored.height);
  return attachTransformedImage16(result, imageData, (data, width, height) => {
    const image16 = copyMirroredRgbaBuffer(data, width, height);
    return { width: image16.width, height: image16.height, data: image16.data };
  });
}

export function applyRotationToImageData(imageData, angle) {
  if (!imageData) return null;
  const normalized = normalizeAngleDegrees(Number(angle) || 0);
  if (Math.abs(normalized) < 0.001) return imageData;
  const rightAngle = Math.round(normalized / 90) * 90;
  if (Math.abs(normalized - rightAngle) < 0.001 && Math.abs(rightAngle) % 90 === 0) {
    return rotateImageDataRightAngle(imageData, rightAngle);
  }

  // A 2D canvas is 8-bit only, so straightening a RAW or 16-bit scan by a
  // non-right angle (which is what auto-frame does on nearly every frame)
  // used to throw the 16-bit plane away. Resample both planes in the core
  // when the source carries one, and derive the 8-bit view from the 16-bit
  // result so the two stay exactly consistent.
  const plan = planGeometry(imageData, { rotationAngle: normalized }, { rotateAtThreshold: true });
  if (plan) return renderGeometry(imageData, plan);

  const rad = normalized * Math.PI / 180;
  const w = imageData.width;
  const h = imageData.height;
  const { width: newW, height: newH } = rotatedDimensions(w, h, normalized);
  const srcCanvas = createImageCanvas();
  srcCanvas.width = w;
  srcCanvas.height = h;
  const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
  srcCtx.putImageData(imageData, 0, 0);

  const dstCanvas = createImageCanvas();
  dstCanvas.width = newW;
  dstCanvas.height = newH;
  const dstCtx = dstCanvas.getContext('2d', { willReadFrequently: true });
  dstCtx.translate(newW / 2, newH / 2);
  dstCtx.rotate(rad);
  dstCtx.drawImage(srcCanvas, -w / 2, -h / 2);

  geometryCounters.rotations++;
  return dstCtx.getImageData(0, 0, newW, newH);
}

/**
 * The export geometry chain (base -> rotation -> mirror -> crop) in one pass
 * that only builds the output window.
 *
 * A batch export used to rotate the whole 24 MP scan on the main thread and
 * then keep a 5 MP frame of it: ~0.8 s of blocking per file for pixels that
 * were thrown away. The core computes the same samples as the step chain
 * (bit-identical) for every case it plans; only 8-bit sources at a non-right
 * angle (the canvas rotation) and inconsistent planes still run the steps.
 *
 * @param {ImageData} imageData base image (with optional __image16 plane)
 * @param {{rotationAngle?: number, mirrored?: boolean, cropRegion?: {left:number, top:number, width:number, height:number}|null}} geometry
 * @param {{rotate: Function, mirror: Function, crop: Function}} steps the
 *   step-by-step implementations used for the fallback (kept injectable so the
 *   caller's crop sanitisation applies)
 */
export function applyGeometryChainToImageData(imageData, geometry, steps) {
  const plan = planGeometry(imageData, geometry, { sanitizeCrop: (crop, frame) => steps.crop(null, crop, frame) });
  if (plan) return renderGeometry(imageData, plan);
  const angle = normalizeAngleDegrees(Number(geometry?.rotationAngle) || 0);
  let working = imageData;
  if (Math.abs(angle) > 0.001) working = steps.rotate(working, angle);
  if (geometry?.mirrored) working = steps.mirror(working);
  if (geometry?.cropRegion) working = steps.crop(working, geometry.cropRegion);
  return working;
}

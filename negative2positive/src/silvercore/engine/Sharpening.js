/**
 * Sharpening.js - Unsharp Mask sharpening
 * Separable Gaussian blur + unsharp mask for post-processing.
 * Performance target: 4000x6000 < 500ms via separable kernel.
 */

// Gaussian kernel cache (Phase 7) - keyed by radius*10 (0.1 precision)
const _kernelCache = new Map()

/**
 * Build 1D Gaussian kernel for given radius (cached).
 * @param {number} radius - Blur radius (0.5-3.0)
 * @returns {Float32Array} Normalized kernel
 */
function buildGaussianKernel(radius) {
  const cacheKey = Math.round(radius * 10);
  const cached = _kernelCache.get(cacheKey);
  if (cached) return cached;

  const sigma = radius;
  const size = Math.ceil(sigma * 3) * 2 + 1;
  const kernel = new Float32Array(size);
  const center = (size - 1) / 2;
  let sum = 0;

  for (let i = 0; i < size; i++) {
    const x = i - center;
    kernel[i] = Math.exp(-(x * x) / (2 * sigma * sigma));
    sum += kernel[i];
  }

  for (let i = 0; i < size; i++) {
    kernel[i] /= sum;
  }

  _kernelCache.set(cacheKey, kernel);
  return kernel;
}

// Keep only the horizontally blurred rows needed by the current vertical
// window. A row is read before it can be sharpened, so processing in place is
// safe. Float32 rounding at both blur passes matches the original full planes.
//
// `band` (#256): `data` holds frame rows [band.y0, band.y1) of a frame `height`
// rows high, and `band.rowAt(y)` gives the unsharpened samples of the rows just
// outside it ({ array, offset }), up to the kernel's half-width and clamped at
// the frame's edges, never at the band's. Its rows come out exactly as the
// same rows of the whole frame.
function sharpenRows(data, width, height, kernel, amount, threshold, band = null) {
  const kLen = kernel.length;
  const halfK = (kLen - 1) / 2;
  const y0 = band ? band.y0 : 0;
  const y1 = band ? band.y1 : height;
  const rowCount = Math.min(height, kLen);
  const rows = new Float32Array(rowCount * width);
  const rowIds = new Int32Array(rowCount).fill(-1);
  const offsets = new Int32Array(kLen);
  const luminance = new Float32Array(width);

  function prepareRow(y) {
    const slot = y % rowCount;
    const offset = slot * width;
    if (rowIds[slot] === y) return offset;
    let src = data;
    let source = (y - y0) * width * 4;
    if (y < y0 || y >= y1) {
      const halo = band.rowAt(y);
      src = halo.array;
      source = halo.offset;
    }
    for (let x = 0; x < width; x++) {
      const i = source + x * 4;
      luminance[x] = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
    }
    for (let x = 0; x < width; x++) {
      let sum = 0;
      if (x >= halfK && x < width - halfK) {
        for (let k = 0; k < kLen; k++) sum += luminance[x + k - halfK] * kernel[k];
      } else {
        for (let k = 0; k < kLen; k++) {
          const sx = Math.max(0, Math.min(width - 1, x + k - halfK));
          sum += luminance[sx] * kernel[k];
        }
      }
      rows[offset + x] = sum;
    }
    rowIds[slot] = y;
    return offset;
  }

  for (let y = y0; y < y1; y++) {
    for (let k = 0; k < kLen; k++) {
      offsets[k] = prepareRow(Math.max(0, Math.min(height - 1, y + k - halfK)));
    }
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = 0; k < kLen; k++) sum += rows[offsets[k] + x] * kernel[k];
      const i = ((y - y0) * width + x) * 4;
      const original = Math.fround(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
      const diff = original - Math.fround(sum);
      if (Math.abs(diff) < threshold) continue;
      const sharpen = amount * diff;
      data[i] = Math.max(0, Math.min(PIXEL_MAX, data[i] + sharpen + 0.5)) | 0;
      data[i + 1] = Math.max(0, Math.min(PIXEL_MAX, data[i + 1] + sharpen + 0.5)) | 0;
      data[i + 2] = Math.max(0, Math.min(PIXEL_MAX, data[i + 2] + sharpen + 0.5)) | 0;
    }
  }
}

const PIXEL_MAX = 65535;
// Threshold UI is 0-255 (8-bit perceptual scale). Internally we operate on
// 16-bit luminance, so multiply by 257 to match the same perceptual cutoff.
const THRESHOLD_8_TO_16 = 257;

/**
 * Apply Unsharp Mask sharpening to image data.
 * @param {Image16} imageData - 16-bit RGBA, modified in place
 * @param {Object} params - { amount: 0-200, radius: 0.5-3.0, threshold: 0-255 }
 * @returns {Image16}
 */
export function applyUnsharpMask(imageData, params = {}) {
  const amount = (params.amount ?? 0) / 100;
  const radius = params.radius ?? 1.0;
  const threshold = (params.threshold ?? 0) * THRESHOLD_8_TO_16;

  if (amount <= 0 || radius < 0.1) return imageData;

  const { data, width, height } = imageData;
  if (width < 1 || height < 1) return imageData;
  const kernel = buildGaussianKernel(radius);
  sharpenRows(data, width, height, kernel, amount, threshold);

  return imageData;
}

/**
 * Rows of unsharpened neighbours a row band needs on each side (the kernel's
 * half-width), or 0 when these parameters do not sharpen (#256).
 * @param {Object} params - as applyUnsharpMask
 */
export function unsharpMaskHaloRows(params = {}) {
  const amount = (params.amount ?? 0) / 100;
  const radius = params.radius ?? 1.0;
  if (amount <= 0 || radius < 0.1) return 0;
  return (buildGaussianKernel(radius).length - 1) / 2;
}

/**
 * applyUnsharpMask on a row band of a frame (#256): `band` holds frame rows
 * [startRow, startRow + band.height) of a frame `frameHeight` rows high, in
 * place. `above` and `below` hold the unsharpened rows just outside the band
 * (unsharpMaskHaloRows of them, fewer at the frame's edges): the frame rows
 * [max(0, startRow - halo), startRow) and [end, min(frameHeight, end + halo)).
 * The band's rows come out exactly as applyUnsharpMask makes them in the frame.
 * @param {Image16} band - modified in place
 */
export function applyUnsharpMaskBand(band, params = {}, { startRow, frameHeight, above = null, below = null }) {
  const amount = (params.amount ?? 0) / 100;
  const radius = params.radius ?? 1.0;
  const threshold = (params.threshold ?? 0) * THRESHOLD_8_TO_16;
  if (amount <= 0 || radius < 0.1) return band;
  const { data, width, height } = band;
  if (width < 1 || height < 1) return band;
  const kernel = buildGaussianKernel(radius);
  const y0 = startRow;
  const y1 = startRow + height;
  const halo = (kernel.length - 1) / 2;
  const aboveStart = Math.max(0, y0 - halo);
  const rowWords = width * 4;
  sharpenRows(data, width, frameHeight, kernel, amount, threshold, {
    y0,
    y1,
    rowAt: (y) => (y < y0
      ? { array: above, offset: (y - aboveStart) * rowWords }
      : { array: below, offset: (y - y1) * rowWords })
  });
  return band;
}

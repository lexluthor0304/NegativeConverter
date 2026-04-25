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

/**
 * Separable Gaussian blur (horizontal + vertical passes).
 * Split into boundary/interior regions to eliminate clamp in inner loop (Phase 5).
 * @param {Float32Array} channel - Input channel data
 * @param {number} width
 * @param {number} height
 * @param {Float32Array} kernel - 1D Gaussian kernel
 * @returns {Float32Array} Blurred channel
 */
function separableBlur(channel, width, height, kernel) {
  const kLen = kernel.length;
  const halfK = (kLen - 1) / 2;
  const temp = new Float32Array(width * height);
  const output = new Float32Array(width * height);

  // Horizontal pass - split into left boundary / interior / right boundary
  const hInnerStart = halfK;
  const hInnerEnd = width - halfK;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;

    // Left boundary [0, halfK) - needs clamping
    for (let x = 0; x < hInnerStart && x < width; x++) {
      let sum = 0;
      for (let k = 0; k < kLen; k++) {
        const sx = x + k - halfK;
        sum += channel[rowOffset + (sx < 0 ? 0 : sx)] * kernel[k];
      }
      temp[rowOffset + x] = sum;
    }

    // Interior [halfK, width-halfK) - no clamping needed
    for (let x = hInnerStart; x < hInnerEnd; x++) {
      let sum = 0;
      const baseIdx = rowOffset + x - halfK;
      for (let k = 0; k < kLen; k++) {
        sum += channel[baseIdx + k] * kernel[k];
      }
      temp[rowOffset + x] = sum;
    }

    // Right boundary [width-halfK, width) - needs clamping
    for (let x = Math.max(hInnerEnd, hInnerStart); x < width; x++) {
      let sum = 0;
      for (let k = 0; k < kLen; k++) {
        const sx = x + k - halfK;
        sum += channel[rowOffset + (sx >= width ? width - 1 : sx)] * kernel[k];
      }
      temp[rowOffset + x] = sum;
    }
  }

  // Vertical pass - split into top boundary / interior / bottom boundary
  // Process in blocks of 64 columns for better cache locality
  const BLOCK = 64;
  const vInnerStart = halfK;
  const vInnerEnd = height - halfK;

  for (let xBlock = 0; xBlock < width; xBlock += BLOCK) {
    const xEnd = Math.min(xBlock + BLOCK, width);

    // Top boundary [0, halfK) - needs clamping
    for (let y = 0; y < vInnerStart && y < height; y++) {
      for (let x = xBlock; x < xEnd; x++) {
        let sum = 0;
        for (let k = 0; k < kLen; k++) {
          const sy = y + k - halfK;
          sum += temp[(sy < 0 ? 0 : sy) * width + x] * kernel[k];
        }
        output[y * width + x] = sum;
      }
    }

    // Interior [halfK, height-halfK) - no clamping needed
    for (let y = vInnerStart; y < vInnerEnd; y++) {
      const baseY = y - halfK;
      for (let x = xBlock; x < xEnd; x++) {
        let sum = 0;
        for (let k = 0; k < kLen; k++) {
          sum += temp[(baseY + k) * width + x] * kernel[k];
        }
        output[y * width + x] = sum;
      }
    }

    // Bottom boundary [height-halfK, height) - needs clamping
    for (let y = Math.max(vInnerEnd, vInnerStart); y < height; y++) {
      for (let x = xBlock; x < xEnd; x++) {
        let sum = 0;
        for (let k = 0; k < kLen; k++) {
          const sy = y + k - halfK;
          sum += temp[(sy >= height ? height - 1 : sy) * width + x] * kernel[k];
        }
        output[y * width + x] = sum;
      }
    }
  }

  return output;
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
  const pixelCount = width * height;

  // Extract luminance channel
  const lum = new Float32Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const idx = i * 4;
    lum[i] = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
  }

  // Blur luminance
  const kernel = buildGaussianKernel(radius);
  const blurred = separableBlur(lum, width, height, kernel);

  // Apply unsharp mask per channel
  for (let i = 0; i < pixelCount; i++) {
    const diff = lum[i] - blurred[i];
    if (Math.abs(diff) < threshold) continue;

    const idx = i * 4;
    const sharpen = amount * diff;
    data[idx] = Math.max(0, Math.min(PIXEL_MAX, data[idx] + sharpen + 0.5)) | 0;
    data[idx + 1] = Math.max(0, Math.min(PIXEL_MAX, data[idx + 1] + sharpen + 0.5)) | 0;
    data[idx + 2] = Math.max(0, Math.min(PIXEL_MAX, data[idx + 2] + sharpen + 0.5)) | 0;
  }

  return imageData;
}

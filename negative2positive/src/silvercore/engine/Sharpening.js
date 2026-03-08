/**
 * Sharpening.js - Unsharp Mask sharpening
 * Separable Gaussian blur + unsharp mask for post-processing.
 * Performance target: 4000x6000 < 500ms via separable kernel.
 */

/**
 * Build 1D Gaussian kernel for given radius.
 * @param {number} radius - Blur radius (0.5-3.0)
 * @returns {Float32Array} Normalized kernel
 */
function buildGaussianKernel(radius) {
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

  return kernel;
}

/**
 * Separable Gaussian blur (horizontal + vertical passes).
 * Operates on a single-channel Float32Array.
 * @param {Float32Array} channel - Input channel data
 * @param {number} width
 * @param {number} height
 * @param {Float32Array} kernel - 1D Gaussian kernel
 * @returns {Float32Array} Blurred channel
 */
function separableBlur(channel, width, height, kernel) {
  const halfK = (kernel.length - 1) / 2;
  const temp = new Float32Array(width * height);
  const output = new Float32Array(width * height);

  // Horizontal pass
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = 0; k < kernel.length; k++) {
        const sx = Math.min(Math.max(x + k - halfK, 0), width - 1);
        sum += channel[rowOffset + sx] * kernel[k];
      }
      temp[rowOffset + x] = sum;
    }
  }

  // Vertical pass
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let sum = 0;
      for (let k = 0; k < kernel.length; k++) {
        const sy = Math.min(Math.max(y + k - halfK, 0), height - 1);
        sum += temp[sy * width + x] * kernel[k];
      }
      output[y * width + x] = sum;
    }
  }

  return output;
}

/**
 * Apply Unsharp Mask sharpening to image data.
 * @param {ImageData} imageData - Will be modified in place
 * @param {Object} params - { amount: 0-200, radius: 0.5-3.0, threshold: 0-255 }
 * @returns {ImageData}
 */
export function applyUnsharpMask(imageData, params = {}) {
  const amount = (params.amount ?? 0) / 100;
  const radius = params.radius ?? 1.0;
  const threshold = params.threshold ?? 0;

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
    data[idx] = Math.max(0, Math.min(255, data[idx] + sharpen + 0.5)) | 0;
    data[idx + 1] = Math.max(0, Math.min(255, data[idx + 1] + sharpen + 0.5)) | 0;
    data[idx + 2] = Math.max(0, Math.min(255, data[idx + 2] + sharpen + 0.5)) | 0;
  }

  return imageData;
}

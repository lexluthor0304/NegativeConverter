/**
 * ImageProcessor.js - Canvas-based image processing pipeline
 * Replaces ImageMagick commands from NLPImageProcessor.lua
 */

/**
 * Analyze image to extract per-channel histogram data.
 * Returns black/white/mean points per channel (equivalent to NLP's PPM analysis).
 *
 * @param {ImageData} imageData - Source image (negative)
 * @param {Object} params - { borderBuffer, colorModel }
 * @returns {Object[]} [rChannel, gChannel, bChannel] each with whitePointOrigin, blackPointOrigin, meanPoint
 */
export function analyzeImage(imageData, params) {
  const { data, width, height } = imageData;
  const borderPct = (params.borderBuffer || 10) / 100;

  // Crop region (center crop excluding film border)
  const cropX = Math.round(width * borderPct);
  const cropY = Math.round(height * borderPct);
  const cropW = width - 2 * cropX;
  const cropH = height - 2 * cropY;

  // Build per-channel histograms from cropped region
  const rHist = new Uint32Array(256);
  const gHist = new Uint32Array(256);
  const bHist = new Uint32Array(256);
  let totalPixels = 0;

  for (let y = cropY; y < cropY + cropH; y++) {
    for (let x = cropX; x < cropX + cropW; x++) {
      const i = (y * width + x) * 4;
      rHist[data[i]]++;
      gHist[data[i + 1]]++;
      bHist[data[i + 2]]++;
      totalPixels++;
    }
  }

  // Thresholds per color model
  const blackThreshold = 0.002;
  const whiteThreshold = 0.002;

  return [
    computeChannelLevels(rHist, totalPixels, blackThreshold, whiteThreshold, 'ToneCurvePV2012Red'),
    computeChannelLevels(gHist, totalPixels, blackThreshold, whiteThreshold, 'ToneCurvePV2012Green'),
    computeChannelLevels(bHist, totalPixels, blackThreshold, whiteThreshold, 'ToneCurvePV2012Blue'),
  ];
}

/**
 * Compute black point, white point, and mean for a single channel histogram.
 * Names are swapped because we're analyzing a negative:
 * - whitePointOrigin = dark end of negative = white point of positive
 * - blackPointOrigin = bright end of negative = black point of positive
 */
function computeChannelLevels(hist, totalPixels, blackThreshold, whiteThreshold, settingName) {
  // Find white point origin (scan from dark end)
  let cumulative = 0;
  let whitePointOrigin = 0;
  for (let i = 0; i < 256; i++) {
    cumulative += hist[i] / totalPixels;
    if (cumulative > whiteThreshold) {
      whitePointOrigin = Math.max(i - 1, 0);
      break;
    }
  }

  // Find black point origin (scan from bright end)
  cumulative = 0;
  let blackPointOrigin = 255;
  for (let i = 255; i >= 0; i--) {
    cumulative += hist[i] / totalPixels;
    if (cumulative > blackThreshold) {
      blackPointOrigin = Math.min(i + 1, 255);
      break;
    }
  }

  // Compute mean point (weighted average within adjusted range)
  const expandFactor = 0.005;
  const contractFactor = 0.005;
  const adjBlack = Math.round(whitePointOrigin * (1 + expandFactor));
  const adjWhite = Math.round(blackPointOrigin * (1 - contractFactor));
  const adjRange = adjWhite - adjBlack;
  const adjScale = adjRange > 0 ? 256 / adjRange : 1;

  let weightedSum = 0;
  for (let i = adjBlack; i <= adjWhite; i++) {
    const normalizedPosition = (i - adjBlack) * adjScale;
    weightedSum += hist[i] * normalizedPosition;
  }

  let meanPoint = totalPixels > 0 ? weightedSum / totalPixels / 256 : 0.5;
  meanPoint = 1 - meanPoint; // Invert because this is a negative

  return { whitePointOrigin, blackPointOrigin, meanPoint, settingName };
}

/**
 * Apply tone curve LUTs to image data.
 * @param {ImageData} imageData - Source (will be modified in place)
 * @param {Uint8Array} rLUT - Red channel LUT (256 entries)
 * @param {Uint8Array} gLUT - Green channel LUT
 * @param {Uint8Array} bLUT - Blue channel LUT
 * @returns {ImageData} Modified imageData
 */
export function applyLUT(imageData, rLUT, gLUT, bLUT) {
  const { data } = imageData;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rLUT[data[i]];
    data[i + 1] = gLUT[data[i + 1]];
    data[i + 2] = bLUT[data[i + 2]];
    // Alpha unchanged
  }
  return imageData;
}

/**
 * Simple box blur for pre-processing (replaces ImageMagick -blur 0x1).
 * @param {ImageData} imageData
 * @param {number} radius
 * @returns {ImageData}
 */
export function boxBlur(imageData, radius = 1) {
  const { data, width, height } = imageData;
  const output = new Uint8ClampedArray(data.length);
  const size = radius * 2 + 1;
  const area = size * size;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let rSum = 0, gSum = 0, bSum = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const sx = Math.min(Math.max(x + dx, 0), width - 1);
          const sy = Math.min(Math.max(y + dy, 0), height - 1);
          const si = (sy * width + sx) * 4;
          rSum += data[si];
          gSum += data[si + 1];
          bSum += data[si + 2];
        }
      }
      const di = (y * width + x) * 4;
      output[di] = rSum / area;
      output[di + 1] = gSum / area;
      output[di + 2] = bSum / area;
      output[di + 3] = data[di + 3];
    }
  }

  imageData.data.set(output);
  return imageData;
}

/**
 * Negate image (invert pixel values). Simple negative-to-positive.
 */
export function negateImage(imageData) {
  const { data } = imageData;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255 - data[i];
    data[i + 1] = 255 - data[i + 1];
    data[i + 2] = 255 - data[i + 2];
  }
  return imageData;
}

/**
 * Adjust saturation of image.
 * @param {ImageData} imageData
 * @param {number} amount - 0=grayscale, 100=unchanged, 200=max saturation
 */
export function adjustSaturation(imageData, amount) {
  if (amount === 100) return imageData;
  const factor = amount / 100;
  const { data } = imageData;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    data[i] = Math.max(0, Math.min(255, lum + factor * (r - lum)));
    data[i + 1] = Math.max(0, Math.min(255, lum + factor * (g - lum)));
    data[i + 2] = Math.max(0, Math.min(255, lum + factor * (b - lum)));
  }
  return imageData;
}

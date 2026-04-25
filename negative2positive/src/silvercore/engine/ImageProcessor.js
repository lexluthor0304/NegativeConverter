/**
 * ImageProcessor.js - Canvas-based image processing pipeline
 *
 * 16-bit pipeline: All functions operate on Image16 ({ width, height, data: Uint16Array }
 * RGBA, range [0, 65535]). Histograms remain 256-bin via `>> 8` indexing (cheap, accurate
 * enough for auto black/white point detection). Channel point ranges are reported in
 * the 16-bit domain so curve generators can index a 65536-entry LUT directly.
 */

import { colorModels } from './Presets.js'

const MAX_16 = 65535;
const HIST_BINS = 256;
const HIST_MAX = HIST_BINS - 1;
// Multiplier converting 8-bit histogram bin index → 16-bit pixel value.
// 65535 / 255 = 257, so bin k corresponds to pixel value k * 257.
const BIN_TO_16 = 257;

/**
 * Analyze image to extract per-channel histogram data.
 * Returns black/white/mean points per channel via histogram analysis.
 *
 * @param {Image16} imageData - Source image, 16-bit RGBA
 * @param {Object} params - { borderBuffer, colorModel }
 * @returns {Object[]} per-channel { whitePointOrigin, blackPointOrigin, meanPoint } in [0, 65535]
 */
export function analyzeImage(imageData, params) {
  const { data, width, height } = imageData;
  const borderPct = (params.borderBuffer || 10) / 100;

  // Crop region (center crop excluding film border)
  const cropX = Math.round(width * borderPct);
  const cropY = Math.round(height * borderPct);
  const cropW = width - 2 * cropX;
  const cropH = height - 2 * cropY;

  // Build per-channel 256-bin histograms from cropped region (>>8 indexing keeps cost
  // identical to the 8-bit version while operating on 16-bit pixels).
  const rHist = new Uint32Array(HIST_BINS);
  const gHist = new Uint32Array(HIST_BINS);
  const bHist = new Uint32Array(HIST_BINS);
  let totalPixels = 0;

  for (let y = cropY; y < cropY + cropH; y++) {
    for (let x = cropX; x < cropX + cropW; x++) {
      const i = (y * width + x) * 4;
      rHist[data[i] >>> 8]++;
      gHist[data[i + 1] >>> 8]++;
      bHist[data[i + 2] >>> 8]++;
      totalPixels++;
    }
  }

  // Thresholds per color model
  const model = colorModels[params.colorModel] || colorModels.basic;
  const blackThreshold = model.blackThreshold ?? 0.002;
  const whiteThreshold = model.whiteThreshold ?? 0.002;

  const imageType = params.imageType || 'negative';
  return [
    computeChannelLevels(rHist, totalPixels, blackThreshold, whiteThreshold, 'ToneCurvePV2012Red', imageType),
    computeChannelLevels(gHist, totalPixels, blackThreshold, whiteThreshold, 'ToneCurvePV2012Green', imageType),
    computeChannelLevels(bHist, totalPixels, blackThreshold, whiteThreshold, 'ToneCurvePV2012Blue', imageType),
  ];
}

/**
 * Compute black point, white point, and mean for a single channel histogram.
 * Names are swapped because we're analyzing a negative:
 * - whitePointOrigin = dark end of negative = white point of positive
 * - blackPointOrigin = bright end of negative = black point of positive
 */
function computeChannelLevels(hist, totalPixels, blackThreshold, whiteThreshold, settingName, imageType) {
  // Find white point origin (scan from dark end) — bin index in [0, 255]
  let cumulative = 0;
  let whiteBin = 0;
  for (let i = 0; i < HIST_BINS; i++) {
    cumulative += hist[i] / totalPixels;
    if (cumulative > whiteThreshold) {
      whiteBin = Math.max(i - 1, 0);
      break;
    }
  }

  // Find black point origin (scan from bright end)
  cumulative = 0;
  let blackBin = HIST_MAX;
  for (let i = HIST_MAX; i >= 0; i--) {
    cumulative += hist[i] / totalPixels;
    if (cumulative > blackThreshold) {
      blackBin = Math.min(i + 1, HIST_MAX);
      break;
    }
  }

  // Compute mean point (weighted average within adjusted range) — still in bin space
  const expandFactor = 0.005;
  const contractFactor = 0.005;
  const adjBlack = Math.round(whiteBin * (1 + expandFactor));
  const adjWhite = Math.round(blackBin * (1 - contractFactor));
  const adjRange = adjWhite - adjBlack;
  const adjScale = adjRange > 0 ? HIST_BINS / adjRange : 1;

  let weightedSum = 0;
  for (let i = adjBlack; i <= adjWhite; i++) {
    const normalizedPosition = (i - adjBlack) * adjScale;
    weightedSum += hist[i] * normalizedPosition;
  }

  let meanPoint = totalPixels > 0 ? weightedSum / totalPixels / HIST_BINS : 0.5;
  if (imageType !== 'positive') {
    meanPoint = 1 - meanPoint; // Invert because this is a negative
  }

  // Promote bin indices to 16-bit pixel range so downstream curve generators can
  // index Uint16Array(65536) LUTs directly.
  return {
    whitePointOrigin: whiteBin * BIN_TO_16,
    blackPointOrigin: blackBin * BIN_TO_16,
    meanPoint,
    settingName,
  };
}

/**
 * Apply tone curve LUTs to image data.
 * @param {Image16} imageData - 16-bit RGBA image (will be modified in place)
 * @param {Uint16Array} rLUT - Red channel LUT (65536 entries → 0..65535)
 * @param {Uint16Array} gLUT - Green channel LUT
 * @param {Uint16Array} bLUT - Blue channel LUT
 * @returns {Image16} Modified imageData
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
 * Separable box blur for pre-processing (replaces ImageMagick -blur 0x1).
 * Uses sliding window: O(n²) independent of radius.
 * @param {ImageData} imageData
 * @param {number} radius
 * @returns {ImageData}
 */
export function boxBlur(imageData, radius = 1) {
  const { data, width, height } = imageData;
  const size = radius * 2 + 1;
  const invSize = 1 / size;
  // Match data type — boxBlur preserves [0, MAX] since it's an average.
  const temp = data instanceof Uint16Array
    ? new Uint16Array(data.length)
    : new Uint8ClampedArray(data.length);

  // Horizontal pass: data → temp
  for (let y = 0; y < height; y++) {
    const rowOff = y * width * 4;
    // Initialize running sums for first pixel
    let rSum = 0, gSum = 0, bSum = 0;
    for (let dx = -radius; dx <= radius; dx++) {
      const sx = dx < 0 ? 0 : dx >= width ? width - 1 : dx;
      const si = rowOff + sx * 4;
      rSum += data[si];
      gSum += data[si + 1];
      bSum += data[si + 2];
    }
    temp[rowOff] = rSum * invSize;
    temp[rowOff + 1] = gSum * invSize;
    temp[rowOff + 2] = bSum * invSize;
    temp[rowOff + 3] = data[rowOff + 3];

    // Slide window across the row
    for (let x = 1; x < width; x++) {
      // Add new right pixel
      const addX = x + radius;
      const addSx = addX >= width ? width - 1 : addX;
      const addI = rowOff + addSx * 4;
      rSum += data[addI];
      gSum += data[addI + 1];
      bSum += data[addI + 2];

      // Remove old left pixel
      const remX = x - radius - 1;
      const remSx = remX < 0 ? 0 : remX;
      const remI = rowOff + remSx * 4;
      rSum -= data[remI];
      gSum -= data[remI + 1];
      bSum -= data[remI + 2];

      const di = rowOff + x * 4;
      temp[di] = rSum * invSize;
      temp[di + 1] = gSum * invSize;
      temp[di + 2] = bSum * invSize;
      temp[di + 3] = data[di + 3];
    }
  }

  // Vertical pass: temp → data
  for (let x = 0; x < width; x++) {
    const colOff = x * 4;
    // Initialize running sums for first pixel
    let rSum = 0, gSum = 0, bSum = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      const sy = dy < 0 ? 0 : dy >= height ? height - 1 : dy;
      const si = sy * width * 4 + colOff;
      rSum += temp[si];
      gSum += temp[si + 1];
      bSum += temp[si + 2];
    }
    data[colOff] = rSum * invSize;
    data[colOff + 1] = gSum * invSize;
    data[colOff + 2] = bSum * invSize;

    // Slide window down the column
    for (let y = 1; y < height; y++) {
      const addY = y + radius;
      const addSy = addY >= height ? height - 1 : addY;
      const addI = addSy * width * 4 + colOff;
      rSum += temp[addI];
      gSum += temp[addI + 1];
      bSum += temp[addI + 2];

      const remY = y - radius - 1;
      const remSy = remY < 0 ? 0 : remY;
      const remI = remSy * width * 4 + colOff;
      rSum -= temp[remI];
      gSum -= temp[remI + 1];
      bSum -= temp[remI + 2];

      const di = y * width * 4 + colOff;
      data[di] = rSum * invSize;
      data[di + 1] = gSum * invSize;
      data[di + 2] = bSum * invSize;
    }
  }

  return imageData;
}

/**
 * Negate image (invert pixel values). Simple negative-to-positive.
 * @param {Image16} imageData - 16-bit RGBA, modified in place.
 */
export function negateImage(imageData) {
  const { data } = imageData;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = MAX_16 - data[i];
    data[i + 1] = MAX_16 - data[i + 1];
    data[i + 2] = MAX_16 - data[i + 2];
  }
  return imageData;
}

// Pre-computed hue weight lookup tables (Phase 3)
// 3600 entries for 0.1° resolution in [0,1] hue space
const HUE_TABLE_SIZE = 3600
const hueWeightTableR = new Float32Array(HUE_TABLE_SIZE) // Red center at 0
const hueWeightTableG = new Float32Array(HUE_TABLE_SIZE) // Green center at 1/3
const hueWeightTableB = new Float32Array(HUE_TABLE_SIZE) // Blue center at 2/3

;(function buildHueWeightTables() {
  const inv = 1 / HUE_TABLE_SIZE
  for (let i = 0; i < HUE_TABLE_SIZE; i++) {
    const h = i * inv
    // Red (center = 0)
    let dist = h > 0.5 ? 1 - h : h
    hueWeightTableR[i] = dist > 1/6 ? 0 : 0.5 + 0.5 * Math.cos(dist * 6 * Math.PI)
    // Green (center = 1/3)
    dist = Math.abs(h - 1/3)
    if (dist > 0.5) dist = 1 - dist
    hueWeightTableG[i] = dist > 1/6 ? 0 : 0.5 + 0.5 * Math.cos(dist * 6 * Math.PI)
    // Blue (center = 2/3)
    dist = Math.abs(h - 2/3)
    if (dist > 0.5) dist = 1 - dist
    hueWeightTableB[i] = dist > 1/6 ? 0 : 0.5 + 0.5 * Math.cos(dist * 6 * Math.PI)
  }
})()

/**
 * Apply HSL (Hue/Saturation) adjustments per color region.
 * Mimics Lightroom's HSL panel with Red/Green/Blue channels.
 * Uses pre-computed hue weight lookup tables (Phase 3).
 * @param {ImageData} imageData - Will be modified in place
 * @param {Object} hsl - { redHue, redSaturation, greenHue, greenSaturation, blueHue, blueSaturation }
 * @returns {ImageData}
 */
export function applyHSLAdjustments(imageData, hsl) {
  if (!hsl) return imageData
  const { redHue, redSaturation, greenHue, greenSaturation, blueHue, blueSaturation } = hsl
  if (!redHue && !redSaturation && !greenHue && !greenSaturation && !blueHue && !blueSaturation) {
    return imageData
  }

  const { data } = imageData
  const rHueShift = redHue / 360
  const gHueShift = greenHue / 360
  const bHueShift = blueHue / 360
  const rSatFactor = redSaturation / 100
  const gSatFactor = greenSaturation / 100
  const bSatFactor = blueSaturation / 100
  const invMax = 1 / MAX_16

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] * invMax
    const g = data[i + 1] * invMax
    const b = data[i + 2] * invMax

    // RGB → HSL (optimized: avoid Math.max/Math.min function calls)
    let max, min
    if (r > g) {
      max = r > b ? r : b
      min = g < b ? g : b
    } else {
      max = g > b ? g : b
      min = r < b ? r : b
    }
    const d = max - min
    const l = (max + min) * 0.5

    if (d < 1e-6) continue // achromatic, skip

    let h
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
    else if (max === g) h = ((b - r) / d + 2) / 6
    else h = ((r - g) / d + 4) / 6

    const invD = 1 / (l > 0.5 ? 2 - max - min : max + min)
    let s = d * invD

    // Lookup hue weights from pre-computed tables
    const hIdx = (h * HUE_TABLE_SIZE) | 0
    const rWeight = hueWeightTableR[hIdx]
    const gWeight = hueWeightTableG[hIdx]
    const bWeight = hueWeightTableB[hIdx]

    // Apply hue shift
    h += rWeight * rHueShift + gWeight * gHueShift + bWeight * bHueShift
    h = h - Math.floor(h)

    // Apply saturation adjustment
    const satAdj = rWeight * rSatFactor + gWeight * gSatFactor + bWeight * bSatFactor
    s = s * (1 + satAdj)
    if (s < 0) s = 0
    else if (s > 1) s = 1

    // HSL → RGB
    let r2, g2, b2
    if (s < 1e-6) {
      r2 = g2 = b2 = l
    } else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s
      const p = 2 * l - q
      r2 = hue2rgb(p, q, h + 1/3)
      g2 = hue2rgb(p, q, h)
      b2 = hue2rgb(p, q, h - 1/3)
    }

    let v
    v = r2 * MAX_16 + 0.5; data[i] = v < 0 ? 0 : v > MAX_16 ? MAX_16 : v | 0
    v = g2 * MAX_16 + 0.5; data[i + 1] = v < 0 ? 0 : v > MAX_16 ? MAX_16 : v | 0
    v = b2 * MAX_16 + 0.5; data[i + 2] = v < 0 ? 0 : v > MAX_16 ? MAX_16 : v | 0
  }

  return imageData
}

/** HSL hue-to-RGB helper */
function hue2rgb(p, q, t) {
  if (t < 0) t += 1
  if (t > 1) t -= 1
  if (t < 1/6) return p + (q - p) * 6 * t
  if (t < 1/2) return q
  if (t < 2/3) return p + (q - p) * (2/3 - t) * 6
  return p
}

/**
 * Adjust saturation of image.
 * @param {Image16} imageData - 16-bit RGBA
 * @param {number} amount - 0=grayscale, 100=unchanged, 200=max saturation
 */
export function adjustSaturation(imageData, amount) {
  if (amount === 100) return imageData;
  const factor = amount / 100;
  const { data } = imageData;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    data[i] = Math.max(0, Math.min(MAX_16, lum + factor * (r - lum)));
    data[i + 1] = Math.max(0, Math.min(MAX_16, lum + factor * (g - lum)));
    data[i + 2] = Math.max(0, Math.min(MAX_16, lum + factor * (b - lum)));
  }
  return imageData;
}

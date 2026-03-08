/**
 * ImageProcessor.js - Canvas-based image processing pipeline
 * Canvas-based image processing pipeline
 */

import { colorModels } from './Presets.js'

/**
 * Analyze image to extract per-channel histogram data.
 * Returns black/white/mean points per channel via histogram analysis.
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
  if (imageType !== 'positive') {
    meanPoint = 1 - meanPoint; // Invert because this is a negative
  }

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
 * Apply HSL (Hue/Saturation) adjustments per color region.
 * Mimics Lightroom's HSL panel with Red/Green/Blue channels.
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
  // Precompute hue shifts in [0,1] range (Lightroom uses [-100,100] mapped to [-30°,+30°] approx)
  const rHueShift = redHue / 360
  const gHueShift = greenHue / 360
  const bHueShift = blueHue / 360
  // Saturation adjustments as multiplier offsets (Lightroom [-100,100] → [-1,+1])
  const rSatFactor = redSaturation / 100
  const gSatFactor = greenSaturation / 100
  const bSatFactor = blueSaturation / 100

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255
    const g = data[i + 1] / 255
    const b = data[i + 2] / 255

    // RGB → HSL
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const d = max - min
    const l = (max + min) * 0.5

    if (d < 1e-6) continue // achromatic, skip

    let h
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
    else if (max === g) h = ((b - r) / d + 2) / 6
    else h = ((r - g) / d + 4) / 6

    let s = l > 0.5 ? d / (2 - max - min) : d / (max + min)

    // Compute per-region weights using cosine falloff
    // Each region has 120° width (60° half-width), centered at 0°, 120°, 240°
    const rWeight = hueWeight(h, 0)     // Red center at 0°
    const gWeight = hueWeight(h, 1/3)   // Green center at 120°
    const bWeight = hueWeight(h, 2/3)   // Blue center at 240°

    // Apply hue shift (weighted blend of all regions)
    h += rWeight * rHueShift + gWeight * gHueShift + bWeight * bHueShift
    h = h - Math.floor(h) // wrap to [0,1]

    // Apply saturation adjustment
    const satAdj = rWeight * rSatFactor + gWeight * gSatFactor + bWeight * bSatFactor
    s = Math.max(0, Math.min(1, s * (1 + satAdj)))

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

    data[i] = Math.max(0, Math.min(255, r2 * 255 + 0.5)) | 0
    data[i + 1] = Math.max(0, Math.min(255, g2 * 255 + 0.5)) | 0
    data[i + 2] = Math.max(0, Math.min(255, b2 * 255 + 0.5)) | 0
  }

  return imageData
}

/** Cosine-based weight for a hue region. center in [0,1], 60° half-width. */
function hueWeight(h, center) {
  // Angular distance on hue circle
  let dist = Math.abs(h - center)
  if (dist > 0.5) dist = 1 - dist
  // 60° half-width = 1/6 in [0,1] hue space
  if (dist > 1/6) return 0
  return 0.5 + 0.5 * Math.cos(dist * 6 * Math.PI)
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

/**
 * WhiteBalance.js - Auto white balance algorithms
 * Extracted from NLPViewController.lua and v1.2.1 Negative.lua
 */

import { rgbToHSV } from './ColorSpace.js';

/**
 * HSB analysis with masked sampling (equivalent to ImageMagick HSB pipeline).
 * Analyzes image pixels within hue/saturation/luminosity masks.
 *
 * @param {ImageData} imageData
 * @param {Object} params - { hueLow, hueHigh, invertHue, satThreshold, lumLow, lumHigh }
 * @returns {{ h: number, s: number, b: number }}
 */
function hsbAnalysis(imageData, params) {
  const { data, width, height } = imageData;
  const { hueLow, hueHigh, invertHue, satThreshold, lumLow, lumHigh } = params;

  let hSum = 0, sSum = 0, bSum = 0, count = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;

    const [h, s, v] = rgbToHSV(r, g, b);
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;

    // Hue mask
    let hueInRange = h >= hueLow && h <= hueHigh;
    if (invertHue) hueInRange = !hueInRange;

    // Saturation mask (keep low-saturation / near-neutral pixels)
    const satPass = s * 100 < satThreshold;

    // Luminosity mask
    const lumPass = lum * 100 >= lumLow && lum * 100 <= lumHigh;

    if (hueInRange && satPass && lumPass) {
      // Negate + per-channel normalize approximation
      // For WB analysis we use the inverted values
      const nr = 1 - r;
      const ng = 1 - g;
      const nb = 1 - b;
      const [nh, ns, nv] = rgbToHSV(nr, ng, nb);

      hSum += nh;
      sSum += ns;
      bSum += nv;
      count++;
    }
  }

  if (count === 0) return { h: 0, s: 0, b: 0.5 };
  return {
    h: Math.round(hSum / count),
    s: Math.round((sSum / count) * 100),
    b: Math.round((bSum / count) * 100),
  };
}

/**
 * Run 3 HSB analyses for auto WB (neutral, warm, cool).
 * @param {ImageData} imageData - Cropped and blurred negative
 * @returns {Object} { neutral, warm, cool } HSB triplets
 */
export function analyzeAutoWB(imageData) {
  return {
    neutral: hsbAnalysis(imageData, {
      hueLow: 0, hueHigh: 360, invertHue: false,
      satThreshold: 70, lumLow: 0, lumHigh: 100,
    }),
    warm: hsbAnalysis(imageData, {
      hueLow: 145, hueHigh: 270, invertHue: false,
      satThreshold: 60, lumLow: 25, lumHigh: 75,
    }),
    cool: hsbAnalysis(imageData, {
      hueLow: 90, hueHigh: 270, invertHue: true,
      satThreshold: 70, lumLow: 25, lumHigh: 75,
    }),
  };
}

/**
 * Compute auto color correction from channel mean points.
 * @param {Object[]} channelData - [r, g, b] each with .meanPoint
 * @returns {{ tempCorrection: number, tintCorrection: number, cyanCorrection: number }}
 */
export function computeAutoColor(channelData) {
  const rMean = channelData[0].meanPoint;
  const gMean = channelData[1].meanPoint;
  const bMean = channelData[2].meanPoint;
  const nGray = (rMean + gMean + bMean) / 3;

  return {
    tempCorrection: Math.round((nGray - bMean) * -100),
    tintCorrection: Math.round((nGray - gMean) * -100),
    cyanCorrection: Math.round((nGray - rMean) * -100),
  };
}

/**
 * Channel multiplier matrix for color balance.
 * Maps temp/tint/cyan adjustments to per-channel offsets.
 */
export const CHANNEL_MULTIPLIER = [
  { temp: 0.8, tint: 0.5, cyan: -1.0 },  // Red
  { temp: 0.8, tint: -1.0, cyan: 0.5 },  // Green
  { temp: -1.6, tint: 0.5, cyan: 0.5 },  // Blue
];

export const TEMP_STRENGTH = 2;

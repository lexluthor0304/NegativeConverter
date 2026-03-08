/**
 * CurveEngine.js - Tone curve generation engine
 * Tone curve generation engine
 *
 * Core algorithm: tanh/atanh-based S-curve interpolation applied through
 * a multi-layer processing pipeline to generate per-channel LUT curves.
 */

import { toneProfiles } from './Presets.js';

// --- Math primitives ---

function clamp01(x) {
  return x > 1 ? 1 : x < 0 ? 0 : x;
}

function atanh(x) {
  // Numerically stable atanh
  x = Math.max(-0.9999999, Math.min(0.9999999, x));
  return 0.5 * Math.log((1 + x) / (1 - x));
}

function logb(base, val) {
  return Math.log(val) / Math.log(base);
}

function tanhBasis(steepness, midpoint, x) {
  return Math.tanh(0.5 * steepness * (x - midpoint));
}

function tanhInterpolate(steepness, midpoint, x, scale) {
  scale = scale || 1;
  const t = x / scale;
  const num = tanhBasis(steepness, midpoint, t) - tanhBasis(steepness, midpoint, 0);
  const den = tanhBasis(steepness, midpoint, 1) - tanhBasis(steepness, midpoint, 0);
  return (num / den) * scale;
}

function atanhInterpolate(steepness, midpoint, x, scale) {
  scale = scale || 1;
  const range = tanhBasis(steepness, midpoint, 1) - tanhBasis(steepness, midpoint, 0);
  let t = range * (x / scale) + tanhBasis(steepness, midpoint, 0);
  t = Math.max(-0.9999999, Math.min(0.9999999, t));
  const result = (2 / steepness) * atanh(t) + midpoint;
  return result * scale;
}

// --- Channel mapping helpers ---

function mapChannels(channels, fn) {
  const result = [];
  for (let ch = 0; ch < channels.length; ch++) {
    result[ch] = [];
    for (let pt = 0; pt < channels[ch].length; pt++) {
      result[ch][pt] = fn(channels[ch][pt], ch + 1, pt + 1);
    }
  }
  return result;
}

function applyDifferenceLayer(base, transformed, reference) {
  return mapChannels(base, (val, ch, pt) =>
    clamp01(val + transformed[ch - 1][pt - 1] - reference[ch - 1][pt - 1])
  );
}

// --- Settings preparation ---

function autoToneGamma(channelData) {
  const avgMean = (channelData[0].meanPoint + channelData[1].meanPoint + channelData[2].meanPoint) / 3;
  if (avgMean <= 0 || avgMean >= 1) return 1;
  let gamma = 1 / logb(0.5, avgMean);
  return Math.max(0.8, Math.min(1.1, gamma));
}

function prepareSettings(channelData, settings) {
  const profileKey = settings.toneProfile || 'standard';
  const profile = toneProfiles[profileKey] || toneProfiles.standard;

  let autoGamma = 1;
  if (profile.autoTone) {
    const rawGamma = autoToneGamma(channelData);
    const autoToneLevel = settings.autoToneLevel ?? 1;
    autoGamma = 1 + (rawGamma - 1) * autoToneLevel;
  }

  return {
    cyan: 1 - (settings.temp || 0) * 0.01,
    tint: 1 - (settings.tint || 0) * 0.01,
    temp: 1 - (settings.temperature || 0) * 0.01,
    wbCyan: -(settings.wbCyan || 0) / 255,
    wbTint: -(settings.wbTint || 0) / 255,
    wbTemp: -(settings.wbTemp || 0) / 255,
    brightness: (1 / (1 + (settings.brightness || 0) * 0.02)) *
                (1 / (profile.defaultGamma || 1)) *
                (1 / autoGamma),
    exposure: 1 / (1 + (settings.exposure || 0) * 0.02),
    contrast: (settings.contrast || 0) + (profile.defaultContrast || 0),
    highlights: (settings.highlights || 0) + (profile.defaultHighlights || 0) + ((settings.glow || 0) / 1.5),
    shadows: (settings.shadows || 0) + (profile.defaultShadows || 0) - ((settings.fade || 0) / 1.5),
    blacks: (settings.blacks || 0) + (profile.defaultBlacks || 0) + (settings.fade || 0),
    whites: (settings.whites || 0) + (profile.defaultWhites || 0) - (settings.glow || 0),
    shadowRange: settings.shadowRange ?? 5,
    highlightRange: settings.highlightRange ?? 5,
    shadowCyan: settings.shadowCyan ?? 0,
    shadowTint: settings.shadowTint ?? 0,
    shadowTemp: settings.shadowTemp ?? 0,
    highlightCyan: settings.highlightCyan ?? 0,
    highlightTint: settings.highlightTint ?? 0,
    highlightTemp: settings.highlightTemp ?? 0,
  };
}

// --- Curve resolution ---

function getCurveResolution(curveWidth, settings) {
  const type = settings.curvePrecision || 'auto';
  if (type === 'auto') {
    if (curveWidth <= 30) return 3;
    if (curveWidth <= 70) return 5;
    if (curveWidth < 128) return 7;
    return 9;
  }
  if (type === 'smooth') return 4;
  if (type === 'precise') return 14;
  return 8;
}

// --- Base grid ---

function createBaseGrid(resolution) {
  const grid = [[], [], []];
  for (let ch = 0; ch < 3; ch++) {
    for (let i = 0; i < resolution; i++) {
      grid[ch][i] = i / (resolution - 1);
    }
  }
  return grid;
}

// --- Tone adjustment layers ---

function exposureLayer(channels, exposure) {
  if (exposure === 1) return channels;
  return mapChannels(channels, (x) => {
    if (exposure < 1) {
      return 1 - Math.pow(1 - x, 1 / exposure);
    }
    const darkFactor = 2 - exposure;
    const scale = 1 - (1 - darkFactor) * 0.4;
    return x * scale;
  });
}

function gammaLayer(channels, gamma) {
  if (gamma === 1) return channels;
  return mapChannels(channels, (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return Math.pow(x, gamma);
  });
}

function contrastLayer(channels, contrast) {
  if (Math.abs(contrast) < 1) return channels;
  const midpoint = 0.5;
  if (contrast >= 1) {
    const steepness = 1 + contrast * 0.2;
    return mapChannels(channels, (x) => tanhInterpolate(steepness, midpoint, x));
  }
  const steepness = 1 + Math.abs(contrast) * 0.1;
  return mapChannels(channels, (x) => atanhInterpolate(steepness, midpoint, x));
}

function highlightsLayer(channels, highlights) {
  if (Math.abs(highlights) < 1) return channels;
  const midpoint = 0.75;
  const threshold = 0.9;
  const steepness = 0.5 + Math.abs(highlights) * 0.1;
  if (highlights >= 1) {
    return mapChannels(channels, (x) => {
      if (x <= 1 - threshold) return x;
      return 1 - tanhInterpolate(steepness, midpoint, 1 - x, threshold);
    });
  }
  return mapChannels(channels, (x) => {
    if (x <= 1 - threshold) return x;
    return 1 - atanhInterpolate(steepness, midpoint, 1 - x, threshold);
  });
}

function shadowsLayer(channels, shadows) {
  if (Math.abs(shadows) < 1) return channels;
  const midpoint = 0.75;
  const threshold = 0.9;
  const steepness = 0.5 + Math.abs(shadows) * 0.1;
  if (shadows >= 1) {
    return mapChannels(channels, (x) => {
      if (x >= threshold) return x;
      return atanhInterpolate(steepness, midpoint, x, threshold);
    });
  }
  return mapChannels(channels, (x) => {
    if (x >= threshold) return x;
    return tanhInterpolate(steepness, midpoint, x, threshold);
  });
}

function blacksLayer(channels, prepared) {
  const blacks = prepared.blacks;
  if (Math.abs(blacks) < 1) return channels;
  const decay = (-(prepared.shadowRange) + 1) * 0.33 + 5;

  if (blacks >= 1) {
    const lift = blacks / 255;
    return mapChannels(channels, (x) => {
      if (x >= 0.9) return x;
      return lift * Math.exp(-x * decay) + x;
    });
  }
  // Negative blacks: crush shadows
  const steepness = 0.5 + Math.abs(blacks) * 0.1;
  return mapChannels(channels, (x) => {
    if (x > 0.5) return x;
    return tanhInterpolate(steepness, 0.75, x, 0.5);
  });
}

function whitesLayer(channels, settings, prepared) {
  let whites = prepared.whites;
  const highlightRange = settings.highlightRange ?? 5;
  const decay = (-highlightRange + 1) * 0.33 + 5;

  // Combine whites with strong negative highlights
  if ((settings.highlights || 0) < -5) {
    whites += (settings.highlights || 0) / 5;
  }

  if (Math.abs(whites) < 1) return channels;

  if (whites <= -1) {
    const clip = -whites / 255;
    return mapChannels(channels, (x) => {
      if (x < 0.1) return x;
      return 1 - (clip * Math.exp(-(1 - x) * decay) + (1 - x));
    });
  }
  const steepness = 0.5 + Math.abs(whites) * 0.1;
  return mapChannels(channels, (x) => {
    if (x < 0.5) return x;
    return 1 - tanhInterpolate(steepness, 0.75, 1 - x, 0.5);
  });
}

// --- White balance layers ---

const WB_LOW = 0.1;
const WB_HIGH = 0.8;

function applyLinearFixed(channels, colorOffset) {
  const highCompl = 1 - WB_HIGH;
  return mapChannels(channels, (x, ch) => {
    const offset = colorOffset[ch - 1];
    if (offset === 0) return x;
    if (x <= 0 || x >= 1) return clamp01(x);
    if (x > WB_HIGH) {
      const blend = (1 - x) / highCompl;
      return clamp01(x + offset * blend);
    }
    if (x < WB_LOW) {
      return clamp01(x + offset * (x / WB_LOW));
    }
    return clamp01(x + offset);
  });
}

function applyLinearDynamic(channels, colorOffset) {
  const highCompl = 1 - WB_HIGH;
  return mapChannels(channels, (x, ch) => {
    const offset = colorOffset[ch - 1];
    if (offset === 0) return x;
    if (x <= 0 || x >= 1) return clamp01(x);
    const scaled = offset * (0.2 + 0.8 * x);
    if (x > WB_HIGH) {
      const blend = (1 - x) / highCompl;
      return clamp01(x + scaled * blend);
    }
    if (x < WB_LOW) {
      return clamp01(x + scaled * (x / WB_LOW));
    }
    return clamp01(x + scaled);
  });
}

function applyShadowWeighted(channels, colorOffset) {
  return mapChannels(channels, (x, ch) => {
    const offset = colorOffset[ch - 1];
    if (offset === 0 || x <= 0 || x >= 1) return x;
    const gamma = 1 + offset * 4;
    if (gamma <= 0.01) return x;
    return clamp01(Math.pow(x, 1 / gamma));
  });
}

function applyHighlightWeighted(channels, colorOffset) {
  return mapChannels(channels, (x, ch) => {
    const offset = colorOffset[ch - 1];
    if (offset === 0 || x <= 0 || x >= 1) return x;
    const gamma = 1 + offset * 4;
    if (gamma <= 0.01) return x;
    return clamp01(1 - Math.pow(1 - x, gamma));
  });
}

function applyMidtoneWeighted(channels, colorOffset) {
  return mapChannels(channels, (x, ch) => {
    const offset = colorOffset[ch - 1];
    if (offset === 0 || x <= 0 || x >= 1) return x;
    const gamma = 1 + offset * 4;
    if (gamma <= 0.01) return x;
    const shadow = clamp01(Math.pow(x, 1 / gamma));
    const highlight = clamp01(1 - Math.pow(1 - x, gamma));
    return (shadow + highlight) / 2;
  });
}

function colorLinearLayer(channels, settings) {
  const wbTint = -(settings.wbTint || 0) / 255;
  const wbTemp = -(settings.wbTemp || 0) / 255;
  const wbCyan = -(settings.wbCyan || 0) / 255;
  const wbTonality = settings.wbTonality || 'addDensity';
  const wbMethod = settings.wbMethod || 'linearFixed';

  let colorOffset;
  let brightnessMultiplier = 1;

  switch (wbTonality) {
    case 'neutralDensity':
      colorOffset = [
        -(wbTemp / 2 + wbTint / 2),
        -(wbTemp / 2 - wbTint / 2),
        wbTemp / 2 - wbTint / 2,
      ];
      break;
    case 'subtractDensity': {
      const denom = (1 - wbTemp * 0.5) * (1 - wbTint * 0.5);
      brightnessMultiplier = Math.abs(denom) > 0.001 ? 1 / denom : 1;
      colorOffset = [
        -(wbTemp + wbTint),
        0,
        0,
      ];
      break;
    }
    case 'tempTintDensity':
      colorOffset = [
        -wbTint / 2,
        0,
        wbTemp - wbTint / 2,
      ];
      break;
    case 'addDensity':
    default:
      colorOffset = [wbCyan, wbTint, wbTemp];
      break;
  }

  if (colorOffset[0] === 0 && colorOffset[1] === 0 && colorOffset[2] === 0 && brightnessMultiplier === 1) {
    return channels;
  }

  if (brightnessMultiplier !== 1) {
    channels = mapChannels(channels, (x) => clamp01(x * brightnessMultiplier));
  }

  switch (wbMethod) {
    case 'linearDynamic':
      return applyLinearDynamic(channels, colorOffset);
    case 'shadowWeighted':
      return applyShadowWeighted(channels, colorOffset);
    case 'highlightWeighted':
      return applyHighlightWeighted(channels, colorOffset);
    case 'midtoneWeighted':
      return applyMidtoneWeighted(channels, colorOffset);
    case 'linearFixed':
    default:
      return applyLinearFixed(channels, colorOffset);
  }
}

function colorGammaLayer(channels, colorMultipliers) {
  return mapChannels(channels, (x, ch) => {
    const mult = colorMultipliers[ch - 1];
    if (mult === 1) return x;
    const shift = (1 - mult) / 4;
    const adjusted = x - shift;
    if (x <= 0 || x >= 1) return x;
    if (adjusted >= 1) return 1;
    if (x > 0.8) {
      const blend = (1 - x) / 0.2;
      return x - shift * blend;
    }
    if (adjusted <= 0) return 0;
    return adjusted;
  });
}

// --- Shadow/Highlight color toning ---

function shadowColorLayer(channels, settings) {
  const midpoint = 0.75;
  const colorScale = 0.125;
  const shadowBound = 0.9 - (10 - (settings.shadowRange ?? 5)) * 0.0444;
  const colorSettings = [-(settings.shadowCyan ?? 0), -(settings.shadowTint ?? 0), -(settings.shadowTemp ?? 0)];

  return mapChannels(channels, (x, ch) => {
    const colorVal = colorSettings[ch - 1];
    if (colorVal === 0) return x;
    if (x >= shadowBound) return x;

    const rangeFactor = 1 + (10 - (settings.shadowRange ?? 5)) / 18;
    const steepness = 0.75 + Math.abs(colorVal) * rangeFactor * colorScale;

    if (colorVal > 0) {
      return atanhInterpolate(steepness, midpoint, x, shadowBound);
    }
    return tanhInterpolate(steepness, midpoint, x, shadowBound);
  });
}

function midtoneColorLayer(channels, settings) {
  const colorScale = 0.1;
  const midCenter = 0.5;
  const midWidth = 0.35;
  const colorSettings = [-(settings.midCyan ?? 0), -(settings.midTint ?? 0), -(settings.midTemp ?? 0)];

  return mapChannels(channels, (x, ch) => {
    const colorVal = colorSettings[ch - 1];
    if (colorVal === 0) return x;

    // Bell-curve weight centered at midCenter
    const dist = (x - midCenter) / midWidth;
    const weight = Math.exp(-0.5 * dist * dist);
    if (weight < 0.01) return x;

    const shift = colorVal * colorScale * weight / 255;
    return clamp01(x + shift);
  });
}

function highlightColorLayer(channels, settings) {
  const midpoint = 0.75;
  const colorScale = 0.125;
  const highlightBound = 0.9 - (10 - (settings.highlightRange ?? 5)) * 0.0444;
  const colorSettings = [-(settings.highlightCyan ?? 0), -(settings.highlightTint ?? 0), -(settings.highlightTemp ?? 0)];

  return mapChannels(channels, (x, ch) => {
    const colorVal = colorSettings[ch - 1];
    if (colorVal === 0) return x;
    if (x <= 1 - highlightBound) return x;

    const rangeFactor = 1 + (10 - (settings.highlightRange ?? 5)) / 18;
    const steepness = 0.75 + Math.abs(colorVal) * rangeFactor * colorScale;

    if (colorVal > 0) {
      return 1 - tanhInterpolate(steepness, midpoint, 1 - x, highlightBound);
    }
    return 1 - atanhInterpolate(steepness, midpoint, 1 - x, highlightBound);
  });
}

// --- Invert (negative -> positive flip) ---

function invertCurve(channels) {
  const len = channels[0].length;
  return mapChannels(channels, (_x, ch, pt) => channels[ch - 1][len - pt]);
}

// --- Soft clip layer ---

function softClipLayer(channels, whiteClips, blackClips) {
  return mapChannels(channels, (x, ch) => {
    const wc = whiteClips[ch - 1] || 0;
    const bc = blackClips[ch - 1] || 0;
    if (wc === 0 && bc === 0) return x;
    const whiteScale = (255 - wc) / 255;
    const blackScale = bc / 255;
    return x * (whiteScale - blackScale) + blackScale;
  });
}

// --- Color protected clamp ---

function colorProtectedClamp(channels) {
  const numPts = channels[0].length;
  for (let pt = 0; pt < numPts; pt++) {
    let r = channels[0][pt];
    let g = channels[1][pt];
    let b = channels[2][pt];

    const maxVal = Math.max(r, g, b);
    const minVal = Math.min(r, g, b);
    if (maxVal <= 1 && minVal >= 0) continue;

    const avg = (r + g + b) / 3;

    if (maxVal > 1 && avg < maxVal) {
      const ratio = (1 - avg) / (maxVal - avg);
      r = avg + (r - avg) * ratio;
      g = avg + (g - avg) * ratio;
      b = avg + (b - avg) * ratio;
    }

    if (minVal < 0 && avg > minVal) {
      const newMin = Math.min(r, g, b);
      if (newMin < 0) {
        const ratio = avg / (avg - newMin);
        r = avg + (r - avg) * ratio;
        g = avg + (g - avg) * ratio;
        b = avg + (b - avg) * ratio;
      }
    }

    channels[0][pt] = clamp01(r);
    channels[1][pt] = clamp01(g);
    channels[2][pt] = clamp01(b);
  }
  return channels;
}

// --- Clip point computation ---

function computeClipPoints(channelData, settings) {
  const profileKey = settings.toneProfile || 'standard';
  const profile = toneProfiles[profileKey] || toneProfiles.standard;
  const softHigh = (settings.softHigh ?? 0) + (profile.defaultSoftHigh || 0);
  const softLow = (settings.softLow ?? 0) + (profile.defaultSoftLow || 0);

  const whites = []; // per-channel white point (bright end of negative = shadow of positive)
  const blacks = []; // per-channel black point (dark end of negative = highlight of positive)
  const whiteOverflow = [0, 0, 0];
  const blackUnderflow = [0, 0, 0];

  for (let ch = 0; ch < 3; ch++) {
    let wp = channelData[ch].whitePointOrigin + softHigh;
    let bp = channelData[ch].blackPointOrigin - softLow;

    if (wp < 0) {
      whiteOverflow[ch] = -wp;
      wp = 0;
    }
    if (bp > 255) {
      blackUnderflow[ch] = bp - 255;
      bp = 255;
    }
    whites[ch] = wp;
    blacks[ch] = bp;
  }

  const widths = [
    blacks[0] - whites[0],
    blacks[1] - whites[1],
    blacks[2] - whites[2],
  ];

  return { whites, blacks, widths, whiteOverflow, blackUnderflow };
}

// --- Build raw curve (scale normalized to pixel coordinates) ---

function buildRawCurve(channelData, settings, normalizedGrid) {
  const SOFT_CLIP = 6;
  const clip = computeClipPoints(channelData, settings);
  const numPoints = normalizedGrid[0].length;
  const raw = [[], [], []];

  // For negative mode, swap softHighlights/softShadows semantics
  const isNeg = (settings.imageType || 'negative') === 'negative';
  const useSoftHigh = isNeg ? settings.softHighlights : settings.softShadows;
  const useSoftLow = isNeg ? settings.softShadows : settings.softHighlights;

  for (let i = 0; i < numPoints; i++) {
    for (let ch = 0; ch < 3; ch++) {
      raw[ch][i] = clip.whites[ch] + normalizedGrid[ch][i] * clip.widths[ch];
    }

    // Soft highlight clipping (first point)
    if (i === 0 && useSoftHigh) {
      if (raw[0][0] > SOFT_CLIP && raw[1][0] > SOFT_CLIP && raw[2][0] > SOFT_CLIP) {
        raw[0][0] -= SOFT_CLIP;
        raw[1][0] -= SOFT_CLIP;
        raw[2][0] -= SOFT_CLIP;
      }
    }

    // Soft shadow clipping (last point)
    if (i === numPoints - 1 && useSoftLow) {
      const threshold = 255 - SOFT_CLIP;
      if (raw[0][i] < threshold && raw[1][i] < threshold && raw[2][i] < threshold) {
        raw[0][i] += SOFT_CLIP;
        raw[1][i] += SOFT_CLIP;
        raw[2][i] += SOFT_CLIP;
      }
    }
  }

  return { raw, clip };
}

// --- Main entry point ---

/**
 * Generate tone curve LUTs from channel analysis data and user settings.
 * @param {Object[]} channelData - [{whitePointOrigin, blackPointOrigin, meanPoint}, ...] for R,G,B
 * @param {Object} settings - All user parameters
 * @returns {Object} { r: Uint8Array(256), g: Uint8Array(256), b: Uint8Array(256) } - LUT per channel
 */
export function generateCurves(channelData, settings) {
  const imageType = settings.imageType || 'negative';

  // 1. Prepare settings
  const prepared = prepareSettings(channelData, settings);

  // 2. Compute clip points
  const clip = computeClipPoints(channelData, settings);
  const minWidth = Math.min(...clip.widths);

  // 3. Set curve resolution
  const resolution = getCurveResolution(minWidth, settings);

  // 4. Create base grid
  let curve = createBaseGrid(resolution);

  // 5. Build raw curve
  const { raw } = buildRawCurve(channelData, settings, curve);

  // 6. Color multipliers
  const colorMults = [prepared.cyan, prepared.tint, prepared.temp];

  // 7. Apply layers in order
  const hasWbColor = prepared.wbTint !== 0 || prepared.wbTemp !== 0 || prepared.wbCyan !== 0;

  // Color first (default)
  const layerOrder = settings.layerOrder || 'colorFirst';
  if (layerOrder === 'colorFirst') {
    if (hasWbColor) {
      curve = colorLinearLayer(curve, settings);
    }
    curve = colorGammaLayer(curve, colorMults);
  }

  // Tone layers
  curve = exposureLayer(curve, prepared.exposure);
  curve = gammaLayer(curve, prepared.brightness);
  curve = contrastLayer(curve, prepared.contrast);
  curve = highlightsLayer(curve, prepared.highlights);
  curve = shadowsLayer(curve, prepared.shadows);
  curve = blacksLayer(curve, prepared);
  curve = whitesLayer(curve, settings, prepared);

  // Soft clip
  curve = softClipLayer(curve, clip.whiteOverflow, clip.blackUnderflow);

  // Tones first alternative order
  if (layerOrder === 'tonesFirst') {
    const refGrid = createBaseGrid(resolution);
    if (hasWbColor) {
      const colorCurve = colorLinearLayer(refGrid, settings);
      curve = applyDifferenceLayer(curve, colorCurve, refGrid);
    }
    const gammaCurve = colorGammaLayer(refGrid, colorMults);
    curve = applyDifferenceLayer(curve, gammaCurve, refGrid);
  }

  // Highlight & shadow color toning
  if ((settings.highlightCyan ?? 0) !== 0 || (settings.highlightTint ?? 0) !== 0 || (settings.highlightTemp ?? 0) !== 0) {
    curve = highlightColorLayer(curve, settings);
  }
  if ((settings.shadowCyan ?? 0) !== 0 || (settings.shadowTint ?? 0) !== 0 || (settings.shadowTemp ?? 0) !== 0) {
    curve = shadowColorLayer(curve, settings);
  }
  if ((settings.midCyan ?? 0) !== 0 || (settings.midTint ?? 0) !== 0 || (settings.midTemp ?? 0) !== 0) {
    curve = midtoneColorLayer(curve, settings);
  }

  // Color protected clamp (preserves channel ratios on overflow)
  curve = colorProtectedClamp(curve);

  // 8. Invert for negative mode; skip for positive
  const finalCurve = imageType === 'positive' ? curve : invertCurve(curve);

  // 9. Build interleaved curve points (X=raw input, Y=output*255)
  const curvePoints = [[], [], []];
  for (let ch = 0; ch < 3; ch++) {
    for (let pt = 0; pt < curve[0].length; pt++) {
      curvePoints[ch].push({
        x: Math.round(raw[ch][pt]),
        y: Math.round(finalCurve[ch][pt] * 255),
      });
    }
  }

  // 10. Interpolate to full 256-point LUT
  return {
    r: interpolateToLUT(curvePoints[0]),
    g: interpolateToLUT(curvePoints[1]),
    b: interpolateToLUT(curvePoints[2]),
  };
}

/**
 * Interpolate sparse curve points to a full 256-entry LUT.
 * Uses linear interpolation between control points.
 */
function interpolateToLUT(points) {
  const lut = new Uint8Array(256);

  // Sort by x
  points.sort((a, b) => a.x - b.x);

  // Clamp and extend
  for (let i = 0; i < 256; i++) {
    if (i <= points[0].x) {
      lut[i] = Math.max(0, Math.min(255, points[0].y));
    } else if (i >= points[points.length - 1].x) {
      lut[i] = Math.max(0, Math.min(255, points[points.length - 1].y));
    } else {
      // Find surrounding points
      let lo = 0;
      for (let j = 0; j < points.length - 1; j++) {
        if (points[j].x <= i && points[j + 1].x >= i) {
          lo = j;
          break;
        }
      }
      const p0 = points[lo];
      const p1 = points[lo + 1];
      const t = (p1.x === p0.x) ? 0 : (i - p0.x) / (p1.x - p0.x);
      const v = p0.y + t * (p1.y - p0.y);
      lut[i] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }

  return lut;
}

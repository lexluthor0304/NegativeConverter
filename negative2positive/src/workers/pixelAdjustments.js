/**
 * Pure pixel adjustment functions extracted from main.js for use in Web Workers.
 * No DOM dependencies — operates only on typed arrays and plain objects.
 */

export function hue2rgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

export function buildChannelLuts({
  lutR, lutG, lutB,
  curveR, curveG, curveB,
  rMult, gMult, bMult,
  contrastFactor, doContrast,
  doTempTint, tempRMult, tintGMult, tempBMult,
  doCMY, cmyRShift, cmyGShift, cmyBShift
}) {
  for (let v = 0; v < 256; v++) {
    let r = v * rMult;
    let g = v * gMult;
    let b = v * bMult;

    if (doContrast) {
      r = (r - 127.5) * contrastFactor + 127.5;
      g = (g - 127.5) * contrastFactor + 127.5;
      b = (b - 127.5) * contrastFactor + 127.5;
    }

    if (doTempTint) {
      r *= tempRMult;
      g *= tintGMult;
      b *= tempBMult;
    }

    if (r < 0) r = 0; else if (r > 255) r = 255;
    if (g < 0) g = 0; else if (g > 255) g = 255;
    if (b < 0) b = 0; else if (b > 255) b = 255;

    if (doCMY) {
      r -= cmyRShift;
      g -= cmyGShift;
      b -= cmyBShift;

      if (r < 0) r = 0; else if (r > 255) r = 255;
      if (g < 0) g = 0; else if (g > 255) g = 255;
      if (b < 0) b = 0; else if (b > 255) b = 255;
    }

    lutR[v] = curveR[(r + 0.5) | 0];
    lutG[v] = curveG[(g + 0.5) | 0];
    lutB[v] = curveB[(b + 0.5) | 0];
  }
}

/**
 * Apply pixel adjustments to a buffer. Handles both fast LUT path and full HSL path.
 *
 * @param {Uint8ClampedArray} inputData - Source pixel data (RGBA)
 * @param {Uint8ClampedArray} outputData - Destination pixel data (RGBA)
 * @param {number} pixelCount - Total pixel count (width * height)
 * @param {object} params - Pre-computed adjustment parameters
 * @param {string} quality - 'preview' or 'full'
 * @param {function} [onProgress] - Optional progress callback(percent)
 * @param {number} [chunkSize=500000] - Pixels per progress chunk
 */
export function applyAdjustmentsToPixels(inputData, outputData, pixelCount, params, quality = 'full', onProgress = null, chunkSize = 500000) {
  const {
    rMult, gMult, bMult,
    contrastFactor, doContrast,
    highlightsFactor, shadowsFactor,
    doHighlights, doShadows,
    tempRMult, tempBMult, tintGMult,
    doTempTint,
    satFactor, vibFactor, doHsl,
    cmyRShift, cmyGShift, cmyBShift, doCMY,
    curveR, curveG, curveB
  } = params;

  const lumaScale = 2 / 255;
  const totalBytes = pixelCount * 4;

  // Fast path: LUT-only when no highlights/shadows/HSL
  if (!doHighlights && !doShadows && !doHsl) {
    const lutR = new Uint8Array(256);
    const lutG = new Uint8Array(256);
    const lutB = new Uint8Array(256);
    buildChannelLuts({
      lutR, lutG, lutB,
      curveR, curveG, curveB,
      rMult, gMult, bMult,
      contrastFactor, doContrast,
      doTempTint, tempRMult, tintGMult, tempBMult,
      doCMY, cmyRShift, cmyGShift, cmyBShift
    });

    let progressNext = chunkSize * 4;
    for (let i = 0; i < totalBytes; i += 4) {
      outputData[i] = lutR[inputData[i]];
      outputData[i + 1] = lutG[inputData[i + 1]];
      outputData[i + 2] = lutB[inputData[i + 2]];
      outputData[i + 3] = 255;

      if (onProgress && i >= progressNext) {
        onProgress((i / totalBytes) * 100);
        progressNext = i + chunkSize * 4;
      }
    }
    if (onProgress) onProgress(100);
    return;
  }

  // Full path with highlights/shadows/HSL
  let progressNext = chunkSize * 4;
  for (let i = 0; i < totalBytes; i += 4) {
    let r = inputData[i] * rMult;
    let g = inputData[i + 1] * gMult;
    let b = inputData[i + 2] * bMult;

    if (doContrast) {
      r = (r - 127.5) * contrastFactor + 127.5;
      g = (g - 127.5) * contrastFactor + 127.5;
      b = (b - 127.5) * contrastFactor + 127.5;
    }

    if (doHighlights || doShadows) {
      const luma = (r * 0.299 + g * 0.587 + b * 0.114);
      if (doHighlights && luma > 127.5) {
        const mult = 1 + highlightsFactor * (luma - 127.5) * lumaScale;
        r *= mult; g *= mult; b *= mult;
      }
      if (doShadows && luma < 127.5) {
        const mult = 1 + shadowsFactor * (127.5 - luma) * lumaScale;
        r *= mult; g *= mult; b *= mult;
      }
    }

    if (doTempTint) {
      r *= tempRMult;
      b *= tempBMult;
      g *= tintGMult;
    }

    if (r < 0) r = 0; else if (r > 255) r = 255;
    if (g < 0) g = 0; else if (g > 255) g = 255;
    if (b < 0) b = 0; else if (b > 255) b = 255;

    if (!doHsl) {
      r = (r + 0.5) | 0;
      g = (g + 0.5) | 0;
      b = (b + 0.5) | 0;
    }

    if (doHsl) {
      if (quality === 'preview') {
        const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
        const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
        const hsvSat = max <= 0 ? 0 : (max - min) / max;
        let vibScale = 1;
        if (vibFactor >= 0) vibScale = 1 + vibFactor * (1 - hsvSat);
        else vibScale = 1 + vibFactor;
        const scale = satFactor * vibScale;
        const gray = (r * 0.299 + g * 0.587 + b * 0.114);
        r = gray + (r - gray) * scale;
        g = gray + (g - gray) * scale;
        b = gray + (b - gray) * scale;
        if (r < 0) r = 0; else if (r > 255) r = 255;
        if (g < 0) g = 0; else if (g > 255) g = 255;
        if (b < 0) b = 0; else if (b > 255) b = 255;
        r = (r + 0.5) | 0;
        g = (g + 0.5) | 0;
        b = (b + 0.5) | 0;
      } else {
        let rn = r / 255;
        let gn = g / 255;
        let bn = b / 255;

        const max = rn > gn ? (rn > bn ? rn : bn) : (gn > bn ? gn : bn);
        const min = rn < gn ? (rn < bn ? rn : bn) : (gn < bn ? gn : bn);
        let h = 0;
        let s = 0;
        const l = (max + min) / 2;

        if (max !== min) {
          const d = max - min;
          s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
          if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
          else if (max === gn) h = (bn - rn) / d + 2;
          else h = (rn - gn) / d + 4;
          h /= 6;
        }

        s *= satFactor;
        if (vibFactor >= 0) s += (1 - s) * vibFactor;
        else s *= (1 + vibFactor);
        if (s < 0) s = 0; else if (s > 1) s = 1;

        if (s === 0) {
          const v = Math.round(l * 255);
          r = v; g = v; b = v;
        } else {
          const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
          const p = 2 * l - q;
          rn = hue2rgb(p, q, h + 1 / 3);
          gn = hue2rgb(p, q, h);
          bn = hue2rgb(p, q, h - 1 / 3);
          r = Math.round(rn * 255);
          g = Math.round(gn * 255);
          b = Math.round(bn * 255);
        }
      }
    }

    if (doCMY) {
      r -= cmyRShift;
      g -= cmyGShift;
      b -= cmyBShift;

      if (r < 0) r = 0; else if (r > 255) r = 255;
      if (g < 0) g = 0; else if (g > 255) g = 255;
      if (b < 0) b = 0; else if (b > 255) b = 255;
    }

    r = curveR[(r + 0.5) | 0];
    g = curveG[(g + 0.5) | 0];
    b = curveB[(b + 0.5) | 0];

    outputData[i] = r;
    outputData[i + 1] = g;
    outputData[i + 2] = b;
    outputData[i + 3] = 255;

    if (onProgress && i >= progressNext) {
      onProgress((i / totalBytes) * 100);
      progressNext = i + chunkSize * 4;
    }
  }
  if (onProgress) onProgress(100);
}

/**
 * Compute adjustment parameters from settings object.
 * This extracts pure numeric computations that don't depend on DOM state.
 */
export function computeAdjustmentParams(settings) {
  const exposureMult = Math.pow(2, settings.exposure || 0);
  const contrastFactor = 1 + ((settings.contrast || 0) / 100);
  const tempFactor = (settings.temperature || 0) / 100;
  const tintFactor = (settings.tint || 0) / 100;
  const satFactor = 1 + ((settings.saturation || 0) / 100);
  const vibFactor = (settings.vibrance || 0) / 100;
  const highlightsFactor = (settings.highlights || 0) / 100;
  const shadowsFactor = (settings.shadows || 0) / 100;

  const rMult = (settings.wbR || 1) * exposureMult;
  const gMult = (settings.wbG || 1) * exposureMult;
  const bMult = (settings.wbB || 1) * exposureMult;

  const tempRMult = 1 + tempFactor * 0.3;
  const tempBMult = 1 - tempFactor * 0.3;
  const tintGMult = 1 + tintFactor * 0.3;

  const cmyRShift = (settings.cyan || 0) * 2.55;
  const cmyGShift = (settings.magenta || 0) * 2.55;
  const cmyBShift = (settings.yellow || 0) * 2.55;

  const doContrast = contrastFactor !== 1;
  const doHighlights = highlightsFactor !== 0;
  const doShadows = shadowsFactor !== 0;
  const doTempTint = tempFactor !== 0 || tintFactor !== 0;
  const doHsl = satFactor !== 1 || vibFactor !== 0;
  const doCMY = cmyRShift !== 0 || cmyGShift !== 0 || cmyBShift !== 0;

  return {
    rMult, gMult, bMult,
    contrastFactor, doContrast,
    highlightsFactor, shadowsFactor,
    doHighlights, doShadows,
    tempRMult, tempBMult, tintGMult,
    doTempTint,
    satFactor, vibFactor, doHsl,
    cmyRShift, cmyGShift, cmyBShift, doCMY,
    curveR: settings.curves.r,
    curveG: settings.curves.g,
    curveB: settings.curves.b
  };
}

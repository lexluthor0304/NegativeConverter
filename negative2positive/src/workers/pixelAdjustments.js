/**
 * Pure pixel adjustment functions extracted from main.js for use in Web Workers.
 * No DOM dependencies — operates only on typed arrays and plain objects.
 */
import { buildExpiredRescueStages, buildExpiredSpatialStage, applyExpiredSpatial, applyExpiredTone } from '../pipeline/expiredRescue.js';

// Linear interpolation of a 256-entry float curve at a fractional position.
function lerpCurve(curve, x) {
  if (x <= 0) return curve[0];
  if (x >= 255) return curve[255];
  const i = x | 0;
  const f = x - i;
  return curve[i] + (curve[i + 1] - curve[i]) * f;
}

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
  doCMY, cmyRShift, cmyGShift, cmyBShift,
  rescueR = null, rescueG = null, rescueB = null
}) {
  for (let v = 0; v < 256; v++) {
    // The expired-film rescue reshapes the positive before every other control.
    let r = (rescueR ? rescueR[v] : v) * rMult;
    let g = (rescueG ? rescueG[v] : v) * gMult;
    let b = (rescueB ? rescueB[v] : v) * bMult;

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
 * @param {object} [lutScratch] - Optional reusable { lutR, lutG, lutB } buffers
 */
export function applyAdjustmentsToPixels(inputData, outputData, pixelCount, params, quality = 'full', onProgress = null, chunkSize = 500000, lutScratch = null) {
  const {
    rMult, gMult, bMult,
    contrastFactor, doContrast,
    highlightsFactor, shadowsFactor,
    doHighlights, doShadows,
    tempRMult, tempBMult, tintGMult,
    doTempTint,
    satFactor, vibFactor, doHsl,
    cmyRShift, cmyGShift, cmyBShift, doCMY,
    curveR, curveG, curveB,
    doLook, doLookMatrix, lookMatrix, lookOffset, lookR, lookG, lookB,
    rescueR, rescueG, rescueB, doRescueSpatial, rescueSpatial, doRescuePixel, rescueStages, frameWidth, frameHeight
  } = params;

  const lumaScale = 2 / 255;
  const totalBytes = pixelCount * 4;

  // Fast path: LUT-only when no highlights/shadows/HSL, no cross-channel look
  // matrix and no per-pixel rescue stage (position or luminance dependent)
  if (!doHighlights && !doShadows && !doHsl && !doLookMatrix && !doRescueSpatial && !doRescuePixel) {
    const lutR = lutScratch && lutScratch.lutR instanceof Uint8Array && lutScratch.lutR.length >= 256
      ? lutScratch.lutR
      : new Uint8Array(256);
    const lutG = lutScratch && lutScratch.lutG instanceof Uint8Array && lutScratch.lutG.length >= 256
      ? lutScratch.lutG
      : new Uint8Array(256);
    const lutB = lutScratch && lutScratch.lutB instanceof Uint8Array && lutScratch.lutB.length >= 256
      ? lutScratch.lutB
      : new Uint8Array(256);
    buildChannelLuts({
      lutR, lutG, lutB,
      curveR, curveG, curveB,
      rMult, gMult, bMult,
      contrastFactor, doContrast,
      doTempTint, tempRMult, tintGMult, tempBMult,
      doCMY, cmyRShift, cmyGShift, cmyBShift,
      rescueR, rescueG, rescueB
    });
    if (doLook && lookR) {
      // A per-channel look curve folds into the channel LUTs.
      for (let v = 0; v < 256; v++) {
        lutR[v] = lookR[lutR[v]];
        lutG[v] = lookG[lutG[v]];
        lutB[v] = lookB[lutB[v]];
      }
    }

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
  // The spatial rescue stage needs each pixel's position in the frame; the
  // luminance-indexed crossover needs the whole pixel. Both run here.
  const spatialWidth = doRescueSpatial && frameWidth > 0 ? frameWidth : 0;
  const spatialHeight = doRescueSpatial && frameHeight > 0 ? frameHeight : 1;
  const rescuePx = doRescueSpatial || doRescuePixel ? new Float32Array(3) : null;
  let px = 0;
  let py = 0;
  for (let i = 0; i < totalBytes; i += 4) {
    let r;
    let g;
    let b;
    if (rescuePx) {
      rescuePx[0] = inputData[i];
      rescuePx[1] = inputData[i + 1];
      rescuePx[2] = inputData[i + 2];
      if (spatialWidth) {
        applyExpiredSpatial(rescueSpatial, (px + 0.5) / spatialWidth, (py + 0.5) / spatialHeight, rescuePx);
        if (++px === spatialWidth) { px = 0; py++; }
      }
      if (doRescuePixel) {
        applyExpiredTone(rescueStages, rescuePx);
      } else if (rescueR) {
        rescuePx[0] = lerpCurve(rescueR, rescuePx[0]);
        rescuePx[1] = lerpCurve(rescueG, rescuePx[1]);
        rescuePx[2] = lerpCurve(rescueB, rescuePx[2]);
      }
      r = rescuePx[0] * rMult;
      g = rescuePx[1] * gMult;
      b = rescuePx[2] * bMult;
    } else {
      r = (rescueR ? rescueR[inputData[i]] : inputData[i]) * rMult;
      g = (rescueG ? rescueG[inputData[i + 1]] : inputData[i + 1]) * gMult;
      b = (rescueB ? rescueB[inputData[i + 2]] : inputData[i + 2]) * bMult;
    }

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

    if (doLook) {
      // Lab-match look: 3x3 matrix with offset, then per-channel curves.
      if (doLookMatrix) {
        const lr = lookMatrix[0] * r + lookMatrix[1] * g + lookMatrix[2] * b + lookOffset[0];
        const lg = lookMatrix[3] * r + lookMatrix[4] * g + lookMatrix[5] * b + lookOffset[1];
        const lb = lookMatrix[6] * r + lookMatrix[7] * g + lookMatrix[8] * b + lookOffset[2];
        r = lr < 0 ? 0 : lr > 255 ? 255 : lr;
        g = lg < 0 ? 0 : lg > 255 ? 255 : lg;
        b = lb < 0 ? 0 : lb > 255 ? 255 : lb;
      }
      if (lookR) {
        r = lookR[(r + 0.5) | 0];
        g = lookG[(g + 0.5) | 0];
        b = lookB[(b + 0.5) | 0];
      }
    }

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
 * True when a 256-entry curve LUT maps every input to itself.
 * @param {ArrayLike<number>} curve
 */
export function isIdentityCurve(curve) {
  if (!curve || curve.length < 256) return false;
  for (let v = 0; v < 256; v++) {
    if (curve[v] !== v) return false;
  }
  return true;
}

/**
 * True when applyAdjustmentsToPixels would copy the RGB channels through
 * unchanged (alpha is always forced opaque).
 *
 * This stage is 8-bit only — it reads and writes Uint8ClampedArray and builds
 * 256-entry LUTs — so any non-identity adjustment quantises the image to 8 bits.
 * Callers use this to decide whether the engine's 16-bit plane still describes
 * the result and can therefore be exported at full precision.
 *
 * @param {object} params - Output of computeAdjustmentParams
 */
export function isIdentityAdjustmentParams(params) {
  if (!params) return false;
  return params.rMult === 1
    && params.gMult === 1
    && params.bMult === 1
    && !params.doContrast
    && !params.doHighlights
    && !params.doShadows
    && !params.doTempTint
    && !params.doHsl
    && !params.doCMY
    && !params.doLook
    && !params.doRescue
    && isIdentityCurve(params.curveR)
    && isIdentityCurve(params.curveG)
    && isIdentityCurve(params.curveB);
}

/**
 * Compute adjustment parameters from settings object.
 * This extracts pure numeric computations that don't depend on DOM state.
 * `frame` ({ width, height }) is needed only by the position-dependent
 * expired-film stage; without it that stage is left out.
 */
export function computeAdjustmentParams(settings, frame = null) {
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

  // Lab-match look (see labMatch.js): identity matrix and null curves mean off.
  const look = settings.look && typeof settings.look === 'object' ? settings.look : null;
  const identityMatrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const lookMatrix = look && Array.isArray(look.matrix) && look.matrix.length === 9 ? look.matrix : identityMatrix;
  const lookOffset = look && Array.isArray(look.offset) && look.offset.length === 3 ? look.offset : [0, 0, 0];
  const doLookMatrix = Boolean(look) && (lookMatrix.some((v, i) => Math.abs(v - identityMatrix[i]) > 1e-6) || lookOffset.some((v) => Math.abs(v) > 1e-6));
  const lookCurves = look && look.curves && look.curves.r && look.curves.g && look.curves.b ? look.curves : null;
  const doLookCurves = Boolean(lookCurves) && !(isIdentityCurve(lookCurves.r) && isIdentityCurve(lookCurves.g) && isIdentityCurve(lookCurves.b));
  const doLook = doLookMatrix || doLookCurves;

  // Expired-film rescue (see pipeline/expiredRescue.js): tone stages rebuilt
  // from the stored analysis and strengths; null when off. With the
  // luminance-indexed crossover active the stages run per pixel, otherwise
  // they compose into one curve per channel for the LUT path.
  const rescueStages = buildExpiredRescueStages(settings);
  const doRescue = Boolean(rescueStages);
  const rescue = rescueStages ? rescueStages.composed : null;
  const doRescuePixel = Boolean(rescueStages && !rescueStages.composed);
  const frameWidth = frame && Number.isFinite(frame.width) ? frame.width | 0 : 0;
  const frameHeight = frame && Number.isFinite(frame.height) ? frame.height | 0 : 0;
  const rescueSpatial = rescueStages && frameWidth > 0 && frameHeight > 0 ? buildExpiredSpatialStage(settings) : null;
  const doRescueSpatial = Boolean(rescueSpatial);

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
    curveB: settings.curves.b,
    doLook, doLookMatrix, lookMatrix, lookOffset,
    lookR: doLookCurves ? lookCurves.r : null,
    lookG: doLookCurves ? lookCurves.g : null,
    lookB: doLookCurves ? lookCurves.b : null,
    doRescue,
    rescueR: rescue ? rescue.r : null,
    rescueG: rescue ? rescue.g : null,
    rescueB: rescue ? rescue.b : null,
    doRescueSpatial,
    rescueSpatial,
    doRescuePixel,
    rescueStages,
    frameWidth,
    frameHeight
  };
}

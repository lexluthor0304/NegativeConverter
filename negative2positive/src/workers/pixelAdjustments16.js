// The Step-3 adjustment stage at 16 bits. Same maths as pixelAdjustments.js
// (exposure and WB gains, contrast, highlights / shadows, temperature and
// tint, saturation and vibrance, CMY, curves, the lab-match look), evaluated
// in floating point on the 0..255 scale the controls are defined on, with the
// 256-entry curve LUTs interpolated linearly so the output keeps far more
// than 256 distinct levels per channel. Reads and writes 16-bit RGBA planes.
// No DOM: shared by the export worker and the main-thread fallback.

import { hue2rgb } from './pixelAdjustments.js';
import { applyExpiredSpatial } from '../pipeline/expiredRescue.js';

const SCALE_16_TO_8 = 255 / 65535;
const SCALE_8_TO_16 = 65535 / 255;

/** Linear interpolation of a 256-entry curve at a fractional 0..255 position. */
export function curveAt(curve, x) {
  if (x <= 0) return curve[0];
  if (x >= 255) return curve[255];
  const i = x | 0;
  const f = x - i;
  return curve[i] + (curve[i + 1] - curve[i]) * f;
}

// True when the chain has no stage that mixes channels or depends on the
// pixel's neighbours in colour space, so a per-channel LUT reproduces it.
function isSeparable(params) {
  return !params.doHighlights && !params.doShadows && !params.doHsl && !params.doLookMatrix && !params.doRescueSpatial;
}

// The per-channel chain for one channel value (0..255 float) of a separable
// pipeline: expired-film rescue, gains, contrast, temp/tint, CMY, curve, look curve.
function channelChain(v, mult, tempMult, cmyShift, curve, lookCurve, params, rescue = null) {
  let x = (rescue ? curveAt(rescue, v) : v) * mult;
  if (params.doContrast) x = (x - 127.5) * params.contrastFactor + 127.5;
  if (params.doTempTint) x *= tempMult;
  if (x < 0) x = 0; else if (x > 255) x = 255;
  if (params.doCMY) {
    x -= cmyShift;
    if (x < 0) x = 0; else if (x > 255) x = 255;
  }
  x = curveAt(curve, x);
  if (lookCurve) x = curveAt(lookCurve, x);
  return x;
}

/**
 * Builds three 65536-entry Uint16 LUTs for a separable pipeline.
 * @returns {{lutR: Uint16Array, lutG: Uint16Array, lutB: Uint16Array}}
 */
export function buildChannelLuts16(params, scratch = null) {
  const make = (key) => (scratch && scratch[key] instanceof Uint16Array && scratch[key].length >= 65536 ? scratch[key] : new Uint16Array(65536));
  const lutR = make('lutR'); const lutG = make('lutG'); const lutB = make('lutB');
  const { curveR, curveG, curveB, lookR, lookG, lookB } = params;
  const lookCurves = params.doLook && lookR ? [lookR, lookG, lookB] : [null, null, null];
  const rescue = params.doRescue ? [params.rescueR, params.rescueG, params.rescueB] : [null, null, null];
  for (let v = 0; v < 65536; v++) {
    const x = v * SCALE_16_TO_8;
    lutR[v] = Math.round(channelChain(x, params.rMult, params.tempRMult, params.cmyRShift, curveR, lookCurves[0], params, rescue[0]) * SCALE_8_TO_16);
    lutG[v] = Math.round(channelChain(x, params.gMult, params.tintGMult, params.cmyGShift, curveG, lookCurves[1], params, rescue[1]) * SCALE_8_TO_16);
    lutB[v] = Math.round(channelChain(x, params.bMult, params.tempBMult, params.cmyBShift, curveB, lookCurves[2], params, rescue[2]) * SCALE_8_TO_16);
  }
  return { lutR, lutG, lutB };
}

/**
 * Applies the adjustments to a 16-bit RGBA plane.
 *
 * @param {Uint16Array} input16 - RGBA samples 0..65535
 * @param {Uint16Array} output16 - destination, same length; alpha is forced opaque
 * @param {number} pixelCount
 * @param {object} params - computeAdjustmentParams(settings)
 * @param {'preview'|'full'} [quality]
 * @param {function} [onProgress]
 * @param {number} [chunkSize]
 * @param {object} [lutScratch] - reusable { lutR, lutG, lutB } Uint16Array(65536)
 */
export function applyAdjustmentsToPixels16(input16, output16, pixelCount, params, quality = 'full', onProgress = null, chunkSize = 500000, lutScratch = null) {
  const total = pixelCount * 4;
  let progressNext = chunkSize * 4;

  if (isSeparable(params)) {
    const { lutR, lutG, lutB } = buildChannelLuts16(params, lutScratch);
    for (let i = 0; i < total; i += 4) {
      output16[i] = lutR[input16[i]];
      output16[i + 1] = lutG[input16[i + 1]];
      output16[i + 2] = lutB[input16[i + 2]];
      output16[i + 3] = 65535;
      if (onProgress && i >= progressNext) {
        onProgress((i / total) * 100);
        progressNext = i + chunkSize * 4;
      }
    }
    if (onProgress) onProgress(100);
    return;
  }

  const {
    rMult, gMult, bMult, contrastFactor, doContrast, highlightsFactor, shadowsFactor, doHighlights, doShadows,
    tempRMult, tempBMult, tintGMult, doTempTint, satFactor, vibFactor, doHsl, cmyRShift, cmyGShift, cmyBShift, doCMY,
    curveR, curveG, curveB, doLook, doLookMatrix, lookMatrix, lookOffset, lookR, lookG, lookB,
    doRescue, rescueR, rescueG, rescueB, doRescueSpatial, rescueSpatial, frameWidth, frameHeight
  } = params;
  const lumaScale = 2 / 255;
  const spatialWidth = doRescueSpatial && frameWidth > 0 ? frameWidth : 0;
  const spatialHeight = doRescueSpatial && frameHeight > 0 ? frameHeight : 1;
  const spatialPx = doRescueSpatial ? new Float32Array(3) : null;
  let px = 0;
  let py = 0;

  for (let i = 0; i < total; i += 4) {
    let r = input16[i] * SCALE_16_TO_8;
    let g = input16[i + 1] * SCALE_16_TO_8;
    let b = input16[i + 2] * SCALE_16_TO_8;
    if (spatialWidth) {
      spatialPx[0] = r; spatialPx[1] = g; spatialPx[2] = b;
      applyExpiredSpatial(rescueSpatial, (px + 0.5) / spatialWidth, (py + 0.5) / spatialHeight, spatialPx);
      if (++px === spatialWidth) { px = 0; py++; }
      r = spatialPx[0]; g = spatialPx[1]; b = spatialPx[2];
    }
    if (doRescue) {
      r = curveAt(rescueR, r);
      g = curveAt(rescueG, g);
      b = curveAt(rescueB, b);
    }
    r *= rMult;
    g *= gMult;
    b *= bMult;

    if (doContrast) {
      r = (r - 127.5) * contrastFactor + 127.5;
      g = (g - 127.5) * contrastFactor + 127.5;
      b = (b - 127.5) * contrastFactor + 127.5;
    }
    if (doHighlights || doShadows) {
      const luma = r * 0.299 + g * 0.587 + b * 0.114;
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

    if (doHsl) {
      if (quality === 'preview') {
        const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
        const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
        const hsvSat = max <= 0 ? 0 : (max - min) / max;
        const vibScale = vibFactor >= 0 ? 1 + vibFactor * (1 - hsvSat) : 1 + vibFactor;
        const scale = satFactor * vibScale;
        const gray = r * 0.299 + g * 0.587 + b * 0.114;
        r = gray + (r - gray) * scale;
        g = gray + (g - gray) * scale;
        b = gray + (b - gray) * scale;
      } else {
        let rn = r / 255; let gn = g / 255; let bn = b / 255;
        const max = rn > gn ? (rn > bn ? rn : bn) : (gn > bn ? gn : bn);
        const min = rn < gn ? (rn < bn ? rn : bn) : (gn < bn ? gn : bn);
        let h = 0; let s = 0;
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
          r = g = b = l * 255;
        } else {
          const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
          const p = 2 * l - q;
          r = hue2rgb(p, q, h + 1 / 3) * 255;
          g = hue2rgb(p, q, h) * 255;
          b = hue2rgb(p, q, h - 1 / 3) * 255;
        }
      }
      if (r < 0) r = 0; else if (r > 255) r = 255;
      if (g < 0) g = 0; else if (g > 255) g = 255;
      if (b < 0) b = 0; else if (b > 255) b = 255;
    }

    if (doCMY) {
      r -= cmyRShift; g -= cmyGShift; b -= cmyBShift;
      if (r < 0) r = 0; else if (r > 255) r = 255;
      if (g < 0) g = 0; else if (g > 255) g = 255;
      if (b < 0) b = 0; else if (b > 255) b = 255;
    }

    r = curveAt(curveR, r);
    g = curveAt(curveG, g);
    b = curveAt(curveB, b);

    if (doLook) {
      if (doLookMatrix) {
        const lr = lookMatrix[0] * r + lookMatrix[1] * g + lookMatrix[2] * b + lookOffset[0];
        const lg = lookMatrix[3] * r + lookMatrix[4] * g + lookMatrix[5] * b + lookOffset[1];
        const lb = lookMatrix[6] * r + lookMatrix[7] * g + lookMatrix[8] * b + lookOffset[2];
        r = lr < 0 ? 0 : lr > 255 ? 255 : lr;
        g = lg < 0 ? 0 : lg > 255 ? 255 : lg;
        b = lb < 0 ? 0 : lb > 255 ? 255 : lb;
      }
      if (lookR) {
        r = curveAt(lookR, r);
        g = curveAt(lookG, g);
        b = curveAt(lookB, b);
      }
    }

    output16[i] = Math.round(r * SCALE_8_TO_16);
    output16[i + 1] = Math.round(g * SCALE_8_TO_16);
    output16[i + 2] = Math.round(b * SCALE_8_TO_16);
    output16[i + 3] = 65535;

    if (onProgress && i >= progressNext) {
      onProgress((i / total) * 100);
      progressNext = i + chunkSize * 4;
    }
  }
  if (onProgress) onProgress(100);
}

/** 8-bit view (high byte) of a 16-bit RGBA plane, for display. */
export function downconvertPlane16(input16, output8) {
  for (let i = 0; i < input16.length; i++) output8[i] = input16[i] >>> 8;
  return output8;
}

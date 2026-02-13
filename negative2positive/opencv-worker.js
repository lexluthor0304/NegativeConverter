import { ensureCvReady } from './opencvBridge.js';

let cvInstance = null;
let cvInitAttempted = false;
let cvInitError = null;

async function tryEnsureCvReady() {
  if (cvInstance) return cvInstance;
  if (cvInitAttempted) return null;
  cvInitAttempted = true;
  try {
    cvInstance = await ensureCvReady();
    return cvInstance;
  } catch (err) {
    cvInitError = err;
    return null;
  }
}

function buildAutoMask(cv, rgba, width, height, autoStrength) {
  const src = cv.matFromArray(height, width, cv.CV_8UC4, rgba);
  const gray = new cv.Mat();
  const topHat = new cv.Mat();
  const blackHat = new cv.Mat();
  const combined = new cv.Mat();
  const binary = new cv.Mat();
  const refined = new cv.Mat();
  const kernelSmall = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
  const kernelLarge = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.morphologyEx(gray, topHat, cv.MORPH_TOPHAT, kernelLarge);
    cv.morphologyEx(gray, blackHat, cv.MORPH_BLACKHAT, kernelLarge);
    cv.addWeighted(topHat, 1, blackHat, 1, 0, combined);

    const clampedStrength = Math.max(0, Math.min(100, autoStrength || 0));
    const threshold = Math.max(8, Math.min(60, Math.round(48 - clampedStrength * 0.35)));
    cv.threshold(combined, binary, threshold, 255, cv.THRESH_BINARY);
    cv.morphologyEx(binary, refined, cv.MORPH_OPEN, kernelSmall);
    cv.morphologyEx(refined, refined, cv.MORPH_CLOSE, kernelSmall);

    return refined.clone();
  } finally {
    src.delete();
    gray.delete();
    topHat.delete();
    blackHat.delete();
    combined.delete();
    binary.delete();
    refined.delete();
    kernelSmall.delete();
    kernelLarge.delete();
  }
}

function buildManualMask(cv, rgbaMask, width, height) {
  const out = new cv.Mat(height, width, cv.CV_8UC1, new cv.Scalar(0));
  if (!rgbaMask) return out;

  const mask = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < rgbaMask.length; i += 4, p++) {
    const alpha = rgbaMask[i + 3];
    const lum = (rgbaMask[i] + rgbaMask[i + 1] + rgbaMask[i + 2]) / 3;
    mask[p] = (alpha > 0 || lum > 10) ? 255 : 0;
  }
  out.data.set(mask);
  return out;
}

function combineMasks(cv, autoMask, manualMask) {
  if (autoMask && manualMask) {
    const merged = new cv.Mat();
    cv.bitwise_or(autoMask, manualMask, merged);
    return merged;
  }
  if (autoMask) return autoMask.clone();
  if (manualMask) return manualMask.clone();
  return null;
}

function runInpaint(cv, rgba, width, height, mask, radius) {
  const src = cv.matFromArray(height, width, cv.CV_8UC4, rgba);
  const rgb = new cv.Mat();
  const restored = new cv.Mat();
  const out = new cv.Mat();

  try {
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    cv.inpaint(rgb, mask, restored, Math.max(1, Math.min(20, radius || 3)), cv.INPAINT_TELEA);
    cv.cvtColor(restored, out, cv.COLOR_RGB2RGBA);
    return out.data.slice().buffer;
  } finally {
    src.delete();
    rgb.delete();
    restored.delete();
    out.delete();
  }
}

function buildManualMaskArray(rgbaMask, width, height) {
  const mask = new Uint8Array(width * height);
  if (!rgbaMask) return mask;
  for (let i = 0, p = 0; i < rgbaMask.length; i += 4, p++) {
    const alpha = rgbaMask[i + 3];
    const lum = (rgbaMask[i] + rgbaMask[i + 1] + rgbaMask[i + 2]) / 3;
    if (alpha > 0 || lum > 10) mask[p] = 255;
  }
  return mask;
}

function buildAutoMaskArray(rgba, width, height, autoStrength) {
  const mask = new Uint8Array(width * height);
  const threshold = Math.max(8, Math.min(60, 46 - (Math.max(0, Math.min(100, autoStrength || 0)) * 0.32)));

  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const p = row + x;
      const centerIdx = p * 4;
      const g = rgba[centerIdx] * 0.299 + rgba[centerIdx + 1] * 0.587 + rgba[centerIdx + 2] * 0.114;

      let sum = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const q = ((y + dy) * width + (x + dx)) * 4;
          sum += rgba[q] * 0.299 + rgba[q + 1] * 0.587 + rgba[q + 2] * 0.114;
          count++;
        }
      }

      const mean = count > 0 ? (sum / count) : g;
      const diff = Math.abs(g - mean);
      if (diff > threshold && (g < 38 || g > 220 || diff > threshold * 1.55)) {
        mask[p] = 255;
      }
    }
  }

  if (autoStrength >= 55) {
    const expanded = new Uint8Array(mask);
    for (let y = 1; y < height - 1; y++) {
      const row = y * width;
      for (let x = 1; x < width - 1; x++) {
        const p = row + x;
        if (mask[p]) continue;
        let hit = false;
        for (let dy = -1; dy <= 1 && !hit; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (mask[(y + dy) * width + (x + dx)]) {
              hit = true;
              break;
            }
          }
        }
        if (hit) expanded[p] = 255;
      }
    }
    return expanded;
  }

  return mask;
}

function mergeMaskArrays(maskA, maskB) {
  if (!maskA && !maskB) return null;
  if (!maskA) return new Uint8Array(maskB);
  if (!maskB) return new Uint8Array(maskA);
  const out = new Uint8Array(maskA.length);
  for (let i = 0; i < out.length; i++) out[i] = (maskA[i] || maskB[i]) ? 255 : 0;
  return out;
}

function countMaskPixels(mask) {
  if (!mask) return 0;
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) count++;
  }
  return count;
}

function inpaintFallback(rgba, width, height, mergedMask, radius = 3) {
  const out = new Uint8ClampedArray(rgba);
  let pending = new Uint8Array(mergedMask);
  let remaining = countMaskPixels(pending);
  if (remaining === 0) return out.buffer;

  const baseRadius = Math.max(1, Math.min(20, Math.round(radius || 3)));
  const maxPasses = Math.max(4, Math.min(24, baseRadius * 5));

  for (let pass = 0; pass < maxPasses && remaining > 0; pass++) {
    const next = new Uint8Array(pending);
    let changed = 0;

    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const p = row + x;
        if (!pending[p]) continue;

        let sumR = 0;
        let sumG = 0;
        let sumB = 0;
        let wSum = 0;

        for (let dy = -baseRadius; dy <= baseRadius; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -baseRadius; dx <= baseRadius; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= width) continue;
            const d2 = dx * dx + dy * dy;
            if (d2 === 0 || d2 > baseRadius * baseRadius) continue;
            const q = ny * width + nx;
            if (pending[q]) continue;
            const w = 1 / (1 + d2);
            const idx = q * 4;
            sumR += out[idx] * w;
            sumG += out[idx + 1] * w;
            sumB += out[idx + 2] * w;
            wSum += w;
          }
        }

        if (wSum > 0) {
          const outIdx = p * 4;
          out[outIdx] = Math.round(sumR / wSum);
          out[outIdx + 1] = Math.round(sumG / wSum);
          out[outIdx + 2] = Math.round(sumB / wSum);
          out[outIdx + 3] = 255;
          next[p] = 0;
          changed++;
          remaining--;
        }
      }
    }

    pending = next;
    if (changed > 0) continue;

    const nextWide = new Uint8Array(pending);
    let changedWide = 0;
    const maxWideRadius = baseRadius + 6;

    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const p = row + x;
        if (!pending[p]) continue;

        let found = false;
        let bestIdx = -1;
        let bestDist = Infinity;

        for (let r = baseRadius + 1; r <= maxWideRadius && !found; r++) {
          for (let dy = -r; dy <= r; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= height) continue;
            for (let dx = -r; dx <= r; dx++) {
              if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
              const nx = x + dx;
              if (nx < 0 || nx >= width) continue;
              const q = ny * width + nx;
              if (pending[q]) continue;
              const d2 = dx * dx + dy * dy;
              if (d2 < bestDist) {
                bestDist = d2;
                bestIdx = q;
                found = true;
              }
            }
          }
        }

        if (bestIdx >= 0) {
          const srcIdx = bestIdx * 4;
          const outIdx = p * 4;
          out[outIdx] = out[srcIdx];
          out[outIdx + 1] = out[srcIdx + 1];
          out[outIdx + 2] = out[srcIdx + 2];
          out[outIdx + 3] = 255;
          nextWide[p] = 0;
          changedWide++;
          remaining--;
        }
      }
    }

    pending = nextWide;
    if (changedWide === 0) break;
  }

  return out.buffer;
}

function runRetouchFallback(rgba, width, height, manualMaskRgba, autoEnabled, autoStrength, inpaintRadius, includeMask) {
  const manualMask = buildManualMaskArray(manualMaskRgba, width, height);
  const autoMask = autoEnabled ? buildAutoMaskArray(rgba, width, height, autoStrength) : null;
  const mergedMask = mergeMaskArrays(manualMask, autoMask);
  const changedPixels = countMaskPixels(mergedMask);
  if (changedPixels === 0) {
    return {
      outBuffer: rgba.buffer,
      applied: false,
      changedPixels: 0,
      maskBuffer: null,
      backend: 'fallback'
    };
  }

  return {
    outBuffer: inpaintFallback(rgba, width, height, mergedMask, inpaintRadius),
    applied: true,
    changedPixels,
    maskBuffer: includeMask ? new Uint8Array(mergedMask).buffer : null,
    backend: 'fallback'
  };
}

function runRetouchOpenCv(cv, rgba, width, height, manualMaskRgba, autoEnabled, autoStrength, inpaintRadius, includeMask) {
  let autoMask = null;
  let manualMask = null;
  let mergedMask = null;

  try {
    if (autoEnabled) {
      autoMask = buildAutoMask(cv, rgba, width, height, autoStrength);
    }
    manualMask = buildManualMask(cv, manualMaskRgba, width, height);
    mergedMask = combineMasks(cv, autoMask, manualMask);

    const changedPixels = mergedMask ? cv.countNonZero(mergedMask) : 0;
    if (changedPixels === 0) {
      return {
        outBuffer: rgba.buffer,
        applied: false,
        changedPixels: 0,
        maskBuffer: null,
        backend: 'opencv'
      };
    }

    return {
      outBuffer: runInpaint(cv, rgba, width, height, mergedMask, inpaintRadius),
      applied: true,
      changedPixels,
      maskBuffer: includeMask ? new Uint8Array(mergedMask.data).buffer : null,
      backend: 'opencv'
    };
  } finally {
    if (autoMask) autoMask.delete();
    if (manualMask) manualMask.delete();
    if (mergedMask) mergedMask.delete();
  }
}

self.onmessage = async (event) => {
  const payload = event.data || {};

  if (payload.type === 'init') {
    await tryEnsureCvReady();
    self.postMessage({
      type: 'ready',
      backend: cvInstance ? 'opencv' : 'fallback',
      warning: cvInstance ? null : String(cvInitError?.message || cvInitError || 'OpenCV init failed')
    });
    return;
  }

  if (payload.type !== 'retouch') return;

  const {
    id,
    width,
    height,
    rgbaBuffer,
    manualMaskBuffer,
    autoEnabled,
    autoStrength,
    inpaintRadius,
    includeMask
  } = payload;

  try {
    const rgba = new Uint8ClampedArray(rgbaBuffer);
    const manualMaskRgba = manualMaskBuffer ? new Uint8ClampedArray(manualMaskBuffer) : null;
    const cv = cvInstance || await tryEnsureCvReady();
    let result;
    if (cv) {
      try {
        result = runRetouchOpenCv(cv, rgba, width, height, manualMaskRgba, !!autoEnabled, autoStrength, inpaintRadius, !!includeMask);
      } catch (opencvErr) {
        result = runRetouchFallback(rgba, width, height, manualMaskRgba, !!autoEnabled, autoStrength, inpaintRadius, !!includeMask);
      }
    } else {
      result = runRetouchFallback(rgba, width, height, manualMaskRgba, !!autoEnabled, autoStrength, inpaintRadius, !!includeMask);
    }

    const transfer = [result.outBuffer];
    if (result.maskBuffer) transfer.push(result.maskBuffer);
    self.postMessage({
      type: 'retouchResult',
      id,
      width,
      height,
      outBuffer: result.outBuffer,
      applied: !!result.applied,
      changedPixels: Number.isFinite(result.changedPixels) ? result.changedPixels : 0,
      maskBuffer: result.maskBuffer || null,
      backend: result.backend || (cv ? 'opencv' : 'fallback')
    }, transfer);
  } catch (err) {
    self.postMessage({
      type: 'error',
      id,
      error: String(err?.message || err || 'Retouch failed')
    });
  }
};

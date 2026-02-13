import { ensureCvReady } from './opencvBridge.js';

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

self.onmessage = async (event) => {
  const payload = event.data || {};

  if (payload.type === 'init') {
    try {
      await ensureCvReady();
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({
        type: 'error',
        id: payload.id || null,
        error: String(err?.message || err || 'OpenCV init failed')
      });
    }
    return;
  }

  if (payload.type !== 'retouch') return;

  const { id, width, height, rgbaBuffer, manualMaskBuffer, autoEnabled, autoStrength, inpaintRadius } = payload;

  try {
    const cv = await ensureCvReady();
    const rgba = new Uint8ClampedArray(rgbaBuffer);
    const manualMaskRgba = manualMaskBuffer ? new Uint8ClampedArray(manualMaskBuffer) : null;

    let autoMask = null;
    let manualMask = null;
    let mergedMask = null;

    try {
      if (autoEnabled) {
        autoMask = buildAutoMask(cv, rgba, width, height, autoStrength);
      }
      manualMask = buildManualMask(cv, manualMaskRgba, width, height);
      mergedMask = combineMasks(cv, autoMask, manualMask);

      const hasMask = mergedMask ? cv.countNonZero(mergedMask) > 0 : false;
      if (!hasMask) {
        self.postMessage({
          type: 'retouchResult',
          id,
          width,
          height,
          outBuffer: rgbaBuffer,
          applied: false
        }, [rgbaBuffer]);
        return;
      }

      const outBuffer = runInpaint(cv, rgba, width, height, mergedMask, inpaintRadius);
      self.postMessage({
        type: 'retouchResult',
        id,
        width,
        height,
        outBuffer,
        applied: true
      }, [outBuffer]);
    } finally {
      if (autoMask) autoMask.delete();
      if (manualMask) manualMask.delete();
      if (mergedMask) mergedMask.delete();
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      id,
      error: String(err?.message || err || 'Retouch failed')
    });
  }
};

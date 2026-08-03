/**
 * DustRemoval.js - Film dust detection and inpainting engine
 *
 * Ported from Python (Scharr edge detection + contour analysis + TELEA inpaint).
 * Uses OpenCV.js when available, with pure-JS fallbacks for missing functions.
 *
 * Pipeline: Scharr edges → threshold → HoughLinesP line exclusion →
 *           highpass filter → contour analysis → dilate → inpaint
 */

// ─── OpenCV.js feature detection ─────────────────────────────────────────────

let _hasScharr = null;
let _hasInpaint = null;
let _hasLine = null;

function cv() {
  return window.cv;
}

function detectFeatures() {
  const c = cv();
  if (!c || !c.Mat) return;
  _hasScharr = typeof c.Scharr === 'function';
  _hasInpaint = typeof c.inpaint === 'function';
  _hasLine = typeof c.line === 'function';
}

function ensureFeatureDetection() {
  if (_hasScharr === null) detectFeatures();
}

// ─── Pure-JS fallback implementations ────────────────────────────────────────

/**
 * 3x3 Scharr convolution (JS fallback).
 * @param {Uint8Array} gray - Grayscale pixel data (h*w)
 * @param {number} w - Width
 * @param {number} h - Height
 * @param {'x'|'y'} direction
 * @returns {Float64Array} Convolution result (CV_64F equivalent)
 */
function scharrJS(gray, w, h, direction) {
  // Scharr kernels
  const kx = [-3, 0, 3, -10, 0, 10, -3, 0, 3];
  const ky = [-3, -10, -3, 0, 0, 0, 3, 10, 3];
  const kernel = direction === 'x' ? kx : ky;
  const out = new Float64Array(w * h);

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let sum = 0;
      for (let ky2 = -1; ky2 <= 1; ky2++) {
        for (let kx2 = -1; kx2 <= 1; kx2++) {
          sum += gray[(y + ky2) * w + (x + kx2)] * kernel[(ky2 + 1) * 3 + (kx2 + 1)];
        }
      }
      out[y * w + x] = sum;
    }
  }
  return out;
}

/**
 * Normalize float array to 0-255 Uint8.
 */
function normalizeToUint8(src, len) {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < len; i++) {
    if (src[i] < min) min = src[i];
    if (src[i] > max) max = src[i];
  }
  const out = new Uint8Array(len);
  const range = max - min || 1;
  for (let i = 0; i < len; i++) {
    out[i] = Math.round(((src[i] - min) / range) * 255);
  }
  return out;
}

/**
 * TELEA-style Fast Marching Method inpainting (JS fallback).
 * Simplified implementation for small masked regions.
 */
function inpaintTeleaJS(imageData, mask, radius) {
  const { width, height, data } = imageData;
  const out = new Uint8ClampedArray(data);
  const r = radius || 3;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] === 0) continue;

      let rSum = 0, gSum = 0, bSum = 0, wSum = 0;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny < 0 || ny >= height || nx < 0 || nx >= width) continue;
          if (mask[ny * width + nx] > 0) continue;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > r) continue;
          const w = 1 / (dist + 0.001);
          const idx = (ny * width + nx) * 4;
          rSum += data[idx] * w;
          gSum += data[idx + 1] * w;
          bSum += data[idx + 2] * w;
          wSum += w;
        }
      }

      if (wSum > 0) {
        const idx = (y * width + x) * 4;
        out[idx] = Math.round(rSum / wSum);
        out[idx + 1] = Math.round(gSum / wSum);
        out[idx + 2] = Math.round(bSum / wSum);
      }
    }
  }
  return out;
}

// ─── Mat utility helpers ─────────────────────────────────────────────────────

/** Convert ImageData (RGBA) to OpenCV Mat (RGBA) */
function imageDataToMat(imageData) {
  const c = cv();
  return c.matFromImageData(imageData);
}

/** Convert single-channel Uint8Array (h*w) to OpenCV Mat */
function uint8ArrayToMat(arr, h, w) {
  const c = cv();
  const mat = new c.Mat(h, w, c.CV_8UC1);
  mat.data.set(arr);
  return mat;
}

/** Convert OpenCV single-channel Mat to Uint8Array */
function matToUint8Array(mat) {
  return new Uint8Array(mat.data);
}

/** Safe mat delete helper */
function deleteMats(...mats) {
  for (const m of mats) {
    if (m && !m.isDeleted()) m.delete();
  }
}

// ─── Core detection algorithm ────────────────────────────────────────────────
//
// Dual morphological top-hat: white top-hat catches bright dust, black top-hat
// catches dark specks; thin scratches respond to both. An adaptive quantile
// threshold keeps only the most anomalous responses, then contours are
// filtered by size, compactness and neighbourhood isolation (dust sits in
// quiet surroundings; photo texture fires densely everywhere around itself).
//
// The previous Scharr+highpass port required highpass values of exactly 255
// for bright defects, so white dust on a positive was structurally
// undetectable (0% recall on the synthetic benchmark in
// scripts/eval-dust.mjs; this pipeline measures ~70% with ~1-2% false area
// and runs ~7x faster).

const DUST_HAT_KERNEL = 9;             // structuring element diameter (px)
const DUST_MAX_AREA_RATIO = 4e-4;      // secondary guard: blobs above this are real image content
const DUST_SCRATCH_ELONGATION = 6;     // bbox aspect at which a blob counts as a scratch
const DUST_MIN_FILL = 0.42;            // blob area / bbox area — texture shards are stringy
const DUST_NEIGHBOR_DENSITY_LIMIT = 0.18; // surrounding response density that marks texture
const DUST_DEFAULT_MAX_SIZE_RATIO = 0.016; // default particle cap as a share of the short edge

/** Default cap on a dust blob's long side, in px, for a given frame size. */
export function defaultMaxParticleSize(width, height) {
  return Math.max(8, Math.round(Math.min(width, height) * DUST_DEFAULT_MAX_SIZE_RATIO));
}

/**
 * Decide whether a thresholded blob is removable dust.
 *
 * The size cap is the primary guard (#113): the old area-ratio-only limit let
 * a single "dust" blob grow to ~110 px across on a 24MP scan, so small lamps
 * and specular highlights were erased. Beyond the spot budget only thin lines
 * survive — a hair can cross half the frame, but its stroke stays a few px
 * wide. Bounding-box thickness fails on diagonal lines, so the stroke width
 * is estimated as area / length; thick elongated shapes (light tubes, bright
 * edges) fail that test and stay.
 *
 * @returns {{ keep: boolean, isScratch: boolean }}
 */
export function classifyDustBlob(rect, area, maxSize, imageWidth, imageHeight) {
  const longSide = Math.max(rect.width, rect.height);
  const maxArea = Math.min(imageWidth * imageHeight * DUST_MAX_AREA_RATIO, maxSize * maxSize);
  const fill = area / Math.max(1, rect.width * rect.height);
  if (longSide <= maxSize) {
    return { keep: area <= maxArea && fill >= DUST_MIN_FILL, isScratch: false };
  }
  const effectiveThickness = area / Math.max(1, longSide);
  const isScratch = effectiveThickness <= Math.max(3, maxSize / 3)
    && longSide <= Math.min(imageWidth, imageHeight) * 0.6;
  return { keep: isScratch, isScratch };
}

/**
 * Compute white/black top-hat responses for the image.
 * @returns {{ topData: Uint8Array, blackData: Uint8Array }}
 */
function computeHatResponses(imageData) {
  const c = cv();
  const src = imageDataToMat(imageData);
  const gray = new c.Mat();
  c.cvtColor(src, gray, c.COLOR_RGBA2GRAY);
  const kernel = c.getStructuringElement(c.MORPH_ELLIPSE, new c.Size(DUST_HAT_KERNEL, DUST_HAT_KERNEL));
  const tophat = new c.Mat();
  const blackhat = new c.Mat();
  c.morphologyEx(gray, tophat, c.MORPH_TOPHAT, kernel);
  c.morphologyEx(gray, blackhat, c.MORPH_BLACKHAT, kernel);
  const topData = new Uint8Array(tophat.data);
  const blackData = new Uint8Array(blackhat.data);
  deleteMats(src, gray, kernel, tophat, blackhat);
  return { topData, blackData };
}

/** Quantile-based threshold: stronger strength admits a larger anomaly share. */
export function hatThreshold(data, strength) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i++) hist[data[i]]++;
  // Level 1 admits almost nothing (~0.03% of pixels); the old mapping of
  // 0.001 + strength*0.0011 made even the minimum setting claim ~0.2% of the
  // frame, which on clean film lands on real highlight detail (#113).
  const target = data.length * (1 - (0.0003 + (strength - 1) * 0.0013));
  let cum = 0;
  let quantile = 255;
  for (let v = 0; v < 256; v++) {
    cum += hist[v];
    if (cum >= target) { quantile = v; break; }
  }
  const floor = Math.max(12, 32 - strength * 2);
  return Math.max(floor, quantile);
}

/**
 * Threshold the hat responses and filter contours into the final dust mask.
 * @returns {{ mask: Uint8Array, particleCount: number }}
 */
function buildDustMask(topData, blackData, w, h, strength, maxParticleSize) {
  const c = cv();
  const pixelCount = w * h;
  const maxSize = Number.isFinite(maxParticleSize) && maxParticleSize > 0
    ? maxParticleSize
    : defaultMaxParticleSize(w, h);
  const thTop = hatThreshold(topData, strength);
  const thBlack = hatThreshold(blackData, strength);

  const bin = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    bin[i] = (topData[i] > thTop || blackData[i] > thBlack) ? 255 : 0;
  }

  // Integral image over the binary response for isolation checks
  const integ = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += bin[y * w + x] > 0 ? 1 : 0;
      integ[(y + 1) * (w + 1) + (x + 1)] = integ[y * (w + 1) + (x + 1)] + rowSum;
    }
  }
  const regionSum = (x0, y0, x1, y1) => {
    x0 = Math.max(0, x0); y0 = Math.max(0, y0);
    x1 = Math.min(w, x1); y1 = Math.min(h, y1);
    if (x1 <= x0 || y1 <= y0) return 0;
    return integ[y1 * (w + 1) + x1] - integ[y0 * (w + 1) + x1] - integ[y1 * (w + 1) + x0] + integ[y0 * (w + 1) + x0];
  };

  const binMat = uint8ArrayToMat(bin, h, w);
  const contours = new c.MatVector();
  const hierarchy = new c.Mat();
  c.findContours(binMat, contours, hierarchy, c.RETR_EXTERNAL, c.CHAIN_APPROX_SIMPLE);

  const outMat = c.Mat.zeros(h, w, c.CV_8UC1);
  let particleCount = 0;

  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i);
    const area = Math.abs(c.contourArea(cnt)) || 1;
    const rect = c.boundingRect(cnt);
    const shape = classifyDustBlob(rect, area, maxSize, w, h);
    const isScratch = shape.isScratch;
    let keep = shape.keep;

    if (keep) {
      // Scratches too must sit in quiet surroundings — dense responses around
      // a thin candidate mean film-grain or texture, not a defect. They get a
      // tight band (their bbox is already mostly background), spots a wide pad.
      const pad = isScratch ? 16 : Math.max(8, Math.max(rect.width, rect.height) * 2);
      const nbSum = regionSum(rect.x - pad, rect.y - pad, rect.x + rect.width + pad, rect.y + rect.height + pad);
      const selfSum = regionSum(rect.x, rect.y, rect.x + rect.width, rect.y + rect.height);
      const nbArea = (Math.min(w, rect.x + rect.width + pad) - Math.max(0, rect.x - pad))
        * (Math.min(h, rect.y + rect.height + pad) - Math.max(0, rect.y - pad))
        - rect.width * rect.height;
      const density = (nbSum - selfSum) / Math.max(1, nbArea);
      if (density > DUST_NEIGHBOR_DENSITY_LIMIT) keep = false;
    }

    if (keep) {
      const vec = new c.MatVector();
      vec.push_back(cnt);
      c.drawContours(outMat, vec, 0, new c.Scalar(255), c.FILLED);
      vec.delete();
      particleCount++;
    }
    cnt.delete();
  }

  const kernelSize = Math.max(3, Math.round(h * 0.0015)) | 1;
  const dilateKernel = c.getStructuringElement(c.MORPH_ELLIPSE, new c.Size(kernelSize, kernelSize));
  const dilated = new c.Mat();
  c.dilate(outMat, dilated, dilateKernel);
  const mask = new Uint8Array(dilated.data);

  deleteMats(binMat, hierarchy, outMat, dilateKernel, dilated);
  contours.delete();

  return { mask, particleCount };
}

/**
 * Detect dust and scratches.
 *
 * @param {ImageData} imageData - Input RGBA image
 * @param {{ strength?: number, maxParticleSize?: number }} [options] -
 *   strength 1-10 (higher = more aggressive); maxParticleSize caps a blob's
 *   long side in px (defaults to defaultMaxParticleSize of the frame)
 * @returns {{ mask: Uint8Array, particleCount: number, _state: Object|null }}
 */
export function detectDust(imageData, { strength = 3, maxParticleSize } = {}) {
  const c = cv();
  if (!c || !c.Mat) {
    console.warn('DustRemoval: OpenCV.js not available');
    return { mask: new Uint8Array(imageData.width * imageData.height), particleCount: 0, _state: null };
  }
  ensureFeatureDetection();

  const { width: w, height: h } = imageData;
  const { topData, blackData } = computeHatResponses(imageData);
  const { mask, particleCount } = buildDustMask(topData, blackData, w, h, strength, maxParticleSize);

  return {
    mask,
    particleCount,
    _state: { topData, blackData, width: w, height: h }
  };
}

/**
 * Update dust detection with a new strength value, reusing the cached top-hat
 * responses (skips the morphology — only threshold + contour filtering rerun).
 *
 * @param {ImageData} imageData - Input RGBA image
 * @param {Object} existingState - _state from previous detectDust()
 * @param {number} newStrength - New strength value (1-10)
 * @param {number} [maxParticleSize] - Cap on a blob's long side in px
 * @returns {{ mask: Uint8Array, particleCount: number, _state: Object }}
 */
export function updateDustStrength(imageData, existingState, newStrength, maxParticleSize) {
  const c = cv();
  if (!c || !c.Mat) return detectDust(imageData, { strength: newStrength, maxParticleSize });
  if (!existingState || !existingState.topData
    || existingState.width !== imageData.width
    || existingState.height !== imageData.height) {
    return detectDust(imageData, { strength: newStrength, maxParticleSize });
  }

  const { topData, blackData, width: w, height: h } = existingState;
  const { mask, particleCount } = buildDustMask(topData, blackData, w, h, newStrength, maxParticleSize);
  return { mask, particleCount, _state: existingState };
}

/**
 * Inpaint masked regions using TELEA algorithm.
 *
 * @param {ImageData} imageData - Input RGBA image
 * @param {Uint8Array} mask - Single-channel mask (h*w), 255 = inpaint
 * @param {number} [radius=3] - Inpaint radius
 * @returns {ImageData} New ImageData with dust removed
 */
export function inpaintMasked(imageData, mask, radius = 3) {
  const { width, height } = imageData;
  const c = cv();
  ensureFeatureDetection();

  if (c && c.Mat && _hasInpaint) {
    // Use OpenCV inpaint
    const src = imageDataToMat(imageData);
    const bgr = new c.Mat();
    c.cvtColor(src, bgr, c.COLOR_RGBA2RGB);

    const maskMat = uint8ArrayToMat(mask, height, width);
    const dst = new c.Mat();

    try {
      c.inpaint(bgr, maskMat, dst, radius, c.INPAINT_TELEA);
    } catch (e) {
      // If inpaint fails, fall through to JS fallback
      console.warn('DustRemoval: cv.inpaint failed, using JS fallback', e);
      deleteMats(src, bgr, maskMat, dst);
      return inpaintMaskedJS(imageData, mask, radius);
    }

    // Convert back to RGBA
    const rgba = new c.Mat();
    c.cvtColor(dst, rgba, c.COLOR_RGB2RGBA);

    const outData = new Uint8ClampedArray(rgba.data);
    const result = new ImageData(outData, width, height);

    deleteMats(src, bgr, maskMat, dst, rgba);
    return result;
  }

  return inpaintMaskedJS(imageData, mask, radius);
}

/**
 * JS-only inpaint fallback.
 */
function inpaintMaskedJS(imageData, mask, radius) {
  const { width, height } = imageData;
  const outData = inpaintTeleaJS(imageData, mask, radius);
  return new ImageData(outData, width, height);
}

/**
 * Intelligent brush refinement: detect dust within brush region using Scharr.
 *
 * @param {ImageData} imageData - Source image (RGBA)
 * @param {Uint8Array} existingMask - Current dust mask (h*w)
 * @param {Uint8Array} brushMask - Brush stroke mask (h*w), 255 = brushed
 * @returns {Uint8Array} Updated mask
 */
export function refineMaskIntelligent(imageData, existingMask, brushMask) {
  const c = cv();
  if (!c || !c.Mat) return existingMask;
  ensureFeatureDetection();

  const { width: w, height: h } = imageData;

  // Convert to grayscale
  const src = imageDataToMat(imageData);
  const grayMat = new c.Mat();
  c.cvtColor(src, grayMat, c.COLOR_RGBA2GRAY);
  const grayData = new Uint8Array(grayMat.data);
  deleteMats(src, grayMat);

  // Find bounding rect of brush area
  const brushMat = uint8ArrayToMat(brushMask, h, w);
  const brushContours = new c.MatVector();
  const brushHierarchy = new c.Mat();
  c.findContours(brushMat, brushContours, brushHierarchy, c.RETR_EXTERNAL, c.CHAIN_APPROX_SIMPLE);

  if (brushContours.size() === 0) {
    deleteMats(brushMat, brushHierarchy);
    brushContours.delete();
    return existingMask;
  }

  // Get overall bounding rect
  let minX = w, minY = h, maxX = 0, maxY = 0;
  for (let i = 0; i < brushContours.size(); i++) {
    const rect = c.boundingRect(brushContours.get(i));
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }
  deleteMats(brushMat, brushHierarchy);
  brushContours.delete();

  const rx = Math.max(0, minX);
  const ry = Math.max(0, minY);
  const rw = Math.min(w, maxX) - rx;
  const rh = Math.min(h, maxY) - ry;
  if (rw < 1 || rh < 1) return existingMask;

  // Extract cropped gray region
  const croppedGray = new Uint8Array(rw * rh);
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      croppedGray[y * rw + x] = grayData[(ry + y) * w + (rx + x)];
    }
  }

  // Scharr on cropped region
  let diffX, diffY;
  if (_hasScharr) {
    const cropMat = uint8ArrayToMat(croppedGray, rh, rw);
    const dxMat = new c.Mat();
    const dyMat = new c.Mat();
    c.Scharr(cropMat, dxMat, c.CV_64F, 1, 0);
    c.Scharr(cropMat, dyMat, c.CV_64F, 0, 1);
    diffX = new Float64Array(dxMat.data64F);
    diffY = new Float64Array(dyMat.data64F);
    deleteMats(cropMat, dxMat, dyMat);
  } else {
    diffX = scharrJS(croppedGray, rw, rh, 'x');
    diffY = scharrJS(croppedGray, rw, rh, 'y');
  }

  const cropPixels = rw * rh;
  const mag = new Float64Array(cropPixels);
  for (let i = 0; i < cropPixels; i++) {
    mag[i] = Math.sqrt(diffX[i] * diffX[i] + diffY[i] * diffY[i]);
  }
  const normalized = normalizeToUint8(mag, cropPixels);

  // Threshold: low edge values are dust candidates (inRange 0-60)
  const scharrThreshed = new Uint8Array(cropPixels);
  for (let i = 0; i < cropPixels; i++) {
    scharrThreshed[i] = (normalized[i] <= 60) ? 255 : 0;
  }

  // Gaussian blur
  const threshMat = uint8ArrayToMat(scharrThreshed, rh, rw);
  const blurred = new c.Mat();
  c.GaussianBlur(threshMat, blurred, new c.Size(0, 0), 1);

  // Find contours in edge result
  const edgeContours = new c.MatVector();
  const edgeHierarchy = new c.Mat();
  c.findContours(blurred, edgeContours, edgeHierarchy, c.RETR_EXTERNAL, c.CHAIN_APPROX_SIMPLE);

  const filled = c.Mat.zeros(rh, rw, c.CV_8UC1);
  c.drawContours(filled, edgeContours, -1, new c.Scalar(255), c.FILLED);

  const filledData = new Uint8Array(filled.data);

  // Create full-size edge mask and combine with brush
  const result = new Uint8Array(existingMask);
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const fi = y * rw + x;
      const gi = (ry + y) * w + (rx + x);
      // selection = filled AND brushMask (within bounds)
      if (filledData[fi] > 0 && brushMask[gi] > 0) {
        result[gi] = 255;
      }
    }
  }

  deleteMats(threshMat, blurred, edgeHierarchy, filled);
  edgeContours.delete();

  return result;
}

/**
 * Direct brush: add brush area directly to mask.
 */
export function refineMaskDirect(existingMask, brushMask) {
  const result = new Uint8Array(existingMask);
  for (let i = 0; i < result.length; i++) {
    result[i] = result[i] | brushMask[i];
  }
  return result;
}

/**
 * Remove brush: erase brush area from mask.
 */
export function refineMaskRemove(existingMask, brushMask) {
  const result = new Uint8Array(existingMask);
  for (let i = 0; i < result.length; i++) {
    result[i] = result[i] & (~brushMask[i] & 0xFF);
  }
  return result;
}

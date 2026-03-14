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

/**
 * Process a single tile: Scharr edge detection → threshold → blur →
 * HoughLinesP → highpass → combined mask.
 *
 * @param {ImageData} tileImageData - Tile image data (RGBA)
 * @param {number} strength - Detection strength (1-10)
 * @returns {{ scharr: Uint8Array, scharrAll: Uint8Array, lineMask: Uint8Array, gaussMask: Uint8Array }}
 */
function correctTile(tileImageData, strength) {
  const c = cv();
  ensureFeatureDetection();
  const { width: w, height: h } = tileImageData;
  const pixelCount = w * h;

  // Convert to grayscale
  const src = imageDataToMat(tileImageData);
  const gray = new c.Mat();
  c.cvtColor(src, gray, c.COLOR_RGBA2GRAY);
  const grayData = new Uint8Array(gray.data);

  const factor = h >> 1;
  const minimumLine = Math.max(1, (factor / 10) | 0);
  const TH_gauss = 20;
  const TH_scharr = 0.7 * strength;
  const scharrGauss = 12;
  const highpassGauss = 3;

  // Scharr edge detection in X and Y
  let diffXData, diffYData;

  if (_hasScharr) {
    const diffX = new c.Mat();
    const diffY = new c.Mat();
    c.Scharr(gray, diffX, c.CV_64F, 1, 0);
    c.Scharr(gray, diffY, c.CV_64F, 0, 1);
    diffXData = new Float64Array(diffX.data64F);
    diffYData = new Float64Array(diffY.data64F);
    deleteMats(diffX, diffY);
  } else {
    diffXData = scharrJS(grayData, w, h, 'x');
    diffYData = scharrJS(grayData, w, h, 'y');
  }

  // Compute magnitude
  const magnitude = new Float64Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    magnitude[i] = Math.sqrt(diffXData[i] * diffXData[i] + diffYData[i] * diffYData[i]);
  }

  // Normalize to 0-255
  const scharrAll = normalizeToUint8(magnitude, pixelCount);

  // Threshold
  const threshValue = (TH_scharr * 5) | 0;
  const scharrThreshed = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    scharrThreshed[i] = (scharrAll[i] >= threshValue && scharrAll[i] <= 255) ? 255 : 0;
  }

  // Gaussian blur the thresholded result
  const scharrMat = uint8ArrayToMat(scharrThreshed, h, w);
  const blurredScharr = new c.Mat();
  const ksize = scharrGauss + 1;
  c.GaussianBlur(scharrMat, blurredScharr, new c.Size(ksize, ksize), 0);
  const scharr = new Uint8Array(blurredScharr.data);

  // Create line mask via HoughLinesP
  const lineMask = new Uint8Array(pixelCount);
  let sumScharr = 0;
  for (let i = 0; i < pixelCount; i++) sumScharr += scharr[i];

  if (sumScharr > 0 && typeof c.HoughLinesP === 'function') {
    const lines = new c.Mat();
    try {
      c.HoughLinesP(blurredScharr, lines, 1, Math.PI / 180, 200, minimumLine, 100);
      const lineMaskMat = c.Mat.zeros(h, w, c.CV_8UC1);

      for (let i = 0; i < lines.rows; i++) {
        const x1 = lines.data32S[i * 4];
        const y1 = lines.data32S[i * 4 + 1];
        const x2 = lines.data32S[i * 4 + 2];
        const y2 = lines.data32S[i * 4 + 3];
        if (_hasLine) {
          c.line(lineMaskMat, new c.Point(x1, y1), new c.Point(x2, y2), new c.Scalar(255), 10);
        } else {
          // Bresenham fallback with thickness
          drawLineOnMask(lineMask, w, h, x1, y1, x2, y2, 10);
        }
      }

      if (_hasLine) {
        const lmData = matToUint8Array(lineMaskMat);
        lineMask.set(lmData);
      }
      lineMaskMat.delete();
    } catch (e) {
      // HoughLinesP can fail on degenerate inputs; ignore
    }
    lines.delete();
  }

  // Highpass filter: gray - GaussianBlur(gray)
  const hpKsize = highpassGauss * 2 + 1;
  const blur1 = new c.Mat();
  c.GaussianBlur(gray, blur1, new c.Size(hpKsize, hpKsize), 0);
  const blur1Data = new Uint8Array(blur1.data);

  const highpass = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    highpass[i] = Math.max(0, grayData[i] - blur1Data[i]);
  }

  // Blur for inverse highpass
  const invKsize = TH_gauss * 2 + 1;
  const blur2 = new c.Mat();
  c.GaussianBlur(gray, blur2, new c.Size(invKsize, invKsize), 0);
  const blur2Data = new Uint8Array(blur2.data);

  const highpassInv = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    highpassInv[i] = Math.max(0, blur2Data[i] - grayData[i]);
  }

  // Combine masks: mask = ~inRange(highpass, 0, 254) | highpassInv | lineMask
  const combinedMask = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    // inRange(highpass, 0, 254) → pixel is 255 if in range, else 0
    // bitwise_not of that → 255 if highpass == 255, else 0
    const inRangeVal = (highpass[i] >= 0 && highpass[i] <= 254) ? 255 : 0;
    const notInRange = inRangeVal ^ 255;
    combinedMask[i] = notInRange | highpassInv[i] | lineMask[i];
  }

  // Apply GaussianBlur 3 times to smooth the combined mask
  let maskMat = uint8ArrayToMat(combinedMask, h, w);
  for (let iter = 0; iter < 3; iter++) {
    const tmp = new c.Mat();
    c.GaussianBlur(maskMat, tmp, new c.Size(ksize, ksize), 0);
    maskMat.delete();
    maskMat = tmp;
  }
  const gaussMask = new Uint8Array(maskMat.data);

  // Cleanup
  deleteMats(src, gray, scharrMat, blurredScharr, blur1, blur2, maskMat);

  return { scharr, scharrAll, lineMask, gaussMask };
}

/**
 * Bresenham line drawing with thickness (fallback when cv.line unavailable).
 */
function drawLineOnMask(mask, w, h, x1, y1, x2, y2, thickness) {
  const halfT = (thickness >> 1) || 1;
  const dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1);
  const sx = x1 < x2 ? 1 : -1, sy = y1 < y2 ? 1 : -1;
  let err = dx - dy;
  let cx = x1, cy = y1;

  while (true) {
    for (let ty = -halfT; ty <= halfT; ty++) {
      for (let tx = -halfT; tx <= halfT; tx++) {
        const nx = cx + tx, ny = cy + ty;
        if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
          mask[ny * w + nx] = 255;
        }
      }
    }
    if (cx === x2 && cy === y2) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; cx += sx; }
    if (e2 < dx) { err += dx; cy += sy; }
  }
}

/**
 * Analyze contours to separate dust particles from highlights.
 *
 * @param {Uint8Array} binaryMask - Binary input (h*w)
 * @param {Uint8Array} scharrAll - Scharr magnitude (h*w, 0-255)
 * @param {number} w - Width
 * @param {number} h - Height
 * @returns {{ allowedMask: Uint8Array, highlightMask: Uint8Array }}
 */
function analyzeContours(binaryMask, scharrAll, w, h) {
  const c = cv();
  const pixelCount = w * h;

  const srcMat = uint8ArrayToMat(binaryMask, h, w);
  const contours = new c.MatVector();
  const hierarchy = new c.Mat();
  c.findContours(srcMat, contours, hierarchy, c.RETR_EXTERNAL, c.CHAIN_APPROX_SIMPLE);

  const allowedMask = new Uint8Array(pixelCount);
  const highlightMask = new Uint8Array(pixelCount);
  const allowedMat = c.Mat.zeros(h, w, c.CV_8UC1);
  const highlightMat = c.Mat.zeros(h, w, c.CV_8UC1);

  const maximum = (h * w * 1.5e-4) | 0;
  const minimum = (h * w * 1e-7) | 0;

  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i);
    const area = Math.abs(c.contourArea(cnt));
    if (area < minimum || area > maximum) continue;

    const rect = c.boundingRect(cnt);
    const cx = rect.x + (rect.width >> 1);
    const cy = rect.y + (rect.height >> 1);

    const centerValue = (cy >= 0 && cy < h && cx >= 0 && cx < w)
      ? scharrAll[cy * w + cx]
      : 0;

    if (centerValue < 50) {
      const contourVec = new c.MatVector();
      contourVec.push_back(cnt);
      c.drawContours(allowedMat, contourVec, 0, new c.Scalar(255), c.FILLED);
      contourVec.delete();
    } else {
      const contourVec = new c.MatVector();
      contourVec.push_back(cnt);
      c.drawContours(highlightMat, contourVec, 0, new c.Scalar(255), c.FILLED);
      contourVec.delete();
    }
  }

  allowedMask.set(matToUint8Array(allowedMat));
  highlightMask.set(matToUint8Array(highlightMat));

  deleteMats(srcMat, hierarchy, allowedMat, highlightMat);
  contours.delete();

  return { allowedMask, highlightMask };
}

/**
 * Extract a tile from ImageData as a new ImageData.
 */
function extractTile(imageData, x1, y1, x2, y2) {
  const { width, data } = imageData;
  const tw = x2 - x1;
  const th = y2 - y1;
  const tileData = new Uint8ClampedArray(tw * th * 4);

  for (let y = 0; y < th; y++) {
    const srcOffset = ((y1 + y) * width + x1) * 4;
    const dstOffset = y * tw * 4;
    tileData.set(data.subarray(srcOffset, srcOffset + tw * 4), dstOffset);
  }

  return new ImageData(tileData, tw, th);
}

/**
 * Place tile data back into a full-size array.
 */
function placeTile(fullArr, fullW, tileArr, tileW, tileH, x1, y1) {
  for (let y = 0; y < tileH; y++) {
    const srcOffset = y * tileW;
    const dstOffset = (y1 + y) * fullW + x1;
    fullArr.set(tileArr.subarray(srcOffset, srcOffset + tileW), dstOffset);
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Detect dust particles in an image.
 *
 * @param {ImageData} imageData - Input RGBA image (post-conversion positive)
 * @param {{ strength: number }} options - Detection options
 * @returns {{ mask: Uint8Array, particleCount: number, _state: Object }}
 *   mask: single-channel Uint8Array (h*w), 255 = dust pixel
 *   _state: internal state for updateDustStrength()
 */
export function detectDust(imageData, { strength = 3 } = {}) {
  const c = cv();
  if (!c || !c.Mat) {
    console.warn('DustRemoval: OpenCV.js not available');
    return { mask: new Uint8Array(imageData.width * imageData.height), particleCount: 0, _state: null };
  }
  ensureFeatureDetection();

  const { width: w, height: h } = imageData;
  const pixelCount = w * h;
  const hStep = h >> 1;
  const wStep = w >> 1;

  const fullScharr = new Uint8Array(pixelCount);
  const fullScharrAll = new Uint8Array(pixelCount);
  const fullLinien = new Uint8Array(pixelCount);
  const fullGauss = new Uint8Array(pixelCount);

  // Process in 2x2 tiles
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 2; col++) {
      const y1 = row * hStep;
      const y2 = row < 1 ? (row + 1) * hStep : h;
      const x1 = col * wStep;
      const x2 = col < 1 ? (col + 1) * wStep : w;
      const tw = x2 - x1;
      const th = y2 - y1;

      const tile = extractTile(imageData, x1, y1, x2, y2);
      const { scharr, scharrAll, lineMask, gaussMask } = correctTile(tile, strength);

      placeTile(fullScharr, w, scharr, tw, th, x1, y1);
      placeTile(fullScharrAll, w, scharrAll, tw, th, x1, y1);
      placeTile(fullLinien, w, lineMask, tw, th, x1, y1);
      placeTile(fullGauss, w, gaussMask, tw, th, x1, y1);
    }
  }

  // Combine: increase = scharr AND NOT(linien)
  // Then:    increase = multiply(increase, gauss)
  const increase = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const val = fullScharr[i] & (~fullLinien[i] & 0xFF);
    // cv2.multiply saturated: min(255, a * b) for uint8
    increase[i] = Math.min(255, val * fullGauss[i]);
  }

  // Analyze contours — cache allowedMask for reuse by updateDustStrength
  const { allowedMask } = analyzeContours(increase, fullScharrAll, w, h);

  // Dilate with elliptical kernel
  const kernelSize = Math.max(3, Math.round(h * 0.0015)) | 1; // ensure odd
  const kernel = c.getStructuringElement(c.MORPH_ELLIPSE, new c.Size(kernelSize, kernelSize));
  const allowedMat = uint8ArrayToMat(allowedMask, h, w);
  const dilatedMat = new c.Mat();
  c.dilate(allowedMat, dilatedMat, kernel);
  const mask = new Uint8Array(dilatedMat.data);

  // Count particles (count contours in final mask)
  const finalContours = new c.MatVector();
  const finalHierarchy = new c.Mat();
  c.findContours(dilatedMat, finalContours, finalHierarchy, c.RETR_EXTERNAL, c.CHAIN_APPROX_SIMPLE);
  const particleCount = finalContours.size();

  // Cleanup
  deleteMats(kernel, allowedMat, dilatedMat, finalHierarchy);
  finalContours.delete();

  return {
    mask,
    particleCount,
    _state: { scharrAll: fullScharrAll, linien: fullLinien, gauss: fullGauss, allowedMask, width: w, height: h }
  };
}

/**
 * Update dust detection with a new strength value, reusing cached edge data.
 *
 * @param {ImageData} imageData - Input RGBA image
 * @param {Object} existingState - _state from previous detectDust()
 * @param {number} newStrength - New strength value (1-10)
 * @returns {{ mask: Uint8Array, particleCount: number, _state: Object }}
 */
export function updateDustStrength(imageData, existingState, newStrength) {
  if (!existingState) return detectDust(imageData, { strength: newStrength });

  const c = cv();
  if (!c || !c.Mat) return detectDust(imageData, { strength: newStrength });
  ensureFeatureDetection();

  const { width: w, height: h } = imageData;
  const pixelCount = w * h;
  const hStep = h >> 1;
  const wStep = w >> 1;
  const TH_scharr = 0.7;

  // Convert to grayscale
  const src = imageDataToMat(imageData);
  const grayMat = new c.Mat();
  c.cvtColor(src, grayMat, c.COLOR_RGBA2GRAY);
  const grayData = new Uint8Array(grayMat.data);
  deleteMats(src, grayMat);

  const fullScharr = new Uint8Array(pixelCount);

  // Re-run Scharr with new threshold per tile
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 2; col++) {
      const y1 = row * hStep;
      const y2 = row < 1 ? (row + 1) * hStep : h;
      const x1 = col * wStep;
      const x2 = col < 1 ? (col + 1) * wStep : w;
      const tw = x2 - x1;
      const th = y2 - y1;

      // Extract tile grayscale
      const tileGray = new Uint8Array(tw * th);
      for (let ty = 0; ty < th; ty++) {
        for (let tx = 0; tx < tw; tx++) {
          tileGray[ty * tw + tx] = grayData[(y1 + ty) * w + (x1 + tx)];
        }
      }

      // Scharr
      let diffX, diffY;
      if (_hasScharr) {
        const tileMat = uint8ArrayToMat(tileGray, th, tw);
        const dxMat = new c.Mat();
        const dyMat = new c.Mat();
        c.Scharr(tileMat, dxMat, c.CV_64F, 1, 0);
        c.Scharr(tileMat, dyMat, c.CV_64F, 0, 1);
        diffX = new Float64Array(dxMat.data64F);
        diffY = new Float64Array(dyMat.data64F);
        deleteMats(tileMat, dxMat, dyMat);
      } else {
        diffX = scharrJS(tileGray, tw, th, 'x');
        diffY = scharrJS(tileGray, tw, th, 'y');
      }

      const tilePixels = tw * th;
      const mag = new Float64Array(tilePixels);
      for (let i = 0; i < tilePixels; i++) {
        mag[i] = Math.sqrt(diffX[i] * diffX[i] + diffY[i] * diffY[i]);
      }
      const normalized = normalizeToUint8(mag, tilePixels);

      const threshVal = (TH_scharr * newStrength * 5) | 0;
      const tileScharr = new Uint8Array(tilePixels);
      for (let i = 0; i < tilePixels; i++) {
        tileScharr[i] = (normalized[i] >= threshVal && normalized[i] <= 255) ? 255 : 0;
      }

      placeTile(fullScharr, w, tileScharr, tw, th, x1, y1);
    }
  }

  const { linien, gauss, scharrAll } = existingState;

  // Combine: increase = scharr AND NOT(linien), then multiply with gauss
  const increase = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const val = fullScharr[i] & (~linien[i] & 0xFF);
    // cv2.multiply saturated: min(255, a * b) for uint8
    increase[i] = Math.min(255, val * gauss[i]);
  }

  // Analyze contours with new threshold
  const { allowedMask } = analyzeContours(increase, scharrAll, w, h);

  // Dilate
  const kernelSize = Math.max(3, Math.round(h * 0.0015)) | 1;
  const kernel = c.getStructuringElement(c.MORPH_ELLIPSE, new c.Size(kernelSize, kernelSize));
  const allowedMat = uint8ArrayToMat(allowedMask, h, w);
  const dilatedMat = new c.Mat();
  c.dilate(allowedMat, dilatedMat, kernel);
  const mask = new Uint8Array(dilatedMat.data);

  const finalContours = new c.MatVector();
  const finalHierarchy = new c.Mat();
  c.findContours(dilatedMat, finalContours, finalHierarchy, c.RETR_EXTERNAL, c.CHAIN_APPROX_SIMPLE);
  const particleCount = finalContours.size();

  deleteMats(kernel, allowedMat, dilatedMat, finalHierarchy);
  finalContours.delete();

  return {
    mask,
    particleCount,
    _state: { scharrAll, linien, gauss, allowedMask, width: w, height: h }
  };
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

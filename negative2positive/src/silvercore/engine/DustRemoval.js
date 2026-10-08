/**
 * DustRemoval.js - Film dust detection and inpainting engine
 *
 * Ported from Python (Scharr edge detection + contour analysis + TELEA inpaint).
 * Uses OpenCV.js; only the brush's Scharr step has a pure-JS fallback.
 *
 * Pipeline: Scharr edges → threshold → HoughLinesP line exclusion →
 *           highpass filter → contour analysis → dilate → inpaint
 */

// ─── OpenCV.js feature detection ─────────────────────────────────────────────

let _hasScharr = null;
let _hasInpaint = null;
let _hasLine = null;

function cv() {
  return globalThis.window?.cv || globalThis.cv;
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

// ─── Pure-JS helpers ─────────────────────────────────────────────────────────

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

function validateMask(mask, length) {
  if (!(mask instanceof Uint8Array) || mask.length !== length) {
    throw new RangeError(`Dust mask must be a Uint8Array with ${length} pixels`);
  }
}

function maskBounds(mask, width, height) {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = i % width;
    const y = Math.floor(i / width);
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function cropRgba(source, region) {
  const data = new Uint8ClampedArray(region.width * region.height * 4);
  for (let y = 0; y < region.height; y++) {
    const start = ((region.y + y) * source.width + region.x) * 4;
    data.set(source.data.subarray(start, start + region.width * 4), y * region.width * 4);
  }
  return new ImageData(data, region.width, region.height);
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
 * Exact summed-area counts of nonzero mask pixels, using four bytes per pixel.
 */
export function buildBinaryIntegralImage(bin, w, h) {
  // Each pixel contributes either zero or one. Integer counts remain exact;
  // only frames exceeding uint32's count range need the wider representation.
  const Counts = w * h <= 0xffffffff ? Uint32Array : Float64Array;
  const integ = new Counts((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += bin[y * w + x] > 0 ? 1 : 0;
      integ[(y + 1) * (w + 1) + x + 1] = integ[y * (w + 1) + x + 1] + rowSum;
    }
  }
  return integ;
}

/** Threshold the hat responses and filter contours into the final dust mask. */
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
  const integ = buildBinaryIntegralImage(bin, w, h);
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

// ─── Inpainting ──────────────────────────────────────────────────────────────
//
// TELEA is local. A masked pixel takes its value from known pixels within the
// inpaint radius, weighted by distances the fast-marching pass computes one or
// two pixels further out. Mask pixels more than 2 × (radius + 2) apart
// therefore never influence each other, so each cluster of nearby dust is
// repaired in its own small crop. That is bit-identical to one full-frame
// cv.inpaint (DustRemoval.partition.test.mjs), and unlike it the crops fit the
// 1 GiB heap compiled into OpenCV.js: the full-frame call needs about 19 B per
// pixel and failed above about 50 MP, where a JS stand-in left every speck in
// place (#259).

const INPAINT_WINDOW = 2048; // core of a split window, when one cluster exceeds the heap

/** Margin TELEA reads around a masked pixel: the radius, one FMM step and one gradient step. */
export function dustInpaintPad(radius) {
  return radius + 2;
}

function openCvError(error) {
  if (typeof error === 'number') {
    // OpenCV.js throws C++ exceptions as heap pointers.
    let message = '';
    try { message = cv()?.exceptionFromPtr?.(error)?.msg || ''; } catch { /* keep the pointer */ }
    return new Error(message || `OpenCV exception ${error}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function isOutOfMemory(error) {
  return /Insufficient memory|Failed to allocate|out of memory|Cannot enlarge memory|\bOOM\b/i.test(error?.message || '');
}

/**
 * Groups mask pixels that TELEA may couple. The mask is looked at through a
 * grid of cells 2 × pad wide, aligned to the frame origin, and 8-connected
 * occupied cells form one cluster. Pixels of different clusters are more than
 * 2 × pad apart, so their pad-grown boxes never overlap. The grid can merge
 * clusters that did not need merging, but it never separates two that
 * interact. `bounds` limits the scan to a rectangle that no cluster crosses
 * (the regional stroke passes one); by default the whole frame is scanned.
 *
 * @returns {{ cell: number, grid: {c0,r0,columns,rows}, labels: Int32Array,
 *   clusters: Array<{x: number, y: number, width: number, height: number}> }}
 *   `labels` holds 1 + the cluster index of each occupied cell of the grid.
 */
export function dustMaskClusters(mask, width, height, pad, bounds = null) {
  const cell = Math.max(1, 2 * pad);
  const bx = bounds ? bounds.x : 0, by = bounds ? bounds.y : 0;
  const bw = bounds ? bounds.width : width, bh = bounds ? bounds.height : height;
  const c0 = Math.floor(bx / cell), r0 = Math.floor(by / cell);
  const columns = Math.max(0, Math.ceil((bx + bw) / cell) - c0);
  const rows = Math.max(0, Math.ceil((by + bh) / cell) - r0);
  const cells = columns * rows;
  // Pixel extent inside each occupied cell, relative to the cell origin.
  const minX = new Uint16Array(cells).fill(0xffff), minY = new Uint16Array(cells).fill(0xffff);
  const maxX = new Uint16Array(cells), maxY = new Uint16Array(cells);
  const occupied = new Uint8Array(cells);
  const mark = (x, y) => {
    const cx = (x / cell) | 0, cy = (y / cell) | 0;
    const k = (cy - r0) * columns + (cx - c0);
    const lx = x - cx * cell, ly = y - cy * cell;
    occupied[k] = 1;
    if (lx < minX[k]) minX[k] = lx;
    if (lx > maxX[k]) maxX[k] = lx;
    if (ly < minY[k]) minY[k] = ly;
    if (ly > maxY[k]) maxY[k] = ly;
  };
  if (!bounds && (mask.byteOffset & 3) === 0) {
    // Whole frame: skip empty 4-pixel words.
    const words = new Uint32Array(mask.buffer, mask.byteOffset, mask.length >>> 2);
    for (let w = 0; w < words.length; w++) {
      if (words[w] === 0) continue;
      for (let i = w << 2, end = i + 4; i < end; i++) {
        if (!mask[i]) continue;
        const y = (i / width) | 0;
        mark(i - y * width, y);
      }
    }
    for (let i = words.length << 2; i < mask.length; i++) {
      if (!mask[i]) continue;
      const y = (i / width) | 0;
      mark(i - y * width, y);
    }
  } else {
    for (let y = by; y < by + bh; y++) {
      const row = y * width;
      for (let x = bx; x < bx + bw; x++) if (mask[row + x]) mark(x, y);
    }
  }
  const labels = new Int32Array(cells);
  const clusters = [];
  const stack = [];
  for (let start = 0; start < cells; start++) {
    if (!occupied[start] || labels[start]) continue;
    const label = clusters.length + 1;
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    labels[start] = label;
    stack.push(start);
    while (stack.length) {
      const k = stack.pop();
      const lc = k % columns, lr = (k - lc) / columns;
      const ox = (lc + c0) * cell, oy = (lr + r0) * cell;
      if (ox + minX[k] < x0) x0 = ox + minX[k];
      if (ox + maxX[k] > x1) x1 = ox + maxX[k];
      if (oy + minY[k] < y0) y0 = oy + minY[k];
      if (oy + maxY[k] > y1) y1 = oy + maxY[k];
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const nc = lc + dc, nr = lr + dr;
        if (nc < 0 || nr < 0 || nc >= columns || nr >= rows) continue;
        const n = nr * columns + nc;
        if (occupied[n] && !labels[n]) { labels[n] = label; stack.push(n); }
      }
    }
    clusters.push({ x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 });
  }
  return { cell, grid: { c0, r0, columns, rows }, labels, clusters };
}

function clusterLabelAt(partition, x, y) {
  const { cell, grid: { c0, r0, columns, rows } } = partition;
  const column = ((x / cell) | 0) - c0, row = ((y / cell) | 0) - r0;
  if (column < 0 || row < 0 || column >= columns || row >= rows) return 0;
  return partition.labels[row * columns + column];
}

function padRect(rect, pad, width, height) {
  const x = Math.max(0, rect.x - pad), y = Math.max(0, rect.y - pad);
  return {
    x, y,
    width: Math.min(width, rect.x + rect.width + pad) - x,
    height: Math.min(height, rect.y + rect.height + pad) - y,
  };
}

/**
 * One cv.inpaint over `crop`, whose mask holds only the pixels of cluster
 * `label`. Values of that cluster's pixels inside `write` go to `target`
 * (RGB8, and 8-bit × 257 in its 16-bit plane); alpha and every other pixel
 * are left alone. `target` is an RGBA image placed at (target.x, target.y).
 */
function inpaintClusterCrop(source, mask, partition, label, crop, write, target, radius) {
  const c = cv();
  const { width } = source;
  const { x: cx, y: cy, width: cw, height: ch } = crop;
  let rgb, maskMat, dst;
  try {
    rgb = new c.Mat(ch, cw, c.CV_8UC3);
    maskMat = new c.Mat(ch, cw, c.CV_8UC1);
    const rgbData = rgb.data, maskData = maskMat.data, src = source.data;
    for (let row = 0; row < ch; row++) {
      const y = cy + row;
      let s = (y * width + cx) * 4, d = row * cw * 3, m = row * cw;
      for (let x = cx; x < cx + cw; x++, s += 4, d += 3, m++) {
        rgbData[d] = src[s]; rgbData[d + 1] = src[s + 1]; rgbData[d + 2] = src[s + 2];
        maskData[m] = mask[y * width + x] && clusterLabelAt(partition, x, y) === label ? 255 : 0;
      }
    }
    dst = new c.Mat();
    c.inpaint(rgb, maskMat, dst, radius, c.INPAINT_TELEA);
    const out = dst.data;
    const data8 = target.data, data16 = target.__image16?.data || null;
    const tw = target.width;
    for (let y = write.y; y < write.y + write.height; y++) {
      for (let x = write.x; x < write.x + write.width; x++) {
        const m = (y - cy) * cw + (x - cx);
        if (!maskData[m]) continue;
        const t = ((y - target.y) * tw + (x - target.x)) * 4;
        for (let channel = 0; channel < 3; channel++) {
          const value = out[m * 3 + channel];
          data8[t + channel] = value;
          if (data16) data16[t + channel] = value * 257;
        }
      }
    }
  } catch (error) {
    throw openCvError(error);
  } finally {
    deleteMats(rgb, maskMat, dst);
  }
}

// Only a cluster too big for the heap lands here (a stroke or a dense chain
// across most of a 50 MP+ frame). Windows overlap by 4 × pad, which bounds
// but does not remove the influence of the cut; this is the one inexact case,
// and a single full-frame call already failed there.
let _splitWarned = false;
function inpaintClusterInWindows(source, mask, partition, label, box, target, radius) {
  const pad = dustInpaintPad(radius);
  if (!_splitWarned) {
    _splitWarned = true;
    console.warn(`DustRemoval: a ${box.width}×${box.height} dust cluster exceeds the OpenCV heap; repairing it in overlapping windows`);
  }
  const { width, height } = source;
  for (let y = box.y; y < box.y + box.height; y += INPAINT_WINDOW) {
    for (let x = box.x; x < box.x + box.width; x += INPAINT_WINDOW) {
      const write = {
        x, y,
        width: Math.min(INPAINT_WINDOW, box.x + box.width - x),
        height: Math.min(INPAINT_WINDOW, box.y + box.height - y),
      };
      inpaintClusterCrop(source, mask, partition, label, padRect(write, 4 * pad, width, height), write, target, radius);
    }
  }
}

function inpaintCluster(source, mask, partition, index, target, radius) {
  const { width, height } = source;
  const box = partition.clusters[index];
  const crop = padRect(box, dustInpaintPad(radius), width, height);
  try {
    inpaintClusterCrop(source, mask, partition, index + 1, crop, crop, target, radius);
  } catch (error) {
    if (!isOutOfMemory(error) || (box.width <= INPAINT_WINDOW && box.height <= INPAINT_WINDOW)) throw error;
    inpaintClusterInWindows(source, mask, partition, index + 1, box, target, radius);
  }
}

function requireInpaint() {
  const c = cv();
  ensureFeatureDetection();
  if (!c || !c.Mat || !_hasInpaint) throw new Error('OpenCV.js inpaint is not available');
}

function validateRadius(radius) {
  if (!Number.isInteger(radius) || radius < 1) {
    throw new RangeError('Inpaint radius must be a positive integer');
  }
}

function cloneImage(source) {
  const result = new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);
  if (source.__image16) {
    result.__image16 = {
      width: source.width, height: source.height,
      data: new Uint16Array(source.__image16.data),
    };
  }
  return result;
}

/**
 * Inpaint masked regions using TELEA, one cluster at a time.
 *
 * Masked pixels take the TELEA value (16-bit plane: 8-bit × 257); alpha and
 * unmasked pixels keep their source values in both planes. An OpenCV error is
 * thrown to the caller: there is no JS stand-in, which could not reach the
 * inside of a dilated speck.
 *
 * @param {ImageData} imageData - Input RGBA image
 * @param {Uint8Array} mask - Single-channel mask (h*w), non-zero = inpaint
 * @param {number} [radius=3] - Inpaint radius
 * @returns {ImageData} New ImageData with dust removed
 */
export function inpaintMasked(imageData, mask, radius = 3) {
  const { width, height } = imageData;
  validateMask(mask, width * height);
  validateRadius(radius);
  const partition = dustMaskClusters(mask, width, height, dustInpaintPad(radius));
  const result = cloneImage(imageData);
  if (!partition.clusters.length) return result;
  requireInpaint();
  const target = { data: result.data, __image16: result.__image16, x: 0, y: 0, width };
  for (let i = 0; i < partition.clusters.length; i++) {
    inpaintCluster(imageData, mask, partition, i, target, radius);
  }
  return result;
}

/**
 * The repaired pixels of `rect` alone: the source everywhere in it, except
 * mask pixels, which take TELEA values. `rect` must not cut a cluster of
 * `mask` (the regional stroke closes it over them), so the patch equals the
 * same rectangle of inpaintMasked(imageData, mask, radius).
 *
 * @returns {{ rgba8: Uint8ClampedArray, rgba16: Uint16Array|null }}
 */
export function inpaintMaskedRect(imageData, mask, rect, radius = 3) {
  const { width, height } = imageData;
  validateMask(mask, width * height);
  validateRadius(radius);
  const { x, y, width: rw, height: rh } = rect;
  const rgba8 = new Uint8ClampedArray(rw * rh * 4);
  const plane = imageData.__image16?.data || null;
  const rgba16 = plane ? new Uint16Array(rw * rh * 4) : null;
  for (let row = 0; row < rh; row++) {
    const start = ((y + row) * width + x) * 4;
    rgba8.set(imageData.data.subarray(start, start + rw * 4), row * rw * 4);
    if (rgba16) rgba16.set(plane.subarray(start, start + rw * 4), row * rw * 4);
  }
  const partition = dustMaskClusters(mask, width, height, dustInpaintPad(radius), rect);
  if (partition.clusters.length) {
    requireInpaint();
    const target = { data: rgba8, __image16: rgba16 ? { data: rgba16 } : null, x, y, width: rw };
    for (let i = 0; i < partition.clusters.length; i++) {
      inpaintCluster(imageData, mask, partition, i, target, radius);
    }
  }
  return { rgba8, rgba16 };
}

// Low-edge areas inside `region` (Scharr magnitude normalised over the crop,
// then blurred and filled): the candidates the intelligent brush may add.
function intelligentSelection(imageData, region) {
  const c = cv();
  const { width: rw, height: rh } = region;
  let src, grayMat, croppedGray;
  try {
    src = imageDataToMat(cropRgba(imageData, region));
    grayMat = new c.Mat();
    c.cvtColor(src, grayMat, c.COLOR_RGBA2GRAY);
    croppedGray = new Uint8Array(grayMat.data);
  } finally {
    deleteMats(src, grayMat);
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
  deleteMats(threshMat, blurred, edgeHierarchy, filled);
  edgeContours.delete();
  return filledData;
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
  validateMask(existingMask, imageData.width * imageData.height);
  validateMask(brushMask, imageData.width * imageData.height);
  const c = cv();
  if (!c || !c.Mat) return existingMask;
  ensureFeatureDetection();

  const { width: w, height: h } = imageData;

  // 輪郭抽出と全画像のグレースケール化を省き、筆跡範囲だけ変換する。
  const region = maskBounds(brushMask, w, h);
  if (!region) return existingMask;
  const { x: rx, y: ry, width: rw, height: rh } = region;
  const filledData = intelligentSelection(imageData, region);

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
  return result;
}

/**
 * The three brush modes applied in place to `mask`, inside `rect` only.
 * `brush` is the rect's own stroke raster, and `rect` must be its tight
 * bounds: the intelligent mode normalises edges over exactly that crop, so
 * the result equals refineMaskIntelligent / Direct / Remove with the same
 * stroke rasterised over the whole frame.
 */
export function refineMaskInRect(imageData, mask, rect, brush, mode) {
  const { width: w, height: h } = imageData;
  validateMask(mask, w * h);
  const { x: rx, y: ry, width: rw, height: rh } = rect;
  if (!(brush instanceof Uint8Array) || brush.length !== rw * rh) {
    throw new RangeError(`Brush raster must be a Uint8Array with ${rw * rh} pixels`);
  }
  let filled = null;
  if (mode === 'intelligent') {
    const c = cv();
    if (!c || !c.Mat) return;
    ensureFeatureDetection();
    filled = intelligentSelection(imageData, rect);
  }
  for (let y = 0; y < rh; y++) {
    const row = (ry + y) * w + rx;
    for (let x = 0; x < rw; x++) {
      const b = brush[y * rw + x];
      const gi = row + x;
      if (mode === 'intelligent') {
        if (filled[y * rw + x] > 0 && b > 0) mask[gi] = 255;
      } else if (mode === 'direct') {
        mask[gi] = mask[gi] | b;
      } else {
        mask[gi] = mask[gi] & (~b & 0xFF);
      }
    }
  }
}

/**
 * Direct brush: add brush area directly to mask.
 */
export function refineMaskDirect(existingMask, brushMask) {
  validateMask(existingMask, brushMask?.length);
  validateMask(brushMask, existingMask.length);
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
  validateMask(existingMask, brushMask?.length);
  validateMask(brushMask, existingMask.length);
  const result = new Uint8Array(existingMask);
  for (let i = 0; i < result.length; i++) {
    result[i] = result[i] & (~brushMask[i] & 0xFF);
  }
  return result;
}

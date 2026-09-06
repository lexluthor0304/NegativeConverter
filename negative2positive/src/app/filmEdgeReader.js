// Film edge reader: locates 35mm perforation lanes in a strip scan, rectifies
// the rebate bands outside the perforations and decodes the DX film edge
// barcode (ISO 1007 clock/data tracks). Pure JS, no DOM, no OpenCV.
//
// Geometry is found on a downsampled copy; the barcode is sampled from the
// full-resolution pixels along the fitted lane line, so a 0.42 mm module stays
// several pixels wide even on a whole-strip scan.
//
// DX edge barcode layout (frame-number version, 31 modules of 13 mm):
//   clock track (nearer the perforations): 5-module bar, 23 alternating
//   single modules, 3-module bar.
//   data track (nearer the film edge): start b/w/b/w/b, 23 data bits aligned
//   under the alternating clock modules, stop b/w/b.
//   data bits: [0] sep, [1..7] DX part 1, [8] sep, [9..12] DX part 2,
//   [13..18] frame number, [19] half-frame flag, [20] sep, [21] parity,
//   [22] sep. Parity bit equals the number of set bits before it, mod 2.
//   The older 23-module version has 15 data bits and no frame number.

export const PERFORATION_PITCH_MM = 4.75;
export const DX_MODULE_MM = 13 / 31;
export const DX_CLOCK_PATTERN_FN = Object.freeze([5, ...new Array(23).fill(1), 3]);
export const DX_CLOCK_PATTERN_NO_FN = Object.freeze([5, ...new Array(15).fill(1), 3]);

const DEFAULTS = Object.freeze({
  maxAnalysisSide: 1400,
  whiteFraction: 0.86,
  minHolesPerLane: 3,
  bandDepthMm: 2.9,
  rowStepMm: 0.08,
  columnStepMm: 0.05,
  darkThreshold: 0.38
});

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = Array.from(values).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// --- DX bit level -----------------------------------------------------------

export function decodeDxDataBits(bits) {
  if (!Array.isArray(bits) && !(bits instanceof Uint8Array)) return null;
  const length = bits.length;
  const hasFrameNumber = length === 23;
  if (!hasFrameNumber && length !== 15) return null;
  const separators = hasFrameNumber ? [0, 8, 20, 22] : [0, 8, 14];
  for (const index of separators) {
    if (bits[index]) return null;
  }
  const parityIndex = length - 2;
  let sum = 0;
  for (let i = 0; i < parityIndex; i++) sum += bits[i] ? 1 : 0;
  if ((sum % 2) !== (bits[parityIndex] ? 1 : 0)) return null;
  const toInt = (start, count) => {
    let value = 0;
    for (let i = 0; i < count; i++) value = (value << 1) | (bits[start + i] ? 1 : 0);
    return value;
  };
  const dx1 = toInt(1, 7);
  const dx2 = toInt(9, 4);
  const result = { dx1, dx2, dxNumber: `${dx1}-${dx2}`, hasFrameNumber, frameNumber: null, halfFrame: false };
  if (hasFrameNumber) {
    result.frameNumber = toInt(13, 6);
    result.halfFrame = Boolean(bits[19]);
  }
  return result;
}

export function encodeDxDataBits({ dx1, dx2, frameNumber = null, halfFrame = false }) {
  const hasFrameNumber = Number.isFinite(frameNumber);
  const bits = new Array(hasFrameNumber ? 23 : 15).fill(0);
  const put = (value, start, count) => {
    for (let i = 0; i < count; i++) bits[start + i] = (value >> (count - 1 - i)) & 1;
  };
  put(clamp(Math.round(dx1), 0, 127), 1, 7);
  put(clamp(Math.round(dx2), 0, 15), 9, 4);
  if (hasFrameNumber) {
    put(clamp(Math.round(frameNumber), 0, 63), 13, 6);
    bits[19] = halfFrame ? 1 : 0;
  }
  const parityIndex = bits.length - 2;
  let sum = 0;
  for (let i = 0; i < parityIndex; i++) sum += bits[i];
  bits[parityIndex] = sum % 2;
  return bits;
}

// Run-length encode a binary row. Returns arrays of run starts (inclusive)
// and lengths; runs alternate and the first run's value is `firstValue`.
export function runLengthEncode(binary) {
  const starts = [];
  const lengths = [];
  if (!binary.length) return { starts, lengths, firstValue: 0 };
  let current = binary[0] ? 1 : 0;
  let start = 0;
  for (let i = 1; i <= binary.length; i++) {
    const value = i < binary.length ? (binary[i] ? 1 : 0) : -1;
    if (value !== current) {
      starts.push(start);
      lengths.push(i - start);
      start = i;
      current = value;
    }
  }
  return { starts, lengths, firstValue: binary[0] ? 1 : 0 };
}

// Flip runs shorter than `minRun` samples to the neighbouring value so a
// single noisy sample cannot split a bar or bridge a space. The expected
// module width is known from the perforation pitch, so `minRun` is a quarter
// of a module.
export function smoothBinaryRuns(binary, minRun) {
  if (minRun <= 1 || binary.length < 3) return binary;
  let start = 0;
  while (start < binary.length) {
    let end = start;
    while (end < binary.length && binary[end] === binary[start]) end++;
    if (end - start < minRun && start > 0 && end < binary.length) {
      const fill = binary[start - 1];
      for (let i = start; i < end; i++) binary[i] = fill;
      // Re-scan from the previous run so merged runs are measured together.
      let back = start - 1;
      while (back > 0 && binary[back - 1] === fill) back--;
      start = back;
      continue;
    }
    start = end;
  }
  return binary;
}

// Find clock tracks in a run-length encoded row. `runs` must alternate
// dark/light; `darkFirst` tells whether run 0 is dark. Returns matches with
// module size and reading direction (1 = start bar on the left).
export function findDxClocks(runs, { firstValue, minModulePx = 2.5, maxModulePx = 60 } = {}) {
  const { starts, lengths } = runs;
  const matches = [];
  const patterns = [
    { pattern: DX_CLOCK_PATTERN_FN, hasFrameNumber: true },
    { pattern: DX_CLOCK_PATTERN_NO_FN, hasFrameNumber: false }
  ];
  for (const { pattern, hasFrameNumber } of patterns) {
    const count = pattern.length;
    const totalModules = pattern.reduce((a, b) => a + b, 0);
    for (let i = 0; i + count <= lengths.length; i++) {
      const isDark = ((i % 2 === 0) ? firstValue : 1 - firstValue) === 1;
      if (!isDark) continue;
      const first = lengths[i];
      const last = lengths[i + count - 1];
      for (const direction of [1, -1]) {
        const startBar = direction === 1 ? first : last;
        const stopBar = direction === 1 ? last : first;
        let total = 0;
        for (let k = 0; k < count; k++) total += lengths[i + k];
        const module = total / totalModules;
        if (module < minModulePx || module > maxModulePx) continue;
        if (Math.abs(startBar - 5 * module) > 1.3 * module) continue;
        if (Math.abs(stopBar - 3 * module) > 1.1 * module) continue;
        let ok = true;
        let deviation = 0;
        for (let k = 1; k < count - 1; k++) {
          const ratio = lengths[i + k] / module;
          if (ratio < 0.42 || ratio > 1.75) { ok = false; break; }
          deviation += Math.abs(ratio - 1);
        }
        if (!ok) continue;
        matches.push({
          runIndex: i,
          runCount: count,
          start: starts[i],
          end: starts[i + count - 1] + lengths[i + count - 1],
          moduleSize: module,
          direction,
          hasFrameNumber,
          deviation: deviation / (count - 2)
        });
      }
    }
  }
  return matches;
}

// --- raster helpers ----------------------------------------------------------

function buildAnalysisRaster(imageData, maxSide) {
  const { width, height, data } = imageData;
  const scale = Math.max(1, Math.max(width, height) / maxSide);
  const step = Math.ceil(scale);
  const w = Math.max(1, Math.floor(width / step));
  const h = Math.max(1, Math.floor(height / step));
  const lum = new Float32Array(w * h);
  const minChannel = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = y * step;
    for (let x = 0; x < w; x++) {
      const sx = x * step;
      const idx = (sy * width + sx) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      lum[y * w + x] = (r + g + b) / 3;
      minChannel[y * w + x] = Math.min(r, g, b);
    }
  }
  return { width: w, height: h, step, lum, minChannel };
}

function percentile(values, fraction) {
  const sample = values.length > 200000 ? values.filter((_, i) => i % Math.ceil(values.length / 200000) === 0) : values;
  const sorted = Float32Array.from(sample).sort();
  return sorted[clamp(Math.floor(sorted.length * fraction), 0, sorted.length - 1)];
}

function labelWhiteComponents(raster, threshold) {
  const { width, height, minChannel } = raster;
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) mask[i] = minChannel[i] >= threshold ? 1 : 0;
  const labels = new Int32Array(width * height);
  const components = [];
  const stack = new Int32Array(width * height);
  let next = 1;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    let top = 0;
    stack[top++] = start;
    labels[start] = next;
    let area = 0;
    let minX = width; let maxX = -1; let minY = height; let maxY = -1;
    let sumX = 0; let sumY = 0;
    let touchesBorder = false;
    while (top > 0) {
      const idx = stack[--top];
      const y = (idx / width) | 0;
      const x = idx - y * width;
      area++;
      sumX += x; sumY += y;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesBorder = true;
      if (x > 0 && mask[idx - 1] && !labels[idx - 1]) { labels[idx - 1] = next; stack[top++] = idx - 1; }
      if (x < width - 1 && mask[idx + 1] && !labels[idx + 1]) { labels[idx + 1] = next; stack[top++] = idx + 1; }
      if (y > 0 && mask[idx - width] && !labels[idx - width]) { labels[idx - width] = next; stack[top++] = idx - width; }
      if (y < height - 1 && mask[idx + width] && !labels[idx + width]) { labels[idx + width] = next; stack[top++] = idx + width; }
    }
    components.push({
      area,
      x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1,
      cx: sumX / area, cy: sumY / area,
      touchesBorder
    });
    next++;
  }
  return components;
}

// Cluster hole candidates into lanes along `axis` ('x' lanes run horizontally,
// clustered by cy; 'y' lanes run vertically, clustered by cx).
function findLanes(holes, axis) {
  const along = axis === 'x' ? 'cx' : 'cy';
  const across = axis === 'x' ? 'cy' : 'cx';
  const acrossSize = axis === 'x' ? 'height' : 'width';
  const alongSize = axis === 'x' ? 'width' : 'height';
  const sorted = holes.slice().sort((a, b) => a[across] - b[across]);
  const lanes = [];
  let cluster = [];
  const flush = () => {
    if (cluster.length >= DEFAULTS.minHolesPerLane) {
      const lane = buildLane(cluster, along, across, alongSize, acrossSize);
      if (lane) lanes.push(lane);
    }
    cluster = [];
  };
  for (const hole of sorted) {
    if (!cluster.length) { cluster.push(hole); continue; }
    const center = cluster.reduce((s, h) => s + h[across], 0) / cluster.length;
    const tolerance = 0.6 * median(cluster.map((h) => h[acrossSize]));
    if (Math.abs(hole[across] - center) <= Math.max(1.5, tolerance)) cluster.push(hole);
    else { flush(); cluster.push(hole); }
  }
  flush();
  return lanes;
}

function buildLane(holes, along, across, alongSize, acrossSize) {
  const sorted = holes.slice().sort((a, b) => a[along] - b[along]);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i][along] - sorted[i - 1][along]);
  const pitch = median(gaps.filter((g) => g > 0));
  if (!(pitch > 0)) return null;
  // Keep holes that sit on the pitch grid (allow skipped holes).
  const kept = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i][along] - kept[kept.length - 1][along];
    const multiple = Math.round(gap / pitch);
    if (multiple >= 1 && Math.abs(gap / pitch - multiple) <= 0.18 * multiple) kept.push(sorted[i]);
  }
  if (kept.length < DEFAULTS.minHolesPerLane) return null;
  const holeAlong = median(kept.map((h) => h[alongSize]));
  const holeAcross = median(kept.map((h) => h[acrossSize]));
  // 35mm KS perforations: 1.98 mm along the strip, 2.80 mm across, 4.75 mm pitch.
  const alongRatio = holeAlong / pitch;
  const acrossRatio = holeAcross / pitch;
  if (alongRatio < 0.28 || alongRatio > 0.6) return null;
  if (acrossRatio < 0.42 || acrossRatio > 0.8) return null;
  // Least squares line across = a + b * along.
  const n = kept.length;
  let sa = 0; let sc = 0; let saa = 0; let sac = 0;
  for (const h of kept) { sa += h[along]; sc += h[across]; saa += h[along] * h[along]; sac += h[along] * h[across]; }
  const denom = n * saa - sa * sa;
  const b = denom !== 0 ? (n * sac - sa * sc) / denom : 0;
  const a = (sc - b * sa) / n;
  return {
    holes: kept,
    pitch,
    holeAlong,
    holeAcross,
    intercept: a,
    slope: b,
    center: sc / n,
    alongMin: kept[0][along],
    alongMax: kept[kept.length - 1][along]
  };
}

// Detect perforation lanes. Returns null when no lane is found.
export function detectPerforationLanes(imageData, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  if (!imageData || !imageData.data || imageData.width < 16 || imageData.height < 16) return null;
  const raster = buildAnalysisRaster(imageData, opts.maxAnalysisSide);
  const bright = percentile(raster.lum, 0.995);
  if (!(bright > 0)) return null;
  const threshold = bright * opts.whiteFraction;
  const components = labelWhiteComponents(raster, threshold);
  const maxArea = raster.width * raster.height * 0.01;
  const holes = components.filter((c) => {
    if (c.touchesBorder) return false;
    if (c.area < 12 || c.area > maxArea) return false;
    const fill = c.area / (c.width * c.height);
    if (fill < 0.68) return false;
    const aspect = Math.max(c.width, c.height) / Math.min(c.width, c.height);
    return aspect >= 1.05 && aspect <= 2.1 && Math.min(c.width, c.height) >= 3;
  });
  if (opts.debug) {
    opts.debug.raster = { width: raster.width, height: raster.height, step: raster.step, bright, threshold };
    opts.debug.components = components.length;
    opts.debug.holes = holes.length;
    opts.debug.sample = components
      .filter((c) => !c.touchesBorder && c.area >= 12 && c.area <= maxArea)
      .sort((a, b) => b.area - a.area)
      .slice(0, 12)
      .map((c) => ({ area: c.area, w: c.width, h: c.height, cx: Math.round(c.cx), cy: Math.round(c.cy), fill: +(c.area / (c.width * c.height)).toFixed(2) }));
  }
  if (holes.length < opts.minHolesPerLane) return null;

  const evaluate = (axis) => {
    // Perforations are taller across the strip than they are long, so lanes
    // running along x are made of holes with height > width.
    const lanes = findLanes(holes.filter((h) => (axis === 'x' ? h.height >= h.width : h.width >= h.height)), axis)
      .sort((a, b) => b.holes.length - a.holes.length);
    if (!lanes.length) return null;
    const primary = lanes[0];
    let secondary = null;
    for (const lane of lanes.slice(1)) {
      const pitchRatio = lane.pitch / primary.pitch;
      const separation = Math.abs(lane.center - primary.center) / primary.pitch;
      // Lane centres sit about 29 mm apart (6.1 pitches) on 35mm film.
      if (pitchRatio > 0.9 && pitchRatio < 1.1 && separation > 5.0 && separation < 7.4) { secondary = lane; break; }
    }
    const score = primary.holes.length + (secondary ? secondary.holes.length : 0);
    return { axis, primary, secondary, score };
  };
  const horizontal = evaluate('x');
  const vertical = evaluate('y');
  if (opts.debug) opts.debug.lanes = { horizontal, vertical };
  const best = [horizontal, vertical].filter(Boolean).sort((a, b) => b.score - a.score)[0];
  if (!best) return null;

  const lanes = [best.primary, best.secondary].filter(Boolean);
  const pitch = lanes.reduce((s, l) => s + l.pitch, 0) / lanes.length;
  const pxPerMm = pitch / PERFORATION_PITCH_MM;
  const filmAxisCenter = best.secondary
    ? (best.primary.center + best.secondary.center) / 2
    : null;
  const laneDescriptors = lanes.map((lane) => {
    let outward;
    if (filmAxisCenter !== null) outward = lane.center < filmAxisCenter ? -1 : 1;
    else {
      // Single lane: the image area is on the side with more mid-tone pixels.
      outward = estimateOutwardDirection(raster, lane, best.axis, threshold) ;
    }
    return {
      axis: best.axis,
      outward,
      holeCount: lane.holes.length,
      pitch: lane.pitch,
      holeAlong: lane.holeAlong,
      holeAcross: lane.holeAcross,
      intercept: lane.intercept,
      slope: lane.slope,
      center: lane.center,
      alongMin: lane.alongMin,
      alongMax: lane.alongMax
    };
  });
  const angleDeg = Math.atan(laneDescriptors[0].slope) * 180 / Math.PI;
  return {
    axis: best.axis,
    step: raster.step,
    analysisWidth: raster.width,
    analysisHeight: raster.height,
    brightLevel: bright,
    whiteThreshold: threshold,
    pxPerMm: pxPerMm * raster.step,
    pxPerMmAnalysis: pxPerMm,
    angleDeg,
    lanes: laneDescriptors,
    holeCount: laneDescriptors.reduce((s, l) => s + l.holeCount, 0)
  };
}

function estimateOutwardDirection(raster, lane, axis, whiteThreshold) {
  const { width, height, minChannel } = raster;
  const depth = Math.round(lane.pitch * 3);
  const count = (sign) => {
    let mid = 0;
    for (let d = Math.round(lane.holeAcross); d < depth; d++) {
      const across = Math.round(lane.center + sign * d);
      for (let along = Math.round(lane.alongMin); along <= Math.round(lane.alongMax); along += 2) {
        const x = axis === 'x' ? along : across;
        const y = axis === 'x' ? across : along;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        if (minChannel[y * width + x] < whiteThreshold) mid++;
      }
    }
    return mid;
  };
  // The image area (more non-white pixels) is inward; the outer rebate is thin.
  return count(1) > count(-1) ? -1 : 1;
}

// --- band rectification -----------------------------------------------------

function sampleLuminance(imageData, x, y) {
  const { width, height, data } = imageData;
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return NaN;
  const x0 = Math.floor(x); const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1); const y1 = Math.min(height - 1, y0 + 1);
  const fx = x - x0; const fy = y - y0;
  const at = (xx, yy) => {
    const idx = (yy * width + xx) * 4;
    return (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
  };
  const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
  const bottom = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
  return top * (1 - fy) + bottom * fy;
}

// Build a rectified band for one lane: rows are perpendicular offsets from the
// lane centre (starting at the outer hole edge), columns run along the lane.
export function rectifyLaneBand(imageData, geometry, lane, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const pxPerMm = geometry.pxPerMm;
  const step = geometry.step;
  const theta = Math.atan(lane.slope);
  const cos = Math.cos(theta); const sin = Math.sin(theta);
  // Unit vectors in full-res pixels. `u` runs along the lane, `n` points outward.
  const u = lane.axis === 'x' ? [cos, sin] : [sin, cos];
  const n = lane.axis === 'x' ? [-sin * lane.outward, cos * lane.outward] : [cos * lane.outward, -sin * lane.outward];
  // Point on the lane centre line at along = 0 (analysis coords -> full-res).
  const origin = lane.axis === 'x'
    ? [0, lane.intercept * step]
    : [lane.intercept * step, 0];
  const alongExtent = lane.axis === 'x' ? imageData.width : imageData.height;
  const columnStep = Math.max(1, opts.columnStepMm * pxPerMm);
  const rowStep = Math.max(1, opts.rowStepMm * pxPerMm);
  const holeHalf = (lane.holeAcross * step) / 2;
  const depth = opts.bandDepthMm * pxPerMm;
  const rows = Math.max(1, Math.round(depth / rowStep));
  const cols = Math.max(1, Math.round(alongExtent / columnStep));
  const values = new Float32Array(rows * cols).fill(NaN);
  for (let r = 0; r < rows; r++) {
    const offset = holeHalf + r * rowStep;
    for (let c = 0; c < cols; c++) {
      const along = c * columnStep;
      const x = origin[0] + u[0] * along + n[0] * offset;
      const y = origin[1] + u[1] * along + n[1] * offset;
      values[r * cols + c] = sampleLuminance(imageData, x, y);
    }
  }
  return {
    rows, cols, values, columnStep, rowStep, holeHalf, origin, u, n,
    offsetOfRow: (r) => holeHalf + r * rowStep,
    pointAt: (r, c) => {
      const offset = holeHalf + r * rowStep;
      const along = c * columnStep;
      return { x: origin[0] + u[0] * along + n[0] * offset, y: origin[1] + u[1] * along + n[1] * offset };
    }
  };
}

// Normalise a band row against the local clear base and return darkness in
// [0,1]. The base is the 85th percentile of the window (about 20 mm) so bars,
// text and dark objects do not pull it down and perforations or the light box
// do not pull it up. Values are compared in linear light: the print on the
// rebate is dense, so bars sit well above the threshold even when the base
// itself is fairly dark in the scan.
const LINEAR_LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) LINEAR_LUT[i] = Math.pow(i / 255, 2.2);
function toLinear(v) {
  if (v <= 0) return 0;
  if (v >= 255) return 1;
  const i = Math.floor(v);
  const f = v - i;
  return LINEAR_LUT[i] * (1 - f) + LINEAR_LUT[Math.min(255, i + 1)] * f;
}

export function rowDarkness(band, row, windowCols, polarity = 'dark') {
  const { cols, values } = band;
  const line = values.subarray(row * cols, (row + 1) * cols);
  const half = Math.max(1, Math.round(windowCols / 2));
  const darkness = new Float32Array(cols);
  const blocks = Math.ceil(cols / half);
  const blockHigh = new Float32Array(blocks).fill(0);
  const blockLow = new Float32Array(blocks).fill(0);
  const scratch = new Float32Array(half);
  for (let b = 0; b < blocks; b++) {
    let n = 0;
    const from = b * half;
    const to = Math.min(cols, from + half);
    for (let c = from; c < to; c++) { const v = line[c]; if (!Number.isNaN(v)) scratch[n++] = v; }
    if (!n) continue;
    const sorted = scratch.subarray(0, n).slice().sort();
    blockHigh[b] = sorted[Math.min(n - 1, Math.floor(n * 0.85))];
    blockLow[b] = sorted[Math.min(n - 1, Math.floor(n * 0.15))];
  }
  for (let c = 0; c < cols; c++) {
    const v = line[c];
    if (Number.isNaN(v)) { darkness[c] = 0; continue; }
    const b = (c / half) | 0;
    const b0 = Math.max(0, b - 1); const b1 = Math.min(blocks - 1, b + 1);
    if (polarity === 'light') {
      // Positive film: dense black rebate with clear marks. Signal is how far
      // above the dark base a sample sits, relative to the local mark level.
      let low = Infinity; let high = 0;
      for (let k = b0; k <= b1; k++) { if (blockLow[k] < low) low = blockLow[k]; if (blockHigh[k] > high) high = blockHigh[k]; }
      const linLow = toLinear(low); const linHigh = toLinear(high);
      darkness[c] = linHigh - linLow > 0.06 ? clamp((toLinear(v) - linLow) / (linHigh - linLow), 0, 1) : 0;
      continue;
    }
    // Negative film: take the larger neighbouring base so a block that is
    // mostly print still normalises against clear base.
    let base = blockHigh[b];
    if (blockHigh[b0] > base) base = blockHigh[b0];
    if (blockHigh[b1] > base) base = blockHigh[b1];
    const linBase = toLinear(base);
    darkness[c] = linBase > 0.002 ? clamp(1 - toLinear(v) / linBase, 0, 1) : 0;
  }
  return darkness;
}

function sampleBits(band, darkness, clock, darkThreshold) {
  const moduleCols = clock.moduleSize;
  const count = clock.hasFrameNumber ? 23 : 15;
  const centreOf = (moduleIndex) => (clock.direction === 1
    ? clock.start + (moduleIndex + 0.5) * moduleCols
    : clock.end - (moduleIndex + 0.5) * moduleCols);
  const isDark = (moduleIndex) => averageDarkness(darkness, centreOf(moduleIndex), moduleCols * 0.3) > darkThreshold ? 1 : 0;
  const bits = new Array(count);
  for (let k = 0; k < count; k++) bits[k] = isDark(5 + k);
  // Start (b w b w b) and stop (b w b) patterns on the data track.
  const totalModules = clock.hasFrameNumber ? 31 : 23;
  const expected = [[0, 1], [1, 0], [2, 1], [3, 0], [4, 1], [totalModules - 3, 1], [totalModules - 2, 0], [totalModules - 1, 1]];
  let guardErrors = 0;
  for (const [moduleIndex, value] of expected) if (isDark(moduleIndex) !== value) guardErrors++;
  return { bits, guardErrors };
}

function averageDarkness(darkness, centre, halfWidth) {
  const from = Math.max(0, Math.round(centre - halfWidth));
  const to = Math.min(darkness.length - 1, Math.round(centre + halfWidth));
  if (to < from) return 0;
  let sum = 0;
  for (let c = from; c <= to; c++) sum += darkness[c];
  return sum / (to - from + 1);
}

// Decode every DX code visible in one rectified band. Clock detections from
// all rows are grouped by position so the module grid comes from a median over
// the whole clock track, then the data track (the rows just beyond the clock)
// is read on several rows and the majority decode wins.
export function decodeDxCodesInBand(band, geometry, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const moduleCols = (DX_MODULE_MM * geometry.pxPerMm) / band.columnStep;
  const windowCols = Math.round((20 * geometry.pxPerMm) / band.columnStep);
  const rowsPerMm = geometry.pxPerMm / band.rowStep;
  const darknessRows = new Array(band.rows);
  const polarity = opts.polarity === 'light' ? 'light' : 'dark';
  const darknessAt = (row) => {
    if (!darknessRows[row]) darknessRows[row] = rowDarkness(band, row, windowCols, polarity);
    return darknessRows[row];
  };
  const groups = [];
  for (let row = 0; row < band.rows; row++) {
    const darkness = darknessAt(row);
    const binary = new Uint8Array(band.cols);
    for (let c = 0; c < band.cols; c++) binary[c] = darkness[c] > opts.darkThreshold ? 1 : 0;
    smoothBinaryRuns(binary, Math.max(1, Math.round(moduleCols * 0.25)));
    const runs = runLengthEncode(binary);
    const clocks = findDxClocks(runs, {
      firstValue: runs.firstValue,
      minModulePx: moduleCols * 0.7,
      maxModulePx: moduleCols * 1.35
    });
    if (opts.debug && clocks.length) opts.debug.push({ row, clocks: clocks.length });
    for (const clock of clocks) {
      const group = groups.find((g) => g.direction === clock.direction
        && g.hasFrameNumber === clock.hasFrameNumber
        && Math.abs(g.starts[g.starts.length - 1] - clock.start) < moduleCols * 2);
      if (group) {
        group.rows.push(row); group.starts.push(clock.start); group.ends.push(clock.end); group.modules.push(clock.moduleSize);
      } else {
        groups.push({ direction: clock.direction, hasFrameNumber: clock.hasFrameNumber, rows: [row], starts: [clock.start], ends: [clock.end], modules: [clock.moduleSize] });
      }
    }
  }
  const found = [];
  for (const group of groups) {
    if (group.rows.length < 2) continue;
    const clock = {
      start: median(group.starts),
      end: median(group.ends),
      moduleSize: median(group.modules),
      direction: group.direction,
      hasFrameNumber: group.hasFrameNumber
    };
    const clockBottom = Math.max(...group.rows);
    const clockTop = Math.min(...group.rows);
    // The data track follows the clock track; read up to ~1.4 mm beyond it.
    const firstDataRow = clockBottom + 1;
    const lastDataRow = Math.min(band.rows - 1, clockBottom + Math.round(1.4 * rowsPerMm));
    const votes = new Map();
    for (let dataRow = firstDataRow; dataRow <= lastDataRow; dataRow++) {
      const { bits, guardErrors } = sampleBits(band, darknessAt(dataRow), clock, opts.darkThreshold);
      if (opts.debug) opts.debug.push({ clockRows: group.rows.length, dataRow, guardErrors, bits: bits.join('') });
      if (guardErrors > 0) continue;
      const value = decodeDxDataBits(bits);
      if (!value || (value.dx1 === 0 && value.dx2 === 0)) continue;
      const key = `${value.dxNumber}/${value.frameNumber}/${value.halfFrame ? 1 : 0}`;
      const entry = votes.get(key) || { value, rows: 0 };
      entry.rows++;
      votes.set(key, entry);
    }
    let best = null;
    for (const entry of votes.values()) if (!best || entry.rows > best.rows) best = entry;
    if (!best || best.rows < 2) continue;
    const centreCol = (clock.start + clock.end) / 2;
    const point = band.pointAt(clockBottom, centreCol);
    found.push({
      ...best.value,
      polarity,
      direction: clock.direction,
      moduleCols: clock.moduleSize,
      clockRows: group.rows.length,
      clockTopOffsetMm: band.offsetOfRow(clockTop) / geometry.pxPerMm,
      dataRows: best.rows,
      alongPx: centreCol * band.columnStep,
      x: point.x,
      y: point.y
    });
  }
  return found.sort((a, b) => a.alongPx - b.alongPx);
}

// --- film base from the rebate -------------------------------------------------

function sampleRgb(imageData, x, y) {
  const { width, height, data } = imageData;
  const xi = Math.round(x); const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= width || yi >= height) return null;
  const idx = (yi * width + xi) * 4;
  return [data[idx], data[idx + 1], data[idx + 2]];
}

// Median colour of unprinted rebate pixels along a lane band (between the
// perforations and the film edge, skipping bars, text and the light box).
export function sampleRebateFilmBase(imageData, geometry, lane, options = {}) {
  const band = rectifyLaneBand(imageData, geometry, lane, { ...options, columnStepMm: 0.2, rowStepMm: 0.15, bandDepthMm: 2.4 });
  const rs = []; const gs = []; const bs = [];
  const whiteThreshold = geometry.brightLevel * DEFAULTS.whiteFraction;
  for (let r = 0; r < band.rows; r++) {
    const darkness = rowDarkness(band, r, Math.round((20 * geometry.pxPerMm) / band.columnStep));
    for (let c = 0; c < band.cols; c++) {
      if (darkness[c] > 0.12) continue;
      const p = band.pointAt(r, c);
      const rgb = sampleRgb(imageData, p.x, p.y);
      if (!rgb) continue;
      if (Math.min(rgb[0], rgb[1], rgb[2]) >= whiteThreshold) continue;
      rs.push(rgb[0]); gs.push(rgb[1]); bs.push(rgb[2]);
    }
  }
  if (rs.length < 50) return null;
  return { r: Math.round(median(rs)), g: Math.round(median(gs)), b: Math.round(median(bs)), samples: rs.length, method: 'rebate' };
}

// --- top level -------------------------------------------------------------------

export function readFilmEdge(imageData, options = {}) {
  const geometry = detectPerforationLanes(imageData, options);
  if (!geometry) return { found: false, geometry: null, dxCodes: [], dx: null, filmBase: null, polarity: null };
  const bands = geometry.lanes.map((lane) => ({ lane, band: rectifyLaneBand(imageData, geometry, lane, options) }));
  const polarities = options.polarity === 'light' ? ['light'] : options.polarity === 'dark' ? ['dark'] : ['dark', 'light'];
  let dxCodes = [];
  let polarity = null;
  for (const candidate of polarities) {
    for (const { lane, band } of bands) {
      const codes = decodeDxCodesInBand(band, geometry, { ...options, polarity: candidate })
        .map((code) => ({ ...code, lane: lane.outward }));
      dxCodes.push(...codes);
    }
    if (dxCodes.length) { polarity = candidate; break; }
  }
  let filmBase = null;
  if (polarity !== 'light') {
    for (const { lane } of bands) {
      filmBase = sampleRebateFilmBase(imageData, geometry, lane, options);
      if (filmBase) break;
    }
  }
  return {
    found: true,
    geometry,
    dxCodes,
    dx: summarizeDxCodes(dxCodes),
    filmBase,
    polarity
  };
}

export function summarizeDxCodes(codes) {
  if (!codes.length) return null;
  const votes = new Map();
  for (const code of codes) votes.set(code.dxNumber, (votes.get(code.dxNumber) || 0) + 1);
  let best = null;
  for (const [dxNumber, count] of votes) if (!best || count > best.count) best = { dxNumber, count };
  const winner = codes.find((c) => c.dxNumber === best.dxNumber);
  const frames = codes
    .filter((c) => c.dxNumber === best.dxNumber && c.hasFrameNumber)
    .map((c) => ({ frameNumber: c.frameNumber, halfFrame: c.halfFrame, x: c.x, y: c.y }))
    .sort((a, b) => (a.frameNumber - b.frameNumber) || (a.halfFrame - b.halfFrame));
  return {
    dx1: winner.dx1,
    dx2: winner.dx2,
    dxNumber: best.dxNumber,
    dxExtract: winner.dx1 * 16 + winner.dx2,
    votes: best.count,
    total: codes.length,
    frames
  };
}

// --- settings -------------------------------------------------------------------------

const MAX_FILM_EDGE_NAMES = 5;
const MAX_FILM_EDGE_FRAMES = 80;

// Coerces a detection record into the shape persisted in per-file settings.
// Returns null for anything that is not a checked record; `checked: true,
// found: false` is kept so a file is not re-analysed on every switch.
export function sanitizeFilmEdgeForSettings(input) {
  if (!input || typeof input !== 'object') return null;
  const found = Boolean(input.found);
  const record = { checked: true, found };
  if (!found) return record;
  const int = (value, min, max) => (Number.isFinite(Number(value)) ? clamp(Math.round(Number(value)), min, max) : null);
  const dx1 = int(input.dx1, 0, 127);
  const dx2 = int(input.dx2, 0, 15);
  record.dx1 = dx1;
  record.dx2 = dx2;
  record.dxNumber = dx1 !== null && dx2 !== null ? `${dx1}-${dx2}` : null;
  record.dxExtract = dx1 !== null && dx2 !== null ? dx1 * 16 + dx2 : null;
  record.votes = int(input.votes, 0, 999) ?? 0;
  record.total = int(input.total, 0, 999) ?? 0;
  record.filmName = typeof input.filmName === 'string' ? input.filmName.slice(0, 120) : null;
  record.shortName = typeof input.shortName === 'string' ? input.shortName.slice(0, 40) : null;
  record.names = Array.isArray(input.names) ? input.names.filter((n) => typeof n === 'string').slice(0, MAX_FILM_EDGE_NAMES).map((n) => n.slice(0, 120)) : [];
  record.filmKind = ['color', 'bw', 'positive'].includes(input.filmKind) ? input.filmKind : null;
  record.presetId = typeof input.presetId === 'string' ? input.presetId.slice(0, 64) : null;
  record.frames = Array.isArray(input.frames)
    ? input.frames.slice(0, MAX_FILM_EDGE_FRAMES).map((f) => ({ frameNumber: int(f?.frameNumber, 0, 63), halfFrame: Boolean(f?.halfFrame) })).filter((f) => f.frameNumber !== null)
    : [];
  record.filmBase = input.filmBase && Number.isFinite(Number(input.filmBase.r))
    ? { r: int(input.filmBase.r, 1, 255), g: int(input.filmBase.g, 1, 255), b: int(input.filmBase.b, 1, 255), samples: int(input.filmBase.samples, 0, 1e9) ?? 0 }
    : null;
  record.pxPerMm = Number.isFinite(Number(input.pxPerMm)) ? Number(Number(input.pxPerMm).toFixed(2)) : null;
  record.angleDeg = Number.isFinite(Number(input.angleDeg)) ? Number(Number(input.angleDeg).toFixed(2)) : null;
  record.axis = input.axis === 'y' ? 'y' : 'x';
  record.polarity = input.polarity === 'light' ? 'light' : 'dark';
  record.appliedPreset = Boolean(input.appliedPreset);
  record.appliedFilmBase = Boolean(input.appliedFilmBase);
  record.appliedFilmType = Boolean(input.appliedFilmType);
  return record;
}

// Frame labels for status text: [30A, 31, 31A] -> "30A–31A".
export function formatFilmEdgeFrames(frames) {
  if (!Array.isArray(frames) || !frames.length) return '';
  const label = (f) => `${f.frameNumber}${f.halfFrame ? 'A' : ''}`;
  const sorted = frames.slice().sort((a, b) => (a.frameNumber - b.frameNumber) || (Number(a.halfFrame) - Number(b.halfFrame)));
  if (sorted.length === 1) return label(sorted[0]);
  return `${label(sorted[0])}–${label(sorted[sorted.length - 1])}`;
}

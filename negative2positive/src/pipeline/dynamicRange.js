// Dynamic range compression: the gradient-domain method of Fattal,
// Lischinski and Werman ("Gradient Domain High Dynamic Range Compression",
// SIGGRAPH 2002), implemented from the paper. docs/dynamic-range-compression.md
// has the design, the measurements behind it and what each control does.
//
// The method works on the log luminance H of a frame. Its gradients are
// attenuated by a factor below one for large gradients (the big steps of
// brightness between regions: the range) and kept or raised for small ones
// (detail), measured on several scales so that an edge is attenuated where it
// is, not around it. The luminance whose gradients are the attenuated field
// is found by solving the Poisson equation lap(I) = div(G) with reflected
// borders; each pixel's luminance is then scaled by exp(I) / exp(H).
//
// Where it acts (position B of the design): on the negative, after the
// engine's analysis (black and white points, automatic colour) and before
// its curves, as a per-pixel exposure in linear light, exactly like the
// dodge-and-burn stops (silvercore/util/localExposure.js). The highlights and
// shadows the curve would clip still exist there, and the analysis taken on
// the uncompressed frame keeps the curve from stretching back what was just
// compressed. On a negative the bright areas are the picture's shadows, so
// the gain's sign is read the other way round; a positive (slide) gets the
// same stage at the same point without the inversion.
//
// The equation is solved on a reduced copy of the frame (SOLVE_LONG_SIDE)
// whose size depends only on the frame's aspect ratio. Its result, a small
// map of log gains, is upsampled to any resolution by a joint bilateral
// upsampling (Kopf et al., SIGGRAPH 2007) guided by each pixel's own
// luminance, so a gain changes where the picture's edge is, not beside it.
// The map is a pure function of its sample, and the editor makes the sample
// once from the full-resolution frame, so the display preview, the zoomed
// detail and every export of a photo apply the same map.
//
// Plain JavaScript in Float64 with fixed loop counts: the same sample and
// settings give the same map, bytes and all, on every run.

import { nearestSmoothLength, solvePoissonNeumann } from './dynamicRangeSolver.js';
import { LINEAR_LUT, LINEAR_STEPS } from '../silvercore/util/localExposure.js';

export const DRC_VERSION = 1;

export const DRC_KEYS = Object.freeze([
  'drcAmount', 'drcDetail', 'drcShadows', 'drcHighlights', 'drcLocalContrast', 'drcSaturation'
]);

// Amount 0 is off. At 50 the other five are the method's own: the paper's
// symmetric compression, its amplification of small gradients (bounded), no
// colour change beyond what the curves do.
export const DRC_DEFAULTS = Object.freeze({
  drcAmount: 0,
  drcDetail: 50,
  drcShadows: 50,
  drcHighlights: 50,
  drcLocalContrast: 50,
  drcSaturation: 50
});

/** Solve grid: the long side of the reduced frame the equation is solved on. */
export const SOLVE_LONG_SIDE = 512;
// The coarsest level of the gradient pyramid keeps at least this short side.
const MIN_LEVEL_SIDE = 32;
// Linear luminance offset in the log: keeps the densest, noisiest parts of a
// scan (luminance near 0) from reading as huge log gradients.
export const DRC_EPSILON = 1e-3;
// The attenuation exponent at Amount 100 (the paper uses 0.8-0.9 per level).
const BETA_AT_FULL = 0.78;
// Detail: the percentile of each level's gradients below which a gradient is
// detail and keeps its contrast.
const DETAIL_SHARE_LOW = 0.5;
const DETAIL_SHARE_HIGH = 0.97;
// Local contrast at 100: the most the gradients below the threshold are raised.
const BOOST_AT_FULL = 2;
// Local contrast: the gradients below this quantile of a level are raised.
const RAISE_QUANTILE = 0.7;
// The anchor: this quantile of the frame's log luminance keeps its level.
const ANCHOR_QUANTILE = 0.5;
// The finest pyramid level whose gradients set the attenuation (0 = the grid
// itself): level 0 mostly reads the film's grain.
const FIRST_ATTENUATED_LEVEL = 1;
// Joint bilateral upsampling: the range weight's width in log luminance.
const RANGE_SIGMA = 0.5;
// The log gain the map may hold (about 4.5 stops either way).
const MAX_LOG_GAIN = 3.1;
// Saturation protection at 100: the most a darkened pixel's chroma is reduced,
// reached at PROTECT_STOPS of darkening.
const PROTECT_AT_FULL = 0.6;
const PROTECT_STOPS = 1.5;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const finiteOr = (v, d) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

/** The six controls, clamped to 0..100 and rounded, missing ones at their defaults. */
export function normalizeDrcSettings(settings = {}) {
  const out = {};
  for (const key of DRC_KEYS) out[key] = clamp(Math.round(finiteOr(settings?.[key], DRC_DEFAULTS[key])), 0, 100);
  return out;
}

/** The six controls of a recipe or saved state, sanitised against a fallback. */
export function sanitizeDrcParams(source = {}, fallback = {}) {
  const out = {};
  for (const key of DRC_KEYS) {
    const value = finiteOr(source?.[key], finiteOr(fallback?.[key], DRC_DEFAULTS[key]));
    out[key] = clamp(Math.round(value), 0, 100);
  }
  return out;
}

export function drcEnabled(settings) {
  return finiteOr(settings?.drcAmount, 0) > 0;
}

/**
 * What the controls mean for the method (docs/dynamic-range-compression.md):
 * - beta: the attenuation exponent of every level (Amount);
 * - detailShare: the share of the frame, from its calmest gradients up, whose
 *   gradients keep at least their contrast; the rest is compressed (Detail);
 * - boostCap: how far that calm share's gradients may be raised, the paper's
 *   amplification of small gradients bounded (Local contrast);
 * - shadowShare / highlightShare: the parts of the gain that brighten and
 *   darken the picture, 1 = the method's own (Shadows, Highlights);
 * - protect: how much chroma a pixel the compression darkened may lose
 *   (Saturation protection).
 */
export function drcMethodParams(settings) {
  const s = normalizeDrcSettings(settings);
  const amount = s.drcAmount / 100;
  const beta = 1 - (1 - BETA_AT_FULL) * amount;
  const local = s.drcLocalContrast / 100;
  return {
    amount,
    beta,
    detailShare: DETAIL_SHARE_LOW + (DETAIL_SHARE_HIGH - DETAIL_SHARE_LOW) * (s.drcDetail / 100),
    // Below the threshold: no change at 0, the attenuation's own exponent
    // mirrored at 50 (the paper's single power law), twice that at 100.
    betaLow: 1 - (1 - beta) * 2 * local,
    boostCap: 1 + (BOOST_AT_FULL - 1) * local,
    shadowShare: s.drcShadows / 50,
    highlightShare: s.drcHighlights / 50,
    protect: (s.drcSaturation / 100) * PROTECT_AT_FULL
  };
}

/** The settings a map depends on (all but Saturation protection), as a cache key. */
export function drcMapKey(settings) {
  const s = normalizeDrcSettings(settings);
  return `${DRC_VERSION}:${s.drcAmount}:${s.drcDetail}:${s.drcShadows}:${s.drcHighlights}:${s.drcLocalContrast}`;
}

/** The solve grid of a frame: about SOLVE_LONG_SIDE on its long side, both sides of 2, 3 and 5 only. */
export function drcSolveSize(width, height, longSide = SOLVE_LONG_SIDE) {
  const long = Math.max(width, height);
  const scale = longSide / long;
  return {
    width: nearestSmoothLength(Math.max(8, width * scale)),
    height: nearestSmoothLength(Math.max(8, height * scale))
  };
}

export const DRC_LUMA = Object.freeze([0.2126, 0.7152, 0.0722]);

// The linear value of a 16-bit code: LINEAR_LUT interpolated exactly as
// exposeRgbaRun reads it.
function linear16(v) {
  const idx = (v / 65535) * LINEAR_STEPS;
  const i0 = Math.floor(idx);
  const f = idx - i0;
  return LINEAR_LUT[i0] * (1 - f) + LINEAR_LUT[i0 < LINEAR_STEPS ? i0 + 1 : LINEAR_STEPS] * f;
}

/**
 * The sample a map is solved from: the frame's linear luminance on the solve
 * grid. Each cell averages the 16-bit codes it covers (integer sums, so the
 * order the rows are read in cannot change a value) and is then made linear;
 * a frame smaller than the grid is sampled bilinearly.
 *
 * The builder does one grid row per step, so the page can spread the work
 * over short slices (createDrcSampler) and get the same numbers as
 * sampleDrcInput, which runs it to the end.
 *
 * @param {Uint16Array} data - RGBA, the negative (or positive) as the engine receives it
 * @param {number} width
 * @param {number} height
 * @param {object} [options]
 * @param {number} [options.longSide]
 * @param {number} [options.scale] - 257 for an 8-bit plane
 */
export function createDrcSampleBuilder(data, width, height, options = {}) {
  const w3 = DRC_LUMA;
  const grid = drcSolveSize(width, height, options.longSide);
  const gw = grid.width;
  const gh = grid.height;
  const lum = new Float32Array(gw * gh);
  const cellLum = (r, g, b) => w3[0] * linear16(r) + w3[1] * linear16(g) + w3[2] * linear16(b);
  const reduce = width >= gw && height >= gh;
  // An 8-bit plane read as the 16-bit one the adapter promotes it to (x 257):
  // integer sums times 257 are the 16-bit sums exactly.
  const scale = options.scale || 1;
  const acc = new Float64Array(gw * 3);
  const count = new Float64Array(gw);
  const xStart = new Int32Array(gw + 1);
  for (let gx = 0; gx <= gw; gx++) xStart[gx] = Math.floor((gx * width) / gw);
  let gy = 0;
  function row() {
    if (reduce) {
      const y0 = Math.floor((gy * height) / gh);
      const y1 = Math.floor(((gy + 1) * height) / gh);
      acc.fill(0);
      count.fill(0);
      for (let y = y0; y < y1; y++) {
        const base = y * width * 4;
        for (let gx = 0; gx < gw; gx++) {
          const x0 = xStart[gx];
          const x1 = xStart[gx + 1];
          let r = 0; let g = 0; let b = 0;
          for (let i = base + x0 * 4, end = base + x1 * 4; i < end; i += 4) {
            r += data[i]; g += data[i + 1]; b += data[i + 2];
          }
          acc[gx * 3] += r; acc[gx * 3 + 1] += g; acc[gx * 3 + 2] += b;
          count[gx] += x1 - x0;
        }
      }
      for (let gx = 0; gx < gw; gx++) {
        const n = count[gx] || 1;
        lum[gy * gw + gx] = cellLum((acc[gx * 3] * scale) / n, (acc[gx * 3 + 1] * scale) / n, (acc[gx * 3 + 2] * scale) / n);
      }
    } else {
      const fy = clamp(((gy + 0.5) * height) / gh - 0.5, 0, height - 1);
      const y0 = Math.floor(fy); const y1 = Math.min(height - 1, y0 + 1); const wy = fy - y0;
      for (let gx = 0; gx < gw; gx++) {
        const fx = clamp(((gx + 0.5) * width) / gw - 0.5, 0, width - 1);
        const x0 = Math.floor(fx); const x1 = Math.min(width - 1, x0 + 1); const wx = fx - x0;
        const at = (c) => {
          const a = data[(y0 * width + x0) * 4 + c] * scale * (1 - wx) + data[(y0 * width + x1) * 4 + c] * scale * wx;
          const b = data[(y1 * width + x0) * 4 + c] * scale * (1 - wx) + data[(y1 * width + x1) * 4 + c] * scale * wx;
          return a * (1 - wy) + b * wy;
        };
        lum[gy * gw + gx] = cellLum(at(0), at(1), at(2));
      }
    }
    gy++;
  }
  return {
    width: gw,
    height: gh,
    /** Runs up to `rows` grid rows; true once the sample is complete. */
    step(rows = gh) {
      for (let k = 0; k < rows && gy < gh; k++) row();
      return gy >= gh;
    },
    get done() { return gy >= gh; },
    /** Source pixels one step reads (for slicing by time). */
    get pixelsPerRow() { return reduce ? Math.ceil(height / gh) * width : gw * 4; },
    result() {
      if (gy < gh) throw new Error('The sample is not complete');
      return { width: gw, height: gh, lum };
    }
  };
}

/** The whole sample at once (createDrcSampleBuilder run to the end). */
export function sampleDrcInput(data, width, height, options = {}) {
  const builder = createDrcSampleBuilder(data, width, height, options);
  builder.step();
  return builder.result();
}

// 5-tap binomial reduce by two (reflected borders).
function reduceLevel(src, w, h) {
  const nw = Math.ceil(w / 2);
  const nh = Math.ceil(h / 2);
  const tmp = new Float64Array(nw * h);
  const k = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16];
  const rx = (x) => (x < 0 ? -x - 1 : x >= w ? 2 * w - x - 1 : x);
  const ry = (y) => (y < 0 ? -y - 1 : y >= h ? 2 * h - y - 1 : y);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < nw; x++) {
      const cx = 2 * x;
      let s = 0;
      for (let t = -2; t <= 2; t++) s += k[t + 2] * src[y * w + rx(cx + t)];
      tmp[y * nw + x] = s;
    }
  }
  const out = new Float64Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const cy = 2 * y;
    for (let x = 0; x < nw; x++) {
      let s = 0;
      for (let t = -2; t <= 2; t++) s += k[t + 2] * tmp[ry(cy + t) * nw + x];
      out[y * nw + x] = s;
    }
  }
  return { data: out, width: nw, height: nh };
}

function gradientMagnitude(level, scale) {
  const { data, width: w, height: h } = level;
  const mag = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const ym = y > 0 ? y - 1 : y;
    const yp = y < h - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : x;
      const xp = x < w - 1 ? x + 1 : x;
      const gx = (data[y * w + xp] - data[y * w + xm]) / ((xp - xm || 1) * scale);
      const gy = (data[yp * w + x] - data[ym * w + x]) / ((yp - ym || 1) * scale);
      mag[y * w + x] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return mag;
}

// The q-quantile of a level's gradient magnitudes, from a fixed stride of
// samples (exact on small levels).
function quantile(values, q) {
  const stride = Math.max(1, Math.floor(values.length / 65536));
  const n = Math.floor((values.length - 1) / stride) + 1;
  const sample = new Float64Array(n);
  for (let i = 0, j = 0; j < n; i += stride, j++) sample[j] = values[i];
  sample.sort();
  return sample[Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))))];
}

// Bilinear upsampling of a coarse level's field to the next finer level's grid.
function upsampleTo(field, cw, ch, w, h) {
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = clamp((y + 0.5) * (ch / h) - 0.5, 0, ch - 1);
    const y0 = Math.floor(fy); const y1 = Math.min(ch - 1, y0 + 1); const wy = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = clamp((x + 0.5) * (cw / w) - 0.5, 0, cw - 1);
      const x0 = Math.floor(fx); const x1 = Math.min(cw - 1, x0 + 1); const wx = fx - x0;
      const a = field[y0 * cw + x0] * (1 - wx) + field[y0 * cw + x1] * wx;
      const b = field[y1 * cw + x0] * (1 - wx) + field[y1 * cw + x1] * wx;
      out[y * w + x] = a * (1 - wy) + b * wy;
    }
  }
  return out;
}

/**
 * The attenuation field Phi on the finest level (the paper's equation 6):
 * phi_k = (|grad H_k| / alpha_k)^(beta - 1) on the levels of a Gaussian
 * pyramid, multiplied from the coarsest level down, so an edge is attenuated
 * on the scales where it is strong.
 *
 * Two departures from the paper, both measured on real frames
 * (docs/dynamic-range-compression.md): alpha_k is a percentile of the level's
 * own gradients (the Detail control) rather than 0.1 of their mean, and a
 * gradient below it is left as it is (phi_k = 1) unless Local contrast raises
 * it (exponent betaLow, the product of the raises bounded by boostCap). The
 * Local contrast raises the gradients below the level's median.
 * The paper raises every small gradient on every level and then rescales the
 * whole result to the display; without that rescale (the anchor keeps the
 * frame's level) the texture of every busy area lost a fifth of its contrast.
 */
export function attenuationField(H, width, height, method) {
  const levels = [{ data: H, width, height }];
  while (Math.min(levels[levels.length - 1].width, levels[levels.length - 1].height) >= 2 * MIN_LEVEL_SIDE) {
    const top = levels[levels.length - 1];
    levels.push(reduceLevel(top.data, top.width, top.height));
  }
  let phi = null;
  let raise = null;
  let pw = 0; let ph = 0;
  const eHigh = method.beta - 1;
  const eLow = method.betaLow - 1;
  for (let k = levels.length - 1; k >= 0; k--) {
    const level = levels[k];
    const n = level.width * level.height;
    const local = new Float64Array(n);
    const localRaise = new Float64Array(n);
    if (k >= FIRST_ATTENUATED_LEVEL) {
      const mag = gradientMagnitude(level, 2 ** k);
      const alpha = Math.max(quantile(mag, method.detailShare), 1e-6);
      // Local contrast raises the gradients below the level's median (or
      // below the detail threshold, if that is lower): what is raised does
      // not grow with what Detail protects.
      const raiseBelow = Math.min(alpha, Math.max(quantile(mag, RAISE_QUANTILE), 1e-6));
      for (let i = 0; i < n; i++) {
        const g = Math.max(mag[i], 1e-9);
        const ratio = g / alpha;
        local[i] = ratio > 1 ? Math.pow(ratio, eHigh) : 1;
        const below = g / raiseBelow;
        localRaise[i] = below < 1 && eLow < 0 ? Math.pow(Math.max(below, 0.05), eLow) : 1;
      }
    } else {
      local.fill(1);
      localRaise.fill(1);
    }
    if (phi) {
      const up = upsampleTo(phi, pw, ph, level.width, level.height);
      const upRaise = upsampleTo(raise, pw, ph, level.width, level.height);
      for (let i = 0; i < n; i++) { local[i] *= up[i]; localRaise[i] *= upRaise[i]; }
    }
    phi = local; raise = localRaise; pw = level.width; ph = level.height;
  }
  for (let i = 0; i < phi.length; i++) phi[i] *= raise[i] > method.boostCap ? method.boostCap : raise[i];
  return phi;
}

/**
 * The compressed log luminance I for log luminance H on a grid: Phi from
 * attenuationField, G = Phi grad H with forward differences (Phi averaged
 * over the two pixels a difference joins), div G with backward differences,
 * lap(I) = div G solved exactly. I has the mean of H.
 */
export function compressLogLuminance(H, width, height, method, phi = attenuationField(H, width, height, method)) {
  const n = width * height;
  const gx = new Float64Array(n);
  const gy = new Float64Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (x < width - 1) gx[i] = (H[i + 1] - H[i]) * 0.5 * (phi[i] + phi[i + 1]);
      if (y < height - 1) gy[i] = (H[i + width] - H[i]) * 0.5 * (phi[i] + phi[i + width]);
    }
  }
  const f = new Float64Array(n);
  let mean = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      f[i] = gx[i] - (x > 0 ? gx[i - 1] : 0) + gy[i] - (y > 0 ? gy[i - width] : 0);
      mean += H[i];
    }
  }
  mean /= n;
  solvePoissonNeumann(f, width, height);
  for (let i = 0; i < n; i++) f[i] += mean;
  return f;
}

/**
 * The map of one photo: the log gain on the solve grid, and the grid's log
 * luminance that guides its upsampling.
 *
 * The solved luminance is anchored so that the frame's median log luminance
 * keeps its level (a frame that is mostly a dark void keeps it dark; the
 * middle of the range would lift it to an empty grey), then the parts of the
 * gain that brighten and darken the picture are scaled by the Shadows and
 * Highlights shares (1 and 1: the method as published).
 *
 * @param {{ width: number, height: number, lum: Float32Array }} sample - sampleDrcInput
 * @param {object} settings - the drc* settings
 * @param {object} [options]
 * @param {boolean} [options.inverted] - the sample is a negative's: its bright areas are the picture's shadows
 * @returns {{ version, width, height, logGain: Float32Array, guide: Float32Array, stats: object }|null}
 *   null when Amount is 0
 */
export function solveDrcMap(sample, settings, options = {}) {
  if (!drcEnabled(settings) || !sample?.lum || sample.lum.length !== sample.width * sample.height) return null;
  const method = drcMethodParams(settings);
  const inverted = Boolean(options.inverted);
  const eps = DRC_EPSILON;
  const { width, height, lum } = sample;
  const n = width * height;
  const H = new Float64Array(n);
  for (let i = 0; i < n; i++) H[i] = Math.log(lum[i] + eps);
  const I = compressLogLuminance(H, width, height, method);
  const offset = quantile(H, ANCHOR_QUANTILE) - quantile(I, ANCHOR_QUANTILE);
  const logGain = new Float32Array(n);
  const guide = new Float32Array(n);
  let lifted = 0; let lowered = 0;
  for (let i = 0; i < n; i++) {
    // The gain of the luminance itself: exp(I) is L + eps.
    const out = Math.max(1e-12, Math.exp(I[i] + offset) - eps);
    let g = lum[i] > 0 ? Math.log(out / lum[i]) : 0;
    const brightens = inverted ? g < 0 : g > 0;
    g *= brightens ? method.shadowShare : method.highlightShare;
    g = clamp(g, -MAX_LOG_GAIN, MAX_LOG_GAIN);
    logGain[i] = g;
    guide[i] = H[i];
    if (brightens) lifted += Math.abs(g); else lowered += Math.abs(g);
  }
  return {
    version: DRC_VERSION,
    width,
    height,
    logGain,
    guide,
    stats: { meanBrightenStops: (lifted / n) * Math.LOG2E, meanDarkenStops: (lowered / n) * Math.LOG2E }
  };
}

// ---------------------------------------------------------------------------
// The per-pixel stage: stops of exposure on the negative

const RANGE_TABLE_SIZE = 1024; // exp(-d^2 / 2 sigma^2) over d in [0, 4 sigma]
let rangeTable = null;
function rangeWeights() {
  if (rangeTable) return rangeTable;
  const max = 4 * RANGE_SIGMA;
  const table = new Float64Array(RANGE_TABLE_SIZE + 2);
  for (let i = 0; i <= RANGE_TABLE_SIZE + 1; i++) {
    const d = (Math.min(i, RANGE_TABLE_SIZE) / RANGE_TABLE_SIZE) * max;
    table[i] = Math.exp(-(d * d) / (2 * RANGE_SIGMA * RANGE_SIGMA));
  }
  rangeTable = { table, scale: RANGE_TABLE_SIZE / max };
  return rangeTable;
}

function rangeWeight(t, d) {
  const pos = d * t.scale;
  if (pos >= RANGE_TABLE_SIZE) return t.table[RANGE_TABLE_SIZE];
  const i = pos | 0;
  const f = pos - i;
  return t.table[i] + (t.table[i + 1] - t.table[i]) * f;
}

/** The stage of a map: what the per-pixel functions read. */
export function buildDrcStage(map) {
  if (!map || !(map.logGain?.length === map.width * map.height) || !(map.guide?.length === map.logGain.length)) return null;
  return { width: map.width, height: map.height, logGain: map.logGain, guide: map.guide, range: rangeWeights() };
}

/**
 * The log gain (natural log, linear light) of one pixel at normalised frame
 * position (u, v) with log luminance h: the map's four neighbours weighted
 * by distance and by how close their luminance is to the pixel's.
 */
export function drcLogGainAt(stage, u, v, h) {
  const { width: gw, height: gh, logGain, guide, range } = stage;
  const fx = clamp(u * gw - 0.5, 0, gw - 1);
  const fy = clamp(v * gh - 0.5, 0, gh - 1);
  const x0 = fx | 0; const y0 = fy | 0;
  const x1 = x0 + 1 < gw ? x0 + 1 : x0;
  const y1 = y0 + 1 < gh ? y0 + 1 : y0;
  const wx = fx - x0; const wy = fy - y0;
  const i00 = y0 * gw + x0; const i01 = y0 * gw + x1; const i10 = y1 * gw + x0; const i11 = y1 * gw + x1;
  const w00 = (1 - wx) * (1 - wy) * rangeWeight(range, Math.abs(h - guide[i00]));
  const w01 = wx * (1 - wy) * rangeWeight(range, Math.abs(h - guide[i01]));
  const w10 = (1 - wx) * wy * rangeWeight(range, Math.abs(h - guide[i10]));
  const w11 = wx * wy * rangeWeight(range, Math.abs(h - guide[i11]));
  const sum = w00 + w01 + w10 + w11;
  if (sum > 1e-9) return (w00 * logGain[i00] + w01 * logGain[i01] + w10 * logGain[i10] + w11 * logGain[i11]) / sum;
  // No neighbour shares the pixel's luminance: the plain bilinear value.
  return (1 - wy) * ((1 - wx) * logGain[i00] + wx * logGain[i01]) + wy * ((1 - wx) * logGain[i10] + wx * logGain[i11]);
}

/**
 * The compression's stops (log2 of the linear gain) for every pixel of a
 * 16-bit RGBA plane, guided by each pixel's own linear luminance.
 *
 * @param {Uint16Array} data
 * @param {number} width
 * @param {number} height
 * @param {object} stage - buildDrcStage
 * @param {object} [options]
 * @param {number[]} [options.weights]
 * @param {{ x: number, y: number, frameWidth: number, frameHeight: number }} [options.frame] - the
 *   plane is a window of a larger frame (a detail region): its origin and the frame's size
 * @param {Float32Array} [options.out]
 * @returns {Float32Array}
 */
export function computeDrcStops(data, width, height, stage, options = {}) {
  const w3 = options.weights || DRC_LUMA;
  const frame = options.frame || { x: 0, y: 0, frameWidth: width, frameHeight: height };
  const n = width * height;
  const out = options.out && options.out.length === n ? options.out : new Float32Array(n);
  const { width: gw, height: gh, logGain, guide, range } = stage;
  // The bilinear part of drcLogGainAt, per column and per row.
  const cx0 = new Int32Array(width); const cx1 = new Int32Array(width); const cwx = new Float64Array(width);
  for (let x = 0; x < width; x++) {
    const fx = clamp(((frame.x + x + 0.5) / frame.frameWidth) * gw - 0.5, 0, gw - 1);
    cx0[x] = fx | 0; cx1[x] = cx0[x] + 1 < gw ? cx0[x] + 1 : cx0[x]; cwx[x] = fx - cx0[x];
  }
  const logTable = logLuminanceTable();
  const rangeTable = range.table;
  const rangeScale = range.scale;
  const lut = LINEAR_LUT;
  const toIndex = LINEAR_STEPS / 65535;
  for (let y = 0; y < height; y++) {
    const fy = clamp(((frame.y + y + 0.5) / frame.frameHeight) * gh - 0.5, 0, gh - 1);
    const y0 = fy | 0; const y1 = y0 + 1 < gh ? y0 + 1 : y0; const wy = fy - y0;
    const row0 = y0 * gw; const row1 = y1 * gw;
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const i = p * 4;
      // linear16 of each channel, inlined.
      let idx = data[i] * toIndex; let k = idx | 0; let f = idx - k;
      const lr = lut[k] + (lut[k < LINEAR_STEPS ? k + 1 : k] - lut[k]) * f;
      idx = data[i + 1] * toIndex; k = idx | 0; f = idx - k;
      const lg = lut[k] + (lut[k < LINEAR_STEPS ? k + 1 : k] - lut[k]) * f;
      idx = data[i + 2] * toIndex; k = idx | 0; f = idx - k;
      const lb = lut[k] + (lut[k < LINEAR_STEPS ? k + 1 : k] - lut[k]) * f;
      const L = w3[0] * lr + w3[1] * lg + w3[2] * lb;
      // log(L + eps) from the table.
      const pos = (L < 1 ? (L > 0 ? L : 0) : 1) * LOG_TABLE_STEPS;
      const t = pos | 0;
      const h = logTable[t] + (logTable[t < LOG_TABLE_STEPS ? t + 1 : t] - logTable[t]) * (pos - t);
      const a = cx0[x]; const b = cx1[x]; const wx = cwx[x];
      const i00 = row0 + a; const i01 = row0 + b; const i10 = row1 + a; const i11 = row1 + b;
      let d; let r;
      d = (h > guide[i00] ? h - guide[i00] : guide[i00] - h) * rangeScale;
      r = d >= RANGE_TABLE_SIZE ? rangeTable[RANGE_TABLE_SIZE] : rangeTable[d | 0] + (rangeTable[(d | 0) + 1] - rangeTable[d | 0]) * (d - (d | 0));
      const w00 = (1 - wx) * (1 - wy) * r;
      d = (h > guide[i01] ? h - guide[i01] : guide[i01] - h) * rangeScale;
      r = d >= RANGE_TABLE_SIZE ? rangeTable[RANGE_TABLE_SIZE] : rangeTable[d | 0] + (rangeTable[(d | 0) + 1] - rangeTable[d | 0]) * (d - (d | 0));
      const w01 = wx * (1 - wy) * r;
      d = (h > guide[i10] ? h - guide[i10] : guide[i10] - h) * rangeScale;
      r = d >= RANGE_TABLE_SIZE ? rangeTable[RANGE_TABLE_SIZE] : rangeTable[d | 0] + (rangeTable[(d | 0) + 1] - rangeTable[d | 0]) * (d - (d | 0));
      const w10 = (1 - wx) * wy * r;
      d = (h > guide[i11] ? h - guide[i11] : guide[i11] - h) * rangeScale;
      r = d >= RANGE_TABLE_SIZE ? rangeTable[RANGE_TABLE_SIZE] : rangeTable[d | 0] + (rangeTable[(d | 0) + 1] - rangeTable[d | 0]) * (d - (d | 0));
      const w11 = wx * wy * r;
      const sum = w00 + w01 + w10 + w11;
      const g = sum > 1e-9
        ? (w00 * logGain[i00] + w01 * logGain[i01] + w10 * logGain[i10] + w11 * logGain[i11]) / sum
        : (1 - wy) * ((1 - wx) * logGain[i00] + wx * logGain[i01]) + wy * ((1 - wx) * logGain[i10] + wx * logGain[i11]);
      out[p] = g * Math.LOG2E;
    }
  }
  return out;
}

// log(L + DRC_EPSILON) over L in [0, 1], for computeDrcStops.
const LOG_TABLE_STEPS = 65536;
let logTableCache = null;
function logLuminanceTable() {
  if (!logTableCache) {
    logTableCache = new Float64Array(LOG_TABLE_STEPS + 1);
    for (let i = 0; i <= LOG_TABLE_STEPS; i++) logTableCache[i] = Math.log(i / LOG_TABLE_STEPS + DRC_EPSILON);
  }
  return logTableCache;
}

/** The sum of a dense stops map and the compression's (a new dense map); tiled maps are read tile by tile. */
export function addStops(drcStops, strokes, width, height) {
  const out = new Float32Array(drcStops);
  if (!strokes) return out;
  if (strokes.tiled === true && Array.isArray(strokes.tiles)) {
    const { tileSize, columns, rows, tiles } = strokes;
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const tile = tiles[row * columns + column];
        if (!tile) continue;
        const x0 = column * tileSize; const y0 = row * tileSize;
        const w = Math.min(tileSize, width - x0); const h = Math.min(tileSize, height - y0);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[(y0 + y) * width + x0 + x] += tile[y * tileSize + x];
      }
    }
    return out;
  }
  if (strokes.length === out.length) for (let i = 0; i < out.length; i++) out[i] += strokes[i];
  return out;
}

/**
 * Saturation protection, after the curves: a pixel the compression darkened
 * by d stops loses up to `protect` of its chroma (around its Rec. 709
 * luminance), reached at PROTECT_STOPS. Brought down from the shoulder of the
 * film's curve, highlights regain colour the curve had compressed, and they
 * can come back stronger and more cast than they look; lifted shadows
 * (which lose saturation instead) are left alone.
 *
 * @param {{ width, height, data: Uint16Array }} image16 - the positive, in place
 * @param {Float32Array} stops - the compression's stops on the negative (computeDrcStops)
 * @param {number} protect - drcMethodParams(settings).protect
 * @param {boolean} inverted - a negative: positive stops darken the picture
 */
export function applyDrcProtection(image16, stops, protect, inverted) {
  if (!(protect > 0) || !stops || stops.length !== image16.width * image16.height) return image16;
  const d = image16.data;
  const sign = inverted ? 1 : -1;
  const k = protect / PROTECT_STOPS;
  for (let p = 0; p < stops.length; p++) {
    const darkening = stops[p] * sign;
    if (!(darkening > 0)) continue;
    const keep = 1 - (darkening >= PROTECT_STOPS ? protect : darkening * k);
    const i = p * 4;
    const r = d[i]; const g = d[i + 1]; const b = d[i + 2];
    const Y = DRC_LUMA[0] * r + DRC_LUMA[1] * g + DRC_LUMA[2] * b;
    d[i] = clamp(Math.round(Y + (r - Y) * keep), 0, 65535);
    d[i + 1] = clamp(Math.round(Y + (g - Y) * keep), 0, 65535);
    d[i + 2] = clamp(Math.round(Y + (b - Y) * keep), 0, 65535);
  }
  return image16;
}

/**
 * How much a photo would gain from the compression, from its converted
 * positive (16-bit RGBA, any size): the shares of pixels within a few levels
 * of black and of white. Strided, about 64k samples.
 */
export function measureDrcClipping(data, width, height) {
  const n = width * height;
  const stride = Math.max(1, Math.floor(n / 65536));
  let low = 0; let high = 0; let count = 0;
  const lowLimit = 0.03 * 65535;
  const highLimit = 0.97 * 65535;
  for (let p = 0; p < n; p += stride) {
    const i = p * 4;
    const Y = DRC_LUMA[0] * data[i] + DRC_LUMA[1] * data[i + 1] + DRC_LUMA[2] * data[i + 2];
    if (Y <= lowLimit) low++;
    else if (Y >= highLimit) high++;
    count++;
  }
  return { shadows: count ? low / count : 0, highlights: count ? high / count : 0 };
}

// ---------------------------------------------------------------------------
// The hint and Auto: what the compression would do to a photo

/** The share of the frame the hint asks to be brought back from near black or white. */
export const DRC_HINT_THRESHOLD = 0.08;
const HINT_AMOUNTS = [30, 50, 70];
const HINT_SAMPLES = 32768;

function exposeCode(v, stops) {
  if (stops === 0) return v;
  const linear = linear16(v) * Math.pow(2, stops);
  return Math.round(Math.pow(linear < 1 ? linear : 1, 1 / 2.2) * 65535);
}

/**
 * Estimates, on a strided subsample of the negative, how much of the frame
 * sits near black or white after the conversion's curves, without the
 * compression and with it at a few amounts. Only the curves are evaluated
 * (not the colour stages after them), which is enough to tell a frame whose
 * ends the compression brings back from one that is dark or bright by design.
 *
 * @param {object} input - { data: Uint16Array RGBA, width, height } the negative as the engine receives it
 * @param {{ r: Uint16Array, g: Uint16Array, b: Uint16Array }} luts - the conversion's curves (65536 entries)
 * @param {object} sample - sampleDrcInput of the frame
 * @param {boolean} inverted - a negative
 * @returns {{ base: { shadows, highlights }, byAmount: object, reduction: number, suggested: object|null }}
 */
export function estimateDrcEffect(input, luts, sample, inverted) {
  const { data, width, height } = input;
  const n = width * height;
  const stride = Math.max(1, Math.floor(n / HINT_SAMPLES));
  const idx = [];
  for (let p = 0; p < n; p += stride) idx.push(p);
  const lowLimit = 0.03 * 65535;
  const highLimit = 0.97 * 65535;
  const shares = (stopsAt) => {
    let low = 0; let high = 0;
    for (let k = 0; k < idx.length; k++) {
      const p = idx[k];
      const i = p * 4;
      const s = stopsAt ? stopsAt(p, i) : 0;
      const r = luts.r[exposeCode(data[i], s)];
      const g = luts.g[exposeCode(data[i + 1], s)];
      const b = luts.b[exposeCode(data[i + 2], s)];
      const Y = DRC_LUMA[0] * r + DRC_LUMA[1] * g + DRC_LUMA[2] * b;
      if (Y <= lowLimit) low++; else if (Y >= highLimit) high++;
    }
    return { shadows: low / idx.length, highlights: high / idx.length };
  };
  const base = shares(null);
  const byAmount = {};
  for (const amount of HINT_AMOUNTS) {
    const map = solveDrcMap(sample, { drcAmount: amount }, { inverted });
    const stage = buildDrcStage(map);
    byAmount[amount] = shares((p, i) => {
      const x = p % width; const y = (p - x) / width;
      const L = DRC_LUMA[0] * linear16(data[i]) + DRC_LUMA[1] * linear16(data[i + 1]) + DRC_LUMA[2] * linear16(data[i + 2]);
      return drcLogGainAt(stage, (x + 0.5) / width, (y + 0.5) / height, Math.log(L + DRC_EPSILON)) * Math.LOG2E;
    });
  }
  const clipped = (s) => s.shadows + s.highlights;
  const reduction = clipped(base) - clipped(byAmount[50]);
  return { base, byAmount, reduction, suggested: suggestDrcSettings(base, byAmount) };
}

/**
 * Auto: the six controls for a photo from estimateDrcEffect's numbers. The
 * smallest amount that brings back most of what 70 would; the end that was
 * clipped more gets the larger share. Detail, local contrast and saturation
 * protection stay at their defaults.
 */
export function suggestDrcSettings(base, byAmount) {
  const clipped = (s) => s.shadows + s.highlights;
  const before = clipped(base);
  const best = before - clipped(byAmount[70]);
  let amount = 70;
  for (const candidate of [30, 50]) {
    if (before - clipped(byAmount[candidate]) >= 0.8 * best) { amount = candidate; break; }
  }
  if (!(best > 0.005)) amount = 30;
  const lean = base.shadows + base.highlights > 0 ? (base.highlights - base.shadows) / (base.shadows + base.highlights) : 0;
  return {
    ...DRC_DEFAULTS,
    drcAmount: amount,
    drcShadows: clamp(Math.round(50 - 15 * lean), 0, 100),
    drcHighlights: clamp(Math.round(50 + 15 * lean), 0, 100)
  };
}

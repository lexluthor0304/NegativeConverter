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
import { analysisPixelBounds } from '../app/analysisRegion.js';

export const DRC_VERSION = 2;

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
  drcSaturation: 75
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
// Where a pixel may be moved (drcLimitGain): the frame's extremes are the
// 0.5 % and 99.5 % quantiles of the solve grid's log luminance; a pixel moves
// freely up to the middle (the anchor) and at least LIMIT_MARGIN (natural
// log, half a stop) inside an extreme, then through a soft knee a quarter of
// the remaining way wide. Measured on 66 real negatives and 32 public frames
// (docs/dynamic-range-compression.md).
const LIMIT_QUANTILE = 0.005;
const LIMIT_SOFT = 0.25;
const LIMIT_MARGIN = 0.35;
export const DRC_LIMIT_SOFT = LIMIT_SOFT;
export const DRC_LIMIT_MARGIN = LIMIT_MARGIN;
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
  // Local contrast: -1 at 0, 0 at 50 (small gradients as they are), 1 at 100.
  const local = (s.drcLocalContrast - 50) / 50;
  return {
    amount,
    beta,
    detailShare: DETAIL_SHARE_LOW + (DETAIL_SHARE_HIGH - DETAIL_SHARE_LOW) * (s.drcDetail / 100),
    // Below the raise threshold: flattened towards 0, as they are at 50,
    // raised towards 100 (at 100 twice the attenuation's exponent, mirrored).
    betaLow: 1 - (1 - beta) * 2 * local,
    boostCap: local > 0 ? 1 + (BOOST_AT_FULL - 1) * local : 1,
    shadowShare: s.drcShadows / 50,
    highlightShare: s.drcHighlights / 50,
    protect: (s.drcSaturation / 100) * PROTECT_AT_FULL
  };
}

/** The settings a map depends on (Amount, Detail, Local contrast), as a cache key. */
export function drcMapKey(settings) {
  const s = normalizeDrcSettings(settings);
  return `${DRC_VERSION}:${s.drcAmount}:${s.drcDetail}:${s.drcLocalContrast}`;
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
 * The sample a map is solved from: the frame's mean 16-bit codes per cell of
 * the solve grid (R, G, B; integer sums, so the order the rows are read in
 * cannot change a value), a frame smaller than the grid sampled bilinearly.
 * It is taken from the frame as the conversion receives it (geometry
 * applied, before film-base compensation), which the editor and every
 * conversion of a photo have alike; the preprocessing the engine does before
 * the exposure stage is applied to each cell when the map is solved
 * (drcSampleLuminance).
 *
 * The builder does one grid row per step, so the page can spread the work
 * over short slices (app/dynamicRangeHint.js) and get the numbers of
 * sampleDrcInput, which runs it to the end.
 *
 * @param {Uint16Array|Uint8Array|Uint8ClampedArray} data - RGBA
 * @param {number} width
 * @param {number} height
 * @param {object} [options]
 * @param {number} [options.longSide]
 * @param {number} [options.scale] - 257 for an 8-bit plane (read as the adapter's 16-bit promotion)
 */
export function createDrcSampleBuilder(data, width, height, options = {}) {
  const grid = drcSolveSize(width, height, options.longSide);
  const gw = grid.width;
  const gh = grid.height;
  const rgb = new Float32Array(gw * gh * 3);
  const reduce = width >= gw && height >= gh;
  // Integer sums times 257 are the 16-bit promotion's sums exactly.
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
        const o = (gy * gw + gx) * 3;
        rgb[o] = (acc[gx * 3] * scale) / n;
        rgb[o + 1] = (acc[gx * 3 + 1] * scale) / n;
        rgb[o + 2] = (acc[gx * 3 + 2] * scale) / n;
      }
    } else {
      const fy = clamp(((gy + 0.5) * height) / gh - 0.5, 0, height - 1);
      const y0 = Math.floor(fy); const y1 = Math.min(height - 1, y0 + 1); const wy = fy - y0;
      for (let gx = 0; gx < gw; gx++) {
        const fx = clamp(((gx + 0.5) * width) / gw - 0.5, 0, width - 1);
        const x0 = Math.floor(fx); const x1 = Math.min(width - 1, x0 + 1); const wx = fx - x0;
        const o = (gy * gw + gx) * 3;
        for (let c = 0; c < 3; c++) {
          const a = data[(y0 * width + x0) * 4 + c] * scale * (1 - wx) + data[(y0 * width + x1) * 4 + c] * scale * wx;
          const b = data[(y1 * width + x0) * 4 + c] * scale * (1 - wx) + data[(y1 * width + x1) * 4 + c] * scale * wx;
          rgb[o + c] = a * (1 - wy) + b * wy;
        }
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
    result() {
      if (gy < gh) throw new Error('The sample is not complete');
      return { width: gw, height: gh, rgb };
    }
  };
}

/** The whole sample at once (createDrcSampleBuilder run to the end). */
export function sampleDrcInput(data, width, height, options = {}) {
  const builder = createDrcSampleBuilder(data, width, height, options);
  builder.step();
  return builder.result();
}

/**
 * The engine's preprocessing before its exposure stage, applied to one cell's
 * mean (16-bit codes, in place in `c`): film-base gains, the B&W mix, the
 * pre-tone saturation, the positive's gain and white balance. The same
 * arithmetic as the pixel stages, without their rounding (a mean has none).
 * The flat field is not applied to the sample.
 */
function prepareCell(c, prep) {
  if (prep.gains) {
    c[0] = Math.min(65535, c[0] * prep.gains.r);
    c[1] = Math.min(65535, c[1] * prep.gains.g);
    c[2] = Math.min(65535, c[2] * prep.gains.b);
  }
  if (prep.mix) {
    const y = c[0] * prep.mix[0] + c[1] * prep.mix[1] + c[2] * prep.mix[2];
    c[0] = c[1] = c[2] = y;
  }
  const preSat = prep.preSaturation ?? 100;
  if (preSat !== 100) {
    const f = preSat / 100;
    const lum = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
    for (let k = 0; k < 3; k++) c[k] = clamp(lum + f * (c[k] - lum), 0, 65535);
  }
  const pos = prep.positive;
  if (pos && !(pos.gain === 1 && pos.wb.every((w) => w === 1))) {
    const r = c[0] * pos.wb[0]; const g = c[1] * pos.wb[1]; const b = c[2] * pos.wb[2];
    const peak = Math.max(r, g, b) / 65535;
    const k = pos.gain / (1 + (pos.gain - 1) * peak);
    c[0] = Math.min(65535, r * k); c[1] = Math.min(65535, g * k); c[2] = Math.min(65535, b * k);
  }
}

/** A key for a preparation (what drcSampleLuminance depends on). */
export function drcPrepKey(prep = {}) {
  const g = prep.gains;
  const pos = prep.positive;
  return [g ? `${g.r},${g.g},${g.b}` : '', prep.mix ? prep.mix.join(',') : '', prep.preSaturation ?? 100,
    pos ? `${pos.gain},${pos.wb.join(',')}` : ''].join('|');
}

/** The linear Rec. 709 luminance of each cell after the preparation. */
export function drcSampleLuminance(sample, prep = {}) {
  const n = sample.width * sample.height;
  const lum = new Float32Array(n);
  const c = new Float64Array(3);
  for (let i = 0; i < n; i++) {
    c[0] = sample.rgb[i * 3]; c[1] = sample.rgb[i * 3 + 1]; c[2] = sample.rgb[i * 3 + 2];
    prepareCell(c, prep);
    lum[i] = DRC_LUMA[0] * linear16(c[0]) + DRC_LUMA[1] * linear16(c[1]) + DRC_LUMA[2] * linear16(c[2]);
  }
  return lum;
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
  return quantiles(values, [q])[0];
}

// Several quantiles of one array from a single sort (the same values as quantile).
function quantiles(values, qs) {
  const stride = Math.max(1, Math.floor(values.length / 65536));
  const n = Math.floor((values.length - 1) / stride) + 1;
  const sample = new Float64Array(n);
  for (let i = 0, j = 0; j < n; i += stride, j++) sample[j] = values[i];
  sample.sort();
  return qs.map((q) => sample[Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))))]);
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
      const [detailQ, raiseQ] = quantiles(mag, [method.detailShare, RAISE_QUANTILE]);
      const alpha = Math.max(detailQ, 1e-6);
      // Local contrast raises the gradients below the level's median (or
      // below the detail threshold, if that is lower): what is raised does
      // not grow with what Detail protects.
      const raiseBelow = Math.min(alpha, Math.max(raiseQ, 1e-6));
      for (let i = 0; i < n; i++) {
        const g = Math.max(mag[i], 1e-9);
        const ratio = g / alpha;
        local[i] = ratio > 1 ? Math.pow(ratio, eHigh) : 1;
        const below = g / raiseBelow;
        localRaise[i] = below < 1 && eLow !== 0 ? Math.pow(Math.max(below, 0.05), eLow) : 1;
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
 * The map of one photo: the log gain of the method on the solve grid (before
 * the Shadows and Highlights shares, which act per pixel, so moving them
 * needs no new solve), and the grid's log luminance that guides its
 * upsampling.
 *
 * The solved luminance is anchored so that the frame's median log luminance
 * keeps its level (a frame that is mostly a dark void keeps it dark; the
 * middle of the range would lift it to an empty grey).
 *
 * @param {{ width: number, height: number, rgb?: Float32Array, lum?: Float32Array }} sample -
 *   sampleDrcInput (rgb, prepared here with `options.prep`), or a luminance grid
 * @param {object} settings - the drc* settings
 * @param {object} [options]
 * @param {object} [options.prep] - the engine's preprocessing (drcSampleLuminance)
 * @returns {{ version, width, height, logGain: Float32Array, guide: Float32Array }|null} null when Amount is 0
 */
export function solveDrcMap(sample, settings, options = {}) {
  if (!drcEnabled(settings) || !sample) return null;
  const n = sample.width * sample.height;
  const lum = sample.lum || (sample.rgb?.length === n * 3 ? drcSampleLuminance(sample, options.prep || {}) : null);
  if (!lum || lum.length !== n) return null;
  const method = drcMethodParams(settings);
  const { width, height } = sample;
  const eps = DRC_EPSILON;
  const H = new Float64Array(n);
  for (let i = 0; i < n; i++) H[i] = Math.log(lum[i] + eps);
  // The picture alone is solved (the analysis region, drcPictureOf, when the
  // conversion names one): a film holder or rebate around it is no part of the
  // scene, and its edge with the picture would be compressed like any other
  // and shift the picture beside it. The picture's cells, padded with their
  // own edge (no gradient, as the reflected border) to a size the DCT takes;
  // outside the picture the gain of its nearest cell carries on.
  // (Only a picture the conversion names: without a region the whole frame is the picture.)
  const box = options.picture?.region ? analysisPixelBounds(width, height, options.picture.region, 0) : null;
  let I;
  if (box && (box.width < width || box.height < height) && box.width >= 16 && box.height >= 16) {
    const sw = smoothAtLeast(box.width); const sh = smoothAtLeast(box.height);
    const Hc = new Float64Array(sw * sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      Hc[y * sw + x] = H[(box.top + Math.min(y, box.height - 1)) * width + box.left + Math.min(x, box.width - 1)];
    }
    const Ic = compressLogLuminance(Hc, sw, sh, method);
    I = new Float64Array(n);
    for (let y = 0; y < height; y++) {
      const cy = clamp(y - box.top, 0, box.height - 1);
      for (let x = 0; x < width; x++) {
        const cx = clamp(x - box.left, 0, box.width - 1);
        const c = cy * sw + cx;
        I[y * width + x] = H[y * width + x] + (Ic[c] - Hc[c]);
      }
    }
  } else {
    I = compressLogLuminance(H, width, height, method);
  }
  // (On a negative the order is the other way round; the median is its own mirror.)
  const q = options.inverted ? 1 - ANCHOR_QUANTILE : ANCHOR_QUANTILE;
  // The anchor and the extremes are the picture's too.
  const [Hp, Ip] = pictureCells(H, I, width, height, options.picture);
  const [anchorH, limitLow, middle, limitHigh] = quantiles(Hp, [q, LIMIT_QUANTILE, ANCHOR_QUANTILE, 1 - LIMIT_QUANTILE]);
  const offset = anchorH - quantile(Ip, q);
  const logGain = new Float32Array(n);
  const guide = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // The gain of the luminance itself: exp(I) is L + eps.
    const out = Math.max(1e-12, Math.exp(I[i] + offset) - eps);
    logGain[i] = lum[i] > 0 ? clamp(Math.log(out / lum[i]), -2 * MAX_LOG_GAIN, 2 * MAX_LOG_GAIN) : 0;
    guide[i] = H[i];
  }
  // The frame's own extremes (log luminance of its 0.5 % and 99.5 % cells):
  // no pixel is pushed past them (drcLimitGain).
  const limits = [limitLow, middle, limitHigh];
  return { version: DRC_VERSION, width, height, logGain, guide, limits };
}

/**
 * A pixel's stops from the map's log gain at it: the part that brightens the
 * picture scaled by Shadow recovery, the part that darkens it by Highlight
 * compression (on a negative the signs are the other way round), limited to
 * about 4.5 stops, as log2.
 */
export function drcStopsOf(logGain, method, inverted, h = null, limits = null) {
  const brightens = inverted ? logGain < 0 : logGain > 0;
  let g = logGain * (brightens ? method.shadowShare : method.highlightShare);
  g = g > MAX_LOG_GAIN ? MAX_LOG_GAIN : g < -MAX_LOG_GAIN ? -MAX_LOG_GAIN : g;
  if (limits && h !== null) g = drcLimitGain(g, h, limits[0], limits[1], limits[2]);
  return g * Math.LOG2E;
}

/**
 * The gain of a pixel of log luminance h, held inside the frame. The gain is
 * regional: detail darker (or brighter) than its region gets the region's
 * gain and, without this, would be pushed past the frame's own black (or
 * white) and clipped by the curves; a frame whose middle sits near an
 * extreme would be pulled into it. So, in the direction a pixel moves, it
 * moves freely up to a ceiling c (the middle, and at least LIMIT_MARGIN
 * inside the extreme); past c its level goes through a soft knee,
 * g' = f(h + g) - f(h), f(t) = c + w (1 - exp(-(t - c) / w)), w a quarter of
 * the way from c to the extreme: it approaches that point and never passes
 * it, and two pixels keep their order. Moving towards the middle (lifting
 * shadows, lowering highlights) is untouched up to the middle.
 */
export function drcLimitGain(g, h, low, mid, high) {
  if (g > 0) {
    // Upwards: freely up to the ceiling (the middle, and at least LIMIT_MARGIN
    // inside the high extreme), then a soft knee that never reaches the extreme.
    const c = Math.min(mid, high - LIMIT_MARGIN);
    const w = (high - c) * LIMIT_SOFT;
    const t = h + g;
    if (t <= c) return g;
    if (!(w > 1e-6)) return h >= c ? 0 : c - h;
    const ft = c + w * (1 - Math.exp(-(t - c) / w));
    const fh = h <= c ? h : c + w * (1 - Math.exp(-(h - c) / w));
    return ft - fh;
  }
  if (g < 0) {
    const c = Math.max(mid, low + LIMIT_MARGIN);
    const w = (c - low) * LIMIT_SOFT;
    const t = h + g;
    if (t >= c) return g;
    if (!(w > 1e-6)) return h <= c ? 0 : c - h;
    const ft = c - w * (1 - Math.exp(-(c - t) / w));
    const fh = h >= c ? h : c - w * (1 - Math.exp(-(c - h) / w));
    return ft - fh;
  }
  return g;
}

/** Saturation protection's weight of a pixel (0-255): how far the compression darkened it, up to PROTECT_STOPS. */
export function drcProtectWeight(stops, inverted) {
  const darkening = inverted ? stops : -stops;
  if (!(darkening > 0)) return 0;
  return Math.round((darkening >= PROTECT_STOPS ? 1 : darkening / PROTECT_STOPS) * 255);
}

export const DRC_MAX_LOG_GAIN = MAX_LOG_GAIN;
export const DRC_PROTECT_STOPS = PROTECT_STOPS;

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

/** The range weight table (for the GPU stage, which reads the same numbers). */
export function drcRangeTable() {
  const t = rangeWeights();
  return { table: t.table, scale: t.scale, size: RANGE_TABLE_SIZE };
}

/** The stage of a map: what the per-pixel functions read. */
/**
 * The picture inside a frame, for the map's anchor and extremes: the
 * conversion's analysis region (the crop, or the detected frame of an
 * uncropped scan) less its border buffer, as the engine's analysis sees it.
 */
export function drcPictureOf(params) {
  const r = params?.analysisRegion;
  const region = r && ['left', 'top', 'width', 'height'].every((k) => Number.isFinite(r[k])) && r.width > 0 && r.height > 0
    ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
  return { region, border: (Number.isFinite(params?.borderBuffer) ? params.borderBuffer : 10) / 100 };
}

/** The picture's part of a map key. */
export function drcPictureKey(picture) {
  if (!picture) return 'p:all';
  const r = picture.region;
  const f = (v) => (+v).toFixed(4);
  return `p:${r ? [r.left, r.top, r.width, r.height].map(f).join(',') : 'full'}:${f(picture.border)}`;
}

// The smallest length of 2, 3 and 5 factors at least n.
function smoothAtLeast(n) {
  for (let m = Math.max(1, n); ; m++) if (nearestSmoothLength(m) === m) return m;
}

// The log luminance of the solve grid's cells inside the picture (and of the
// solved result there); the whole grid without a picture.
function pictureCells(H, I, width, height, picture) {
  if (!picture) return [H, I];
  const box = analysisPixelBounds(width, height, picture.region, picture.border);
  const Hp = new Float64Array(box.width * box.height);
  const Ip = new Float64Array(box.width * box.height);
  for (let y = 0, k = 0; y < box.height; y++) for (let x = 0; x < box.width; x++, k++) {
    const i = (box.top + y) * width + box.left + x;
    Hp[k] = H[i]; Ip[k] = I[i];
  }
  return [Hp, Ip];
}

/** A map's extremes, or none (a map from before they were kept: no limit). */
export function drcLimitsOf(map) {
  const l = map && map.limits;
  return l && l.length === 3 && l.every(Number.isFinite) && l[0] <= l[1] && l[1] <= l[2] ? [l[0], l[1], l[2]] : null;
}

export function buildDrcStage(map) {
  if (!map || !(map.logGain?.length === map.width * map.height) || !(map.guide?.length === map.logGain.length)) return null;
  return { width: map.width, height: map.height, logGain: map.logGain, guide: map.guide, limits: drcLimitsOf(map), range: rangeWeights() };
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

// The joint bilateral lookup of computeDrcStops / exposeDrcReference for one
// pixel, from its linear luminance L (shared so both read the same numbers).
function logOfLuminance(L, logTable) {
  const pos = (L < 1 ? (L > 0 ? L : 0) : 1) * LOG_TABLE_STEPS;
  const t = pos | 0;
  return logTable[t] + (logTable[t < LOG_TABLE_STEPS ? t + 1 : t] - logTable[t]) * (pos - t);
}

function lookupLogGain(stage, cx0, cx1, cwx, row0, row1, wy, h) {
  const { logGain, guide, range } = stage;
  const i00 = row0 + cx0; const i01 = row0 + cx1; const i10 = row1 + cx0; const i11 = row1 + cx1;
  const rt = range.table; const rs = range.scale;
  let d; let r;
  d = (h > guide[i00] ? h - guide[i00] : guide[i00] - h) * rs;
  r = d >= RANGE_TABLE_SIZE ? rt[RANGE_TABLE_SIZE] : rt[d | 0] + (rt[(d | 0) + 1] - rt[d | 0]) * (d - (d | 0));
  const w00 = (1 - cwx) * (1 - wy) * r;
  d = (h > guide[i01] ? h - guide[i01] : guide[i01] - h) * rs;
  r = d >= RANGE_TABLE_SIZE ? rt[RANGE_TABLE_SIZE] : rt[d | 0] + (rt[(d | 0) + 1] - rt[d | 0]) * (d - (d | 0));
  const w01 = cwx * (1 - wy) * r;
  d = (h > guide[i10] ? h - guide[i10] : guide[i10] - h) * rs;
  r = d >= RANGE_TABLE_SIZE ? rt[RANGE_TABLE_SIZE] : rt[d | 0] + (rt[(d | 0) + 1] - rt[d | 0]) * (d - (d | 0));
  const w10 = (1 - cwx) * wy * r;
  d = (h > guide[i11] ? h - guide[i11] : guide[i11] - h) * rs;
  r = d >= RANGE_TABLE_SIZE ? rt[RANGE_TABLE_SIZE] : rt[d | 0] + (rt[(d | 0) + 1] - rt[d | 0]) * (d - (d | 0));
  const w11 = cwx * wy * r;
  const sum = w00 + w01 + w10 + w11;
  return sum > 1e-9
    ? (w00 * logGain[i00] + w01 * logGain[i01] + w10 * logGain[i10] + w11 * logGain[i11]) / sum
    : (1 - wy) * ((1 - cwx) * logGain[i00] + cwx * logGain[i01]) + wy * ((1 - cwx) * logGain[i10] + cwx * logGain[i11]);
}

function columnTables(width, frame, gw) {
  const cx0 = new Int32Array(width); const cx1 = new Int32Array(width); const cwx = new Float64Array(width);
  for (let x = 0; x < width; x++) {
    const fx = clamp(((frame.x + x + 0.5) / frame.frameWidth) * gw - 0.5, 0, gw - 1);
    cx0[x] = fx | 0; cx1[x] = cx0[x] + 1 < gw ? cx0[x] + 1 : cx0[x]; cwx[x] = fx - cx0[x];
  }
  return { cx0, cx1, cwx };
}

function rowOf(y, frame, gh) {
  const fy = clamp(((frame.y + y + 0.5) / frame.frameHeight) * gh - 0.5, 0, gh - 1);
  const y0 = fy | 0;
  return { y0, y1: y0 + 1 < gh ? y0 + 1 : y0, wy: fy - y0 };
}

// linear16 inlined: the LINEAR_LUT read exposeRgbaRun does.
const TO_INDEX = LINEAR_STEPS / 65535;
function lin(v) {
  const idx = v * TO_INDEX; const k = idx | 0; const f = idx - k;
  return LINEAR_LUT[k] + (LINEAR_LUT[k < LINEAR_STEPS ? k + 1 : k] - LINEAR_LUT[k]) * f;
}

/** The stops of dodge-and-burn strokes at a pixel: a dense map, a tiled one, or none. */
function strokeReader(strokes, width) {
  if (!strokes) return null;
  if (strokes.tiled === true && Array.isArray(strokes.tiles)) {
    const { tileSize, columns, tiles } = strokes;
    return (x, y) => {
      const tile = tiles[((y / tileSize) | 0) * columns + ((x / tileSize) | 0)];
      return tile ? tile[(y % tileSize) * tileSize + (x % tileSize)] : 0;
    };
  }
  return (x, y) => strokes[y * width + x];
}

/**
 * The compression's stops for every pixel of a 16-bit RGBA plane (as it
 * enters the exposure stage), guided by each pixel's own linear luminance.
 * For tests and the hint; the conversion uses exposeDrcReference (or the GPU).
 */
export function computeDrcStops(data, width, height, stage, options = {}) {
  const method = options.method || drcMethodParams({ drcAmount: 1 });
  const inverted = Boolean(options.inverted);
  const frame = options.frame || { x: 0, y: 0, frameWidth: width, frameHeight: height };
  const out = new Float32Array(width * height);
  const { cx0, cx1, cwx } = columnTables(width, frame, stage.width);
  const logTable = logLuminanceTable();
  for (let y = 0; y < height; y++) {
    const { y0, y1, wy } = rowOf(y, frame, stage.height);
    const row0 = y0 * stage.width; const row1 = y1 * stage.width;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const L = DRC_LUMA[0] * lin(data[i]) + DRC_LUMA[1] * lin(data[i + 1]) + DRC_LUMA[2] * lin(data[i + 2]);
      const h = logOfLuminance(L, logTable);
      out[y * width + x] = drcStopsOf(lookupLogGain(stage, cx0[x], cx1[x], cwx[x], row0, row1, wy, h), method, inverted, h, stage.limits);
    }
  }
  return out;
}

/**
 * The exposure stage with the compression, in place, in JavaScript: the
 * reference of the GPU stage (render/dynamicRangeGpu.js) and its fallback.
 * Each pixel's stops are the compression's (from the map, guided by its own
 * luminance) plus the dodge-and-burn strokes'; the exposure is
 * exposeRgbaRun's arithmetic. `weights` (optional, one byte per pixel)
 * receives saturation protection's weight. No stops plane is kept.
 *
 * @param {{ width, height, data: Uint16Array }} image16 - the plane entering the exposure stage
 * @param {object} stage - buildDrcStage(map)
 * @param {object} method - drcMethodParams(settings)
 * @param {object} [options]
 * @param {boolean} [options.inverted]
 * @param {Float32Array|object|null} [options.strokes] - dense or tiled stops of the strokes, of this plane's size
 * @param {{ x, y, frameWidth, frameHeight }} [options.frame]
 * @param {Uint8Array} [options.weights]
 */
export function exposeDrcReference(image16, stage, method, options = {}) {
  const { width, height, data } = image16;
  const inverted = Boolean(options.inverted);
  const frame = options.frame || { x: 0, y: 0, frameWidth: width, frameHeight: height };
  const weights = options.weights || null;
  const stroke = strokeReader(options.strokes, width);
  const { cx0, cx1, cwx } = columnTables(width, frame, stage.width);
  const logTable = logLuminanceTable();
  // `rect`: only these pixels (the GPU stage's tiles it could not do).
  const rect = options.rect || { x: 0, y: 0, width, height };
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    const { y0, y1, wy } = rowOf(y, frame, stage.height);
    const row0 = y0 * stage.width; const row1 = y1 * stage.width;
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      const p = y * width + x;
      const i = p * 4;
      const lr = lin(data[i]); const lg = lin(data[i + 1]); const lb = lin(data[i + 2]);
      const L = DRC_LUMA[0] * lr + DRC_LUMA[1] * lg + DRC_LUMA[2] * lb;
      const h = logOfLuminance(L, logTable);
      const drcStops = drcStopsOf(lookupLogGain(stage, cx0[x], cx1[x], cwx[x], row0, row1, wy, h), method, inverted, h, stage.limits);
      if (weights) weights[p] = drcProtectWeight(drcStops, inverted);
      const s = drcStops + (stroke ? stroke(x, y) : 0);
      if (s === 0) continue;
      const gain = Math.pow(2, s);
      let v = lr * gain; data[i] = Math.round(Math.pow(v < 1 ? v : 1, 1 / 2.2) * 65535);
      v = lg * gain; data[i + 1] = Math.round(Math.pow(v < 1 ? v : 1, 1 / 2.2) * 65535);
      v = lb * gain; data[i + 2] = Math.round(Math.pow(v < 1 ? v : 1, 1 / 2.2) * 65535);
    }
  }
  return image16;
}

// log(L + DRC_EPSILON) over L in [0, 1], for the per-pixel lookups.
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
 * loses up to `protect` of its chroma (around its Rec. 709 luminance), in
 * proportion to its weight (drcProtectWeight: 255 at PROTECT_STOPS of
 * darkening). Brought down from the shoulder of the film's curve, highlights
 * regain colour the curve had compressed and can come back stronger and more
 * cast than they look; lifted shadows (which lose saturation instead) are
 * left alone.
 *
 * @param {{ width, height, data: Uint16Array }} image16 - the positive, in place
 * @param {Uint8Array} weights - one per pixel
 * @param {number} protect - drcMethodParams(settings).protect
 */
export function applyDrcProtection(image16, weights, protect) {
  if (!(protect > 0) || !weights || weights.length !== image16.width * image16.height) return image16;
  const d = image16.data;
  // The share of chroma each weight keeps (the same products as 1 - w * protect / 255).
  const k = protect / 255;
  const keepOf = new Float64Array(256);
  for (let w = 0; w < 256; w++) keepOf[w] = 1 - w * k;
  const lr = DRC_LUMA[0]; const lg = DRC_LUMA[1]; const lb = DRC_LUMA[2];
  for (let p = 0, n = weights.length; p < n; p++) {
    const w = weights[p];
    if (w === 0) continue;
    const keep = keepOf[w];
    const i = p << 2;
    const r = d[i]; const g = d[i + 1]; const b = d[i + 2];
    const Y = lr * r + lg * g + lb * b;
    // Math.round(x) is floor(x + 0.5); the clamp to the 16-bit range first.
    let x = Y + (r - Y) * keep + 0.5;
    d[i] = x < 0 ? 0 : x >= 65535 ? 65535 : x | 0;
    x = Y + (g - Y) * keep + 0.5;
    d[i + 1] = x < 0 ? 0 : x >= 65535 ? 65535 : x | 0;
    x = Y + (b - Y) * keep + 0.5;
    d[i + 2] = x < 0 ? 0 : x >= 65535 ? 65535 : x | 0;
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
// The hint is offered when Auto would bring back at least this much local
// contrast in the picture's ends (display levels per grid step, the darkest
// and brightest tenth together; see estimateDrcEffect). Chosen on 66 real
// negatives and 32 public frames by eye (docs/dynamic-range-compression.md).
export const DRC_HINT_THRESHOLD = 6;
const HINT_AMOUNTS = [15, 30, 50, 70];
const HINT_SHARES = [25, 50, 75];
const HINT_SAMPLES = 16384;
// The estimate solves on its own grid of 256 px: it runs with a photo's first
// conversion and must not delay it much; at 160 px it no longer told the
// frames apart.
const HINT_LONG_SIDE = 256;
// The share of the picture's cells that makes each end (darkest, brightest).
const END_SHARE = 0.1;
// What the midtones may lose of their local contrast before it counts
// against a setting (the flat, grey look), and how much it counts.
const MID_LOSS_WEIGHT = 1.5;
// How far the bright end may be dimmed and the dark end lifted (mean display
// levels) before it counts as the flat look, and how much that and a colour
// shift in the ends count against a setting.
const FREE_DIM = 25;
const FREE_LIFT = 25;
const FLAT_WEIGHT = 0.4;
const SHIFT_WEIGHT = 0.3;
const FREE_SHIFT = 5;
// Display levels added to the brightness a chroma is measured against (near
// black, chroma is noise).
const CHROMA_FLOOR = 16;
// The near-black or near-white share a setting may add (a quarter of a
// percentage point of the sampled pixels).
const ADD_TOLERANCE = 0.0025;
// The screen's flare, as a share of white, that hides detail in deep shadow.
const DETAIL_FLARE = 0.02;
// The texture whose visibility measures fine detail (stops on the negative).
const TEXTURE_STOPS = 0.1;

// Linear light of a display-encoded 16-bit code (gamma 2.2), by table.
let linearTableCache = null;
function displayLinear() {
  if (!linearTableCache) {
    linearTableCache = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) linearTableCache[i] = Math.pow(i / 65535, 2.2);
  }
  return linearTableCache;
}

/**
 * What the compression would do for a photo, measured cheaply with the
 * conversion's own curves (only the curves; the colour stages after them do
 * not change where detail is):
 *
 * - on a 256 px grid of the negative (cell means), the picture's darkest and
 *   brightest tenth (by the converted luminance without the compression) and
 *   its middle; in each, the local contrast (mean difference between
 *   neighbouring cells, in 8-bit display levels) and the number of distinct
 *   display levels, without the compression and with each candidate;
 * - on a strided subsample of 16k pixels, the share near black or white
 *   (within 3 %), so that no candidate that adds clipped area is chosen.
 *
 * The candidates are Amount 15, 30, 50 and 70 with Shadow recovery and
 * Highlight compression at 25, 50 and 75 (only Amount needs a solve). A
 * candidate that adds near-black or near-white pixels (ADD_TOLERANCE) is
 * never chosen. The score is the fine detail gained in the two ends, less
 * what the middle loses of its local contrast (the flat look), an end moved
 * further than FREE_DIM / FREE_LIFT display levels (a bright end dimmed to
 * grey, a dark end lifted to grey) and a hue that moves (colour shift).
 * Auto is the gentlest candidate within 90 % of the best score, or nothing
 * when no candidate scores above 0; the hint is offered when the score is at
 * least DRC_HINT_THRESHOLD.
 *
 * @param {object} input - { data: Uint16Array RGBA, width, height } the negative as the engine receives it
 * @param {{ r: Uint16Array, g: Uint16Array, b: Uint16Array }} luts - the conversion's curves (65536 entries)
 * @param {boolean} inverted - a negative
 * @param {object} [options]
 * @param {{ x0, y0, x1, y1 }} [options.bounds] - the picture inside the scan (the crop or the
 *   detected frame), in pixels: only it is measured, so a holder or rebate around it does not
 *   count (the compression itself still sees the whole frame)
 * @returns {{ base, benefit, ends, reduction, suggested }}
 */
export function estimateDrcEffect(input, luts, inverted, options = {}) {
  const { data, width, height } = input;
  // Never finer than the frame itself (a tile, a test's small frame).
  const sample = sampleDrcInput(data, width, height, { longSide: Math.min(HINT_LONG_SIDE, Math.max(width, height)) });
  const gw = sample.width; const gh = sample.height;
  const b = options.bounds;
  const x0 = b ? clamp(Math.floor(b.x0), 0, width - 1) : 0;
  const y0 = b ? clamp(Math.floor(b.y0), 0, height - 1) : 0;
  const x1 = b ? clamp(Math.ceil(b.x1), x0 + 1, width) : width;
  const y1 = b ? clamp(Math.ceil(b.y1), y0 + 1, height) : height;

  // The points measured: sampled pixels of the picture (the ends, the
  // clipped share) and the grid's cells inside it (the middle's local
  // contrast). Each keeps its channels gamma-encoded (exposure by s stops is
  // then a factor 2^(s/2.2)), its log luminance and its position.
  const points = (count) => ({ q: new Float64Array(count * 3), h: new Float64Array(count), u: new Float64Array(count), v: new Float64Array(count) });
  const fill = (pts, k, r, g, bl, u, v) => {
    const lr = linear16(r); const lg = linear16(g); const lb = linear16(bl);
    pts.q[k * 3] = Math.pow(lr, 1 / 2.2); pts.q[k * 3 + 1] = Math.pow(lg, 1 / 2.2); pts.q[k * 3 + 2] = Math.pow(lb, 1 / 2.2);
    pts.h[k] = Math.log(DRC_LUMA[0] * lr + DRC_LUMA[1] * lg + DRC_LUMA[2] * lb + DRC_EPSILON);
    pts.u[k] = u; pts.v[k] = v;
  };
  const bw = x1 - x0;
  const area = bw * (y1 - y0);
  const stride = Math.max(1, Math.floor(area / HINT_SAMPLES));
  const pixelCount = Math.ceil(area / stride);
  const px = points(pixelCount);
  for (let k = 0, a = 0; a < area; a += stride, k++) {
    const x = x0 + (a % bw); const y = y0 + Math.floor(a / bw);
    const i = (y * width + x) * 4;
    fill(px, k, data[i], data[i + 1], data[i + 2], (x + 0.5) / width, (y + 0.5) / height);
  }
  const cx0 = clamp(Math.floor(x0 * gw / width), 0, gw - 1);
  const cx1 = clamp(Math.ceil(x1 * gw / width), cx0 + 1, gw);
  const cy0 = clamp(Math.floor(y0 * gh / height), 0, gh - 1);
  const cy1 = clamp(Math.ceil(y1 * gh / height), cy0 + 1, gh);
  const cw = cx1 - cx0; const ch = cy1 - cy0;
  const cells = points(cw * ch);
  for (let cy = cy0; cy < cy1; cy++) for (let cx = cx0; cx < cx1; cx++) {
    const c = (cy * gw + cx) * 3;
    const code = (k) => Math.round(clamp(sample.rgb[c + k], 0, 65535));
    fill(cells, (cy - cy0) * cw + (cx - cx0), code(0), code(1), code(2), (cx + 0.5) / gw, (cy + 0.5) / gh);
  }

  // A point's converted channels with s stops: the curves of the exposed codes.
  const rgbOf = (pts, k, s, out) => {
    const m = s === 0 ? 1 : Math.pow(2, s / 2.2);
    for (let c = 0; c < 3; c++) {
      const e = pts.q[k * 3 + c] * m;
      out[c] = (c === 0 ? luts.r : c === 1 ? luts.g : luts.b)[e < 1 ? Math.round(e * 65535) : 65535];
    }
    return out;
  };
  const tmp = [0, 0, 0];
  const lumOf = (pts, k, s) => { rgbOf(pts, k, s, tmp); return DRC_LUMA[0] * tmp[0] + DRC_LUMA[1] * tmp[1] + DRC_LUMA[2] * tmp[2]; };
  // The curves give display-encoded codes: 8-bit display levels are the
  // codes / 257, linear light their decoding (gamma 2.2).
  const toDisplay = (Y) => (Y > 0 ? (Y < 65535 ? Y : 65535) : 0) / 257;
  const linearTable = displayLinear();
  const toLinear = (Y) => linearTable[Y > 0 ? (Y < 65535 ? Math.round(Y) : 65535) : 0];
  // Fine detail a pixel shows: the contrast a texture of +/- TEXTURE_STOPS on
  // the negative makes there on screen, as a viewer sees it (Weber contrast
  // with the screen's flare: a difference in deep shadow is lost in it), in
  // percent. The curves' shoulder and toe flatten it; the compression moves
  // an end back to where the curve shows it.
  const detailAt = (k, s) => {
    const a = toLinear(lumOf(px, k, s + TEXTURE_STOPS)); const c = toLinear(lumOf(px, k, s - TEXTURE_STOPS));
    return 100 * Math.abs(a - c) / ((a + c) / 2 + DETAIL_FLARE);
  };

  // Without the compression: the ends and the middle.
  const offY = new Float64Array(pixelCount);
  for (let k = 0; k < pixelCount; k++) offY[k] = lumOf(px, k, 0);
  const order = Array.from({ length: pixelCount }, (_, k) => k).sort((p, q) => offY[p] - offY[q]);
  const endCount = Math.max(1, Math.floor(pixelCount * END_SHARE));
  const pixelEnds = { dark: order.slice(0, endCount), bright: order.slice(pixelCount - endCount) };
  const blackLimit = 0.01 * 65535; const whiteLimit = 0.99 * 65535;
  const lowLimit = 0.03 * 65535; const highLimit = 0.97 * 65535;
  const clipOf = (stops) => {
    let low = 0; let high = 0; let black = 0; let white = 0;
    for (let k = 0; k < pixelCount; k++) {
      const Y = stops ? lumOf(px, k, stops[k]) : offY[k];
      if (Y <= lowLimit) low++; else if (Y >= highLimit) high++;
      if (Y <= blackLimit) black++; else if (Y >= whiteLimit) white++;
    }
    return { shadows: low / pixelCount, highlights: high / pixelCount, black: black / pixelCount, white: white / pixelCount };
  };
  const fineOf = (ks, stops) => { let sum = 0; for (const k of ks) sum += detailAt(k, stops ? stops[k] : 0); return sum / ks.length; };
  // How far an end moves (mean display levels) and how much its colour
  // changes (red and blue against green, relative to the brightness, in
  // percent).
  // Each end pixel without the compression: display luminance, chroma size and hue.
  const offLook = new Float64Array(pixelCount * 3);
  const b3 = [0, 0, 0];
  for (const k of [...pixelEnds.dark, ...pixelEnds.bright]) {
    rgbOf(px, k, 0, b3);
    const r = toDisplay(b3[0]); const g = toDisplay(b3[1]); const bl = toDisplay(b3[2]);
    offLook[k * 3] = DRC_LUMA[0] * r + DRC_LUMA[1] * g + DRC_LUMA[2] * bl;
    const y = DRC_LUMA[0] * r + DRC_LUMA[1] * g + DRC_LUMA[2] * bl;
    offLook[k * 3 + 1] = (r - g) / (y + CHROMA_FLOOR);
    offLook[k * 3 + 2] = (bl - g) / (y + CHROMA_FLOOR);
  }
  const moveOf = (ks, stops) => {
    let move = 0; let shift = 0;
    for (const k of ks) {
      rgbOf(px, k, stops[k], b3);
      const r = toDisplay(b3[0]); const g = toDisplay(b3[1]); const bl = toDisplay(b3[2]);
      const y = DRC_LUMA[0] * r + DRC_LUMA[1] * g + DRC_LUMA[2] * bl;
      move += y - offLook[k * 3];
      // Chroma relative to brightness: an exposure change that keeps the
      // saturation does not count, a neutral black turning blue does.
      shift += 100 * Math.hypot((r - g) / (y + CHROMA_FLOOR) - offLook[k * 3 + 1], (bl - g) / (y + CHROMA_FLOOR) - offLook[k * 3 + 2]);
    }
    return { move: move / ks.length, shift: shift / ks.length };
  };
  // The middle's local contrast on the grid: neighbouring cells, in display levels.
  const cellOff = new Float64Array(cw * ch);
  for (let k = 0; k < cw * ch; k++) cellOff[k] = toDisplay(lumOf(cells, k, 0));
  const sortedCells = Array.from(cellOff).sort((p, q) => p - q);
  const midLow = sortedCells[Math.floor(0.3 * (sortedCells.length - 1))];
  const midHigh = sortedCells[Math.floor(0.7 * (sortedCells.length - 1))];
  const midPairs = [];
  const involved = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const k = y * cw + x;
    if (cellOff[k] < midLow || cellOff[k] > midHigh) continue;
    involved[k] = 1;
    if (x + 1 < cw) { midPairs.push(k, k + 1); involved[k + 1] = 1; }
    if (y + 1 < ch) { midPairs.push(k, k + cw); involved[k + cw] = 1; }
  }
  const involvedCells = [];
  for (let k = 0; k < cw * ch; k++) if (involved[k]) involvedCells.push(k);
  const cellOn = new Float64Array(cw * ch);
  const midContrast = (stops) => {
    if (!midPairs.length) return 0;
    const disp = stops ? cellOn : cellOff;
    if (stops) for (const k of involvedCells) cellOn[k] = toDisplay(lumOf(cells, k, stops[k]));
    let sum = 0;
    for (let j = 0; j < midPairs.length; j += 2) sum += Math.abs(disp[midPairs[j]] - disp[midPairs[j + 1]]);
    return sum / (midPairs.length / 2);
  };
  const base = clipOf(null);
  const fineBefore = { dark: fineOf(pixelEnds.dark, null), bright: fineOf(pixelEnds.bright, null) };
  const midBefore = midContrast(null);

  const candidates = [];
  let best = null;
  const pixelStops = new Float64Array(pixelCount);
  const cellStops = new Float64Array(cw * ch);
  for (const amount of HINT_AMOUNTS) {
    const map = solveDrcMap(sample, { drcAmount: amount }, { inverted, picture: options.picture || null });
    const stage = buildDrcStage(map);
    if (!stage) continue;
    // The raw gain of every point, once per amount; the shares per candidate.
    const pixelGain = new Float64Array(pixelCount);
    for (let k = 0; k < pixelCount; k++) pixelGain[k] = drcLogGainAt(stage, px.u[k], px.v[k], px.h[k]);
    const cellGain = new Float64Array(cw * ch);
    for (const k of involvedCells) cellGain[k] = drcLogGainAt(stage, cells.u[k], cells.v[k], cells.h[k]);
    for (const drcShadows of HINT_SHARES) for (const drcHighlights of HINT_SHARES) {
      const settings = { drcAmount: amount, drcShadows, drcHighlights };
      const method = drcMethodParams(settings);
      for (let k = 0; k < pixelCount; k++) pixelStops[k] = drcStopsOf(pixelGain[k], method, inverted, px.h[k], stage.limits);
      for (const k of involvedCells) cellStops[k] = drcStopsOf(cellGain[k], method, inverted, cells.h[k], stage.limits);
      const clip = clipOf(pixelStops);
      // Never more near-black or near-white (within 1 %) than the photo had.
      const adds = clip.black > base.black + ADD_TOLERANCE || clip.white > base.white + ADD_TOLERANCE;
      const fine = { dark: fineOf(pixelEnds.dark, pixelStops), bright: fineOf(pixelEnds.bright, pixelStops) };
      const moves = { dark: moveOf(pixelEnds.dark, pixelStops), bright: moveOf(pixelEnds.bright, pixelStops) };
      const midAfter = midContrast(cellStops);
      const gain = (fine.dark - fineBefore.dark) + (fine.bright - fineBefore.bright);
      const midLoss = Math.max(0, midBefore - midAfter);
      const flat = Math.max(0, -moves.bright.move - FREE_DIM) + Math.max(0, moves.dark.move - FREE_LIFT);
      const shift = Math.max(0, moves.dark.shift - FREE_SHIFT) + Math.max(0, moves.bright.shift - FREE_SHIFT);
      const score = gain - MID_LOSS_WEIGHT * midLoss - FLAT_WEIGHT * flat - SHIFT_WEIGHT * shift;
      const candidate = { settings, clip, fine, moves, midAfter, gain, midLoss, score, adds };
      candidates.push(candidate);
      if (!adds && (!best || score > best.score)) best = candidate;
    }
  }
  // The gentlest setting within 90 % of the best: the smallest amount, then
  // shares nearest 50.
  let chosen = best;
  if (best && best.score > 0) {
    const gentle = (c) => c.settings.drcAmount * 10 + Math.abs(c.settings.drcShadows - 50) + Math.abs(c.settings.drcHighlights - 50);
    for (const c of candidates) if (!c.adds && c.score >= 0.9 * best.score && gentle(c) < gentle(chosen)) chosen = c;
  }
  const clipped = (sh) => sh.shadows + sh.highlights;
  const end = (k) => (chosen ? { detail: +(chosen.fine[k] - fineBefore[k]).toFixed(3), detailBefore: +fineBefore[k].toFixed(3) } : { detail: 0, detailBefore: +fineBefore[k].toFixed(3) });
  return {
    base,
    benefit: chosen ? Math.max(0, chosen.score) : 0,
    ends: { dark: end('dark'), bright: end('bright'), mid: { contrast: chosen ? +(chosen.midAfter - midBefore).toFixed(3) : 0 } },
    moves: chosen ? chosen.moves : null,
    reduction: chosen ? clipped(base) - clipped(chosen.clip) : 0,
    // Nothing that helps (or nothing that keeps the ends): Auto leaves it off.
    suggested: chosen && chosen.score > 0 ? { ...DRC_DEFAULTS, ...chosen.settings } : null,
    ...(options.candidates ? { candidates: candidates.map((c) => ({ ...c.settings, score: +c.score.toFixed(2), gain: +c.gain.toFixed(2), midLoss: +c.midLoss.toFixed(2),
      dim: +c.moves.bright.move.toFixed(1), lift: +c.moves.dark.move.toFixed(1), shift: +(c.moves.dark.shift + c.moves.bright.shift).toFixed(2), adds: c.adds })) } : {})
  };
}

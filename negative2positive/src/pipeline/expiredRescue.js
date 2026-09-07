// Expired film rescue: a separate correction stage for rolls that were shot
// or developed long past their date. Age shows up in a positive as
//
//   * fog       — the black point floats up, contrast collapses;
//   * a cast    — the dye layers lose speed at different rates, so one or
//                 two channels sit high everywhere (blue/magenta, green…);
//   * crossover — the layers also fade with different gammas, so shadows
//                 lean one way (often green) and highlights the other
//                 (often pink), which no single white balance removes;
//   * thin shadows — an old roll is slower than its box speed, so the frame
//                 is in effect underexposed.
//
// Colour and tone are corrected separately, and both by luminance:
//
//   * colour: for each luminance band of the positive, the near-neutral
//     pixels' mean colour is measured; the offset that brings it onto its
//     luminance, interpolated over luminance, is added to every pixel of that
//     density. A cyan sky and a magenta wall may share a red value and need
//     opposite corrections, so this cannot be a per-channel curve; and a grey
//     object that is already neutral at its density is left alone, which
//     per-channel levels (which assume a neutral black) would not do.
//   * tone: one curve shared by the three channels — black and white points
//     from the luminance histogram, a brightness gamma for lost speed, a soft
//     S-curve — so neutrals stay neutral.
//
// No OpenCV, no DOM. analyzeExpiredFilm() measures a positive once and returns
// a small plain object that is stored with the photo's settings;
// buildExpiredRescueStages() turns that plus the strengths into the per-pixel
// stage (applyExpiredTone) at any time, in the worker as well as on screen.
//
// The spatial part (uneven fog, local contrast) is measured with OpenCV.js
// on the main thread (app/expiredRescueOpenCv.js) and stored as a small
// quadratic fog surface plus a local-mean grid; this module fits, stores
// and applies them without OpenCV, so the export worker and the 16-bit
// path reproduce the preview exactly.

export const EXPIRED_RESCUE_VERSION = 3;
export const EXPIRED_SPATIAL_VERSION = 1;

export const EXPIRED_RESCUE_KEYS = Object.freeze([
  'expiredEnabled', 'expiredLevels', 'expiredNeutralize', 'expiredCrossover',
  'expiredBrightness', 'expiredContrast', 'expiredUnevenFog', 'expiredLocalContrast'
]);

export const EXPIRED_RESCUE_DEFAULTS = Object.freeze({
  expiredEnabled: false,
  expiredLevels: 100,
  expiredNeutralize: 100,
  expiredCrossover: 100,
  expiredBrightness: 0,
  expiredContrast: 25,
  expiredUnevenFog: 100,
  expiredLocalContrast: 0
});

const EXPIRED_RESCUE_RANGES = Object.freeze({
  expiredLevels: [0, 100],
  expiredNeutralize: [0, 100],
  expiredCrossover: [0, 100],
  expiredBrightness: [-100, 100],
  expiredContrast: [0, 100],
  expiredUnevenFog: [0, 100],
  expiredLocalContrast: [0, 100]
});

const HIST_BINS = 1024;
const LOW_PERCENTILE = 0.005;
const HIGH_PERCENTILE = 0.995;
// Tonal bands of the positive (by luminance, normalised to the frame's own
// range) whose near-neutral pixels decide the colour correction at that
// density.
const BAND_EDGES = [0, 0.06, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1.0001];
// The farthest a band may move a channel (the strengths scale it).
const BAND_MOVE_LIMIT = 0.35;
// A band needs this share of the neutral-weighted population to count.
const MIN_BAND_SHARE = 0.004;
const NEUTRAL_CHROMA = 0.12;
// Mean-shift radius (per channel, 0..1) for the densest near-neutral cluster.
const CLUSTER_RADIUS = 0.06;
const MIN_SAMPLES = 400;
// sRGB middle grey; a leveled positive whose midtones sit well below it was
// underexposed (an aged roll has lost speed) and gets a brightness lift.
const TARGET_MIDTONE = 0.42;
// The fitted fog surface never removes more than this much of the range at
// any point, so a failed fit (a bright wall read as fog) stays a mild error.
const FOG_SURFACE_LIMIT = 0.15;
// Local contrast at 100 %: deviations from the local mean grow by this much.
const LOCAL_CONTRAST_MAX = 0.6;
const IDENTITY_PLACEMENT = Object.freeze({ left: 0, top: 0, width: 1, height: 1 });
const OFFSET_BINS = 64;

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function finite(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function luminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

// Near-neutral pixels decide the colour balance: a strongly coloured
// subject (an orange cat, green grass) should not be "corrected" to grey.
function neutralWeight(r, g, b) {
  const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
  const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
  const chroma = (max - min) / NEUTRAL_CHROMA;
  return 1 / (1 + chroma * chroma);
}

function percentileFromHistogram(hist, total, fraction) {
  const target = fraction * total;
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= target) return (i + 0.5) / hist.length;
  }
  return 1;
}

// Shape-preserving cubic through anchors with increasing x (Fritsch–Carlson
// slopes): no overshoot between anchors, flat beyond the ends.
function shapeCubic(xs, ys) {
  const n = xs.length;
  if (n === 1) return () => ys[0];
  const h = new Array(n - 1);
  const delta = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = xs[i + 1] - xs[i];
    delta[i] = (ys[i + 1] - ys[i]) / h[i];
  }
  const d = new Array(n).fill(0);
  d[0] = delta[0];
  d[n - 1] = delta[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (delta[i - 1] * delta[i] <= 0) {
      d[i] = 0;
    } else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      d[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i]);
    }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const t = (x - xs[i]) / h[i];
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * d[i]
      + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * d[i + 1];
  };
}

function lerpCurve(curve, x) {
  if (x <= 0) return curve[0];
  if (x >= 255) return curve[255];
  const i = x | 0;
  const f = x - i;
  return curve[i] + (curve[i + 1] - curve[i]) * f;
}

export function resolveExpiredSamplePlane(image) {
  return resolveSamplePlane(image);
}

export function resolveExpiredBounds(image, options = {}) {
  return resolveBounds(image, options);
}

function resolveSamplePlane(image) {
  if (!image || typeof image !== 'object') return null;
  const plane = image.__image16 && image.__image16.data instanceof Uint16Array ? image.__image16 : null;
  if (plane && plane.width === image.width && plane.height === image.height) {
    return { data: plane.data, scale: 1 / 65535, bits: 16 };
  }
  if (image.data instanceof Uint16Array) return { data: image.data, scale: 1 / 65535, bits: 16 };
  if (image.data && image.data.length >= image.width * image.height * 4) {
    return { data: image.data, scale: 1 / 255, bits: 8 };
  }
  return null;
}

function resolveBounds(image, options) {
  const width = image.width | 0;
  const height = image.height | 0;
  const region = options.region && typeof options.region === 'object' ? options.region : null;
  if (region) {
    const left = clamp(Math.floor(finite(region.left, 0)), 0, Math.max(0, width - 1));
    const top = clamp(Math.floor(finite(region.top, 0)), 0, Math.max(0, height - 1));
    const w = clamp(Math.floor(finite(region.width, width)), 1, width - left);
    const h = clamp(Math.floor(finite(region.height, height)), 1, height - top);
    return { left, top, width: w, height: h };
  }
  const buffer = clamp(finite(options.borderBuffer, 0.02), 0, 0.3);
  const inset = Math.floor(Math.min(width, height) * buffer);
  return {
    left: inset,
    top: inset,
    width: Math.max(1, width - inset * 2),
    height: Math.max(1, height - inset * 2)
  };
}

function sanitizePlacement(value) {
  if (!value || typeof value !== 'object') return IDENTITY_PLACEMENT;
  const left = finite(value.left, 0);
  const top = finite(value.top, 0);
  const width = finite(value.width, 1);
  const height = finite(value.height, 1);
  if (width <= 0 || height <= 0) return IDENTITY_PLACEMENT;
  return { left, top, width, height };
}

/**
 * Measures how an aged roll has shifted this positive.
 *
 * `options.spatial` (a stage from buildExpiredSpatialStage) flattens each
 * sample first, so the colour and tone are measured on the frame the way
 * the stage will hand it on; `options.placement` says where `image` sits
 * in the frame (normalised), for images that are already a crop of it.
 *
 * @param {{width:number,height:number,data:Uint8ClampedArray|Uint16Array,__image16?:object}} image
 * @param {{region?:{left:number,top:number,width:number,height:number}, borderBuffer?:number, maxSamples?:number, spatial?:object|null, placement?:object}} [options]
 * @returns {object|null} analysis, or null when there is nothing to measure
 */
export function analyzeExpiredFilm(image, options = {}) {
  const plane = resolveSamplePlane(image);
  if (!plane) return null;
  const { data, scale } = plane;
  const width = image.width | 0;
  const height = image.height | 0;
  const bounds = resolveBounds(image, options);
  const maxSamples = Math.max(1000, finite(options.maxSamples, 200000) | 0);
  const stride = Math.max(1, Math.ceil(Math.sqrt((bounds.width * bounds.height) / maxSamples)));
  const spatial = options.spatial && typeof options.spatial === 'object' ? options.spatial : null;
  const placement = sanitizePlacement(options.placement);
  const px = new Float32Array(3);

  const lumHist = new Uint32Array(HIST_BINS);
  const capacity = (Math.ceil(bounds.width / stride) + 1) * (Math.ceil(bounds.height / stride) + 1);
  const samples = new Float32Array(capacity * 3);
  let count = 0;
  for (let y = bounds.top; y < bounds.top + bounds.height; y += stride) {
    let index = (y * width + bounds.left) * 4;
    const v = placement.top + ((y + 0.5) / height) * placement.height;
    for (let x = bounds.left; x < bounds.left + bounds.width; x += stride, index += stride * 4) {
      if (!data[index + 3]) continue;
      let r = data[index] * scale;
      let g = data[index + 1] * scale;
      let b = data[index + 2] * scale;
      if (spatial) {
        px[0] = r * 255; px[1] = g * 255; px[2] = b * 255;
        applyExpiredSpatial(spatial, placement.left + ((x + 0.5) / width) * placement.width, v, px);
        r = px[0] / 255; g = px[1] / 255; b = px[2] / 255;
      }
      samples[count * 3] = r;
      samples[count * 3 + 1] = g;
      samples[count * 3 + 2] = b;
      lumHist[Math.min(HIST_BINS - 1, (luminance(r, g, b) * HIST_BINS) | 0)]++;
      count++;
    }
  }
  if (count < MIN_SAMPLES) return null;

  // 1. Tone: where the frame's density sits. The colour correction below
  //    keeps every pixel's luminance, so these serve the shared tone curve.
  let lumLow = percentileFromHistogram(lumHist, count, LOW_PERCENTILE);
  let lumHigh = percentileFromHistogram(lumHist, count, HIGH_PERCENTILE);
  if (lumHigh - lumLow < 0.02) {
    lumLow = 0;
    lumHigh = 1;
  }
  const lumMedian = percentileFromHistogram(lumHist, count, 0.5);
  const leveledMedian = clamp((lumMedian - lumLow) / (lumHigh - lumLow), 0, 1);

  // 2. Colour by density: per band of (range-normalised) luminance, the
  //    near-neutral-weighted mean colour and mean luminance.
  const bandCount = BAND_EDGES.length - 1;
  const span = Math.max(0.02, lumHigh - lumLow);
  const bandSum = Array.from({ length: bandCount }, () => [0, 0, 0]);
  const bandLumSum = new Float64Array(bandCount);
  const bandWeight = new Float64Array(bandCount);
  let bandTotal = 0;
  let neutralPopulation = 0;
  for (let i = 0; i < count; i++) {
    const r = samples[i * 3];
    const g = samples[i * 3 + 1];
    const b = samples[i * 3 + 2];
    const lum = luminance(r, g, b);
    const t = clamp((lum - lumLow) / span, 0, 1);
    const w = neutralWeight(r, g, b);
    neutralPopulation += w;
    let k = 0;
    while (k < bandCount - 1 && t >= BAND_EDGES[k + 1]) k++;
    bandSum[k][0] += w * r;
    bandSum[k][1] += w * g;
    bandSum[k][2] += w * b;
    bandLumSum[k] += w * lum;
    bandWeight[k] += w;
    bandTotal += w;
  }
  // Within a band the near-neutral pixels can still be two populations (a
  // grey ramp under a green fog next to a lawn); the mean would sit between
  // them. Three mean-shift steps pull each band's estimate onto its densest
  // colour cluster instead, which is where a film's neutrals gather.
  const bandMean = bandSum.map((sum, k) => (bandWeight[k] > 0 ? sum.map((v) => v / bandWeight[k]) : null));
  const bandOf = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const lum = luminance(samples[i * 3], samples[i * 3 + 1], samples[i * 3 + 2]);
    const t = clamp((lum - lumLow) / span, 0, 1);
    let k = 0;
    while (k < bandCount - 1 && t >= BAND_EDGES[k + 1]) k++;
    bandOf[i] = k;
  }
  for (let iteration = 0; iteration < 3; iteration++) {
    const shiftSum = Array.from({ length: bandCount }, () => [0, 0, 0]);
    const shiftLum = new Float64Array(bandCount);
    const shiftWeight = new Float64Array(bandCount);
    for (let i = 0; i < count; i++) {
      const k = bandOf[i];
      const mean = bandMean[k];
      if (!mean) continue;
      const r = samples[i * 3];
      const g = samples[i * 3 + 1];
      const b = samples[i * 3 + 2];
      const distance = Math.max(Math.abs(r - mean[0]), Math.abs(g - mean[1]), Math.abs(b - mean[2])) / CLUSTER_RADIUS;
      const w = neutralWeight(r, g, b) / (1 + distance * distance);
      shiftSum[k][0] += w * r;
      shiftSum[k][1] += w * g;
      shiftSum[k][2] += w * b;
      shiftLum[k] += w * luminance(r, g, b);
      shiftWeight[k] += w;
    }
    for (let k = 0; k < bandCount; k++) {
      if (!bandMean[k] || shiftWeight[k] < 8) continue;
      bandMean[k] = shiftSum[k].map((v) => v / shiftWeight[k]);
      bandLumSum[k] = shiftLum[k];
      bandWeight[k] = shiftWeight[k];
    }
  }
  const bands = [];
  for (let k = 0; k < bandCount; k++) {
    const share = bandTotal > 0 ? bandWeight[k] / bandTotal : 0;
    if (!bandMean[k] || share < MIN_BAND_SHARE || bandWeight[k] < 8) {
      bands.push(null);
      continue;
    }
    bands.push({
      lum: round4(bandLumSum[k] / bandWeight[k]),
      mean: bandMean[k].map(round4),
      share: round4(share)
    });
  }
  // The overall cast: how far the near-neutral population leans, weighted
  // by band population.
  let lean = [0, 0, 0];
  let leanWeight = 0;
  for (const band of bands) {
    if (!band) continue;
    for (let c = 0; c < 3; c++) lean[c] += band.share * (band.mean[c] - band.lum);
    leanWeight += band.share;
  }
  lean = lean.map((v) => (leanWeight > 0 ? v / leanWeight : 0));

  return {
    version: EXPIRED_RESCUE_VERSION,
    bits: plane.bits,
    samples: count,
    lumLow: round4(lumLow),
    lumHigh: round4(lumHigh),
    lumMedian: round4(lumMedian),
    leveledMedian: round4(leveledMedian),
    bands,
    lean: lean.map(round4),
    neutralShare: round4(count ? neutralPopulation / count : 0)
  };
}

// The colour correction as a table over luminance (0..255 units): each
// band's lean (its near-neutral mean minus its luminance) is an anchor, the
// anchors are joined by a shape-preserving cubic over luminance, and the
// offset is the negative lean, split into the overall cast (scaled by
// `neutralize`) and what varies with density (scaled by `crossover`), held
// flat beyond the outermost bands. Null when nothing leans.
function offsetsFromBands(bands, lean, neutralize, crossover) {
  const points = bands.filter(Boolean);
  if (!points.length) return null;
  const anchors = points.map((band) => ({ lum: band.lum, lean: band.mean.map((m) => m - band.lum) }));
  const xs = anchors.map((a) => a.lum);
  const lo = xs[0];
  const hi = xs[xs.length - 1];
  const table = new Float32Array(OFFSET_BINS * 3);
  let moved = false;
  for (let c = 0; c < 3; c++) {
    const curve = shapeCubic(xs, anchors.map((a) => a.lean[c]));
    for (let i = 0; i < OFFSET_BINS; i++) {
      const bandLean = curve(clamp(i / (OFFSET_BINS - 1), lo, hi));
      const delta = clamp(-(lean[c] * neutralize + (bandLean - lean[c]) * crossover), -BAND_MOVE_LIMIT, BAND_MOVE_LIMIT);
      if (Math.abs(delta) > 0.002) moved = true;
      table[i * 3 + c] = delta * 255;
    }
  }
  return moved ? table : null;
}

// Spatial part: a fog surface and a local-mean grid measured by OpenCV.

function evaluateQuadratic(c, u, v) {
  return c[0] + c[1] * u + c[2] * v + c[3] * u * u + c[4] * v * v + c[5] * u * v;
}

// Weighted least squares for `dof` coefficients (normal equations, Gaussian
// elimination with pivoting, a whisper of ridge). Rows carry six features;
// a plane uses the first three.
function solveLeastSquares(rows, values, weights, dof) {
  const m = Array.from({ length: dof }, () => new Float64Array(dof + 1));
  for (let i = 0; i < values.length; i++) {
    const w = weights[i];
    if (!(w > 0)) continue;
    const row = rows[i];
    for (let p = 0; p < dof; p++) {
      const rp = row[p] * w;
      for (let q = 0; q < dof; q++) m[p][q] += rp * row[q];
      m[p][dof] += rp * values[i];
    }
  }
  for (let p = 0; p < dof; p++) m[p][p] += 1e-7;
  for (let col = 0; col < dof; col++) {
    let pivot = col;
    for (let r = col + 1; r < dof; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    if (pivot !== col) { const t = m[pivot]; m[pivot] = m[col]; m[col] = t; }
    for (let r = 0; r < dof; r++) {
      if (r === col) continue;
      const factor = m[r][col] / m[col][col];
      if (!factor) continue;
      for (let q = col; q <= dof; q++) m[r][q] -= factor * m[col][q];
    }
  }
  const out = [0, 0, 0, 0, 0, 0];
  for (let p = 0; p < dof; p++) out[p] = m[p][dof] / m[p][p];
  return out.every(Number.isFinite) ? out : null;
}

// Fits a floor to a grid of local minima. Bright content lifts cells above
// the floor, so cells above the surface lose weight quickly (asymmetric
// Huber) while cells below keep pulling it down.
function fitFloor(values, us, vs, rows, dof) {
  const n = values.length;
  const sorted = Array.from(values).sort((a, b) => a - b);
  const median = sorted[n >> 1];
  let weights = Array.from(values, (value) => (value <= median ? 1 : 0.25));
  let coefficients = solveLeastSquares(rows, values, weights, dof);
  if (!coefficients) return null;
  for (let iteration = 0; iteration < 5; iteration++) {
    weights = Array.from(values, (value, i) => {
      const residual = value - evaluateQuadratic(coefficients, us[i], vs[i]);
      // Above the surface is content (drops out fast); below is the floor
      // itself and keeps its say.
      const scaled = residual > 0 ? residual / 0.012 : residual / 0.04;
      return 1 / (1 + scaled * scaled);
    });
    const next = solveLeastSquares(rows, values, weights, dof);
    if (!next) break;
    coefficients = next;
  }
  return coefficients;
}

// Fog on film varies gently. A quadratic is tried first (a bowl or a corner);
// when even the robust fit bends further than fog plausibly could — bright
// content filling a corner of a small region — a plane is fitted instead,
// and failing that the floor is treated as even.
const FOG_SURFACE_PLAUSIBLE = 0.25;
function fitFogSurface(values, us, vs, fraction) {
  const rows = [];
  for (let i = 0; i < values.length; i++) rows.push([1, us[i], vs[i], us[i] * us[i], vs[i] * vs[i], us[i] * vs[i]]);
  for (const dof of [6, 3]) {
    const fit = fitFloor(values, us, vs, rows, dof);
    if (!fit) continue;
    const range = surfaceRange(fit, fraction);
    if (range.max - range.min <= FOG_SURFACE_PLAUSIBLE) return fit;
  }
  return null;
}

// The surface is only trusted where it was measured: its range is read over
// the measured region, and applyExpiredSpatial() holds it at the region's
// edges instead of extrapolating a quadratic into a rebate or a border.
function surfaceRange(coefficients, fraction) {
  let min = Infinity;
  let max = -Infinity;
  for (let j = 0; j <= 8; j++) {
    for (let i = 0; i <= 8; i++) {
      const value = evaluateQuadratic(coefficients, fraction.left + (i / 8) * fraction.width, fraction.top + (j / 8) * fraction.height);
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  return { min, max };
}

/**
 * Turns OpenCV's low-resolution maps (see app/expiredRescueOpenCv.js) into
 * the stored spatial analysis: a quadratic fog floor per channel in frame
 * coordinates plus the local luminance-mean grid.
 *
 * @param {{gridWidth:number, gridHeight:number, low:Float32Array[], mean:Float32Array, fraction:{left:number,top:number,width:number,height:number}}} maps
 */
export function fitExpiredSpatial(maps) {
  if (!maps || !Array.isArray(maps.low) || maps.low.length !== 3 || !maps.mean) return null;
  const gw = maps.gridWidth | 0;
  const gh = maps.gridHeight | 0;
  if (gw < 2 || gh < 2 || maps.mean.length !== gw * gh) return null;
  const fraction = sanitizePlacement(maps.fraction);
  const us = new Float32Array(gw * gh);
  const vs = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      us[j * gw + i] = fraction.left + ((i + 0.5) / gw) * fraction.width;
      vs[j * gw + i] = fraction.top + ((j + 0.5) / gh) * fraction.height;
    }
  }
  const coefficients = [];
  const offset = [];
  const amplitude = [];
  for (let c = 0; c < 3; c++) {
    const grid = maps.low[c];
    if (!grid || grid.length !== gw * gh) return null;
    let fit = gw * gh >= 12 ? fitFogSurface(grid, us, vs, fraction) : null;
    if (!fit) {
      let sum = 0;
      for (let i = 0; i < grid.length; i++) sum += grid[i];
      fit = [sum / grid.length, 0, 0, 0, 0, 0];
    }
    const range = surfaceRange(fit, fraction);
    const span = range.max - range.min;
    if (!(span >= 0.005)) fit = [range.min, 0, 0, 0, 0, 0];
    coefficients.push(fit.map(round4));
    offset.push(round4(range.min));
    amplitude.push(round4(Math.max(0, span >= 0.005 ? span : 0)));
  }
  return {
    version: EXPIRED_SPATIAL_VERSION,
    fraction: { left: round4(fraction.left), top: round4(fraction.top), width: round4(fraction.width), height: round4(fraction.height) },
    gridWidth: gw,
    gridHeight: gh,
    fog: { coefficients, offset, amplitude },
    mean: Array.from(maps.mean, (value) => Math.round(clamp(value, 0, 1) * 1000) / 1000)
  };
}

/** A range-checked plain copy of a spatial analysis, or null. */
export function sanitizeExpiredSpatial(value) {
  if (!value || typeof value !== 'object' || value.version !== EXPIRED_SPATIAL_VERSION) return null;
  const gw = Number(value.gridWidth) | 0;
  const gh = Number(value.gridHeight) | 0;
  if (gw < 2 || gh < 2 || gw > 128 || gh > 128) return null;
  if (!Array.isArray(value.mean) || value.mean.length !== gw * gh) return null;
  const fog = value.fog && typeof value.fog === 'object' ? value.fog : null;
  if (!fog || !Array.isArray(fog.coefficients) || fog.coefficients.length !== 3) return null;
  const coefficients = fog.coefficients.map((c) => (Array.isArray(c) && c.length === 6 ? c.map((v) => clamp(finite(v, 0), -20, 20)) : null));
  if (coefficients.some((c) => !c)) return null;
  const triple = (arr, min, max) => (Array.isArray(arr) && arr.length === 3 ? arr.map((v) => clamp(finite(v, 0), min, max)) : [0, 0, 0]);
  return {
    version: EXPIRED_SPATIAL_VERSION,
    fraction: sanitizePlacement(value.fraction),
    gridWidth: gw,
    gridHeight: gh,
    fog: { coefficients, offset: triple(fog.offset, -1, 2), amplitude: triple(fog.amplitude, 0, 1) },
    mean: value.mean.map((v) => clamp(finite(v, 0.5), 0, 1))
  };
}

/**
 * The per-pixel spatial stage for a frame: null when the analysis has no
 * spatial part or both strengths are zero. Values are in the 0..255 domain
 * the adjustment loops use.
 */
export function buildExpiredSpatialStage(settings) {
  if (!settings || typeof settings !== 'object' || !settings.expiredEnabled) return null;
  const spatial = sanitizeExpiredSpatial(settings.expiredAnalysis && settings.expiredAnalysis.spatial);
  if (!spatial) return null;
  const params = sanitizeExpiredRescueParams(settings);
  const fogStrength = params.expiredUnevenFog / 100;
  const local = (params.expiredLocalContrast / 100) * LOCAL_CONTRAST_MAX;
  const fogActive = fogStrength > 0 && spatial.fog.amplitude.some((a) => a > 0);
  if (!fogActive && local <= 0) return null;
  const coefficients = new Float32Array(18);
  for (let c = 0; c < 3; c++) for (let k = 0; k < 6; k++) coefficients[c * 6 + k] = spatial.fog.coefficients[c][k];
  return {
    fog: fogActive ? coefficients : null,
    fogOffset: Float32Array.from(spatial.fog.offset),
    fogScale: fogStrength * 255,
    fogLimit: FOG_SURFACE_LIMIT,
    local,
    mean: local > 0 ? Float32Array.from(spatial.mean, (v) => v * 255) : null,
    gridWidth: spatial.gridWidth,
    gridHeight: spatial.gridHeight,
    fraction: spatial.fraction
  };
}

function meanAt(stage, u, v) {
  const { fraction, gridWidth, gridHeight, mean } = stage;
  const gu = clamp((u - fraction.left) / fraction.width, 0, 1) * (gridWidth - 1);
  const gv = clamp((v - fraction.top) / fraction.height, 0, 1) * (gridHeight - 1);
  const i0 = gu | 0;
  const j0 = gv | 0;
  const i1 = i0 + 1 < gridWidth ? i0 + 1 : i0;
  const j1 = j0 + 1 < gridHeight ? j0 + 1 : j0;
  const fu = gu - i0;
  const fv = gv - j0;
  const top = mean[j0 * gridWidth + i0] * (1 - fu) + mean[j0 * gridWidth + i1] * fu;
  const bottom = mean[j1 * gridWidth + i0] * (1 - fu) + mean[j1 * gridWidth + i1] * fu;
  return top * (1 - fv) + bottom * fv;
}

/**
 * Applies the spatial stage to one pixel in place. `u`, `v` are the pixel's
 * normalised frame coordinates; `px` holds R, G, B in 0..255 (floats).
 */
export function applyExpiredSpatial(stage, u, v, px) {
  let fogLum = 0;
  const { fraction } = stage;
  if (u < fraction.left) u = fraction.left;
  else if (u > fraction.left + fraction.width) u = fraction.left + fraction.width;
  if (v < fraction.top) v = fraction.top;
  else if (v > fraction.top + fraction.height) v = fraction.top + fraction.height;
  if (stage.fog) {
    const c = stage.fog;
    for (let ch = 0; ch < 3; ch++) {
      const k = ch * 6;
      const q = c[k] + c[k + 1] * u + c[k + 2] * v + c[k + 3] * u * u + c[k + 4] * v * v + c[k + 5] * u * v;
      const fog = clamp(q - stage.fogOffset[ch], 0, stage.fogLimit) * stage.fogScale;
      if (fog > 0) {
        const value = (px[ch] - fog) / (1 - fog / 255);
        px[ch] = value < 0 ? 0 : value;
      }
      fogLum += fog * (ch === 0 ? 0.2126 : ch === 1 ? 0.7152 : 0.0722);
    }
  }
  if (stage.local > 0) {
    let mean = meanAt(stage, u, v);
    if (fogLum > 0) {
      mean = (mean - fogLum) / (1 - fogLum / 255);
      if (mean < 0) mean = 0;
    }
    const lum = 0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2];
    const delta = (lum - mean) * stage.local;
    for (let ch = 0; ch < 3; ch++) px[ch] = clamp(px[ch] + delta, 0, 255);
  }
}


function sanitizeBands(value) {
  if (!Array.isArray(value) || value.length !== BAND_EDGES.length - 1) return null;
  return value.map((band) => {
    if (!band || typeof band !== 'object') return null;
    const mean = Array.isArray(band.mean) && band.mean.length === 3 ? band.mean.map((v) => clamp(finite(v, 0.5), 0, 1)) : null;
    if (!mean) return null;
    return { lum: clamp(finite(band.lum, 0.5), 0, 1), mean, share: clamp(finite(band.share, 0), 0, 1) };
  });
}

/** True when `value` is an analysis this module produced (or a faithful copy). */
export function isExpiredAnalysis(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.version !== EXPIRED_RESCUE_VERSION) return false;
  if (!sanitizeBands(value.bands)) return false;
  return ['lumLow', 'lumHigh', 'leveledMedian'].every((key) => Number.isFinite(Number(value[key])));
}

/** A plain, range-checked copy of an analysis, or null. */
export function sanitizeExpiredAnalysis(value) {
  if (!isExpiredAnalysis(value)) return null;
  let lumLow = clamp(finite(value.lumLow, 0), 0, 0.98);
  let lumHigh = clamp(finite(value.lumHigh, 1), 0.02, 1);
  if (lumHigh - lumLow < 0.02) {
    lumLow = 0;
    lumHigh = 1;
  }
  const lean = Array.isArray(value.lean) && value.lean.length === 3 ? value.lean.map((v) => clamp(finite(v, 0), -1, 1)) : [0, 0, 0];
  const spatial = sanitizeExpiredSpatial(value.spatial);
  return {
    version: EXPIRED_RESCUE_VERSION,
    bits: value.bits === 16 ? 16 : 8,
    samples: Math.max(0, Number(value.samples) | 0),
    lumLow,
    lumHigh,
    lumMedian: clamp(finite(value.lumMedian, 0.5), 0, 1),
    leveledMedian: clamp(finite(value.leveledMedian, 0.5), 0, 1),
    bands: sanitizeBands(value.bands),
    lean,
    neutralShare: clamp(finite(value.neutralShare, 0), 0, 1),
    ...(spatial ? { spatial } : {})
  };
}

/**
 * Starting strengths for an analysis: the colour stages at their defaults,
 * brightness from how dark the leveled midtones are (an underexposed roll),
 * contrast from how much range the levels had to recover.
 */
export function defaultExpiredRescueParams(analysis) {
  const params = { ...EXPIRED_RESCUE_DEFAULTS, expiredEnabled: true };
  const safe = sanitizeExpiredAnalysis(analysis);
  if (!safe) return params;
  const median = clamp(safe.leveledMedian, 0.02, 0.98);
  // brightness b applies gamma 2^(-b/100); solve for the gamma that puts the
  // median on middle grey, then keep it inside a lift that does not flatten.
  const gammaNeeded = Math.log(TARGET_MIDTONE) / Math.log(median);
  params.expiredBrightness = Math.round(clamp(-100 * Math.log2(gammaNeeded), -25, 60));
  // A roll that only used half the range was flat; a little S-curve helps.
  const range = safe.lumHigh - safe.lumLow;
  params.expiredContrast = Math.round(clamp(20 + (1 - range) * 30, 10, 45));
  return params;
}

/** Range-checked strengths; missing keys fall back to `fallback` then the defaults. */
export function sanitizeExpiredRescueParams(source, fallback = null) {
  const src = source && typeof source === 'object' ? source : {};
  const fb = fallback && typeof fallback === 'object' ? fallback : {};
  const out = {};
  out.expiredEnabled = typeof src.expiredEnabled === 'boolean'
    ? src.expiredEnabled
    : (typeof fb.expiredEnabled === 'boolean' ? fb.expiredEnabled : EXPIRED_RESCUE_DEFAULTS.expiredEnabled);
  for (const key of Object.keys(EXPIRED_RESCUE_RANGES)) {
    const [min, max] = EXPIRED_RESCUE_RANGES[key];
    const value = finite(src[key], finite(fb[key], EXPIRED_RESCUE_DEFAULTS[key]));
    out[key] = Math.round(clamp(value, min, max));
  }
  return out;
}

// The tanh S-curve of the engine's tone profiles, pinned at 0 and 1.
function softContrast(x, strength) {
  const s = 4;
  const shaped = 0.5 + Math.tanh((x - 0.5) * s) / (2 * Math.tanh(s / 2));
  return x + strength * (shaped - x);
}

function buildColourOffsets(analysis, neutralize, crossover) {
  return offsetsFromBands(analysis.bands, analysis.lean, neutralize, crossover);
}

/**
 * The rescue's stages for a frame, or null when the stage is off / has no
 * analysis: `offsets`, the luminance-indexed colour table (null when nothing
 * leans), then `tone`, the shared 256-entry float curve (levels, brightness,
 * contrast) in the 0..255 domain. `composed` carries the tone curve for
 * each channel when there are no offsets, for the separable fast path.
 */
export function buildExpiredRescueStages(settings) {
  if (!settings || typeof settings !== 'object' || !settings.expiredEnabled) return null;
  const analysis = sanitizeExpiredAnalysis(settings.expiredAnalysis);
  if (!analysis) return null;
  const params = sanitizeExpiredRescueParams(settings);
  const levels = params.expiredLevels / 100;
  const brightnessGamma = Math.pow(2, -params.expiredBrightness / 100);
  const contrast = params.expiredContrast / 100;
  const lo = analysis.lumLow * levels;
  const hi = 1 - (1 - analysis.lumHigh) * levels;
  const span = Math.max(0.02, hi - lo);
  const tone = new Float32Array(256);
  for (let v = 0; v < 256; v++) {
    let x = clamp((v / 255 - lo) / span, 0, 1);
    x = Math.pow(x, brightnessGamma);
    if (contrast > 0) x = softContrast(x, contrast);
    tone[v] = clamp(x * 255, 0, 255);
  }
  const offsets = buildColourOffsets(analysis, params.expiredNeutralize / 100, params.expiredCrossover / 100);
  return { offsets, tone, composed: offsets ? null : { r: tone, g: tone, b: tone } };
}

/**
 * One pixel through the stages: the colour offsets for its luminance, then
 * the shared tone curve. `px` holds R, G, B in 0..255 (floats), updated in
 * place.
 */
export function applyExpiredTone(stages, px) {
  let r = px[0];
  let g = px[1];
  let b = px[2];
  const table = stages.offsets;
  if (table) {
    const pos = clamp((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255, 0, 1) * (OFFSET_BINS - 1);
    const i0 = pos | 0;
    const i1 = i0 + 1 < OFFSET_BINS ? i0 + 1 : i0;
    const f = pos - i0;
    r = clamp(r + table[i0 * 3] * (1 - f) + table[i1 * 3] * f, 0, 255);
    g = clamp(g + table[i0 * 3 + 1] * (1 - f) + table[i1 * 3 + 1] * f, 0, 255);
    b = clamp(b + table[i0 * 3 + 2] * (1 - f) + table[i1 * 3 + 2] * f, 0, 255);
  }
  px[0] = lerpCurve(stages.tone, r);
  px[1] = lerpCurve(stages.tone, g);
  px[2] = lerpCurve(stages.tone, b);
}

/**
 * The separable part of the rescue as three 256-entry curves: the shared
 * tone curve. The luminance-indexed colour offsets are not a per-channel
 * curve; callers that need the whole rescue use buildExpiredRescueStages()
 * and applyExpiredTone().
 */
export function buildExpiredRescueCurves(settings) {
  const stages = buildExpiredRescueStages(settings);
  if (!stages) return null;
  return { r: stages.tone, g: stages.tone, b: stages.tone };
}

/** True when the curves would change nothing (all identity within half a level). */
export function isIdentityExpiredCurves(curves) {
  if (!curves) return true;
  for (const key of ['r', 'g', 'b']) {
    const curve = curves[key];
    if (!curve || curve.length !== 256) return true;
    for (let v = 0; v < 256; v++) if (Math.abs(curve[v] - v) > 0.5) return false;
  }
  return true;
}

const HUE_NAMES = ['red', 'yellow', 'green', 'cyan', 'blue', 'magenta'];

// The name of the hue a small RGB offset leans towards.
function castName(offset) {
  const [r, g, b] = offset;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  if (chroma < 1e-6) return null;
  let hue;
  if (max === r) hue = ((g - b) / chroma) % 6;
  else if (max === g) hue = (b - r) / chroma + 2;
  else hue = (r - g) / chroma + 4;
  if (hue < 0) hue += 6;
  return HUE_NAMES[Math.round(hue) % 6];
}

/**
 * Plain numbers and hue names for the diagnosis panel. Percentages are
 * integers; `exposureStops` is negative when the roll was underexposed.
 */
export function describeExpiredAnalysis(analysis) {
  const safe = sanitizeExpiredAnalysis(analysis);
  if (!safe) return null;
  const spread = (offset) => Math.max(...offset) - Math.min(...offset);
  const fog = safe.lumLow;
  const range = safe.lumHigh - safe.lumLow;
  const castStrength = spread(safe.lean);
  // Shadows = the bands below 0.3 of the range, highlights = 0.6 to 0.9: how
  // far their near-neutral pixels lean beyond the overall cast.
  const bandLean = (from, to) => {
    const acc = [0, 0, 0];
    let weight = 0;
    for (let k = from; k <= to; k++) {
      const band = safe.bands[k];
      if (!band) continue;
      for (let c = 0; c < 3; c++) acc[c] += band.share * (band.mean[c] - band.lum - safe.lean[c]);
      weight += band.share;
    }
    return weight > 0 ? acc.map((v) => v / weight) : [0, 0, 0];
  };
  const shadow = bandLean(1, 2);
  const highlight = bandLean(5, 6);
  let crossoverStrength = 0;
  for (let k = 1; k <= 6; k++) {
    const band = safe.bands[k];
    if (band) crossoverStrength = Math.max(crossoverStrength, spread(band.mean.map((m, c) => m - band.lum - safe.lean[c])));
  }
  // A midtone at 0.42 is "correct"; every halving of the linear value is a stop.
  const linear = Math.pow(clamp(safe.leveledMedian, 0.01, 1), 2.2);
  const exposureStops = Math.log2(linear / Math.pow(TARGET_MIDTONE, 2.2));
  const levelsUsed = Math.round(range * (safe.bits === 16 ? 65535 : 255));
  const unevenFog = safe.spatial ? Math.max(...safe.spatial.fog.amplitude) : 0;
  return {
    hasSpatial: Boolean(safe.spatial),
    unevenFogPercent: Math.round(unevenFog * 100),
    fogPercent: Math.round(fog * 100),
    rangePercent: Math.round(range * 100),
    cast: castStrength >= 0.03 ? castName(safe.lean) : null,
    castPercent: Math.round(castStrength * 100),
    shadowCast: spread(shadow) >= 0.02 ? castName(shadow) : null,
    highlightCast: spread(highlight) >= 0.02 ? castName(highlight) : null,
    crossoverPercent: Math.round(crossoverStrength * 100),
    exposureStops: Math.round(exposureStops * 10) / 10,
    levelsUsed,
    lowBitDepth: safe.bits === 8 && levelsUsed < 110,
    neutralSharePercent: Math.round(safe.neutralShare * 100)
  };
}

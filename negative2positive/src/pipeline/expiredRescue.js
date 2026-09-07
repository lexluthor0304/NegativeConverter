// Expired film rescue: a separate correction stage for rolls that were shot
// or developed long past their date. Age shows up in a positive as
//
//   * fog       — every channel's black point floats up, contrast collapses;
//   * a cast    — the dye layers lose speed at different rates, so one or
//                 two channels sit high everywhere (blue/magenta, green…);
//   * crossover — the layers also fade with different gammas, so shadows
//                 lean one way (often green) and highlights the other
//                 (often pink), which no single white balance removes;
//   * thin shadows — an old roll is slower than its box speed, so the frame
//                 is in effect underexposed.
//
// The stage models exactly that per channel: black/white points, a gamma
// that neutralises the midtones, and a bounded split-tone offset for the
// remaining crossover, followed by a master brightness gamma and a soft
// S-curve. Everything is a per-channel 1-D curve, so it folds into the
// adjustment LUTs and costs nothing per pixel. No OpenCV, no DOM.
//
// analyzeExpiredFilm() measures a positive once and returns a small plain
// object (percentiles, gammas, band offsets) that is stored with the photo's
// settings; buildExpiredRescueCurves() turns that plus the five strengths
// into three 256-entry curves (0..255 in, 0..255 float out) at any time.

export const EXPIRED_RESCUE_VERSION = 1;

// The spatial part (uneven fog, local contrast) is measured with OpenCV.js
// on the main thread (app/expiredRescueOpenCv.js) and stored as a small
// quadratic fog surface plus a local-mean grid; this module fits, stores
// and applies them without OpenCV, so the export worker and the 16-bit
// path reproduce the preview exactly.
export const EXPIRED_SPATIAL_VERSION = 1;

export const EXPIRED_RESCUE_KEYS = Object.freeze([
  'expiredEnabled', 'expiredLevels', 'expiredNeutralize', 'expiredCrossover',
  'expiredBrightness', 'expiredContrast', 'expiredUnevenFog', 'expiredLocalContrast'
]);

export const EXPIRED_RESCUE_DEFAULTS = Object.freeze({
  expiredEnabled: false,
  expiredLevels: 100,
  expiredNeutralize: 80,
  expiredCrossover: 70,
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

// The fitted fog surface never removes more than this much of the range at
// any point, so a failed fit (a bright wall read as fog) stays a mild error.
const FOG_SURFACE_LIMIT = 0.15;
// Local contrast at 100 %: deviations from the local mean grow by this much.
const LOCAL_CONTRAST_MAX = 0.6;
const IDENTITY_PLACEMENT = Object.freeze({ left: 0, top: 0, width: 1, height: 1 });

const HIST_BINS = 1024;
const LOW_PERCENTILE = 0.005;
const HIGH_PERCENTILE = 0.995;
const MID_BAND = [0.12, 0.88];
const SHADOW_BAND = [0.04, 0.42];
const HIGHLIGHT_BAND = [0.58, 0.96];
const NEUTRAL_CHROMA = 0.12;
const GAMMA_RANGE = [0.55, 1.8];
// Offsets beyond this would dent the curve's slope; the monotonic guard in
// buildExpiredRescueCurves() covers the rest.
const CROSSOVER_LIMIT = 0.12;
const MIN_SAMPLES = 400;
// sRGB middle grey; a leveled positive whose midtones sit well below it was
// underexposed (an aged roll has lost speed) and gets a brightness lift.
const TARGET_MIDTONE = 0.42;

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

// Split-tone weights: zero at both ends of the range (the levels already
// fixed black and white), peaking in the shadows / highlights.
function shadowWeight(x) {
  if (x >= 0.5) return 0;
  const t = x / 0.5;
  return 4 * t * (1 - t);
}

function highlightWeight(x) {
  if (x <= 0.5) return 0;
  const t = (x - 0.5) / 0.5;
  return 4 * t * (1 - t);
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

/**
 * Measures how an aged roll has shifted this positive.
 *
 * `options.spatial` (a stage from buildExpiredSpatialStage) flattens each
 * sample first, so the curves are measured on the frame the way the stage
 * will hand it to them; `options.placement` says where `image` sits in the
 * frame (normalised), for images that are already a crop of it.
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

  const hist = [new Uint32Array(HIST_BINS), new Uint32Array(HIST_BINS), new Uint32Array(HIST_BINS)];
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
      hist[0][Math.min(HIST_BINS - 1, (r * HIST_BINS) | 0)]++;
      hist[1][Math.min(HIST_BINS - 1, (g * HIST_BINS) | 0)]++;
      hist[2][Math.min(HIST_BINS - 1, (b * HIST_BINS) | 0)]++;
      lumHist[Math.min(HIST_BINS - 1, (luminance(r, g, b) * HIST_BINS) | 0)]++;
      count++;
    }
  }
  if (count < MIN_SAMPLES) return null;

  // 1. Fog and range: black / white points per channel.
  const low = [0, 1, 2].map((c) => percentileFromHistogram(hist[c], count, LOW_PERCENTILE));
  const high = [0, 1, 2].map((c) => percentileFromHistogram(hist[c], count, HIGH_PERCENTILE));
  for (let c = 0; c < 3; c++) {
    if (high[c] - low[c] < 0.02) {
      // A flat channel: leave it alone rather than amplify noise 50×.
      low[c] = 0;
      high[c] = 1;
    }
  }
  const lumMedian = percentileFromHistogram(lumHist, count, 0.5);
  const medians = [0, 1, 2].map((c) => percentileFromHistogram(hist[c], count, 0.5));

  // 2. Midtone neutrality after the levels: per-channel gamma so the
  //    near-neutral midtones land on their luminance.
  const leveled = new Float32Array(count * 3);
  const logSum = [0, 0, 0];
  let logTargetSum = 0;
  let midWeight = 0;
  let neutralPopulation = 0;
  for (let i = 0; i < count; i++) {
    const r = clamp((samples[i * 3] - low[0]) / (high[0] - low[0]), 0, 1);
    const g = clamp((samples[i * 3 + 1] - low[1]) / (high[1] - low[1]), 0, 1);
    const b = clamp((samples[i * 3 + 2] - low[2]) / (high[2] - low[2]), 0, 1);
    leveled[i * 3] = r;
    leveled[i * 3 + 1] = g;
    leveled[i * 3 + 2] = b;
    const lum = luminance(r, g, b);
    if (lum < MID_BAND[0] || lum > MID_BAND[1]) continue;
    const w = neutralWeight(r, g, b);
    neutralPopulation += w;
    const floor = 1 / 512;
    logSum[0] += w * Math.log(Math.max(floor, r));
    logSum[1] += w * Math.log(Math.max(floor, g));
    logSum[2] += w * Math.log(Math.max(floor, b));
    logTargetSum += w * Math.log(Math.max(floor, lum));
    midWeight += w;
  }
  const gamma = [1, 1, 1];
  if (midWeight > 0) {
    const logTarget = logTargetSum / midWeight;
    for (let c = 0; c < 3; c++) {
      const logChannel = logSum[c] / midWeight;
      gamma[c] = logChannel < -1e-6 ? clamp(logTarget / logChannel, GAMMA_RANGE[0], GAMMA_RANGE[1]) : 1;
    }
  }

  // 3. Crossover: what remains in the shadows and highlights once the
  //    midtones are neutral, as an offset per channel, with the mean of the
  //    split-tone weight over the same pixels so the curve removes exactly
  //    the measured mean.
  const shadowOffset = [0, 0, 0];
  const highlightOffset = [0, 0, 0];
  const shadowWeightMean = [0, 0, 0];
  const highlightWeightMean = [0, 0, 0];
  let shadowTotal = 0;
  let highlightTotal = 0;
  const leveledLum = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const r = Math.pow(leveled[i * 3], gamma[0]);
    const g = Math.pow(leveled[i * 3 + 1], gamma[1]);
    const b = Math.pow(leveled[i * 3 + 2], gamma[2]);
    const lum = luminance(r, g, b);
    leveledLum[i] = lum;
    const w = neutralWeight(r, g, b);
    if (lum >= SHADOW_BAND[0] && lum <= SHADOW_BAND[1]) {
      shadowOffset[0] += w * (r - lum);
      shadowOffset[1] += w * (g - lum);
      shadowOffset[2] += w * (b - lum);
      shadowWeightMean[0] += w * shadowWeight(r);
      shadowWeightMean[1] += w * shadowWeight(g);
      shadowWeightMean[2] += w * shadowWeight(b);
      shadowTotal += w;
    } else if (lum >= HIGHLIGHT_BAND[0] && lum <= HIGHLIGHT_BAND[1]) {
      highlightOffset[0] += w * (r - lum);
      highlightOffset[1] += w * (g - lum);
      highlightOffset[2] += w * (b - lum);
      highlightWeightMean[0] += w * highlightWeight(r);
      highlightWeightMean[1] += w * highlightWeight(g);
      highlightWeightMean[2] += w * highlightWeight(b);
      highlightTotal += w;
    }
  }
  const shadow = [0, 0, 0];
  const highlight = [0, 0, 0];
  // A band needs a real population before its offset is trusted.
  const minBandWeight = Math.max(30, count * 0.01);
  for (let c = 0; c < 3; c++) {
    if (shadowTotal >= minBandWeight) {
      const meanWeight = Math.max(0.25, shadowWeightMean[c] / shadowTotal);
      shadow[c] = clamp((shadowOffset[c] / shadowTotal) / meanWeight, -CROSSOVER_LIMIT, CROSSOVER_LIMIT);
    }
    if (highlightTotal >= minBandWeight) {
      const meanWeight = Math.max(0.25, highlightWeightMean[c] / highlightTotal);
      highlight[c] = clamp((highlightOffset[c] / highlightTotal) / meanWeight, -CROSSOVER_LIMIT, CROSSOVER_LIMIT);
    }
  }

  // 4. Exposure: where the leveled, neutral midtones sit.
  const sortedLum = leveledLum.slice().sort();
  const leveledMedian = sortedLum[Math.floor((count - 1) * 0.5)];

  return {
    version: EXPIRED_RESCUE_VERSION,
    bits: plane.bits,
    samples: count,
    low: low.map(round4),
    high: high.map(round4),
    gamma: gamma.map(round4),
    shadow: shadow.map(round4),
    highlight: highlight.map(round4),
    medians: medians.map(round4),
    lumMedian: round4(lumMedian),
    leveledMedian: round4(leveledMedian),
    neutralShare: round4(count ? neutralPopulation / count : 0)
  };
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
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

// ---------------------------------------------------------------------------
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

/** True when `value` is an analysis this module produced (or a faithful copy). */
export function isExpiredAnalysis(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.version !== EXPIRED_RESCUE_VERSION) return false;
  for (const key of ['low', 'high', 'gamma', 'shadow', 'highlight']) {
    const arr = value[key];
    if (!Array.isArray(arr) || arr.length !== 3 || !arr.every((v) => Number.isFinite(Number(v)))) return false;
  }
  return Number.isFinite(Number(value.leveledMedian));
}

/** A plain, range-checked copy of an analysis, or null. */
export function sanitizeExpiredAnalysis(value) {
  if (!isExpiredAnalysis(value)) return null;
  const triple = (arr, min, max) => arr.map((v) => clamp(Number(v), min, max));
  const low = triple(value.low, 0, 0.98);
  const high = triple(value.high, 0.02, 1);
  for (let c = 0; c < 3; c++) if (high[c] - low[c] < 0.02) { low[c] = 0; high[c] = 1; }
  const spatial = sanitizeExpiredSpatial(value.spatial);
  return {
    version: EXPIRED_RESCUE_VERSION,
    bits: value.bits === 16 ? 16 : 8,
    samples: Math.max(0, Number(value.samples) | 0),
    low,
    high,
    gamma: triple(value.gamma, GAMMA_RANGE[0], GAMMA_RANGE[1]),
    shadow: triple(value.shadow, -CROSSOVER_LIMIT, CROSSOVER_LIMIT),
    highlight: triple(value.highlight, -CROSSOVER_LIMIT, CROSSOVER_LIMIT),
    medians: Array.isArray(value.medians) && value.medians.length === 3 ? triple(value.medians, 0, 1) : [0.5, 0.5, 0.5],
    lumMedian: clamp(finite(value.lumMedian, 0.5), 0, 1),
    leveledMedian: clamp(finite(value.leveledMedian, 0.5), 0, 1),
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
  const brightness = Math.round(clamp(-100 * Math.log2(gammaNeeded), -25, 60));
  params.expiredBrightness = brightness;
  const range = (safe.high[0] - safe.low[0] + safe.high[1] - safe.low[1] + safe.high[2] - safe.low[2]) / 3;
  // A roll that only used half the range was flat; a little S-curve helps.
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

/**
 * The rescue as three 256-entry curves (input 0..255 -> output 0..255 as
 * floats, monotonic), or null when the stage is off / has no analysis.
 */
export function buildExpiredRescueCurves(settings) {
  if (!settings || typeof settings !== 'object' || !settings.expiredEnabled) return null;
  const analysis = sanitizeExpiredAnalysis(settings.expiredAnalysis);
  if (!analysis) return null;
  const params = sanitizeExpiredRescueParams(settings);
  const levels = params.expiredLevels / 100;
  const neutralize = params.expiredNeutralize / 100;
  const crossover = params.expiredCrossover / 100;
  const brightnessGamma = Math.pow(2, -params.expiredBrightness / 100);
  const contrast = params.expiredContrast / 100;
  const curves = { r: new Float32Array(256), g: new Float32Array(256), b: new Float32Array(256) };
  const channels = [curves.r, curves.g, curves.b];
  for (let c = 0; c < 3; c++) {
    const lo = analysis.low[c] * levels;
    const hi = 1 - (1 - analysis.high[c]) * levels;
    const span = Math.max(0.02, hi - lo);
    const gamma = 1 + (analysis.gamma[c] - 1) * neutralize;
    const shadowAmp = analysis.shadow[c] * crossover;
    const highlightAmp = analysis.highlight[c] * crossover;
    const curve = channels[c];
    let previous = 0;
    for (let v = 0; v < 256; v++) {
      let x = clamp((v / 255 - lo) / span, 0, 1);
      x = Math.pow(x, gamma);
      x = clamp(x - shadowAmp * shadowWeight(x) - highlightAmp * highlightWeight(x), 0, 1);
      x = Math.pow(x, brightnessGamma);
      if (contrast > 0) x = softContrast(x, contrast);
      let out = clamp(x * 255, 0, 255);
      // Split-tone offsets could dent the slope; keep the curve monotonic.
      if (out < previous) out = previous;
      previous = out;
      curve[v] = out;
    }
  }
  return curves;
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
  const fog = (safe.low[0] + safe.low[1] + safe.low[2]) / 3;
  const range = (safe.high[0] - safe.low[0] + safe.high[1] - safe.low[1] + safe.high[2] - safe.low[2]) / 3;
  const lum = luminance(safe.medians[0], safe.medians[1], safe.medians[2]);
  const castOffset = safe.medians.map((m) => m - lum);
  const castStrength = Math.max(...castOffset) - Math.min(...castOffset);
  const shadowStrength = Math.max(...safe.shadow) - Math.min(...safe.shadow);
  const highlightStrength = Math.max(...safe.highlight) - Math.min(...safe.highlight);
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
    cast: castStrength >= 0.03 ? castName(castOffset) : null,
    castPercent: Math.round(castStrength * 100),
    shadowCast: shadowStrength >= 0.02 ? castName(safe.shadow) : null,
    highlightCast: highlightStrength >= 0.02 ? castName(safe.highlight) : null,
    crossoverPercent: Math.round(Math.max(shadowStrength, highlightStrength) * 100),
    exposureStops: Math.round(exposureStops * 10) / 10,
    levelsUsed,
    lowBitDepth: safe.bits === 8 && levelsUsed < 110,
    neutralSharePercent: Math.round(safe.neutralShare * 100)
  };
}

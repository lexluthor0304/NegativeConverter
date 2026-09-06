// Whole-roll analysis: a minilab looks at the entire roll before printing and
// then varies only the exposure per frame. These helpers aggregate per-frame
// measurements (film base, histogram levels, negative density) into one roll
// film base and one shared channelData, flag frames that do not belong to the
// roll, and turn per-frame density differences into exposure offsets.
// Pure functions; no DOM, no engine imports.

const ROLL_REASONS = Object.freeze(['base-colour', 'base-density', 'no-base']);

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function weightedMedian(values, weights) {
  const pairs = values.map((value, i) => ({ value, weight: weights ? weights[i] : 1 })).filter((p) => Number.isFinite(p.value) && p.weight > 0);
  if (!pairs.length) return NaN;
  pairs.sort((a, b) => a.value - b.value);
  const total = pairs.reduce((s, p) => s + p.weight, 0);
  let acc = 0;
  for (const p of pairs) {
    acc += p.weight;
    if (acc >= total / 2) return p.value;
  }
  return pairs[pairs.length - 1].value;
}

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const index = clamp(Math.round((sorted.length - 1) * fraction), 0, sorted.length - 1);
  return sorted[index];
}

// Chromaticity of a film base: channel shares that do not change with the
// light-box brightness, plus the brightness itself.
export function baseChromaticity(base) {
  if (!base) return null;
  const r = Number(base.r); const g = Number(base.g); const b = Number(base.b);
  if (![r, g, b].every(Number.isFinite)) return null;
  const sum = r + g + b;
  if (sum <= 0) return null;
  return { r: r / sum, b: b / sum, luminance: sum / 3 };
}

function baseWeight(base) {
  if (!base) return 0;
  if (base.method === 'rebate' || base.method === 'manual') return 3;
  const confidence = Number(base.confidence);
  return 1 + (Number.isFinite(confidence) ? clamp(confidence, 0, 1) : 0.5);
}

// Mean linear luminance of the negative inside an inset region. Used for the
// per-frame exposure offset; relative between frames, so gamma only needs to
// be consistent (sRGB-ish 2.2 is assumed for 8-bit data).
export function measureNegativeMean(imageData, insetFraction = 0.1) {
  if (!imageData || !imageData.data) return NaN;
  const { width, height, data } = imageData;
  const inset = clamp(Number(insetFraction) || 0, 0, 0.45);
  const x0 = Math.floor(width * inset); const x1 = Math.ceil(width * (1 - inset));
  const y0 = Math.floor(height * inset); const y1 = Math.ceil(height * (1 - inset));
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 60000)));
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.pow(i / 255, 2.2);
  let sum = 0; let count = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * width + x) * 4;
      if (data[i + 3] === 0) continue;
      sum += 0.2126 * lut[data[i]] + 0.7152 * lut[data[i + 1]] + 0.0722 * lut[data[i + 2]];
      count++;
    }
  }
  return count ? sum / count : NaN;
}

// Aggregates per-frame measurements. Each frame: { id, filmBase, channelData,
// negativeMean }. channelData is the SilverCore analysis (3 channels with
// whitePointOrigin / blackPointOrigin in 16-bit units and meanPoint in 0..1).
export function aggregateRollAnalysis(frames, options = {}) {
  const baseTolerance = Number.isFinite(options.baseTolerance) ? options.baseTolerance : 0.03;
  const luminanceTolerance = Number.isFinite(options.luminanceTolerance) ? options.luminanceTolerance : 0.35;
  const list = Array.isArray(frames) ? frames.filter((f) => f && f.id !== undefined) : [];
  const result = { count: list.length, usable: 0, filmBase: null, channelData: null, frames: [], outlierCount: 0 };
  if (!list.length) return result;

  const chroma = list.map((f) => baseChromaticity(f.filmBase));
  const weights = list.map((f) => baseWeight(f.filmBase));
  const medR = weightedMedian(chroma.map((c) => (c ? c.r : NaN)), weights);
  const medB = weightedMedian(chroma.map((c) => (c ? c.b : NaN)), weights);
  const medLum = weightedMedian(chroma.map((c) => (c ? c.luminance : NaN)), weights);

  const annotated = list.map((frame, i) => {
    const c = chroma[i];
    const reasons = [];
    if (!c) reasons.push('no-base');
    else {
      if (Math.abs(c.r - medR) > baseTolerance || Math.abs(c.b - medB) > baseTolerance) reasons.push('base-colour');
      const ratio = medLum > 0 ? c.luminance / medLum : 1;
      if (ratio < 1 - luminanceTolerance || ratio > 1 / (1 - luminanceTolerance)) reasons.push('base-density');
    }
    const baseDelta = c ? Math.max(Math.abs(c.r - medR), Math.abs(c.b - medB)) : null;
    return { frame, reasons, outlier: reasons.length > 0, baseDelta };
  });
  // A roll of two frames cannot outvote itself: with fewer than three frames only
  // the missing-base case counts as an outlier.
  if (list.length < 3) {
    for (const entry of annotated) {
      entry.reasons = entry.reasons.filter((r) => r === 'no-base');
      entry.outlier = entry.reasons.length > 0;
    }
  }
  const inliers = annotated.filter((e) => !e.outlier);
  result.usable = inliers.length;
  result.outlierCount = annotated.length - inliers.length;

  if (inliers.length) {
    const w = inliers.map((e) => baseWeight(e.frame.filmBase));
    const pick = (key) => weightedMedian(inliers.map((e) => Number(e.frame.filmBase[key])), w);
    const r = pick('r'); const g = pick('g'); const b = pick('b');
    const has16 = inliers.every((e) => Number.isFinite(Number(e.frame.filmBase.r16)));
    const r16 = has16 ? pick('r16') : Math.round(r * 257);
    const g16 = has16 ? pick('g16') : Math.round(g * 257);
    const b16 = has16 ? pick('b16') : Math.round(b * 257);
    const spread = Math.max(0, ...inliers.map((e) => e.baseDelta || 0));
    result.filmBase = {
      r: Math.round(clamp(r, 1, 255)), g: Math.round(clamp(g, 1, 255)), b: Math.round(clamp(b, 1, 255)),
      r16: Math.round(clamp(r16, 1, 65535)), g16: Math.round(clamp(g16, 1, 65535)), b16: Math.round(clamp(b16, 1, 65535)),
      method: 'roll',
      precision: has16 ? 16 : 8,
      confidence: Number(clamp(0.6 + 0.35 * clamp(1 - spread / baseTolerance, 0, 1), 0, 0.98).toFixed(3)),
      samples: inliers.length,
      spread: Number(spread.toFixed(4))
    };
  }

  const withChannels = inliers.filter((e) => Array.isArray(e.frame.channelData) && e.frame.channelData.length === 3);
  if (withChannels.length) {
    result.channelData = [0, 1, 2].map((ch) => {
      const whites = withChannels.map((e) => Number(e.frame.channelData[ch].whitePointOrigin));
      const blacks = withChannels.map((e) => Number(e.frame.channelData[ch].blackPointOrigin));
      const means = withChannels.map((e) => Number(e.frame.channelData[ch].meanPoint));
      return {
        // Robust roll-wide range: the 20th percentile of the dark ends and the
        // 80th percentile of the bright ends, so one odd frame cannot flatten the roll.
        whitePointOrigin: Math.round(percentile(whites, 0.2)),
        blackPointOrigin: Math.round(percentile(blacks, 0.8)),
        meanPoint: Number(percentile(means, 0.5).toFixed(4)),
        settingName: withChannels[0].frame.channelData[ch].settingName || ['ToneCurvePV2012Red', 'ToneCurvePV2012Green', 'ToneCurvePV2012Blue'][ch]
      };
    });
  }

  const means = inliers.map((e) => Number(e.frame.negativeMean)).filter((v) => Number.isFinite(v) && v > 0);
  const rollMean = means.length ? percentile(means, 0.5) : NaN;
  result.frames = annotated.map((e) => {
    const mean = Number(e.frame.negativeMean);
    // A thinner (brighter) negative is underexposed: the positive needs more exposure.
    const offsetStops = Number.isFinite(mean) && mean > 0 && Number.isFinite(rollMean) && rollMean > 0
      ? Number(clamp(Math.log2(mean / rollMean), -2, 2).toFixed(3))
      : 0;
    return { id: e.frame.id, outlier: e.outlier, reasons: e.reasons, baseDelta: e.baseDelta === null ? null : Number(e.baseDelta.toFixed(4)), offsetStops };
  });
  return result;
}

// --- exposure mapping -----------------------------------------------------------------

// CurveEngine's exposure layer (slider units -300..300): positive values apply
// 1 - (1 - x)^(1 + 0.02e), negative values scale by
// 1 - 0.008u / (1 - 0.02u) up to u = 20 and an exponential tail beyond. This
// inverts the response at mid-grey so an offset in stops maps to slider units.
const TAIL_START = 20;
const TAIL_SCALE = 1 - (0.008 * TAIL_START) / (1 - 0.02 * TAIL_START);
const TAIL_DECAY = (0.008 / Math.pow(1 - 0.02 * TAIL_START, 2)) / TAIL_SCALE;

export function exposureMidGreyResponse(units) {
  if (!units) return 0.5;
  if (units > 0) return 1 - Math.pow(0.5, 1 + units * 0.02);
  const u = -units;
  const scale = u <= TAIL_START ? 1 - (0.008 * u) / (1 - 0.02 * u) : TAIL_SCALE * Math.exp(-TAIL_DECAY * (u - TAIL_START));
  return 0.5 * scale;
}

export function exposureUnitsForStops(stops) {
  const s = clamp(Number(stops) || 0, -2, 0.95);
  if (Math.abs(s) < 1e-4) return 0;
  const target = 0.5 * Math.pow(2, s);
  if (s > 0) {
    const power = Math.log(1 - target) / Math.log(0.5);
    return Math.round(clamp((power - 1) / 0.02, 0, 300));
  }
  let lo = 0; let hi = 300;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (exposureMidGreyResponse(-mid) > target) lo = mid; else hi = mid;
  }
  return -Math.round((lo + hi) / 2);
}

// --- settings -----------------------------------------------------------------------------

function sanitizeChannelData(input) {
  if (!Array.isArray(input) || input.length !== 3) return null;
  const names = ['ToneCurvePV2012Red', 'ToneCurvePV2012Green', 'ToneCurvePV2012Blue'];
  const channels = input.map((ch, i) => {
    if (!ch || typeof ch !== 'object') return null;
    const white = Number(ch.whitePointOrigin); const black = Number(ch.blackPointOrigin); const mean = Number(ch.meanPoint);
    if (![white, black, mean].every(Number.isFinite)) return null;
    return {
      whitePointOrigin: Math.round(clamp(white, 0, 65535)),
      blackPointOrigin: Math.round(clamp(black, 0, 65535)),
      meanPoint: Number(clamp(mean, 0, 1).toFixed(4)),
      settingName: typeof ch.settingName === 'string' ? ch.settingName.slice(0, 40) : names[i]
    };
  });
  return channels.every(Boolean) ? channels : null;
}

// Per-file record persisted as settings.rollFrame.
export function sanitizeRollFrameForSettings(input) {
  if (!input || typeof input !== 'object') return null;
  const channelData = sanitizeChannelData(input.channelData);
  const offset = Number(input.offsetStops);
  const reasons = Array.isArray(input.reasons) ? input.reasons.filter((r) => ROLL_REASONS.includes(r)).slice(0, 4) : [];
  return {
    rollId: typeof input.rollId === 'string' ? input.rollId.slice(0, 40) : null,
    locked: Boolean(input.locked) && channelData !== null,
    channelData,
    offsetStops: Number.isFinite(offset) ? Number(clamp(offset, -3, 3).toFixed(3)) : 0,
    equalize: Boolean(input.equalize),
    outlier: Boolean(input.outlier),
    reasons
  };
}

// A thin (bright) negative inverts to a dark positive, so a positive offset
// (frame brighter than the roll) is brightened in the positive.
export function rollFrameExposureUnits(rollFrame) {
  if (!rollFrame || !rollFrame.equalize || rollFrame.outlier) return 0;
  return exposureUnitsForStops(rollFrame.offsetStops);
}

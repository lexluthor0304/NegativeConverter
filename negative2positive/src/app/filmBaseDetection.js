const DEFAULT_FILM_BASE = Object.freeze({ r: 210, g: 140, b: 90 });
const UINT8_MAX = 255;
const UINT16_MAX = 65535;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function finiteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getSampleSource(imageData) {
  if (!imageData) return null;
  const image16 = imageData.__image16;
  if (
    image16
    && image16.data instanceof Uint16Array
    && image16.width === imageData.width
    && image16.height === imageData.height
  ) {
    return {
      width: image16.width,
      height: image16.height,
      data: image16.data,
      max: UINT16_MAX,
      precision: 16
    };
  }

  if (imageData.data && typeof imageData.data.length === 'number') {
    return {
      width: imageData.width,
      height: imageData.height,
      data: imageData.data,
      max: UINT8_MAX,
      precision: 8
    };
  }

  return null;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const pos = clamp(p, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function trimmedMean(sorted, trim = 0.1) {
  if (sorted.length === 0) return 0;
  const start = Math.min(sorted.length - 1, Math.floor(sorted.length * trim));
  const end = Math.max(start + 1, Math.ceil(sorted.length * (1 - trim)));
  let sum = 0;
  for (let i = start; i < end; i++) sum += sorted[i];
  return sum / (end - start);
}

function to8Bit(value, maxValue) {
  return clamp(Math.round((value / maxValue) * UINT8_MAX), 1, UINT8_MAX);
}

function to16Bit(value, maxValue) {
  return clamp(Math.round((value / maxValue) * UINT16_MAX), 1, UINT16_MAX);
}

function sortNumeric(values) {
  values.sort((a, b) => a - b);
  return values;
}

function summarizeRegion(source, bounds, options = {}) {
  const maxSamples = Math.max(64, Math.round(finiteNumber(options.maxSamples, 18000)));
  const trim = clamp(finiteNumber(options.trim, 0.1), 0, 0.35);
  const width = source.width;
  const data = source.data;
  const regionW = Math.max(1, bounds.endX - bounds.startX + 1);
  const regionH = Math.max(1, bounds.endY - bounds.startY + 1);
  const step = Math.max(1, Math.ceil(Math.sqrt((regionW * regionH) / maxSamples)));

  const rVals = [];
  const gVals = [];
  const bVals = [];
  const lumaVals = [];

  for (let y = bounds.startY; y <= bounds.endY; y += step) {
    for (let x = bounds.startX; x <= bounds.endX; x += step) {
      const idx = (y * width + x) * 4;
      const alpha = data[idx + 3];
      if (alpha === 0) continue;

      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      rVals.push(r);
      gVals.push(g);
      bVals.push(b);
      lumaVals.push(0.299 * r + 0.587 * g + 0.114 * b);
    }
  }

  if (rVals.length === 0) {
    return makeFilmBaseResult(DEFAULT_FILM_BASE.r, DEFAULT_FILM_BASE.g, DEFAULT_FILM_BASE.b, UINT8_MAX, {
      method: options.method || 'fallback',
      precision: 8,
      samples: 0,
      confidence: 0
    });
  }

  sortNumeric(rVals);
  sortNumeric(gVals);
  sortNumeric(bVals);
  sortNumeric(lumaVals);

  const r = trimmedMean(rVals, trim);
  const g = trimmedMean(gVals, trim);
  const b = trimmedMean(bVals, trim);
  const l10 = percentile(lumaVals, 0.1);
  const l90 = percentile(lumaVals, 0.9);
  const spread8 = ((l90 - l10) / source.max) * UINT8_MAX;
  const r8 = to8Bit(r, source.max);
  const g8 = to8Bit(g, source.max);
  const b8 = to8Bit(b, source.max);
  const orangeBias = (r8 - b8) + ((r8 - g8) * 0.5);
  const clipped = percentile(rVals, 0.98) >= source.max * 0.995
    || percentile(gVals, 0.98) >= source.max * 0.995
    || percentile(bVals, 0.98) >= source.max * 0.995;

  const confidence = clamp(
    0.18
      + clamp((orangeBias - 6) / 75, 0, 1) * 0.42
      + clamp(1 - (spread8 / 55), 0, 1) * 0.28
      + clamp(rVals.length / 800, 0, 1) * 0.12
      - (clipped ? 0.22 : 0),
    0,
    0.98
  );

  return makeFilmBaseResult(r, g, b, source.max, {
    method: options.method || 'manual',
    precision: source.precision,
    samples: rVals.length,
    spread: Math.round(spread8),
    orangeBias: Math.round(orangeBias),
    clipped,
    confidence
  });
}

function makeFilmBaseResult(r, g, b, maxValue, meta = {}) {
  const result = {
    r: to8Bit(r, maxValue),
    g: to8Bit(g, maxValue),
    b: to8Bit(b, maxValue),
    r16: to16Bit(r, maxValue),
    g16: to16Bit(g, maxValue),
    b16: to16Bit(b, maxValue)
  };

  if (meta.method) result.method = String(meta.method);
  if (Number.isFinite(meta.precision)) result.precision = meta.precision;
  if (Number.isFinite(meta.samples)) result.samples = Math.max(0, Math.round(meta.samples));
  if (Number.isFinite(meta.spread)) result.spread = Math.max(0, Math.round(meta.spread));
  if (Number.isFinite(meta.orangeBias)) result.orangeBias = Math.round(meta.orangeBias);
  if (typeof meta.clipped === 'boolean') result.clipped = meta.clipped;
  if (Number.isFinite(meta.confidence)) result.confidence = Number(clamp(meta.confidence, 0, 1).toFixed(3));
  if (Number.isFinite(meta.candidates)) result.candidates = Math.max(0, Math.round(meta.candidates));
  if (Number.isFinite(meta.selected)) result.selected = Math.max(0, Math.round(meta.selected));

  return result;
}

function makeRegionBounds(source, x, y, radius) {
  const safeRadius = Math.max(1, Math.round(finiteNumber(radius, 10)));
  return {
    startX: clamp(Math.floor(x - safeRadius), 0, source.width - 1),
    endX: clamp(Math.ceil(x + safeRadius), 0, source.width - 1),
    startY: clamp(Math.floor(y - safeRadius), 0, source.height - 1),
    endY: clamp(Math.ceil(y + safeRadius), 0, source.height - 1)
  };
}

export function sampleFilmBase(imageData, x, y, radius = 10, options = {}) {
  const source = getSampleSource(imageData);
  if (!source) return sanitizeFilmBaseForSettings(null);
  const bounds = makeRegionBounds(source, x, y, radius);
  return summarizeRegion(source, bounds, {
    ...options,
    method: options.method || 'manual'
  });
}

function addEdgeCandidates(candidates, imageData, source, edgeOffset, radius, fractions) {
  const maxX = source.width - 1;
  const maxY = source.height - 1;

  for (const f of fractions) {
    const x = Math.round(maxX * f);
    candidates.push(sampleFilmBase(imageData, x, edgeOffset, radius, { method: 'auto-edge' }));
    candidates.push(sampleFilmBase(imageData, x, maxY - edgeOffset, radius, { method: 'auto-edge' }));
  }

  for (const f of fractions) {
    const y = Math.round(maxY * f);
    candidates.push(sampleFilmBase(imageData, edgeOffset, y, radius, { method: 'auto-edge' }));
    candidates.push(sampleFilmBase(imageData, maxX - edgeOffset, y, radius, { method: 'auto-edge' }));
  }
}

function addInteriorCandidates(candidates, imageData, source, radius) {
  const fractions = [0.18, 0.34, 0.5, 0.66, 0.82];
  const maxX = source.width - 1;
  const maxY = source.height - 1;
  for (const fy of fractions) {
    for (const fx of fractions) {
      candidates.push(sampleFilmBase(
        imageData,
        Math.round(maxX * fx),
        Math.round(maxY * fy),
        radius,
        { method: 'auto-grid', maxSamples: 9000 }
      ));
    }
  }
}

function scoreCandidate(candidate) {
  const brightness = (candidate.r + candidate.g + candidate.b) / 3;
  const orangeBias = finiteNumber(candidate.orangeBias, (candidate.r - candidate.b) + ((candidate.r - candidate.g) * 0.5));
  const spread = finiteNumber(candidate.spread, 45);
  const orderBonus = candidate.r >= candidate.g && candidate.g >= candidate.b ? 12 : -10;
  const clipPenalty = candidate.clipped || candidate.r > 252 || candidate.g > 252 || candidate.b > 252 ? 45 : 0;
  return brightness * 0.18 + orangeBias * 1.45 + orderBonus - spread * 1.15 - clipPenalty;
}

function combineCandidates(candidates, selected, hadEligible) {
  const r16Vals = sortNumeric(selected.map(candidate => candidate.r16));
  const g16Vals = sortNumeric(selected.map(candidate => candidate.g16));
  const b16Vals = sortNumeric(selected.map(candidate => candidate.b16));
  const confidenceVals = selected.map(candidate => finiteNumber(candidate.confidence, 0.35));
  const spreadVals = selected.map(candidate => finiteNumber(candidate.spread, 45));
  const orangeVals = selected.map(candidate => finiteNumber(candidate.orangeBias, 0));

  const r16 = trimmedMean(r16Vals, selected.length >= 5 ? 0.15 : 0);
  const g16 = trimmedMean(g16Vals, selected.length >= 5 ? 0.15 : 0);
  const b16 = trimmedMean(b16Vals, selected.length >= 5 ? 0.15 : 0);
  const avgConfidence = confidenceVals.reduce((sum, value) => sum + value, 0) / confidenceVals.length;
  const avgSpread = spreadVals.reduce((sum, value) => sum + value, 0) / spreadVals.length;
  const avgOrange = orangeVals.reduce((sum, value) => sum + value, 0) / orangeVals.length;
  const consistency = (
    (percentile(r16Vals, 0.9) - percentile(r16Vals, 0.1))
    + (percentile(g16Vals, 0.9) - percentile(g16Vals, 0.1))
    + (percentile(b16Vals, 0.9) - percentile(b16Vals, 0.1))
  ) / UINT16_MAX * UINT8_MAX / 3;

  const confidence = clamp(
    avgConfidence * 0.68
      + clamp(1 - consistency / 35, 0, 1) * 0.18
      + clamp(selected.length / Math.max(6, candidates.length * 0.25), 0, 1) * 0.14
      - (hadEligible ? 0 : 0.22),
    0.02,
    0.98
  );

  return makeFilmBaseResult(r16, g16, b16, UINT16_MAX, {
    method: 'auto',
    precision: 16,
    samples: selected.reduce((sum, candidate) => sum + finiteNumber(candidate.samples, 0), 0),
    spread: avgSpread,
    orangeBias: avgOrange,
    confidence,
    candidates: candidates.length,
    selected: selected.length
  });
}

export function autoDetectFilmBase(imageData, borderBufferPct = 10) {
  const source = getSampleSource(imageData);
  if (!source) return sanitizeFilmBaseForSettings(null);

  const minSide = Math.max(1, Math.min(source.width, source.height));
  const bufferPct = clamp(finiteNumber(borderBufferPct, 10), 0, 30);
  const hasBorderHint = bufferPct > 0.5;
  const edgeBand = Math.max(4, Math.round(minSide * ((hasBorderHint ? bufferPct : 6) / 100)));
  const radius = clamp(Math.round(edgeBand * 0.42), 3, 72);
  const edgeOffset = clamp(Math.round(edgeBand * 0.5), radius, Math.max(radius, Math.floor(minSide / 2)));
  const edgeFractions = hasBorderHint
    ? [0.08, 0.2, 0.34, 0.5, 0.66, 0.8, 0.92]
    : [0.12, 0.28, 0.5, 0.72, 0.88];

  const candidates = [];
  addEdgeCandidates(candidates, imageData, source, edgeOffset, radius, edgeFractions);
  if (!hasBorderHint) {
    addInteriorCandidates(candidates, imageData, source, Math.max(3, Math.round(radius * 0.8)));
  }

  const scored = candidates
    .map(candidate => ({ ...candidate, score: scoreCandidate(candidate) }))
    .sort((a, b) => b.score - a.score);

  const eligible = scored.filter(candidate => (
    candidate.orangeBias >= 7
    && candidate.spread <= 48
    && !candidate.clipped
    && candidate.r >= candidate.g - 6
    && candidate.g >= candidate.b - 10
  ));
  const pool = eligible.length > 0 ? eligible : scored;
  const selectedCount = clamp(Math.max(3, Math.ceil(pool.length * 0.25)), 1, Math.min(9, pool.length));
  const selected = pool.slice(0, selectedCount);

  return combineCandidates(scored, selected, eligible.length > 0);
}

export function sanitizeFilmBaseForSettings(input, fallback = null) {
  const source = (input && typeof input === 'object')
    ? input
    : (fallback && typeof fallback === 'object' ? fallback : DEFAULT_FILM_BASE);

  const r = clamp(Math.round(finiteNumber(source.r, DEFAULT_FILM_BASE.r)), 1, UINT8_MAX);
  const g = clamp(Math.round(finiteNumber(source.g, DEFAULT_FILM_BASE.g)), 1, UINT8_MAX);
  const b = clamp(Math.round(finiteNumber(source.b, DEFAULT_FILM_BASE.b)), 1, UINT8_MAX);
  const result = {
    r,
    g,
    b,
    r16: clamp(Math.round(finiteNumber(source.r16, r * 257)), 1, UINT16_MAX),
    g16: clamp(Math.round(finiteNumber(source.g16, g * 257)), 1, UINT16_MAX),
    b16: clamp(Math.round(finiteNumber(source.b16, b * 257)), 1, UINT16_MAX)
  };

  const confidence = finiteNumber(source.confidence, NaN);
  if (Number.isFinite(confidence)) result.confidence = Number(clamp(confidence, 0, 1).toFixed(3));

  for (const key of ['samples', 'spread', 'orangeBias', 'candidates', 'selected', 'precision']) {
    const value = finiteNumber(source[key], NaN);
    if (Number.isFinite(value)) result[key] = Math.max(0, Math.round(value));
  }

  if (typeof source.clipped === 'boolean') result.clipped = source.clipped;
  if (source.method) result.method = String(source.method).slice(0, 32);

  return result;
}

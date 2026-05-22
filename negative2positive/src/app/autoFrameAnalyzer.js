import { resizeImageDataToMaxSide } from './imageDataOps.js';

const DEFAULT_FORMAT_RATIOS = {
  '135': 1.5,
  '120-6x4.5': 1.33,
  '120-6x6': 1,
  '120-6x7': 1.17,
  '120-6x9': 1.5
};

const DEFAULT_120_FORMATS = ['6x4.5', '6x6', '6x7', '6x9'];

const DEFAULT_SCORE_WEIGHTS = {
  area: 0.18,
  rectangularity: 0.20,
  orthogonality: 0.14,
  parallelism: 0.10,
  edgeSupport: 0.18,
  centerPrior: 0.08,
  aspect: 0.12
};

const DENSITY_TEMPLATE_MAX_PIXELS = 2_700_000;
const DENSITY_TEMPLATE_SCALE_FACTORS = [0.98, 0.94, 0.90, 0.84, 0.78, 0.70, 0.62];
const DENSITY_TEMPLATE_OFFSETS = [-0.055, -0.025, 0, 0.025, 0.055];

function clampBetween(v, min, max) {
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function normalizeAngleDegrees(angle) {
  let normalized = Number.isFinite(angle) ? angle : 0;
  while (normalized > 180) normalized -= 360;
  while (normalized <= -180) normalized += 360;
  return normalized;
}

function sanitizeCropRegionForImage(cropRegion, imageData) {
  if (!cropRegion || !imageData) return null;
  const imageWidth = Number(imageData.width);
  const imageHeight = Number(imageData.height);
  if (!Number.isFinite(imageWidth) || !Number.isFinite(imageHeight) || imageWidth < 1 || imageHeight < 1) {
    return null;
  }

  const leftRaw = Number(cropRegion.left);
  const topRaw = Number(cropRegion.top);
  const widthRaw = Number(cropRegion.width);
  const heightRaw = Number(cropRegion.height);
  if (!Number.isFinite(leftRaw) || !Number.isFinite(topRaw) || !Number.isFinite(widthRaw) || !Number.isFinite(heightRaw)) {
    return null;
  }

  const left = clampBetween(Math.floor(leftRaw), 0, imageWidth - 1);
  const top = clampBetween(Math.floor(topRaw), 0, imageHeight - 1);
  const maxWidth = imageWidth - left;
  const maxHeight = imageHeight - top;
  if (maxWidth < 1 || maxHeight < 1) return null;

  const width = clampBetween(Math.floor(widthRaw), 1, maxWidth);
  const height = clampBetween(Math.floor(heightRaw), 1, maxHeight);
  if (width < 1 || height < 1) return null;

  return { left, top, width, height };
}

function getAnalyzerContext(options = {}) {
  return {
    settings: options.settings || {},
    maxSide: Number.isFinite(options.maxSide) ? options.maxSide : 1600,
    formatRatios: options.formatRatios || DEFAULT_FORMAT_RATIOS,
    default120Formats: options.default120Formats || DEFAULT_120_FORMATS,
    scoreWeights: options.scoreWeights || DEFAULT_SCORE_WEIGHTS,
    rotateImageData: typeof options.rotateImageData === 'function' ? options.rotateImageData : null,
    sanitizeCropRegion: typeof options.sanitizeCropRegion === 'function'
      ? options.sanitizeCropRegion
      : sanitizeCropRegionForImage
  };
}

function getAutoFrameAspectTargets(context) {
  const { settings, default120Formats, formatRatios } = context;
  const pref = settings && settings.formatPreference ? settings.formatPreference : 'auto';
  const allowed120Map = (settings && settings.allowed120Formats) || {};
  const enabled120 = default120Formats.filter(fmt => allowed120Map[fmt] !== false);
  const safe120 = enabled120.length ? enabled120 : ['6x6'];

  const targets = [];
  const addTarget = (key, weight = 1) => {
    const ratio = formatRatios[key];
    if (!Number.isFinite(ratio)) return;
    targets.push({ key, ratio, weight: clampBetween(weight, 0.4, 1.2) });
  };

  if (pref === '135') {
    addTarget('135', 1.05);
    safe120.forEach(fmt => addTarget(`120-${fmt}`, 0.78));
  } else if (pref === '120') {
    safe120.forEach(fmt => addTarget(`120-${fmt}`, 1.05));
    addTarget('135', 0.78);
  } else {
    addTarget('135', 1);
    safe120.forEach(fmt => addTarget(`120-${fmt}`, 1));
  }
  return targets.length ? targets : [{ key: '135', ratio: 1.5, weight: 1 }];
}

function scoreAspectAgainstTargets(ratio, targets) {
  const safeRatio = Math.max(0.01, Number(ratio) || 1);
  let best = { score: 0, format: 'unknown' };
  targets.forEach(target => {
    const delta = Math.abs(safeRatio - target.ratio) / target.ratio;
    const normalized = 1 - clampBetween(delta / 0.45, 0, 1);
    const weighted = clampBetween(normalized * target.weight, 0, 1);
    if (weighted > best.score) {
      best = { score: weighted, format: target.key };
    }
  });
  return best;
}

function sanitizeBound(bound, imageWidth, imageHeight) {
  if (!bound) return null;
  const left = clampBetween(Math.floor(Number(bound.x) || 0), 0, imageWidth - 1);
  const top = clampBetween(Math.floor(Number(bound.y) || 0), 0, imageHeight - 1);
  const maxWidth = imageWidth - left;
  const maxHeight = imageHeight - top;
  if (maxWidth < 1 || maxHeight < 1) return null;
  const width = clampBetween(Math.floor(Number(bound.width) || 0), 1, maxWidth);
  const height = clampBetween(Math.floor(Number(bound.height) || 0), 1, maxHeight);
  if (width < 1 || height < 1) return null;
  return { x: left, y: top, width, height };
}

function orderPointsClockwise(points) {
  if (!Array.isArray(points) || points.length !== 4) return [];
  const center = points.reduce((acc, p) => {
    acc.x += p.x;
    acc.y += p.y;
    return acc;
  }, { x: 0, y: 0 });
  center.x /= points.length;
  center.y /= points.length;
  return [...points].sort((a, b) => {
    const angleA = Math.atan2(a.y - center.y, a.x - center.x);
    const angleB = Math.atan2(b.y - center.y, b.x - center.x);
    return angleA - angleB;
  });
}

function computeOrthogonality(points) {
  if (!Array.isArray(points) || points.length !== 4) return 0.65;
  const ordered = orderPointsClockwise(points);
  if (ordered.length !== 4) return 0.65;

  let deviationSum = 0;
  for (let i = 0; i < 4; i++) {
    const prev = ordered[(i + 3) % 4];
    const curr = ordered[i];
    const next = ordered[(i + 1) % 4];
    const v1x = prev.x - curr.x;
    const v1y = prev.y - curr.y;
    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;
    const len1 = Math.hypot(v1x, v1y);
    const len2 = Math.hypot(v2x, v2y);
    if (len1 < 0.001 || len2 < 0.001) {
      deviationSum += 45;
      continue;
    }
    const cosTheta = clampBetween((v1x * v2x + v1y * v2y) / (len1 * len2), -1, 1);
    const angle = Math.acos(cosTheta) * 180 / Math.PI;
    deviationSum += Math.abs(90 - angle);
  }
  const avgDeviation = deviationSum / 4;
  return 1 - clampBetween(avgDeviation / 30, 0, 1);
}

function computeParallelism(points) {
  if (!Array.isArray(points) || points.length !== 4) return 0.65;
  const ordered = orderPointsClockwise(points);
  if (ordered.length !== 4) return 0.65;

  const edges = [];
  for (let i = 0; i < 4; i++) {
    const p1 = ordered[i];
    const p2 = ordered[(i + 1) % 4];
    let orientation = Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180 / Math.PI;
    if (orientation < 0) orientation += 180;
    edges.push(orientation);
  }

  const pairDelta = (a, b) => {
    let delta = Math.abs(a - b);
    if (delta > 90) delta = 180 - delta;
    return delta;
  };

  const dev1 = pairDelta(edges[0], edges[2]);
  const dev2 = pairDelta(edges[1], edges[3]);
  const avgDeviation = (dev1 + dev2) / 2;
  return 1 - clampBetween(avgDeviation / 20, 0, 1);
}

function extractApproxPoints(approxMat) {
  if (!approxMat || !approxMat.data32S) return [];
  const data = approxMat.data32S;
  const points = [];
  for (let i = 0; i + 1 < data.length; i += 2) {
    points.push({ x: data[i], y: data[i + 1] });
  }
  return points;
}

function edgePixelAt(mat, x, y) {
  if (!mat || !Number.isFinite(x) || !Number.isFinite(y)) return 0;
  const safeX = clampBetween(Math.round(x), 0, mat.cols - 1);
  const safeY = clampBetween(Math.round(y), 0, mat.rows - 1);
  return mat.ucharPtr(safeY, safeX)[0] > 0 ? 1 : 0;
}

function computeEdgeSupport(edges, bound) {
  if (!edges || !bound) return 0;
  const left = bound.x;
  const right = bound.x + bound.width - 1;
  const top = bound.y;
  const bottom = bound.y + bound.height - 1;
  if (right <= left || bottom <= top) return 0;

  const step = Math.max(1, Math.round(Math.min(bound.width, bound.height) / 120));
  let hits = 0;
  let total = 0;

  for (let x = left; x <= right; x += step) {
    hits += edgePixelAt(edges, x, top);
    hits += edgePixelAt(edges, x, bottom);
    total += 2;
  }
  for (let y = top; y <= bottom; y += step) {
    hits += edgePixelAt(edges, left, y);
    hits += edgePixelAt(edges, right, y);
    total += 2;
  }

  return total > 0 ? clampBetween(hits / total, 0, 1) : 0;
}

function getRegionMean(integral, stride, x, y, width, height) {
  if (!integral || width <= 0 || height <= 0) return 0;
  const maxY = Math.max(0, Math.floor(integral.length / stride) - 1);
  const x1 = clampBetween(Math.round(x), 0, stride - 1);
  const y1 = clampBetween(Math.round(y), 0, maxY);
  const x2 = clampBetween(Math.round(x + width), x1, stride - 1);
  const y2 = clampBetween(Math.round(y + height), y1, maxY);
  const area = Math.max(1, (x2 - x1) * (y2 - y1));
  const idxA = y1 * stride + x1;
  const idxB = y1 * stride + x2;
  const idxC = y2 * stride + x1;
  const idxD = y2 * stride + x2;
  return (integral[idxD] - integral[idxB] - integral[idxC] + integral[idxA]) / area;
}

function addIntegralSample(integral, stride, x, y, rowSum, value, above) {
  rowSum += value;
  integral[(y + 1) * stride + (x + 1)] = above + rowSum;
  return rowSum;
}

function buildDensityAnalysis(imageData) {
  if (!imageData) return null;
  const width = imageData.width;
  const height = imageData.height;
  const totalPixels = width * height;
  if (totalPixels < 16 || totalPixels > DENSITY_TEMPLATE_MAX_PIXELS) return null;

  const stride = width + 1;
  const luma = new Uint8ClampedArray(totalPixels);
  const lumaIntegral = new Float32Array((width + 1) * (height + 1));
  const edgeIntegral = new Float32Array((width + 1) * (height + 1));
  const chromaIntegral = new Float32Array((width + 1) * (height + 1));
  const rowEdge = new Float32Array(height);
  const colEdge = new Float32Array(width);
  const { data } = imageData;

  let chromaSum = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    luma[p] = Math.round((r * 0.299) + (g * 0.587) + (b * 0.114));
    chromaSum += Math.max(r, g, b) - Math.min(r, g, b);
  }

  for (let y = 0; y < height; y++) {
    let rowLumaSum = 0;
    let rowEdgeSum = 0;
    let rowChromaSum = 0;
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const v = luma[idx];
      const left = x > 0 ? luma[idx - 1] : v;
      const up = y > 0 ? luma[idx - width] : v;
      const edge = Math.min(255, Math.abs(v - left) + Math.abs(v - up));
      const chromaIdx = idx * 4;
      const r = data[chromaIdx];
      const g = data[chromaIdx + 1];
      const b = data[chromaIdx + 2];
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      const aboveIdx = y * stride + (x + 1);

      rowLumaSum = addIntegralSample(lumaIntegral, stride, x, y, rowLumaSum, v, lumaIntegral[aboveIdx]);
      rowEdgeSum = addIntegralSample(edgeIntegral, stride, x, y, rowEdgeSum, edge, edgeIntegral[aboveIdx]);
      rowChromaSum = addIntegralSample(chromaIntegral, stride, x, y, rowChromaSum, chroma, chromaIntegral[aboveIdx]);
      rowEdge[y] += edge;
      colEdge[x] += edge;
    }
  }

  for (let y = 0; y < height; y++) rowEdge[y] /= Math.max(1, width);
  for (let x = 0; x < width; x++) colEdge[x] /= Math.max(1, height);

  return {
    width,
    height,
    stride,
    lumaIntegral,
    edgeIntegral,
    chromaIntegral,
    rowEdge,
    colEdge,
    globalChroma: chromaSum / Math.max(1, totalPixels)
  };
}

function inferFrameMaterialMode(context, analysis) {
  const filmType = String((context.settings && (context.settings.filmType || context.settings.sourceFilmType)) || 'color');
  const positiveMode = filmType === 'positive' || filmType === 'slide' || filmType === 'bwPositive';
  const bwMode = filmType === 'bw' || filmType === 'blackWhite' || filmType === 'bwNegative' || filmType === 'bwPositive';
  const lowChroma = analysis ? analysis.globalChroma < 18 : false;

  if (filmType === 'bwPositive') return 'bw-positive';
  if (bwMode) return positiveMode ? 'bw-positive' : 'bw-negative';
  if (filmType === 'color' || filmType === 'colorNegative') return 'color-negative';
  if (filmType === 'colorPositive') return 'color-positive';
  if (positiveMode) return lowChroma ? 'bw-positive' : 'color-positive';
  return lowChroma ? 'bw-negative' : 'color-negative';
}

function getFrameModeScoringProfile(mode) {
  switch (mode) {
    case 'color-positive':
      return { edgeWeight: 0.29, contrastWeight: 0.25, chromaWeight: 0.09, outsideWeight: 0.10 };
    case 'bw-negative':
      return { edgeWeight: 0.34, contrastWeight: 0.27, chromaWeight: 0.00, outsideWeight: 0.12 };
    case 'bw-positive':
      return { edgeWeight: 0.36, contrastWeight: 0.29, chromaWeight: 0.00, outsideWeight: 0.10 };
    case 'color-negative':
    default:
      return { edgeWeight: 0.30, contrastWeight: 0.24, chromaWeight: 0.06, outsideWeight: 0.12 };
  }
}

function computeBandStats(rect, analysis) {
  const minSide = Math.max(1, Math.min(rect.width, rect.height));
  const band = clampBetween(Math.round(minSide * 0.045), 4, 42);
  const outer = clampBetween(Math.round(minSide * 0.06), 5, 56);
  const left = rect.x;
  const top = rect.y;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  const stride = analysis.stride;

  const insideBands = [
    { x: left, y: top, width: rect.width, height: band },
    { x: left, y: bottom - band, width: rect.width, height: band },
    { x: left, y: top, width: band, height: rect.height },
    { x: right - band, y: top, width: band, height: rect.height }
  ];
  const outsideBands = [
    { x: left, y: top - outer, width: rect.width, height: outer },
    { x: left, y: bottom, width: rect.width, height: outer },
    { x: left - outer, y: top, width: outer, height: rect.height },
    { x: right, y: top, width: outer, height: rect.height }
  ].filter(b => b.x >= 0 && b.y >= 0 && b.x + b.width <= analysis.width && b.y + b.height <= analysis.height);

  const meanFor = (integral, bands) => {
    if (!bands.length) return 0;
    let weighted = 0;
    let area = 0;
    bands.forEach(b => {
      const a = Math.max(1, b.width * b.height);
      weighted += getRegionMean(integral, stride, b.x, b.y, b.width, b.height) * a;
      area += a;
    });
    return weighted / Math.max(1, area);
  };

  return {
    innerLuma: meanFor(analysis.lumaIntegral, insideBands),
    outerLuma: meanFor(analysis.lumaIntegral, outsideBands),
    innerEdge: meanFor(analysis.edgeIntegral, insideBands),
    outerEdge: meanFor(analysis.edgeIntegral, outsideBands),
    innerChroma: meanFor(analysis.chromaIntegral, insideBands),
    outerChroma: meanFor(analysis.chromaIntegral, outsideBands),
    outsideBandCount: outsideBands.length
  };
}

function scoreSprocketLaneSupport(analysis, rect) {
  if (!analysis || !rect) return 0;
  const { width, height } = analysis;
  const crop = sanitizeBound(rect, width, height);
  if (!crop) return 0;

  const shortSide = Math.max(1, Math.min(crop.width, crop.height));
  const laneDepth = clampBetween(Math.round(shortSide * 0.16), 5, 56);
  const minLane = Math.max(4, Math.round(shortSide * 0.045));

  if (crop.width >= crop.height) {
    const topHeight = Math.min(laneDepth, crop.y);
    const bottomHeight = Math.min(laneDepth, height - (crop.y + crop.height));
    if (topHeight < minLane || bottomHeight < minLane) return 0;

    const top = getRegionMean(analysis.edgeIntegral, analysis.stride, crop.x, crop.y - topHeight, crop.width, topHeight);
    const bottom = getRegionMean(analysis.edgeIntegral, analysis.stride, crop.x, crop.y + crop.height, crop.width, bottomHeight);
    const center = getRegionMean(
      analysis.edgeIntegral,
      analysis.stride,
      crop.x + crop.width * 0.10,
      crop.y + crop.height * 0.28,
      crop.width * 0.80,
      crop.height * 0.44
    );
    const balance = 1 - clampBetween(Math.abs(top - bottom) / Math.max(1, Math.max(top, bottom)), 0, 1);
    return clampBetween(((top + bottom) * 0.5 - center * 0.52) / 18, 0, 1) * balance;
  }

  const leftWidth = Math.min(laneDepth, crop.x);
  const rightWidth = Math.min(laneDepth, width - (crop.x + crop.width));
  if (leftWidth < minLane || rightWidth < minLane) return 0;

  const left = getRegionMean(analysis.edgeIntegral, analysis.stride, crop.x - leftWidth, crop.y, leftWidth, crop.height);
  const right = getRegionMean(analysis.edgeIntegral, analysis.stride, crop.x + crop.width, crop.y, rightWidth, crop.height);
  const center = getRegionMean(
    analysis.edgeIntegral,
    analysis.stride,
    crop.x + crop.width * 0.28,
    crop.y + crop.height * 0.10,
    crop.width * 0.44,
    crop.height * 0.80
  );
  const balance = 1 - clampBetween(Math.abs(left - right) / Math.max(1, Math.max(left, right)), 0, 1);
  return clampBetween(((left + right) * 0.5 - center * 0.52) / 18, 0, 1) * balance;
}

function scoreDensityRect(rect, target, analysis, context, options = {}) {
  if (!rect || !target || !analysis) return null;
  const crop = sanitizeBound(rect, analysis.width, analysis.height);
  if (!crop) return null;

  const imageArea = Math.max(1, analysis.width * analysis.height);
  const areaRatio = (crop.width * crop.height) / imageArea;
  if (areaRatio < 0.12 || areaRatio > 0.965) return null;

  const ratio = Math.max(crop.width, crop.height) / Math.max(1, Math.min(crop.width, crop.height));
  const aspectDelta = Math.abs(ratio - target.ratio) / target.ratio;
  const aspectScore = 1 - clampBetween(aspectDelta / 0.24, 0, 1);
  if (aspectScore <= 0) return null;

  const bandStats = computeBandStats(crop, analysis);
  const boundaryCompleteness = clampBetween(bandStats.outsideBandCount / 4, 0, 1);
  if (boundaryCompleteness < 0.5) return null;

  const frameMode = inferFrameMaterialMode(context, analysis);
  const profile = getFrameModeScoringProfile(frameMode);
  const insideEdge = getRegionMean(
    analysis.edgeIntegral,
    analysis.stride,
    crop.x + crop.width * 0.08,
    crop.y + crop.height * 0.08,
    crop.width * 0.84,
    crop.height * 0.84
  );
  const outsideEdge = bandStats.outerEdge;
  const contentTexture = clampBetween((insideEdge - outsideEdge * 0.72) / 24, 0, 1) * boundaryCompleteness;
  const boundaryEdgeContrast = clampBetween(Math.abs(bandStats.innerEdge - bandStats.outerEdge) / 18, 0, 1) * boundaryCompleteness;
  const edgeDelta = Math.max(contentTexture, boundaryEdgeContrast * 0.72);
  const borderContrast = clampBetween(Math.abs(bandStats.innerLuma - bandStats.outerLuma) / 34, 0, 1) * boundaryCompleteness;
  const chromaContrast = profile.chromaWeight > 0
    ? clampBetween(Math.abs(bandStats.innerChroma - bandStats.outerChroma) / 22, 0, 1) * boundaryCompleteness
    : 0;
  const outsideClean = clampBetween(1 - (outsideEdge / Math.max(12, insideEdge + 1)), 0, 1) * boundaryCompleteness;
  const centerX = crop.x + crop.width / 2;
  const centerY = crop.y + crop.height / 2;
  const centerDist = Math.hypot(centerX - analysis.width / 2, centerY - analysis.height / 2);
  const centerPrior = 1 - clampBetween(centerDist / (Math.hypot(analysis.width, analysis.height) * 0.34), 0, 1);
  const areaScore = 1 - clampBetween(Math.abs(areaRatio - 0.62) / 0.48, 0, 1);
  const laneScore = options.sprocket
    ? scoreSprocketLaneSupport(analysis, crop)
    : 0;

  const score = clampBetween(
    (aspectScore * 0.19) +
    (edgeDelta * profile.edgeWeight) +
    (borderContrast * profile.contrastWeight) +
    (chromaContrast * profile.chromaWeight) +
    (outsideClean * profile.outsideWeight) +
    (centerPrior * 0.10) +
    (areaScore * 0.08) +
    (laneScore * 0.08),
    0,
    1
  );

  if (score < 0.34) return null;

  return {
    method: options.sprocket ? 'density-sprocket-template' : 'density-template',
    area: crop.width * crop.height,
    bound: crop,
    cropRegion: { left: crop.x, top: crop.y, width: crop.width, height: crop.height },
    minRectWidth: crop.width,
    minRectHeight: crop.height,
    minRectAngle: 0,
    points: [
      { x: crop.x, y: crop.y },
      { x: crop.x + crop.width, y: crop.y },
      { x: crop.x + crop.width, y: crop.y + crop.height },
      { x: crop.x, y: crop.y + crop.height }
    ],
    score,
    areaRatio,
    detectedFormat: target.key,
    frameMode,
    scoreBreakdown: {
      area: Number(areaScore.toFixed(3)),
      rectangularity: 1,
      orthogonality: 1,
      parallelism: 1,
      edgeSupport: Number(Math.max(edgeDelta, borderContrast).toFixed(3)),
      centerPrior: Number(centerPrior.toFixed(3)),
      aspect: Number(aspectScore.toFixed(3)),
      borderContrast: Number(borderContrast.toFixed(3)),
      boundaryCompleteness: Number(boundaryCompleteness.toFixed(3)),
      boundaryEdgeContrast: Number(boundaryEdgeContrast.toFixed(3)),
      contentTexture: Number(contentTexture.toFixed(3)),
      outsideClean: Number(outsideClean.toFixed(3)),
      chromaContrast: Number(chromaContrast.toFixed(3)),
      sprocketLane: Number(laneScore.toFixed(3)),
      frameMode
    },
    minRect: {
      angle: 0,
      width: crop.width,
      height: crop.height
    }
  };
}

function pushDensityRectCandidate(candidates, rect, target, analysis, context, options = {}) {
  const scored = scoreDensityRect(rect, target, analysis, context, options);
  if (scored) candidates.push(scored);
}

function buildDensityTemplateCandidates(imageData, context) {
  const analysis = buildDensityAnalysis(imageData);
  if (!analysis) return [];

  const aspectTargets = getAutoFrameAspectTargets(context);
  const candidates = [];
  const maxW = analysis.width * 0.985;
  const maxH = analysis.height * 0.985;
  const centerX = analysis.width / 2;
  const centerY = analysis.height / 2;

  aspectTargets.forEach((target) => {
    const orientations = [
      { ratio: target.ratio, portrait: false },
      { ratio: 1 / target.ratio, portrait: true }
    ];

    orientations.forEach((orientation) => {
      const ratio = orientation.ratio;
      const fitW = ratio >= 1 ? Math.min(maxW, maxH * ratio) : Math.min(maxW, maxH * ratio);
      const fitH = ratio >= 1 ? fitW / ratio : Math.min(maxH, fitW / ratio);
      if (fitW < analysis.width * 0.22 || fitH < analysis.height * 0.22) return;

      DENSITY_TEMPLATE_SCALE_FACTORS.forEach((scale) => {
        const width = fitW * scale;
        const height = fitH * scale;
        if (width < analysis.width * 0.22 || height < analysis.height * 0.22) return;
        DENSITY_TEMPLATE_OFFSETS.forEach((offsetX) => {
          DENSITY_TEMPLATE_OFFSETS.forEach((offsetY) => {
            const x = centerX - width / 2 + (analysis.width * offsetX);
            const y = centerY - height / 2 + (analysis.height * offsetY);
            pushDensityRectCandidate(candidates, { x, y, width, height }, target, analysis, context);
          });
        });
      });

      if (target.key === '135') {
        const shortRatios = [0.58, 0.64, 0.70, 0.76];
        shortRatios.forEach((shortRatio) => {
          const landscape = !orientation.portrait;
          const shortSide = (landscape ? analysis.height : analysis.width) * shortRatio;
          const width = landscape ? shortSide * target.ratio : shortSide;
          const height = landscape ? shortSide : shortSide * target.ratio;
          if (width > maxW || height > maxH) return;
          DENSITY_TEMPLATE_OFFSETS.forEach((offsetX) => {
            DENSITY_TEMPLATE_OFFSETS.forEach((offsetY) => {
              const x = centerX - width / 2 + (analysis.width * offsetX);
              const y = centerY - height / 2 + (analysis.height * offsetY);
              pushDensityRectCandidate(candidates, { x, y, width, height }, target, analysis, context, { sprocket: true });
            });
          });
        });
      }
    });
  });

  const seen = new Set();
  return candidates
    .sort((a, b) => b.score - a.score)
    .filter((candidate) => {
      const key = [
        candidate.detectedFormat,
        Math.round(candidate.bound.x / 4),
        Math.round(candidate.bound.y / 4),
        Math.round(candidate.bound.width / 4),
        Math.round(candidate.bound.height / 4)
      ].join(':');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 18);
}

function scoreFrameCandidate(candidate, context) {
  if (!candidate || !context) return null;
  const { imageWidth, imageHeight, imageArea, edges, aspectTargets, scoreWeights } = context;
  const bound = sanitizeBound(candidate.bound, imageWidth, imageHeight);
  if (!bound) return null;

  const area = Math.max(1, Number(candidate.area) || (bound.width * bound.height));
  const areaRatio = area / imageArea;
  const rectWidth = Math.max(1, Number(candidate.minRectWidth) || bound.width);
  const rectHeight = Math.max(1, Number(candidate.minRectHeight) || bound.height);
  const rectArea = Math.max(1, rectWidth * rectHeight);
  const rectangularity = clampBetween(area / rectArea, 0, 1);

  const areaCoverage = clampBetween(areaRatio / 0.88, 0, 1);
  const overshootPenalty = areaRatio > 0.97 ? clampBetween((areaRatio - 0.97) / 0.03, 0, 1) * 0.35 : 0;
  const areaScore = clampBetween(areaCoverage - overshootPenalty, 0, 1);

  const points = Array.isArray(candidate.points) ? candidate.points : [];
  const orthogonality = clampBetween(Number(candidate.orthogonalityHint), 0, 1) || computeOrthogonality(points);
  const parallelism = clampBetween(Number(candidate.parallelismHint), 0, 1) || computeParallelism(points);
  const edgeSupport = computeEdgeSupport(edges, bound);

  const centerX = bound.x + (bound.width / 2);
  const centerY = bound.y + (bound.height / 2);
  const centerDist = Math.hypot(centerX - (imageWidth / 2), centerY - (imageHeight / 2));
  const centerPrior = 1 - clampBetween(centerDist / (Math.hypot(imageWidth, imageHeight) * 0.45), 0, 1);

  const ratio = Math.max(rectWidth, rectHeight) / Math.max(1, Math.min(rectWidth, rectHeight));
  const aspect = scoreAspectAgainstTargets(ratio, aspectTargets);

  const score = (
    areaScore * scoreWeights.area +
    rectangularity * scoreWeights.rectangularity +
    orthogonality * scoreWeights.orthogonality +
    parallelism * scoreWeights.parallelism +
    edgeSupport * scoreWeights.edgeSupport +
    centerPrior * scoreWeights.centerPrior +
    aspect.score * scoreWeights.aspect
  );

  return {
    ...candidate,
    bound,
    score: clampBetween(score, 0, 1),
    areaRatio,
    detectedFormat: aspect.format,
    scoreBreakdown: {
      area: Number(areaScore.toFixed(3)),
      rectangularity: Number(rectangularity.toFixed(3)),
      orthogonality: Number(orthogonality.toFixed(3)),
      parallelism: Number(parallelism.toFixed(3)),
      edgeSupport: Number(edgeSupport.toFixed(3)),
      centerPrior: Number(centerPrior.toFixed(3)),
      aspect: Number(aspect.score.toFixed(3))
    },
    minRect: {
      angle: Number(candidate.minRectAngle) || 0,
      width: rectWidth,
      height: rectHeight
    }
  };
}

function buildHoughCandidate(edges, imageWidth, imageHeight) {
  if (!window.cv.HoughLinesP) return null;
  const lines = new window.cv.Mat();
  try {
    const minDim = Math.min(imageWidth, imageHeight);
    window.cv.HoughLinesP(
      edges,
      lines,
      1,
      Math.PI / 180,
      70,
      Math.max(40, Math.round(minDim * 0.25)),
      Math.max(8, Math.round(minDim * 0.02))
    );

    if (!lines.rows || !lines.data32S) return null;
    const data = lines.data32S;
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    let hCount = 0;
    let vCount = 0;

    for (let i = 0; i < lines.rows; i++) {
      const idx = i * 4;
      const x1 = data[idx];
      const y1 = data[idx + 1];
      const x2 = data[idx + 2];
      const y2 = data[idx + 3];
      const dx = x2 - x1;
      const dy = y2 - y1;
      const length = Math.hypot(dx, dy);
      if (length < minDim * 0.18) continue;

      let angle = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI);
      if (angle > 90) angle = 180 - angle;

      if (angle <= 16) {
        hCount++;
      } else if (angle >= 74) {
        vCount++;
      } else {
        continue;
      }

      left = Math.min(left, x1, x2);
      right = Math.max(right, x1, x2);
      top = Math.min(top, y1, y2);
      bottom = Math.max(bottom, y1, y2);
    }

    if (hCount < 2 || vCount < 2) return null;
    if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(right) || !Number.isFinite(bottom)) {
      return null;
    }

    const margin = Math.round(minDim * 0.006);
    const bound = sanitizeBound({
      x: left - margin,
      y: top - margin,
      width: (right - left) + margin * 2,
      height: (bottom - top) + margin * 2
    }, imageWidth, imageHeight);
    if (!bound) return null;

    return {
      method: 'hough',
      area: bound.width * bound.height,
      bound,
      minRectWidth: bound.width,
      minRectHeight: bound.height,
      minRectAngle: 0,
      points: [
        { x: bound.x, y: bound.y },
        { x: bound.x + bound.width, y: bound.y },
        { x: bound.x + bound.width, y: bound.y + bound.height },
        { x: bound.x, y: bound.y + bound.height }
      ],
      orthogonalityHint: 1,
      parallelismHint: 1
    };
  } catch (err) {
    console.warn('Hough candidate failed:', err);
    return null;
  } finally {
    lines.delete();
  }
}

function detectFrameCandidatesWithCv(imageData, context, options = {}) {
  if (!(window.cv && window.cv.Mat) || !imageData) return [];

  const minAreaRatio = Number.isFinite(options.minAreaRatio) ? options.minAreaRatio : 0.05;
  const retrievalMode = options.retrievalMode === 'external' ? window.cv.RETR_EXTERNAL : window.cv.RETR_LIST;
  const aspectTargets = getAutoFrameAspectTargets(context);
  const src = window.cv.matFromImageData(imageData);
  const imageWidth = src.cols;
  const imageHeight = src.rows;
  const imageArea = Math.max(1, imageWidth * imageHeight);

  let gray = null;
  let claheEnhanced = null;
  let topHat = null;
  let blackHat = null;
  let merged = null;
  let blurred = null;
  let edges = null;
  let kernel3 = null;
  let kernel7 = null;
  let contours = null;
  let hierarchy = null;

  try {
    gray = new window.cv.Mat();
    claheEnhanced = new window.cv.Mat();
    topHat = new window.cv.Mat();
    blackHat = new window.cv.Mat();
    merged = new window.cv.Mat();
    blurred = new window.cv.Mat();
    edges = new window.cv.Mat();
    kernel3 = window.cv.getStructuringElement(window.cv.MORPH_RECT, new window.cv.Size(3, 3));
    kernel7 = window.cv.getStructuringElement(window.cv.MORPH_RECT, new window.cv.Size(7, 7));
    contours = new window.cv.MatVector();
    hierarchy = new window.cv.Mat();

    window.cv.cvtColor(src, gray, window.cv.COLOR_RGBA2GRAY);
    let claheApplied = false;
    let clahe = null;
    try {
      if (window.cv.createCLAHE && typeof window.cv.createCLAHE === 'function') {
        clahe = window.cv.createCLAHE(2.0, new window.cv.Size(8, 8));
      } else if (window.cv.CLAHE && typeof window.cv.CLAHE === 'function') {
        clahe = new window.cv.CLAHE(2.0, new window.cv.Size(8, 8));
      }
      if (clahe && typeof clahe.apply === 'function') {
        clahe.apply(gray, claheEnhanced);
        claheApplied = true;
      }
    } catch (err) {
      claheApplied = false;
    } finally {
      if (clahe && typeof clahe.delete === 'function') {
        clahe.delete();
      }
    }
    if (!claheApplied) {
      window.cv.equalizeHist(gray, claheEnhanced);
    }
    window.cv.morphologyEx(claheEnhanced, topHat, window.cv.MORPH_TOPHAT, kernel7);
    window.cv.morphologyEx(claheEnhanced, blackHat, window.cv.MORPH_BLACKHAT, kernel7);
    window.cv.addWeighted(claheEnhanced, 1.0, topHat, 0.7, 0, merged);
    window.cv.addWeighted(merged, 1.0, blackHat, -0.45, 0, merged);
    window.cv.GaussianBlur(merged, blurred, new window.cv.Size(5, 5), 0, 0, window.cv.BORDER_DEFAULT);
    window.cv.Canny(blurred, edges, 40, 140, 3, false);
    window.cv.dilate(edges, edges, kernel3, new window.cv.Point(-1, -1), 1);

    const candidates = [];
    window.cv.findContours(edges, contours, hierarchy, retrievalMode, window.cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      let approx = null;
      try {
        const area = Math.abs(window.cv.contourArea(contour));
        if (area < imageArea * minAreaRatio) continue;

        const bound = window.cv.boundingRect(contour);
        const minRect = window.cv.minAreaRect(contour);
        const perimeter = window.cv.arcLength(contour, true);
        approx = new window.cv.Mat();
        window.cv.approxPolyDP(contour, approx, Math.max(2, perimeter * 0.02), true);
        const approxPoints = extractApproxPoints(approx);

        const scored = scoreFrameCandidate({
          method: 'contour',
          area,
          bound,
          minRectWidth: minRect.size.width,
          minRectHeight: minRect.size.height,
          minRectAngle: minRect.angle,
          points: approxPoints.length === 4 ? approxPoints : []
        }, {
          imageWidth,
          imageHeight,
          imageArea,
          edges,
          aspectTargets,
          scoreWeights: context.scoreWeights
        });
        if (scored) candidates.push(scored);
      } finally {
        contour.delete();
        if (approx) approx.delete();
      }
    }

    const houghCandidate = buildHoughCandidate(edges, imageWidth, imageHeight);
    if (houghCandidate) {
      const scoredHough = scoreFrameCandidate(houghCandidate, {
        imageWidth,
        imageHeight,
        imageArea,
        edges,
        aspectTargets,
        scoreWeights: context.scoreWeights
      });
      if (scoredHough) candidates.push(scoredHough);
    }

    candidates.push(...buildDensityTemplateCandidates(imageData, context));

    return candidates
      .filter(candidate => candidate.areaRatio >= minAreaRatio)
      .sort((a, b) => b.score - a.score)
      .slice(0, 16);
  } catch (err) {
    console.error('OpenCV border analysis failed:', err);
    return buildDensityTemplateCandidates(imageData, context)
      .filter(candidate => candidate.areaRatio >= minAreaRatio)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);
  } finally {
    src.delete();
    if (gray) gray.delete();
    if (claheEnhanced) claheEnhanced.delete();
    if (topHat) topHat.delete();
    if (blackHat) blackHat.delete();
    if (merged) merged.delete();
    if (blurred) blurred.delete();
    if (edges) edges.delete();
    if (kernel3) kernel3.delete();
    if (kernel7) kernel7.delete();
    if (contours) contours.delete();
    if (hierarchy) hierarchy.delete();
  }
}

function buildRotationCandidates(baseCandidates = []) {
  const angleSet = new Set([0]);
  baseCandidates.slice(0, 4).forEach(candidate => {
    const minRect = candidate && candidate.minRect ? candidate.minRect : null;
    if (!minRect) return;
    let angle = Number(minRect.angle) || 0;
    const width = Number(minRect.width) || 0;
    const height = Number(minRect.height) || 0;
    if (width < height) angle += 90;
    [angle, -angle, angle + 90, angle - 90, angle + 180].forEach(raw => {
      const normalized = normalizeAngleDegrees(raw);
      const quantized = Math.round(normalized * 10) / 10;
      if (Math.abs(quantized) <= 0.1) {
        angleSet.add(0);
      } else {
        angleSet.add(quantized);
      }
    });
  });
  return Array.from(angleSet);
}

function normalizeAxisDelta(angle) {
  let normalized = normalizeAngleDegrees(Number(angle) || 0);
  while (normalized > 90) normalized -= 180;
  while (normalized <= -90) normalized += 180;
  if (normalized > 45) normalized -= 90;
  if (normalized <= -45) normalized += 90;
  return normalized;
}

function mergeAngleCandidates(...candidateGroups) {
  const angleSet = new Set([0]);
  candidateGroups.flat().forEach((angle) => {
    const normalized = normalizeAngleDegrees(Number(angle) || 0);
    const quantized = Math.abs(normalized) < 0.12 ? 0 : Math.round(normalized * 10) / 10;
    angleSet.add(quantized);
  });
  return Array.from(angleSet).sort((a, b) => Math.abs(a) - Math.abs(b));
}

function buildLineOrientationRotationCandidates(imageData) {
  if (!(window.cv && window.cv.Mat && window.cv.HoughLinesP) || !imageData) return [];
  const src = window.cv.matFromImageData(imageData);
  let gray = null;
  let blurred = null;
  let edges = null;
  let lines = null;
  try {
    const width = src.cols;
    const height = src.rows;
    const minDim = Math.min(width, height);
    if (minDim < 80) return [];

    gray = new window.cv.Mat();
    blurred = new window.cv.Mat();
    edges = new window.cv.Mat();
    lines = new window.cv.Mat();

    window.cv.cvtColor(src, gray, window.cv.COLOR_RGBA2GRAY);
    window.cv.GaussianBlur(gray, blurred, new window.cv.Size(5, 5), 0, 0, window.cv.BORDER_DEFAULT);
    window.cv.Canny(blurred, edges, 35, 120, 3, false);
    window.cv.HoughLinesP(
      edges,
      lines,
      1,
      Math.PI / 180,
      58,
      Math.max(34, Math.round(minDim * 0.18)),
      Math.max(7, Math.round(minDim * 0.016))
    );

    if (!lines.rows || !lines.data32S) return [];
    const bins = new Map();
    let totalWeight = 0;
    const data = lines.data32S;
    for (let i = 0; i < lines.rows; i++) {
      const idx = i * 4;
      const x1 = data[idx];
      const y1 = data[idx + 1];
      const x2 = data[idx + 2];
      const y2 = data[idx + 3];
      const dx = x2 - x1;
      const dy = y2 - y1;
      const length = Math.hypot(dx, dy);
      if (length < minDim * 0.16) continue;

      const rawAngle = Math.atan2(dy, dx) * 180 / Math.PI;
      const axisDelta = normalizeAxisDelta(rawAngle);
      if (Math.abs(axisDelta) > 35) continue;
      const bin = Math.round(axisDelta * 2) / 2;
      const weight = length * (1 - clampBetween(Math.abs(axisDelta) / 42, 0, 0.45));
      bins.set(bin, (bins.get(bin) || 0) + weight);
      totalWeight += weight;
    }

    if (totalWeight <= 0 || bins.size === 0) return [];
    return Array.from(bins.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .filter(([, weight]) => weight / totalWeight >= 0.16)
      .map(([delta]) => -delta)
      .filter(angle => Math.abs(angle) >= 0.2);
  } catch (err) {
    console.warn('Auto frame line orientation failed:', err);
    return [];
  } finally {
    src.delete();
    if (gray) gray.delete();
    if (blurred) blurred.delete();
    if (edges) edges.delete();
    if (lines) lines.delete();
  }
}

function getAutoFrameTargetRatiosForFormat(formatKey, context) {
  const direct = context.formatRatios[formatKey];
  if (Number.isFinite(direct)) return [direct];
  const fallback = getAutoFrameAspectTargets(context)
    .map(target => target.ratio)
    .filter(ratio => Number.isFinite(ratio) && ratio > 0.01);
  return fallback.length ? fallback : [context.formatRatios['135'] || 1.5];
}

function evaluateAutoFrameCropRegion(cropRegion, imageData, detectedFormat, candidate, context) {
  if (!cropRegion || !imageData) {
    return {
      isValid: false,
      areaRatio: 0,
      aspectDelta: 1,
      aspectScore: 0,
      areaScore: 0,
      edgeSupport: 0,
      shortEdgeCoverage: 0
    };
  }

  const totalArea = Math.max(1, imageData.width * imageData.height);
  const cropArea = Math.max(1, cropRegion.width * cropRegion.height);
  const areaRatio = cropArea / totalArea;
  const ratio = Math.max(cropRegion.width, cropRegion.height) / Math.max(1, Math.min(cropRegion.width, cropRegion.height));
  const targetRatios = getAutoFrameTargetRatiosForFormat(detectedFormat, context);
  let bestAspectDelta = Infinity;
  targetRatios.forEach((targetRatio) => {
    const delta = Math.abs(ratio - targetRatio) / targetRatio;
    if (delta < bestAspectDelta) bestAspectDelta = delta;
  });
  if (!Number.isFinite(bestAspectDelta)) bestAspectDelta = 1;

  const hasKnownFormat = Number.isFinite(context.formatRatios[detectedFormat]);
  const aspectTolerance = hasKnownFormat ? 0.34 : 0.42;
  const areaScore = clampBetween((areaRatio - 0.08) / 0.86, 0, 1);
  const aspectScore = 1 - clampBetween(bestAspectDelta / aspectTolerance, 0, 1);
  const shortEdgeCoverage = Math.min(cropRegion.width / imageData.width, cropRegion.height / imageData.height);
  const edgeSupport = candidate && candidate.scoreBreakdown
    ? clampBetween(Number(candidate.scoreBreakdown.edgeSupport) || 0, 0, 1)
    : 0.5;

  const isValid = areaRatio >= 0.10
    && areaRatio <= 0.975
    && bestAspectDelta <= aspectTolerance
    && shortEdgeCoverage >= 0.22
    && edgeSupport >= 0.12;

  return {
    isValid,
    areaRatio: Number(areaRatio.toFixed(4)),
    aspectDelta: Number(bestAspectDelta.toFixed(4)),
    aspectScore: Number(aspectScore.toFixed(3)),
    areaScore: Number(areaScore.toFixed(3)),
    edgeSupport: Number(edgeSupport.toFixed(3)),
    shortEdgeCoverage: Number(shortEdgeCoverage.toFixed(3)),
    aspectTolerance: Number(aspectTolerance.toFixed(3))
  };
}

function isDensityTemplateCandidate(candidate) {
  return Boolean(candidate && typeof candidate.method === 'string' && candidate.method.startsWith('density'));
}

function getDensityTemplateReliability(candidate, validation) {
  if (!isDensityTemplateCandidate(candidate)) {
    return { usable: true, confidenceCap: 1 };
  }

  const breakdown = candidate.scoreBreakdown || {};
  const boundaryCompleteness = clampBetween(Number(breakdown.boundaryCompleteness) || 0, 0, 1);
  const boundaryStrength = Math.max(
    Number(breakdown.borderContrast) || 0,
    Number(breakdown.edgeSupport) || 0,
    Number(breakdown.boundaryEdgeContrast) || 0
  );
  const contentTexture = clampBetween(Number(breakdown.contentTexture) || 0, 0, 1);
  const outsideClean = clampBetween(Number(breakdown.outsideClean) || 0, 0, 1);
  const sprocketLane = clampBetween(Number(breakdown.sprocketLane) || 0, 0, 1);
  const aspectScore = validation && Number.isFinite(validation.aspectScore) ? validation.aspectScore : 0;
  const areaRatio = validation && Number.isFinite(validation.areaRatio) ? validation.areaRatio : 1;
  const is135 = candidate.detectedFormat === '135';
  const isSprocketCandidate = candidate.method === 'density-sprocket-template';

  const strong35mm = is135
    && isSprocketCandidate
    && sprocketLane >= 0.24
    && boundaryStrength >= 0.24
    && outsideClean >= 0.12
    && boundaryCompleteness >= 0.5;

  const strongImageWindow = boundaryCompleteness >= 0.75
    && boundaryStrength >= 0.44
    && outsideClean >= 0.20
    && contentTexture >= 0.08
    && aspectScore >= 0.78
    && areaRatio <= 0.93;

  const moderateImageWindow = boundaryCompleteness >= 0.75
    && boundaryStrength >= 0.34
    && outsideClean >= 0.18
    && contentTexture >= 0.06
    && aspectScore >= 0.84
    && areaRatio <= 0.88;

  if (!strong35mm && !strongImageWindow && !moderateImageWindow) {
    return { usable: false, confidenceCap: 0 };
  }

  let confidenceCap = 0.66;
  if (strong35mm) confidenceCap = 0.78;
  if (strongImageWindow) confidenceCap = Math.max(confidenceCap, 0.74);
  if (!isSprocketCandidate) confidenceCap = Math.min(confidenceCap, 0.68);

  return { usable: true, confidenceCap };
}

function computeAutoFrameAnglePenalty(angle) {
  const absAngle = Math.abs(normalizeAngleDegrees(Number(angle) || 0));
  if (absAngle <= 0.12) return 0;
  const remainder = absAngle % 90;
  const distanceToRightAngle = Math.min(remainder, 90 - remainder);
  const offAxisPenalty = clampBetween(distanceToRightAngle / 22, 0, 1) * 0.16;
  const magnitudePenalty = clampBetween(absAngle / 120, 0, 1) * 0.07;
  return clampBetween(offAxisPenalty + magnitudePenalty, 0, 0.25);
}

function buildCropRegionFromBound(bound, imageData, marginRatio, context) {
  if (!bound || !imageData) return null;
  const safeMarginRatio = Number.isFinite(marginRatio) ? marginRatio : 0.02;
  const margin = Math.round(Math.min(imageData.width, imageData.height) * Math.max(0, safeMarginRatio));
  const left = clampBetween(bound.x - margin, 0, imageData.width - 1);
  const top = clampBetween(bound.y - margin, 0, imageData.height - 1);
  const maxWidth = imageData.width - left;
  const maxHeight = imageData.height - top;
  const width = clampBetween(bound.width + margin * 2, 1, maxWidth);
  const height = clampBetween(bound.height + margin * 2, 1, maxHeight);
  return context.sanitizeCropRegion({ left, top, width, height }, imageData);
}

function scaleCropRegion(cropRegion, sourceWidth, sourceHeight, targetImageData, context) {
  if (!cropRegion || !targetImageData || !sourceWidth || !sourceHeight) return null;
  const scaleX = targetImageData.width / sourceWidth;
  const scaleY = targetImageData.height / sourceHeight;
  return context.sanitizeCropRegion({
    left: Math.round(cropRegion.left * scaleX),
    top: Math.round(cropRegion.top * scaleY),
    width: Math.round(cropRegion.width * scaleX),
    height: Math.round(cropRegion.height * scaleY)
  }, targetImageData);
}

function detectAxisAlignedCropRegion(imageData, marginRatio, context) {
  const candidates = detectFrameCandidatesWithCv(imageData, context, {
    minAreaRatio: 0.04,
    retrievalMode: 'external'
  });
  if (!candidates.length) return null;

  for (const candidate of candidates) {
    const cropRegion = candidate.cropRegion
      ? context.sanitizeCropRegion(candidate.cropRegion, imageData)
      : buildCropRegionFromBound(candidate.bound, imageData, marginRatio, context);
    if (!cropRegion) continue;
    const validation = evaluateAutoFrameCropRegion(cropRegion, imageData, candidate.detectedFormat, candidate, context);
    if (!validation.isValid) continue;
    const reliability = getDensityTemplateReliability(candidate, validation);
    if (!reliability.usable) continue;
    const confidence = Math.min(reliability.confidenceCap, clampBetween(
      (candidate.score * 0.62) +
      (Math.min(validation.areaRatio / 0.92, 1) * 0.16) +
      (validation.aspectScore * 0.16) +
      (validation.edgeSupport * 0.06),
      0,
      1
    ));
    return {
      cropRegion,
      confidence,
      confidenceCap: reliability.confidenceCap,
      candidate,
      validation
    };
  }
  return null;
}

export function inferAutoFrameConfidenceLevel(confidence, settings = {}) {
  const high = Number.isFinite(settings.highConfidence) ? settings.highConfidence : 0.72;
  const min = Number.isFinite(settings.minConfidence) ? settings.minConfidence : 0.55;
  if (confidence >= high) return 'high';
  if (confidence >= min) return 'medium';
  return 'low';
}

export function detectFrameAndRotation(imageData, options = {}) {
  if (!imageData || !(window.cv && window.cv.Mat)) return null;
  const context = getAnalyzerContext(options);
  if (!context.rotateImageData) return null;

  const previewData = resizeImageDataToMaxSide(imageData, context.maxSide);
  const previewCandidates = detectFrameCandidatesWithCv(previewData, context, { minAreaRatio: 0.04 });
  const lineAngleCandidates = buildLineOrientationRotationCandidates(previewData);
  if (!previewCandidates.length && !lineAngleCandidates.length) return null;

  const angleCandidates = mergeAngleCandidates(
    buildRotationCandidates(previewCandidates),
    lineAngleCandidates
  );
  let bestPreview = null;
  for (const angle of angleCandidates) {
    const rotatedPreview = Math.abs(angle) < 0.001 ? previewData : context.rotateImageData(previewData, angle);
    const cropPreview = detectAxisAlignedCropRegion(rotatedPreview, context.settings.marginRatio, context);
    if (!cropPreview) continue;
    const baseScore = previewCandidates[0] ? previewCandidates[0].score : 0.5;
    const anglePenalty = computeAutoFrameAnglePenalty(angle);
    const validationAspect = cropPreview.validation ? cropPreview.validation.aspectScore : 0.6;
    const score = clampBetween(
      (baseScore * 0.24) +
      (cropPreview.confidence * 0.66) +
      (validationAspect * 0.10) -
      anglePenalty,
      0,
      1
    );
    const isBetter = !bestPreview
      || score > (bestPreview.score + 0.001)
      || (Math.abs(score - bestPreview.score) <= 0.001 && Math.abs(angle) < Math.abs(bestPreview.angle));
    if (isBetter) {
      bestPreview = {
        angle,
        score,
        cropPreview,
        anglePenalty,
        rotatedPreviewWidth: rotatedPreview.width,
        rotatedPreviewHeight: rotatedPreview.height
      };
    }
  }

  if (!bestPreview) return null;
  const normalizedAngle = Math.abs(bestPreview.angle) < 0.15 ? 0 : Number(bestPreview.angle.toFixed(2));
  const rotatedFull = Math.abs(normalizedAngle) < 0.001 ? imageData : context.rotateImageData(imageData, normalizedAngle);
  const scaledCropRegion = scaleCropRegion(
    bestPreview.cropPreview.cropRegion,
    bestPreview.rotatedPreviewWidth,
    bestPreview.rotatedPreviewHeight,
    rotatedFull,
    context
  );
  const scaledValidation = evaluateAutoFrameCropRegion(
    scaledCropRegion,
    rotatedFull,
    bestPreview.cropPreview.candidate ? bestPreview.cropPreview.candidate.detectedFormat : 'unknown',
    bestPreview.cropPreview.candidate,
    context
  );
  const cropFull = scaledCropRegion && scaledValidation.isValid
    ? {
      cropRegion: scaledCropRegion,
      confidence: bestPreview.cropPreview.confidence,
      confidenceCap: bestPreview.cropPreview.confidenceCap,
      candidate: bestPreview.cropPreview.candidate,
      validation: scaledValidation
    }
    : detectAxisAlignedCropRegion(rotatedFull, context.settings.marginRatio, context);
  if (!cropFull || !cropFull.validation || !cropFull.validation.isValid) return null;

  const fullAnglePenalty = computeAutoFrameAnglePenalty(normalizedAngle);
  const resultConfidenceCap = Math.min(
    Number.isFinite(cropFull.confidenceCap) ? cropFull.confidenceCap : 1,
    bestPreview.cropPreview && Number.isFinite(bestPreview.cropPreview.confidenceCap)
      ? bestPreview.cropPreview.confidenceCap
      : 1
  );
  const confidence = Number(Math.min(resultConfidenceCap, clampBetween(
    (bestPreview.score * 0.34) +
    (cropFull.confidence * 0.56) +
    (cropFull.validation.aspectScore * 0.10) -
    (fullAnglePenalty * 0.4),
    0,
    1
  )).toFixed(2));
  const confidenceLevel = inferAutoFrameConfidenceLevel(confidence, context.settings);
  const detectedFormat = cropFull.candidate && cropFull.candidate.detectedFormat
    ? cropFull.candidate.detectedFormat
    : 'unknown';
  const inferredFrameMode = cropFull.candidate && cropFull.candidate.frameMode
    ? cropFull.candidate.frameMode
    : inferFrameMaterialMode(context, buildDensityAnalysis(previewData));

  return {
    angle: normalizedAngle,
    cropRegion: cropFull.cropRegion,
    confidence,
    confidenceLevel,
    detectedFormat,
    rotatedImageData: rotatedFull,
    diagnostics: {
      method: cropFull.candidate ? cropFull.candidate.method : 'unknown',
      scoreBreakdown: cropFull.candidate ? cropFull.candidate.scoreBreakdown : null,
      frameMode: inferredFrameMode,
      anglePenalty: Number(fullAnglePenalty.toFixed(3)),
      cropValidation: cropFull.validation || null
    }
  };
}

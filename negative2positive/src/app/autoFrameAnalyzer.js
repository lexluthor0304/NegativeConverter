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

    return candidates
      .filter(candidate => candidate.areaRatio >= minAreaRatio)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
  } catch (err) {
    console.error('OpenCV border analysis failed:', err);
    return [];
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

function detectAxisAlignedCropRegion(imageData, marginRatio, context) {
  const candidates = detectFrameCandidatesWithCv(imageData, context, {
    minAreaRatio: 0.04,
    retrievalMode: 'external'
  });
  if (!candidates.length) return null;

  for (const candidate of candidates) {
    const cropRegion = buildCropRegionFromBound(candidate.bound, imageData, marginRatio, context);
    if (!cropRegion) continue;
    const validation = evaluateAutoFrameCropRegion(cropRegion, imageData, candidate.detectedFormat, candidate, context);
    if (!validation.isValid) continue;
    const confidence = clampBetween(
      (candidate.score * 0.62) +
      (Math.min(validation.areaRatio / 0.92, 1) * 0.16) +
      (validation.aspectScore * 0.16) +
      (validation.edgeSupport * 0.06),
      0,
      1
    );
    return {
      cropRegion,
      confidence,
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
  if (!previewCandidates.length) return null;

  const angleCandidates = buildRotationCandidates(previewCandidates);
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
      bestPreview = { angle, score, cropPreview, anglePenalty };
    }
  }

  if (!bestPreview) return null;
  const normalizedAngle = Math.abs(bestPreview.angle) < 0.15 ? 0 : Number(bestPreview.angle.toFixed(2));
  const rotatedFull = Math.abs(normalizedAngle) < 0.001 ? imageData : context.rotateImageData(imageData, normalizedAngle);
  const cropFull = detectAxisAlignedCropRegion(rotatedFull, context.settings.marginRatio, context);
  if (!cropFull || !cropFull.validation || !cropFull.validation.isValid) return null;

  const fullAnglePenalty = computeAutoFrameAnglePenalty(normalizedAngle);
  const confidence = Number(clampBetween(
    (bestPreview.score * 0.34) +
    (cropFull.confidence * 0.56) +
    (cropFull.validation.aspectScore * 0.10) -
    (fullAnglePenalty * 0.4),
    0,
    1
  ).toFixed(2));
  const confidenceLevel = inferAutoFrameConfidenceLevel(confidence, context.settings);
  const detectedFormat = cropFull.candidate && cropFull.candidate.detectedFormat
    ? cropFull.candidate.detectedFormat
    : 'unknown';

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
      anglePenalty: Number(fullAnglePenalty.toFixed(3)),
      cropValidation: cropFull.validation || null
    }
  };
}

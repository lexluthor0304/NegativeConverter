const DEFAULT_FILM_COLOR = [6, 6, 6, 255];
const DEFAULT_HOLE_COLOR = [255, 255, 255, 255];
const DEFAULT_MARKING_COLOR = [237, 156, 0, 255];
const DEFAULT_OVEREXPOSURE_COLOR = [237, 156, 0, 255];
const DX_EDGE_COLUMN_COUNT = 31;
const DX_EDGE_CODE_WIDTH_MM = 13;
const NATURAL_FILM_TEXTURE_SEED = 3508;

// 35mm still-film proportions: 34.98mm film width, 24x36mm image gate,
// eight perforations per still frame, and KS/BH-style sprocket dimensions.
export const THIRTY_FIVE_MM_SPROCKET_SPEC = Object.freeze({
  filmWidthMm: 34.98,
  stillFrameWidthMm: 36,
  stillFrameHeightMm: 24,
  perforationsPerStillFrame: 8,
  perforationPitchMm: 4.75,
  perforationWidthMm: 1.98,
  perforationHeightMm: 2.80,
  perforationOuterMarginMm: 2.00
});

export const DEFAULT_SPROCKET_EDGE_MARKINGS = Object.freeze({
  textEnabled: false,
  text: 'GC 400-8 KODAK',
  frameNumberEnabled: false,
  frameNumber: 18,
  frameNumberHole: 1,
  firstHoleOffsetMm: 0,
  dxEnabled: false,
  dx1: 82,
  dx2: 3,
  halfFrameMarksEnabled: true,
  overexposedSprockets: false,
  overexposureStrength: 1,
  fontStyle: 'monoBold',
  fontFamily: '',
  holeColor: '#ffffff',
  letteringColor: '#ed9c00',
  overexposureColor: '#ed9c00'
});

const FONT_STYLE_OPTIONS = new Set(['monoBold', 'mono', 'sansBold', 'serif']);

const CANVAS_FONT_STYLES = Object.freeze({
  monoBold: { family: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', weight: '700' },
  mono: { family: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', weight: '500' },
  sansBold: { family: 'Inter, Arial, sans-serif', weight: '700' },
  serif: { family: 'Georgia, Times, serif', weight: '700' }
});

const BITMAP_FONT = Object.freeze({
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '11100'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10011', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '01010', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '01010', '00100', '00100', '00100', '01010', '10001'],
  Y: ['10001', '01010', '00100', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '?': ['01110', '10001', '00001', '00010', '00100', '00000', '00100']
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clampInt(value, min, max) {
  return clamp(Math.round(Number(value) || 0), min, max);
}

function hexToColor(input) {
  if (typeof input !== 'string') return null;
  const match = input.trim().match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i);
  if (!match) return null;
  const hex = match[1].length === 3
    ? match[1].split('').map((ch) => ch + ch).join('')
    : match[1];
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
    255
  ];
}

function sanitizeColor(input, fallback) {
  const hexColor = hexToColor(input);
  const source = hexColor || (Array.isArray(input) || ArrayBuffer.isView(input) ? input : fallback);
  return [
    clamp(Math.round(Number(source[0]) || 0), 0, 255),
    clamp(Math.round(Number(source[1]) || 0), 0, 255),
    clamp(Math.round(Number(source[2]) || 0), 0, 255),
    clamp(Math.round(Number(source[3]) || 0), 0, 255)
  ];
}

export function normalizeSprocketEdgeMarkings(options = {}) {
  const source = options && typeof options === 'object' ? options : {};
  const defaults = DEFAULT_SPROCKET_EDGE_MARKINGS;
  return {
    textEnabled: Boolean(source.textEnabled),
    text: String(source.text ?? defaults.text).slice(0, 48),
    frameNumberEnabled: Boolean(source.frameNumberEnabled),
    frameNumber: clampInt(source.frameNumber ?? defaults.frameNumber, 0, 99),
    frameNumberHole: clampInt(source.frameNumberHole ?? defaults.frameNumberHole, 1, 8),
    firstHoleOffsetMm: clamp(Number(source.firstHoleOffsetMm ?? defaults.firstHoleOffsetMm) || 0, -2.5, 2.5),
    dxEnabled: Boolean(source.dxEnabled),
    dx1: clampInt(source.dx1 ?? defaults.dx1, 0, 126),
    dx2: clampInt(source.dx2 ?? defaults.dx2, 0, 15),
    halfFrameMarksEnabled: source.halfFrameMarksEnabled === undefined
      ? defaults.halfFrameMarksEnabled
      : Boolean(source.halfFrameMarksEnabled),
    overexposedSprockets: Boolean(source.overexposedSprockets),
    overexposureStrength: clamp(Number(source.overexposureStrength ?? defaults.overexposureStrength) || 0, 0, 2),
    fontStyle: FONT_STYLE_OPTIONS.has(source.fontStyle) ? source.fontStyle : defaults.fontStyle,
    fontFamily: String(source.fontFamily ?? defaults.fontFamily).slice(0, 80),
    holeColor: sanitizeColor(source.holeColor ?? defaults.holeColor, DEFAULT_HOLE_COLOR),
    letteringColor: sanitizeColor(source.letteringColor ?? defaults.letteringColor, DEFAULT_MARKING_COLOR),
    overexposureColor: sanitizeColor(source.overexposureColor ?? defaults.overexposureColor, DEFAULT_OVEREXPOSURE_COLOR)
  };
}

function getComposeEdgeMarkings(options = {}) {
  return normalizeSprocketEdgeMarkings(options.edgeMarkings || options.filmEdgeMarkings || {});
}

function hasVisibleEdgeMarkings(edge) {
  return Boolean(edge.textEnabled || edge.frameNumberEnabled || edge.dxEnabled);
}

export function getSprocketFrameMetrics(width, height, options = {}) {
  const edge = getComposeEdgeMarkings(options);
  const sourceWidth = Math.max(1, Math.round(Number(width) || 1));
  const sourceHeight = Math.max(1, Math.round(Number(height) || 1));
  const shortSide = Math.min(sourceWidth, sourceHeight);
  const showMarkings = hasVisibleEdgeMarkings(edge);
  const spec = THIRTY_FIVE_MM_SPROCKET_SPEC;
  const imagePxPerMmX = sourceWidth / spec.stillFrameWidthMm;
  const filmEdgeBandMm = (spec.filmWidthMm - spec.stillFrameHeightMm) / 2;
  const physicalBandHeight = Math.round(sourceHeight * filmEdgeBandMm / spec.stillFrameHeightMm);
  const sideMargin = clamp(
    Math.round(imagePxPerMmX * 1.0),
    8,
    Math.max(8, Math.round(shortSide * 0.08))
  );
  const bandMin = showMarkings ? 36 : 18;
  const bandHeight = clamp(
    physicalBandHeight,
    bandMin,
    Math.max(bandMin, Math.round(sourceHeight * 0.36))
  );
  const filmEdgePxPerMmY = bandHeight / filmEdgeBandMm;
  const mm = Math.max(1, (imagePxPerMmX + filmEdgePxPerMmY) / 2);
  const edgeGap = Math.max(2, Math.round(filmEdgePxPerMmY * 0.18));
  const holeWidth = Math.max(8, Math.round(spec.perforationWidthMm * imagePxPerMmX));
  const holeHeight = clamp(
    Math.round(spec.perforationHeightMm * filmEdgePxPerMmY),
    10,
    Math.max(10, bandHeight - edgeGap * 2)
  );
  const holeRadius = Math.max(2, Math.round(holeHeight * 0.18));
  const outputWidth = sourceWidth + sideMargin * 2;
  const outputHeight = sourceHeight + bandHeight * 2;
  const edgeTextPixelSize = Math.max(7, Math.round(filmEdgePxPerMmY * 0.78));
  const edgeTextHeight = Math.max(1, Math.ceil(edgeTextPixelSize * 1.35));
  const pitch = Math.max(holeWidth + edgeGap * 2, Math.round(spec.perforationPitchMm * imagePxPerMmX));
  const holeCount = spec.perforationsPerStillFrame;
  const span = (holeCount - 1) * pitch + holeWidth;
  const firstHoleOffsetPx = Math.round(edge.firstHoleOffsetMm * imagePxPerMmX);
  const startX = Math.round((outputWidth - span) / 2 + firstHoleOffsetPx);
  const outerPerfMargin = clamp(
    Math.round(spec.perforationOuterMarginMm * filmEdgePxPerMmY),
    edgeGap,
    Math.max(edgeGap, bandHeight - holeHeight - edgeGap)
  );
  const topY = outerPerfMargin;
  const topTextY = showMarkings ? Math.max(0, Math.floor((topY - edgeTextHeight - edgeGap) / 2)) : 0;
  const topMarkingY = topTextY;
  const bottomBandTop = bandHeight + sourceHeight;
  const bottomY = bottomBandTop + bandHeight - outerPerfMargin - holeHeight;
  const bottomOuterTop = bottomY + holeHeight;
  const bottomOuterHeight = Math.max(edgeGap, outputHeight - bottomOuterTop);
  const dxRowGap = clamp(
    Math.round(filmEdgePxPerMmY * 0.12),
    1,
    Math.max(1, bottomOuterHeight - edgeGap - 2)
  );
  const dxTargetBarHeight = Math.max(2, Math.round(filmEdgePxPerMmY * 0.82));
  const dxBarHeight = clamp(
    dxTargetBarHeight,
    1,
    Math.max(1, Math.floor((bottomOuterHeight - edgeGap - dxRowGap) / 2))
  );
  const dxCodeHeight = dxBarHeight * 2 + dxRowGap;
  const bottomDxY = showMarkings
    ? bottomOuterTop + Math.max(edgeGap, Math.floor((bottomOuterHeight - dxCodeHeight) / 2))
    : 0;
  const bottomMarkingY = showMarkings
    ? bottomOuterTop + Math.max(0, Math.floor((bottomOuterHeight - edgeTextHeight - edgeGap) / 2))
    : 0;

  return {
    sourceWidth,
    sourceHeight,
    outputWidth,
    outputHeight,
    sideMargin,
    bandHeight,
    bottomBandTop,
    holeWidth,
    holeHeight,
    holeRadius,
    pitch,
    holeCount,
    startX,
    topY,
    bottomY,
    topMarkingY,
    topTextY,
    bottomMarkingY,
    bottomDxY,
    edgeTextPixelSize,
    edgeTextHeight,
    dxCodeHeight,
    dxBarHeight,
    dxRowGap,
    edgeGap,
    filmEdgePxPerMmY,
    imagePxPerMmX,
    bottomOuterTop,
    bottomOuterHeight,
    mm,
    showMarkings
  };
}

function isInsideRoundedRect(x, y, width, height, radius) {
  const px = x + 0.5;
  const py = y + 0.5;
  const innerRight = width - radius;
  const innerBottom = height - radius;
  const dx = px < radius ? radius - px : (px > innerRight ? px - innerRight : 0);
  const dy = py < radius ? radius - py : (py > innerBottom ? py - innerBottom : 0);
  return (dx * dx + dy * dy) <= radius * radius;
}

function blendPixel(data, index, fill, alpha) {
  const amount = clamp(alpha, 0, 1);
  const keep = 1 - amount;
  data[index] = Math.round(data[index] * keep + fill[0] * amount);
  data[index + 1] = Math.round(data[index + 1] * keep + fill[1] * amount);
  data[index + 2] = Math.round(data[index + 2] * keep + fill[2] * amount);
  data[index + 3] = Math.max(data[index + 3], Math.round(fill[3] * amount));
}

function addPixel(data, index, fill, alpha) {
  const amount = clamp(alpha, 0, 1);
  data[index] = clamp(Math.round(data[index] + fill[0] * amount), 0, 255);
  data[index + 1] = clamp(Math.round(data[index + 1] + fill[1] * amount), 0, 255);
  data[index + 2] = clamp(Math.round(data[index + 2] + fill[2] * amount), 0, 255);
  data[index + 3] = Math.max(data[index + 3], Math.round(fill[3] * amount));
}

function hashNoise(x, y, seed = NATURAL_FILM_TEXTURE_SEED) {
  let value = Math.imul(Math.round(x), 374761393)
    ^ Math.imul(Math.round(y), 668265263)
    ^ Math.imul(seed, 1442695041);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function smoothNoise(x, y, scale, seed) {
  const sx = Math.floor(x / scale);
  const sy = Math.floor(y / scale);
  return (
    hashNoise(sx, sy, seed) +
    hashNoise(sx + 1, sy, seed) +
    hashNoise(sx, sy + 1, seed) +
    hashNoise(sx + 1, sy + 1, seed)
  ) * 0.25;
}

function filmBasePixel(metrics, filmColor, x, y) {
  const cx = metrics.outputWidth / 2;
  const cy = metrics.outputHeight / 2;
  const nx = Math.abs((x + 0.5 - cx) / Math.max(1, cx));
  const ny = Math.abs((y + 0.5 - cy) / Math.max(1, cy));
  const radial = clamp((nx * nx + ny * ny) * 0.9, 0, 1);
  const inTopBand = y < metrics.bandHeight;
  const inBottomBand = y >= metrics.bottomBandTop;
  const bandDepth = inTopBand
    ? y / Math.max(1, metrics.bandHeight)
    : (inBottomBand ? (metrics.outputHeight - y - 1) / Math.max(1, metrics.bandHeight) : 0.48);
  const outerEdge = inTopBand || inBottomBand ? 1 - clamp(bandDepth, 0, 1) : 0.22;
  const framePitch = Math.max(1, getEdgeFramePitch(metrics));
  const frameShade = Math.sin(((x - metrics.startX) / framePitch) * Math.PI * 2) * 1.6;
  const sprocketShade = Math.sin(((x - metrics.startX) / Math.max(1, metrics.pitch)) * Math.PI * 2) * 0.55;
  const coarse = smoothNoise(x, y, 18, NATURAL_FILM_TEXTURE_SEED + 19) - 0.5;
  const fine = hashNoise(x, y, NATURAL_FILM_TEXTURE_SEED + 31) - 0.5;
  const leakWave = Math.max(0, Math.sin((x * 0.018) + (y * 0.007) + 1.35));
  const warmLeak = Math.pow(leakWave, 6) * (inTopBand || inBottomBand ? 1 : 0.28);
  const density = 1.5 + radial * 3.5 + outerEdge * 2.6 + frameShade + sprocketShade + coarse * 6 + fine * 2.4;

  return [
    clamp(Math.round(filmColor[0] + density + warmLeak * 10), 0, 255),
    clamp(Math.round(filmColor[1] + density * 0.9 + warmLeak * 4.8), 0, 255),
    clamp(Math.round(filmColor[2] + density * 0.62 + warmLeak * 1.4), 0, 255),
    filmColor[3]
  ];
}

function fillFilmBase(data, metrics, filmColor) {
  for (let i = 0; i < data.length; i += 4) {
    data[i] = filmColor[0];
    data[i + 1] = filmColor[1];
    data[i + 2] = filmColor[2];
    data[i + 3] = filmColor[3];
  }

  const paintSpan = (left, top, width, height) => {
    const right = Math.min(metrics.outputWidth, left + width);
    const bottom = Math.min(metrics.outputHeight, top + height);
    for (let y = Math.max(0, top); y < bottom; y++) {
      for (let x = Math.max(0, left); x < right; x++) {
        const fill = filmBasePixel(metrics, filmColor, x, y);
        const index = (y * metrics.outputWidth + x) * 4;
        data[index] = fill[0];
        data[index + 1] = fill[1];
        data[index + 2] = fill[2];
        data[index + 3] = fill[3];
      }
    }
  };

  paintSpan(0, 0, metrics.outputWidth, metrics.bandHeight);
  paintSpan(0, metrics.bottomBandTop, metrics.outputWidth, metrics.outputHeight - metrics.bottomBandTop);
  if (metrics.sideMargin > 0) {
    const middleTop = metrics.bandHeight;
    const middleHeight = metrics.sourceHeight;
    paintSpan(0, middleTop, metrics.sideMargin, middleHeight);
    paintSpan(metrics.sideMargin + metrics.sourceWidth, middleTop, metrics.sideMargin, middleHeight);
  }
}

function fillRect(data, metrics, left, top, width, height, fill, alpha = 1) {
  const rectLeft = Math.max(0, Math.round(left));
  const rectTop = Math.max(0, Math.round(top));
  const rectRight = Math.min(metrics.outputWidth, Math.round(left + width));
  const rectBottom = Math.min(metrics.outputHeight, Math.round(top + height));
  if (rectRight <= rectLeft || rectBottom <= rectTop) return;

  for (let y = rectTop; y < rectBottom; y++) {
    for (let x = rectLeft; x < rectRight; x++) {
      const i = (y * metrics.outputWidth + x) * 4;
      if (alpha >= 1) {
        data[i] = fill[0];
        data[i + 1] = fill[1];
        data[i + 2] = fill[2];
        data[i + 3] = fill[3];
      } else {
        blendPixel(data, i, fill, alpha);
      }
    }
  }
}

function paintSprocketHole(data, metrics, left, top, fill) {
  const rectLeft = Math.max(0, left);
  const rectTop = Math.max(0, top);
  const rectRight = Math.min(metrics.outputWidth, left + metrics.holeWidth);
  const rectBottom = Math.min(metrics.outputHeight, top + metrics.holeHeight);
  const rim = Math.max(1, Math.round(Math.min(metrics.holeWidth, metrics.holeHeight) * 0.10));
  const rimFill = [
    clamp(fill[0] - 38, 0, 255),
    clamp(fill[1] - 34, 0, 255),
    clamp(fill[2] - 28, 0, 255),
    fill[3]
  ];

  for (let y = rectTop; y < rectBottom; y++) {
    for (let x = rectLeft; x < rectRight; x++) {
      if (!isInsideRoundedRect(x - left, y - top, metrics.holeWidth, metrics.holeHeight, metrics.holeRadius)) {
        continue;
      }
      const i = (y * metrics.outputWidth + x) * 4;
      data[i] = fill[0];
      data[i + 1] = fill[1];
      data[i + 2] = fill[2];
      data[i + 3] = fill[3];
      if (fill[3] > 0) {
        const interiorDistance = -roundedRectDistance(
          x + 0.5,
          y + 0.5,
          left,
          top,
          metrics.holeWidth,
          metrics.holeHeight,
          metrics.holeRadius
        );
        if (interiorDistance >= 0 && interiorDistance < rim) {
          const rimAlpha = (1 - interiorDistance / rim) * 0.16;
          blendPixel(data, i, rimFill, rimAlpha);
        }
      }
    }
  }
}

function forEachSprocketHole(metrics, callback) {
  for (let i = 0; i < metrics.holeCount; i++) {
    const left = metrics.startX + i * metrics.pitch;
    callback(left, metrics.topY, i);
    callback(left, metrics.bottomY, i);
  }
}

function roundedRectDistance(px, py, left, top, width, height, radius) {
  const centerX = left + width / 2;
  const centerY = top + height / 2;
  const qx = Math.abs(px - centerX) - (width / 2 - radius);
  const qy = Math.abs(py - centerY) - (height / 2 - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - radius;
}

function paintSprocketGlow(data, metrics, left, top, fill, strength = 1) {
  const amount = clamp(Number(strength) || 0, 0, 2);
  if (amount <= 0) return;
  const spread = Math.max(4, Math.round(metrics.holeHeight * (0.42 + amount * 0.38)));
  const rectLeft = Math.max(0, Math.round(left - spread));
  const rectTop = Math.max(0, Math.round(top - spread));
  const rectRight = Math.min(metrics.outputWidth, Math.round(left + metrics.holeWidth + spread));
  const rectBottom = Math.min(metrics.outputHeight, Math.round(top + metrics.holeHeight + spread));

  for (let y = rectTop; y < rectBottom; y++) {
    for (let x = rectLeft; x < rectRight; x++) {
      const distance = roundedRectDistance(
        x + 0.5,
        y + 0.5,
        left,
        top,
        metrics.holeWidth,
        metrics.holeHeight,
        metrics.holeRadius
      );
      if (distance < 0 || distance > spread) continue;
      const falloff = 1 - distance / spread;
      const isTopRow = top < metrics.bandHeight;
      const inward = isTopRow
        ? clamp((y - top) / Math.max(1, metrics.holeHeight + spread), 0, 1)
        : clamp((top + metrics.holeHeight - y) / Math.max(1, metrics.holeHeight + spread), 0, 1);
      const coarse = smoothNoise(x, y, Math.max(3, Math.round(metrics.holeHeight * 0.32)), 914);
      const fine = hashNoise(x, y, 915);
      const streak = Math.pow(Math.max(0, Math.sin((x - left) * 0.16 + (isTopRow ? 0.5 : 2.2))), 3);
      const irregularity = clamp(0.62 + coarse * 0.54 + fine * 0.22 + inward * 0.24 + streak * 0.18, 0.45, 1.45);
      const alpha = falloff * falloff * clamp(0.16 + amount * 0.38, 0.08, 0.82) * irregularity;
      addPixel(data, (y * metrics.outputWidth + x) * 4, fill, alpha);
    }
  }
}

function paintSprocketRows(data, metrics, fill) {
  forEachSprocketHole(metrics, (left, top) => {
    paintSprocketHole(data, metrics, left, top, fill);
  });
}

function paintOverexposedSprockets(data, metrics, fill) {
  forEachSprocketHole(metrics, (left, top) => {
    paintSprocketGlow(data, metrics, left, top, fill, metrics.edgeOverexposureStrength);
  });
}

function getGlyphRows(char) {
  return BITMAP_FONT[char] || BITMAP_FONT['?'];
}

function measureBitmapText(text, scale) {
  const safeText = String(text || '');
  if (!safeText) return 0;
  return safeText.length * 6 * scale - scale;
}

function drawBitmapText(data, metrics, text, x, y, scale, fill, align = 'left') {
  const safeText = String(text || '').toUpperCase();
  if (!safeText || scale <= 0) return;

  const measured = measureBitmapText(safeText, scale);
  let cursorX = Math.round(x);
  if (align === 'center') cursorX -= Math.round(measured / 2);
  if (align === 'right') cursorX -= measured;

  const cursorY = Math.round(y);
  for (const char of safeText) {
    const rows = getGlyphRows(char);
    for (let row = 0; row < rows.length; row++) {
      for (let col = 0; col < rows[row].length; col++) {
        if (rows[row][col] !== '1') continue;
        fillRect(
          data,
          metrics,
          cursorX + col * scale,
          cursorY + row * scale,
          scale,
          scale,
          fill
        );
      }
    }
    cursorX += 6 * scale;
  }
}

function createTextCanvas(width, height) {
  if (typeof OffscreenCanvas === 'function') {
    return new OffscreenCanvas(width, height);
  }
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  return null;
}

function toCssFontFamilyList(input) {
  const families = String(input || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 4);
  if (!families.length) return '';
  return families.map((family) => {
    const clean = family.replace(/["'\\]/g, '');
    return /^[a-z0-9_-]+$/i.test(clean) ? clean : `"${clean}"`;
  }).join(', ');
}

function drawCanvasText(data, metrics, text, x, y, pixelSize, fill, align, fontStyle, fontFamily = '') {
  const safeText = String(text || '').trim();
  if (!safeText || pixelSize <= 0) return false;

  const style = CANVAS_FONT_STYLES[fontStyle] || CANVAS_FONT_STYLES.monoBold;
  const measureCanvas = createTextCanvas(1, 1);
  if (!measureCanvas) return false;
  const measureCtx = measureCanvas.getContext('2d');
  if (!measureCtx || typeof measureCtx.measureText !== 'function') return false;

  const customFamily = toCssFontFamilyList(fontFamily);
  const family = customFamily ? `${customFamily}, ${style.family}` : style.family;
  const font = `${style.weight} ${Math.round(pixelSize)}px ${family}`;
  measureCtx.font = font;
  const measured = Math.max(1, Math.ceil(measureCtx.measureText(safeText).width));
  const textWidth = measured + 6;
  const textHeight = Math.max(1, Math.ceil(pixelSize * 1.35));
  const textCanvas = createTextCanvas(textWidth, textHeight);
  if (!textCanvas) return false;
  const textCtx = textCanvas.getContext('2d');
  if (!textCtx || typeof textCtx.getImageData !== 'function') return false;

  textCtx.clearRect(0, 0, textWidth, textHeight);
  textCtx.font = font;
  textCtx.textBaseline = 'top';
  textCtx.textAlign = 'left';
  textCtx.fillStyle = `rgba(${fill[0]}, ${fill[1]}, ${fill[2]}, ${fill[3] / 255})`;
  textCtx.fillText(safeText, 3, 0);

  const textPixels = textCtx.getImageData(0, 0, textWidth, textHeight).data;
  let dstLeft = Math.round(x);
  if (align === 'center') dstLeft -= Math.round(textWidth / 2);
  if (align === 'right') dstLeft -= textWidth;
  const dstTop = Math.round(y);

  for (let ty = 0; ty < textHeight; ty++) {
    const dy = dstTop + ty;
    if (dy < 0 || dy >= metrics.outputHeight) continue;
    for (let tx = 0; tx < textWidth; tx++) {
      const dx = dstLeft + tx;
      if (dx < 0 || dx >= metrics.outputWidth) continue;
      const srcIndex = (ty * textWidth + tx) * 4;
      const alpha = textPixels[srcIndex + 3] / 255;
      if (alpha <= 0) continue;
      const dstIndex = (dy * metrics.outputWidth + dx) * 4;
      blendPixel(data, dstIndex, fill, alpha);
    }
  }
  return true;
}

function drawEdgeText(data, metrics, edge, text, x, y, pixelSize, align = 'left', fill = edge.letteringColor) {
  const rendered = drawCanvasText(
    data,
    metrics,
    text,
    x,
    y,
    pixelSize,
    fill,
    align,
    edge.fontStyle,
    edge.fontFamily
  );
  if (rendered) return;
  const scale = Math.max(1, Math.round(pixelSize / 7));
  drawBitmapText(data, metrics, text, x, y, scale, fill, align);
}

export function buildDxEdgeCodeBlocks(options = {}) {
  const source = options && typeof options === 'object' ? options : {};
  const edge = normalizeSprocketEdgeMarkings(source);
  const hasExplicitAFlag = Object.prototype.hasOwnProperty.call(source, 'aFlag');
  const aFlag = hasExplicitAFlag ? (source.aFlag ? 1 : 0) : (edge.frameNumber > 36 ? 1 : 0);
  const blocks = [];
  const seen = new Set();
  const add = (column, row) => {
    const key = `${column}:${row}`;
    if (column < 0 || column >= DX_EDGE_COLUMN_COUNT || row < 0 || row > 1 || seen.has(key)) return;
    seen.add(key);
    blocks.push({ column, row });
  };
  const addBinary = (value, startColumn, startBit) => {
    let bit = startBit;
    let column = startColumn;
    while (bit >= 1) {
      if ((value & bit) !== 0) add(column, 1);
      bit >>= 1;
      column++;
    }
  };

  for (let column = 0; column <= 4; column++) add(column, 0);
  for (let column = 0; column <= 4; column += 2) add(column, 1);
  for (let column = 6; column <= 30; column += 2) add(column, 0);

  addBinary(edge.dx1, 6, 64);
  addBinary(edge.dx2, 14, 8);
  addBinary(clampInt(edge.frameNumber, 0, 63), 18, 32);

  if (aFlag) add(24, 1);
  if (((edge.dx1 + edge.dx2 + clampInt(edge.frameNumber, 0, 63) + aFlag) % 2) === 1) add(26, 1);

  add(29, 0);
  add(28, 1);
  add(30, 1);
  return blocks;
}

function getEdgeFramePitch(metrics) {
  return metrics.pitch * THIRTY_FIVE_MM_SPROCKET_SPEC.perforationsPerStillFrame;
}

function getFrameNumberAnchorX(metrics, edge) {
  return Math.round(metrics.startX + metrics.holeWidth + (edge.frameNumberHole - 1) * metrics.pitch);
}

function forEachVisibleFrameRepeat(metrics, edge, callback) {
  const framePitch = getEdgeFramePitch(metrics);
  const baseX = getFrameNumberAnchorX(metrics, edge);
  const minIndex = Math.floor((0 - baseX - framePitch) / framePitch);
  const maxIndex = Math.ceil((metrics.outputWidth - baseX + framePitch) / framePitch);
  for (let index = minIndex; index <= maxIndex; index++) {
    const frameNumber = clampInt(edge.frameNumber + index, 0, 99);
    callback({
      index,
      frameNumber,
      mainX: baseX + index * framePitch,
      halfX: baseX + (index + 0.5) * framePitch
    });
  }
}

function isHorizontallyVisible(metrics, left, width) {
  return left + width >= 0 && left <= metrics.outputWidth;
}

function paintDxBar(data, metrics, left, top, width, height, fill) {
  const bleed = Math.max(1, Math.round(height * 0.12));
  fillRect(data, metrics, left - 1, top - bleed, width + 2, height + bleed * 2, fill, 0.16);
  fillRect(data, metrics, left, top, width, height, fill);
}

function paintDxSequence(data, metrics, edge, left, top, modulePitch, barWidth, blockHeight, rowPitch, aFlag) {
  const codeWidth = modulePitch * DX_EDGE_COLUMN_COUNT;
  if (!isHorizontallyVisible(metrics, left, codeWidth)) return;
  for (const block of buildDxEdgeCodeBlocks({ ...edge, aFlag })) {
    paintDxBar(
      data,
      metrics,
      left + block.column * modulePitch,
      top + block.row * rowPitch,
      barWidth,
      blockHeight,
      edge.letteringColor
    );
  }
}

function paintDxEdgeCode(data, metrics, edge) {
  const codeWidth = Math.max(
    DX_EDGE_COLUMN_COUNT,
    Math.round(DX_EDGE_CODE_WIDTH_MM * metrics.imagePxPerMmX)
  );
  const modulePitch = codeWidth / DX_EDGE_COLUMN_COUNT;
  const barWidth = Math.max(1, Math.ceil(modulePitch + 0.5));
  const blockHeight = Math.max(1, metrics.dxBarHeight || Math.round(metrics.filmEdgePxPerMmY * 0.78));
  const rowGap = Math.max(1, metrics.dxRowGap || Math.round(metrics.filmEdgePxPerMmY * 0.12));
  const rowPitch = blockHeight + rowGap;
  const top = clamp(
    metrics.bottomDxY,
    metrics.bottomBandTop,
    Math.max(metrics.bottomBandTop, metrics.outputHeight - (blockHeight * 2 + rowGap) - 1)
  );
  const dxOffset = Math.round(metrics.pitch - metrics.imagePxPerMmX * 0.5);

  forEachVisibleFrameRepeat(metrics, edge, (repeat) => {
    paintDxSequence(data, metrics, edge, repeat.mainX + dxOffset, top, modulePitch, barWidth, blockHeight, rowPitch, false);
    paintDxSequence(data, metrics, edge, repeat.halfX + dxOffset, top, modulePitch, barWidth, blockHeight, rowPitch, true);
  });
}

function fillTriangle(data, metrics, p0, p1, p2, fill, alpha = 1) {
  const minX = Math.max(0, Math.floor(Math.min(p0.x, p1.x, p2.x)));
  const maxX = Math.min(metrics.outputWidth - 1, Math.ceil(Math.max(p0.x, p1.x, p2.x)));
  const minY = Math.max(0, Math.floor(Math.min(p0.y, p1.y, p2.y)));
  const maxY = Math.min(metrics.outputHeight - 1, Math.ceil(Math.max(p0.y, p1.y, p2.y)));
  const area = (p1.y - p2.y) * (p0.x - p2.x) + (p2.x - p1.x) * (p0.y - p2.y);
  if (area === 0) return;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const a = ((p1.y - p2.y) * (px - p2.x) + (p2.x - p1.x) * (py - p2.y)) / area;
      const b = ((p2.y - p0.y) * (px - p2.x) + (p0.x - p2.x) * (py - p2.y)) / area;
      const c = 1 - a - b;
      if (a < 0 || b < 0 || c < 0) continue;
      const index = (y * metrics.outputWidth + x) * 4;
      if (alpha >= 1) {
        data[index] = fill[0];
        data[index + 1] = fill[1];
        data[index + 2] = fill[2];
        data[index + 3] = fill[3];
      } else {
        blendPixel(data, index, fill, alpha);
      }
    }
  }
}

function paintHalfFrameMarker(data, metrics, edge, repeat) {
  const label = `${repeat.frameNumber}A`;
  const pixelSize = Math.max(6, Math.round(metrics.edgeTextPixelSize * 0.84));
  const triangleHeight = clamp(
    Math.round(metrics.filmEdgePxPerMmY * 1.45),
    5,
    Math.max(5, metrics.outputHeight - metrics.bottomMarkingY - 1)
  );
  const triangleWidth = Math.max(4, Math.round(metrics.imagePxPerMmX * 1.65));
  const triangleLeft = repeat.halfX - metrics.imagePxPerMmX;
  const triangleTop = metrics.bottomMarkingY + Math.max(0, Math.round((metrics.edgeTextHeight - triangleHeight) / 2));

  if (isHorizontallyVisible(metrics, triangleLeft, triangleWidth)) {
    fillTriangle(
      data,
      metrics,
      { x: triangleLeft, y: triangleTop },
      { x: triangleLeft + triangleWidth, y: triangleTop + triangleHeight / 2 },
      { x: triangleLeft, y: triangleTop + triangleHeight },
      edge.letteringColor
    );
  }

  drawEdgeText(
    data,
    metrics,
    edge,
    label,
    repeat.halfX + Math.round(metrics.imagePxPerMmX * 0.8),
    metrics.bottomMarkingY,
    pixelSize,
    'left'
  );
}

function paintFrameNumberMarker(data, metrics, edge) {
  const pixelSize = metrics.edgeTextPixelSize;
  const textWidth = Math.max(metrics.imagePxPerMmX * 2.2, pixelSize * 2);
  forEachVisibleFrameRepeat(metrics, edge, (repeat) => {
    const label = String(repeat.frameNumber);
    if (isHorizontallyVisible(metrics, repeat.mainX, textWidth)) {
      drawEdgeText(data, metrics, edge, label, repeat.mainX, metrics.topMarkingY, pixelSize, 'left');
      drawEdgeText(data, metrics, edge, label, repeat.mainX, metrics.bottomMarkingY, pixelSize, 'left');
    }
    if (edge.halfFrameMarksEnabled) {
      paintHalfFrameMarker(data, metrics, edge, repeat);
    }
  });
}

function paintSprocketTextureSmear(data, metrics, sourceImageData, strength = 1) {
  const source = sourceImageData?.data;
  if (!source) return;
  const amount = clamp(Number(strength) || 0, 0, 2);
  if (amount <= 0) return;
  const spread = Math.max(5, Math.round(metrics.holeHeight * 0.58));

  forEachSprocketHole(metrics, (left, top) => {
    const isTopRow = top < metrics.bandHeight;
    const rectLeft = Math.max(0, Math.round(left - spread));
    const rectTop = Math.max(0, Math.round(top - spread));
    const rectRight = Math.min(metrics.outputWidth, Math.round(left + metrics.holeWidth + spread));
    const rectBottom = Math.min(metrics.outputHeight, Math.round(top + metrics.holeHeight + spread));

    for (let y = rectTop; y < rectBottom; y++) {
      for (let x = rectLeft; x < rectRight; x++) {
        const distance = roundedRectDistance(
          x + 0.5,
          y + 0.5,
          left,
          top,
          metrics.holeWidth,
          metrics.holeHeight,
          metrics.holeRadius
        );
        if (distance < 0 || distance > spread) continue;
        const sourceX = clampInt(x - metrics.sideMargin, 0, metrics.sourceWidth - 1);
        const edgeDistance = isTopRow
          ? Math.max(0, metrics.bandHeight - y)
          : Math.max(0, y - (metrics.bandHeight + metrics.sourceHeight - 1));
        const sourceY = isTopRow
          ? clampInt(edgeDistance, 0, metrics.sourceHeight - 1)
          : clampInt(metrics.sourceHeight - 1 - edgeDistance, 0, metrics.sourceHeight - 1);
        const srcIndex = (sourceY * metrics.sourceWidth + sourceX) * 4;
        const falloff = 1 - distance / spread;
        const grain = clamp(0.68 + smoothNoise(x, y, Math.max(4, Math.round(metrics.holeHeight * 0.4)), 777) * 0.62, 0.45, 1.3);
        const alpha = falloff * falloff * clamp(0.045 + amount * 0.055, 0.03, 0.16) * grain;
        blendPixel(
          data,
          (y * metrics.outputWidth + x) * 4,
          [source[srcIndex], source[srcIndex + 1], source[srcIndex + 2], 255],
          alpha
        );
      }
    }
  });
}

function paintPhotoText(data, metrics, edge) {
  const pixelSize = metrics.edgeTextPixelSize;
  const text = edge.text.trim();
  if (!text) return;
  drawEdgeText(
    data,
    metrics,
    edge,
    text,
    Math.round(metrics.outputWidth / 2),
    metrics.topTextY,
    pixelSize,
    'center'
  );
}

function paintEdgeMarkings(data, metrics, edge) {
  if (edge.textEnabled) paintPhotoText(data, metrics, edge);
  if (edge.dxEnabled) paintDxEdgeCode(data, metrics, edge);
  if (edge.frameNumberEnabled) paintFrameNumberMarker(data, metrics, edge);
}

export function composeSprocketFrame(imageData, options = {}) {
  if (!imageData || !imageData.data || !imageData.width || !imageData.height) {
    throw new Error('ImageData is required to compose sprocket holes.');
  }

  const edge = getComposeEdgeMarkings(options);
  const metrics = getSprocketFrameMetrics(imageData.width, imageData.height, { edgeMarkings: edge });
  metrics.edgeOverexposureStrength = edge.overexposureStrength;
  const filmColor = sanitizeColor(options.filmColor, DEFAULT_FILM_COLOR);
  const holeColor = options.transparentHoles === true
    ? [0, 0, 0, 0]
    : sanitizeColor(options.holeColor ?? edge.holeColor, DEFAULT_HOLE_COLOR);
  const output = new Uint8ClampedArray(metrics.outputWidth * metrics.outputHeight * 4);

  fillFilmBase(output, metrics, filmColor);

  const src = imageData.data;
  for (let y = 0; y < metrics.sourceHeight; y++) {
    const srcOffset = y * metrics.sourceWidth * 4;
    const dstOffset = ((y + metrics.bandHeight) * metrics.outputWidth + metrics.sideMargin) * 4;
    output.set(src.subarray(srcOffset, srcOffset + metrics.sourceWidth * 4), dstOffset);
  }

  if (edge.overexposedSprockets) {
    paintSprocketTextureSmear(output, metrics, imageData, edge.overexposureStrength);
    paintOverexposedSprockets(output, metrics, edge.overexposureColor);
  }
  paintSprocketRows(output, metrics, holeColor);
  paintEdgeMarkings(output, metrics, edge);

  return new ImageData(output, metrics.outputWidth, metrics.outputHeight);
}

export function hasSprocketFrameEnabled(settings) {
  return Boolean(settings && (
    settings.sprocketHolesEnabled
    || settings.sprocketPreviewEnabled
    || settings.exportSprocketHolesEnabled
  ));
}

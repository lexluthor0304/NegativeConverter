const DEFAULT_FILM_COLOR = [6, 6, 6, 255];
const DEFAULT_HOLE_COLOR = [255, 255, 255, 255];
const DEFAULT_MARKING_COLOR = [196, 122, 0, 255];
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
  text: 'KODAK PORTRA 160',
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
  fontStyle: 'edgePixel',
  fontFamily: '',
  holeColor: '#ffffff',
  letteringColor: '#c47a00',
  overexposureColor: '#ed9c00'
});

const FONT_STYLE_OPTIONS = new Set(['edgePixel', 'monoBold', 'mono', 'sansBold', 'serif']);

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

  // Input is always landscape at this point (portrait images are pre-rotated by the caller).
  const sy = sourceHeight;
  // 画面の縦横比で穴を伸ばさない。パノラマではピッチを保って穴の数を増やす。
  const imagePxPerMmX = sy / spec.stillFrameHeightMm;
  const filmEdgeBandMm = (spec.filmWidthMm - spec.stillFrameHeightMm) / 2;
  const physicalBandHeight = Math.round(sy * filmEdgeBandMm / spec.stillFrameHeightMm);
  const sideMargin = clamp(
    Math.round(imagePxPerMmX * 1.0),
    8,
    Math.max(8, Math.round(shortSide * 0.08))
  );
  const bandMin = showMarkings ? 36 : 18;
  const bandHeight = clamp(
    physicalBandHeight,
    bandMin,
    Math.max(bandMin, Math.round(sy * 0.36))
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
  const holeRadius = Math.max(1, filmEdgePxPerMmY * 0.32);
  const outputWidth = sourceWidth + sideMargin * 2;
  const outputHeight = sourceHeight + bandHeight * 2;
  const edgeTextPixelSize = Math.max(7, filmEdgePxPerMmY * 1.35);
  const frameNumberPixelSize = Math.max(7, filmEdgePxPerMmY * 1.65);
  const edgeTextHeight = Math.ceil(frameNumberPixelSize);
  const pitch = Math.max(holeWidth + edgeGap * 2, Math.round(spec.perforationPitchMm * imagePxPerMmX));
  const perforationsPerFrame = spec.perforationsPerStillFrame;
  const span = (perforationsPerFrame - 1) * pitch + holeWidth;
  const firstHoleOffsetPx = Math.round(edge.firstHoleOffsetMm * imagePxPerMmX);
  const frameStartX = Math.round((outputWidth - span) / 2 + firstHoleOffsetPx);
  const firstHoleIndex = Math.floor((0 - frameStartX - holeWidth) / pitch);
  const lastHoleIndex = Math.ceil((outputWidth - frameStartX) / pitch);
  const holeCount = Math.max(0, lastHoleIndex - firstHoleIndex + 1);
  const startX = frameStartX + firstHoleIndex * pitch;
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
  const dxRowGap = 0;
  const dxBarHeight = Math.max(1, filmEdgePxPerMmY * 1.15);
  const dxCodeHeight = dxBarHeight * 2 + dxRowGap;
  const bottomDxY = showMarkings
    ? outputHeight - dxCodeHeight
    : 0;
  const bottomMarkingY = showMarkings
    ? outputHeight - edgeTextHeight - Math.max(1, filmEdgePxPerMmY * 0.08)
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
    perforationsPerFrame,
    firstHoleIndex,
    frameStartX,
    startX,
    topY,
    bottomY,
    topMarkingY,
    topTextY,
    bottomMarkingY,
    bottomDxY,
    edgeTextPixelSize,
    frameNumberPixelSize,
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

function mixColor(a, b, amount) {
  const t = clamp(amount, 0, 1);
  const keep = 1 - t;
  return [
    clamp(Math.round(a[0] * keep + b[0] * t), 0, 255),
    clamp(Math.round(a[1] * keep + b[1] * t), 0, 255),
    clamp(Math.round(a[2] * keep + b[2] * t), 0, 255),
    clamp(Math.round((a[3] ?? 255) * keep + (b[3] ?? 255) * t), 0, 255)
  ];
}

function hashNoise(x, y, seed = NATURAL_FILM_TEXTURE_SEED) {
  let value = Math.imul(Math.round(x), 374761393)
    ^ Math.imul(Math.round(y), 668265263)
    ^ Math.imul(seed, 1442695041);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function smoothNoise(x, y, scale, seed) {
  const sx = Math.floor(x / scale), sy = Math.floor(y / scale);
  const fx = x / scale - sx, fy = y / scale - sy;
  const tx = fx * fx * (3 - 2 * fx), ty = fy * fy * (3 - 2 * fy);
  const a = hashNoise(sx, sy, seed) * (1 - tx) + hashNoise(sx + 1, sy, seed) * tx;
  const b = hashNoise(sx, sy + 1, seed) * (1 - tx) + hashNoise(sx + 1, sy + 1, seed) * tx;
  return a * (1 - ty) + b * ty;
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
  const phaseStartX = metrics.frameStartX ?? metrics.startX;
  const frameShade = Math.sin(((x - phaseStartX) / framePitch) * Math.PI * 2) * 0.55;
  const sprocketShade = Math.sin(((x - phaseStartX) / Math.max(1, metrics.pitch)) * Math.PI * 2) * 0.12;
  const coarse = smoothNoise(x, y, 18, NATURAL_FILM_TEXTURE_SEED + 19) - 0.5;
  const fine = hashNoise(x, y, NATURAL_FILM_TEXTURE_SEED + 31) - 0.5;
  const density = 1.5 + radial * 3.5 + outerEdge * 2.6 + frameShade + sprocketShade + coarse * 6 + fine * 2.4;

  return [
    clamp(Math.round(filmColor[0] + density), 0, 255),
    clamp(Math.round(filmColor[1] + density * 0.9), 0, 255),
    clamp(Math.round(filmColor[2] + density * 0.62), 0, 255),
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

function copyPhotoRegion(data, metrics, imageData) {
  const src = imageData.data;
  for (let y = 0; y < metrics.sourceHeight; y++) {
    const srcOffset = y * metrics.sourceWidth * 4;
    const dstOffset = ((y + metrics.bandHeight) * metrics.outputWidth + metrics.sideMargin) * 4;
    data.set(src.subarray(srcOffset, srcOffset + metrics.sourceWidth * 4), dstOffset);
  }
}

function clearPhotoRegion(data, metrics) {
  for (let y = 0; y < metrics.sourceHeight; y++) {
    const dstOffset = ((y + metrics.bandHeight) * metrics.outputWidth + metrics.sideMargin) * 4;
    data.fill(0, dstOffset, dstOffset + metrics.sourceWidth * 4);
  }
}

function paintSprocketHole(data, metrics, left, top, fill) {
  // 薄い打ち抜き縁。立体的なベベルではなく、走査時の柔らかい境界を描く。
  const softness = Math.max(0.65, metrics.mm * 0.035);
  const rectLeft = Math.max(0, Math.floor(left - softness));
  const rectTop = Math.max(0, Math.floor(top - softness));
  const rectRight = Math.min(metrics.outputWidth, Math.ceil(left + metrics.holeWidth + softness));
  const rectBottom = Math.min(metrics.outputHeight, Math.ceil(top + metrics.holeHeight + softness));
  for (let y = rectTop; y < rectBottom; y++) {
    for (let x = rectLeft; x < rectRight; x++) {
      const edgeVariation = (smoothNoise(x / metrics.mm, y / metrics.mm, 0.2, 8107) - 0.5) * metrics.mm * 0.025;
      const distance = roundedRectDistance(x + 0.5, y + 0.5, left, top, metrics.holeWidth, metrics.holeHeight, metrics.holeRadius) + edgeVariation;
      const coverage = clamp(0.5 - distance / (softness * 2), 0, 1);
      if (coverage === 0) continue;
      const i = (y * metrics.outputWidth + x) * 4;
      if (fill[3] === 0) {
        data[i + 3] = Math.round(data[i + 3] * (1 - coverage));
        if (coverage === 1) data.fill(0, i, i + 3);
      } else {
        for (let c = 0; c < 4; c++) data[i + c] = Math.round(data[i + c] * (1 - coverage) + fill[c] * coverage);
      }
    }
  }
}

function forEachSprocketHole(metrics, callback) {
  for (let i = 0; i < metrics.holeCount; i++) {
    const holeIndex = (metrics.firstHoleIndex || 0) + i;
    const left = (metrics.frameStartX ?? metrics.startX) + holeIndex * metrics.pitch;
    callback(left, metrics.topY, holeIndex);
    callback(left, metrics.bottomY, holeIndex);
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

function getSprocketBandClip(metrics, top) {
  return top < metrics.bandHeight
    ? { top: 0, bottom: metrics.bandHeight }
    : { top: metrics.bottomBandTop, bottom: metrics.outputHeight };
}

function paintSprocketGlow(data, metrics, left, top, fill, strength = 1) {
  const amount = clamp(Number(strength) || 0, 0, 2);
  if (amount <= 0) return;
  // 拡張した孔マスクの二段階の羽根ぼかし。外側の低密度ハローと内側の暖色芯を分ける。
  const sigma = Math.max(1, metrics.mm * (0.42 + amount * 0.15));
  const spread = Math.ceil(sigma * 3.5);
  const core = mixColor(fill, [255, 235, 155, fill[3]], 0.35);
  const bandClip = getSprocketBandClip(metrics, top);
  const rectLeft = Math.max(0, Math.round(left - spread));
  const rectTop = Math.max(bandClip.top, Math.round(top - spread));
  const rectRight = Math.min(metrics.outputWidth, Math.round(left + metrics.holeWidth + spread));
  const rectBottom = Math.min(bandClip.bottom, Math.round(top + metrics.holeHeight + spread));

  for (let y = rectTop; y < rectBottom; y++) {
    for (let x = rectLeft; x < rectRight; x++) {
      const distance = roundedRectDistance(
        x + 0.5, y + 0.5,
        left, top, metrics.holeWidth, metrics.holeHeight, metrics.holeRadius
      );
      if (distance < 0 || distance > spread) continue;
      const d = Math.max(0, distance - metrics.mm * 0.18);
      const localExposure = 0.92 + (smoothNoise(x / metrics.mm, y / metrics.mm, 1.1, 914) - 0.5) * 0.3;
      const inner = Math.exp(-(d * d) / (2 * sigma * sigma));
      const outer = Math.exp(-(d * d) / (4 * sigma * sigma));
      const index = (y * metrics.outputWidth + x) * 4;
      addPixel(data, index, fill, outer * amount * 0.16 * localExposure);
      addPixel(data, index, core, inner * amount * 0.54 * localExposure);
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
  let cursorX = x;
  if (align === 'center') cursorX -= measured / 2;
  if (align === 'right') cursorX -= measured;

  const rectangles = [];
  for (const char of safeText) {
    const rows = getGlyphRows(char);
    for (let row = 0; row < rows.length; row++) {
      for (let col = 0; col < rows[row].length; col++) {
        if (rows[row][col] !== '1') continue;
        rectangles.push([cursorX + col * scale, y + row * scale, scale, scale]);
      }
    }
    cursorX += 6 * scale;
  }
  paintMarkingRectangles(data, metrics, rectangles, fill);
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

// 文字とバーコードを一枚の露光マスクにしてから走査の柔らかさを付ける。
// 隣接する筆画を加算しないので、交点だけ黄色く発光することがない。
function softenMarkingMask(mask, width, height, sigma) {
  const radius = Math.max(1, Math.ceil(sigma * 2.5));
  const kernel = Array.from({ length: radius * 2 + 1 }, (_, i) => Math.exp(-((i - radius) ** 2) / (2 * sigma * sigma)));
  const total = kernel.reduce((a, b) => a + b, 0);
  for (let i = 0; i < kernel.length; i++) kernel[i] /= total;
  const horizontal = new Float32Array(mask.length), result = new Float32Array(mask.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let value = 0;
    for (let k = -radius; k <= radius; k++) if (x + k >= 0 && x + k < width) value += mask[y * width + x + k] * kernel[k + radius];
    horizontal[y * width + x] = value;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let value = 0;
    for (let k = -radius; k <= radius; k++) if (y + k >= 0 && y + k < height) value += horizontal[(y + k) * width + x] * kernel[k + radius];
    result[y * width + x] = value;
  }
  return result;
}

function compositeMarkingMask(data, metrics, mask, width, height, left, top, fill) {
  const softened = softenMarkingMask(mask, width, height, Math.max(0.38, metrics.mm * 0.026));
  const glow = metrics.edgeOverexposed ? metrics.edgeOverexposureStrength : 0;
  const core = mixColor(fill, [255, 232, 125, fill[3]], glow * 0.22);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const px = left + x, py = top + y;
    if (px < 0 || px >= metrics.outputWidth || py < 0 || py >= metrics.outputHeight) continue;
    const coverage = softened[y * width + x];
    if (coverage < 0.002) continue;
    const density = 0.88 + (smoothNoise(px / metrics.mm, py / metrics.mm, 0.27, 4501) - 0.5) * 0.14;
    blendPixel(data, (py * metrics.outputWidth + px) * 4, core, coverage * density);
  }
}

function paintMarkingRectangles(data, metrics, rectangles, fill) {
  if (!rectangles.length) return;
  const pad = Math.ceil(Math.max(0.38, metrics.mm * 0.026) * 2.5) + 1;
  const left = Math.max(-pad, Math.floor(Math.min(...rectangles.map(r => r[0]))) - pad);
  const top = Math.max(-pad, Math.floor(Math.min(...rectangles.map(r => r[1]))) - pad);
  const right = Math.min(metrics.outputWidth + pad, Math.ceil(Math.max(...rectangles.map(r => r[0] + r[2]))) + pad);
  const bottom = Math.min(metrics.outputHeight + pad, Math.ceil(Math.max(...rectangles.map(r => r[1] + r[3]))) + pad);
  const width = right - left, height = bottom - top;
  if (width <= 0 || height <= 0) return;
  const mask = new Float32Array(width * height);
  for (const [rx, ry, rw, rh] of rectangles) {
    for (let y = Math.max(top, Math.floor(ry)); y < Math.min(bottom, Math.ceil(ry + rh)); y++) {
      for (let x = Math.max(left, Math.floor(rx)); x < Math.min(right, Math.ceil(rx + rw)); x++) {
        const coverage = Math.max(0, Math.min(x + 1, rx + rw) - Math.max(x, rx)) * Math.max(0, Math.min(y + 1, ry + rh) - Math.max(y, ry));
        const i = (y - top) * width + x - left;
        mask[i] = Math.min(1, mask[i] + coverage);
      }
    }
  }
  compositeMarkingMask(data, metrics, mask, width, height, left, top, fill);
}

function compositeExposedMask(data, metrics, maskPixels, maskWidth, maskHeight, dstLeft, dstTop, fill) {
  const mask = new Float32Array(maskWidth * maskHeight);
  for (let i = 0; i < mask.length; i++) mask[i] = maskPixels[i * 4 + 3] / 255;
  compositeMarkingMask(data, metrics, mask, maskWidth, maskHeight, dstLeft, dstTop, fill);
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
  textCtx.fillStyle = 'rgba(255, 255, 255, 1)';
  textCtx.fillText(safeText, 3, 0);

  const textPixels = textCtx.getImageData(0, 0, textWidth, textHeight).data;
  let dstLeft = Math.round(x);
  if (align === 'center') dstLeft -= Math.round(textWidth / 2);
  if (align === 'right') dstLeft -= textWidth;
  const dstTop = Math.round(y);

  compositeExposedMask(data, metrics, textPixels, textWidth, textHeight, dstLeft, dstTop, fill, pixelSize);
  return true;
}

function drawEdgeText(data, metrics, edge, text, x, y, pixelSize, align = 'left', fill = edge.letteringColor) {
  if (edge.fontStyle === 'edgePixel') {
    const scale = pixelSize / 7;
    drawBitmapText(data, metrics, text, x, y, scale, fill, align);
    return;
  }

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
  const scale = pixelSize / 7;
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
  // ISO 1007 parity: the parity bit equals the number of set data bits
  // (product, generation, frame number and half-frame flag) modulo 2.
  const setBits = (value) => {
    let count = 0;
    for (let v = value; v > 0; v >>= 1) count += v & 1;
    return count;
  };
  const dataBitCount = setBits(edge.dx1) + setBits(edge.dx2) + setBits(clampInt(edge.frameNumber, 0, 63)) + aFlag;
  if (dataBitCount % 2 === 1) add(26, 1);

  add(29, 0);
  add(28, 1);
  add(30, 1);
  return blocks;
}

function getEdgeFramePitch(metrics) {
  return metrics.pitch * THIRTY_FIVE_MM_SPROCKET_SPEC.perforationsPerStillFrame;
}

function getFrameNumberAnchorX(metrics, edge) {
  return Math.round((metrics.frameStartX ?? metrics.startX) + metrics.holeWidth + (edge.frameNumberHole - 1) * metrics.pitch);
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

function paintDxSequence(data, metrics, edge, left, top, modulePitch, barWidth, blockHeight, rowPitch, aFlag, frameNumber) {
  if (!isHorizontallyVisible(metrics, left, modulePitch * DX_EDGE_COLUMN_COUNT)) return;
  const rectangles = buildDxEdgeCodeBlocks({ ...edge, frameNumber, aFlag }).map(block => [
    left + block.column * modulePitch, top + block.row * rowPitch, barWidth, blockHeight
  ]);
  paintMarkingRectangles(data, metrics, rectangles, edge.letteringColor);
}

function paintDxEdgeCode(data, metrics, edge) {
  const codeWidth = Math.max(
    DX_EDGE_COLUMN_COUNT,
    Math.round(DX_EDGE_CODE_WIDTH_MM * metrics.imagePxPerMmX)
  );
  const modulePitch = codeWidth / DX_EDGE_COLUMN_COUNT;
  const barWidth = modulePitch * 0.96;
  const blockHeight = Math.max(1, metrics.dxBarHeight || Math.round(metrics.filmEdgePxPerMmY * 0.78));
  const rowGap = metrics.dxRowGap;
  const rowPitch = blockHeight + rowGap;
  const top = clamp(
    metrics.bottomDxY,
    metrics.bottomBandTop,
    Math.max(metrics.bottomBandTop, metrics.outputHeight - (blockHeight * 2 + rowGap))
  );
  const dxOffset = Math.round(metrics.pitch - metrics.imagePxPerMmX * 0.5);

  forEachVisibleFrameRepeat(metrics, edge, (repeat) => {
    paintDxSequence(data, metrics, edge, repeat.mainX + dxOffset, top, modulePitch, barWidth, blockHeight, rowPitch, false, repeat.frameNumber);
    paintDxSequence(data, metrics, edge, repeat.halfX + dxOffset, top, modulePitch, barWidth, blockHeight, rowPitch, true, repeat.frameNumber);
  });
}

function getTriangleBarycentric(px, py, p0, p1, p2) {
  const area = (p1.y - p2.y) * (p0.x - p2.x) + (p2.x - p1.x) * (p0.y - p2.y);
  if (area === 0) return null;
  const a = ((p1.y - p2.y) * (px - p2.x) + (p2.x - p1.x) * (py - p2.y)) / area;
  const b = ((p2.y - p0.y) * (px - p2.x) + (p0.x - p2.x) * (py - p2.y)) / area;
  return { a, b, c: 1 - a - b };
}

function isInsideTriangle(px, py, p0, p1, p2) {
  const bary = getTriangleBarycentric(px, py, p0, p1, p2);
  return Boolean(bary && bary.a >= 0 && bary.b >= 0 && bary.c >= 0);
}

function getTriangleCoverage(x, y, p0, p1, p2) {
  let hits = 0;
  const samples = [0.25, 0.5, 0.75];
  for (const oy of samples) {
    for (const ox of samples) {
      if (isInsideTriangle(x + ox, y + oy, p0, p1, p2)) hits++;
    }
  }
  return hits / 9;
}

function paintExposedTriangle(data, metrics, p0, p1, p2, fill) {
  const pad = Math.ceil(metrics.mm * 0.08) + 2;
  const left = Math.floor(Math.min(p0.x, p1.x, p2.x)) - pad;
  const top = Math.floor(Math.min(p0.y, p1.y, p2.y)) - pad;
  const width = Math.ceil(Math.max(p0.x, p1.x, p2.x)) - left + pad;
  const height = Math.ceil(Math.max(p0.y, p1.y, p2.y)) - top + pad;
  const mask = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    mask[y * width + x] = getTriangleCoverage(left + x, top + y, p0, p1, p2);
  }
  compositeMarkingMask(data, metrics, mask, width, height, left, top, fill);
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
    paintExposedTriangle(
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
  const pixelSize = metrics.frameNumberPixelSize;
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
    const bandClip = getSprocketBandClip(metrics, top);
    const rectLeft = Math.max(0, Math.round(left - spread));
    const rectTop = Math.max(bandClip.top, Math.round(top - spread));
    const rectRight = Math.min(metrics.outputWidth, Math.round(left + metrics.holeWidth + spread));
    const rectBottom = Math.min(bandClip.bottom, Math.round(top + metrics.holeHeight + spread));

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
        const sourceXFloat = x - metrics.sideMargin;
        if (sourceXFloat < 0 || sourceXFloat >= metrics.sourceWidth) continue;
        const sourceX = clampInt(sourceXFloat, 0, metrics.sourceWidth - 1);
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
  forEachVisibleFrameRepeat(metrics, edge, (frame) => {
    drawEdgeText(
      data,
      metrics,
      edge,
      text,
      frame.mainX + getEdgeFramePitch(metrics) / 2,
      metrics.topTextY,
      pixelSize,
      'center'
    );
  });
}

function paintEdgeMarkings(data, metrics, edge) {
  if (edge.textEnabled) paintPhotoText(data, metrics, edge);
  if (edge.dxEnabled) paintDxEdgeCode(data, metrics, edge);
  if (edge.frameNumberEnabled) paintFrameNumberMarker(data, metrics, edge);
}

function createSprocketFrameImageData(imageData, options = {}, { includePhoto = true } = {}) {
  if (!imageData || !imageData.data || !imageData.width || !imageData.height) {
    throw new Error('ImageData is required to compose sprocket holes.');
  }

  const edge = getComposeEdgeMarkings(options);
  const metrics = getSprocketFrameMetrics(imageData.width, imageData.height, { edgeMarkings: edge });
  metrics.edgeOverexposureStrength = edge.overexposureStrength;
  metrics.edgeOverexposed = edge.overexposedSprockets;
  const filmColor = sanitizeColor(options.filmColor, DEFAULT_FILM_COLOR);
  const holeColor = options.transparentHoles === true
    ? [0, 0, 0, 0]
    : sanitizeColor(options.holeColor ?? edge.holeColor, DEFAULT_HOLE_COLOR);
  const output = new Uint8ClampedArray(metrics.outputWidth * metrics.outputHeight * 4);

  fillFilmBase(output, metrics, filmColor);

  if (edge.overexposedSprockets) {
    paintSprocketTextureSmear(output, metrics, imageData, edge.overexposureStrength);
    paintOverexposedSprockets(output, metrics, edge.overexposureColor);
  }
  paintEdgeMarkings(output, metrics, edge);
  // バーコードは孔の外に隔離せず外縁まで印字し、打ち抜き部分を最後に抜く。
  paintSprocketRows(output, metrics, holeColor);
  if (includePhoto) {
    // Hard guardrail: edge effects are allowed to touch only the added film border.
    copyPhotoRegion(output, metrics, imageData);
  } else {
    clearPhotoRegion(output, metrics);
  }

  return new ImageData(output, metrics.outputWidth, metrics.outputHeight);
}

function isPortrait(imageData) {
  return imageData && imageData.height > imageData.width;
}

function rotateImageData90(imageData) {
  // Rotate 90° clockwise: landscape → portrait, or portrait → landscape
  const srcW = imageData.width, srcH = imageData.height;
  const dstW = srcH, dstH = srcW;
  const src = imageData.data;
  const dst = new Uint8ClampedArray(dstW * dstH * 4);
  for (let y = 0; y < srcH; y++) {
    for (let x = 0; x < srcW; x++) {
      const si = (y * srcW + x) * 4;
      const di = ((x) * dstW + (dstW - 1 - y)) * 4;
      dst[di] = src[si]; dst[di + 1] = src[si + 1];
      dst[di + 2] = src[si + 2]; dst[di + 3] = src[si + 3];
    }
  }
  return new ImageData(dst, dstW, dstH);
}

function rotateImageData270(imageData) {
  // Rotate 270° clockwise (90° counter-clockwise)
  // Source (x,y) → Destination (dstH-1-x, y)
  const srcW = imageData.width, srcH = imageData.height;
  const dstW = srcH, dstH = srcW;
  const src = imageData.data;
  const dst = new Uint8ClampedArray(dstW * dstH * 4);
  for (let y = 0; y < srcH; y++) {
    for (let x = 0; x < srcW; x++) {
      const si = (y * srcW + x) * 4;
      const di = ((dstH - 1 - x) * dstW + y) * 4;
      dst[di] = src[si]; dst[di + 1] = src[si + 1];
      dst[di + 2] = src[si + 2]; dst[di + 3] = src[si + 3];
    }
  }
  return new ImageData(dst, dstW, dstH);
}

export function composeSprocketFrame(imageData, options = {}) {
  if (isPortrait(imageData)) {
    const rotated = rotateImageData90(imageData);
    const framed = createSprocketFrameImageData(rotated, options, { includePhoto: true });
    return rotateImageData270(framed);
  }
  return createSprocketFrameImageData(imageData, options, { includePhoto: true });
}

export function composeSprocketFrameBackground(imageData, options = {}) {
  if (isPortrait(imageData)) {
    const rotated = rotateImageData90(imageData);
    const framed = createSprocketFrameImageData(rotated, options, { includePhoto: false });
    return rotateImageData270(framed);
  }
  return createSprocketFrameImageData(imageData, options, { includePhoto: false });
}

export function hasSprocketFrameEnabled(settings) {
  return Boolean(settings && (
    settings.sprocketHolesEnabled
    || settings.sprocketPreviewEnabled
    || settings.exportSprocketHolesEnabled
  ));
}

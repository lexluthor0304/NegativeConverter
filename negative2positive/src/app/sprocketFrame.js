import {
  NATIVE_PIXEL_SIZE, nativePixelFontLocale, nativePixelFontFamily,
  hasNativePixelGlyph, isNativePixelFontReady, ensureNativePixelFont
} from './nativePixelFont.js';
import { edgeMarkingStyle, edgeTextForFrame, normalizeEdgeStyleId, EDGE_STYLE_AUTO, EDGE_STYLE_PLAIN } from './edgeMarkingStyles.js';
import { rasterizeEdgeGlyph, rasterizeEdgeShape, fujiOutlineArrow, hasEdgeGlyphs, edgeGlyphText, edgeGlyphAdvance } from './edgeGlyphs.js';

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
  overexposureColor: '#ed9c00',
  // A setting without a style is drawn as it always was.
  style: 'custom'
});

const FONT_STYLE_OPTIONS = new Set(['edgePixel', 'monoBold', 'mono', 'sansBold', 'serif']);

const CANVAS_FONT_STYLES = Object.freeze({
  monoBold: { family: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', weight: '700' },
  mono: { family: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', weight: '500' },
  sansBold: { family: 'Inter, Arial, sans-serif', weight: '700' },
  serif: { family: 'Georgia, Times, serif', weight: '700' }
});

export const BITMAP_FONT = Object.freeze({
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
    text: Array.from(String(source.text ?? defaults.text)).slice(0, 48).join(''),
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
    fontLocale: nativePixelFontLocale(source.fontLocale),
    holeColor: sanitizeColor(source.holeColor ?? defaults.holeColor, DEFAULT_HOLE_COLOR),
    letteringColor: sanitizeColor(source.letteringColor ?? defaults.letteringColor, DEFAULT_MARKING_COLOR),
    overexposureColor: sanitizeColor(source.overexposureColor ?? defaults.overexposureColor, DEFAULT_OVEREXPOSURE_COLOR),
    style: normalizeEdgeStyleId(source.style ?? defaults.style)
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

/**
 * Where a width x height photo sits in its film-border frame, portrait photos
 * included (composeSprocketFrame turns them, frames them and turns them
 * back): the frame's size and the photo's rectangle inside it.
 */
export function getSprocketFrameLayout(width, height, options = {}) {
  const portrait = Number(height) > Number(width);
  const metrics = portrait
    ? getSprocketFrameMetrics(height, width, options)
    : getSprocketFrameMetrics(width, height, options);
  return {
    frameWidth: portrait ? metrics.outputHeight : metrics.outputWidth,
    frameHeight: portrait ? metrics.outputWidth : metrics.outputHeight,
    x: portrait ? metrics.bandHeight : metrics.sideMargin,
    y: portrait ? metrics.sideMargin : metrics.bandHeight,
    width: portrait ? metrics.sourceHeight : metrics.sourceWidth,
    height: portrait ? metrics.sourceWidth : metrics.sourceHeight
  };
}

function blendPixel(data, index, fill, alpha) {
  blendChannels(data, index, fill[0], fill[1], fill[2], fill[3], alpha);
}

// blendPixel with the colour as four numbers: a loop that blends a pixel of
// another image need not build an array for each one.
function blendChannels(data, index, red, green, blue, opacity, alpha) {
  const amount = clamp(alpha, 0, 1);
  const keep = 1 - amount;
  data[index] = Math.round(data[index] * keep + red * amount);
  data[index + 1] = Math.round(data[index + 1] * keep + green * amount);
  data[index + 2] = Math.round(data[index + 2] * keep + blue * amount);
  data[index + 3] = Math.max(data[index + 3], Math.round(opacity * amount));
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

// smoothNoise(x / divisor, y / divisor, scale, seed) for every x of [x0, x1),
// one row at a time: `row(y)` returns the row's values (indexed x - x0) in a
// buffer it reuses. The same arithmetic per pixel; what depends on the column
// is computed once, and the lattice hashes once per lattice row instead of
// four per pixel.
function smoothNoiseRows(x0, x1, divisor, scale, seed) {
  const count = Math.max(0, x1 - x0);
  const cell = new Int32Array(count), weight = new Float64Array(count), rest = new Float64Array(count);
  let first = 0, last = -1;
  for (let i = 0; i < count; i++) {
    const u = (x0 + i) / divisor;
    const sx = Math.floor(u / scale), fx = u / scale - sx;
    if (i === 0) first = sx;
    last = sx;
    cell[i] = sx;
    weight[i] = fx * fx * (3 - 2 * fx);
    rest[i] = 1 - weight[i];
  }
  for (let i = 0; i < count; i++) cell[i] -= first;
  const cells = Math.max(0, last - first) + 2;
  const upper = new Float64Array(cells), lower = new Float64Array(cells), values = new Float64Array(count);
  let latticeRow = NaN;
  return (y) => {
    const v = y / divisor;
    const sy = Math.floor(v / scale), fy = v / scale - sy;
    const ty = fy * fy * (3 - 2 * fy), restY = 1 - ty;
    if (sy !== latticeRow) {
      for (let i = 0; i < cells; i++) { upper[i] = hashNoise(first + i, sy, seed); lower[i] = hashNoise(first + i, sy + 1, seed); }
      latticeRow = sy;
    }
    for (let i = 0; i < count; i++) {
      const c = cell[i], tx = weight[i], restX = rest[i];
      const a = upper[c] * restX + upper[c + 1] * tx;
      const b = lower[c] * restX + lower[c + 1] * tx;
      values[i] = a * restY + b * ty;
    }
    return values;
  };
}

// hashNoise's term of a seed, and the hash of integer coordinates with it.
function noiseSeedTerm(seed) {
  return Math.imul(seed, 1442695041);
}

function hashNoiseAt(x, y, seedTerm) {
  let value = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ seedTerm;
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

// The film base: a dark, slightly uneven density over the whole border. Each
// pixel's value is the sum filmBasePixel computed (radial falloff, the outer
// edge of the bands, a shade per frame and per perforation, coarse and fine
// noise), term by term and in the same order, so the bytes are the same.
// What depends on the column or on the row alone is computed once per column
// or row, and the coarse noise's four lattice hashes once per lattice cell
// instead of once per pixel. One step per row.
function* fillFilmBaseSteps(data, metrics, filmColor, interiorSpans = []) {
  const outputWidth = metrics.outputWidth, outputHeight = metrics.outputHeight;
  // The whole frame in the film colour first, as one 32-bit fill where the
  // platform is little-endian (every one the app runs on).
  const packed = new Uint8ClampedArray([filmColor[0], filmColor[1], filmColor[2], filmColor[3]]);
  if (data.byteOffset % 4 === 0 && new Uint8Array(new Uint32Array([1]).buffer)[0] === 1) {
    const words = new Uint32Array(data.buffer, data.byteOffset, data.length >> 2), word = new Uint32Array(packed.buffer)[0];
    for (let from = 0; from < words.length; from += 4194304) {
      words.fill(word, from, Math.min(words.length, from + 4194304));
      yield;
    }
  } else {
    for (let i = 0; i < data.length; i += 4) { data[i] = packed[0]; data[i + 1] = packed[1]; data[i + 2] = packed[2]; data[i + 3] = packed[3]; }
    yield;
  }

  const cx = outputWidth / 2, cy = outputHeight / 2;
  const framePitch = Math.max(1, getEdgeFramePitch(metrics));
  const phaseStartX = metrics.frameStartX ?? metrics.startX;
  const pitch = Math.max(1, metrics.pitch);
  const COARSE = 18;
  const coarseSeed = noiseSeedTerm(NATURAL_FILM_TEXTURE_SEED + 19), fineSeed = noiseSeedTerm(NATURAL_FILM_TEXTURE_SEED + 31);
  const nxSquared = new Float64Array(outputWidth), shade = new Float64Array(outputWidth), sprocketShade = new Float64Array(outputWidth);
  const cell = new Int32Array(outputWidth), weight = new Float64Array(outputWidth), rest = new Float64Array(outputWidth);
  for (let x = 0; x < outputWidth; x++) {
    const nx = Math.abs((x + 0.5 - cx) / Math.max(1, cx));
    nxSquared[x] = nx * nx;
    shade[x] = Math.sin(((x - phaseStartX) / framePitch) * Math.PI * 2) * 0.55;
    sprocketShade[x] = Math.sin(((x - phaseStartX) / pitch) * Math.PI * 2) * 0.12;
    const sx = Math.floor(x / COARSE), fx = x / COARSE - sx;
    cell[x] = sx;
    weight[x] = fx * fx * (3 - 2 * fx);
    rest[x] = 1 - weight[x];
  }
  const cells = Math.floor((outputWidth - 1) / COARSE) + 2;
  const upper = new Float64Array(cells), lower = new Float64Array(cells);
  let latticeRow = NaN;
  const red = filmColor[0], green = filmColor[1], blue = filmColor[2], opacity = filmColor[3];

  const paintSpan = function* (left, top, width, height) {
    const x0 = Math.max(0, left), right = Math.min(outputWidth, left + width);
    const bottom = Math.min(outputHeight, top + height);
    for (let y = Math.max(0, top); y < bottom; y++) {
      const ny = Math.abs((y + 0.5 - cy) / Math.max(1, cy));
      const nySquared = ny * ny;
      const inTopBand = y < metrics.bandHeight;
      const inBottomBand = y >= metrics.bottomBandTop;
      const bandDepth = inTopBand
        ? y / Math.max(1, metrics.bandHeight)
        : (inBottomBand ? (outputHeight - y - 1) / Math.max(1, metrics.bandHeight) : 0.48);
      const outerEdge = inTopBand || inBottomBand ? 1 - clamp(bandDepth, 0, 1) : 0.22;
      const sy = Math.floor(y / COARSE), fy = y / COARSE - sy;
      const ty = fy * fy * (3 - 2 * fy), restY = 1 - ty;
      if (sy !== latticeRow) {
        for (let i = 0; i < cells; i++) { upper[i] = hashNoiseAt(i, sy, coarseSeed); lower[i] = hashNoiseAt(i, sy + 1, coarseSeed); }
        latticeRow = sy;
      }
      let index = (y * outputWidth + x0) * 4;
      for (let x = x0; x < right; x++, index += 4) {
        const radial = clamp((nxSquared[x] + nySquared) * 0.9, 0, 1);
        const sx = cell[x], tx = weight[x], restX = rest[x];
        const a = upper[sx] * restX + upper[sx + 1] * tx;
        const b = lower[sx] * restX + lower[sx + 1] * tx;
        const coarse = (a * restY + b * ty) - 0.5;
        const fine = hashNoiseAt(x, y, fineSeed) - 0.5;
        const density = 1.5 + radial * 3.5 + outerEdge * 2.6 + shade[x] + sprocketShade[x] + coarse * 6 + fine * 2.4;
        // A clamped array clamps the rounded value as clamp(…, 0, 255) did.
        data[index] = Math.round(red + density);
        data[index + 1] = Math.round(green + density * 0.9);
        data[index + 2] = Math.round(blue + density * 0.62);
        data[index + 3] = opacity;
      }
      yield;
    }
  };

  yield* paintSpan(0, 0, outputWidth, metrics.bandHeight);
  yield* paintSpan(0, metrics.bottomBandTop, outputWidth, outputHeight - metrics.bottomBandTop);
  if (metrics.sideMargin > 0) {
    const middleTop = metrics.bandHeight;
    const middleHeight = metrics.sourceHeight;
    yield* paintSpan(0, middleTop, metrics.sideMargin, middleHeight);
    yield* paintSpan(metrics.sideMargin + metrics.sourceWidth, middleTop, metrics.sideMargin, middleHeight);
  }
  // A strip's film between and around its pictures.
  for (const span of interiorSpans) yield* paintSpan(span.left, metrics.bandHeight, span.width, metrics.sourceHeight);
}

// Rows of a plain copy between two steps: about 4 MB.
function rowsPerStep(rowBytes) {
  return Math.max(1, Math.floor(4194304 / Math.max(1, rowBytes)));
}

function* copyPhotoRegionSteps(data, metrics, imageData) {
  const src = imageData.data, rowBytes = metrics.sourceWidth * 4, chunk = rowsPerStep(rowBytes);
  for (let y = 0; y < metrics.sourceHeight; y++) {
    const srcOffset = y * rowBytes;
    const dstOffset = ((y + metrics.bandHeight) * metrics.outputWidth + metrics.sideMargin) * 4;
    data.set(src.subarray(srcOffset, srcOffset + rowBytes), dstOffset);
    if (y % chunk === chunk - 1) yield;
  }
}

function* clearPhotoRegionSteps(data, metrics) {
  const rowBytes = metrics.sourceWidth * 4, chunk = rowsPerStep(rowBytes);
  for (let y = 0; y < metrics.sourceHeight; y++) {
    const dstOffset = ((y + metrics.bandHeight) * metrics.outputWidth + metrics.sideMargin) * 4;
    data.fill(0, dstOffset, dstOffset + rowBytes);
    if (y % chunk === chunk - 1) yield;
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

// Every hole as [left, top], the upper row's and the lower row's in turn.
function sprocketHoles(metrics) {
  const holes = [];
  for (let i = 0; i < metrics.holeCount; i++) {
    const holeIndex = (metrics.firstHoleIndex || 0) + i;
    const left = (metrics.frameStartX ?? metrics.startX) + holeIndex * metrics.pitch;
    holes.push([left, metrics.topY], [left, metrics.bottomY]);
  }
  return holes;
}

function roundedRectDistance(px, py, left, top, width, height, radius) {
  const centerX = left + width / 2;
  const centerY = top + height / 2;
  const qx = Math.abs(px - centerX) - (width / 2 - radius);
  const qy = Math.abs(py - centerY) - (height / 2 - radius);
  // Math.hypot(a, 0) is a itself: only a point beyond a corner needs the
  // root, and every other point (most of them) skips it for the same value.
  const outside = qx <= 0 ? Math.max(qy, 0) : qy <= 0 ? qx : Math.hypot(qx, qy);
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - radius;
}

function getSprocketBandClip(metrics, top) {
  return top < metrics.bandHeight
    ? { top: 0, bottom: metrics.bandHeight }
    : { top: metrics.bottomBandTop, bottom: metrics.outputHeight };
}

function* paintSprocketGlowSteps(data, metrics, left, top, fill, strength = 1) {
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

  const noiseRow = smoothNoiseRows(rectLeft, rectRight, metrics.mm, 1.1, 914);
  for (let y = rectTop; y < rectBottom; y++) {
    const noise = noiseRow(y);
    for (let x = rectLeft; x < rectRight; x++) {
      const distance = roundedRectDistance(
        x + 0.5, y + 0.5,
        left, top, metrics.holeWidth, metrics.holeHeight, metrics.holeRadius
      );
      if (distance < 0 || distance > spread) continue;
      const d = Math.max(0, distance - metrics.mm * 0.18);
      const localExposure = 0.92 + (noise[x - rectLeft] - 0.5) * 0.3;
      const inner = Math.exp(-(d * d) / (2 * sigma * sigma));
      const outer = Math.exp(-(d * d) / (4 * sigma * sigma));
      const index = (y * metrics.outputWidth + x) * 4;
      addPixel(data, index, fill, outer * amount * 0.16 * localExposure);
      addPixel(data, index, core, inner * amount * 0.54 * localExposure);
    }
    if ((y & 31) === 31) yield;
  }
}

function* paintSprocketRowsSteps(data, metrics, fill) {
  for (const [left, top] of sprocketHoles(metrics)) {
    paintSprocketHole(data, metrics, left, top, fill);
    yield;
  }
}

function* paintOverexposedSprocketsSteps(data, metrics, fill) {
  for (const [left, top] of sprocketHoles(metrics)) {
    yield* paintSprocketGlowSteps(data, metrics, left, top, fill, metrics.edgeOverexposureStrength);
    yield;
  }
}

const unicodeBitmapGlyphs = new Map();
const pendingGlyphRows = Array(NATIVE_PIXEL_SIZE).fill('0'.repeat(NATIVE_PIXEL_SIZE));

function needsNativePixelFont(options) {
  const edge = getComposeEdgeMarkings(options);
  return edge.fontStyle === 'edgePixel' && edge.textEnabled
    && Array.from(edge.text.toUpperCase()).some(char => !BITMAP_FONT[char] && hasNativePixelGlyph(char));
}

export function areSprocketFrameFontsReady(options = {}) {
  return !needsNativePixelFont(options) || isNativePixelFontReady(getComposeEdgeMarkings(options).fontLocale);
}

export async function ensureSprocketFrameFonts(options = {}) {
  if (needsNativePixelFont(options)) await ensureNativePixelFont(getComposeEdgeMarkings(options).fontLocale);
}

function getGlyphRows(char, fontLocale) {
  if (BITMAP_FONT[char]) return BITMAP_FONT[char];
  const native = hasNativePixelGlyph(char);
  // A temporary blank must never be cached as the final glyph.
  if (native && !isNativePixelFontReady(fontLocale)) return pendingGlyphRows;
  const family = native ? nativePixelFontFamily(fontLocale) : 'sans-serif';
  const key = `${family}\0${char}`;
  if (unicodeBitmapGlyphs.has(key)) return unicodeBitmapGlyphs.get(key);

  // Fusion Pixel's outlines use a 100-unit grid at 1200 units/em. At 12px,
  // each designed pixel is exactly one canvas pixel. Keep the native grid:
  // no fitting transforms, fractional origins, or synthetic font weights.
  // Rare characters outside the bundled cmap retain the previous system-font
  // fallback instead of regressing to question marks. It is never used for a
  // supported native glyph, including while its font is still loading.
  const size = native ? NATIVE_PIXEL_SIZE : 16;
  const canvas = createTextCanvas(size, size);
  const ctx = canvas?.getContext('2d');
  if (!ctx || typeof ctx.measureText !== 'function' || typeof ctx.getImageData !== 'function') {
    return BITMAP_FONT['?'];
  }
  const font = `400 ${size}px ${native ? `"${family}"` : family}`;
  ctx.font = font;
  ctx.textBaseline = 'alphabetic';
  const measured = ctx.measureText(char);
  // Native coordinates are integers; browser text metrics can return values
  // like 10.0000019. Ceil would add a spurious row and shrink the whole glyph.
  const snap = native ? Math.round : Math.ceil;
  const left = snap(measured.actualBoundingBoxLeft ?? 0);
  const right = snap(measured.actualBoundingBoxRight ?? measured.width);
  const ascent = snap(measured.actualBoundingBoxAscent ?? size);
  const descent = snap(measured.actualBoundingBoxDescent ?? 0);
  const height = Math.max(size, Math.ceil(ascent) + Math.ceil(descent));
  const width = Math.max(1, Math.ceil(measured.width), Math.ceil(left) + Math.ceil(right));
  canvas.width = width;
  canvas.height = height;
  ctx.font = font;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#fff';
  ctx.fillText(char, Math.max(0, Math.ceil(left)), Math.floor((height - Math.ceil(ascent) - Math.ceil(descent)) / 2) + Math.ceil(ascent));
  const pixels = ctx.getImageData(0, 0, width, height).data;
  const rows = Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => (
    pixels[(y * width + x) * 4 + 3] >= 128 ? '1' : '0'
  )).join(''));
  // Bound the cache when users repeatedly edit labels or font families.
  if (unicodeBitmapGlyphs.size >= 256) unicodeBitmapGlyphs.delete(unicodeBitmapGlyphs.keys().next().value);
  unicodeBitmapGlyphs.set(key, rows);
  return rows;
}

function drawBitmapText(data, metrics, text, x, y, scale, fill, align = 'left', fontLocale = 'sc') {
  const safeText = String(text || '').toUpperCase();
  if (!safeText || scale <= 0) return;

  const glyphs = Array.from(safeText, (char) => {
    const rows = getGlyphRows(char, fontLocale);
    const cellSize = scale * 7 / rows.length;
    return { rows, cellSize, width: rows[0].length * cellSize };
  });
  const measured = glyphs.reduce((sum, glyph) => sum + glyph.width + scale, -scale);
  let cursorX = x;
  if (align === 'center') cursorX -= measured / 2;
  if (align === 'right') cursorX -= measured;

  const rectangles = [];
  for (const { rows, cellSize, width } of glyphs) {
    for (let row = 0; row < rows.length; row++) {
      for (let col = 0; col < rows[row].length; col++) {
        if (rows[row][col] !== '1') continue;
        rectangles.push([cursorX + col * cellSize, y + row * cellSize, cellSize, cellSize]);
      }
    }
    cursorX += width + scale;
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
// Each sum runs over the same taps in the same order as before; rows of the
// mask that are empty are not summed (they add nothing), and the taps are a
// typed array. One step per 64 rows.
function* softenMarkingMaskSteps(mask, width, height, sigma) {
  const radius = Math.max(1, Math.ceil(sigma * 2.5));
  const weights = Array.from({ length: radius * 2 + 1 }, (_, i) => Math.exp(-((i - radius) ** 2) / (2 * sigma * sigma)));
  const total = weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < weights.length; i++) weights[i] /= total;
  const kernel = Float64Array.from(weights);
  const horizontal = new Float32Array(mask.length), result = new Float32Array(mask.length);
  // Rows with anything in them: the horizontal pass keeps a row's emptiness.
  const filled = new Uint8Array(height);
  for (let y = 0; y < height; y++) {
    const end = (y + 1) * width;
    for (let i = y * width; i < end; i++) if (mask[i] !== 0) { filled[y] = 1; break; }
  }
  // Tap by tap along a whole row: every pixel still adds its taps in the same
  // order, and the loops read and write memory in a straight line.
  const sums = new Float64Array(width);
  for (let y = 0; y < height; y++) {
    if (filled[y]) {
      const row = y * width;
      sums.fill(0);
      for (let k = -radius; k <= radius; k++) {
        const tap = kernel[k + radius], to = Math.min(width, width - k);
        for (let x = Math.max(0, -k); x < to; x++) sums[x] += mask[row + x + k] * tap;
      }
      horizontal.set(sums, row);
    }
    if ((y & 63) === 63) yield;
  }
  for (let y = 0; y < height; y++) {
    const from = Math.max(-radius, -y), to = Math.min(radius, height - 1 - y);
    let any = false;
    for (let k = from; k <= to; k++) if (filled[y + k]) { any = true; break; }
    if (any) {
      sums.fill(0);
      for (let k = from; k <= to; k++) {
        // An empty row adds nothing.
        if (!filled[y + k]) continue;
        const tap = kernel[k + radius], source = (y + k) * width;
        for (let x = 0; x < width; x++) sums[x] += horizontal[source + x] * tap;
      }
      result.set(sums, y * width);
    }
    if ((y & 63) === 63) yield;
  }
  return result;
}

function* compositeMarkingMaskSteps(data, metrics, mask, width, height, left, top, fill) {
  const softened = yield* softenMarkingMaskSteps(mask, width, height, Math.max(0.38, metrics.mm * 0.026));
  const glow = metrics.edgeOverexposed ? metrics.edgeOverexposureStrength : 0;
  const core = mixColor(fill, [255, 232, 125, fill[3]], glow * 0.22);
  // A brand style may print denser than the custom markings (Ilford's print
  // is clipped white on the reference scans).
  const inkDensity = metrics.styleInkDensity ?? 0.88;
  const firstX = Math.max(0, -left), endX = Math.min(width, metrics.outputWidth - left);
  const noiseRow = smoothNoiseRows(left + firstX, left + Math.max(firstX, endX), metrics.mm, 0.27, 4501);
  for (let y = 0; y < height; y++) {
    const py = top + y;
    if (py >= 0 && py < metrics.outputHeight) {
      let noise = null;
      for (let x = firstX; x < endX; x++) {
        const px = left + x;
        const coverage = softened[y * width + x];
        if (coverage < 0.002) continue;
        noise ??= noiseRow(py);
        const density = inkDensity + (noise[x - firstX] - 0.5) * 0.14;
        blendChannels(data, (py * metrics.outputWidth + px) * 4, core[0], core[1], core[2], core[3], coverage * density);
      }
    }
    if ((y & 63) === 63) yield;
  }
}

// While a frame is composed in steps, the markings stage only builds its
// masks: each composite is kept here, in order, and run in steps afterwards.
// The stage itself never yields, so two frames composed at once cannot mix
// their lists.
let deferredMarkings = null;

function compositeMarkingMask(data, metrics, mask, width, height, left, top, fill) {
  if (deferredMarkings) {
    deferredMarkings.push([data, metrics, mask, width, height, left, top, fill]);
    return;
  }
  for (const step of compositeMarkingMaskSteps(data, metrics, mask, width, height, left, top, fill)) void step;
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
    drawBitmapText(data, metrics, text, x, y, scale, fill, align, edge.fontLocale);
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
  if (metrics.filmFrames) {
    // A strip of several photos (composeFilmStrip): each frame by its own
    // first perforation and number.
    metrics.filmFrames.forEach((frame, index) => {
      const mainX = Math.round(frame.x + metrics.holeWidth + (edge.frameNumberHole - 1) * metrics.pitch);
      callback({ index, frameNumber: clampInt(frame.number, 0, 99), mainX, halfX: mainX + framePitch / 2 });
    });
    return;
  }
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

function* paintSprocketTextureSmearSteps(data, metrics, sourceImageData, strength = 1) {
  const source = sourceImageData?.data;
  if (!source) return;
  const amount = clamp(Number(strength) || 0, 0, 2);
  if (amount <= 0) return;
  const spread = Math.max(5, Math.round(metrics.holeHeight * 0.58));

  for (const [left, top] of sprocketHoles(metrics)) {
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
        blendChannels(data, (y * metrics.outputWidth + x) * 4, source[srcIndex], source[srcIndex + 1], source[srcIndex + 2], 255, alpha);
      }
      if ((y & 31) === 31) yield;
    }
    yield;
  }
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

// ---- Brand styles (edgeMarkingStyles.js) --------------------------------
//
// A style places each marking in perforations along the film from the frame's
// main number and in millimetres in from the film's outer edge. Along the
// film one millimetre is imagePxPerMmX pixels (the perforations' scale);
// across it filmEdgePxPerMmY (the band's). Letters keep their proportions
// against the perforations: where a small preview widens the band beyond its
// physical size, they are narrowed by the ratio of the two.

// A marking whose mask is built in steps: run at once outside a stepped compose.
function deferStyledMarking(build) {
  if (deferredMarkings) {
    deferredMarkings.push({ build });
    return;
  }
  const steps = build();
  let step;
  do { step = steps.next(); } while (!step.done);
  if (step.value) for (const s of compositeMarkingMaskSteps(...step.value)) void s;
}

function markingPad(metrics) {
  return Math.ceil(Math.max(0.38, metrics.mm * 0.026) * 2.5) + 1;
}

/**
 * The frames whose markings a styled border draws: { x, number } with x the
 * main number's position (pixels from the left of the frame image). One frame
 * per eight perforations, numbered on from the photo's own number. A caller
 * that composes several photos on one film names its frames itself
 * (`filmFrames`: each frame's first perforation and number).
 */
export function styledFrameSlots(metrics, edge, style) {
  const framePitch = getEdgeFramePitch(metrics);
  const anchor = (metrics.frameStartX ?? metrics.startX) + style.anchorPerf * metrics.pitch;
  const reach = 9 * metrics.pitch;
  const first = Math.floor((0 - reach - anchor) / framePitch);
  const last = Math.ceil((metrics.outputWidth + reach - anchor) / framePitch);
  const slots = [];
  for (let k = first; k <= last; k++) slots.push({ x: anchor + k * framePitch, number: clampInt(edge.frameNumber + k, 0, 99) });
  return slots;
}

function styledBand(metrics, element) {
  const sY = metrics.filmEdgePxPerMmY;
  const [near, far] = element.from;
  const height = (far - near) * sY;
  const top = element.edge === 'top' ? near * sY : metrics.outputHeight - far * sY;
  return { top, height };
}

function styledText(data, metrics, edge, element, text, x, fill, cache, brand = '') {
  const label = String(text || '').trim();
  if (!label) return;
  const { top, height: capPx } = styledBand(metrics, element);
  if (capPx < 1) return;
  const xScale = Math.min(1, metrics.imagePxPerMmX / Math.max(1e-6, metrics.filmEdgePxPerMmY));
  if (edge.fontStyle !== 'edgePixel') {
    // A canvas font chosen in the panel: its capitals are about 0.72 of the font size.
    if (drawCanvasText(data, metrics, label, x, top - capPx * 0.08, capPx / 0.72, fill, 'left', edge.fontStyle, edge.fontFamily)) return;
  }
  const set = element.glyphs;
  if (!hasEdgeGlyphs(set, label)) {
    // Letters the style has no shape for (CJK and other scripts): the pixel font.
    drawBitmapText(data, metrics, label, x, top, capPx / 7, fill, 'left', edge.fontLocale);
    return;
  }
  const chars = Array.from(edgeGlyphText(set, label));
  const digitScale = element.digitWidth ? element.digitWidth / edgeGlyphAdvance(set, '0') : 1;
  const tracking = (element.tracking ?? 0.2) * capPx * xScale;
  const wordGap = (element.wordSpace ?? 0.6) * capPx * xScale;
  // Kodak sets its name further apart from the stock than the stock's words
  // from each other ("KODAK  GC 400", "GC 400  KODAK").
  const brandGap = (element.brandGap ?? element.wordSpace ?? 0.6) * capPx * xScale;
  const words = chars.join('').split(' ');
  const firstSpace = brand && words[0] === brand ? chars.indexOf(' ') : -1;
  const lastSpace = brand && words.length > 1 && words[words.length - 1] === brand ? chars.lastIndexOf(' ') : -1;
  const pad = markingPad(metrics);
  deferStyledMarking(function* () {
    const placed = [];
    let pen = 0;
    for (let i = 0; i < chars.length; i++) {
      const char = chars[i];
      if (char === ' ') { pen += (i === firstSpace || i === lastSpace ? brandGap : wordGap) - tracking; continue; }
      const widthScale = (/[0-9]/.test(char) ? digitScale : (element.letterWidth ?? 1)) * xScale;
      const key = `${set}\0${char}\0${capPx.toFixed(3)}\0${element.stroke}\0${widthScale.toFixed(4)}`;
      let glyph = cache.get(key);
      if (!glyph) {
        glyph = rasterizeEdgeGlyph(set, char, { capPx, stroke: element.stroke, widthScale });
        cache.set(key, glyph);
        yield;
      }
      placed.push([Math.round(pen), glyph]);
      pen += glyph.advance + tracking;
    }
    if (!placed.length) return null;
    const left = Math.round(x) - 1 - pad, maskTop = Math.round(top) - 1 - pad;
    const width = Math.ceil(pen) + 2 + pad * 2, height = Math.ceil(capPx) + 2 + pad * 2;
    const mask = new Float32Array(width * height);
    for (const [offset, glyph] of placed) {
      for (let y = 0; y < glyph.height; y++) {
        const row = (y + pad) * width + offset + pad, src = y * glyph.width;
        for (let gx = 0; gx < glyph.width; gx++) {
          const v = glyph.mask[src + gx];
          if (v > mask[row + gx]) mask[row + gx] = v;
        }
      }
    }
    return [data, metrics, mask, width, height, left, maskTop, fill];
  });
}

function styledShape(data, metrics, element, x, fill, draw, widthUnits) {
  const { top, height } = styledBand(metrics, element);
  if (height < 1) return;
  const pad = markingPad(metrics);
  deferStyledMarking(function* () {
    const shape = rasterizeEdgeShape(draw, widthUnits, { capPx: height, stroke: element.stroke ?? 0.14 });
    yield;
    const width = shape.width + pad * 2, maskHeight = shape.height + pad * 2;
    const mask = new Float32Array(width * maskHeight);
    for (let y = 0; y < shape.height; y++) mask.set(shape.mask.subarray(y * shape.width, (y + 1) * shape.width), (y + pad) * width + pad);
    return [data, metrics, mask, width, maskHeight, Math.round(x) - 1 - pad, Math.round(top) - 1 - pad, fill];
  });
}

function styledDx(data, metrics, edge, style, x, frameNumber, half) {
  const geometry = style.dxGeometry;
  const modulePitch = Math.max(1, geometry.moduleMm * metrics.imagePxPerMmX);
  const blockHeight = Math.max(1, geometry.rowMm * metrics.filmEdgePxPerMmY);
  const top = metrics.outputHeight - blockHeight * 2;
  // On film the bars of neighbouring modules run together into solid blocks.
  paintDxSequence(data, metrics, edge, x, top, modulePitch, modulePitch * (geometry.barFill ?? 1.02), blockHeight, blockHeight, half, frameNumber);
}

function paintStyledEdgeMarkings(data, metrics, edge, style) {
  const fill = edge.letteringColor;
  const sX = metrics.imagePxPerMmX, pitch = metrics.pitch;
  if (style.inkDensity) metrics.styleInkDensity = style.inkDensity;
  const slots = metrics.filmFrames
    ? metrics.filmFrames.map((frame) => ({ x: frame.x + style.anchorPerf * metrics.pitch, number: clampInt(frame.number, 0, 99) }))
    : styledFrameSlots(metrics, edge, style);
  const cache = new Map();
  const halfMarks = edge.frameNumberEnabled && edge.halfFrameMarksEnabled;
  for (const slot of slots) {
    for (const element of style.elements) {
      const x = slot.x + element.at * pitch;
      // Nothing a style prints is longer than 30 mm.
      if (x > metrics.outputWidth || x < -30 * sX) continue;
      // A marking printed every other frame.
      if (element.parity && (Math.abs(slot.number) % 2 === 0) !== (element.parity === 'even')) continue;
      switch (element.kind) {
        case 'number':
          if (edge.frameNumberEnabled) styledText(data, metrics, edge, element, String(slot.number), x, fill, cache);
          break;
        case 'halfNumber':
          if (halfMarks) styledText(data, metrics, edge, element, `${slot.number}A`, x, fill, cache);
          break;
        case 'code': {
          // An emulsion code printed with the text, when the style knows it for this text.
          const code = style.codes?.[String(edge.text).trim().toUpperCase()];
          if (edge.textEnabled && code) styledText(data, metrics, edge, element, code, x, fill, cache);
          break;
        }
        case 'stripes': {
          // Coloured lines along the perforation rows (Fujicolor), by stock.
          // They are brand marks: shown with the text switch.
          const stripes = edge.textEnabled ? style.stripes?.[String(edge.text).trim().toUpperCase()] || [] : [];
          const sY = metrics.filmEdgePxPerMmY;
          for (const stripe of stripes) {
            const rects = [];
            for (const row of stripe.rows) {
              const middle = (row === 'top' ? metrics.topY : metrics.bottomY) + metrics.holeHeight / 2;
              const centre = middle + (row === 'top' ? 1 : -1) * stripe.offsetMm * sY;
              const height = Math.max(1, stripe.widthMm * sY);
              for (let k = 0; k * stripe.period < 8; k++) {
                const a = slot.x + (stripe.on[0] + k * stripe.period) * pitch, b = slot.x + (stripe.on[1] + k * stripe.period) * pitch;
                if (b < 0 || a > metrics.outputWidth) continue;
                rects.push([a, centre - height / 2, b - a, height]);
              }
            }
            paintMarkingRectangles(data, metrics, rects, sanitizeColor(stripe.color, fill));
          }
          break;
        }
        case 'label':
          if (element.always ? edge.textEnabled : halfMarks) styledText(data, metrics, edge, element, element.value, x, fill, cache);
          break;
        case 'text':
          if (edge.textEnabled) styledText(data, metrics, edge, element, edgeTextForFrame(style, edge.text, slot.number), x, fill, cache, style.brand);
          break;
        case 'dx':
          if (edge.dxEnabled) styledDx(data, metrics, edge, style, x, slot.number, element.half);
          break;
        case 'arrow': {
          if (!halfMarks) break;
          // Kodak: a thin shaft and a solid head, pointing to the higher numbers.
          const { top, height } = styledBand(metrics, element);
          const length = element.lengthMm * sX, head = Math.min(length, element.headMm * sX);
          const shaft = Math.max(1, element.shaftMm * metrics.filmEdgePxPerMmY);
          const middle = top + height / 2;
          paintMarkingRectangles(data, metrics, [[x, middle - shaft / 2, length - head * 0.9, shaft]], fill);
          paintExposedTriangle(data, metrics, { x: x + length - head, y: top }, { x: x + length, y: middle }, { x: x + length - head, y: top + height }, fill);
          break;
        }
        case 'triangle': {
          if (!halfMarks) break;
          // Ilford: a solid triangle pointing to the higher numbers.
          const { top, height } = styledBand(metrics, element);
          const length = element.lengthMm * sX;
          paintExposedTriangle(data, metrics, { x, y: top }, { x: x + length, y: top + height / 2 }, { x, y: top + height }, fill);
          break;
        }
        case 'outlineArrow': {
          if (!halfMarks) break;
          const { height } = styledBand(metrics, element);
          if (height >= 1) styledShape(data, metrics, element, x, fill, fujiOutlineArrow, element.lengthMm * sX / height);
          break;
        }
        default:
          break;
      }
    }
  }
}

function paintEdgeMarkings(data, metrics, edge) {
  // A brand style draws its own layout; custom (and every setting saved
  // before styles existed) draws the markings below, unchanged.
  const style = edgeMarkingStyle(edge.style === EDGE_STYLE_AUTO ? EDGE_STYLE_PLAIN : edge.style);
  if (style) {
    paintStyledEdgeMarkings(data, metrics, edge, style);
    return;
  }
  if (edge.textEnabled) paintPhotoText(data, metrics, edge);
  if (edge.dxEnabled) paintDxEdgeCode(data, metrics, edge);
  if (edge.frameNumberEnabled) paintFrameNumberMarker(data, metrics, edge);
}

// A frame in steps: the same passes in the same order, each long one yielding
// between rows, holes or markings, so a caller can let the page breathe
// between steps (composeSprocketFrameAsync) or run them through at once.
function* createSprocketFrameSteps(imageData, options = {}, { includePhoto = true } = {}) {
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

  yield* fillFilmBaseSteps(output, metrics, filmColor);

  if (edge.overexposedSprockets) {
    yield* paintSprocketTextureSmearSteps(output, metrics, imageData, edge.overexposureStrength);
    yield* paintOverexposedSprocketsSteps(output, metrics, edge.overexposureColor);
  }
  // The markings build their masks at once; the composites run in steps.
  const markings = [];
  deferredMarkings = markings;
  try {
    paintEdgeMarkings(output, metrics, edge);
  } finally {
    deferredMarkings = null;
  }
  for (const marking of markings) {
    if (Array.isArray(marking)) {
      yield* compositeMarkingMaskSteps(...marking);
    } else {
      // A styled marking builds its mask in steps too (one glyph per step).
      const args = yield* marking.build();
      if (args) yield* compositeMarkingMaskSteps(...args);
    }
    yield;
  }
  // バーコードは孔の外に隔離せず外縁まで印字し、打ち抜き部分を最後に抜く。
  yield* paintSprocketRowsSteps(output, metrics, holeColor);
  if (includePhoto) {
    // Hard guardrail: edge effects are allowed to touch only the added film border.
    yield* copyPhotoRegionSteps(output, metrics, imageData);
  } else {
    yield* clearPhotoRegionSteps(output, metrics);
  }

  return new ImageData(output, metrics.outputWidth, metrics.outputHeight);
}

function isPortrait(imageData) {
  return imageData && imageData.height > imageData.width;
}

function* rotateImageData90Steps(imageData) {
  // Rotate 90° clockwise: landscape → portrait, or portrait → landscape
  const srcW = imageData.width, srcH = imageData.height;
  const dstW = srcH, dstH = srcW;
  const src = imageData.data;
  const dst = new Uint8ClampedArray(dstW * dstH * 4);
  const chunk = rowsPerStep(srcW * 16);
  for (let y = 0; y < srcH; y++) {
    for (let x = 0; x < srcW; x++) {
      const si = (y * srcW + x) * 4;
      const di = ((x) * dstW + (dstW - 1 - y)) * 4;
      dst[di] = src[si]; dst[di + 1] = src[si + 1];
      dst[di + 2] = src[si + 2]; dst[di + 3] = src[si + 3];
    }
    if (y % chunk === chunk - 1) yield;
  }
  return new ImageData(dst, dstW, dstH);
}

function* rotateImageData270Steps(imageData) {
  // Rotate 270° clockwise (90° counter-clockwise)
  // Source (x,y) → Destination (dstH-1-x, y)
  const srcW = imageData.width, srcH = imageData.height;
  const dstW = srcH, dstH = srcW;
  const src = imageData.data;
  const dst = new Uint8ClampedArray(dstW * dstH * 4);
  const chunk = rowsPerStep(srcW * 16);
  for (let y = 0; y < srcH; y++) {
    for (let x = 0; x < srcW; x++) {
      const si = (y * srcW + x) * 4;
      const di = ((dstH - 1 - x) * dstW + y) * 4;
      dst[di] = src[si]; dst[di + 1] = src[si + 1];
      dst[di + 2] = src[si + 2]; dst[di + 3] = src[si + 3];
    }
    if (y % chunk === chunk - 1) yield;
  }
  return new ImageData(dst, dstW, dstH);
}

// The photo with its film border (or, with `includePhoto` false, the border
// around a transparent hole for the photo), as steps: a generator whose
// return value is the frame.
function* composeSprocketFrameSteps(imageData, options, includePhoto) {
  if (!isPortrait(imageData)) return yield* createSprocketFrameSteps(imageData, options, { includePhoto });
  const rotated = yield* rotateImageData90Steps(imageData);
  const framed = yield* createSprocketFrameSteps(rotated, options, { includePhoto });
  return yield* rotateImageData270Steps(framed);
}

function runSteps(steps) {
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

export function composeSprocketFrame(imageData, options = {}) {
  return runSteps(composeSprocketFrameSteps(imageData, options, true));
}

export function composeSprocketFrameBackground(imageData, options = {}) {
  return runSteps(composeSprocketFrameSteps(imageData, options, false));
}

/**
 * composeSprocketFrame for a full-size export on the page's own thread: the
 * same frame, byte for byte, composed in slices of `budgetMs` with a task
 * boundary between them (`pause`), so the page keeps painting and answering
 * input while a 60 MP border is drawn (it took one task of five seconds).
 * `pause` defaults to scheduler.yield() where there is one, else a
 * MessageChannel task, which a hidden page does not throttle.
 */
export async function composeSprocketFrameAsync(imageData, options = {}, { budgetMs = 12, pause = pauseForPage, includePhoto = true } = {}) {
  const steps = composeSprocketFrameSteps(imageData, options, includePhoto);
  let sliceStart = performance.now();
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    if (performance.now() - sliceStart >= budgetMs) {
      await pause();
      sliceStart = performance.now();
    }
  }
}

// ---- Film strips (contact sheets) ----------------------------------------
//
// A cut strip of a 135 roll: several pictures on one continuous film, the
// perforations running through from end to end, the edge markings repeating
// with the frames and each frame carrying its own number. Pictures sit in
// 36 × 24 mm windows eight perforations (38 mm) apart, so 2 mm of film
// between them and half of that at each cut; half-frame pictures in
// 18 × 24 mm windows four perforations (19 mm) apart. The film's own
// printing does not change with the camera: on a half-frame strip the
// numbers still come every eight perforations, "nA" between them.

/** Window and pitch of a strip whose pictures are `windowHeight` pixels (24 mm) tall. */
export function filmStripGeometry(count, { windowHeight, halfFrame = false } = {}) {
  const height = Math.max(8, Math.round(Number(windowHeight) || 0));
  const pxPerMm = height / THIRTY_FIVE_MM_SPROCKET_SPEC.stillFrameHeightMm;
  const probe = getSprocketFrameMetrics(Math.round(height * 1.5), height, { edgeMarkings: { textEnabled: true } });
  const perforations = halfFrame ? 4 : 8;
  const framePitch = perforations * probe.pitch;
  const windowWidth = Math.round((halfFrame ? 18 : 36) * pxPerMm);
  const frames = Math.max(1, Math.round(count) || 1);
  return { pxPerMm, pitch: probe.pitch, perforations, framePitch, windowWidth, windowHeight: height, frames, interiorWidth: (frames - 1) * framePitch + windowWidth };
}

function filmStripMetrics(geometry, edge) {
  const metrics = getSprocketFrameMetrics(geometry.interiorWidth, geometry.windowHeight, { edgeMarkings: edge });
  // The cut falls in the middle of the film between two frames.
  metrics.sideMargin = Math.max(1, Math.round((geometry.framePitch - geometry.windowWidth) / 2));
  metrics.outputWidth = metrics.sourceWidth + metrics.sideMargin * 2;
  const span = (geometry.perforations - 1) * metrics.pitch + metrics.holeWidth;
  metrics.frameStartX = metrics.sideMargin + Math.round((geometry.windowWidth - span) / 2 + edge.firstHoleOffsetMm * metrics.imagePxPerMmX);
  metrics.firstHoleIndex = Math.floor((0 - metrics.frameStartX - metrics.holeWidth) / metrics.pitch);
  const lastHoleIndex = Math.ceil((metrics.outputWidth - metrics.frameStartX) / metrics.pitch);
  metrics.holeCount = Math.max(0, lastHoleIndex - metrics.firstHoleIndex + 1);
  metrics.startX = metrics.frameStartX + metrics.firstHoleIndex * metrics.pitch;
  return metrics;
}

// Bilinear resampling of a picture to width × height.
function* resampleImageDataSteps(source, width, height) {
  if (source.width === width && source.height === height) return source;
  const src = source.data, sw = source.width, sh = source.height;
  const out = new Uint8ClampedArray(width * height * 4);
  const sx = sw / width, sy = sh / height;
  for (let y = 0; y < height; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      const a = (y0 * sw + x0) * 4, b = (y0 * sw + x1) * 4, c = (y1 * sw + x0) * 4, d = (y1 * sw + x1) * 4, o = (y * width + x) * 4;
      for (let k = 0; k < 4; k++) {
        out[o + k] = (src[a + k] * (1 - tx) + src[b + k] * tx) * (1 - ty) + (src[c + k] * (1 - tx) + src[d + k] * tx) * ty;
      }
    }
    if ((y & 31) === 31) yield;
  }
  return new ImageData(out, width, height);
}

/**
 * Where each picture goes: turned a quarter clockwise when its orientation
 * differs from the window's (a portrait photo in a 36 × 24 window, a
 * landscape one in a half-frame window), then fitted inside the window,
 * centred, never stretched or cropped. Pure: { rotate, x, y, width, height }
 * relative to the window.
 */
export function fitPictureInWindow(pictureWidth, pictureHeight, windowWidth, windowHeight) {
  const windowPortrait = windowHeight > windowWidth;
  const rotate = pictureWidth !== pictureHeight && (pictureHeight > pictureWidth) !== windowPortrait;
  const w = rotate ? pictureHeight : pictureWidth, h = rotate ? pictureWidth : pictureHeight;
  const scale = Math.min(windowWidth / w, windowHeight / h);
  const width = Math.max(1, Math.min(windowWidth, Math.round(w * scale)));
  const height = Math.max(1, Math.min(windowHeight, Math.round(h * scale)));
  return { rotate, x: Math.floor((windowWidth - width) / 2), y: Math.floor((windowHeight - height) / 2), width, height };
}

function* createFilmStripSteps(pictures, options = {}) {
  if (!Array.isArray(pictures) || !pictures.length) throw new Error('A film strip needs at least one picture.');
  const edge = getComposeEdgeMarkings(options);
  const halfFrame = Boolean(options.halfFrame);
  const geometry = filmStripGeometry(pictures.length, { windowHeight: options.windowHeight, halfFrame });
  const metrics = filmStripMetrics(geometry, edge);
  metrics.edgeOverexposureStrength = edge.overexposureStrength;
  metrics.edgeOverexposed = edge.overexposedSprockets;
  // The film's frames: one per eight perforations, numbered by the picture
  // that starts it, plus one beyond each cut so the printing runs on.
  const step = halfFrame ? 2 : 1;
  const holeOf = (i) => metrics.frameStartX + i * geometry.framePitch;
  const frames = [];
  for (let i = 0; i < pictures.length; i += step) frames.push({ x: holeOf(i), number: clampInt(pictures[i].number, 0, 99) });
  const filmPitch = 8 * metrics.pitch;
  frames.unshift({ x: frames[0].x - filmPitch, number: Math.max(0, frames[0].number - 1) });
  frames.push({ x: frames[frames.length - 1].x + filmPitch, number: Math.min(99, frames[frames.length - 1].number + 1) });
  metrics.filmFrames = frames;

  const filmColor = sanitizeColor(options.filmColor, DEFAULT_FILM_COLOR);
  const holeColor = options.transparentHoles === true
    ? [0, 0, 0, 0]
    : sanitizeColor(options.holeColor ?? edge.holeColor, DEFAULT_HOLE_COLOR);

  // The pictures, turned and fitted into their windows, on one sheet the size
  // of the strip's picture band (the smear of overexposed perforations reads it).
  const band = new Uint8ClampedArray(metrics.sourceWidth * metrics.sourceHeight * 4);
  const placed = [];
  for (let i = 0; i < pictures.length; i++) {
    const source = pictures[i].imageData;
    if (!source?.data) continue;
    const fit = fitPictureInWindow(source.width, source.height, geometry.windowWidth, geometry.windowHeight);
    let picture = source;
    if (fit.rotate) picture = yield* rotateImageData90Steps(picture);
    picture = yield* resampleImageDataSteps(picture, fit.width, fit.height);
    const left = i * geometry.framePitch + fit.x, top = fit.y;
    for (let y = 0; y < fit.height; y++) band.set(picture.data.subarray(y * fit.width * 4, (y + 1) * fit.width * 4), ((top + y) * metrics.sourceWidth + left) * 4);
    placed.push({ left, top, width: fit.width, height: fit.height });
    yield;
  }
  const bandImage = new ImageData(band, metrics.sourceWidth, metrics.sourceHeight);

  const output = new Uint8ClampedArray(metrics.outputWidth * metrics.outputHeight * 4);
  yield* fillFilmBaseSteps(output, metrics, filmColor, [{ left: metrics.sideMargin, width: metrics.sourceWidth }]);
  if (edge.overexposedSprockets) {
    yield* paintSprocketTextureSmearSteps(output, metrics, bandImage, edge.overexposureStrength);
    yield* paintOverexposedSprocketsSteps(output, metrics, edge.overexposureColor);
  }
  const markings = [];
  deferredMarkings = markings;
  try {
    paintEdgeMarkings(output, metrics, edge);
  } finally {
    deferredMarkings = null;
  }
  for (const marking of markings) {
    if (Array.isArray(marking)) {
      yield* compositeMarkingMaskSteps(...marking);
    } else {
      const args = yield* marking.build();
      if (args) yield* compositeMarkingMaskSteps(...args);
    }
    yield;
  }
  yield* paintSprocketRowsSteps(output, metrics, holeColor);
  // Hard guardrail as for one photo: the pictures go in last, untouched.
  for (const rect of placed) {
    for (let y = 0; y < rect.height; y++) {
      const from = ((rect.top + y) * metrics.sourceWidth + rect.left) * 4;
      output.set(band.subarray(from, from + rect.width * 4), ((metrics.bandHeight + rect.top + y) * metrics.outputWidth + metrics.sideMargin + rect.left) * 4);
    }
    yield;
  }
  const strip = new ImageData(output, metrics.outputWidth, metrics.outputHeight);
  strip.windows = placed.map((rect) => ({ x: metrics.sideMargin + rect.left, y: metrics.bandHeight + rect.top, width: rect.width, height: rect.height }));
  strip.pitch = metrics.pitch;
  strip.frameStartX = metrics.frameStartX;
  return strip;
}

/**
 * A strip of `pictures` ([{ imageData, number }]) on one film, with the edge
 * markings of `options.edgeMarkings` (a brand style or the custom markings),
 * the perforations continuous and each frame's own number. `windowHeight`
 * is the pictures' height in pixels (24 mm); `halfFrame` for 18 × 24 mm
 * pictures four perforations apart. Composed in slices like an export.
 * The ImageData carries `windows` (each picture's rectangle) and `pitch`.
 */
export async function composeFilmStripAsync(pictures, options = {}, { budgetMs = 12, pause = pauseForPage } = {}) {
  const steps = createFilmStripSteps(pictures, options);
  let sliceStart = performance.now();
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    if (performance.now() - sliceStart >= budgetMs) {
      await pause();
      sliceStart = performance.now();
    }
  }
}

export function composeFilmStrip(pictures, options = {}) {
  return runSteps(createFilmStripSteps(pictures, options));
}

function pauseForPage() {
  if (typeof globalThis.scheduler?.yield === 'function') return globalThis.scheduler.yield();
  return new Promise((resolve) => {
    if (typeof MessageChannel !== 'function') { setTimeout(resolve, 0); return; }
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => { port1.close(); resolve(); };
    port2.postMessage(null);
  });
}

export function hasSprocketFrameEnabled(settings) {
  return Boolean(settings && (
    settings.sprocketHolesEnabled
    || settings.sprocketPreviewEnabled
    || settings.exportSprocketHolesEnabled
  ));
}

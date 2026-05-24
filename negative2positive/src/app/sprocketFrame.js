const DEFAULT_FILM_COLOR = [6, 6, 6, 255];
const DEFAULT_HOLE_COLOR = [255, 255, 255, 255];
const DEFAULT_MARKING_COLOR = [242, 194, 82, 255];
const DEFAULT_OVEREXPOSURE_COLOR = [237, 156, 0, 255];

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
  overexposedSprockets: false,
  overexposureStrength: 1,
  fontStyle: 'monoBold',
  fontFamily: '',
  holeColor: '#ffffff',
  letteringColor: '#f2c252',
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
  const dxBlockHeight = Math.max(1, Math.round(filmEdgePxPerMmY * 0.36));
  const dxCodeHeight = dxBlockHeight * 2;
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
  const bottomDxY = showMarkings
    ? bottomOuterTop + Math.max(0, Math.floor((bottomOuterHeight - dxCodeHeight - edgeGap) / 2))
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
      const alpha = falloff * falloff * clamp(0.18 + amount * 0.44, 0.08, 0.9);
      blendPixel(data, (y * metrics.outputWidth + x) * 4, fill, alpha);
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

function drawEdgeText(data, metrics, edge, text, x, y, pixelSize, align = 'left') {
  const rendered = drawCanvasText(
    data,
    metrics,
    text,
    x,
    y,
    pixelSize,
    edge.letteringColor,
    align,
    edge.fontStyle,
    edge.fontFamily
  );
  if (rendered) return;
  const scale = Math.max(1, Math.round(pixelSize / 7));
  drawBitmapText(data, metrics, text, x, y, scale, edge.letteringColor, align);
}

export function buildDxEdgeCodeBlocks(options = {}) {
  const edge = normalizeSprocketEdgeMarkings(options);
  const blocks = [];
  const seen = new Set();
  const add = (column, row) => {
    const key = `${column}:${row}`;
    if (column < 0 || column > 30 || row < 0 || row > 1 || seen.has(key)) return;
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

  const aFlag = edge.frameNumber > 36 ? 1 : 0;
  if (aFlag) add(24, 1);
  if (((edge.dx1 + edge.dx2 + clampInt(edge.frameNumber, 0, 63) + aFlag) % 2) === 1) add(26, 1);

  add(29, 0);
  add(28, 1);
  add(30, 1);
  return blocks;
}

function paintDxEdgeCode(data, metrics, edge) {
  const blockWidth = Math.max(1, Math.round(metrics.imagePxPerMmX * 0.42));
  const blockHeight = Math.max(1, Math.round(metrics.filmEdgePxPerMmY * 0.36));
  const codeWidth = blockWidth * 31;
  const frameLabelWidth = edge.frameNumberEnabled
    ? Math.max(metrics.imagePxPerMmX * 2.2, measureBitmapText(String(edge.frameNumber).padStart(2, '0'), Math.max(1, Math.round(metrics.edgeTextPixelSize / 7))))
    : 0;
  const frameLabelCenter = edge.frameNumberEnabled
    ? clamp(
      Math.round(metrics.startX + (edge.frameNumberHole - 0.5) * metrics.pitch),
      metrics.sideMargin,
      metrics.outputWidth - metrics.sideMargin
    )
    : -9999;
  const avoidLeft = frameLabelCenter - frameLabelWidth * 0.7;
  const avoidRight = frameLabelCenter + frameLabelWidth * 0.7;
  const margin = Math.max(2, Math.round(metrics.mm * 0.35));
  const leftCandidate = Math.round(metrics.sideMargin + metrics.mm * 1.2);
  const rightCandidate = Math.round(metrics.outputWidth - codeWidth - metrics.sideMargin - metrics.mm * 1.2);
  const overlapAmount = (left) => Math.max(0, Math.min(left + codeWidth, avoidRight) - Math.max(left, avoidLeft));
  const leftOverlap = edge.frameNumberEnabled ? overlapAmount(leftCandidate) : 0;
  const rightOverlap = edge.frameNumberEnabled ? overlapAmount(rightCandidate) : 0;
  const left = clamp(
    rightOverlap < leftOverlap ? rightCandidate : leftCandidate,
    margin,
    Math.max(margin, metrics.outputWidth - codeWidth - margin)
  );
  const top = clamp(
    metrics.bottomDxY,
    metrics.bottomBandTop,
    Math.max(metrics.bottomBandTop, metrics.outputHeight - blockHeight * 2 - 1)
  );

  for (const block of buildDxEdgeCodeBlocks(edge)) {
    fillRect(
      data,
      metrics,
      left + block.column * blockWidth,
      top + block.row * blockHeight,
      Math.max(1, blockWidth - 1),
      Math.max(1, blockHeight - 1),
      edge.letteringColor
    );
  }
}

function paintFrameNumberMarker(data, metrics, edge) {
  const pixelSize = metrics.edgeTextPixelSize;
  const label = String(edge.frameNumber).padStart(2, '0');
  const markerX = clamp(
    Math.round(metrics.startX + (edge.frameNumberHole - 0.5) * metrics.pitch),
    metrics.sideMargin,
    metrics.outputWidth - metrics.sideMargin
  );
  drawEdgeText(data, metrics, edge, label, markerX, metrics.topMarkingY, pixelSize, 'center');
  drawEdgeText(
    data,
    metrics,
    edge,
    label,
    markerX,
    metrics.bottomMarkingY,
    pixelSize,
    'center'
  );

  const arrowTop = metrics.bottomMarkingY + Math.max(1, Math.round(metrics.edgeTextHeight * 0.18));
  const arrowLeft = markerX + Math.round(metrics.mm * 1.1);
  const arrowSize = Math.max(2, Math.round(metrics.mm * 0.45));
  for (let row = 0; row < arrowSize; row++) {
    fillRect(data, metrics, arrowLeft + row, arrowTop + row, arrowSize - row, 1, edge.letteringColor);
    fillRect(data, metrics, arrowLeft + row, arrowTop + (arrowSize * 2 - row), arrowSize - row, 1, edge.letteringColor);
  }
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
  if (edge.frameNumberEnabled) paintFrameNumberMarker(data, metrics, edge);
  if (edge.dxEnabled) paintDxEdgeCode(data, metrics, edge);
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

  for (let i = 0; i < output.length; i += 4) {
    output[i] = filmColor[0];
    output[i + 1] = filmColor[1];
    output[i + 2] = filmColor[2];
    output[i + 3] = filmColor[3];
  }

  const src = imageData.data;
  for (let y = 0; y < metrics.sourceHeight; y++) {
    const srcOffset = y * metrics.sourceWidth * 4;
    const dstOffset = ((y + metrics.bandHeight) * metrics.outputWidth + metrics.sideMargin) * 4;
    output.set(src.subarray(srcOffset, srcOffset + metrics.sourceWidth * 4), dstOffset);
  }

  if (edge.overexposedSprockets) {
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

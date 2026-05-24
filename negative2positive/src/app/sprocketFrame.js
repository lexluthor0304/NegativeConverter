const DEFAULT_FILM_COLOR = [6, 6, 6, 255];
const DEFAULT_HOLE_COLOR = [255, 255, 255, 255];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sanitizeColor(input, fallback) {
  const source = Array.isArray(input) || ArrayBuffer.isView(input) ? input : fallback;
  return [
    clamp(Math.round(Number(source[0]) || 0), 0, 255),
    clamp(Math.round(Number(source[1]) || 0), 0, 255),
    clamp(Math.round(Number(source[2]) || 0), 0, 255),
    clamp(Math.round(Number(source[3]) || 0), 0, 255)
  ];
}

export function getSprocketFrameMetrics(width, height) {
  const sourceWidth = Math.max(1, Math.round(Number(width) || 1));
  const sourceHeight = Math.max(1, Math.round(Number(height) || 1));
  const shortSide = Math.min(sourceWidth, sourceHeight);
  const sideMargin = clamp(Math.round(sourceWidth * 0.028), 8, Math.max(8, Math.round(shortSide * 0.08)));
  const bandHeight = clamp(Math.round(sourceHeight * 0.12), 18, Math.max(18, Math.round(sourceHeight * 0.2)));
  const holeHeight = clamp(Math.round(bandHeight * 0.58), 10, Math.max(10, bandHeight - 8));
  const holeWidth = Math.max(8, Math.round(holeHeight * 0.72));
  const holeRadius = Math.max(2, Math.round(holeHeight * 0.18));
  const pitch = Math.max(holeWidth + 8, Math.round(holeHeight * 1.7));
  const outputWidth = sourceWidth + sideMargin * 2;
  const outputHeight = sourceHeight + bandHeight * 2;
  const availableWidth = Math.max(holeWidth, outputWidth - sideMargin);
  const holeCount = Math.max(2, Math.floor((availableWidth + pitch - holeWidth) / pitch));
  const span = (holeCount - 1) * pitch + holeWidth;
  const startX = Math.round((outputWidth - span) / 2);
  const topY = Math.round((bandHeight - holeHeight) / 2);
  const bottomY = bandHeight + sourceHeight + topY;

  return {
    sourceWidth,
    sourceHeight,
    outputWidth,
    outputHeight,
    sideMargin,
    bandHeight,
    holeWidth,
    holeHeight,
    holeRadius,
    pitch,
    holeCount,
    startX,
    topY,
    bottomY
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

function paintSprocketRow(data, metrics, top, fill) {
  for (let i = 0; i < metrics.holeCount; i++) {
    const left = metrics.startX + i * metrics.pitch;
    paintSprocketHole(data, metrics, left, top, fill);
  }
}

export function composeSprocketFrame(imageData, options = {}) {
  if (!imageData || !imageData.data || !imageData.width || !imageData.height) {
    throw new Error('ImageData is required to compose sprocket holes.');
  }

  const metrics = getSprocketFrameMetrics(imageData.width, imageData.height);
  const filmColor = sanitizeColor(options.filmColor, DEFAULT_FILM_COLOR);
  const holeColor = options.transparentHoles === true
    ? [0, 0, 0, 0]
    : sanitizeColor(options.holeColor, DEFAULT_HOLE_COLOR);
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

  paintSprocketRow(output, metrics, metrics.topY, holeColor);
  paintSprocketRow(output, metrics, metrics.bottomY, holeColor);

  return new ImageData(output, metrics.outputWidth, metrics.outputHeight);
}

export function hasSprocketFrameEnabled(settings) {
  return Boolean(settings && (
    settings.sprocketHolesEnabled
    || settings.sprocketPreviewEnabled
    || settings.exportSprocketHolesEnabled
  ));
}

import { Engine } from '../silvercore/engine/Engine.js';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sanitizeNumber(value, fallback, min, max) {
  const n = Number(value);
  const base = Number.isFinite(n) ? n : fallback;
  return clamp(base, min, max);
}

function cloneImageData(imageData) {
  return new ImageData(
    new Uint8ClampedArray(imageData.data),
    imageData.width,
    imageData.height
  );
}

function normalizeSaturation(value) {
  return Math.round(sanitizeNumber(value, 100, 0, 200));
}

function normalizeCurvePrecision(value) {
  if (value === 'smooth' || value === 'precise') return value;
  return 'auto';
}

function buildSilverCoreParams(mode, settings = {}) {
  const colorModel = String(settings.colorModel || 'standard');
  const resolvedColorModel = mode === 'bw' ? 'mono' : colorModel;

  return {
    colorModel: resolvedColorModel,
    preSaturation: Math.round(sanitizeNumber(settings.preSaturation, 100, 0, 200)),
    borderBuffer: Math.round(sanitizeNumber(settings.borderBuffer, 10, 0, 30)),
    brightness: sanitizeNumber(settings.brightness, 0, -100, 100),
    exposure: sanitizeNumber(settings.exposure, 0, -300, 300),
    contrast: sanitizeNumber(settings.contrast, 0, -100, 100),
    highlights: sanitizeNumber(settings.highlights, 0, -100, 100),
    shadows: sanitizeNumber(settings.shadows, 0, -100, 100),
    whites: sanitizeNumber(settings.whites, 0, -100, 100),
    blacks: sanitizeNumber(settings.blacks, 0, -100, 100),
    wbMode: String(settings.wbMode || 'auto'),
    temperature: sanitizeNumber(settings.temperature, 0, -100, 100),
    tint: sanitizeNumber(settings.tint, 0, -100, 100),
    saturation: normalizeSaturation(settings.saturation),
    glow: sanitizeNumber(settings.glow, 0, 0, 100),
    fade: sanitizeNumber(settings.fade, 0, 0, 100),
    curvePrecision: normalizeCurvePrecision(settings.curvePrecision),
    source: String(settings.source || 'cameraScan'),
    useWebGL: settings.useWebGL !== false,
  };
}

function toGrayscaleInPlace(imageData) {
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const y = Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
    data[i] = y;
    data[i + 1] = y;
    data[i + 2] = y;
  }
  return imageData;
}

function runSilverCore(imageData, settings, mode) {
  const input = cloneImageData(imageData);
  const params = buildSilverCoreParams(mode, settings);
  const engine = new Engine(input.width, input.height);
  const processed = engine.process(input, params);
  return mode === 'bw' ? toGrayscaleInPlace(processed) : processed;
}

export function convertColorWithSilverCore(imageData, settings = {}) {
  return runSilverCore(imageData, settings, 'color');
}

export function convertBwWithSilverCore(imageData, settings = {}) {
  return runSilverCore(imageData, settings, 'bw');
}

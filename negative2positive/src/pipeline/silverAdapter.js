import { Engine } from '../silvercore/engine/Engine.js';

const ENHANCED_PROFILE_SET = new Set(['none', 'frontier', 'crystal', 'natural', 'pakon']);

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

function normalizeEnhancedProfile(value) {
  const normalized = String(value || 'none');
  return ENHANCED_PROFILE_SET.has(normalized) ? normalized : 'none';
}

function sanitizeFilmBase(base) {
  if (!base || typeof base !== 'object') return null;
  const r = Number(base.r);
  const g = Number(base.g);
  const b = Number(base.b);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
  return {
    r: clamp(Math.round(r), 0, 255),
    g: clamp(Math.round(g), 0, 255),
    b: clamp(Math.round(b), 0, 255),
  };
}

function computeFilmBaseGains(base) {
  const safeBase = sanitizeFilmBase(base);
  if (!safeBase) return null;
  const gray = (safeBase.r + safeBase.g + safeBase.b) / 3;
  if (!Number.isFinite(gray) || gray <= 0) return null;
  return {
    r: clamp(gray / Math.max(safeBase.r, 1), 0.25, 4),
    g: clamp(gray / Math.max(safeBase.g, 1), 0.25, 4),
    b: clamp(gray / Math.max(safeBase.b, 1), 0.25, 4),
  };
}

function applyFilmBaseCompensationInPlace(imageData, gains) {
  if (!imageData || !imageData.data || !gains) return imageData;
  const { data } = imageData;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = clamp(Math.round(data[i] * gains.r), 0, 255);
    data[i + 1] = clamp(Math.round(data[i + 1] * gains.g), 0, 255);
    data[i + 2] = clamp(Math.round(data[i + 2] * gains.b), 0, 255);
  }
  return imageData;
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
    enhancedProfile: normalizeEnhancedProfile(settings.enhancedProfile),
    profileStrength: Math.round(sanitizeNumber(settings.profileStrength, 100, 0, 200)),
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

async function runSilverCore(imageData, settings, mode) {
  const input = cloneImageData(imageData);
  const params = buildSilverCoreParams(mode, settings);
  if (mode === 'color') {
    const filmBaseGains = computeFilmBaseGains(settings && settings.filmBase);
    if (filmBaseGains) {
      applyFilmBaseCompensationInPlace(input, filmBaseGains);
    }
  }
  const engine = new Engine(input.width, input.height);
  try {
    await engine.setEnhancedProfile(params.enhancedProfile);
  } catch (err) {
    console.error('Failed to load enhanced profile, fallback to none:', err);
    params.enhancedProfile = 'none';
    params.profileStrength = 0;
    await engine.setEnhancedProfile('none');
  }
  const processed = engine.process(input, params);
  return mode === 'bw' ? toGrayscaleInPlace(processed) : processed;
}

export async function convertColorWithSilverCore(imageData, settings = {}) {
  return runSilverCore(imageData, settings, 'color');
}

export async function convertBwWithSilverCore(imageData, settings = {}) {
  return runSilverCore(imageData, settings, 'bw');
}

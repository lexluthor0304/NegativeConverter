import { Engine } from '../silvercore/engine/Engine.js';
import { filmPresets } from '../silvercore/engine/FilmPresets.js';

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

function applyFilmPreset(baseSettings, presetId) {
  if (!presetId || presetId === 'none') return baseSettings;
  const preset = filmPresets[presetId];
  if (!preset) return baseSettings;
  return { ...baseSettings, ...preset.settings };
}

function buildSilverCoreParams(mode, settings = {}) {
  const merged = applyFilmPreset(settings, settings.filmPreset);
  const colorModel = String(merged.colorModel || 'standard');
  const resolvedColorModel = mode === 'bw' ? 'mono' : colorModel;

  return {
    colorModel: resolvedColorModel,
    preSaturation: Math.round(sanitizeNumber(merged.preSaturation, 100, 0, 200)),
    borderBuffer: Math.round(sanitizeNumber(merged.borderBuffer, 10, 0, 30)),
    brightness: sanitizeNumber(merged.brightness, 0, -100, 100),
    exposure: sanitizeNumber(merged.exposure, 0, -300, 300),
    contrast: sanitizeNumber(merged.contrast, 0, -100, 100),
    highlights: sanitizeNumber(merged.highlights, 0, -100, 100),
    shadows: sanitizeNumber(merged.shadows, 0, -100, 100),
    whites: sanitizeNumber(merged.whites, 0, -100, 100),
    blacks: sanitizeNumber(merged.blacks, 0, -100, 100),
    wbMode: String(merged.wbMode || 'auto'),
    temperature: sanitizeNumber(merged.temperature, 0, -100, 100),
    tint: sanitizeNumber(merged.tint, 0, -100, 100),
    saturation: normalizeSaturation(merged.saturation),
    glow: sanitizeNumber(merged.glow, 0, 0, 100),
    fade: sanitizeNumber(merged.fade, 0, 0, 100),
    curvePrecision: normalizeCurvePrecision(merged.curvePrecision),
    source: String(merged.source || 'cameraScan'),
    useWebGL: merged.useWebGL !== false,
    enhancedProfile: normalizeEnhancedProfile(merged.enhancedProfile),
    profileStrength: Math.round(sanitizeNumber(merged.profileStrength, 100, 0, 200)),
    midCyan: sanitizeNumber(merged.midCyan, 0, -100, 100),
    midTint: sanitizeNumber(merged.midTint, 0, -100, 100),
    midTemp: sanitizeNumber(merged.midTemp, 0, -100, 100),
    shadowRange: sanitizeNumber(merged.shadowRange, 5, 0, 10),
    highlightRange: sanitizeNumber(merged.highlightRange, 5, 0, 10),
    wbTonality: String(merged.wbTonality || 'addDensity'),
    shadowCyan: sanitizeNumber(merged.shadowCyan, 0, -100, 100),
    shadowTint: sanitizeNumber(merged.shadowTint, 0, -100, 100),
    shadowTemp: sanitizeNumber(merged.shadowTemp, 0, -100, 100),
    highlightCyan: sanitizeNumber(merged.highlightCyan, 0, -100, 100),
    highlightTint: sanitizeNumber(merged.highlightTint, 0, -100, 100),
    highlightTemp: sanitizeNumber(merged.highlightTemp, 0, -100, 100),
    layerOrder: String(merged.layerOrder || 'colorFirst'),
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

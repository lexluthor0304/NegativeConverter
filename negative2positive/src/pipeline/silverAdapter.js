import { Engine } from '../silvercore/engine/Engine.js';
import { filmPresets } from '../silvercore/engine/FilmPresets.js';
import { bwMixWeights } from '../silvercore/engine/Presets.js';
import {
  fromImageData8,
  toImageData8,
  cloneImage16,
} from '../silvercore/util/image16.js';

const ENHANCED_PROFILE_SET = new Set(['none', 'frontier', 'crystal', 'natural', 'pakon']);
const PIXEL_MAX_16 = 65535;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sanitizeNumber(value, fallback, min, max) {
  const n = Number(value);
  const base = Number.isFinite(n) ? n : fallback;
  return clamp(base, min, max);
}

// Resolve any input shape into Image16. Accepts:
//   - Image16 directly ({ width, height, data: Uint16Array })
//   - ImageData carrying an attached __image16 (loader output)
//   - Plain ImageData (upcast via ×257)
function toImage16(input) {
  if (input && input.data instanceof Uint16Array) return input;
  if (input && input.__image16 && input.__image16.data instanceof Uint16Array) {
    return input.__image16;
  }
  return fromImageData8(input);
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

  // Determine imageType from mode
  const imageType = mode === 'positive' ? 'positive' : 'negative';

  return {
    colorModel: resolvedColorModel,
    imageType,
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
    autoToneLevel: Math.round(sanitizeNumber(merged.autoToneLevel, 100, 0, 100)),
    autoColorLevel: Math.round(sanitizeNumber(merged.autoColorLevel, 100, 0, 100)),
    filmWB: String(merged.filmWB || 'none'),
    bwMix: String(merged.bwMix || 'standard'),
  };
}

function toGrayscaleInPlace(image16, mixPreset) {
  const weights = bwMixWeights[mixPreset] || bwMixWeights.standard;
  const data = image16.data;
  for (let i = 0; i < data.length; i += 4) {
    const y = Math.round(data[i] * weights.r + data[i + 1] * weights.g + data[i + 2] * weights.b);
    data[i] = y;
    data[i + 1] = y;
    data[i + 2] = y;
  }
  return image16;
}

// --- Layer 1: Engine cache ---
// Dual cache for preview (small) and full (large) resolution engines
const _cache = {
  preview: { engine: null, width: 0, height: 0, profile: null, inputBuffer: null, pristineBuffer: null, lastSourceRef: null, lastFilmBaseGains: null },
  full:    { engine: null, width: 0, height: 0, profile: null, inputBuffer: null, pristineBuffer: null, lastSourceRef: null, lastFilmBaseGains: null },
};

function gainsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

function _slotFor(options) {
  return (options && options.preview) ? _cache.preview : _cache.full;
}

function _getOrCreateEngine(slot, w, h) {
  if (slot.engine && slot.width === w && slot.height === h) {
    return slot.engine;
  }
  slot.engine = new Engine(w, h);
  slot.width = w;
  slot.height = h;
  slot.profile = null; // force profile reload on new engine
  slot.inputBuffer = null;
  slot.pristineBuffer = null;
  slot.lastSourceRef = null;
  slot.lastFilmBaseGains = null;
  return slot.engine;
}

async function _ensureProfile(slot, engine, profileName) {
  if (slot.profile === profileName) return;
  try {
    await engine.setEnhancedProfile(profileName);
    slot.profile = profileName;
  } catch (err) {
    console.error('Failed to load enhanced profile, fallback to none:', err);
    await engine.setEnhancedProfile('none');
    slot.profile = 'none';
  }
}

function _reuseInputBuffer(slot, image16, filmBaseGains) {
  const len = image16.data.length;
  const sourceRef = image16.data;
  const sourceChanged = sourceRef !== slot.lastSourceRef;
  const gainsChanged = !gainsEqual(slot.lastFilmBaseGains, filmBaseGains);

  // Ensure buffers are allocated
  if (!slot.inputBuffer || slot.inputBuffer.data.length !== len) {
    slot.inputBuffer = cloneImage16(image16);
    slot.pristineBuffer = new Uint16Array(len);
    // Build pristine: source + filmBase
    slot.pristineBuffer.set(sourceRef);
    if (filmBaseGains) {
      _applyGainsToBuffer(slot.pristineBuffer, filmBaseGains);
    }
    slot.lastSourceRef = sourceRef;
    slot.lastFilmBaseGains = filmBaseGains ? { ...filmBaseGains } : null;
    slot.inputBuffer.data.set(slot.pristineBuffer);
    return slot.inputBuffer;
  }

  if (sourceChanged || gainsChanged) {
    // Rebuild pristine: copy source + apply filmBase
    slot.pristineBuffer.set(sourceRef);
    if (filmBaseGains) {
      _applyGainsToBuffer(slot.pristineBuffer, filmBaseGains);
    }
    slot.lastSourceRef = sourceRef;
    slot.lastFilmBaseGains = filmBaseGains ? { ...filmBaseGains } : null;
  }

  // Copy pristine → inputBuffer (engine modifies inputBuffer in-place)
  slot.inputBuffer.data.set(slot.pristineBuffer);
  return slot.inputBuffer;
}

function _applyGainsToBuffer(data, gains) {
  for (let i = 0; i < data.length; i += 4) {
    data[i] = clamp(Math.round(data[i] * gains.r), 0, PIXEL_MAX_16);
    data[i + 1] = clamp(Math.round(data[i + 1] * gains.g), 0, PIXEL_MAX_16);
    data[i + 2] = clamp(Math.round(data[i + 2] * gains.b), 0, PIXEL_MAX_16);
  }
}

// Determine whether we need full process() (histogram re-analysis) or can use reprocess()
function _needsFullProcess(slot, options) {
  if (!slot.engine || !slot.engine.channelData) return true;
  if (options && options.forceFullProcess) return true;
  return false;
}

async function runSilverCore(imageData, settings, mode, options) {
  const slot = _slotFor(options);
  const params = buildSilverCoreParams(mode, settings);

  // Promote whatever the caller hands us into Image16. Loaders attach __image16
  // directly so the upcast is zero-copy in the common case.
  const input16 = toImage16(imageData);

  const engine = _getOrCreateEngine(slot, input16.width, input16.height);

  // Profile loading (skip if unchanged)
  const profileName = params.enhancedProfile;
  await _ensureProfile(slot, engine, profileName);
  if (slot.profile === 'none' && profileName !== 'none') {
    params.enhancedProfile = 'none';
    params.profileStrength = 0;
  }

  // Compute filmBase gains (skip for positive mode - no orange mask)
  const filmBaseGains = mode !== 'positive' ? computeFilmBaseGains(settings && settings.filmBase) : null;

  // Reuse input buffer; skips filmBase per-pixel loop when source + gains unchanged
  const input = _reuseInputBuffer(slot, input16, filmBaseGains);

  // Choose process() vs reprocess() based on whether histogram analysis is needed
  const processed16 = _needsFullProcess(slot, options)
    ? engine.process(input, params)
    : engine.reprocess(input, params);

  const finalImage16 = mode === 'bw' ? toGrayscaleInPlace(processed16, params.bwMix) : processed16;

  // Hand the caller an ImageData (the contract the rest of the app still uses) but
  // leave the 16-bit handle attached so downstream stages (histogram, export) can
  // read the full-precision result without re-deriving from 8-bit.
  const result = toImageData8(finalImage16);
  result.__image16 = finalImage16;
  return result;
}

export function invalidateSilverCoreCache() {
  for (const slot of [_cache.preview, _cache.full]) {
    slot.engine = null;
    slot.width = 0;
    slot.height = 0;
    slot.profile = null;
    slot.inputBuffer = null;
    slot.pristineBuffer = null;
    slot.lastSourceRef = null;
    slot.lastFilmBaseGains = null;
  }
}

export async function convertColorWithSilverCore(imageData, settings = {}, options = {}) {
  return runSilverCore(imageData, settings, 'color', options);
}

export async function convertBwWithSilverCore(imageData, settings = {}, options = {}) {
  return runSilverCore(imageData, settings, 'bw', options);
}

export async function convertPositiveWithSilverCore(imageData, settings = {}, options = {}) {
  return runSilverCore(imageData, settings, 'positive', options);
}

import { Engine } from '../silvercore/engine/Engine.js';
import { loadFilmPresets } from '../silvercore/engine/filmPresetsLoader.js';
import { bwMixWeights, toneProfiles } from '../silvercore/engine/Presets.js';
import { PROFILES as ENHANCED_PROFILE_NAMES } from '../silvercore/engine/EnhancedProfiles.js';
import {
  fromImageData8,
  toImageData8,
  cloneImage16,
} from '../silvercore/util/image16.js';
import { applyFilmBaseCompensationToBuffer } from './filmBaseCompensation.js';
import { analyzeImage, analyzeGreyImage, greyChannelLevels, adjustSaturation } from '../silvercore/engine/ImageProcessor.js';
import { normalizePaperId, normalizeToningId } from '../silvercore/engine/PaperProfiles.js';
import { applyExposureStopsToGrey } from '../silvercore/util/localExposure.js';
import {
  mixToGrey,
  allOpaque,
  packGreyTable,
  writeGreyOutput,
  convertGreyFromSource,
  greyHistogramFromSource,
} from '../silvercore/util/greyPlane.js';
import { rasterizeExposureStops } from '../app/localExposure.js';
import { applyFlatFieldToImage16 } from '../app/flatField.js';
import { analysisPixelBounds } from '../app/analysisRegion.js';
import { LARGE_IMAGE_PIXELS } from '../app/imageMemoryBudget.js';

// EnhancedProfiles.js owns the list of shipped 3D-LUT profiles and their .bin URLs;
// deriving the whitelist from it keeps the two in step. A hand-copied list here is
// what silently dropped 'noritsu' — the 196 KB noritsu.bin shipped in every build
// but the 'Noritsu Lab' preset's profile was rewritten to 'none' before it loaded.
const ENHANCED_PROFILE_SET = new Set(ENHANCED_PROFILE_NAMES);

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

// Plain JPEG/PNG previews have no attached plane. Keep their promotion with the
// engine slot so unchanged inputs retain both the analysis and film-base cache.
// forceFullProcess also supports callers that explicitly refresh pixels in place:
// such requests (and large images) promote for this request only, and the fresh
// plane is ours, so it serves as the work plane instead of being copied again.
function toImage16ForSlot(slot, input, transient = false) {
  if (input.data instanceof Uint16Array || input.__image16?.data instanceof Uint16Array) {
    slot.promotedSource = null;
    return { image: toImage16(input), owned: false };
  }
  if (transient) {
    slot.promotedSource = null;
    return { image: fromImageData8(input), owned: true };
  }
  const cached = slot.promotedSource;
  if (cached && cached.source === input.data
      && cached.image.width === input.width && cached.image.height === input.height) {
    return { image: cached.image, owned: false };
  }
  const image = fromImageData8(input);
  slot.promotedSource = { source: input.data, image };
  return { image, owned: false };
}

// Identity of a pixel buffer for the cache keys, without holding the buffer: a key
// that kept the array itself would pin a received 60 MP source in a retained worker.
const _bufferIds = new WeakMap();
let _nextBufferId = 1;
function _bufferId(buffer) {
  if (!buffer) return 0;
  let id = _bufferIds.get(buffer);
  if (!id) {
    id = _nextBufferId++;
    _bufferIds.set(buffer, id);
  }
  return id;
}

function localExposureStopsForSlot(slot, settings, width, height) {
  const exposure = settings?.localExposure;
  const geometry = settings?.localExposureGeometry;
  if (!geometry || !exposure?.strokes?.length) {
    slot.exposureMap = null;
    return null;
  }
  const workingGeometry = { ...geometry, width, height };
  // Settings snapshots are copied on each render: object identity alone cannot
  // identify an unchanged stroke. The exact content also catches undo and edits.
  const key = JSON.stringify([exposure, workingGeometry]);
  if (!slot.exposureMap || slot.exposureMap.key !== key) {
    slot.exposureMap = { key, stops: rasterizeExposureStops(exposure, workingGeometry) };
  }
  return slot.exposureMap.stops;
}

function normalizeAnalysisOverride(value) {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const channels = value.map((channel) => {
    if (!channel || typeof channel !== 'object') return null;
    const white = Number(channel.whitePointOrigin);
    const black = Number(channel.blackPointOrigin);
    const mean = Number(channel.meanPoint);
    if (![white, black, mean].every(Number.isFinite)) return null;
    return {
      whitePointOrigin: Math.round(Math.max(0, Math.min(65535, white))),
      blackPointOrigin: Math.round(Math.max(0, Math.min(65535, black))),
      meanPoint: Math.max(0, Math.min(1, mean)),
      settingName: String(channel.settingName || ''),
    };
  });
  return channels.every(Boolean) ? channels : null;
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

// Film presets name a tone profile ('base', 'base_gamma', 'filmic', ...). Anything the
// engine does not know about resolves to null, which leaves Engine.buildSettings free to
// derive the profile from the colour model exactly as it did before.
function normalizeToneProfile(value) {
  if (!value) return null;
  const name = String(value);
  return Object.prototype.hasOwnProperty.call(toneProfiles, name) ? name : null;
}

// Merge a film preset into the caller's settings.
//
// Precedence: the PRESET supplies defaults, the CALLER wins. A preset carries 23 keys.
// The app mirrors 8 of them (enhancedProfile, saturation, glow, fade, shadows,
// highlights, blacks, whites) into its own state the moment the preset is picked and
// sends them back on every conversion, so merging the preset on top — the old
// `{ ...baseSettings, ...preset.settings }` — silently re-applied the preset's values
// over the live sliders: the knob moved, the image did not. The other 15 keys
// (toneProfile, shadow/highlight/mid toning, ranges, layerOrder, wbTonality, ...) have
// no UI control and are never sent by the caller, so they still reach the engine from
// the preset. Keys the caller leaves `undefined` never mask a preset value.
function mergeFilmPresetSettings(baseSettings, presetSettings) {
  const merged = { ...presetSettings };
  for (const key of Object.keys(baseSettings)) {
    const value = baseSettings[key];
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

async function applyFilmPreset(baseSettings, presetId) {
  if (!presetId || presetId === 'none') return baseSettings;
  const filmPresets = await loadFilmPresets();
  const preset = filmPresets[presetId];
  if (!preset || !preset.settings) return baseSettings;
  return mergeFilmPresetSettings(baseSettings, preset.settings);
}

// Exported for tests and introspection: resolves caller settings + film preset into the
// flat, range-checked parameter object the engine consumes.
export async function buildSilverCoreParams(mode, settings = {}) {
  const merged = await applyFilmPreset(settings, settings.filmPreset);
  const colorModel = String(merged.colorModel || 'standard');
  // Standard negatives carry a blue hue correction; positive scans already
  // have positive colour, so their neutral starting model must be identity.
  const resolvedColorModel = mode === 'bw' ? 'mono' : mode === 'positive' && colorModel === 'standard' ? 'none' : colorModel;

  // Determine imageType from mode
  const imageType = mode === 'positive' ? 'positive' : 'negative';

  return {
    colorModel: resolvedColorModel,
    imageType,
    // Optional override; null means "derive from the colour model" (Engine.buildSettings).
    toneProfile: normalizeToneProfile(merged.toneProfile) || (mode === 'positive' ? 'positive' : null),
    positiveMode: merged.positiveMode === 'edit' ? 'edit' : 'correct',
    preSaturation: Math.round(sanitizeNumber(merged.preSaturation, 100, 0, 200)),
    borderBuffer: Math.round(sanitizeNumber(merged.borderBuffer, 10, 0, 30)),
    analysisRegion: merged.analysisRegion ? { ...merged.analysisRegion } : null,
    // Roll analysis: shared channelData that replaces this frame's histogram.
    analysisOverride: normalizeAnalysisOverride(merged.analysisOverride),
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
    // Cyan/red balance (the enlarger's C filtration); distinct from the legacy
    // step-3 `cyan` adjustment that the app's settings object also carries.
    colorCyan: sanitizeNumber(merged.colorCyan, 0, -100, 100),
    // Paper emulation, gated by the mode so RA-4 papers never reach a B&W print.
    paper: normalizePaperId(merged.paper, mode === 'positive' ? 'positive' : mode),
    paperToning: normalizeToningId(merged.paperToning),
    paperToningStrength: Math.round(sanitizeNumber(merged.paperToningStrength, 100, 0, 100)),
    saturation: normalizeSaturation(merged.saturation),
    glow: sanitizeNumber(merged.glow, 0, 0, 100),
    fade: sanitizeNumber(merged.fade, 0, 0, 100),
    curvePrecision: normalizeCurvePrecision(merged.curvePrecision),
    source: String(merged.source || 'cameraScan'),
    // Inert: the 16-bit pipeline has no GPU path (Engine._applyLuts is CPU-only and
    // Engine.initWebGL is never called from here). Kept so the plumbing stays visible.
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
// Dual cache for preview (small) and full (large) resolution engines.
//
// The cache holds the engine, the loaded 3D profile, the film-base-compensated
// `pristineBuffer`, the prepared prefix planes (see _prepareRgba / _prepareGrey) and a
// description of the inputs the current histogram analysis was computed from. It
// deliberately does NOT hold the buffer handed back to the caller — see
// _takeWorkBuffer. Requests with forceFullProcess and images over LARGE_IMAGE_PIXELS
// keep no plane at all (_transientWorkBuffer).
function _createSlot() {
  return {
    engine: null,
    width: 0,
    height: 0,
    profile: null,
    pristineBuffer: null,
    lastSourceRef: null,
    lastFilmBaseGains: null,
    analysis: null,
    referencePixels: {},
    promotedSource: null,
    exposureMap: null,
    // Pre-exposure level: { key, kind: 'rgba' | 'grey', plane, alpha }. `plane` is an
    // Image16 (rgba), a Uint16Array (grey) or null when the pristine plane or the
    // source itself is the prepared state.
    prepared: null,
    // Post-exposure level, only while dodge-and-burn stops exist: { key, plane }.
    exposed: null,
  };
}

// Counters for the tests: how often the expensive per-pixel prefix stages ran.
const _stats = { preprocess: 0, preparedBuilds: 0, exposedBuilds: 0 };

function _levelBytes(level) {
  const plane = level && level.plane;
  if (!plane) return 0;
  return (plane.data || plane).byteLength;
}

// What each slot holds and how often the prefix stages ran; for tests and debugging.
export function getSilverCoreCacheStats() {
  const slotInfo = (slot) => ({
    pristineBytes: slot.pristineBuffer ? slot.pristineBuffer.byteLength : 0,
    lastSourceRef: Boolean(slot.lastSourceRef),
    promotedSource: Boolean(slot.promotedSource),
    preparedKind: slot.prepared ? slot.prepared.kind : null,
    preparedBytes: _levelBytes(slot.prepared),
    exposedBytes: _levelBytes(slot.exposed),
    levels: (_levelBytes(slot.prepared) ? 1 : 0) + (_levelBytes(slot.exposed) ? 1 : 0),
  });
  return { ..._stats, preview: slotInfo(_cache.preview), full: slotInfo(_cache.full), scratch: slotInfo(_cache.scratch) };
}

// Tests exercise the large-image rule on small frames.
let _largeImagePixels = LARGE_IMAGE_PIXELS;
export function setLargeImagePixelsForTesting(pixels = LARGE_IMAGE_PIXELS) {
  _largeImagePixels = pixels;
}

const _cache = {
  preview: _createSlot(),
  full: _createSlot(),
  // Test strips and other side renders: never disturbs the preview or export cache.
  scratch: _createSlot(),
};

function filmBaseCompensationEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const aBase = a.base || {};
  const bBase = b.base || {};
  const aOptions = a.options || {};
  const bOptions = b.options || {};
  return aBase.r === bBase.r
    && aBase.g === bBase.g
    && aBase.b === bBase.b
    && aBase.r16 === bBase.r16
    && aBase.g16 === bBase.g16
    && aBase.b16 === bBase.b16
    && aOptions.method === bOptions.method
    && aOptions.strength === bOptions.strength
    && (a.flatFieldKey || '') === (b.flatFieldKey || '');
}

// Identity of a flat-field correction for the cache: which map, in which frame geometry.
function flatFieldKeyOf(settings) {
  const map = settings && settings.flatField;
  if (!map || !map.gains) return '';
  const g = settings.flatFieldGeometry || {};
  const crop = g.cropRegion ? `${g.cropRegion.left ?? g.cropRegion.x}|${g.cropRegion.top ?? g.cropRegion.y}|${g.cropRegion.width}|${g.cropRegion.height}` : '';
  return `${map.id || 'map'}|${g.baseWidth}x${g.baseHeight}|${g.rotationAngle || 0}|${g.mirrored ? 1 : 0}|${crop}`;
}

// Preprocessing that is baked into the cached pristine buffer: the flat field
// (light-pad falloff) first, then the film base compensation.
function _preprocessBuffer(data, width, height, preprocess) {
  _stats.preprocess++;
  if (preprocess.flatField && preprocess.flatFieldGeometry) {
    applyFlatFieldToImage16({ width, height, data }, preprocess.flatField, {
      ...preprocess.flatFieldGeometry,
      width,
      height,
    });
  }
  if (preprocess.base) {
    applyFilmBaseCompensationToBuffer(data, preprocess.base, preprocess.options);
  }
}

function _slotFor(options) {
  if (options && options.scratch) return _cache.scratch;
  return (options && options.preview) ? _cache.preview : _cache.full;
}

function _getOrCreateEngine(slot, w, h) {
  if (slot.engine && slot.width === w && slot.height === h) {
    return slot.engine;
  }
  Object.assign(slot, _createSlot());
  slot.engine = new Engine(w, h);
  slot.width = w;
  slot.height = h;
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

// Hand the engine a buffer that it may scribble on and that the CALLER then owns.
//
// Contract: the Image16 returned by a conversion — the `__image16` attached to the
// result — is never referenced by the cache again. An old version kept it as
// `slot.inputBuffer` and overwrote it on the next conversion, so every ImageData the
// adapter had ever returned for a slot aliased a single plane: undo snapshots, the
// dust-removal clean source, `state.processedImageData` and the gray-point sampler all
// silently mutated to whatever the newest render produced, and the conversion worker's
// transfer of `result.__image16.data.buffer` detached the cache out from under itself.
// Interactive conversions now write their output into a fresh buffer in the first
// curve pass (Engine.applyTail) and transient ones use their own work plane; this
// copy of the pristine plane serves the analysis sample.
//
// `pristineBuffer` caches the part that is actually expensive — the film-base
// per-pixel gain pass — and is rebuilt only when the source buffer or the gains
// change. With no film-base compensation there is nothing to precompute, so the cache
// is dropped and the copy comes straight from the source.
function _takeWorkBuffer(slot, image16, filmBaseCompensation) {
  return cloneImage16(_pristineFor(slot, image16, filmBaseCompensation));
}

// The film-base-compensated (and flat-fielded) source for interactive requests,
// cached per slot while the source and the gains stay the same. Read-only: every
// consumer copies from it or reads it into a fresh buffer. Without compensation the
// source itself is the pristine state.
function _pristineFor(slot, image16, filmBaseCompensation) {
  if (!filmBaseCompensation) {
    slot.pristineBuffer = null;
    slot.lastSourceRef = null;
    slot.lastFilmBaseGains = null;
    return image16;
  }

  const len = image16.data.length;
  const sourceRef = image16.data;
  const sizeChanged = !slot.pristineBuffer || slot.pristineBuffer.length !== len;
  const sourceChanged = sourceRef !== slot.lastSourceRef;
  const gainsChanged = !filmBaseCompensationEqual(slot.lastFilmBaseGains, filmBaseCompensation);

  if (sizeChanged || sourceChanged || gainsChanged) {
    if (sizeChanged) slot.pristineBuffer = new Uint16Array(len);
    slot.pristineBuffer.set(sourceRef);
    _preprocessBuffer(slot.pristineBuffer, image16.width, image16.height, filmBaseCompensation);
    slot.lastSourceRef = sourceRef;
    slot.lastFilmBaseGains = {
      base: filmBaseCompensation.base ? { ...filmBaseCompensation.base } : null,
      options: filmBaseCompensation.options ? { ...filmBaseCompensation.options } : {},
      flatFieldKey: filmBaseCompensation.flatFieldKey || '',
    };
  }

  return { width: image16.width, height: image16.height, data: slot.pristineBuffer };
}

function _dropSlotPlanes(slot) {
  slot.pristineBuffer = null;
  slot.lastSourceRef = null;
  slot.lastFilmBaseGains = null;
  slot.prepared = null;
  slot.exposed = null;
}

// forceFullProcess requests (settle, export, frame repair and batch-lane renders) and
// images over LARGE_IMAGE_PIXELS. A worker receives a fresh copy of the source with
// every such request, so a cached pristine plane was rebuilt on every call and never
// read again, while a retained batch lane held it (480 MB at 60 MP) between frames.
// Instead the one work plane is preprocessed in place and the slot keeps nothing.
// The same buffer length takes the same film-base path, so the pixels are identical.
function _transientWorkBuffer(slot, image16, owned, filmBaseCompensation, reuse = null) {
  _dropSlotPlanes(slot);
  let work = image16;
  if (!owned && reuse) {
    reuse.set(image16.data);
    work = { width: image16.width, height: image16.height, data: reuse };
  } else if (!owned) {
    work = cloneImage16(image16);
  }
  if (filmBaseCompensation) _preprocessBuffer(work.data, work.width, work.height, filmBaseCompensation);
  return work;
}

// A plane for a prepared level: the previous level's memory when the size matches
// (it is never handed out, so reusing it is safe), else a new one.
function _recycledPlane(previous, length) {
  return previous && previous.length === length ? previous : new Uint16Array(length);
}

// `options.workBuffer16` is a plane the caller hands back for the output: the preview
// worker's own previous result, which nothing else references (#233). Every path
// writes it in full before returning it, so the output is identical to a fresh
// allocation. It is refused when its size differs or it shares memory with the source,
// the analysis sample or a plane the slot keeps.
function _reusableOutput(slot, reuse, length, input16, reference) {
  if (!(reuse instanceof Uint16Array) || reuse.length !== length) return null;
  const dataOf = (plane) => (plane instanceof Uint16Array ? plane : plane?.data) || null;
  const kept = [input16.data, reference?.data, slot.pristineBuffer, dataOf(slot.prepared?.plane), slot.prepared?.alpha,
    dataOf(slot.exposed?.plane), slot.referencePixels?.pristineBuffer];
  return kept.some((data) => data && data.buffer === reuse.buffer) ? null : reuse;
}

// Everything the histogram analysis depends on. analyzeImage() reads borderBuffer (the
// analysis crop), colorModel (the black/white clip thresholds) and imageType, plus the
// prepared pixels — which depend on the source buffer, the film-base gains, the
// pre-tone saturation and, in B&W, the channel mix. Every other parameter only reshapes
// the LUTs and can go through the cheap reprocess() path.
function _analysisStateFor(params, filmBaseCompensation, sourceRef, mode, reference = null) {
  const base = filmBaseCompensation ? filmBaseCompensation.base : null;
  const options = filmBaseCompensation ? filmBaseCompensation.options : null;
  return {
    sourceId: _bufferId(sourceRef),
    referenceSize: reference ? `${reference.width}x${reference.height}` : null,
    borderBuffer: params.borderBuffer,
    analysisRegionKey: JSON.stringify(params.analysisRegion || null),
    colorModel: params.colorModel,
    imageType: params.imageType,
    positiveMode: params.positiveMode,
    preSaturation: params.preSaturation,
    bwMix: mode === 'bw' ? params.bwMix : null,
    analysisOverrideKey: params.analysisOverride ? JSON.stringify(params.analysisOverride) : '',
    filmBaseKey: (base
      ? `${base.r}|${base.g}|${base.b}|${base.r16}|${base.g16}|${base.b16}|${options.method}|${options.strength}`
      : '') + (filmBaseCompensation && filmBaseCompensation.flatFieldKey ? `|ff:${filmBaseCompensation.flatFieldKey}` : ''),
  };
}

function _analysisChanged(previous, next) {
  if (!previous) return true;
  return previous.sourceId !== next.sourceId
    || previous.referenceSize !== next.referenceSize
    || previous.borderBuffer !== next.borderBuffer
    || previous.analysisRegionKey !== next.analysisRegionKey
    || previous.colorModel !== next.colorModel
    || previous.imageType !== next.imageType
    || previous.positiveMode !== next.positiveMode
    || previous.preSaturation !== next.preSaturation
    || previous.bwMix !== next.bwMix
    || previous.analysisOverrideKey !== next.analysisOverrideKey
    || previous.filmBaseKey !== next.filmBaseKey;
}

// Determine whether we need full process() (histogram re-analysis) or can use
// reprocess(). Re-analysing on every slider tick would throw away the whole point of
// the split, but skipping it whenever channelData merely exists meant Border Buffer,
// Colour Model and a freshly sampled film base changed the pixels while the LUTs stayed
// pinned to the previous frame's black/white points — the preview then disagreed with
// the full-resolution render that followed.
function _needsFullProcess(slot, options, analysisState) {
  if (!slot.engine || !slot.engine.channelData) return true;
  if (options && options.forceFullProcess) return true;
  return _analysisChanged(slot.analysis, analysisState);
}

// The pre-exposure key: every input of the prepared prefix. The analysis state covers
// the parameters, the film base / flat field and the analysed buffer (the reference
// sample when there is one), so the input's own identity, the mode, the derived
// positive analysis and the plane's representation are added.
function _preparedKey(analysisState, input16, mode, engine, kind) {
  return JSON.stringify([analysisState, _bufferId(input16.data), mode, engine.positiveAnalysis || null, kind]);
}

function _toResult(processed16) {
  const result = toImageData8(processed16);
  result.__image16 = processed16;
  return result;
}

// Interactive RGBA path (colour, positive, and B&W when the grey table is unavailable).
//
// The prefix — B&W mix → pre-saturation → positive gain/WB → dodge-and-burn stops —
// depends on nothing a Brightness, Contrast, Temperature, Saturation or Paper tick
// changes, so it is kept per slot as up to two levels over the pristine plane: the
// pre-exposure level (a plane of its own only when one of its stages is active) and
// the post-exposure level (only while stops exist). A tick that changes neither key
// reads the cached level straight into the fresh output buffer (Engine.applyTail).
function _prepareRgba(ctx) {
  const { slot, engine, params, mode, input16, filmBaseCompensation, reference, needsFullProcess, analysisState } = ctx;
  const base = _pristineFor(slot, input16, filmBaseCompensation);
  const len = base.data.length;
  const copyOfBase = (recycled) => {
    const plane = { width: base.width, height: base.height, data: _recycledPlane(recycled, len) };
    plane.data.set(base.data);
    if (mode === 'bw') toGrayscaleInPlace(plane, params.bwMix);
    return plane;
  };
  const preSaturationActive = (params.preSaturation ?? 100) !== 100;

  let pre;
  let key;
  if (!reference && needsFullProcess) {
    // The analysis changed: build the level in process() order. analyze() applies the
    // pre-saturation in place and derives the statistics and the positive analysis.
    const recycled = slot.prepared?.plane?.data || null;
    slot.prepared = null;
    slot.exposed = null;
    pre = mode === 'bw' || preSaturationActive ? copyOfBase(recycled) : base;
    engine.analyze(pre, params);
    if (!engine.positiveAnalysisIsIdentity()) {
      if (pre === base) pre = copyOfBase(recycled);
      engine._applyPositiveAnalysis(pre);
    }
    key = _preparedKey(analysisState, input16, mode, engine, 'rgba');
    slot.prepared = { key, kind: 'rgba', plane: pre === base ? null : pre, alpha: null };
    _stats.preparedBuilds++;
  } else {
    key = _preparedKey(analysisState, input16, mode, engine, 'rgba');
    if (slot.prepared && slot.prepared.key === key) {
      pre = slot.prepared.plane || base;
    } else {
      // Analysed from the reference sample, or a new source / mode with the same
      // analysis: the stages as reprocess() runs them (pre-saturation is applied here
      // because no analyze() ran on this buffer).
      const recycled = slot.prepared?.plane?.data || null;
      slot.prepared = null;
      slot.exposed = null;
      pre = base;
      if (mode === 'bw' || preSaturationActive || !engine.positiveAnalysisIsIdentity()) {
        pre = copyOfBase(recycled);
        engine._applyPreSaturation(pre, params);
        engine._applyPositiveAnalysis(pre);
      }
      slot.prepared = { key, kind: 'rgba', plane: pre === base ? null : pre, alpha: null };
      _stats.preparedBuilds++;
    }
  }

  const stops = params.localExposureStops;
  if (!(stops && stops.length === len / 4)) {
    slot.exposed = null;
    return pre;
  }
  const exposedKey = `${key}|${slot.exposureMap.key}`;
  if (slot.exposed && slot.exposed.key === exposedKey) return slot.exposed.plane;
  // A stroke edit rebuilds only this level, from the pre-exposure level.
  const recycled = slot.exposed?.plane?.data || null;
  slot.exposed = null;
  const post = { width: pre.width, height: pre.height, data: _recycledPlane(recycled, len) };
  post.data.set(pre.data);
  engine._applyLocalExposure(post, params);
  slot.exposed = { key: exposedKey, plane: post };
  _stats.exposedBuilds++;
  return post;
}

// Interactive B&W path: the same two levels as single-channel grey planes (2 B/px),
// the mix and the pre-saturation ramp baked in, and the output written through one
// grey → RGB table.
function _prepareGrey(ctx) {
  const { slot, engine, params, mode, input16, filmBaseCompensation, reference, needsFullProcess, analysisState } = ctx;
  const base = _pristineFor(slot, input16, filmBaseCompensation);
  const n = base.width * base.height;
  const weights = bwMixWeights[params.bwMix] || bwMixWeights.standard;
  const build = () => {
    const recycled = slot.prepared?.kind === 'grey' ? slot.prepared.plane : null;
    slot.prepared = null;
    slot.exposed = null;
    const grey = mixToGrey(base.data, weights, engine.preSaturationRamp(params), _recycledPlane(recycled, n));
    // Alpha passes through every stage untouched: keep a flag, or the plane it lives in.
    return { grey, alpha: allOpaque(base.data) ? null : base.data };
  };

  let level;
  let key;
  if (!reference && needsFullProcess) {
    level = build();
    engine.analyzeGrey(() => analyzeGreyImage(level.grey, base.width, base.height, params, level.alpha), params);
    key = _preparedKey(analysisState, input16, mode, engine, 'grey');
    slot.prepared = { key, kind: 'grey', plane: level.grey, alpha: level.alpha };
    _stats.preparedBuilds++;
  } else {
    key = _preparedKey(analysisState, input16, mode, engine, 'grey');
    if (slot.prepared && slot.prepared.key === key) {
      level = { grey: slot.prepared.plane, alpha: slot.prepared.alpha };
    } else {
      level = build();
      slot.prepared = { key, kind: 'grey', plane: level.grey, alpha: level.alpha };
      _stats.preparedBuilds++;
    }
  }

  const stops = params.localExposureStops;
  if (!(stops && stops.length === n)) {
    slot.exposed = null;
    return level;
  }
  const exposedKey = `${key}|${slot.exposureMap.key}`;
  if (slot.exposed && slot.exposed.key === exposedKey) return { grey: slot.exposed.plane, alpha: level.alpha };
  const recycled = slot.exposed?.plane || null;
  slot.exposed = null;
  const post = _recycledPlane(recycled, n);
  post.set(level.grey);
  applyExposureStopsToGrey(post, stops);
  slot.exposed = { key: exposedKey, plane: post };
  _stats.exposedBuilds++;
  return { grey: post, alpha: level.alpha };
}

function _greyResult(width, height, write, reuse = null) {
  const out16 = reuse || new Uint16Array(width * height * 4);
  const out8 = new Uint8ClampedArray(width * height * 4);
  write(out16, out8);
  const result = new ImageData(out8, width, height);
  result.__image16 = { width, height, data: out16 };
  return result;
}

// forceFullProcess B&W: no plane is kept. The source is read by one fused pass (mix →
// pre-saturation → stops → table). Without a reference sample the histogram comes
// first, from the same mix computed on the fly over the analysis crop: at 12 MP that
// measured as fast as a transient grey plane (81–89 vs 76–104 ms) without its 2 B/px.
function _transientGrey(ctx) {
  const { slot, engine, params, input16, owned, filmBaseCompensation, reference, needsFullProcess, analysisPreview, reuse } = ctx;
  // A flat field needs its own plane; the promoted 8-bit plane is ours already. Both
  // then take the output in place, so the peak matches the in-place RGBA path.
  _dropSlotPlanes(slot);
  const base = filmBaseCompensation ? _transientWorkBuffer(slot, input16, owned, filmBaseCompensation, reuse) : input16;
  const writable = Boolean(filmBaseCompensation) || owned;
  const n = base.width * base.height;
  const weights = bwMixWeights[params.bwMix] || bwMixWeights.standard;
  const preSatRamp = engine.preSaturationRamp(params);
  const stops = params.localExposureStops && params.localExposureStops.length === n ? params.localExposureStops : null;
  if (!reference && needsFullProcess) {
    engine.analyzeGrey(() => {
      const bounds = analysisPixelBounds(base.width, base.height, params.analysisRegion, (params.borderBuffer ?? 10) / 100);
      const { hist, total } = greyHistogramFromSource(base.data, base.width, bounds, weights, preSatRamp, Boolean(params.excludeTransparent));
      return greyChannelLevels(hist, total, params);
    }, params);
  }
  const table = analysisPreview ? engine.buildCurrentGreyTable(params) : engine.buildGreyTable(params);
  // Without stops the pre-saturation ramp composes into the table.
  const packed = packGreyTable(table, stops ? null : preSatRamp);
  const out16 = writable ? base.data : reuse || new Uint16Array(base.data.length);
  const out8 = new Uint8ClampedArray(base.data.length);
  convertGreyFromSource(base.data, weights, stops ? preSatRamp : null, stops, packed, out16, out8);
  const result = new ImageData(out8, base.width, base.height);
  result.__image16 = { width: base.width, height: base.height, data: out16 };
  return result;
}

async function runSilverCore(imageData, settings, mode, options) {
  const slot = _slotFor(options);
  const params = await buildSilverCoreParams(mode, settings);

  // Promote whatever the caller hands us into Image16. Loaders attach __image16
  // directly so the upcast is zero-copy in the common case.
  const sourceShape = imageData.__image16?.data instanceof Uint16Array ? imageData.__image16 : imageData;
  const engine = _getOrCreateEngine(slot, sourceShape.width, sourceShape.height);
  // Interactive requests keep the pristine and prepared planes in every slot; the
  // others keep none (see _transientWorkBuffer).
  const transient = Boolean(options?.forceFullProcess)
    || sourceShape.width * sourceShape.height > _largeImagePixels;
  const { image: input16, owned } = toImage16ForSlot(slot, imageData, transient);

  // Profile loading (skip if unchanged)
  const profileName = params.enhancedProfile;
  await _ensureProfile(slot, engine, profileName);
  if (slot.profile === 'none' && profileName !== 'none') {
    params.enhancedProfile = 'none';
    params.profileStrength = 0;
  }

  // Film-base compensation cancels the orange mask, which only colour negative film
  // has. B&W film has no mask (and the Step-2 UI hides the control for it) and slide
  // film has none either — but the app still sends a filmBase object, so B&W scans were
  // multiplied by the default {210,140,90} base (r 0.70 / g 1.05 / b 1.63 in linear
  // mode, clipping blue above ~61% of range) or by whatever colour negative happened to
  // be sampled last, making the same file convert differently from run to run.
  // The flat field (camera-scan light pad) applies to every mode; it is baked
  // into the same cached buffer as the film base compensation.
  const flatFieldKey = flatFieldKeyOf(settings);
  const filmBaseCompensation = (mode === 'color' && settings && settings.filmBase) || flatFieldKey
    ? {
        base: mode === 'color' && settings && settings.filmBase ? settings.filmBase : null,
        options: {
          method: settings.filmBaseCompensation || settings.filmBaseMethod || 'density',
          strength: settings.filmBaseStrength ?? 1
        },
        flatField: flatFieldKey ? settings.flatField : null,
        flatFieldGeometry: flatFieldKey ? settings.flatFieldGeometry : null,
        flatFieldKey
      }
    : null;

  const candidate = options?.analysisImageData;
  const reference = candidate?.data instanceof Uint16Array
    && candidate.data.length === candidate.width * candidate.height * 4 ? candidate : null;
  const analysisParams = reference ? { ...params, analysisRegion: null, excludeTransparent: true } : params;
  const analysisState = _analysisStateFor(analysisParams, filmBaseCompensation, reference ? reference.data : input16.data, mode, reference);
  const needsFullProcess = _needsFullProcess(slot, options, analysisState);

  // Dodge and burn: rasterise the strokes for this buffer's size. The engine
  // applies them after the analysis and before the curves; the analysis
  // sample (reference) is never dodged, like the base exposure in a darkroom.
  params.localExposureStops = localExposureStopsForSlot(slot, settings, input16.width, input16.height);

  // B&W: every stage after the mix depends on the grey value alone, so unless a
  // spatial stage is active the output comes from one grey plane and a grey → RGB table.
  const greyPath = mode === 'bw' && engine.greyTableAvailable(params);

  // 解析用の撮影窓は出力範囲とは独立。プレビュー・書き出しとも同じ標本で LUT を作る。
  // The sample keeps the RGBA path in every mode.
  let analysisPreview = null;
  const needsAnalysisPreview = options?.includeAnalysisPreview !== false;
  if (reference && (needsFullProcess || needsAnalysisPreview)) {
    const sample = transient
      ? _transientWorkBuffer({}, reference, false, filmBaseCompensation)
      : _takeWorkBuffer(slot.referencePixels, reference, filmBaseCompensation);
    if (mode === 'bw') toGrayscaleInPlace(sample, params.bwMix);
    if (needsAnalysisPreview) {
      analysisPreview = toImageData8(needsFullProcess
        ? engine.process(sample, analysisParams)
        : engine.reprocess(sample, analysisParams));
    } else if (needsFullProcess) {
      engine.analyze(sample, analysisParams);
    }
  }

  const ctx = { slot, engine, params, mode, input16, owned, filmBaseCompensation, reference, needsFullProcess, analysisState, analysisPreview };
  const planeLength = input16.width * input16.height * 4;
  let result;
  if (transient && greyPath) {
    // The transient paths drop the slot's planes first: only the source and the sample can alias.
    result = _transientGrey({ ...ctx, reuse: _reusableOutput({}, options?.workBuffer16, planeLength, input16, reference) });
  } else if (transient) {
    // B&W: mix down to a neutral negative BEFORE the engine runs. Doing it afterwards
    // (the old toGrayscaleInPlace on the result) discarded the shadow/highlight/mid
    // toning every one of the 18 B&W presets is built around, so sepia, selenium,
    // cyanotype and the rest all rendered identically neutral. Mixing on the way in also
    // puts the channel-filter presets ('red', 'orange', ...) before the histogram
    // analysis and the per-channel curves, where a taking filter belongs.
    const input = _transientWorkBuffer(slot, input16, owned, filmBaseCompensation,
      _reusableOutput({}, options?.workBuffer16, planeLength, input16, reference));
    if (mode === 'bw') toGrayscaleInPlace(input, params.bwMix);
    // Hand the caller an ImageData (the contract the rest of the app still uses) but
    // leave the 16-bit handle attached so downstream stages (histogram, export) can
    // read the full-precision result without re-deriving from 8-bit. The attached plane
    // belongs to the caller: nothing here writes to it again.
    result = _toResult(analysisPreview
      ? engine.applyCurrentCurves(input, params)
      : !reference && needsFullProcess
      ? engine.process(input, params)
      : engine.reprocess(input, params));
  } else if (greyPath) {
    const level = _prepareGrey(ctx);
    const table = packGreyTable(analysisPreview ? engine.buildCurrentGreyTable(params) : engine.buildGreyTable(params));
    result = _greyResult(input16.width, input16.height, (out16, out8) => writeGreyOutput(level.grey, level.alpha, table, out16, out8),
      _reusableOutput(slot, options?.workBuffer16, planeLength, input16, reference));
  } else {
    const src = _prepareRgba(ctx);
    // The first tail pass reads the cached level and writes the caller's buffer.
    const reuse = _reusableOutput(slot, options?.workBuffer16, src.data.length, input16, reference);
    const dst = { width: src.width, height: src.height, data: reuse || new Uint16Array(src.data.length) };
    result = _toResult(analysisPreview ? engine.applyCurrentTail(src, dst, params) : engine.applyTail(src, dst, params));
  }

  if (needsFullProcess) slot.analysis = analysisState;
  if (analysisPreview) result.__analysisPreview = analysisPreview;
  // 参照の種類・寸法・画素バッファ・解析設定をキーにし、通常画像と混同しない。
  if (!reference || transient) slot.referencePixels = {};
  return result;
}

// Runs the histogram analysis exactly as a conversion would (film-base
// compensation, B&W mix, pre-tone saturation, analysis crop) without building
// curves or touching the engine cache. Roll analysis calls this per frame and
// aggregates the channelData across the roll. `analysisOverride` in the settings
// is ignored here on purpose: the point is to measure this frame.
export async function analyzeSilverCoreFrame(imageData, settings = {}, mode = 'color') {
  const params = await buildSilverCoreParams(mode, { ...settings, analysisOverride: null });
  const input = cloneImage16(toImage16(imageData));
  _preprocessBuffer(input.data, input.width, input.height, {
    base: mode === 'color' && settings && settings.filmBase ? settings.filmBase : null,
    options: {
      method: settings.filmBaseCompensation || settings.filmBaseMethod || 'density',
      strength: settings.filmBaseStrength ?? 1,
    },
    flatField: settings.flatField || null,
    flatFieldGeometry: settings.flatFieldGeometry || null,
  });
  if (mode === 'bw') toGrayscaleInPlace(input, params.bwMix);
  if (params.preSaturation !== 100) adjustSaturation(input, params.preSaturation);
  return analyzeImage(input, params);
}

export function invalidateSilverCoreCache() {
  for (const slot of [_cache.preview, _cache.full, _cache.scratch]) {
    Object.assign(slot, _createSlot());
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

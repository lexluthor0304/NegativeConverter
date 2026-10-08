import { Engine } from '../silvercore/engine/Engine.js';
import { loadFilmPresets, getLoadedFilmPresets } from '../silvercore/engine/filmPresetsLoader.js';
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
import { applyExposureStopsToGrey, applyExposureStopsToGreyRect, applyExposureStopsToImage16Rect, hasExposureStops, exposureStopsCover, exposeRgbaRun, exposeGreyValue } from '../silvercore/util/localExposure.js';
import {
  mixToGrey,
  allOpaque,
  packGreyTable,
  writeGreyOutput,
  convertGreyFromSource,
  greyHistogramFromSource,
} from '../silvercore/util/greyPlane.js';
import { rasterizeExposureStopsTiled, updateExposureStopsMap, exposureMapKey, exposureStopsBytes, liveStrokeCoverageRect } from '../app/localExposure.js';
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

// `region` (#248's detail layer): the buffer is the region of a frame of
// frameWidth x frameHeight at originX/originY, and gets that region's stops.
//
// Interactive slots keep a dense map that follows the stroke list (#254 D1): a
// new stroke is added into it and an undone last stroke written back, only
// inside that stroke's box, and `slot.exposureChange` names the box so the
// post-exposure level is updated there only. `transient` requests (full
// resolution, exports) get a tiled map (#254 D5): 256 x 256 tiles only where
// strokes reach. Both hold exactly the values of a full dense raster.
function localExposureStopsForSlot(slot, settings, width, height, region = null, transient = false) {
  const exposure = settings?.localExposure;
  const geometry = settings?.localExposureGeometry;
  if (!geometry || !exposure?.strokes?.length) {
    slot.exposureMap = null;
    slot.exposureChange = null;
    return null;
  }
  const workingGeometry = region
    ? { ...geometry, width: region.frameWidth, height: region.frameHeight, window: { x: region.originX, y: region.originY, width, height } }
    : { ...geometry, width, height };
  // Settings snapshots are copied on each render: object identity alone cannot
  // identify an unchanged stroke. The exact content also catches undo and edits.
  if (transient) {
    const key = exposureMapKey(exposure, workingGeometry);
    if (!slot.exposureMap || slot.exposureMap.key !== key) {
      slot.exposureMap = { key, tiled: true, stops: rasterizeExposureStopsTiled(exposure, workingGeometry) };
      slot.exposureChange = null;
      _stats.exposureMaps.tiled++;
    }
    return slot.exposureMap.stops;
  }
  const previous = slot.exposureMap && !slot.exposureMap.tiled ? slot.exposureMap : null;
  const { map, change } = updateExposureStopsMap(previous, exposure, workingGeometry, _stats.exposureMaps);
  // An unchanged map keeps the last change: the level may not have followed it
  // yet (the GPU preview's prepare updates the map before the next frame).
  if (map !== previous || change) slot.exposureChange = change;
  slot.exposureMap = map;
  return map.stops;
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

function namesFilmPreset(settings) {
  return Boolean(settings.filmPreset && settings.filmPreset !== 'none');
}

function applyFilmPresetFrom(filmPresets, baseSettings, presetId) {
  if (!presetId || presetId === 'none') return baseSettings;
  const preset = filmPresets[presetId];
  if (!preset || !preset.settings) return baseSettings;
  return mergeFilmPresetSettings(baseSettings, preset.settings);
}

// Exported for tests and introspection: resolves caller settings + film preset into the
// flat, range-checked parameter object the engine consumes.
export async function buildSilverCoreParams(mode, settings = {}) {
  return resolveSilverCoreParams(mode, settings, namesFilmPreset(settings) ? await loadFilmPresets() : null);
}

// buildSilverCoreParams() for callers that must not wait (the GPU preview draws in the
// animation frame, #239): null while a named film preset's table has not loaded yet,
// whose load it then starts.
export function trySilverCoreParams(mode, settings = {}) {
  if (!namesFilmPreset(settings)) return resolveSilverCoreParams(mode, settings, null);
  const filmPresets = getLoadedFilmPresets();
  if (!filmPresets) {
    void loadFilmPresets().catch(() => {});
    return null;
  }
  return resolveSilverCoreParams(mode, settings, filmPresets);
}

// The synchronous body of buildSilverCoreParams, with the film-preset table given.
export function resolveSilverCoreParams(mode, settings = {}, filmPresets = null) {
  if (namesFilmPreset(settings) && !filmPresets) throw new Error('Film presets are not loaded');
  const merged = applyFilmPresetFrom(filmPresets, settings, settings.filmPreset);
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

export function toGrayscaleInPlace(image16, mixPreset) {
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
// Every rebuild or drop of a slot's pristine or prepared planes takes a new
// epoch, so a live dodge-and-burn request (#254) can tell that the planes of the
// frame it paints over are still the ones in the slot.
let _planeEpoch = 0;
let _liveSeq = 0;

function _bumpPlanes(slot) {
  slot.planeEpoch = ++_planeEpoch;
}

function _createSlot() {
  return {
    planeEpoch: ++_planeEpoch,
    // What the last interactive conversion of this slot drew with, for live
    // dodge-and-burn rectangles (#254 C): see renderLiveExposureRect.
    live: null,
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
    // What the last map update changed in place: { fromKey, rect } or null (#254).
    exposureChange: null,
    // Pre-exposure level: { key, kind: 'rgba' | 'grey', plane, alpha }. `plane` is an
    // Image16 (rgba), a Uint16Array (grey) or null when the pristine plane or the
    // source itself is the prepared state.
    prepared: null,
    // Post-exposure level, only while dodge-and-burn stops exist: { key, plane }.
    exposed: null,
  };
}

// Counters for the tests: how often the expensive per-pixel prefix stages ran.
// exposedUpdates: post-exposure levels updated inside a stroke's box only (#254);
// exposureMaps: how the stops maps were made (full / extended / undone / tiled).
const _stats = { preprocess: 0, preparedBuilds: 0, exposedBuilds: 0, exposedUpdates: 0, liveRects: 0,
  exposureMaps: { full: 0, extended: 0, undone: 0, tiled: 0 } };

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
    exposureMapBytes: slot.exposureMap ? exposureStopsBytes(slot.exposureMap.stops) : 0,
    exposureMapTiled: Boolean(slot.exposureMap?.tiled),
    levels: (_levelBytes(slot.prepared) ? 1 : 0) + (_levelBytes(slot.exposed) ? 1 : 0),
  });
  return { ..._stats, exposureMaps: { ..._stats.exposureMaps },
    preview: slotInfo(_cache.preview), full: slotInfo(_cache.full), scratch: slotInfo(_cache.scratch), roi: slotInfo(_cache.roi) };
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
  // The detail layer's regions (#248): one fixed size, so panning never
  // rebuilds the engine; regions are transient and keep no plane.
  roi: _createSlot(),
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

// The film-base / flat-field preprocessing a conversion of `settings` in `mode` bakes
// into its pristine plane, or null when there is none.
//
// Film-base compensation cancels the orange mask, which only colour negative film
// has. B&W film has no mask (and the Step-2 UI hides the control for it) and slide
// film has none either — but the app still sends a filmBase object, so B&W scans were
// multiplied by the default {210,140,90} base (r 0.70 / g 1.05 / b 1.63 in linear
// mode, clipping blue above ~61% of range) or by whatever colour negative happened to
// be sampled last, making the same file convert differently from run to run.
// The flat field (camera-scan light pad) applies to every mode; it is baked
// into the same cached buffer as the film base compensation.
function filmBaseCompensationFor(settings, mode) {
  const flatFieldKey = flatFieldKeyOf(settings);
  return (mode === 'color' && settings && settings.filmBase) || flatFieldKey
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
}

// The part of the analysis state that describes the preprocessing.
function filmBaseKeyOf(filmBaseCompensation) {
  const base = filmBaseCompensation ? filmBaseCompensation.base : null;
  const options = filmBaseCompensation ? filmBaseCompensation.options : null;
  return (base
    ? `${base.r}|${base.g}|${base.b}|${base.r16}|${base.g16}|${base.b16}|${options.method}|${options.strength}`
    : '') + (filmBaseCompensation && filmBaseCompensation.flatFieldKey ? `|ff:${filmBaseCompensation.flatFieldKey}` : '');
}

// Preprocessing that is baked into the cached pristine buffer: the flat field
// (light-pad falloff) first, then the film base compensation. A detail region
// (#248, `preprocess.region`) gets the flat field of its place in the frame.
function _preprocessBuffer(data, width, height, preprocess) {
  _stats.preprocess++;
  if (preprocess.flatField && preprocess.flatFieldGeometry) {
    const region = preprocess.region || null;
    applyFlatFieldToImage16({ width, height, data }, preprocess.flatField, region
      ? { ...preprocess.flatFieldGeometry, width: region.frameWidth, height: region.frameHeight, window: { x: region.originX, y: region.originY } }
      : { ...preprocess.flatFieldGeometry, width, height });
  }
  if (preprocess.base) {
    applyFilmBaseCompensationToBuffer(data, preprocess.base, preprocess.options);
  }
}

function _slotFor(options) {
  if (options && options.scratch) return _cache.scratch;
  if (options && options.region) return _cache.roi;
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
    _bumpPlanes(slot);
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
  _bumpPlanes(slot);
  slot.live = null;
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
    positiveOverrideKey: params.positiveAnalysisOverride ? JSON.stringify(params.positiveAnalysisOverride) : '',
    filmBaseKey: filmBaseKeyOf(filmBaseCompensation),
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
    || previous.positiveOverrideKey !== next.positiveOverrideKey
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
// The post-exposure level after the stops map changed in place (#254 D1, the
// map's `change`): pixels inside the changed box are copied from the
// pre-exposure level and exposed again, the rest are already right. False when
// the level is not the one the change started from (it is then rebuilt).
function _followExposureChange(slot, preparedKey, kind, pre, stops, change) {
  const exposed = slot.exposed;
  if (!change || !exposed || exposed.key !== `${preparedKey}|${change.fromKey}`) return false;
  if (change.rect) {
    const { x, y, width, height } = change.rect;
    if (kind === 'grey') {
      if (exposed.plane.length !== pre.grey.length) return false;
      const frameWidth = exposed.plane.length / slot.height;
      for (let row = y; row < y + height; row++) {
        const from = row * frameWidth + x;
        exposed.plane.set(pre.grey.subarray(from, from + width), from);
      }
      applyExposureStopsToGreyRect(exposed.plane, frameWidth, stops, change.rect);
    } else {
      if (exposed.plane.data.length !== pre.data.length) return false;
      for (let row = y; row < y + height; row++) {
        const from = (row * pre.width + x) * 4;
        exposed.plane.data.set(pre.data.subarray(from, from + width * 4), from);
      }
      applyExposureStopsToImage16Rect(exposed.plane, stops, change.rect);
    }
  }
  exposed.key = `${preparedKey}|${slot.exposureMap.key}`;
  _stats.exposedUpdates++;
  return true;
}

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
    _bumpPlanes(slot);
    slot.exposed = null;
    pre = mode === 'bw' || preSaturationActive ? copyOfBase(recycled) : base;
    engine.analyze(pre, params);
    if (!engine.positiveAnalysisIsIdentity()) {
      // The GPU preview's `analyze` (#239) stops at the analysis: the frame that
      // follows builds this level itself, as it does for a new source.
      if (ctx.analysisOnly) return null;
      if (pre === base) pre = copyOfBase(recycled);
      engine._applyPositiveAnalysis(pre);
    }
    key = _preparedKey(analysisState, input16, mode, engine, 'rgba');
    slot.prepared = { key, kind: 'rgba', plane: pre === base ? null : pre, alpha: null };
    _stats.preparedBuilds++;
    _bumpPlanes(slot);
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
      _bumpPlanes(slot);
      slot.exposed = null;
      pre = base;
      if (mode === 'bw' || preSaturationActive || !engine.positiveAnalysisIsIdentity()) {
        pre = copyOfBase(recycled);
        engine._applyPreSaturation(pre, params);
        engine._applyPositiveAnalysis(pre);
      }
      slot.prepared = { key, kind: 'rgba', plane: pre === base ? null : pre, alpha: null };
      _stats.preparedBuilds++;
      _bumpPlanes(slot);
    }
  }

  ctx.preLevel = pre;
  ctx.preparedKey = key;
  const stops = params.localExposureStops;
  if (!(stops && stops.length === len / 4)) {
    slot.exposed = null;
    return pre;
  }
  const exposedKey = `${key}|${slot.exposureMap.key}`;
  if (slot.exposed && slot.exposed.key === exposedKey) return slot.exposed.plane;
  // A stroke added or undone in place (#254 D1): the level changes inside its box only.
  if (_followExposureChange(slot, key, 'rgba', pre, stops, slot.exposureChange)) return slot.exposed.plane;
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
    _bumpPlanes(slot);
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
    _bumpPlanes(slot);
  } else {
    key = _preparedKey(analysisState, input16, mode, engine, 'grey');
    if (slot.prepared && slot.prepared.key === key) {
      level = { grey: slot.prepared.plane, alpha: slot.prepared.alpha };
    } else {
      level = build();
      slot.prepared = { key, kind: 'grey', plane: level.grey, alpha: level.alpha };
      _stats.preparedBuilds++;
      _bumpPlanes(slot);
    }
  }

  ctx.preLevel = level;
  ctx.preparedKey = key;
  const stops = params.localExposureStops;
  if (!(stops && stops.length === n)) {
    slot.exposed = null;
    return level;
  }
  const exposedKey = `${key}|${slot.exposureMap.key}`;
  if (slot.exposed && slot.exposed.key === exposedKey) return { grey: slot.exposed.plane, alpha: level.alpha };
  if (_followExposureChange(slot, key, 'grey', level, stops, slot.exposureChange)) return { grey: slot.exposed.plane, alpha: level.alpha };
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
  const stops = exposureStopsCover(params.localExposureStops, base.width, base.height) ? params.localExposureStops : null;
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
  convertGreyFromSource(base.data, weights, stops ? preSatRamp : null, stops, packed, out16, out8, undefined, base.width);
  const result = new ImageData(out8, base.width, base.height);
  result.__image16 = { width: base.width, height: base.height, data: out16 };
  return result;
}

// The analysis sample a request carries, when it is a usable Image16.
function _validReference(candidate) {
  return candidate?.data instanceof Uint16Array
    && candidate.data.length === candidate.width * candidate.height * 4 ? candidate : null;
}

async function runSilverCore(imageData, settings, mode, options) {
  const slot = _slotFor(options);
  const params = await buildSilverCoreParams(mode, settings);
  // A detail region (#248) is converted with its base's analysis, taken as it
  // is (the override normalisation would round what the base computed).
  const shared = options?.sharedAnalysis;
  if (shared) {
    params.analysisOverride = shared.channelData.map((channel) => ({ ...channel }));
    params.positiveAnalysisOverride = shared.positiveAnalysis
      ? { gain: shared.positiveAnalysis.gain, wb: [...shared.positiveAnalysis.wb] } : null;
  }

  // Promote whatever the caller hands us into Image16. Loaders attach __image16
  // directly so the upcast is zero-copy in the common case.
  const sourceShape = imageData.__image16?.data instanceof Uint16Array ? imageData.__image16 : imageData;
  const engine = _getOrCreateEngine(slot, sourceShape.width, sourceShape.height);
  // Interactive requests keep the pristine and prepared planes in every slot; the
  // others keep none (see _transientWorkBuffer).
  const transient = Boolean(options?.forceFullProcess)
    || sourceShape.width * sourceShape.height > _largeImagePixels;
  const { image: input16, owned: promoted } = toImage16ForSlot(slot, imageData, transient);
  // `ownedSource` (#250): the caller gave the source up (a batch frame's geometry
  // output, transferred to the conversion worker and never read again), so the
  // transient path uses it as the work plane and writes the result into it: the
  // film base / flat field pass runs in place, the same values as a copy because
  // such requests always re-analyse (forceFullProcess). Only honoured for a
  // genuine 16-bit plane; a promoted 8-bit plane is ours already.
  const owned = promoted || (transient && Boolean(options?.ownedSource) && Boolean(options?.forceFullProcess));

  // Profile loading (skip if unchanged)
  const profileName = params.enhancedProfile;
  await _ensureProfile(slot, engine, profileName);
  if (slot.profile === 'none' && profileName !== 'none') {
    params.enhancedProfile = 'none';
    params.profileStrength = 0;
  }

  const region = options?.region || null;
  const baseCompensation = filmBaseCompensationFor(settings, mode);
  const filmBaseCompensation = region && baseCompensation ? { ...baseCompensation, region } : baseCompensation;

  const reference = _validReference(options?.analysisImageData);
  const analysisParams = reference ? { ...params, analysisRegion: null, excludeTransparent: true } : params;
  const analysisState = _analysisStateFor(analysisParams, filmBaseCompensation, reference ? reference.data : input16.data, mode, reference);
  const needsFullProcess = _needsFullProcess(slot, options, analysisState);

  // Dodge and burn: rasterise the strokes for this buffer's size. The engine
  // applies them after the analysis and before the curves; the analysis
  // sample (reference) is never dodged, like the base exposure in a darkroom.
  params.localExposureStops = localExposureStopsForSlot(slot, settings, input16.width, input16.height, region, transient);

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
    ctx.greyTable = table;
    result = _greyResult(input16.width, input16.height, (out16, out8) => writeGreyOutput(level.grey, level.alpha, table, out16, out8),
      _reusableOutput(slot, options?.workBuffer16, planeLength, input16, reference));
  } else {
    const src = _prepareRgba(ctx);
    // The first tail pass reads the cached level and writes the caller's buffer.
    const reuse = _reusableOutput(slot, options?.workBuffer16, src.data.length, input16, reference);
    const dst = { width: src.width, height: src.height, data: reuse || new Uint16Array(src.data.length) };
    result = _toResult(analysisPreview ? engine.applyCurrentTail(src, dst, params) : engine.applyTail(src, dst, params));
  }

  // What a live dodge-and-burn rectangle over this frame needs (#254 C): the
  // pre-exposure level, the tables and settings the tail ran with, and the
  // working geometry of the strokes. References only: the planes are the slot's.
  slot.live = !transient && !region && ctx.preLevel && settings?.localExposureGeometry ? {
    seq: ++_liveSeq,
    epoch: slot.planeEpoch,
    kind: greyPath ? 'grey' : 'rgba',
    width: input16.width,
    height: input16.height,
    preparedKey: ctx.preparedKey,
    pre: ctx.preLevel,
    greyTable: ctx.greyTable || null,
    engine,
    luts: engine.lastLuts,
    settings: engine.lastSettings,
    enhancedLut: engine.enhancedLut,
    params,
    geometry: { ...settings.localExposureGeometry, width: input16.width, height: input16.height },
  } : null;
  if (slot.live) result.__liveFrame = slot.live.seq;
  // The analysis the frame was converted with, when the caller asks (#254
  // follow-up): a region of the frame converted with it as `sharedAnalysis`
  // (and the frame's strokes placed by `region`) has exactly the frame's pixels.
  if (options?.returnAnalysis && engine.channelData) {
    result.__analysis = {
      channelData: engine.channelData.map((channel) => ({ ...channel })),
      positiveAnalysis: engine.positiveAnalysis ? { gain: engine.positiveAnalysis.gain, wb: [...engine.positiveAnalysis.wb] } : null,
    };
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

/**
 * Drop the planes a slot keeps between conversions (#250): the film-base
 * pristine buffer, the source and reference it was built from, the analysis
 * inputs, the 8-bit promotion and the dodge-and-burn map. The engine and its
 * loaded profile stay, so the next frame of a batch does not rebuild them. A
 * batch lane calls this after each frame, so it holds no source or pristine
 * plane between frames.
 * @param {'full'|'preview'|'scratch'} [which]
 */
export function releaseSlotBuffers(which = 'full') {
  const slot = _cache[which];
  if (!slot) return;
  slot.pristineBuffer = null;
  slot.lastSourceRef = null;
  slot.lastFilmBaseGains = null;
  slot.analysis = null;
  slot.referencePixels = {};
  slot.promotedSource = null;
  slot.exposureMap = null;
  slot.exposureChange = null;
  slot.prepared = null;
  slot.exposed = null;
  slot.live = null;
  _bumpPlanes(slot);
}

/** Test hook: the retained fields of a slot. */
export function inspectSlotBuffers(which = 'full') {
  const slot = _cache[which];
  return slot ? {
    engine: slot.engine,
    profile: slot.profile,
    pristineBuffer: slot.pristineBuffer,
    lastSourceRef: slot.lastSourceRef,
    analysis: slot.analysis,
    referencePixels: slot.referencePixels,
    promotedSource: slot.promotedSource,
    exposureMap: slot.exposureMap,
    prepared: slot.prepared,
    exposed: slot.exposed,
  } : null;
}

// ---- GPU preview inputs (#239) ----
//
// The interactive GPU preview runs the per-tick stages (B&W mix → pre-saturation →
// positive gain/WB → stops → curves → HSL → 3D profile → saturation → paper) as one
// shader on the display-size negative, while the settle frame and every export stay
// on runSilverCore. These three functions give main what the shader needs from the
// same slot and cache the following exact frame uses, so preparing and analysing
// here leave that frame's pixels unchanged (it then reuses the pristine plane and the
// analysis, as the next tick of a drag does).

// Identity of the plane a preview shader starts from, apart from the source itself:
// the film base and flat field the pristine plane is compensated with.
export function silverCorePreparedKey(settings = {}, mode = 'color') {
  return `${mode}|${filmBaseKeyOf(filmBaseCompensationFor(settings, mode))}`;
}

// The analysis state a conversion of these parameters is analysed under, as a string:
// equal keys mean the worker's analysis (channelData, autoColor, positiveAnalysis)
// is the same. `source` stands for the converted pixels by identity (main passes its
// display preview object; the worker compares its own buffers).
export function silverCoreAnalysisKey(mode, params, settings, source, analysisImageData = null) {
  const reference = _validReference(analysisImageData);
  const analysisParams = reference ? { ...params, analysisRegion: null, excludeTransparent: true } : params;
  return JSON.stringify(_analysisStateFor(analysisParams, filmBaseCompensationFor(settings, mode),
    reference ? reference.data : source, mode, reference));
}

// Point samples at the positions downsampleImageDataForMaxPixels takes (every
// `step`-th pixel and row from 0), of an RGBA16 plane and its stops.
function _pointSample(plane, stops, maxPixels) {
  const { width, height, data } = plane;
  const total = width * height;
  const step = total <= maxPixels ? 1 : Math.ceil(Math.sqrt(total / maxPixels));
  const outW = step === 1 ? width : Math.max(1, Math.floor(width / step));
  const outH = step === 1 ? height : Math.max(1, Math.floor(height / step));
  const out = new Uint16Array(outW * outH * 4);
  const outStops = stops ? new Float32Array(outW * outH) : null;
  for (let y = 0; y < outH; y++) {
    const srcY = Math.min(height - 1, y * step);
    for (let x = 0; x < outW; x++) {
      const srcX = Math.min(width - 1, x * step);
      const p = srcY * width + srcX;
      const o = y * outW + x;
      out.set(data.subarray(p * 4, p * 4 + 4), o * 4);
      if (outStops) outStops[o] = stops[p];
    }
  }
  return { width: outW, height: outH, data: out, stops: outStops };
}

function _previewSlot(imageData, options) {
  const slot = _slotFor(options);
  const sourceShape = imageData.__image16?.data instanceof Uint16Array ? imageData.__image16 : imageData;
  if (options?.forceFullProcess || sourceShape.width * sourceShape.height > _largeImagePixels) {
    throw new Error('The GPU preview only takes interactive frames');
  }
  const engine = _getOrCreateEngine(slot, sourceShape.width, sourceShape.height);
  const { image: input16 } = toImage16ForSlot(slot, imageData, false);
  return { slot, engine, input16 };
}

/**
 * What the GPU preview uploads for a display-size frame: the prepared negative (a
 * copy of the film-base / flat-field compensated plane; null without compensation,
 * when the caller's own source is that plane), the dodge-and-burn stops (null when
 * every stop is 0) and point samples of both for the CPU histogram.
 */
export function prepareSilverCorePreview(imageData, settings = {}, mode = 'color', options = {}) {
  const { slot, input16 } = _previewSlot(imageData, options);
  const filmBaseCompensation = filmBaseCompensationFor(settings, mode);
  const base = _pristineFor(slot, input16, filmBaseCompensation);
  const stops = localExposureStopsForSlot(slot, settings, input16.width, input16.height);
  const activeStops = stops && hasExposureStops(stops) ? stops : null;
  return {
    width: input16.width,
    height: input16.height,
    pristine: filmBaseCompensation ? new Uint16Array(base.data) : null,
    stops: activeStops ? new Float32Array(activeStops) : null,
    histogram: _pointSample(base, activeStops, Number(options.histogramSamples) || 24_576),
  };
}

/**
 * The analysis a frame of these settings would use, run exactly as runSilverCore runs
 * it (on the analysis sample when there is one) and kept in the slot, so the frame
 * that follows skips it. Returns the ~200 bytes the GPU preview seeds its engine with.
 */
export async function analyzeSilverCorePreview(imageData, settings = {}, mode = 'color', options = {}) {
  const params = await buildSilverCoreParams(mode, settings);
  const { slot, engine, input16 } = _previewSlot(imageData, options);
  const filmBaseCompensation = filmBaseCompensationFor(settings, mode);
  const reference = _validReference(options?.analysisImageData);
  const analysisParams = reference ? { ...params, analysisRegion: null, excludeTransparent: true } : params;
  const analysisState = _analysisStateFor(analysisParams, filmBaseCompensation, reference ? reference.data : input16.data, mode, reference);
  const needsFullProcess = _needsFullProcess(slot, options, analysisState);
  if (needsFullProcess) {
    // The stops come after the analysis; the frame builds their level itself.
    params.localExposureStops = null;
    if (reference) {
      const sample = _takeWorkBuffer(slot.referencePixels, reference, filmBaseCompensation);
      if (mode === 'bw') toGrayscaleInPlace(sample, params.bwMix);
      engine.analyze(sample, analysisParams);
    } else {
      const ctx = { slot, engine, params, mode, input16, owned: false, filmBaseCompensation, reference, needsFullProcess,
        analysisState, analysisPreview: null, analysisOnly: true };
      if (mode === 'bw' && engine.greyTableAvailable(params)) _prepareGrey(ctx);
      else _prepareRgba(ctx);
    }
    slot.analysis = analysisState;
  }
  if (!reference) slot.referencePixels = {};
  return {
    channelData: engine.channelData.map((channel) => ({ ...channel })),
    autoColor: engine.autoColor ? { ...engine.autoColor } : null,
    positiveAnalysis: engine.positiveAnalysis
      ? { gain: engine.positiveAnalysis.gain, wb: [...engine.positiveAnalysis.wb] } : null,
  };
}

// ---- Conversion bands (#256) ----
//
// The band pool (silverBands.js) runs the transient forceFullProcess path of
// runSilverCore on row bands of one frame in several workers. These give it
// the adapter's own rules, so the bands cannot drift from the whole-frame path.

/** The film-base / flat-field preprocessing of a conversion (filmBaseCompensationFor). */
export function silverCorePreprocessFor(settings = {}, mode = 'color') {
  return filmBaseCompensationFor(settings, mode);
}

/** Applies that preprocessing to a plane in place (the pristine plane's pass). */
export function preprocessSilverCorePlane(data, width, height, preprocess) {
  _preprocessBuffer(data, width, height, preprocess);
}

/** The analysis sample of a request when it is a usable Image16, else null. */
export function silverCoreAnalysisReference(candidate) {
  return _validReference(candidate);
}

/**
 * Loads `params.enhancedProfile` into `engine` as runSilverCore does, with the
 * same fallback: a profile that fails to load converts as 'none' at strength 0.
 */
export async function loadSilverCoreProfile(engine, params) {
  const slot = { profile: null };
  const profileName = params.enhancedProfile;
  await _ensureProfile(slot, engine, profileName);
  if (slot.profile === 'none' && profileName !== 'none') {
    params.enhancedProfile = 'none';
    params.profileStrength = 0;
  }
}

// ---- Live dodge and burn (#254 C) ----
//
// While a stroke is painted, the preview worker converts only the rectangle its
// new segments touched, over the frame the last interactive conversion of a slot
// produced: the stops there are the committed map plus the live stroke's coverage
// times its stops (the committed raster's own expression), and the rectangle runs
// the same exposure and tail arithmetic as the frame, so for the same points it
// is exactly the rectangle of the frame the stroke will have once stored.

/** The working geometry of the slot's live frame `frameSeq`, or null when stale. */
export function liveExposureGeometry(which, frameSeq) {
  const slot = _cache[which];
  const live = slot && slot.live;
  return live && live.seq === frameSeq && live.epoch === slot.planeEpoch ? live.geometry : null;
}

function _liveRectPixels(live, rect, rectStops) {
  const n = rect.width * rect.height;
  const W = live.width;
  if (live.kind === 'grey') {
    const { grey, alpha } = live.pre;
    const values = new Uint16Array(n);
    const alphaRect = alpha ? new Uint16Array(n * 4) : null;
    for (let y = 0; y < rect.height; y++) {
      const from = (rect.y + y) * W + rect.x;
      values.set(grey.subarray(from, from + rect.width), y * rect.width);
      if (alphaRect) alphaRect.set(alpha.subarray(from * 4, (from + rect.width) * 4), y * rect.width * 4);
    }
    for (let k = 0; k < n; k++) {
      const s = rectStops[k];
      if (s !== 0) values[k] = exposeGreyValue(values[k], s);
    }
    const out16 = new Uint16Array(n * 4);
    const out8 = new Uint8ClampedArray(n * 4);
    writeGreyOutput(values, alphaRect, live.greyTable, out16, out8);
    return out8;
  }
  const pre = live.pre;
  const data = new Uint16Array(n * 4);
  for (let y = 0; y < rect.height; y++) {
    const from = ((rect.y + y) * W + rect.x) * 4;
    data.set(pre.data.subarray(from, from + rect.width * 4), y * rect.width * 4);
  }
  const image = { width: rect.width, height: rect.height, data };
  exposeRgbaRun(data, 0, rectStops, 0, n);
  live.engine.applyLutsWith(image, live.luts, live.params, live.settings, live.enhancedLut);
  return toImageData8(image).data;
}

/**
 * Converts `rect` (frame pixels) of the slot's live frame `frameSeq` with the
 * committed strokes `committed` (sanitised settings.localExposure, or null) and
 * the stroke being painted (`store`, createLiveStrokeCoverage). A committed list
 * that has moved on since that frame (a stroke stored before its pen-up frame
 * ran) is brought into the slot's map first, in place when it extends it.
 * Returns { rect, rgba } (8-bit RGBA of the rectangle) and, with
 * `withCommitted`, `committedRgba`: the same rectangle without the live stroke.
 * { stale: true } when the slot no longer holds that frame's planes.
 */
export function renderLiveExposureRect(which, { frameSeq, committed = null, store, rect, withCommitted = false }) {
  const slot = _cache[which];
  const live = slot && slot.live;
  if (!live || live.seq !== frameSeq || live.epoch !== slot.planeEpoch) return { stale: true };
  let stops = null;
  if (committed?.strokes?.length) {
    const previous = slot.exposureMap && !slot.exposureMap.tiled ? slot.exposureMap : null;
    const { map, change } = updateExposureStopsMap(previous, committed, live.geometry, _stats.exposureMaps);
    slot.exposureMap = map;
    // The post-exposure level follows the map, or is rebuilt by the next frame.
    if (change && slot.prepared?.key === live.preparedKey) {
      _followExposureChange(slot, live.preparedKey, live.kind, live.pre, map.stops, change);
    }
    stops = map.stops;
  }
  const n = rect.width * rect.height;
  const coverage = liveStrokeCoverageRect(store, rect);
  const strokeStops = store.stroke.stops;
  const liveStops = new Float32Array(n);
  const committedStops = withCommitted ? new Float32Array(n) : null;
  for (let y = 0; y < rect.height; y++) {
    const row = (rect.y + y) * live.width + rect.x;
    for (let x = 0; x < rect.width; x++) {
      const k = y * rect.width + x;
      const base = stops ? stops[row + x] : 0;
      const c = coverage[k];
      liveStops[k] = c > 0 ? base + strokeStops * c : base;
      if (committedStops) committedStops[k] = base;
    }
  }
  _stats.liveRects++;
  return {
    rect,
    rgba: _liveRectPixels(live, rect, liveStops),
    committedRgba: committedStops ? _liveRectPixels(live, rect, committedStops) : null,
  };
}

export function invalidateSilverCoreCache() {
  for (const slot of [_cache.preview, _cache.full, _cache.scratch, _cache.roi]) {
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

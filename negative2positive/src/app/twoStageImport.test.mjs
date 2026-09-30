// Two-stage RAW imports (#255) with the real main.js functions in a vm
// context (loadFile, the full-decode record, the barrier, the settle, the
// crop-unit boundary of restoreSettings / extractCurrentSettings and the
// history rebase); decoders, detections and conversions are fakes:
// - the header plan routes: stage 1 is a half-size 16-bit decode without the
//   defect pass on the file's own buffer, stage 2 reads the file again and
//   starts at once (concurrent) or on stage 1's LibRaw release (sequential);
// - rawDecodePending from the stand-in to the swap; a switch aborts stage 2
//   in the same task; a failed stand-in makes the full decode the load;
// - the barrier: exact consumers wait for the installed, converted full
//   decode, a failure is retried once, a second failure throws, a left photo
//   answers false; nothing is persisted, remembered or reused meanwhile;
// - the saved crop {400, 300, 8700, 5800} restored on the stand-in, edited
//   around and swapped keeps exactly that crop (HEAD made {800, 600, 8736,
//   5736} of it); a window crop converts once; undo entries are rebased to
//   full units and cold;
// - the settle computes the settings off-state on the full decode and keeps
//   what the user changed in the window, never touching studioBusy;
// - the memory ledger (#258) counts the full decode with the open photo from
//   its return to the swap, and nothing of it once the photo is left.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createSharedDecodes } from './sharedDecodes.js';
import { rawDecodePlan } from './imageDimensions.js';
import {
  TWO_STAGE_MIN_MP_DEFAULT, twoStageMinPixels, stageTwoStartMode, createExactGeometry, windowEdits, overlayWindowEdits,
  geometryEdits, hasWindowEdits
} from './provisionalPhoto.js';
import { rotatedDimensions, sanitizeCropRect, normalizeAngleDegrees } from './imageGeometry.js';
import { mergeStudioColors } from './studioSettings.js';
import { MEMORY_FUNCTIONS, memoryGlobals } from './memoryHarness.mjs';
import { backingBuffers } from './photoSessionCache.js';

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `${name} exists`);
  const end = source.indexOf('\n    }', match.index);
  return source.slice(match.index, end + 6);
}
const SNAPSHOT_REF_KEYS = vm.runInNewContext(/const SNAPSHOT_REF_KEYS = (\[[^\]]+\]);/.exec(source)[1]);
const flush = async (rounds = 20) => { for (let i = 0; i < rounds; i++) await new Promise(setImmediate); };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

const FULL = { width: 9536, height: 6336 };
const HALF = { width: 4768, height: 3168 };
function image(size, extra = {}) {
  return Object.assign({ width: size.width, height: size.height, data: new Uint8ClampedArray(4) }, extra);
}
// A tiny TIFF header: IFD0 with a CFA image of `size`.
function cfaHeader(size) {
  const buffer = new ArrayBuffer(64);
  const v = new DataView(buffer);
  v.setUint16(0, 0x4949); v.setUint16(2, 42, true); v.setUint32(4, 8, true); v.setUint16(8, 3, true);
  [[256, size.width], [257, size.height], [262, 32803]].forEach(([tag, value], i) => {
    const at = 10 + i * 12; v.setUint16(at, tag, true); v.setUint16(at + 2, 4, true); v.setUint32(at + 4, 1, true); v.setUint32(at + 8, value, true);
  });
  return buffer;
}

function fixture({ search = '?twoStageMinMp=40&twoStageMode=sequential', settled = null } = {}) {
  const log = [];
  const stage1 = [], stage2 = [], reads = [], restores = [], conversions = [], detections = [], toasts = [];
  const item = { file: null, settings: settled, isDirty: false };
  const state = {
    fileQueue: [item], currentFileIndex: 0, loadedFile: null, autoFrame: { enabled: true }, dustRemoval: {},
    cropping: false, beforeAfterActive: false, filmBase: {}, lensCorrection: { search: {} }, flatFields: {},
    rotationAngle: 0, mirrored: false, cropRegion: null, currentStep: 1, importFilmTypeAuto: true, coreExposure: 0,
    rollReference: { applyLock: false }, rollMetadata: {}
  };
  const target = {
    // The memory budget (#258), real; the fakes below win over its helpers.
    ...memoryGlobals(),
    getPerfNow: () => performance.now(),
    backgroundRest: ms => new Promise(resolve => setTimeout(resolve, ms)),
    state, loadGeneration: 0, photoActivation: null, rewarmAutoFrameWorker: false, importDetectionAbort: null,
    fullResolutionRenderAbort: null, parkedPhoto: null, pendingImportRotation: null,
    SNAPSHOT_REF_KEYS, settledAdjustedBuffer: null, previewAdjustedBuffer: null,
    coreReprocessGeneration: 0, coreReprocessToken: 0, _coreReprocessPending: null, processNegativeInFlight: null,
    coreReprocessTimer: null, dustDrawing: false, aiBrushDrawing: null, undoStack: [], redoStack: [],
    cropModeWaiters: [], failNextFullDecodes: 0, fullDecodeHold: null, DEBUG_UI: false, TWO_STAGE_MIN_MP_KEY: 'nc_two_stage_min_mp',
    dustAiRefresh: { rects: [], timer: null },
    twoStageDiagnostics: { plans: [], stage1: [], stage2: [], swaps: 0, failures: 0, retries: 0, abandoned: 0, leftEarly: 0 },
    AbortController, DOMException, Promise, Map, Set, JSON, Boolean, Object, Error, URLSearchParams, structuredClone, performance,
    setTimeout, clearTimeout,
    window: { location: { search } },
    navigator: { deviceMemory: 16, hardwareConcurrency: 10 },
    document: { body: { dataset: {} }, getElementById: () => null },
    console: { error: (...args) => log.push(['error', ...args]), warn: (...args) => log.push(['warn', ...args]), info() {} },
    i18n: { en: { processing: 'Processing' } }, currentLang: 'en',
    quietLoadingOverlay: { show: async () => {}, updateProgress() {}, hide() {} },
    getLoadingOverlay: () => ({ show: async () => {}, updateProgress() {}, hide() {} }),
    studioWorkspace: { sync() {}, flush() {} }, lensMapCache: new Map(), webglState: { gl: null },
    DEFAULT_FILM_BASE: { r: 210, g: 140, b: 90 },
    showToast: message => toasts.push(message),
    getLocalizedText: (key, fallback) => fallback,
    safeStorageGet: () => null,
    isRawLikeFileName: name => /\.(dng|nef)$/i.test(name), isTiffContainerRawName: () => false,
    isPngFile: () => false, lowMemoryPhotoDevice: () => false,
    analyzeFrameInWorker: { abortReleases: 0 },
    warmUpAutoFrameWorker: () => Promise.resolve(true),
    convertPreviewFrameInWorker: { warmUp: () => Promise.resolve(true) },
    defaultFilmBaseBuffer: () => 10,
    getImageDataPixelCount: img => img.width * img.height,
    createPerfTrace: () => ({ mark() {}, end() {} }),
    rawDecodePlan, twoStageMinPixels, stageTwoStartMode, createExactGeometry, windowEdits, overlayWindowEdits,
    geometryEdits, hasWindowEdits, TWO_STAGE_MIN_MP_DEFAULT, mergeStudioColors, rotatedDimensions, normalizeAngleDegrees,
    BACKGROUND_INPUT_QUIET_MS: 400, BACKGROUND_BUSY_POLL_MS: 250,
    backgroundGate: { lastInputAt: -Infinity, bump() {} },
    coreReprocessBusy: () => false, hasPendingCropDetection: () => false, settlePendingCropDetection: async () => {},
    whenGeometrySettled: async () => true,
    loadRawImageDataPreview: (buffer, name, options) => {
      const gate = deferred();
      stage1.push({ buffer, name, options, ...gate });
      options.signal?.addEventListener('abort', () => gate.reject(options.signal.reason), { once: true });
      return gate.promise;
    },
    loadRawImageData: (buffer, name, options) => {
      const gate = deferred();
      stage2.push({ buffer, name, options, ...gate });
      options.signal?.addEventListener('abort', () => gate.reject(options.signal.reason), { once: true });
      return gate.promise;
    },
    // Settings are plain objects here: sanitize copies the fields these tests use.
    sanitizeSettings: (raw, { fallbackSettings } = {}) => {
      const pick = (key, fallback) => (raw && raw[key] !== undefined ? raw[key] : fallbackSettings?.[key] ?? fallback);
      const crop = raw === state ? state.cropRegion : raw?.cropRegion;
      return {
        cropRegion: crop ? { ...crop } : null, rotationAngle: normalizeAngleDegrees(pick('rotationAngle', 0)), mirrored: Boolean(pick('mirrored', false)),
        coreExposure: pick('coreExposure', 0), filmType: pick('filmType', 'color'), positiveMode: pick('positiveMode', 'correct'),
        filmTypeSource: pick('filmTypeSource', 'auto'), filmTypeConfidence: pick('filmTypeConfidence', null), filmTypeReason: pick('filmTypeReason', null),
        filmBase: { ...pick('filmBase', { r: 1, g: 1, b: 1 }) }, wbR: pick('wbR', 1), wbG: pick('wbG', 1), wbB: pick('wbB', 1),
        wbUserOverride: Boolean(pick('wbUserOverride', false)), grayPointSampled: Boolean(pick('grayPointSampled', false)),
        lensCorrection: { enabled: false, selectedLens: null, params: {}, modes: {} },
        curvePoints: { r: [], g: [], b: [] }, repairStrokes: [], frameMetadata: null, filmEdge: pick('filmEdge', null)
      };
    },
    deepCopySanitizedSettings: (safe, { autoFrameMeta = safe.autoFrameMeta } = {}) => ({ ...structuredClone(safe), autoFrameMeta: autoFrameMeta ?? null }),
    sanitizePresetType: type => type || 'color', sanitizeRepairStrokes: () => [], sanitizeFrameMetadata: value => value,
    cloneSettings: settings => structuredClone(settings),
    EXPIRED_RESCUE_KEYS: [],
    // The synchronous part of #244's applyGeometryFromBase: the crop is
    // sanitised against the rotated frame of the installed base at once.
    applyGeometryFromBase: ({ cropRegion = state.cropRegion, holdBusy = true } = {}) => {
      const base = state.loadedBaseImageData;
      const frame = rotatedDimensions(base.width, base.height, state.rotationAngle);
      state.cropRegion = cropRegion ? sanitizeCropRect(cropRegion, frame) : null;
      restores.push({ base: `${base.width}x${base.height}`, crop: state.cropRegion, holdBusy });
      if (holdBusy) state.busyByGeometry = (state.busyByGeometry || 0) + 1;
      return Promise.resolve(true);
    },
    processNegative: async options => { conversions.push({ base: state.loadedBaseImageData.width, options, settings: target.extractCurrentSettings() }); },
    createDefaultSettings: (img, _item, inputs) => ({
      cropRegion: null, rotationAngle: 0, mirrored: false, coreExposure: 0, filmType: 'color', positiveMode: 'correct',
      filmTypeSource: inputs?.automatic === false ? 'manual' : 'auto', filmTypeConfidence: 'high', filmTypeReason: null,
      filmBase: { r: img.width === FULL.width ? 205 : 190, g: 141, b: 92 }
    }),
    runImportDetections: async (img, options) => { detections.push({ width: img.width, options }); return { image: img, detection: { result: null }, read: null }; },
    analyzeStudioImportFrame: async (img, settings) => ({ ...settings, rotationAngle: 0.5, cropRegion: { left: img.width / 20, top: img.height / 20, width: img.width * 0.9, height: img.height * 0.9 }, autoFrameMeta: { appliedMode: 'crop', from: img.width } }),
    mergeImportFilmEdge: async (img, settings, read, options) => { log.push(['edge', options]); return null; },
    settleImportFilmType: (it, settings, options) => { log.push(['filmType', options]); return settings; },
    learnedImportSettings: async (settings, it, options) => { log.push(['learned', options]); it.automaticDefaults ||= structuredClone(settings); return settings; },
    provisionalLearnedSettings: async settings => { log.push(['provisionalLearned']); return settings; },
    scheduleSemanticColour: () => log.push(['semantic']),
    kickBackgroundPhotoWork: () => log.push(['kick']),
  };
  const context = vm.createContext(new Proxy(target, {
    has: () => true,
    get(t, key) {
      if (key in t) return t[key];
      if (key in globalThis) return globalThis[key];
      if (typeof key === 'string' && /^[a-z]/.test(key)) return () => {};
      return undefined;
    },
    set(t, key, value) { t[key] = value; return true; }
  }));
  target.sharedDecodes = createSharedDecodes({ decode: () => deferred().promise });
  vm.runInContext([
    'supersedeActivation', 'beginActivation', 'invalidatePhotoActivation', 'isCurrentLoad', 'loadFile', 'adoptSharedDecode',
    'twoStageMinPixelsSetting', 'stageTwoMode', 'noteTwoStagePlan', 'noteTwoStageEvent', 'liveGeometry', 'provisionalUnits',
    'createFullDecode', 'beginFullDecodeAttempt', 'noteFullDecodeChange', 'nextFullDecodeChange', 'failFullDecode',
    'retryFullDecode', 'beginProvisionalPhoto', 'abandonFullDecode', 'currentPhotoExact', 'ensureFullDecode',
    'ensureFullDecodeWithNotice', 'whenCropModeClosed', 'startProvisionalSettle', 'waitForProvisionalSwap',
    'settledImportSettings', 'rebaseProvisionalHistory', 'installFullDecode', 'settleProvisionalPhoto',
    'leaveProvisionalPhoto', 'withPendingEdits', 'pendingGeometryEdits', 'extractCurrentSettings', 'restoreSettings',
    'persistCurrentFileSettings', 'canReuseLoadedRollSource', 'studioBackgroundReady', 'rememberPhotoBase',
    'buildFinalImportSettings', 'getCurrentQueueItem', 'liveHistoryRoots', 'openPhotoMemoryRoots', ...MEMORY_FUNCTIONS
  ].map(functionSource).join('\n'), context);
  target.photoSessions = { put: () => { log.push(['session']); return true; } };
  target.hiddenJobs = { safeMode: false };
  const file = (name = 'L1000617.DNG', size = FULL) => {
    const header = cfaHeader(size);
    const f = { name, size: header.byteLength, arrayBuffer: async () => { reads.push(name); return header.slice(0); } };
    item.file = f;
    return f;
  };
  return { context, target, state, item, log, stage1, stage2, reads, restores, conversions, detections, toasts, file };
}

// ---- routing: header plan, stage options, sequential start --------------------------
{
  const f = fixture();
  const file = f.file();
  const loading = f.context.loadFile(file, { autoConvert: false, quiet: true });
  await flush();
  assert.equal(f.stage1.length, 1, 'stage 1 decodes');
  const options = f.stage1[0].options;
  assert.deepEqual([options.halfSize, options.outputBps, options.suppressSensorDefects], [true, 16, false], 'half-size 16-bit, no defect pass');
  assert.equal(f.reads.length, 1, 'the stand-in takes the file\'s own buffer');
  assert.equal(f.stage2.length, 0, 'sequential: stage 2 waits for stage 1\'s LibRaw release');
  options.onLibRawReleased();
  await flush();
  assert.equal(f.reads.length, 2, 'stage 2 reads the file again (nothing copied or pinned)');
  assert.equal(f.stage2.length, 1);
  assert.equal(f.stage2[0].options.halfSize, undefined, 'stage 2 is a full decode');
  // Stage 2 reserves a foreground claim of its own at the loader gate (#258).
  await f.stage2[0].options.reserveDecode({ kind: 'raw', width: FULL.width, height: FULL.height, estimatedBytes: 2e9 });
  assert.equal(f.target.memoryBudget.snapshot().foreground, 2e9, 'stage 2 holds a foreground reservation');
  f.stage1[0].resolve(image(HALF, { __decodeScale: 0.5, __fullSize: { ...FULL } }));
  assert.equal((await loading).status, 'loaded');
  assert.equal(f.state.rawDecodePending, true);
  assert.equal(f.state.provisional.fullSize.width, FULL.width);
  assert.equal(f.context.currentPhotoExact(), false);
  assert.equal(f.context.canReuseLoadedRollSource(f.item), false, 'roll analysis never samples the stand-in');
  f.state.currentStep = 3;
  assert.equal(f.context.studioBackgroundReady(), false, 'roll attempts and lanes wait');
  assert.equal(f.context.rememberPhotoBase(f.item), false, 'no session holds the stand-in');
  // A switch aborts stage 2 in the same task.
  const stage2Signal = f.stage2[0].options.signal;
  f.context.beginActivation(null);
  f.context.invalidatePhotoActivation();
  assert.equal(stage2Signal.aborted, true, 'stage 2 is aborted by the next activation');
  await flush();
  assert.equal(f.target.memoryBudget.snapshot().foreground, 0, 'and its reservation goes with it');
  assert.equal(f.state.rawDecodePending, false);
  assert.equal(f.state.fullDecode, null);
  assert.equal(f.target.twoStageDiagnostics.abandoned, 1);
}
{
  // Concurrent where two LibRaw heaps fit.
  const f = fixture({ search: '?twoStageMinMp=40' });
  const loading = f.context.loadFile(f.file(), { autoConvert: false, quiet: true });
  await flush();
  assert.equal(f.stage1.length, 1);
  assert.equal(f.stage2.length, 1, 'stage 2 starts with stage 1 (8 GB, 10 threads)');
  f.stage1[0].options.onLibRawReleased();
  await flush();
  assert.equal(f.stage2.length, 1, 'and only once');
  f.stage1[0].resolve(image(HALF, { __decodeScale: 0.5, __fullSize: { ...FULL } }));
  await loading;
  f.target.navigator = { hardwareConcurrency: 10 };
  assert.equal(f.context.stageTwoMode(), 'sequential', 'no deviceMemory (WebKit): sequential');
}
{
  // Below the threshold, and with the flag off: one decode.
  for (const search of ['?twoStageMinMp=40', '']) {
    const f = fixture({ search });
    const loading = f.context.loadFile(f.file('small.nef', { width: 6064, height: 4040 }), { autoConvert: false, quiet: true });
    await flush();
    assert.equal(f.stage1.length, 0);
    assert.equal(f.stage2.length, 1, `one full decode (${search || 'flag off'})`);
    f.stage2[0].resolve(image({ width: 6064, height: 4040 }));
    assert.equal((await loading).status, 'loaded');
    assert.equal(f.state.rawDecodePending, false);
    assert.equal(f.context.currentPhotoExact(), true);
  }
  // Flag off: a 60 MP DNG under 100 MiB decodes once, as today.
  const f = fixture({ search: '' });
  const loading = f.context.loadFile(f.file(), { autoConvert: false, quiet: true });
  await flush();
  assert.deepEqual([f.stage1.length, f.stage2.length], [0, 1]);
  f.stage2[0].resolve(image(FULL));
  await loading;
}
{
  // A failed stand-in: the full decode is the load.
  const f = fixture({ search: '?twoStageMinMp=40' });
  const loading = f.context.loadFile(f.file(), { autoConvert: false, quiet: true });
  await flush();
  f.stage1[0].reject(new Error('LibRaw open failed'));
  await flush();
  f.stage2[0].resolve(image(FULL));
  assert.equal((await loading).status, 'loaded');
  assert.equal(f.state.loadedBaseImageData.width, FULL.width);
  assert.equal(f.state.rawDecodePending, false, 'a single full decode is exact');
}

// ---- crop units, the settle and the barrier --------------------------------------------
async function loadedStandIn(f, { settled = null } = {}) {
  f.item.settings = settled;
  const loading = f.context.loadFile(f.file(), { autoConvert: false, quiet: true });
  await flush();
  f.stage1[0].options.onLibRawReleased();
  f.stage1[0].resolve(image(HALF, { __decodeScale: 0.5, __fullSize: { ...FULL } }));
  await loading;
  await flush();
  return f.stage2[0];
}
const SAVED = { left: 400, top: 300, width: 8700, height: 5800 };
{
  const f = fixture();
  const stage2 = await loadedStandIn(f, { settled: { rotationAngle: 0, mirrored: false, cropRegion: { ...SAVED }, coreExposure: 12 } });
  // switchToFile restores the saved recipe on the stand-in.
  f.context.restoreSettings(f.item.settings, { refreshDisplay: false });
  assert.deepEqual(f.state.cropRegion, { left: 200, top: 150, width: 4350, height: 2900 }, 'projected onto the stand-in');
  assert.deepEqual(f.context.extractCurrentSettings().cropRegion, SAVED, 'extracted exactly as saved');
  f.state.currentStep = 3;
  assert.equal(f.context.persistCurrentFileSettings({ force: true, silent: true }), false, 'nothing is persisted in the window');
  // The provisional pass ends (prepareStudioPhoto records these).
  f.state.provisional.start = { fresh: false, snapshot: f.context.extractCurrentSettings(), detectFrame: false, readEdge: false };
  f.state.provisional.settledSnapshot = f.context.extractCurrentSettings();
  // Undo entries of the window: a dust stroke (it patches stand-in planes),
  // then an entry whose crop is in stand-in units.
  f.target.undoStack.push({ label: 'dustBrushStroke', dustDelta: {} });
  f.target.undoStack.push({ label: 'exposure', settings: { cropRegion: { ...f.state.cropRegion }, rotationAngle: 0, mirrored: false,
    provisionalGeometry: f.state.provisional.geometry.save() }, refs: { originalImageData: 'stand-in plane' }, frame: {} });
  // The user edits the exposure in the window.
  f.state.coreExposure = 30;
  // An export waits for the exact photo.
  let exported = false;
  const exporting = f.context.ensureFullDecode({ reason: 'export' }).then(value => { exported = value; });
  f.context.startProvisionalSettle(f.state.fullDecode);
  await flush();
  assert.equal(exported, false, 'the export waits');
  stage2.resolve(image(FULL));
  await exporting;
  assert.equal(exported, true);
  assert.equal(f.state.rawDecodePending, false, 'after the swap nothing is pending');
  assert.equal(f.state.loadedBaseImageData.width, FULL.width);
  assert.deepEqual(f.state.cropRegion, SAVED, 'the swap installs the saved crop: no clamp, no x2, no drift');
  assert.equal(f.state.coreExposure, 30, 'the window edit survives the swap');
  assert.equal(f.restores.at(-1).holdBusy, false, 'the swap never sets studioBusy');
  assert.equal(f.conversions.length, 1, 'one conversion of the full decode');
  assert.equal(f.conversions[0].base, FULL.width);
  assert.equal(f.state.provisional, null);
  assert.equal(f.context.currentPhotoExact(), true);
  assert.equal(f.target.undoStack.length, 1, 'the dust-stroke entry (and anything older) went');
  // (Objects made inside the vm context compare by value through JSON.)
  assert.equal(JSON.stringify(f.target.undoStack[0].refs), '{"cold":true}', 'entries rebuild from the full base');
  assert.equal(JSON.stringify(f.target.undoStack[0].settings.cropRegion), JSON.stringify(SAVED), 'undo never restores a stand-in crop');
  assert.equal(f.target.undoStack[0].settings.provisionalGeometry, undefined);
  assert.equal(f.context.persistCurrentFileSettings({ force: true, silent: true }), true, 'persisted once exact');
  assert.deepEqual(f.item.settings.cropRegion, SAVED);
}
{
  // A fresh photo: the stand-in's analyses are held back and run again on the
  // full decode; a crop drawn in the window converts once and wins.
  const f = fixture();
  const stage2 = await loadedStandIn(f);
  const provisional = f.state.provisional;
  provisional.start = {
    fresh: true, inputs: { automatic: true }, snapshot: f.context.extractCurrentSettings(), detectFrame: true, readEdge: true,
    applyEdgeDefaults: true, autoFrame: { enabled: true }, userEdited: false, pendingEdits: null
  };
  provisional.settledSnapshot = f.context.extractCurrentSettings();
  f.state.cropRegion = { left: 101, top: 77, width: 2001, height: 1333 };
  const first = f.context.extractCurrentSettings().cropRegion;
  assert.deepEqual(first, { left: 202, top: 154, width: 4002, height: 2666 }, 'converted once');
  f.state.currentStep = 3;
  f.context.startProvisionalSettle(f.state.fullDecode);
  stage2.resolve(image(FULL));
  await flush(40);
  assert.equal(f.detections.length, 1);
  assert.equal(f.detections[0].width, FULL.width, 'the detections ran on the full decode');
  assert.equal(f.detections[0].options.owned, true, 'without a copy');
  assert.deepEqual(f.log.filter(([kind]) => kind === 'filmType').map(([, options]) => options.record), [true], 'the full decode votes');
  assert.ok(f.log.some(([kind, options]) => kind === 'edge' && options.rollDate === true));
  assert.ok(f.item.automaticDefaults, 'learned defaults captured from the full decode');
  assert.deepEqual(f.state.cropRegion, first, 'the user\'s window crop wins over the full auto-frame');
  assert.equal(f.state.filmBase.r, 205, 'the film base is the full decode\'s');
  assert.deepEqual(f.log.filter(([kind]) => kind === 'semantic').length, 1, 'semantic colour after the swap');
}
{
  // Failure: a toast, still provisional, one foreground retry, then an error.
  const f = fixture();
  const stage2 = await loadedStandIn(f);
  f.state.provisional.start = { fresh: false, snapshot: f.context.extractCurrentSettings(), detectFrame: false, readEdge: false };
  f.state.provisional.settledSnapshot = f.context.extractCurrentSettings();
  f.context.startProvisionalSettle(f.state.fullDecode);
  stage2.reject(new Error('decode failed'));
  await flush();
  assert.equal(f.state.fullDecode.status, 'failed');
  assert.equal(f.state.rawDecodePending, true, 'still provisional');
  assert.equal(f.toasts.length, 1, 'the user is told');
  const exporting = f.context.ensureFullDecode({ reason: 'export' });
  await flush();
  assert.equal(f.stage2.length, 2, 'the export decodes again');
  f.stage2[1].reject(new Error('decode failed again'));
  await assert.rejects(exporting, error => error.code === 'FULL_DECODE_FAILED');
  assert.equal(f.state.rawDecodePending, true, 'never falls back to the stand-in');
  // A later consumer tries once more, and succeeds.
  const again = f.context.ensureFullDecode({ reason: 'export' });
  await flush();
  f.stage2[2].resolve(image(FULL));
  assert.equal(await again, true);
  assert.equal(f.state.rawDecodePending, false);
}
{
  // The memory ledger's open photo (#258): the stand-in, then the full decode
  // from its return (the swap waits for crop mode here), then the base that
  // holds it; a photo left drops its full decode.
  const f = fixture();
  const stage2 = await loadedStandIn(f);
  f.state.provisional.start = { fresh: false, snapshot: f.context.extractCurrentSettings(), detectFrame: false, readEdge: false };
  f.state.provisional.settledSnapshot = f.context.extractCurrentSettings();
  const counted = () => backingBuffers(f.context.openPhotoMemoryRoots());
  assert.ok(counted().has(f.state.loadedBaseImageData.data.buffer), 'the stand-in counts as the open photo');
  const full = image(FULL);
  stage2.resolve(full);
  await flush();
  assert.equal(f.state.fullDecode.status, 'decoded');
  assert.ok(counted().has(full.data.buffer), 'the full decode counts from its return, before any plane holds it');
  f.state.cropping = true;
  f.context.startProvisionalSettle(f.state.fullDecode);
  await flush();
  assert.equal(f.state.fullDecode.status, 'decoded', 'the swap waits for crop mode');
  assert.ok(counted().has(full.data.buffer), 'and while the swap waits');
  f.state.cropping = false;
  for (const resolve of f.target.cropModeWaiters.splice(0)) resolve();
  await flush(40);
  assert.equal(f.state.loadedBaseImageData, full, 'swapped');
  assert.equal(f.state.fullDecode.decodedImage, null, 'the base holds it now');
  assert.ok(counted().has(full.data.buffer));

  const left = fixture();
  const leftStage2 = await loadedStandIn(left);
  const record = left.state.fullDecode;
  left.state.provisional.start = { fresh: false, snapshot: left.context.extractCurrentSettings(), detectFrame: false, readEdge: false };
  left.state.provisional.settledSnapshot = left.context.extractCurrentSettings();
  left.state.cropping = true;
  left.context.startProvisionalSettle(record);
  const orphan = image(FULL);
  leftStage2.resolve(orphan);
  await flush();
  assert.equal(record.decodedImage, orphan);
  left.context.beginActivation(null);
  left.context.invalidatePhotoActivation();
  assert.equal(record.decodedImage, null, 'a photo left drops its full decode');
  assert.equal(backingBuffers(left.context.openPhotoMemoryRoots()).has(orphan.data.buffer), false);
}
{
  // Leaving early: only the window edits are kept; a waiting export is released.
  const f = fixture();
  await loadedStandIn(f);
  f.state.provisional.start = { fresh: true, snapshot: f.context.extractCurrentSettings(), detectFrame: false, readEdge: false };
  f.state.provisional.settledSnapshot = f.context.extractCurrentSettings();
  f.state.coreExposure = 18;
  const waiting = f.context.ensureFullDecode({ reason: 'export' });
  f.context.leaveProvisionalPhoto(f.item);
  assert.equal(f.item.settings, null, 'a fresh photo keeps no stand-in settings');
  assert.equal(JSON.stringify(f.item.pendingEdits), '{"coreExposure":18}');
  f.context.beginActivation(null);
  f.context.invalidatePhotoActivation();
  assert.equal(await waiting, false, 'the photo was left');
  assert.equal(JSON.stringify(f.context.withPendingEdits(f.item, { coreExposure: 0, filmType: 'color' })), '{"coreExposure":18,"filmType":"color"}');
  assert.equal(f.context.pendingGeometryEdits(f.item), null);
}

console.log('twoStageImport: header routing, stage options and start, abort on switch, barrier, retry, exact crop across the swap, history rebase, window edits and the ledger\'s open photo passed');

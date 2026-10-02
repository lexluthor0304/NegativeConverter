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
//   answers false; nothing is persisted, remembered or reused meanwhile; a
//   concurrent stage 2 failing before the stand-in shows is kept and retried;
// - the saved crop {400, 300, 8700, 5800} restored on the stand-in, edited
//   around and swapped keeps exactly that crop (HEAD made {800, 600, 8736,
//   5736} of it); a window crop converts once; undo entries are rebased to
//   full units and cold;
// - the settle computes the settings off-state on the full decode and keeps
//   what the user changed in the window, never touching studioBusy;
// - the memory ledger (#258) counts the full decode with the open photo from
//   its return to the swap, and nothing of it once the photo is left;
// - the settle, and the fresh recipe of a photo left in the window with an
//   edit, decide as their pass began (learned defaults, the roll's film type):
//   one decode's recipe plus the edit;
// - Analyze roll, Auto Frame Selected, Apply film type to roll and Save
//   Project clicked in the window wait for the exact photo and end as on one
//   decode; crop mode and the automatic roll import still complete;
// - Confirm image area on the stand-in survives the swap over the full
//   decode's diagnostics; a crop applied there is detected again on the
//   installed base (the stand-in's detection ends or its hit is dropped);
//   Apply flat field to selected measures new photos' defaults on the full
//   decode. Each as on one decode, each with a control without the fix;
// - stage 2's reservation goes only once the ledger counts the full base,
//   so the admission its release runs sees it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createSharedDecodes } from './sharedDecodes.js';
import { rawDecodePlan } from './imageDimensions.js';
import {
  TWO_STAGE_MIN_MP_DEFAULT, twoStageMinPixels, stageTwoStartMode, createExactGeometry, windowEdits, overlayWindowEdits,
  geometryEdits, hasWindowEdits, analysisAreaEdited, confirmedImageArea
} from './provisionalPhoto.js';
import { imageAreaFromWorkingRect, imageAreaFromDetection, resolveAnalysisRegion } from './analysisRegion.js';
import { isSameAnalysisFrame } from './cropColorAnalysis.js';
import { rotatedDimensions, sanitizeCropRect, normalizeAngleDegrees } from './imageGeometry.js';
import { mergeStudioColors } from './studioSettings.js';
import { MEMORY_FUNCTIONS, memoryGlobals } from './memoryHarness.mjs';
import { createMemoryBudget } from './memoryBudget.js';
import { backingBuffers } from './photoSessionCache.js';
import { aggregateRollAnalysis, groupAutomaticRollFrames, sanitizeRollFrameForSettings } from './rollAnalysis.js';
import { applyAutomaticFilmType, applyFilmTypeOverride, sanitizeFilmTypeOverride } from './filmTypeOverride.js';
import { applyLearnedDefaults, learnedDefaultsKey } from './learnedDefaults.js';
import { decideRollFilmType, mergeRollDecision, ownFilmTypeVerdict, rollDecisionFrame, rollFilmTypeTarget, ROLL_MONOCHROME } from './rollFilmType.js';

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
    analysisAreaEdited, confirmedImageArea, imageAreaFromWorkingRect, isSameAnalysisFrame,
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
    'createFullDecode', 'beginFullDecodeAttempt', 'noteFullDecodeChange', 'nextFullDecodeChange', 'failFullDecode', 'reportFullDecodeFailure',
    'retryFullDecode', 'beginProvisionalPhoto', 'abandonFullDecode', 'currentPhotoExact', 'ensureFullDecode',
    'ensureFullDecodeWithNotice', 'whenCropModeClosed', 'startProvisionalSettle', 'waitForProvisionalSwap',
    'settledImportSettings', 'rebaseProvisionalHistory', 'windowFrameMetaOnFull', 'appliedCropDiagnostics', 'geometryFrameSize',
    'effectiveGeometryAngle', 'installFullDecode', 'settleProvisionalPhoto',
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
  // A concurrent stage 2 that fails while the stand-in still decodes (a
  // second LibRaw heap that cannot be had): the record keeps the failure,
  // the toast comes with the stand-in, and the export decodes again. Before,
  // the failure was dropped (its record was not state.fullDecode yet): the
  // photo stayed 'running' and an export waited forever.
  const early = async ({ old = false } = {}) => {
    const f = fixture({ search: '?twoStageMinMp=40' });
    if (old) {
      vm.runInContext(functionSource('failFullDecode')
        .replace('if (record.attempt !== attempt || record.abort.signal.aborted) return;', 'if (state.fullDecode !== record || record.attempt !== attempt) return;')
        .replace('if (state.fullDecode === record) reportFullDecodeFailure();', 'reportFullDecodeFailure();'), f.context);
    }
    const loading = f.context.loadFile(f.file(), { autoConvert: false, quiet: true });
    await flush();
    assert.equal(f.stage2.length, 1, 'stage 2 starts with stage 1');
    f.stage2[0].reject(new Error('second LibRaw heap failed'));
    await flush();
    assert.deepEqual([f.toasts.length, f.state.fullDecode], [0, null], 'no stand-in on screen yet, nothing said');
    f.stage1[0].resolve(image(HALF, { __decodeScale: 0.5, __fullSize: { ...FULL } }));
    await loading;
    f.state.provisional.start = { fresh: false, snapshot: f.context.extractCurrentSettings(), detectFrame: false, readEdge: false };
    f.state.provisional.settledSnapshot = f.context.extractCurrentSettings();
    f.context.startProvisionalSettle(f.state.fullDecode);
    await flush();
    let exported = null;
    const exporting = f.context.ensureFullDecode({ reason: 'export' }).then(value => { exported = value; });
    await flush(40);
    return { f, exporting, exported: () => exported };
  };
  const { f, exporting } = await early();
  assert.equal(f.target.twoStageDiagnostics.failures, 1);
  assert.equal(f.toasts.length, 1, 'the failure is reported with the stand-in');
  assert.equal(f.stage2.length, 2, 'the export decodes again');
  assert.equal(f.state.rawDecodePending, true, 'the stand-in is never handed out');
  f.stage2[1].resolve(image(FULL));
  await exporting;
  assert.equal(f.state.loadedBaseImageData.width, FULL.width);
  assert.equal(f.state.fullDecode.status, 'installed');
  // Control: the old failFullDecode.
  const control = await early({ old: true });
  assert.deepEqual([control.f.state.fullDecode.status, control.f.toasts.length, control.f.stage2.length, control.exported()], ['running', 0, 1, null],
    'control: the failure is lost and the export waits for good');
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

// ---- the recipe in the two-stage window, against one decode (#255 review) ----------------
// The real main.js functions run twice: on one decode, and on a stand-in
// whose full decode lands later. The import pass is prepareStudioPhoto's for
// a fresh photo (its inputs and results, below) with real learned defaults:
// one earlier roll whose user raised the contrast by 20 adds +5.
const LEARNED_KEY = learnedDefaultsKey({ filmType: 'color' });
const learnedRecord = key => ({ version: 1, key, rolls: [{ id: 'roll-1', frames: { f1: { coreContrast: 20 } } }] });
const RECIPE_FUNCTIONS = ['importUserEdited', 'learnsImportDefaults', 'learnedImportSettings', 'provisionalLearnedSettings'];
function flowFixture({ twoStage, learnedKeys = [LEARNED_KEY] }) {
  const f = fixture({ search: twoStage ? '?twoStageMinMp=40&twoStageMode=sequential' : '' });
  const { target, state } = f;
  // The recipe keys these cases read besides the fixture's.
  const sanitize = target.sanitizeSettings;
  target.sanitizeSettings = (raw, options = {}) => ({
    ...sanitize(raw, options), coreContrast: raw?.coreContrast ?? options.fallbackSettings?.coreContrast ?? 0,
    learnedDefaults: raw?.learnedDefaults ?? null, rollFrame: raw?.rollFrame ?? null
  });
  const defaults = target.createDefaultSettings;
  target.createDefaultSettings = (...args) => ({ ...defaults(...args), coreContrast: 0 });
  Object.assign(f.item, { id: 'a', selected: true });
  state.fileQueue.push(...['B.DNG', 'C.DNG'].map((name, i) => ({ id: `other-${i}`, file: { name, size: 1 }, selected: true, settings: null, isDirty: false })));
  Object.assign(target, {
    manualEditRevision: 0, automaticRollRevision: 0,
    learnedReady: Promise.resolve(), learnedRecords: new Map(learnedKeys.map(key => [key, learnedRecord(key)])),
    applyLearnedDefaults, learnedDefaultsKey
  });
  vm.runInContext(RECIPE_FUNCTIONS.map(functionSource).join('\n'), f.context);
  return f;
}
async function loadedSingle(f) {
  const loading = f.context.loadFile(f.file(), { autoConvert: false, quiet: true });
  await flush();
  f.stage2[0].resolve(image(FULL));
  await loading;
  await flush();
}
// A fresh photo's import pass as prepareStudioPhoto runs it on the loaded
// base: defaults, the auto-frame result, the film edge and learned defaults.
// On a stand-in it records its inputs, keeps the crop in full units, learns
// nothing, and the settle starts once it ends.
async function importPass(f) {
  const base = f.state.loadedBaseImageData;
  const provisional = f.state.provisional;
  const inputs = { automatic: true };
  f.context.restoreSettings(f.target.createDefaultSettings(base, f.item, inputs), { refreshDisplay: false });
  const snapshot = f.context.extractCurrentSettings();
  if (provisional) {
    provisional.start = { fresh: true, inputs, snapshot, detectFrame: true, readEdge: true, applyEdgeDefaults: true,
      autoFrame: { enabled: true }, userEdited: f.context.importUserEdited(f.item), pendingEdits: null };
  }
  const framed = await f.target.analyzeStudioImportFrame(base, provisional ? { ...snapshot, cropRegion: f.state.cropRegion } : snapshot);
  let { settings } = await f.context.buildFinalImportSettings(base, framed, null, f.item, {
    readEdge: true, freshFile: true, applyEdgeDefaults: true, provisional: Boolean(provisional)
  });
  if (provisional) settings = { ...settings, ...provisional.geometry.toExact(settings) };
  f.context.restoreSettings(settings, { refreshDisplay: false });
  f.state.currentStep = 3;
  if (provisional) {
    provisional.settledSnapshot = f.context.extractCurrentSettings();
    f.context.startProvisionalSettle(f.state.fullDecode);
  }
}

// ---- the pass-start userEdited (#255 review R2-031) ---------------------------------------
// An edit made in the window must not change what the import itself decides
// for the photo: learned defaults and the roll's film type, which one decode
// applied before any edit was possible. Here three B&W frames follow a frame
// without film evidence (noMask): the roll types it B&W unless the frame is
// locked, and a learned record for B&W stock adds +5 contrast.
const ROLL_FUNCTIONS = ['importFilmTypeRoll', 'importFilmTypeActive', 'createImportFilmTypeRoll', 'liveImportSettings',
  'importFilmTypeLocked', 'refreshImportFilmTypeDecision', 'settleImportFilmType'];
const NO_MASK = { filmType: 'positive', filmTypeSource: 'auto', filmTypeConfidence: 'medium', filmTypeReason: 'noMask' };
const MONOCHROME = { filmType: 'bw', filmTypeSource: 'auto', filmTypeConfidence: 'low', filmTypeReason: 'monochrome' };
async function rollFixture({ twoStage }) {
  const f = flowFixture({ twoStage, learnedKeys: [learnedDefaultsKey({ filmType: 'bw' })] });
  const defaults = f.target.createDefaultSettings;
  f.target.createDefaultSettings = (...args) => ({ ...defaults(...args), ...NO_MASK });
  Object.assign(f.target, { importFilmTypeRolls: new Map(), decideRollFilmType, mergeRollDecision, ownFilmTypeVerdict, rollDecisionFrame,
    rollFilmTypeTarget, ROLL_MONOCHROME, applyAutomaticFilmType, sanitizeFilmTypeOverride, scheduleImportFilmTypeUpdate: () => {} });
  vm.runInContext(ROLL_FUNCTIONS.map(functionSource).join('\n'), f.context);
  f.state.fileQueue.push({ id: 'other-2', file: { name: 'D.DNG', size: 1 }, selected: true, isDirty: false });
  for (const item of f.state.fileQueue) item.importId = 'import-1';
  for (const item of f.state.fileQueue.slice(1)) item.settings = { ...MONOCHROME, filmBase: { r: 205, g: 141, b: 92 }, filmEdge: { checked: true } };
  f.context.createImportFilmTypeRoll(f.state.fileQueue);
  f.stage2Entry = twoStage ? await loadedStandIn(f) : (await loadedSingle(f), null);
  await importPass(f);
  // The user nudges the exposure.
  f.item.userEdited = true;
  f.state.coreExposure = 18;
  return f;
}
const DECIDED = ['filmType', 'filmTypeSource', 'filmTypeConfidence', 'filmTypeReason', 'coreContrast', 'learnedDefaults', 'coreExposure', 'rotationAngle'];
const decided = settings => JSON.stringify(Object.fromEntries(DECIDED.map(key => [key, settings?.[key] ?? null])));
// One decode: the import typed and learned before the edit; the edit is on top.
const reference = await (async () => decided((await rollFixture({ twoStage: false })).context.extractCurrentSettings()))();
assert.equal(JSON.parse(reference).filmType, 'bw', 'the roll types the frame B&W');
assert.equal(JSON.parse(reference).coreContrast, 5, 'with the learned contrast of B&W stock');
assert.equal(JSON.parse(reference).coreExposure, 18);
{
  // The settle on the full decode, with the edit made in the window.
  const f = await rollFixture({ twoStage: true });
  const waiting = f.context.ensureFullDecode({ reason: 'export' });
  f.stage2Entry.resolve(image(FULL));
  assert.equal(await waiting, true);
  assert.equal(decided(f.context.extractCurrentSettings()), reference, 'the settled photo decides as its pass began, with the edit on top');
  // Control: the roll decision reading the window's userEdited locks the frame.
  const control = await rollFixture({ twoStage: true });
  const refresh = control.target.refreshImportFilmTypeDecision;
  control.target.refreshImportFilmTypeDecision = record => refresh(record);
  const controlWaiting = control.context.ensureFullDecode({ reason: 'export' });
  control.stage2Entry.resolve(image(FULL));
  await controlWaiting;
  assert.equal(JSON.parse(decided(control.context.extractCurrentSettings())).filmType, 'positive', 'control: a locked frame keeps its own type');
}
{
  // Left before stage 2: only the edit is kept, with the userEdited the pass
  // began with. The fresh recipe of the next decode (switch-back's
  // buildFinalImportSettings, Export All's learned + film-type steps) decides
  // as that pass did, so it equals one decode's recipe plus the edit.
  const f = await rollFixture({ twoStage: true });
  f.context.leaveProvisionalPhoto(f.item);
  f.context.beginActivation(null);
  f.context.invalidatePhotoActivation();
  f.state.currentFileIndex = -1;
  assert.equal(JSON.stringify(f.item.pendingEdits), '{"coreExposure":18}');
  assert.equal(f.item.pendingUserEdited, false, 'the pass began unedited');
  assert.equal(f.item.userEdited, true, 'the photo stays edited: the automatic roll import leaves it alone, as after one decode');
  assert.equal(f.context.importUserEdited(f.item), false);
  const fresh = async item => {
    const defaults = f.target.createDefaultSettings(image(FULL), item);
    return f.target.analyzeStudioImportFrame(image(FULL), defaults);
  };
  const switchBack = overlayWindowEdits((await f.context.buildFinalImportSettings(image(FULL), await fresh(f.item), null, f.item,
    { readEdge: true, freshFile: true, applyEdgeDefaults: true })).settings, f.item.pendingEdits);
  assert.equal(decided(switchBack), reference, 'switch-back: learned defaults, the roll type and the edit');
  const exportAll = f.context.withPendingEdits(f.item, await f.context.learnedImportSettings(f.context.settleImportFilmType(f.item, await fresh(f.item)), f.item));
  assert.equal(decided(exportAll), reference, 'Export All: the same recipe');
  assert.ok(f.item.automaticDefaults, 'the automatic recipe is recorded for learning from this photo\'s edit');
  // Control: without the pass-start value the edit decides (no learned
  // defaults, the frame locked out of the roll's type).
  const control = await rollFixture({ twoStage: true });
  control.context.leaveProvisionalPhoto(control.item);
  delete control.item.pendingUserEdited;
  const controlRecipe = await control.context.learnedImportSettings(control.context.settleImportFilmType(control.item, await fresh(control.item)), control.item);
  assert.deepEqual([controlRecipe.filmType, controlRecipe.coreContrast], ['positive', 0], 'control: the window edit decided');
  // A recipe again (persisted) ends the pass-start value.
  f.state.currentFileIndex = 0;
  f.state.loadedFile = f.item.file;
  f.item.settings = null;
  f.context.persistCurrentFileSettings({ silent: true, force: true });
  assert.equal(f.item.pendingUserEdited, undefined);
  assert.equal(f.context.importUserEdited(f.item), true);
}


{
  // Old against new on synthetic rolls: outside the window (no
  // pendingUserEdited, the caller's own userEdited) every roll decision and
  // every recipe is what 7235c39's functions gave. Frames of five verdict
  // patterns, each frame in turn edited, saved, overridden or typed by hand.
  const OLD = `
    function learnsImportDefaults(item, userEdited = item?.userEdited) {
      return Boolean(item && !item.savedSettings && !state.rollReference.applyLock && !userEdited);
    }
    async function learnedImportSettings(settings, item, { userEdited = item?.userEdited } = {}) {
      if (!learnsImportDefaults(item, userEdited)) return settings;
      await learnedReady;
      item.automaticDefaults ||= structuredClone(settings);
      const key = learnedDefaultsKey(settings, state.rollMetadata);
      return applyLearnedDefaults(settings, learnedRecords.get(key));
    }
    function refreshImportFilmTypeDecision(record) {
      const { typed } = decideRollFilmType(record.items.map(item => {
        const own = state.fileQueue.includes(item) ? record.verdicts.get(item) || null : null;
        return rollDecisionFrame(item.id, own, { locked: importFilmTypeLocked(item), live: liveImportSettings(item) });
      }));
      const next = new Map();
      for (const item of record.items) {
        const entry = typed.get(item.id);
        if (entry) next.set(item, { filmType: entry.filmType, confidence: entry.confidence, reason: entry.reason });
      }
      record.typed = mergeRollDecision(record.typed, next, { final: record.final });
    }
    function settleImportFilmType(item, settings, { record: vote = true, userEdited = item?.userEdited } = {}) {
      const record = importFilmTypeRoll(item);
      if (!record || !settings || !record.items.includes(item)) return settings;
      const own = ownFilmTypeVerdict(settings);
      if (!vote) {
        const target = !record.corrected && own && !own.manual && !importFilmTypeLocked(item, { userEdited }) ? record.typed.get(item) : null;
        return target ? applyAutomaticFilmType(settings, target) : settings;
      }
      if (own) record.verdicts.set(item, own);
      if (record.corrected) return settings;
      refreshImportFilmTypeDecision(record);
      if (importFilmTypeActive(record)) scheduleImportFilmTypeUpdate(record);
      const target = own && !own.manual && !importFilmTypeLocked(item, { userEdited }) ? record.typed.get(item) : null;
      return target ? applyAutomaticFilmType(settings, target) : settings;
    }`;
  const VERDICTS = { mono: MONOCHROME, noMask: NO_MASK, color: { filmType: 'color', filmTypeSource: 'auto', filmTypeConfidence: 'high', filmTypeReason: 'orangeMask' } };
  const PATTERNS = [['mono', 'noMask', 'mono', 'mono', 'color'], ['noMask', 'mono', 'mono', 'noMask', 'mono'], ['mono', 'mono', 'noMask', 'mono', 'mono'],
    ['color', 'mono', 'noMask', 'mono', 'mono'], ['noMask', 'noMask', 'mono', 'mono', 'mono']];
  const LOCKS = [null, 'userEdited', 'savedSettings', 'override', 'manual'];
  // `leftInWindow`: edited in a two-stage window and left before its recipe;
  // `editedAfter`: one decode's photo, edited once its pass had run.
  const decide = async (functions, pattern, lockAt, lock, { leftInWindow = false, editedAfter = false } = {}) => {
    const items = pattern.map((_verdict, i) => ({ id: `f${i}`, importId: 'import-1', file: { name: `${i}.dng` }, settings: null }));
    if (lock === 'userEdited') items[lockAt].userEdited = true;
    if (lock === 'savedSettings') items[lockAt].savedSettings = true;
    if (lock === 'override') items[lockAt].filmTypeOverride = { filmType: 'bw', positiveMode: 'correct' };
    if (leftInWindow) Object.assign(items[lockAt], { userEdited: true, pendingUserEdited: false });
    const state = { fileQueue: items, importFilmTypeAuto: true, rollReference: { applyLock: false }, rollMetadata: {} };
    const context = vm.createContext({
      state, structuredClone, Map, Set, Promise, automaticRollRevision: 0, importFilmTypeRolls: new Map(),
      learnedReady: Promise.resolve(), learnedRecords: new Map(['color', 'bw', 'positive'].map(type => learnedDefaultsKey({ filmType: type }))
        .map(key => [key, learnedRecord(key)])), applyLearnedDefaults, learnedDefaultsKey,
      decideRollFilmType, mergeRollDecision, ownFilmTypeVerdict, rollDecisionFrame, rollFilmTypeTarget, ROLL_MONOCHROME,
      applyAutomaticFilmType, sanitizeFilmTypeOverride, scheduleImportFilmTypeUpdate: () => {}, getCurrentQueueItem: () => null
    });
    vm.runInContext(['importFilmTypeRoll', 'importFilmTypeActive', 'createImportFilmTypeRoll', 'liveImportSettings', 'importFilmTypeLocked']
      .map(functionSource).join('\n') + '\n' + functions, context);
    context.createImportFilmTypeRoll(items);
    const recipes = [];
    // A roll import's frames get their recipes in turn, as pass 1 and the
    // lanes give them.
    for (const [i, item] of items.entries()) {
      let settings = { coreContrast: 0, ...VERDICTS[pattern[i]] };
      if (lock === 'manual' && i === lockAt) settings = { ...settings, filmTypeSource: 'manual' };
      settings = await context.learnedImportSettings(context.settleImportFilmType(item, settings), item);
      item.settings = settings;
      if (editedAfter && i === lockAt) item.userEdited = true;
      recipes.push(settings);
    }
    const record = context.importFilmTypeRoll(items[0]);
    return JSON.stringify({ recipes, typed: [...record.typed].map(([item, target]) => [item.id, target]) });
  };
  const NEW = ['importUserEdited', 'learnsImportDefaults', 'learnedImportSettings', 'refreshImportFilmTypeDecision', 'settleImportFilmType']
    .map(functionSource).join('\n');
  let cases = 0;
  for (const pattern of PATTERNS) for (const lock of LOCKS) for (let lockAt = 0; lockAt < pattern.length; lockAt++) {
    assert.equal(await decide(NEW, pattern, lockAt, lock), await decide(OLD, pattern, lockAt, lock), `${pattern} ${lock}@${lockAt}`);
    cases++;
    if (!lock) break;
  }
  // The one difference: a frame left inside the window decides as its pass
  // began, like one decode's photo edited after its pass; before, the edit
  // decided its recipe.
  for (const pattern of PATTERNS) for (let at = 0; at < pattern.length; at++) {
    const left = await decide(NEW, pattern, at, null, { leftInWindow: true });
    assert.equal(left, await decide(OLD, pattern, at, null, { editedAfter: true }), `${pattern} left@${at}: one decode's recipe`);
    assert.notEqual(left, await decide(OLD, pattern, at, null, { leftInWindow: true }), `${pattern} left@${at}: not the edit's`);
  }
  assert.equal(cases, PATTERNS.length * (1 + (LOCKS.length - 1) * 5));
}

// ---- persist-then-read flows in the window (#255 review R2-029) --------------------------
// Analyze roll, Auto Frame Selected, Apply film type to roll and Save Project
// persist the open photo's recipe and read it back. persistCurrentFileSettings
// refuses in the window, so each waits for the installed full decode first;
// the open photo then ends as after the same action on one decode. Each flow
// runs on one decode, on two stages, and once as before the barrier, which
// loses the photo's own values.
const CHANNELS = [0, 1, 2].map(() => ({ whitePointOrigin: 50000, blackPointOrigin: 500, meanPoint: 0.5 }));
const ACTION_FUNCTIONS = ['runRollAnalysis', 'analyzeRollFromButton', 'runStudioAutoFrame', 'applyAutoFrameToSelected',
  'applyFilmTypeToRoll', 'saveProject', 'buildCurrentProject'];
function actionFixture(options) {
  const f = flowFixture(options);
  const { target, state } = f;
  state.rollAnalysis = {};
  f.saved = [];
  Object.assign(target, {
    studioAutoFrameRunning: false, automaticRollAnalysisRunning: false, manualRollAnalysisRunning: false,
    automaticRollImportRunning: false, automaticRollPendingItems: new Set(), liveSampleStores: new Set(),
    applyFilmTypeOverride, applyAutomaticFilmType, sanitizeFilmTypeOverride,
    aggregateRollAnalysis, sanitizeRollFrameForSettings, groupAutomaticRollFrames,
    hiddenJobs: { safeMode: false, admit: async () => () => {} }, hiddenJobBytesFor: async () => 0,
    createFrameClaim: () => ({ release() {} }), runHiddenJobItem: (_files, work) => work(),
    loadFileToImageData: async () => image(FULL),
    createAnalysisSampleStore: () => {
      const values = new Map();
      return { get: async key => values.get(key) || null, put: async (key, value) => { values.set(key, value); },
        delete: async key => { values.delete(key); }, clear: async () => { values.clear(); } };
    },
    buildRollSample: (_img, settings) => ({ width: 32, height: 21, crop: settings.cropRegion || null }),
    measureNegativeMean: () => 0.4, requiresFilmBase: () => true, analyzeSilverCoreFrame: async () => CHANNELS,
    createTileConverter: () => ({ dispose() {} }), usesSilverCoreConversion: () => false,
    goToStep: step => { state.currentStep = step; }, autoFrameEffectiveAngle: angle => angle,
    buildRollProject: project => structuredClone(project), serializeRollProject: project => JSON.stringify(project),
    saveBlob: async blob => { f.saved.push(JSON.parse(await blob.text())); return { saved: true }; }
  });
  vm.runInContext(ACTION_FUNCTIONS.map(functionSource).join('\n'), f.context);
  return f;
}
const SINGLE = { twoStage: false };
const WINDOW = { twoStage: true };
// Recipes compared without their timestamps (roll id, detection time).
const recipeOf = settings => JSON.stringify({
  ...settings, rollFrame: settings?.rollFrame ? { ...settings.rollFrame, rollId: 'roll' } : null,
  autoFrameMeta: settings?.autoFrameMeta ? { ...settings.autoFrameMeta, detectedAt: 0 } : null
});
// One decode, then two stages with the action clicked while stage 2 is held.
async function runFlow(action, { twoStage, before = null }) {
  const f = actionFixture({ twoStage });
  const stage2 = twoStage ? await loadedStandIn(f) : (await loadedSingle(f), null);
  await importPass(f);
  await before?.(f);
  const running = action(f);
  if (twoStage) {
    await flush();
    assert.equal(f.state.fullDecode.status, 'running', 'the action waits for stage 2');
    assert.equal(f.item.settings, null, 'nothing is persisted from the stand-in');
    assert.equal(f.target.document.body.dataset.studioBusy, undefined, 'and nothing is locked while it waits');
    assert.ok(f.toasts.includes('Preparing full resolution…'));
    stage2.resolve(image(FULL));
  }
  await running;
  await flush();
  assert.equal(f.context.currentPhotoExact(), true);
  return f;
}
const AUTO_FRAME = { angle: 1.2, rotatedWidth: FULL.width, rotatedHeight: FULL.height,
  cropRegion: { left: 600, top: 400, width: 8000, height: 5400 }, confidenceLevel: 'high', confidence: 0.9 };
const detectsFrame = f => {
  f.target.runImportDetections = async (img, options) => { f.detections.push({ width: img.width, options }); return { image: img, detection: { result: { ...AUTO_FRAME } }, read: null }; };
};
{
  // Analyze roll: the open photo keeps its auto-frame crop and learned contrast.
  const analyze = f => f.context.analyzeRollFromButton();
  const one = await runFlow(analyze, SINGLE);
  const two = await runFlow(analyze, WINDOW);
  const settings = two.item.settings;
  assert.equal(settings.rollFrame?.locked, true, 'the roll analysis committed');
  assert.deepEqual(settings.cropRegion, { left: 476, top: 316, width: 8582, height: 5702 }, 'the full decode\'s auto-frame crop');
  assert.equal(settings.coreContrast, 5, 'the learned contrast');
  assert.equal(recipeOf(settings), recipeOf(one.item.settings), 'Analyze roll in the window commits what one decode commits');
  assert.equal(recipeOf(two.context.extractCurrentSettings()), recipeOf(one.context.extractCurrentSettings()), 'and the open photo shows it');
  // On one decode nothing changes: the old handler ran the analysis directly.
  assert.equal(recipeOf((await runFlow(f => f.context.runRollAnalysis(), SINGLE)).item.settings), recipeOf(one.item.settings), 'one decode: as before');
  // Before the barrier the button ran the analysis at once: the open photo's
  // recipe came from bare defaults and the swap kept it as the user's edit.
  const f = actionFixture(WINDOW);
  const stage2 = await loadedStandIn(f);
  await importPass(f);
  await f.context.runRollAnalysis();
  stage2.resolve(image(FULL));
  await flush(40);
  f.context.persistCurrentFileSettings({ silent: true, force: true });
  assert.deepEqual([f.item.settings.cropRegion, f.item.settings.coreContrast], [null, 0], 'control: without the barrier the crop and the learned contrast are lost');
}
{
  // Auto Frame Selected: the new frame over the photo's own recipe.
  const one = await runFlow(f => f.context.runStudioAutoFrame(true), { ...SINGLE, before: detectsFrame });
  const two = await runFlow(f => f.context.runStudioAutoFrame(true), { ...WINDOW, before: detectsFrame });
  assert.equal(JSON.stringify(two.item.settings.cropRegion), JSON.stringify(AUTO_FRAME.cropRegion), 'the detected frame');
  assert.equal(two.item.settings.coreContrast, 5, 'the learned contrast stays');
  assert.equal(recipeOf(two.item.settings), recipeOf(one.item.settings), 'Auto Frame Selected in the window gives what one decode gives');
  assert.equal(recipeOf(two.context.extractCurrentSettings()), recipeOf(one.context.extractCurrentSettings()));
  // runStudioAutoFrame's body as before the barrier.
  const unguarded = async f => {
    f.context.persistCurrentFileSettings({ silent: true, force: true });
    f.target.goToStep(1);
    await f.context.applyAutoFrameToSelected();
  };
  assert.equal(recipeOf((await runFlow(unguarded, { ...SINGLE, before: detectsFrame })).item.settings), recipeOf(one.item.settings), 'one decode: as before');
  const f = actionFixture(WINDOW);
  const stage2 = await loadedStandIn(f);
  await importPass(f);
  detectsFrame(f);
  await unguarded(f);
  stage2.resolve(image(FULL));
  await flush(40);
  f.context.persistCurrentFileSettings({ silent: true, force: true });
  assert.equal(f.item.settings.coreContrast, 0, 'control: without the barrier the learned contrast is lost');
}
{
  // Save Project: the open photo's recipe goes into the project.
  const one = await runFlow(f => f.context.saveProject(), SINGLE);
  const two = await runFlow(f => f.context.saveProject(), WINDOW);
  const saved = two.saved[0].files[0].settings;
  assert.ok(saved, 'the open photo is saved with a recipe');
  assert.equal(saved.coreContrast, 5);
  assert.equal(recipeOf(saved), recipeOf(one.saved[0].files[0].settings), 'Save Project in the window saves what one decode saves');
  const before = await runFlow(f => { f.saved.push(JSON.parse(f.target.serializeRollProject(f.context.buildCurrentProject({ persist: true })))); }, SINGLE);
  assert.equal(JSON.stringify(before.saved[0]), JSON.stringify(one.saved[0]), 'one decode: the project as before');
  const f = actionFixture(WINDOW);
  await loadedStandIn(f);
  await importPass(f);
  assert.equal(f.context.buildCurrentProject({ persist: true }).files[0].settings, null, 'control: without the barrier it is saved without one');
}
{
  // Apply film type to roll on a revisited photo (a recipe from an earlier
  // visit) with an exposure edit made in the window: the edit stays.
  const recipe = { rotationAngle: 0, mirrored: false, cropRegion: { ...SAVED }, coreExposure: 0, coreContrast: 5, filmType: 'color',
    filmTypeSource: 'auto', filmTypeConfidence: 'high', filmTypeReason: null, filmEdge: { checked: true }, filmBase: { r: 205, g: 141, b: 92 } };
  const revisit = async (twoStage) => {
    const f = actionFixture({ twoStage });
    f.item.settings = structuredClone(recipe);
    const stage2 = twoStage ? await loadedStandIn(f, { settled: structuredClone(recipe) }) : (await loadedSingle(f), null);
    f.context.restoreSettings(f.item.settings, { refreshDisplay: false });
    f.state.currentStep = 3;
    if (twoStage) {
      f.state.provisional.start = { fresh: false, snapshot: f.context.extractCurrentSettings(), detectFrame: false, readEdge: false, userEdited: false };
      f.state.provisional.settledSnapshot = f.context.extractCurrentSettings();
      f.context.startProvisionalSettle(f.state.fullDecode);
    }
    f.item.userEdited = true;
    f.state.coreExposure = 18;
    return { f, stage2 };
  };
  // The handler as before the barrier.
  const unguarded = f => {
    f.context.persistCurrentFileSettings({ silent: true, force: true });
    for (const item of f.state.fileQueue) {
      item.filmTypeOverride = { filmType: 'color', positiveMode: 'correct' };
      if (item.settings) item.settings = applyFilmTypeOverride(item.settings, item.filmTypeOverride);
    }
    f.context.restoreSettings(f.item.settings, { refreshDisplay: false });
  };
  const single = await revisit(false);
  await single.f.context.applyFilmTypeToRoll();
  const before = await revisit(false);
  unguarded(before.f);
  assert.equal(recipeOf(before.f.item.settings), recipeOf(single.f.item.settings), 'one decode: as before');
  const { f, stage2 } = await revisit(true);
  const applying = f.context.applyFilmTypeToRoll();
  await flush();
  assert.equal(f.state.fileQueue.some(item => item.filmTypeOverride), false, 'it waits for stage 2');
  stage2.resolve(image(FULL));
  await applying;
  await flush();
  assert.equal(f.item.settings.coreExposure, 18, 'the window edit is in the persisted recipe');
  assert.ok(f.state.fileQueue.every(item => item.filmTypeOverride?.filmType === 'color'));
  assert.equal(recipeOf(f.item.settings), recipeOf(single.f.item.settings), 'Apply film type to roll in the window gives what one decode gives');
  assert.equal(recipeOf(f.context.extractCurrentSettings()), recipeOf(single.f.context.extractCurrentSettings()));
  const control = await revisit(true);
  unguarded(control.f);
  control.stage2.resolve(image(FULL));
  await flush(40);
  assert.equal(control.f.state.coreExposure, 0, 'control: without the barrier the window edit is lost');
}
{
  // Crop mode opened while Save Project waits: the swap waits for the draft,
  // and closing it lets both finish.
  const f = actionFixture(WINDOW);
  const stage2 = await loadedStandIn(f);
  await importPass(f);
  const saving = f.context.saveProject();
  await flush();
  f.state.cropping = true;
  stage2.resolve(image(FULL));
  await flush(40);
  assert.deepEqual([f.saved.length, f.state.fullDecode.status], [0, 'decoded'], 'the swap waits for the crop draft, and the save for the swap');
  f.state.cropping = false;
  for (const resolve of f.target.cropModeWaiters.splice(0)) resolve();
  await saving;
  assert.equal(f.saved.length, 1, 'saved once crop mode closed');
  assert.equal(f.saved[0].files[0].settings.coreContrast, 5);
}
// The automatic roll import waits on studioBackgroundReady (fake timers): a
// window neither blocks it for good nor deadlocks with the barrier.
function fakeTimers(target) {
  let now = 0, id = 0;
  const timers = new Map();
  target.setTimeout = (fn, ms = 0) => { timers.set(++id, { fn, at: now + (ms || 0) }); return id; };
  target.clearTimeout = timer => { timers.delete(timer); };
  return {
    get pending() { return timers.size; },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await flush();
        const [next] = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at);
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
      await flush(40);
    }
  };
}
async function automaticRollInWindow({ click }) {
  const f = actionFixture(WINDOW);
  for (const item of f.state.fileQueue.slice(1)) item.settings = { filmType: 'color', filmTypeSource: 'auto', filmBase: { r: 205, g: 141, b: 92 }, filmEdge: { checked: true }, coreExposure: 0 };
  const marker = { begins: 0, finishes: 0 };
  Object.assign(f.target, {
    createJobMarker: () => ({ begin() { marker.begins++; }, record() {}, setEdited() {}, finish() { marker.finishes++; } }),
    watchRollSamples: { take: () => null },
    planRollAnalysisLanes: async () => ({ decodeSlots: 1, framesInFlight: 1, slotBytes: Infinity }),
    createRollAnalysisWorkers: () => ({ frames: null, slots: null, analyzers: null, configure() {}, dispose() {} }),
    runRollAnalysisPass: async () => {}
  });
  vm.runInContext(functionSource('scheduleAutomaticRollImport'), f.context);
  const stage2 = await loadedStandIn(f);
  await importPass(f);
  const timers = fakeTimers(f.target);
  f.context.scheduleAutomaticRollImport(f.state.fileQueue, { prepared: true });
  await timers.advance(1200 + 750 * 3);
  assert.equal(marker.begins, 0, 'no attempt starts in the window');
  assert.equal(f.target.automaticRollPendingItems.size, 3, 'the import is still pending');
  const clicked = click ? f.context.analyzeRollFromButton() : null;
  stage2.resolve(image(FULL));
  await flush(40);
  await clicked;
  await timers.advance(750 * 4);
  assert.equal(f.context.currentPhotoExact(), true);
  assert.equal(f.target.automaticRollPendingItems.size, 0, 'the import ended');
  assert.equal(timers.pending, 0, 'nothing is left waiting');
  assert.equal(f.item.settings.rollFrame?.locked, true, 'the open photo is locked to the roll');
  assert.deepEqual([f.item.settings.coreContrast, f.item.settings.rotationAngle], [5, 0.5], 'with its own recipe');
  return { f, marker };
}
{
  const automatic = await automaticRollInWindow({ click: false });
  assert.deepEqual([automatic.marker.begins, automatic.marker.finishes], [1, 1], 'the automatic import ran once the photo was exact');
  // Analyze roll clicked in the window: the manual analysis runs once the
  // photo is exact and supersedes the import, which ends without running.
  const manual = await automaticRollInWindow({ click: true });
  assert.deepEqual([manual.marker.begins, manual.f.target.automaticRollRevision], [0, 1]);
}

// ---- the analysis area in the window (#255 review R2-052) ---------------------------------------
// Confirm image area and Apply Crop on the stand-in, against the same on one
// decode. The stand-in's auto-frame (its frame and image area a pixel off,
// as 2x2-binned data without the defect pass gives) and its crop-area
// detection are provisional: the swap installs the full decode's
// diagnostics with the user's confirmed area (fractions of the base, the
// same area on both decodes) or the crop applied again on the full base,
// whose crop-area detection runs on the installed base.
const FULL_CROP = { left: 480, top: 320, width: 8576, height: 5696 };
const FULL_WINDOW = { left: 400, top: 260, width: 8736, height: 5816 };
// Diagnostics compared field by field, whatever order their keys were set in.
const canon = value => JSON.stringify(value, (_key, v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v));
function areaFixture({ twoStage }) {
  const f = fixture({ search: twoStage ? '?twoStageMinMp=40&twoStageMode=sequential' : '' });
  const { target, state } = f;
  // Settings carry autoFrameMeta as the real sanitizeSettings and
  // deepCopySanitizedSettings do.
  const sanitize = target.sanitizeSettings;
  target.sanitizeSettings = (raw, options = {}) => ({
    ...sanitize(raw, options),
    autoFrameMeta: raw === state ? state.autoFrame.lastDiagnostics ?? null
      : raw && Object.hasOwn(raw, 'autoFrameMeta') ? raw.autoFrameMeta
        : options.fallbackSettings === state ? state.autoFrame.lastDiagnostics ?? null : options.fallbackSettings?.autoFrameMeta ?? null
  });
  target.deepCopySanitizedSettings = (safe, { autoFrameMeta = safe.autoFrameMeta } = {}) => ({
    ...structuredClone(safe), autoFrameMeta: autoFrameMeta ? structuredClone(autoFrameMeta) : null
  });
  // The import's auto-frame of `img`: on the stand-in a pixel off.
  target.analyzeStudioImportFrame = async (img, settings) => {
    const scale = img.width / FULL.width, off = img.width === FULL.width ? 0 : 1;
    const rect = r => ({ left: Math.round(r.left * scale) + off, top: Math.round(r.top * scale), width: Math.round(r.width * scale), height: Math.round(r.height * scale) });
    return {
      ...settings, rotationAngle: 0.5, mirrored: false, cropRegion: rect(FULL_CROP),
      autoFrameMeta: {
        confidence: off ? 0.88 : 0.91, confidenceLevel: 'high', detectedFormat: '135', method: 'hough', appliedMode: 'crop',
        importAuto: true, frameIncomplete: false, imageArea: imageAreaFromDetection({ cropRegion: rect(FULL_WINDOW), angle: 0.5 }, img)
      }
    };
  };
  // Apply's crop-area detection: what it was started with, and its outcome
  // (a hit completes the diagnostics it was given, applyCropDetectionOutcome).
  f.cropDetections = [];
  let pending = null;
  Object.assign(target, {
    startCropDetection: options => {
      const detection = { ...options, gate: deferred(), metaAtStart: canon(options.meta), live: { ...state.cropRegion } };
      pending = detection;
      f.cropDetections.push(detection);
      return detection;
    },
    hasPendingCropDetection: () => Boolean(pending),
    cancelCropDetection: () => {
      if (!pending) return;
      const detection = pending;
      pending = null;
      detection.cancelled = true;
      detection.gate.resolve();
    },
    settlePendingCropDetection: async () => { while (pending) await pending.gate.promise; }
  });
  f.land = (detection, imageArea) => {
    assert.equal(pending, detection, 'the detection is still pending');
    Object.assign(detection.meta, { imageArea, analysisNeedsReview: false, frameIncomplete: false, method: 'manual-image-window' });
    pending = null;
    detection.gate.resolve();
  };
  vm.runInContext(functionSource('restoreAutoFrameDiagnostics'), f.context);
  return f;
}
// A fresh photo's import on the loaded base (prepareStudioPhoto's auto-frame;
// on a stand-in in full units, recorded for the settle).
async function importFrame(f) {
  const { context, state, target } = f;
  const provisional = state.provisional;
  const snapshot = context.extractCurrentSettings();
  if (provisional) {
    provisional.start = { fresh: true, inputs: { automatic: true }, snapshot, detectFrame: true, readEdge: false, applyEdgeDefaults: false,
      autoFrame: { enabled: true, onImport: true }, userEdited: false, pendingEdits: null };
  }
  let settings = await target.analyzeStudioImportFrame(state.loadedBaseImageData, snapshot);
  if (provisional) settings = { ...settings, ...provisional.geometry.toExact(settings) };
  context.restoreSettings(settings, { refreshDisplay: false });
  state.currentStep = 3;
  if (provisional) provisional.settledSnapshot = context.extractCurrentSettings();
}
// Apply in crop mode, as its click handler does it (no straighten): the
// diagnostics, the new crop, and the crop-area detection on the loaded base.
function applyCrop(f, { rect = null, selectedArea = null, analysisOnly = false }) {
  const { context, state, target } = f;
  const base = state.loadedBaseImageData;
  const geometry = { rotationAngle: state.rotationAngle, mirrored: state.mirrored };
  const frame = context.geometryFrameSize(base, state.rotationAngle);
  const { meta, detect } = context.appliedCropDiagnostics(state.autoFrame.lastDiagnostics, {
    selectedArea: selectedArea || imageAreaFromWorkingRect(rect, geometry, base), base, analysisOnly,
    previous: { ...geometry, cropRegion: state.cropRegion, frame }
  });
  state.autoFrame.lastDiagnostics = meta;
  if (!analysisOnly) target.applyGeometryFromBase({ cropRegion: rect });
  return detect ? target.startCropDetection({ meta, base, frame, cropRegion: { ...state.cropRegion }, ready: Promise.resolve(true) }) : null;
}
// Two stages: the stand-in's import, `edit` in the window, stage 2 landing.
async function windowFlow(edit, { control = null } = {}) {
  const f = areaFixture({ twoStage: true });
  const stage2 = await loadedStandIn(f);
  await importFrame(f);
  control?.(f);
  const window = await edit(f);
  f.context.startProvisionalSettle(f.state.fullDecode);
  stage2.resolve(image(FULL));
  await flush(40);
  return { f, window };
}
async function singleFlow(edit) {
  const f = areaFixture({ twoStage: false });
  await loadedSingle(f);
  await importFrame(f);
  await edit(f);
  return f;
}
// The rect on the stand-in's frame of the window's edits, and the same rect
// in full units (2x the stand-in's here).
const WINDOW_AREA = { left: 1000, top: 700, width: 2400, height: 1500 };
// A crop reaching past the image window's corner: not its frame, so Apply
// detects the image area inside it.
const WINDOW_CROP = { left: 0, top: 0, width: 2000, height: 1500 };
const double = r => ({ left: r.left * 2, top: r.top * 2, width: r.width * 2, height: r.height * 2 });
{
  // (a) Confirm image area: the area the user confirmed on the stand-in
  // survives the swap; everything else in the diagnostics is the full
  // decode's, and the analysis area kept for an uncertain re-detection is the
  // settled frame's on the full base.
  let area = null, region = null;
  const confirm = async f => {
    applyCrop(f, { rect: WINDOW_AREA, analysisOnly: true });
    area = structuredClone(f.state.autoFrame.lastDiagnostics.imageArea);
    region = resolveAnalysisRegion({ ...f.context.liveGeometry(), autoFrameMeta: f.state.autoFrame.lastDiagnostics }, f.state.loadedBaseImageData);
  };
  const { f } = await windowFlow(confirm);
  assert.equal(f.state.fullDecode.status, 'installed');
  assert.equal(f.state.loadedBaseImageData.width, FULL.width);
  const meta = f.state.autoFrame.lastDiagnostics;
  assert.equal(JSON.stringify(meta.imageArea), JSON.stringify(area), 'the confirmed area survives the swap');
  assert.deepEqual([meta.method, meta.analysisNeedsReview, meta.frameIncomplete, meta.confidence], ['manual-analysis-area', false, false, 0.91],
    'over the full decode\'s diagnostics');
  assert.equal(f.cropDetections.length, 0, 'a confirmed area is not detected');
  // In full-size units: the same part of the photo's frame on the full base.
  const full = resolveAnalysisRegion({ ...f.context.extractCurrentSettings(), autoFrameMeta: meta }, f.state.loadedBaseImageData);
  for (const key of ['left', 'top', 'width', 'height']) assert.ok(Math.abs(full[key] - region[key]) < 1e-3, `analysis region ${key}`);
  // One decode, the same area confirmed after its import: the same diagnostics.
  const one = await singleFlow(async g => { applyCrop(g, { selectedArea: area, analysisOnly: true }); });
  assert.equal(canon(meta), canon(one.state.autoFrame.lastDiagnostics), 'Confirm image area in the window gives one decode\'s diagnostics');
  assert.equal(JSON.stringify(f.context.extractCurrentSettings().cropRegion), JSON.stringify(one.context.extractCurrentSettings().cropRegion));
  // Before the fix the analysis area alone was no window edit: the swap kept
  // the full decode's automatic area.
  const control = await windowFlow(confirm, { control: g => {
    g.target.windowEdits = (settled, live) => {
      const edits = windowEdits(settled, live);
      if (!('cropRegion' in edits)) delete edits.autoFrameMeta;
      return edits;
    };
  } });
  const lost = control.f.state.autoFrame.lastDiagnostics;
  assert.notEqual(JSON.stringify(lost.imageArea), JSON.stringify(area), 'control: the confirmed area is lost at the swap');
  assert.equal(lost.method, 'hough');
}
{
  // (b) Apply Crop: the stand-in's crop-area detection ends (or its hit is
  // dropped), and the crop's detection runs on the installed base with one
  // decode's miss outcome; the photo is exact once it has landed.
  const STANDIN_HIT = imageAreaFromDetection({ cropRegion: { left: 202, top: 131, width: 1798, height: 1369 }, angle: 0.5 }, HALF);
  const FULL_HIT = imageAreaFromDetection({ cropRegion: double({ left: 200, top: 130, width: 1800, height: 1370 }), angle: 0.5 }, FULL);
  for (const landed of [false, true]) {
    const crop = async f => {
      const detection = applyCrop(f, { rect: WINDOW_CROP });
      assert.ok(detection, 'Apply starts a crop-area detection');
      assert.equal(detection.base.width, HALF.width, 'on the stand-in');
      if (landed) f.land(detection, STANDIN_HIT);
      return detection;
    };
    const { f, window } = await windowFlow(crop);
    assert.equal(window.cancelled, landed ? undefined : true, landed ? 'the stand-in\'s hit landed' : 'the stand-in\'s detection ends at the swap');
    assert.equal(f.cropDetections.length, 2, 'the crop is detected again');
    const detection = f.cropDetections[1];
    assert.equal(detection.base, f.state.loadedBaseImageData, 'on the installed full base');
    assert.equal(detection.base.width, FULL.width);
    assert.equal(detection.meta, f.state.autoFrame.lastDiagnostics, 'completing the installed diagnostics');
    assert.equal(JSON.stringify(detection.cropRegion), JSON.stringify(double(WINDOW_CROP)), 'for the crop in full units');
    const atStart = JSON.parse(detection.metaAtStart);
    assert.deepEqual([atStart.analysisNeedsReview, atStart.method, atStart.confidence], [true, 'hough', 0.91], 'the miss outcome over the full decode\'s diagnostics');
    assert.equal(f.state.fullDecode.status, 'swapped', 'not exact while the detection runs');
    f.land(detection, FULL_HIT);
    await flush(40);
    assert.equal(f.state.fullDecode.status, 'installed', 'exact once it landed');
    // One decode applying the same crop after its import.
    const one = await singleFlow(async g => { applyCrop(g, { rect: double(WINDOW_CROP) }); });
    const reference = one.cropDetections[0];
    assert.equal(detection.metaAtStart, reference.metaAtStart, 'the diagnostics Apply installs on one decode');
    assert.equal(JSON.stringify([detection.frame, detection.cropRegion]), JSON.stringify([reference.frame, reference.cropRegion]));
    one.land(reference, FULL_HIT);
    assert.equal(canon(f.state.autoFrame.lastDiagnostics), canon(one.state.autoFrame.lastDiagnostics), 'and its hit, as on one decode');
  }
  // Before the fix the merged recipe kept the stand-in's detection.
  const control = await windowFlow(async f => {
    const detection = applyCrop(f, { rect: WINDOW_CROP });
    f.land(detection, STANDIN_HIT);
  }, { control: g => { g.target.windowFrameMetaOnFull = (_settled, merged) => ({ meta: merged.autoFrameMeta, detect: false }); } });
  assert.equal(control.f.cropDetections.length, 1, 'control: no detection on the full base');
  assert.equal(JSON.stringify(control.f.state.autoFrame.lastDiagnostics.imageArea), JSON.stringify(STANDIN_HIT), 'control: the stand-in\'s hit is the analysis area');
}
{
  // (c) A geometry edit alone (a rotation) and Restore full frame: the full
  // decode's diagnostics, not the stand-in's auto-frame result they used to
  // carry with the geometry; Restore keeps its applied mode.
  const rotate = async f => { f.state.rotationAngle = 1.5; f.target.applyGeometryFromBase({ cropRegion: f.state.cropRegion }); };
  const { f } = await windowFlow(rotate);
  const one = await singleFlow(rotate);
  assert.equal(f.state.autoFrame.lastDiagnostics.confidence, 0.91);
  assert.equal(canon(f.state.autoFrame.lastDiagnostics), canon(one.state.autoFrame.lastDiagnostics), 'a rotation in the window: one decode\'s diagnostics');
  const restore = async g => {
    g.state.rotationAngle = 0;
    g.state.autoFrame.lastDiagnostics.appliedMode = 'none';
    g.target.applyGeometryFromBase({ cropRegion: null });
  };
  const restored = await windowFlow(restore);
  const reference = await singleFlow(restore);
  assert.equal(restored.f.state.autoFrame.lastDiagnostics.appliedMode, 'none');
  assert.equal(canon(restored.f.state.autoFrame.lastDiagnostics), canon(reference.state.autoFrame.lastDiagnostics), 'Restore full frame in the window: one decode\'s diagnostics');
  const control = await windowFlow(rotate, { control: g => { g.target.windowFrameMetaOnFull = (_settled, merged) => ({ meta: merged.autoFrameMeta, detect: false }); } });
  assert.equal(control.f.state.autoFrame.lastDiagnostics.confidence, 0.88, 'control: the stand-in\'s auto-frame result');
}

// ---- Apply flat field to selected in the window (#255 review R2-034) -----------------------------
// Photos without settings get defaults measured on the open frame. In the
// window that waits for the full decode, so their film base is the full
// decode's (205 here, the stand-in's 190), as on one decode.
const OLD_FLAT_FIELD_DEFAULTS = `async function flatFieldDefaultsImage(items, sourceFile = null) {
      const needed = items.some(item => !(sourceFile && item.file === sourceFile) && item.file !== state.loadedFile && !item.settings);
      return needed && state.originalImageData ? geometryFramePixels() : null;
    }`;
function flatFieldFixture({ twoStage, old = false }) {
  const f = fixture({ search: twoStage ? '?twoStageMinMp=40&twoStageMode=sequential' : '' });
  Object.assign(f.state, { flatFields: { ff: { id: 'ff', source: 'blank.dng' } }, flatFieldActiveId: 'ff', flatFieldId: null });
  f.item.selected = true;
  f.others = ['B.DNG', 'blank.dng', 'C.DNG'].map(name => ({ file: { name, size: 1 }, selected: true, settings: null, isDirty: false }));
  f.others[2].settings = { filmBase: { r: 1, g: 1, b: 1 } };
  f.state.fileQueue.push(...f.others);
  Object.assign(f.target, {
    // The working frame of the loaded base (the pool builds it from the base).
    geometryFramePixels: async () => f.state.loadedBaseImageData,
    getInterpolatedText: (_key, _values, fallback) => fallback
  });
  vm.runInContext(['applyFlatFieldToSelected', 'applyFlatFieldToItems', 'flatFieldDefaultsImage'].map(functionSource).join('\n'), f.context);
  if (old) vm.runInContext(OLD_FLAT_FIELD_DEFAULTS, f.context);
  return f;
}
{
  const one = flatFieldFixture({ twoStage: false });
  await loadedSingle(one);
  await one.context.applyFlatFieldToSelected();
  assert.deepEqual([one.others[0].settings.filmBase.r, one.others[0].settings.flatFieldId], [205, 'ff'], 'one decode: defaults measured on the full decode');
  const f = flatFieldFixture({ twoStage: true });
  const stage2 = await loadedStandIn(f);
  f.state.provisional.start = { fresh: false, snapshot: f.context.extractCurrentSettings(), detectFrame: false, readEdge: false };
  f.state.provisional.settledSnapshot = f.context.extractCurrentSettings();
  const applying = f.context.applyFlatFieldToSelected();
  await flush();
  assert.equal(f.state.fullDecode.status, 'running', 'it waits for stage 2');
  assert.equal(f.others[0].settings, null, 'nothing is measured on the stand-in');
  assert.ok(f.toasts.includes('Preparing full resolution…'));
  stage2.resolve(image(FULL));
  await applying;
  assert.equal(f.context.currentPhotoExact(), true);
  assert.equal(JSON.stringify(f.others[0].settings), JSON.stringify(one.others[0].settings), 'Apply flat field to selected in the window gives one decode\'s defaults');
  assert.equal(f.others[1].settings, null, 'never on the blank itself');
  assert.deepEqual([f.others[2].settings.filmBase.r, f.others[2].settings.flatFieldId, f.state.flatFieldId], [1, 'ff', 'ff']);
  // Nothing needs the open frame: no wait.
  const settled = flatFieldFixture({ twoStage: true });
  await loadedStandIn(settled);
  settled.others[0].selected = false;
  await settled.context.applyFlatFieldToSelected();
  assert.deepEqual([settled.state.fullDecode.status, settled.others[2].settings.flatFieldId], ['running', 'ff'], 'photos with settings need no full decode');
  // Before the barrier the defaults came from the stand-in.
  const control = flatFieldFixture({ twoStage: true, old: true });
  await loadedStandIn(control);
  await control.context.applyFlatFieldToSelected();
  assert.equal(control.others[0].settings.filmBase.r, 190, 'control: measured on the stand-in');
}

// ---- stage 2's reservation and the ledger (#255 review R2-057) --------------------------------
// Releasing stage 2's foreground reservation admits the requests waiting in
// the budget at once (memoryBudget.js). That admission must read a ledger
// that already counts the decoded full base, which no plane holds yet: the
// record takes it before the reservation goes. Before, it took it in the
// attempt's `.then`, after the release, and a lane waiting behind the
// foreground reservation was admitted as if the full base did not exist.
{
  const lines = functionSource('beginFullDecodeAttempt').split('\n');
  const from = lines.findIndex(line => line.includes('The ledger counts the full base from its return'));
  const to = lines.findIndex((line, i) => i > from && line.includes('record.decodedImage = image;'));
  assert.ok(from > 0 && to > from, 'the early count exists');
  const OLD_BEGIN = [...lines.slice(0, from), ...lines.slice(to + 1)].join('\n');
  const run = async ({ old = false } = {}) => {
    const f = fixture();
    if (old) vm.runInContext(OLD_BEGIN, f.context);
    const full = { width: FULL.width, height: FULL.height, data: new Uint8ClampedArray(600_000) };
    const reads = [], events = [];
    let released = false;
    f.target.memoryBudget = createMemoryBudget({
      budgetBytes: 1 << 20,
      // The ledger's open photo, as main.js measures it.
      retainedBytes: () => {
        const buffers = backingBuffers(f.context.openPhotoMemoryRoots());
        let bytes = 0;
        for (const buffer of buffers) bytes += buffer.byteLength;
        if (released) reads.push({ bytes, full: buffers.has(full.data.buffer) });
        return bytes;
      },
      onEvent: event => {
        events.push(event);
        if (event.type === 'release' && event.priority === 'foreground' && event.label.startsWith('full-resolution ')) released = true;
      }
    });
    const stage2 = await loadedStandIn(f);
    f.state.provisional.start = { fresh: false, snapshot: f.context.extractCurrentSettings(), detectFrame: false, readEdge: false };
    f.state.provisional.settledSnapshot = f.context.extractCurrentSettings();
    // A user job holds a reservation, stage 2 takes its own at the loader
    // gate, and a lane's frame waits behind that foreground reservation.
    const job = await f.target.memoryBudget.reserve(1, { priority: 'user', label: 'job' });
    await stage2.options.reserveDecode({ kind: 'raw', width: FULL.width, height: FULL.height, estimatedBytes: 400_000 });
    const abort = new AbortController();
    let lane = null;
    f.target.memoryBudget.reserve(600_000, { priority: 'background', label: 'lane', signal: abort.signal }).then(handle => { lane = handle; }, () => {});
    await flush();
    assert.equal(lane, null, 'the lane waits behind stage 2');
    stage2.resolve(full);
    await flush();
    assert.equal(f.state.fullDecode.status, 'decoded');
    assert.equal(f.state.fullDecode.decodedImage, full, 'the ledger counts the full base until the swap');
    const result = { reads: reads.slice(), lane, grant: events.find(event => event.type === 'grant' && event.label === 'lane') || null };
    abort.abort();
    lane?.release();
    job.release();
    return result;
  };
  const fixed = await run();
  assert.ok(fixed.reads.length > 0, 'stage 2\'s release ran an admission');
  assert.equal(fixed.reads[0].full, true, 'that admission counts the full base');
  assert.ok(fixed.reads[0].bytes >= 600_000);
  assert.deepEqual([fixed.lane, fixed.grant], [null, null], 'the lane still waits: the full base leaves no room for it');
  const control = await run({ old: true });
  assert.equal(control.reads[0].full, false, 'control: the admission read the ledger without the full base');
  assert.ok(control.lane, 'control: the lane was admitted');
  assert.equal(control.grant.rule, 'fits', 'control: as if the full base did not exist');
}


console.log('twoStageImport: header routing, stage options and start, abort on switch, barrier, retry, exact crop across the swap, history rebase, window edits and the ledger\'s open photo passed');

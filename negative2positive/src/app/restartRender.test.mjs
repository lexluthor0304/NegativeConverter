import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createCoreReprocessGates } from './coreReprocessDispatcher.js';

// Exercise the actual browser lifecycle functions without loading a DOM,
// OpenCV, or ONNX. Only their UI and expensive conversion dependencies are
// replaced; deferred conversion replies make the failing ordering repeatable.
const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `runtime function exists: ${name}`);
  const end = source.indexOf('\n    }', match.index);
  assert.ok(end > match.index, `runtime function closes: ${name}`);
  return source.slice(match.index, end + '\n    }'.length);
}

function fixture({ repairs = true, locked = false } = {}) {
  const base = { width: 2, height: 2, name: 'same original source object' };
  const oldPixels = { width: 2, height: 2, exposure: 24 };
  const newPixels = { width: 2, height: 2, exposure: 0 };
  const state = {
    loadedBaseImageData: base, originalImageData: base,
    conversionSourceImageData: base, conversionPreviewImageData: base,
    processedImageData: oldPixels, coreExposure: 24, currentStep: 3,
    repairStrokes: repairs ? [{ points: [1] }] : [],
    dustRemoval: { enabled: false, processing: false },
  };
  let resolveOld, rejectOld;
  const oldConversion = new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject; });
  const applied = [];
  const clearedTimers = [];
  const noop = () => {};
  const context = vm.createContext({
    state, coreReprocessToken: 1, coreReprocessGeneration: 0, loadGeneration: 1,
    _coreReprocessFullInFlight: false, _coreReprocessPreviewInFlight: false,
    _coreReprocessPending: null, _coreReprocessActive: 0,
    _coreReprocessIdle: null, _resolveCoreReprocessIdle: null,
    coreReprocessScheduled: null, processNegativeInFlight: null,
    dustDetectionRevision: 1, dustDetectionTimer: null,
    fullResolutionRenderTimer: null, displayPreviewResizeTimer: null,
    fullUpdateTimer: null, coreReprocessTimer: null, step2AutoConvertTimer: null,
    webglState: { gl: null }, console,
    clearTimeout: timer => clearedTimers.push(timer),
    coreReprocessGates: createCoreReprocessGates({ clearTimeout: timer => clearedTimers.push(timer) }),
    CORE_RETAIN_PREVIEW_PLANE: true, corePreviewRetained: null, corePreviewCommit: null,
    corePreviewCommitWanted: false, corePreviewCommitTimer: null, corePreviewSettleWaiters: [],
    isDesktopBatchExportLocked: () => locked,
    clearUndoHistory: noop, pushUndo: noop, exitCropMode: noop, exitBeforeAfter: noop,
    cancelGeometryJob: noop, whenGeometrySettled: async () => true,
    resetZoomPan: noop, updateMirrorButtonState: noop,
    invalidateSilverCoreCache: noop, resetFrontierGuideImageState: noop,
    displayNegative: noop, updateAutoFrameButtons: noop, markCurrentFileDirty: noop,
    updateFull: noop, updatePreview: noop, updateDustStatusUI: noop,
    currentConvertedPreviewSource: () => state.processedImageData, carryStudioThumbnailSource: noop,
    displayResizeReplaces: () => null,
    disposeDustWorker: noop, unpinDustWorker: noop, noteDustReplaced: noop,
    getLocalizedText: (key, text) => text,
    noteCoreReprocessSettled: noop, resetDustForCleanSource: noop,
    scheduleDustDetection: noop, updateSlidersFromState: noop,
    resetExpiredStrengthsInState: noop, initCurves: noop, renderCurve: noop,
    usesSilverCoreConversion: () => true,
    hasFrameRepairs: () => state.dustRemoval.enabled || state.repairStrokes.length > 0,
    getDisplayPreviewSize: () => ({ width: 2, height: 2 }),
    convertFromCurrentSource: () => oldConversion,
    applyProcessedImageToState: pixels => { applied.push(pixels.exposure); state.processedImageData = pixels; },
    goToStep: step => { state.currentStep = step; },
    processNegative: async () => {
      // With no crop/lens correction the restart reuses this exact object,
      // so a source-identity check alone cannot reject an older conversion.
      state.conversionSourceImageData = state.originalImageData;
      state.conversionPreviewImageData = state.originalImageData;
      state.processedImageData = newPixels;
      applied.push(0);
      state.currentStep = 3;
    },
  });
  vm.runInContext([
    'clearFullResolutionRenderState', 'clearCoreReprocessTimer', 'cancelPendingTimers', 'clearDustState',
    'coreReprocessBusy', 'whenCoreReprocessIdle', 'noteCoreReprocessSettled',
    'runCoreReprocess', 'flushScheduledCoreReprocess',
    'resetAllAdjustments', 'rerenderWithCoreControls', 'postPendingPreviewEarly', 'restartPhotoProcessing',
    'retainCorePreviewPlane', 'armCorePreviewCommitTimer', 'releaseCorePreviewRetained', 'requestCorePreviewCommit',
    'maybeCommitCorePreviewPlane', 'settleCorePreviewWaiters',
  ].map(functionSource).join('\n'), context);
  return { context, state, base, oldPixels, newPixels, applied, clearedTimers, resolveOld, rejectOld };
}

for (const full of [true, false]) {
  const test = fixture({ repairs: full });
  const pending = test.context.rerenderWithCoreControls({ full });
  await test.context.restartPhotoProcessing();
  assert.equal(test.state.coreExposure, 0, 'restart resets the adjustment controls');
  assert.equal(test.state.conversionSourceImageData, test.base, 'same source identity reproduces the race');
  assert.equal(test.state.processedImageData, test.newPixels, 'restart has committed fresh pixels');
  test.resolveOld(test.oldPixels);
  assert.equal(await pending, false, `${full ? 'full' : 'preview'} response from before restart must be rejected`);
  assert.equal(test.state.processedImageData, test.newPixels, 'discarded exposure must not overwrite fresh pixels');
  assert.deepEqual(test.applied, [0], 'no stale source is committed after restart');
}

{
  const test = fixture({ repairs: false });
  const pending = test.context.rerenderWithCoreControls({ full: false });
  assert.equal(await test.context.rerenderWithCoreControls({ full: false }), false, 'preview queues behind an active preview');
  const queued = test.context._coreReprocessPending;
  assert.equal(queued.generation, 0, 'queued work retains its original processing generation');
  assert.equal(queued.token, 1, 'queued work retains its original settings token');
  assert.equal(queued.sourceRef, test.base, 'queued work retains its original source');
  await test.context.restartPhotoProcessing();
  // Simulate a new slider request using the current generation. That must not
  // make the old frame admissible under the preview anti-starvation rule.
  test.context.coreReprocessScheduled = { full: false, token: test.context.coreReprocessToken };
  assert.equal(await test.context.rerenderWithCoreControls(queued), false, 'old queued requests cannot adopt a new generation');
  test.resolveOld(test.oldPixels);
  assert.equal(await pending, false);
  assert.deepEqual(test.applied, [0]);
}

{
  const test = fixture();
  const pending = test.context.rerenderWithCoreControls({ full: true });
  test.resolveOld(test.oldPixels);
  assert.equal(await pending, true, 'a current full render still commits normally');
  assert.equal(test.state.processedImageData, test.oldPixels);
}

for (const failConversion of [false, true]) {
  const test = fixture({ repairs: false });
  // This is the direct call used by the dust-off handler, not the tracked
  // runCoreReprocess wrapper. Export must still observe and await it.
  const pending = test.context.rerenderWithCoreControls({ full: true });
  let exportSettled = false;
  const exportBarrier = test.context.flushScheduledCoreReprocess().then(() => { exportSettled = true; });
  await new Promise(setImmediate);
  assert.equal(test.context.coreReprocessBusy(), true);
  assert.equal(exportSettled, false, 'export cannot overtake a direct dust-off render');
  if (failConversion) {
    const rejected = assert.rejects(pending, /conversion failed/);
    test.rejectOld(new Error('conversion failed'));
    await rejected;
  } else {
    test.resolveOld(test.oldPixels);
    assert.equal(await pending, true);
  }
  await exportBarrier;
  assert.equal(exportSettled, true, 'export barrier settles after conversion succeeds or fails');
  assert.equal(test.context.coreReprocessBusy(), false);
  assert.equal(test.context.whenCoreReprocessIdle(), null);
}

{
  const test = fixture({ repairs: false });
  const requests = [];
  test.context.convertFromCurrentSource = () => new Promise(resolve => requests.push(resolve));
  const full = test.context.rerenderWithCoreControls({ full: true });
  const preview = test.context.rerenderWithCoreControls({ full: false });
  assert.equal(await test.context.rerenderWithCoreControls({ full: true }), false);
  let exported = false;
  const barrier = test.context.flushScheduledCoreReprocess().then(() => { exported = true; });
  requests[1](test.oldPixels);
  await preview;
  await new Promise(setImmediate);
  assert.equal(exported, false, 'queued full render remains blocked until the active full render settles');
  assert.ok(test.context._coreReprocessPending);
  requests[0](test.oldPixels);
  await full;
  await new Promise(setImmediate);
  assert.equal(requests.length, 3, 'the queued render is replayed after both active lanes settle');
  assert.equal(exported, false, 'export must also await the replayed render');
  requests[2](test.newPixels);
  await barrier;
  assert.equal(test.state.processedImageData, test.newPixels);
  assert.equal(test.context.coreReprocessBusy(), false);
  assert.equal(test.context._coreReprocessActive, 0);
}

{
  const test = fixture();
  const timerNames = [
    'fullUpdateTimer', 'coreReprocessTimer', 'step2AutoConvertTimer',
    'displayPreviewResizeTimer', 'dustDetectionTimer', 'fullResolutionRenderTimer',
  ];
  for (const name of timerNames) test.context[name] = name;
  test.context.coreReprocessScheduled = { full: false, token: 1 };
  test.context._coreReprocessPending = { full: true, token: 1 };
  await test.context.restartPhotoProcessing();
  for (const name of timerNames) {
    assert.equal(test.context[name], null, `${name} cannot restart discarded work`);
    assert.ok(test.clearedTimers.includes(name), `${name} is actually cancelled`);
  }
  assert.equal(test.context.coreReprocessScheduled, null, 'discarded debounced render is cleared');
  assert.equal(test.context._coreReprocessPending, null, 'discarded queued render is cleared');
}

{
  const test = fixture({ locked: true });
  await test.context.restartPhotoProcessing();
  assert.equal(test.context.coreReprocessToken, 1, 'a blocked restart leaves the active export generation intact');
  assert.equal(test.state.coreExposure, 24);
  assert.equal(test.state.processedImageData, test.oldPixels);
  assert.deepEqual(test.applied, []);
}

{
  const test = fixture({ repairs: false });
  const { context, state } = test;
  const conversions = [];
  const overlayHides = [];
  const noop = () => {};
  Object.assign(context, {
    isCurrentLoad: generation => generation === context.loadGeneration,
    createPerfTrace: () => ({ mark: noop, end: noop }),
    getImageDataPixelCount: image => image.width * image.height,
    getLoadingOverlay: () => ({ show: async () => {}, updateProgress: noop,
      hide: () => overlayHides.push(context.coreReprocessGeneration) }),
    i18n: { en: {} }, currentLang: 'en', aiRepair: { status: 'ready' },
    applyLensCorrectionWithSettings: async image => image,
    buildPreviewSourceImageData: image => image, refreshCanvasContainerSize: () => false,
    hasSeparateConversionPreview: () => false,
    maybeAutoWhiteBalance: noop, maybeAnalyzeExpiredRescue: noop,
    syncBatchUIState: noop, revealBatchFileList: noop,
    updateStudioThumbnail: noop, scheduleFullUpdate: noop,
    setTimeout: callback => { queueMicrotask(callback); return 1; },
    appAlert: error => { throw new Error(error); },
    convertFromCurrentSource: () => new Promise(resolve => {
      conversions.push({ resolve, exposure: state.coreExposure });
    }),
  });
  vm.runInContext(functionSource('processNegative'), context);
  const oldConversion = context.processNegative();
  await new Promise(setImmediate);
  assert.equal(conversions.length, 1);
  assert.equal(conversions[0].exposure, 24);
  await context.restartPhotoProcessing();
  await new Promise(setImmediate);
  assert.equal(conversions.length, 2, 'restart launches a new conversion instead of joining the old same-source promise');
  assert.equal(conversions[1].exposure, 0);
  const newOwner = context.processNegativeInFlight;
  conversions[0].resolve(test.oldPixels);
  await oldConversion;
  assert.equal(context.processNegativeInFlight, newOwner, 'old finally cannot clear the newer conversion owner');
  assert.deepEqual(overlayHides, [], 'old conversion cannot hide the new conversion overlay');
  assert.deepEqual(test.applied, [], 'old same-source conversion cannot commit');
  conversions[1].resolve(test.newPixels);
  await newOwner;
  await new Promise(setImmediate);
  assert.equal(context.processNegativeInFlight, null, 'current owner clears itself normally');
  assert.equal(state.processedImageData, test.newPixels);
  assert.deepEqual(test.applied, [0]);
  assert.equal(overlayHides.length, 1, 'only the current conversion hides its overlay');
}

for (const withNewOwner of [false, true]) {
  const test = fixture({ repairs: false });
  const { context, state } = test;
  const frames = [];
  const retries = [];
  Object.assign(context, {
    hasSeparateConversionPreview: () => true,
    createPerfTrace: () => ({ end() {} }),
    getImageDataPixelCount: image => image ? image.width * image.height : 0,
    waitForNextFrame: () => new Promise(resolve => frames.push(resolve)),
    scheduleFullResolutionRender: reason => retries.push(reason),
    FULL_RESOLUTION_INTERACTIVE_DELAY_MS: 600,
  });
  vm.runInContext(functionSource('startFullResolutionRender'), context);
  const oldFull = context.startFullResolutionRender();
  await context.restartPhotoProcessing();
  const newFull = withNewOwner ? context.startFullResolutionRender() : null;
  assert.equal(state.fullResolutionPromise, newFull);
  assert.equal(frames.length, withNewOwner ? 2 : 1);
  frames[0]();
  await oldFull;
  assert.equal(state.fullResolutionPromise, newFull, 'old full-resolution finally cannot replace the current owner');
  assert.equal(state.fullResolutionPending, withNewOwner, 'old finalizer cannot change the reset/new pending state');
  assert.deepEqual(retries, [], 'discarded generation cannot schedule a stale retry');
  if (!withNewOwner) continue;
  frames[1]();
  await new Promise(setImmediate);
  test.resolveOld(test.newPixels);
  await newFull;
  assert.equal(state.fullResolutionPromise, null, 'new full-resolution owner cleans up normally');
  assert.equal(state.fullResolutionPending, false);
  assert.equal(state.processedImageData, test.newPixels);
}

// #236: the first photo converts its provisional settings while the frame
// and film-edge detections run, then either keeps that render (same
// conversion key) or re-renders exactly once. The real prepareStudioPhoto,
// processNegative and full-resolution scheduling run against deferred
// detection and conversion replies.
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await new Promise(resolve => setTimeout(resolve, 2));
    for (let j = 0; j < 10; j++) await new Promise(setImmediate);
  }
};
const META_ONLY = ['autoFrameMeta', 'filmEdge', 'frameMetadata', 'filmTypeSource', 'filmTypeConfidence', 'filmTypeReason', 'learnedDefaults'];

function prepareFixture({ itemSettings = null, detectFrame = true, learned = 0 } = {}) {
  const base = { width: 40, height: 30, id: 'base' };
  const item = { file: { name: 'L1000617.DNG' }, settings: itemSettings, isDirty: false };
  const defaults = { id: 'defaults', filmType: 'color', coreExposure: 0, coreTemperature: 0, cropRegion: null, rotationAngle: 0, mirrored: false,
    autoFrameMeta: null, filmEdge: null, frameMetadata: {}, filmTypeSource: 'auto', filmTypeConfidence: 'medium', filmTypeReason: null, learnedDefaults: null };
  const state = {
    loadedBaseImageData: base, originalImageData: base, croppedImageData: null, cropRegion: null,
    autoFrame: { enabled: detectFrame, onImport: true, lastDiagnostics: null }, importFilmTypeAuto: true,
    step2Mode: 'border', currentStep: 1, live: structuredClone(itemSettings || defaults),
    photoSwitchTarget: item, photoSwitchPhase: 'preparing', fullResolutionPending: false,
    fullResolutionPromise: null, conversionSourceImageData: null, conversionPreviewImageData: null,
    dustRemoval: { enabled: false }, repairStrokes: [],
  };
  const log = [];
  const conversions = [];
  const frames = [];
  const edges = [];
  const armed = [];
  const marks = [];
  const overlay = { hides: 0, shows: 0, show: async () => { overlay.shows++; }, updateProgress() {}, hide() { overlay.hides++; } };
  const noop = () => {};
  const context = vm.createContext({
    state, console, structuredClone, DOMException, AbortController, JSON, Promise,
    loadGeneration: 1, coreReprocessGeneration: 0, processNegativeInFlight: null, importDetectionAbort: null,
    fullResolutionRenderTimer: null, FULL_RESOLUTION_IDLE_DELAY_MS: 2500,
    document: { body: { dataset: { photoSwitching: 'true' } } },
    i18n: { en: {} }, currentLang: 'en', aiRepair: { status: 'ready' },
    setTimeout: (fn, ms) => {
      if (!ms) return setTimeout(fn, 0);
      armed.push({ fn, ms, provisional: Boolean(item.provisional) });
      return armed.length;
    },
    clearTimeout: noop,
    isCurrentLoad: generation => generation === context.loadGeneration,
    getCurrentQueueItem: () => item,
    createPerfTrace: () => ({ mark: stage => marks.push(stage), end: noop }),
    getImageDataPixelCount: image => (image ? image.width * image.height : 0),
    getLoadingOverlay: () => overlay, quietLoadingOverlay: { show: async () => {}, updateProgress: noop, hide: noop },
    studioWorkspace: { sync: noop }, updateAutoFrameButtons: noop, updateExpiredRescueUI: noop,
    createDefaultSettings: () => structuredClone(defaults), mergeStudioColors: settings => settings,
    restoreSettings: settings => {
      log.push({ restore: settings.id });
      state.live = structuredClone(settings);
      state.cropRegion = settings.cropRegion;
      state.croppedImageData = settings.cropRegion ? { width: 20, height: 10, id: `crop:${settings.id}` } : null;
    },
    extractCurrentSettings: () => structuredClone(state.live),
    expiredImportKeepsFullFrame: () => false,
    analyzeStudioImportFrame: (source, settings, options) => {
      const reply = deferred();
      frames.push({ options, reply, settings });
      options.signal.addEventListener('abort', () => reply.reject(new DOMException('superseded', 'AbortError')));
      return reply.promise;
    },
    readImportFilmEdge: (source, options) => {
      const reply = deferred();
      edges.push({ options, reply });
      options.signal.addEventListener('abort', () => reply.reject(new DOMException('superseded', 'AbortError')));
      return reply.promise;
    },
    mergeImportFilmEdge: async (source, settings, read) => (read?.result
      ? { settings: { ...settings, id: `${settings.id}+edge`, filmEdge: { checked: true, found: true, filmName: 'KODAK' }, ...read.result.change }, toast: 'edge toast' }
      : { settings: { ...settings, filmEdge: { checked: true, found: false } }, toast: null }),
    provisionalLearnedSettings: async settings => ({ ...settings, coreTemperature: settings.coreTemperature + learned }),
    learnedImportSettings: async (settings, target) => {
      log.push({ learned: settings.id, provisional: Boolean(target.provisional) });
      target.automaticDefaults ||= structuredClone(settings);
      return { ...settings, id: `${settings.id}+learned`, coreTemperature: settings.coreTemperature + learned };
    },
    conversionKey: settings => JSON.stringify(Object.fromEntries(Object.entries(settings).filter(([key]) => key !== 'id' && !META_ONLY.includes(key)))),
    applyImportMetaToState: settings => { log.push({ meta: settings.id }); state.live = { ...state.live, ...Object.fromEntries(META_ONLY.map(key => [key, settings[key]])) }; },
    goToStep: step => { state.currentStep = step; },
    showToast: text => log.push({ toast: text }), updateFileListUI: noop,
    scheduleSemanticColour: () => log.push('semantic'), notifyImportReview: () => log.push('review'),
    scheduleProjectRecovery: noop, scheduleAiRepairPreloadForRecipe: noop, resetZoomPan: noop,
    // Outside a roll import (#231), with the geometry already built (#244).
    settleImportFilmType: (target, settings) => settings, deferImportFilmTypeToast: () => false,
    reviewForItem: () => ({ reasons: [] }), whenGeometrySettled: async () => true, pendingImportRotation: null,
    // processNegative's own dependencies.
    applyLensCorrectionWithSettings: async image => image,
    invalidateSilverCoreCache: noop,
    buildPreviewSourceImageData: image => ({ width: 8, height: 6, preview: image.id }),
    usesSilverCoreConversion: () => true,
    hasSeparateConversionPreview: () => Boolean(state.conversionSourceImageData && state.conversionPreviewImageData
      && state.conversionPreviewImageData !== state.conversionSourceImageData),
    convertFromCurrentSource: () => {
      const reply = deferred();
      conversions.push({ reply, settings: structuredClone(state.live), provisional: Boolean(item.provisional) });
      log.push({ convert: state.live.id });
      return reply.promise;
    },
    applyProcessedImageToState: image => { state.processedImageData = image; },
    maybeAutoWhiteBalance: () => { item.isDirty = true; }, maybeAnalyzeExpiredRescue: noop,
    syncBatchUIState: noop, revealBatchFileList: noop, updatePreview: noop, updateStudioThumbnail: noop,
    scheduleFullUpdate: noop, hasFrameRepairs: () => false, scheduleDustDetection: () => log.push('dust'),
    isLargeImage: () => false, startFullResolutionRender: noop,
    appAlert: error => { throw new Error(error); }, getLocalizedText: (key, text) => text,
    refreshCanvasContainerSize: () => false, noteDustReplaced: noop,
  });
  vm.runInContext([
    'prepareStudioPhoto', 'startImportDetection', 'buildFinalImportSettings', 'revealProvisionalPhoto',
    'armSettledConversion', 'processNegative', 'scheduleFullResolutionRender',
  ].map(functionSource).join('\n'), context);
  const answer = async (index = conversions.length - 1) => {
    conversions[index].reply.resolve({ width: 8, height: 6, id: `converted:${conversions[index].settings.id}` });
    await settle();
  };
  return { context, state, item, log, conversions, frames, edges, armed, marks, overlay, answer };
}

const unapplied = settings => ({ ...settings, autoFrameMeta: { appliedMode: 'none', method: 'density-template', confidence: 0.68, importAuto: true, imageArea: null } });
const cropped = settings => ({ ...settings, rotationAngle: 1.5, cropRegion: { left: 2, top: 2, width: 20, height: 10 },
  autoFrameMeta: { appliedMode: 'crop', method: 'contour', confidence: 0.9, importAuto: true, imageArea: [{ x: 0, y: 0 }] } });

// Detection that changes nothing, landing before, during or after the
// provisional conversion: exactly one conversion and no provisional idle render.
for (const timing of ['before', 'during', 'after']) {
  const f = prepareFixture();
  const done = f.context.prepareStudioPhoto(1, f.item, { quiet: true });
  await settle();
  assert.equal(f.frames.length, 1, 'frame detection starts without being awaited');
  assert.equal(f.edges.length, 1, 'the film-edge read starts alongside it');
  const detection = f.frames[0].options;
  assert.equal(detection.silent, true, 'detection never raises the global overlay');
  assert.equal(detection.filmType, 'color');
  assert.deepEqual({ ...detection.autoFrame }, { enabled: true, onImport: true, lastDiagnostics: null }, 'detection reads the snapshot settings');
  assert.notEqual(detection.autoFrame, f.state.autoFrame, 'a copy, not the live object');
  if (timing === 'before') {
    f.frames[0].reply.resolve(unapplied(f.frames[0].settings)); f.edges[0].reply.resolve({ result: null });
    await settle();
  }
  assert.equal(f.conversions.length, 1, 'the provisional conversion does not wait for detection');
  assert.equal(f.conversions[0].provisional, true);
  if (timing === 'during') {
    f.frames[0].reply.resolve(unapplied(f.frames[0].settings)); f.edges[0].reply.resolve({ result: null });
    await settle();
  }
  assert.equal(f.context.document.body.dataset.photoSwitching, 'true', 'the switch surface stays until the provisional paint');
  await f.answer(0);
  assert.equal(f.context.document.body.dataset.photoSwitching, undefined, 'the provisional paint reveals the photo');
  assert.equal(f.state.photoSwitchTarget, null);
  if (timing === 'after') {
    assert.equal(f.context.document.body.dataset.studioDetecting, 'frame', 'the tail reports the running detection');
    assert.equal(f.context.document.body.dataset.studioBusy, 'true', 'editing stays locked during the tail');
    assert.equal(f.item.provisional?.wasDirty, false, 'the item is marked provisional during the tail');
    assert.ok(!f.log.includes('semantic'), 'no semantic pass before the final settings');
    f.frames[0].reply.resolve(unapplied(f.frames[0].settings)); f.edges[0].reply.resolve({ result: null });
  }
  await done;
  assert.equal(f.conversions.length, 1, `${timing}: one conversion when detection changes nothing`);
  assert.deepEqual(f.log.filter(entry => entry.meta).map(entry => entry.meta), ['defaults+learned'], 'the detection descriptions are applied once');
  assert.equal(f.armed.filter(arm => arm.ms === 2500).length, 1, 'the idle full-resolution render is armed once');
  assert.ok(f.armed.every(arm => !arm.provisional), 'never while the item is provisional');
  assert.deepEqual(f.log.filter(entry => entry === 'semantic' || entry === 'review'), ['semantic', 'review'], 'semantic pass and review run once, at the end');
  assert.equal(f.log.filter(entry => entry.learned).length, 1, 'automaticDefaults are recorded by the final settings only');
  assert.equal(f.item.automaticDefaults.id, 'defaults', 'from the pre-learned final settings');
  assert.equal(f.item.provisional, undefined);
  assert.equal(f.item.isDirty, true, 'the provisional automatic WB stands as the final one');
  assert.equal(f.context.document.body.dataset.studioBusy, undefined);
  assert.equal(f.context.document.body.dataset.studioDetecting, undefined);
  assert.ok(f.marks.indexOf('autoFrame') > 0 && f.marks.indexOf('provisionalSettings') < f.marks.indexOf('autoFrame'),
    'the provisional conversion starts before the autoFrame mark');
  assert.ok(f.marks.indexOf('provisionalSettings') < f.marks.indexOf('settings'));
}

// Detection that reframes, landing while the provisional conversion is still
// in flight: exactly one re-render, from the state today's render starts from.
for (const timing of ['during', 'after']) {
  const f = prepareFixture({ learned: 2 });
  f.state.step2Mode = 'noBorder';
  const done = f.context.prepareStudioPhoto(1, f.item, { quiet: false });
  await settle();
  if (timing === 'during') {
    f.frames[0].reply.resolve(cropped(f.frames[0].settings));
    f.edges[0].reply.resolve({ result: { change: {} } });
    await settle();
  }
  f.state.step2Mode = 'border';
  await f.answer(0);
  assert.equal(f.overlay.hides > 0, true, 'the direct import overlay hides after the provisional paint');
  if (timing === 'after') {
    f.frames[0].reply.resolve(cropped(f.frames[0].settings));
    f.edges[0].reply.resolve({ result: { change: {} } });
    await settle();
  }
  assert.equal(f.conversions.length, 2, `${timing}: exactly one re-render`);
  assert.equal(f.conversions[1].provisional, false, 'the re-render converts final settings');
  assert.equal(f.conversions[1].settings.cropRegion.width, 20);
  assert.equal(f.conversions[1].settings.coreTemperature, 2, 'learned values apply once, to the final settings');
  assert.equal(f.state.step2Mode, 'noBorder', 'goToStep(2) starts from the pre-provisional mode');
  assert.equal(f.item.isDirty, false, 'the provisional WB dirty flag is undone before the re-render');
  assert.deepEqual(f.log.filter(entry => entry.restore).map(entry => entry.restore), ['defaults', 'defaults', 'defaults+edge+learned'],
    'fresh defaults, then the provisional settings, then the final settings');
  assert.equal(f.log.filter(entry => entry.meta).length, 0);
  assert.ok(!f.log.includes('semantic'), 'semantic pass waits for the re-render');
  await f.answer(1);
  await done;
  assert.deepEqual(f.log.filter(entry => entry === 'semantic' || entry.toast).map(entry => entry.toast || entry), ['edge toast', 'semantic'], 'toasts and the semantic pass run once, after the final step');
  assert.equal(f.armed.filter(arm => arm.ms === 2500).length, 1, 'only the final render arms the idle full-resolution pass');
  assert.equal(f.item.automaticDefaults.id, 'defaults+edge');
}

// Leaving mid-tail drops both detections and every final step; the item keeps
// settings === null and its pre-provisional dirty flag.
{
  const f = prepareFixture();
  const done = f.context.prepareStudioPhoto(1, f.item, { quiet: true });
  await settle();
  await f.answer(0);
  assert.equal(f.item.provisional?.wasDirty, false);
  f.context.loadGeneration++;
  f.context.importDetectionAbort.abort();
  await done;
  assert.equal(f.conversions.length, 1);
  assert.equal(f.item.settings, null);
  assert.equal(f.item.automaticDefaults, undefined, 'no final learned settings for a dropped tail');
  assert.equal(f.item.provisional, undefined);
  assert.equal(f.item.isDirty, false);
  assert.equal(f.log.filter(entry => entry.meta || entry === 'semantic' || entry.toast).length, 0);
  assert.equal(f.armed.length, 0, 'no idle render for the abandoned photo');
}

// Without detection work (a recipe that already has its frame and edge) the
// photo takes today's single pass.
{
  const settings = { id: 'saved', filmType: 'color', coreExposure: 5, coreTemperature: 0, cropRegion: null, rotationAngle: 0, mirrored: false,
    autoFrameMeta: { appliedMode: 'none', importAuto: true }, filmEdge: { checked: true, found: false }, frameMetadata: {}, learnedDefaults: null };
  const f = prepareFixture({ itemSettings: settings });
  const done = f.context.prepareStudioPhoto(1, f.item, { quiet: true });
  await settle();
  assert.equal(f.frames.length + f.edges.length, 0);
  assert.equal(f.conversions.length, 1);
  assert.equal(f.conversions[0].provisional, false);
  await f.answer(0);
  await done;
  assert.equal(f.armed.filter(arm => arm.ms === 2500).length, 1);
  assert.equal(f.context.document.body.dataset.studioDetecting, undefined);
}

// A load that is gone before any conversion hides its overlay (loadFile left
// it up for the conversion).
{
  const f = prepareFixture();
  f.state.originalImageData = null;
  await f.context.prepareStudioPhoto(1, f.item, { quiet: false });
  assert.equal(f.overlay.hides, 1);
}

console.log('restartRender: stale replies and queues rejected, direct-render export barrier and promise ownership preserved, valid renders and export lock respected, provisional first-photo render and single re-render ordered');

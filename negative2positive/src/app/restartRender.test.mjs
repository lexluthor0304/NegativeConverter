import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

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
    isDesktopBatchExportLocked: () => locked,
    clearUndoHistory: noop, pushUndo: noop, exitCropMode: noop, exitBeforeAfter: noop,
    resetZoomPan: noop, updateMirrorButtonState: noop,
    invalidateSilverCoreCache: noop, resetFrontierGuideImageState: noop,
    displayNegative: noop, updateAutoFrameButtons: noop, markCurrentFileDirty: noop,
    updateFull: noop, updatePreview: noop, updateDustStatusUI: noop,
    disposeDustWorker: noop, getLocalizedText: (key, text) => text,
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
    'clearFullResolutionRenderState', 'cancelPendingTimers', 'clearDustState',
    'coreReprocessBusy', 'whenCoreReprocessIdle', 'noteCoreReprocessSettled',
    'runCoreReprocess', 'flushScheduledCoreReprocess',
    'resetAllAdjustments', 'rerenderWithCoreControls', 'restartPhotoProcessing',
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
    buildPreviewSourceImageData: image => image,
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

console.log('restartRender: stale replies and queues rejected, direct-render export barrier and promise ownership preserved, valid renders and export lock respected');

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createPhotoSessionCache } from './photoSessionCache.js';

// Execute the actual lifecycle control flow. Only DOM/decoder/AI dependencies
// are stubbed; deferred worker replies expose intermediate ownership states.
const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source)?.index;
  assert.notEqual(start, undefined, `${name} exists in main.js`);
  const end = source.indexOf('\n    }', start);
  assert.ok(end > start, `${name} closes at module indentation`);
  return source.slice(start, end + '\n    }'.length);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(setImmediate);
const noop = () => {};
function image() {
  return { width: 4, height: 4, data: new Uint8ClampedArray(64),
    __image16: { width: 4, height: 4, data: new Uint16Array(64) } };
}

function fixture() {
  const base = image(), converted = image(), mask = new Uint8Array(16);
  const item = { file: new Blob(['original container']), settings: { repairStrokes: [] } };
  const state = {
    loadedFile: item.file, loadedBaseImageData: base, originalImageData: base,
    conversionSourceImageData: base, processedImageData: converted,
    previewSourceImageData: image(), currentStep: 3,
    processedImageDataIsPreview: false, fullResolutionPending: false,
    rawDecodePending: false, rawMetadata: { camera: 'test' }, flatFields: {},
    repairStrokes: [], zoomLevel: 1, panX: 0, panY: 0,
    dustRemoval: { enabled: true, strength: 3, maxParticleSize: 40, ai: true,
      processing: false, mask, cleanSource: converted, particleCount: 1, brushSize: 1, showMask: false },
    fileQueue: [item],
  };
  const photoSessions = createPhotoSessionCache({ maxBytes: 4096 });
  const photoPreviews = createPhotoSessionCache({ maxBytes: 4096 });
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { style: {}, textContent: '' });
    return elements.get(id);
  };
  const context = vm.createContext({
    state, photoSessions, photoPreviews, console: { warn: noop, error: noop },
    document: { body: { dataset: {} }, getElementById: element },
    File: globalThis.File, performance, Uint8Array, structuredClone, DOMException,
    aiRepair: { revision: 2, status: 'ready', provider: 'wasm', run: noop, release: noop },
    processNegativeInFlight: null, coreReprocessTimer: null, dustDetectionTimer: null,
    pendingBrushRepairs: 0, dustDrawing: false, undoStack: [], redoStack: [],
    coreReprocessGeneration: 3, coreReprocessToken: 4, dustDetectionRevision: 5,
    loadGeneration: 6, _coreReprocessPending: null,
    studioThumbnailUpdateFrame: 0, cancelAnimationFrame: noop,
    coreReprocessBusy: () => false,
    captureSnapshot: () => ({ refs: {
      processedImageData: state.processedImageData,
      conversionSourceImageData: state.conversionSourceImageData,
    } }),
    currentConvertedPreviewSource: () => state.processedImageData,
    buildAdjustmentSettings: () => ({}),
    createAdjustedPhotoPreview: () => image(),
    getDustSource: () => state.dustRemoval.cleanSource,
    dustBrushSource: converted, dustBrushToken: 4, dustBrushPoints: [{ x: 1, y: 1 }],
    dustBrushMode: 'direct', dustBrushTurn: Promise.resolve(),
    pushUndo: noop, createBrushMask: () => new Uint8Array(16),
    updateDustStatusUI: noop, updatePreview: noop, aiRepairReady: () => false,
    getLocalizedText: (key, fallback) => fallback,
    getInterpolatedText: (key, values, fallback) => fallback,
    applyDustResultToState: () => { state.processedImageData = state.dustRemoval.inpaintedImageData; },
    cancelPendingTimers: noop, cancelScheduledFullResolutionRender: noop,
    getLoadingOverlay: () => ({ hide: noop }), noteCoreReprocessSettled: noop,
    assertRepairCurrent: valid => { if (!valid()) throw new DOMException('Superseded', 'AbortError'); },
  });
  vm.runInContext(['photoSettingsKey', 'rememberPhotoSession', 'invalidatePhotoActivation',
    'isCurrentLoad', 'onDustBrushEnd'].map(functionSource).join('\n'), context);
  return { context, state, item, photoSessions, photoPreviews, base, converted, mask, element };
}

for (const outcome of ['success', 'stale', 'abort']) {
  const f = fixture(), previous = deferred(), refinement = deferred();
  const { context: c, state, item, photoSessions, photoPreviews } = f;
  c.dustDrawing = true;
  c.rememberPhotoSession(item);
  assert.equal(photoSessions.peek(item).snapshot, null, 'an unfinished pointer stroke is not a settled session');
  assert.equal(photoPreviews.size, 0);
  c.dustBrushTurn = previous.promise;
  let started = 0;
  c.refineDustMaskInWorker = () => { started++; return refinement.promise; };
  const pending = c.onDustBrushEnd({});
  assert.equal(c.pendingBrushRepairs, 1, 'the legacy turn is counted before awaiting its predecessor');
  c.rememberPhotoSession(item);
  assert.equal(photoSessions.peek(item).snapshot, null);
  assert.equal(photoSessions.peek(item).base, f.base, 'an unsettled session may still retain immutable decoded input');
  previous.resolve(); await tick();
  assert.equal(started, 1);
  c.rememberPhotoSession(item);
  assert.equal(photoSessions.peek(item).snapshot, null, 'worker refinement must not be mistaken for settled output');
  assert.equal(photoPreviews.size, 0);
  if (outcome === 'stale') c.invalidatePhotoActivation();
  const repaired = image(), newMask = new Uint8Array(16).fill(255);
  if (outcome === 'abort') refinement.reject(new DOMException('Worker disposed', 'AbortError'));
  else refinement.resolve({ imageData: repaired, mask: newMask, particleCount: 2 });
  await pending;
  assert.equal(c.pendingBrushRepairs, 0, 'success, stale-result and rejection paths all release the pending count');
  await c.dustBrushTurn;
  assert.equal(state.dustRemoval.mask, outcome === 'success' ? newMask : f.mask);
  assert.equal(state.processedImageData, outcome === 'success' ? repaired : f.converted);
  if (outcome === 'success') {
    c.rememberPhotoSession(item);
    assert.equal(photoSessions.peek(item).snapshot.refs.processedImageData, repaired);
    assert.equal(photoPreviews.size, 1);
  }
}

{
  const f = fixture(), c = f.context;
  const oldFull = f.state.processedImageData;
  const newPreview = f.state.previewSourceImageData;
  const convertedBase = image();
  // Distinct non-8-bit-aligned values detect accidental precision promotion.
  convertedBase.__image16.data.fill(12345);
  newPreview.__image16.data.fill(23456);
  f.base.__image16.data.fill(34567);
  f.state.conversionSourceImageData = convertedBase;
  f.state.fullResolutionPending = true;
  c.rememberPhotoSession(f.item);
  const entry = f.photoSessions.take(f.item);
  assert.equal(entry.previewOnly, true, 'a recent core preview cannot become full-resolution on restore');
  assert.equal(entry.fullResolutionPending, true);
  assert.equal(entry.snapshot.refs.processedImageData, f.state.previewSourceImageData,
    'cache the current preview rather than stale full pixels under new settings');
  assert.notEqual(entry.snapshot.refs.processedImageData, oldFull);
  assert.equal(entry.snapshot.refs.processedImageData.__image16.data, newPreview.__image16.data);
  assert.equal(entry.snapshot.refs.processedImageData.__image16.data[0], 23456);
  assert.equal(entry.snapshot.refs.conversionSourceImageData, convertedBase,
    'substituting pending preview pixels must preserve the full converted base');
  assert.equal(entry.snapshot.refs.conversionSourceImageData.__image16.data, convertedBase.__image16.data);
  assert.equal(entry.snapshot.refs.conversionSourceImageData.__image16.data[0], 12345);
  assert.equal(entry.base, f.base);
  assert.equal(entry.base.__image16.data[0], 34567, 'the decoded export source stays exact 16-bit');
  f.state.rawDecodePending = true;
  c.rememberPhotoSession(f.item);
  assert.equal(f.photoSessions.size, 0, 'a temporary RAW decode is not an immutable full decoded base');
}

{
  const f = fixture(), c = f.context;
  Object.assign(f.state, { zoomLevel: 2.5, panX: 13, panY: -21, fullResolutionPending: true });
  c.rememberPhotoSession(f.item);
  Object.assign(f.state, { currentFileIndex: -1, loadedFile: new Blob(['other photo']),
    zoomLevel: .25, panX: -100, panY: 100 });
  let restored = 0, scheduled = 0, cancelledFrame = 0;
  const warmFeedback = [];
  Object.assign(c, {
    studioAutoFrameRunning: false, isDesktopBatchExportLocked: () => false,
    singleExportActive: false, getCurrentQueueItem: () => null,
    studioWorkspace: { sync: () => warmFeedback.push(f.state.photoSwitchTarget) },
    requestAnimationFrame: () => assert.fail('warm cache hit must not yield for loading feedback'),
    expiredAnalysisKey: null, lensMapCache: new Map(), invalidateSilverCoreCache: noop,
    studioThumbnailUpdateFrame: 19, cancelAnimationFrame: id => { cancelledFrame = id; },
    restoreSnapshot: (snapshot, options) => {
      restored++;
      assert.deepEqual([f.state.zoomLevel, f.state.panX, f.state.panY], [2.5, 13, -21],
        'incoming zoom and pan must be applied before restoreSnapshot samples the display raster');
      assert.equal(snapshot.refs.processedImageData, f.state.previewSourceImageData);
      assert.equal(options.previewOnly, true);
      assert.equal(options.reprocess, false);
    },
    applyZoomPanTransform: noop, updateUndoRedoButtons: noop, updateStudioThumbnail: noop,
    updateFileListUI: noop, loadStudioThumbnails: noop,
    scheduleFullResolutionRender: reason => { assert.equal(reason, 'photo-restored'); scheduled++; },
  });
  vm.runInContext(functionSource('switchToFile'), c);
  await c.switchToFile(0);
  assert.equal(restored, 1);
  assert.equal(scheduled, 1, 'a pending full render is resumed after warm preview restoration');
  assert.equal(cancelledFrame, 19, 'the outgoing thumbnail frame cannot write into the incoming photo');
  assert.equal(c.studioThumbnailUpdateFrame, 0);
  assert.equal(f.state.loadedFile, f.item.file);
  assert.equal(f.photoSessions.size, 0, 'the active photo owns its buffers instead of retaining a cache alias');
  assert.ok(warmFeedback.length > 0 && warmFeedback.every(target => target == null),
    'warm restoration never announces a cold loading target');
}

function coldFixture() {
  const f = fixture(), c = f.context;
  const frames = [], loads = [], preparations = [], feedback = [];
  const second = { file: new File(['second'], 'second.png'), settings: null };
  const third = { file: new File(['third'], 'third.png'), settings: null };
  f.state.fileQueue.push(second, third);
  f.state.currentFileIndex = 0;
  Object.assign(c, {
    studioAutoFrameRunning: false, isDesktopBatchExportLocked: () => false,
    singleExportActive: false, getCurrentQueueItem: () => null,
    studioWorkspace: { sync: () => feedback.push({ target: f.state.photoSwitchTarget, phase: f.state.photoSwitchPhase }) },
    requestAnimationFrame: callback => frames.push(callback), setTimeout: callback => callback(),
    resetZoomPan: noop, updateFileListUI: noop, loadStudioThumbnails: noop,
    showToast: noop,
    loadFile: (file, options) => {
      assert.equal(options.quiet, true);
      const generation = ++c.loadGeneration;
      const gate = deferred();
      loads.push({ ...gate, file });
      return gate.promise.then(result => {
        if (c.isCurrentLoad(generation) && result.status === 'loaded') f.state.loadedFile = file;
        return result;
      });
    },
    prepareStudioPhoto: (generation, item) => {
      assert.equal(f.state.photoSwitchPhase, 'preparing');
      assert.equal(f.state.photoSwitchTarget, item);
      const gate = deferred();
      preparations.push(gate);
      return gate.promise;
    },
  });
  vm.runInContext(functionSource('switchToFile'), c);
  return { ...f, second, third, frames, loads, preparations, feedback };
}
for (const outcome of ['success', 'load-error', 'prepare-error']) {
  const f = coldFixture(), c = f.context;
  let redraws = 0;
  c.updatePreview = () => { redraws++; };
  const pending = c.switchToFile(1);
  assert.equal(f.state.photoSwitchTarget, f.second, 'target feedback is set synchronously on click');
  assert.equal(f.state.photoSwitchPhase, 'loading');
  assert.equal(f.feedback.at(-1).target, f.second);
  assert.equal(f.loads.length, 0, 'decoding cannot begin before the feedback paint');
  assert.equal(f.frames.length, 1);
  f.frames.shift()(); await tick();
  assert.equal(f.loads.length, 1);
  f.loads[0].resolve(outcome === 'load-error' ? { status: 'error', message: 'decode failed' } : { status: 'loaded' });
  await tick();
  if (outcome !== 'load-error') {
    assert.equal(f.preparations.length, 1);
    assert.equal(f.state.photoSwitchTarget, f.second, 'feedback remains through conversion, not just decoding');
    if (outcome === 'prepare-error') f.preparations[0].reject(new Error('conversion failed'));
    else f.preparations[0].resolve();
  }
  await pending;
  assert.equal(f.state.photoSwitchTarget, null);
  assert.equal(f.state.photoSwitchPhase, null);
  assert.equal(c.document.body.dataset.photoSwitching, undefined);
  assert.equal(c.document.body.dataset.studioBusy, undefined);
  if (outcome !== 'success') assert.equal(f.second.status, 'error');
  if (outcome === 'load-error') {
    assert.equal(f.state.currentFileIndex, 0);
    assert.equal(f.state.loadedFile, f.item.file);
    assert.equal(redraws, 1, 'failed target/proxy restores the actual loaded photo before removing its veil');
  }
}

for (const supersedeBeforePaint of [false, true]) {
  const f = coldFixture(), c = f.context;
  const older = c.switchToFile(1);
  if (!supersedeBeforePaint) { f.frames.shift()(); await tick(); }
  const newer = c.switchToFile(2);
  assert.equal(f.state.photoSwitchTarget, f.third);
  if (supersedeBeforePaint) { f.frames.shift()(); await tick(); }
  else f.loads[0].resolve({ status: 'loaded' });
  await older;
  assert.equal(f.state.photoSwitchTarget, f.third, 'stale completion cannot erase the newer target');
  assert.equal(c.document.body.dataset.photoSwitching, 'true');
  assert.equal(c.document.body.dataset.studioBusy, 'true');
  f.frames.shift()(); await tick();
  assert.equal(f.loads.at(-1).file, f.third.file);
  assert.equal(f.loads.length, supersedeBeforePaint ? 1 : 2,
    'a superseded pre-paint request does not decode');
  f.loads.at(-1).resolve({ status: 'loaded' }); await tick();
  f.preparations[0].resolve();
  await newer;
  assert.equal(f.state.loadedFile, f.third.file);
  assert.equal(f.state.photoSwitchTarget, null);
  assert.equal(c.document.body.dataset.photoSwitching, undefined);
}

{
  const f = fixture(), c = f.context;
  const undo = { label: 'cyan' }, redo = { label: 'density' };
  let restored = 0, consoleCommits = 0;
  Object.assign(c, {
    stateReady: true, manualEditRevision: 8, MAX_UNDO: 20,
    undoStack: [undo], redoStack: [redo],
    getCurrentQueueItem: () => f.item, getUndoLabel: value => value,
    restoreSnapshot: () => { restored++; }, updateUndoRedoButtons: noop,
    showToast: noop, pruneHistoryForMemory: noop,
    sanitizePresetType: value => value,
    CONSOLE_CHANNELS: { density: { stateKey: 'coreExposure', step: 10 }, cyan: { stateKey: 'cyan', step: 5 } },
    CONSOLE_MAX_STEPS: 8,
    commitConsoleChannel: () => { consoleCommits++; }, updateConsoleReadouts: noop,
    getBeforeAfterReferenceImageData: () => f.converted,
  });
  f.state.coreExposure = 20;
  f.state.cyan = 10;
  vm.runInContext(['performUndo', 'performRedo', 'consoleChannelsEnabled', 'consoleColorKeysEnabled',
    'consoleChannelSteps', 'nudgeConsoleChannel', 'resetConsoleChannels', 'canActivateBeforeAfter']
    .map(functionSource).join('\n'), c);
  c.document.body.dataset.photoSwitching = 'true';
  c.performUndo(); c.performRedo();
  c.nudgeConsoleChannel('density', 1); c.nudgeConsoleChannel('cyan', -1); c.resetConsoleChannels();
  assert.equal(restored, 0, 'global undo/redo cannot restore outgoing snapshots onto a pending target');
  assert.equal(consoleCommits, 0);
  assert.equal(c.undoStack[0], undo); assert.equal(c.redoStack[0], redo);
  assert.equal(c.manualEditRevision, 8);
  assert.equal(f.item.userEdited, undefined);
  assert.equal(f.state.coreExposure, 20); assert.equal(f.state.cyan, 10);
  assert.equal(c.canActivateBeforeAfter(), false, 'Space cannot reveal the outgoing comparison while loading');

  let zoomKeydown, zoomCalls = 0;
  c.document.addEventListener = (type, listener) => { assert.equal(type, 'keydown'); zoomKeydown = listener; };
  Object.assign(c, {
    isEditableTarget: () => false, canvasContainer: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 80 }) },
    ZOOM_BUTTON_FACTOR: 1.2, zoomAtPoint: () => { zoomCalls++; }, resetZoomPan: () => { zoomCalls++; },
  });
  const zoomStart = source.indexOf('    // Keyboard zoom shortcuts');
  const zoomEnd = source.indexOf('    // Undo/Redo keyboard shortcuts', zoomStart);
  vm.runInContext(source.slice(zoomStart, zoomEnd), c);
  for (const key of ['+', '-', '0']) zoomKeydown({ key, preventDefault: noop });
  assert.equal(zoomCalls, 0, 'global zoom keys cannot change the cached outgoing view');

  delete c.document.body.dataset.photoSwitching;
  assert.equal(c.canActivateBeforeAfter(), true);
  c.performUndo(); c.performRedo();
  assert.equal(restored, 2, 'ordinary undo/redo resumes immediately after activation');
  c.nudgeConsoleChannel('density', 1);
  assert.equal(f.state.coreExposure, 30);
  assert.equal(consoleCommits, 1);
  for (const key of ['+', '-', '0']) zoomKeydown({ key, preventDefault: noop });
  assert.equal(zoomCalls, 3, 'ordinary keyboard zoom resumes without a sticky lock');
}

for (const locked of [false, true]) {
  const f = fixture(), c = f.context;
  c.rememberPhotoSession(f.item);
  assert.ok(f.photoSessions.bytes > 0 && f.photoPreviews.bytes > 0);
  let pickerOpened = 0, emptyListRefreshes = 0;
  Object.assign(c, {
    isDesktopBatchExportLocked: () => locked,
    clearDustState: noop, clearUndoHistory: noop, clearProjectRecovery: noop,
    exitCropMode: noop, exitBeforeAfter: noop, resetZoomPan: noop,
    composeDisplaySprocketFrame: { clear: noop },
    sprocketPreviewFrameCache: { key: 'old', sourceRef: f.base, metrics: {} },
    sprocketPreviewFrameCanvas: { width: 100, height: 100 },
    sprocketScratchCanvas: { width: 100, height: 100 },
    beforeAfterScratchCanvas: { width: 100, height: 100 },
    zoomControls: { style: {} }, canvas: { style: {} }, glCanvas: { style: {} },
    updateMirrorButtonState: noop, clearFullResolutionRenderState: noop,
    invalidateSilverCoreCache: noop, stopHotFolder: noop,
    createInitialLensCorrectionState: () => ({}), resetFrontierGuideImageState: noop,
    resetRollReferenceState: noop, webglState: { gl: null },
    fullUpdateTimer: null, step2AutoConvertTimer: null,
    setUploadPlaceholderStatus: noop, updateBeforeAfterButtonState: noop,
    updateSprocketControlsUI: noop, resetAllAdjustments: noop, syncBatchUIState: noop,
    updateFileListUI: () => { assert.equal(f.state.fileQueue.length, 0); emptyListRefreshes++; },
    fileInput: { value: 'old', click: () => { pickerOpened++; } },
  });
  c.document.body.dataset = { studioBusy: 'true', photoSwitching: 'true' };
  f.state.photoSwitchTarget = f.item;
  f.state.photoSwitchPhase = 'loading';
  vm.runInContext(functionSource('closePhotoSession'), c);
  const oldGeneration = c.loadGeneration, oldToken = c.coreReprocessToken;
  c.closePhotoSession();
  if (locked) {
    assert.equal(c.loadGeneration, oldGeneration);
    assert.ok(f.photoSessions.bytes > 0 && f.photoPreviews.bytes > 0);
    assert.equal(pickerOpened, 0);
    assert.equal(emptyListRefreshes, 0);
  } else {
    assert.equal(f.photoSessions.bytes, 0, 'close releases inactive snapshots without a later file-list refresh');
    assert.equal(f.photoPreviews.bytes, 0, 'close releases presentation previews even when picker is cancelled');
    assert.equal(f.photoSessions.size + f.photoPreviews.size, 0);
    assert.equal(f.state.loadedFile, null);
    assert.equal(f.state.loadedBaseImageData, null);
    assert.equal(f.state._pendingFullResBuffer, null);
    assert.equal(c.isCurrentLoad(oldGeneration), false);
    assert.ok(c.coreReprocessToken > oldToken);
    assert.equal(c.document.body.dataset.photoSwitching, undefined);
    assert.equal(c.document.body.dataset.studioBusy, undefined);
    assert.equal(f.state.photoSwitchTarget, null);
    assert.equal(f.state.photoSwitchPhase, null);
    assert.equal(c.sprocketPreviewFrameCache.sourceRef, null);
    assert.equal(c.sprocketPreviewFrameCanvas.width, 1);
    assert.equal(pickerOpened, 1);
    assert.equal(emptyListRefreshes, 1, 'close releases memoized file-list rows even if the picker is cancelled');
  }
}

function aiFixture() {
  const f = fixture(), c = f.context;
  Object.assign(c, {
    defaultInferencePreference: () => 'wasm', updateAiRepairUI: noop, showToast: noop,
    hasFrameRepairs: () => true, scheduleDustDetection: noop,
    DEFAULT_MODEL_URL: '/local-model.onnx',
    aiRepairReady: () => c.aiRepair.status === 'ready',
    localExposureGeometryFor: () => ({}), repairMask: () => f.mask,
    inpaintDustOffMainThread: async () => f.converted,
  });
  vm.runInContext(['performAiRepairModelLoad', 'inpaintForCommit', 'inpaintManualBrush']
    .map(functionSource).join('\n'), c);
  return f;
}

for (const succeed of [false, true]) {
  const f = aiFixture(), c = f.context, fetched = deferred();
  const before = c.photoSettingsKey(f.item);
  c.fetchModelBytes = () => fetched.promise;
  c.createInpaintSessionInWorker = async () => ({ run: noop, release: noop, provider: 'wasm' });
  const pending = c.performAiRepairModelLoad('/replacement.onnx', { refresh: false });
  const loading = c.photoSettingsKey(f.item);
  assert.notEqual(loading, before, 'old-model repair caches invalidate before replacement finishes');
  await tick();
  if (succeed) fetched.resolve(new Uint8Array(8));
  else fetched.reject(new Error('replacement unavailable'));
  await pending;
  assert.equal(c.aiRepair.status, succeed ? 'ready' : 'error');
  assert.notEqual(c.photoSettingsKey(f.item), before, 'failed replacement cannot revive old-model cached repairs');
  if (succeed) assert.notEqual(c.photoSettingsKey(f.item), loading, 'new successful session has a distinct repair revision');
}

for (const manual of [false, true]) {
  const f = aiFixture(), c = f.context;
  if (manual) f.state.repairStrokes = f.item.settings.repairStrokes = [{ points: [{ x: .5, y: .5 }], size: .01 }];
  const before = c.photoSettingsKey(f.item);
  c.inpaintWithModel = async () => { throw new Error('inference failed'); };
  if (manual) await assert.rejects(c.inpaintManualBrush(f.converted), /inference failed/);
  else assert.equal(await c.inpaintForCommit(f.converted, f.mask), f.converted);
  assert.equal(c.aiRepair.status, 'error');
  assert.notEqual(c.photoSettingsKey(f.item), before, `${manual ? 'manual-brush' : 'automatic-dust'} inference failure invalidates repaired snapshots`);
}

{
  const f = fixture(), c = f.context;
  f.state.dustRemoval.enabled = false;
  const unaffected = c.photoSettingsKey(f.item);
  c.aiRepair.revision++;
  assert.equal(c.photoSettingsKey(f.item), unaffected, 'AI changes do not invalidate photos with no repairs');
  f.item.settings.flatFieldId = 'flat';
  const missing = c.photoSettingsKey(f.item);
  f.state.flatFields.flat = { id: 'flat' };
  const available = c.photoSettingsKey(f.item);
  assert.notEqual(available, missing, 'flat-field availability is part of the cache key');
  delete f.state.flatFields.flat;
  assert.equal(c.photoSettingsKey(f.item), missing);
}

console.log('photoSessionLifecycle: real legacy-brush settling, precision flags, close cleanup and repair-key invalidation passed');

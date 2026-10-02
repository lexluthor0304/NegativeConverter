import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createPhotoSessionCache } from './photoSessionCache.js';
import { createThumbnailSourceCache } from './thumbnailSources.js';
import { createRollSampleCache } from './rollSampleCache.js';
import { exactSettingsKey } from './settingsKey.js';
import { createHiddenJobGate } from './hiddenJobGate.js';
import { applyStrokePatch } from './dustStrokeHistory.js';
import { displaySessionStubs, DISPLAY_SESSION_HELPERS } from './displaySessionHarness.mjs';

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
  const thumbnailSources = createThumbnailSourceCache();
  thumbnailSources.put(item, { working: base, baseSize: { width: base.width, height: base.height }, geometryKey: 'k' });
  const watchRollSamples = createRollSampleCache(1024 * 1024);
  watchRollSamples.put(item, { data: new Uint8ClampedArray(4) });
  const postPaint = [];
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { style: {}, textContent: '' });
    return elements.get(id);
  };
  const context = vm.createContext({
    state, photoSessions, photoPreviews, thumbnailSources, watchRollSamples, console: { warn: noop, error: noop },
    // No two-stage import here (#255).
    abandonFullDecode: noop, leaveProvisionalPhoto: noop,
    document: { body: { dataset: {} }, getElementById: element },
    File: globalThis.File, performance, Uint8Array, structuredClone, DOMException, AbortController,
    aiRepair: { revision: 2, status: 'ready', provider: 'wasm', run: noop, release: noop },
    processNegativeInFlight: null, coreReprocessTimer: null, dustDetectionTimer: null, fullResolutionRenderTimer: null,
    corePreviewRetained: null, corePreviewCommit: null,
    pendingBrushRepairs: 0, brushRepairWaiters: [], dustMaskSources: new WeakMap(), fullResolutionConversionAbort: null,
    rememberRepairMasks: noop, clearRepairedPreview: noop,
    // A photo switch releases the comparison canvas (#242).
    comparisonReleases: 0, releaseBeforeAfterCanvas: () => { context.comparisonReleases++; },
    dustDrawing: false, undoStack: [], redoStack: [],
    coreReprocessGeneration: 3, coreReprocessToken: 4, dustDetectionRevision: 5,
    loadGeneration: 6, _coreReprocessPending: null, importDetectionAbort: null,
    fullResolutionRenderAbort: null, analyzeFrameInWorker: { abortReleases: 0 }, rewarmAutoFrameWorker: false,
    // #243: the prefetch slot, latest-wins activations and the background lanes.
    photoPrefetch: createPhotoSessionCache({ maxBytes: 4096 }), prefetchedItem: null,
    beginActivation: () => { context.activations.push(new AbortController()); return context.activations.at(-1).signal; },
    activations: [], notePhotoActivation: noop, activationDwell: async () => { context.dwells++; }, dwells: 0,
    sharedDecodeInFlight: () => false, adoptSharedDecode: () => null,
    kickBackgroundPhotoWork: noop, supersedeActivation: noop, releaseActivationClaim: noop,
    abortBackgroundDecodes: () => { context.backgroundAborts++; }, backgroundAborts: 0,
    studioThumbnailUpdateFrame: 0, cancelAnimationFrame: noop,
    studioThumbnailUpdateTimer: 0, clearTimeout: noop,
    exactSettingsKey, schedulePostPaintTask: task => postPaint.push(task),
    fileListRefreshDeferrals: 0, fileListRefreshDeferred: false, queueMicrotask,
    renderFileListUI: noop,
    coreReprocessBusy: () => false,
    // No GPU frame is ahead of its exact frame (#239).
    gpuPreviewScheduler: { busy: () => false },
    // #263: no reduced preview-tier session is open.
    previewTier: 'normal', displayIsReduced: () => false, resetPreviewTierForActivation: noop,
    captureSnapshot: () => ({ refs: {
      processedImageData: state.processedImageData,
      conversionSourceImageData: state.conversionSourceImageData,
    } }),
    currentConvertedPreviewSource: () => state.processedImageData,
    buildAdjustmentSettings: () => ({ curves: { r: new Uint8Array(256), g: new Uint8Array(256), b: new Uint8Array(256) } }),
    samplePhotoPreviewSource: source => ({ width: source.width, height: source.height, data: source.data.slice() }),
    adjustPhotoPreviewSample: sample => ({ ...sample, adjusted: true }),
    getDustSource: () => state.dustRemoval.cleanSource,
    dustBrushSource: converted, dustBrushToken: 4, dustBrushPoints: [{ x: 1, y: 1 }],
    dustBrushMode: 'direct', dustBrushTurn: Promise.resolve(),
    // #254: pointer events, the feedback overlay and the display overlay's tint.
    dustBrushPointerId: 1, releaseDustBrushPointer: noop, brushFeedback: { end: noop },
    displayOverlaySize: () => ({ width: 2, height: 2 }), patchDustTint: noop,
    pushUndo: noop, pushUndoDelta: (label, delta) => { context.deltas.push(delta); }, deltas: [],
    applyStrokePatch, showDustParticleCount: noop, refreshDustDisplay: noop, queueDustAiRefresh: noop,
    dustMaskTagSequence: 0, dustAiRefresh: { rects: [] }, unpinDustWorker: noop, dustPrivateClone: null,
    repairStamps: { forget: noop }, forgetDustMaskInfo: noop,
    setTimeout: callback => queueMicrotask(callback),
    ImageData: class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } },
    updateDustStatusUI: noop, updatePreview: noop, aiRepairReady: () => false,
    getLocalizedText: (key, fallback) => fallback,
    getInterpolatedText: (key, values, fallback) => fallback,
    applyDustResultToState: () => { state.processedImageData = state.dustRemoval.inpaintedImageData; },
    cancelPendingTimers: noop, cancelScheduledFullResolutionRender: noop, cancelGeometryJob: noop,
    hasPendingCropDetection: () => false, settlePendingCropDetection: async () => {},
    dropDetailLayer: noop,
    geometryDiagnostics: { coldSessions: false },
    getLoadingOverlay: () => ({ hide: noop }), noteCoreReprocessSettled: noop,
    assertRepairCurrent: valid => { if (!valid()) throw new DOMException('Superseded', 'AbortError'); },
    hiddenJobs: createHiddenJobGate({ isHidden: () => false }),
    // #249: no photo here takes a display form.
    ...displaySessionStubs(),
  });
  vm.runInContext([...DISPLAY_SESSION_HELPERS, 'photoSettingsKey', 'rememberPhotoSession', 'invalidatePhotoActivation',
    'cancelStudioThumbnailUpdate', 'isCurrentLoad', 'deferFileListRefresh', 'updateFileListUI',
    'refreshThumbnailStates', 'nextDustMaskTag', 'needsDustPrivateBuffer', 'installDustPrivateBuffer',
    'ensureDustPrivateBuffer', 'prepareDustPrivateBuffer', 'strokeDustOffMainThread',
    'commitDustStroke', 'onDustBrushEnd', 'noteBrushRepairSettled', 'whenBrushRepairsSettled',
    'abortSupersededFullResolutionConversion'].map(functionSource).join('\n'), context);
  const paint = () => { for (const task of postPaint.splice(0)) task(); };
  return { context, state, item, photoSessions, photoPreviews, thumbnailSources, watchRollSamples, base, converted, mask, element, postPaint, paint };
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
  c.strokeDustInWorker = (target, stroke) => {
    started++;
    assert.deepEqual(stroke.points, [{ x: 1, y: 1 }], 'only the stroke itself travels to the worker');
    return refinement.promise;
  };
  const pending = c.onDustBrushEnd({ pointerId: 1 });
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
  // The worker's patch covers the rect the stroke touched (here the frame).
  const rect = { x: 0, y: 0, width: 4, height: 4 };
  const patch = { rect, rgba8: new Uint8ClampedArray(64).fill(9), rgba16: new Uint16Array(64).fill(2313),
    maskRect: rect, maskBytes: new Uint8Array(16).fill(255), particleCount: 2, countBefore: 1 };
  if (outcome === 'abort') refinement.reject(new DOMException('Worker disposed', 'AbortError'));
  else refinement.resolve(patch);
  await pending;
  assert.equal(c.pendingBrushRepairs, 0, 'success, stale-result and rejection paths all release the pending count');
  await c.dustBrushTurn;
  assert.equal(state.dustRemoval.mask, f.mask, 'the mask is patched in place, never replaced');
  assert.deepEqual([...f.mask], Array(16).fill(outcome === 'success' ? 255 : 0));
  assert.notEqual(state.processedImageData, f.converted, 'patches go into a private copy, never the clean source');
  assert.deepEqual([...f.converted.data], Array(64).fill(0), 'the clean source is never patched');
  assert.deepEqual([...state.processedImageData.data], Array(64).fill(outcome === 'success' ? 9 : 0));
  assert.equal(c.deltas.length, outcome === 'success' ? 1 : 0, 'only a landed stroke enters history');
  if (outcome === 'success') {
    assert.equal(state.dustRemoval.particleCount, 2);
    c.rememberPhotoSession(item);
    assert.equal(photoSessions.peek(item).snapshot.refs.processedImageData, state.processedImageData);
    assert.equal(photoPreviews.size, 0, 'the click task does not adjust the presentation proxy');
    f.paint();
    assert.equal(photoPreviews.size, 1);
    assert.equal(photoPreviews.peek(item).key, c.photoSettingsKey(item));
    assert.equal(photoPreviews.peek(item).image.adjusted, true);
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
  let restored = 0, scheduled = 0, cancelledFrame = 0, clearedTimer = 0;
  const warmFeedback = [];
  Object.assign(c, {
    studioAutoFrameRunning: false, isDesktopBatchExportLocked: () => false,
    singleExportActive: false, getCurrentQueueItem: () => null,
    studioWorkspace: { sync: () => warmFeedback.push(f.state.photoSwitchTarget),
      flush: () => assert.fail('a warm cache hit leaves its syncs to one coalesced flush') },
    requestAnimationFrame: () => assert.fail('warm cache hit must not yield for loading feedback'),
    yieldToPaint: () => assert.fail('warm cache hit must not yield for loading feedback'),
    expiredAnalysisKey: null, lensMapCache: new Map(), invalidateSilverCoreCache: noop,
    studioThumbnailUpdateFrame: 19, cancelAnimationFrame: id => { cancelledFrame = id; },
    studioThumbnailUpdateTimer: 23, clearTimeout: id => { clearedTimer = id; },
    adoptStudioThumbnailInputs: noop,
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
    scheduleAiRepairPreloadForRecipe: () => { preloadChecks++; },
    cancelProvisionalFrame: noop,
    presentRetainedPreview: () => assert.fail('a warm restore shows no presentation image'),
    requestProvisionalFrame: () => assert.fail('a warm restore decodes no embedded preview'),
  });
  let preloadChecks = 0;
  vm.runInContext(functionSource('switchToFile'), c);
  await c.switchToFile(0);
  assert.equal(preloadChecks, 1, 'a restored recipe with repair strokes may preload MI-GAN on idle');
  assert.equal(restored, 1);
  assert.equal(c.comparisonReleases, 1, 'the switch releases the comparison canvas');
  assert.equal(scheduled, 1, 'a pending full render is resumed after warm preview restoration');
  assert.equal(cancelledFrame, 19, 'the outgoing thumbnail frame cannot write into the incoming photo');
  assert.equal(clearedTimer, 23, 'nor can its settle timer');
  assert.equal(c.studioThumbnailUpdateFrame, 0);
  assert.equal(c.studioThumbnailUpdateTimer, 0);
  assert.equal(f.state.loadedFile, f.item.file);
  assert.equal(f.photoSessions.size, 0, 'the active photo owns its buffers instead of retaining a cache alias');
  assert.ok(warmFeedback.length > 0 && warmFeedback.every(target => target == null),
    'warm restoration never announces a cold loading target');
}

function coldFixture({ presented = null } = {}) {
  const f = fixture(), c = f.context;
  const frames = [], loads = [], preparations = [], feedback = [], presentations = [], provisional = [], flushes = [];
  const second = { file: new File(['second'], 'second.png'), settings: null };
  const third = { file: new File(['third'], 'third.png'), settings: null };
  f.state.fileQueue.push(second, third);
  f.state.currentFileIndex = 0;
  Object.assign(c, {
    studioAutoFrameRunning: false, isDesktopBatchExportLocked: () => false,
    singleExportActive: false, getCurrentQueueItem: () => null,
    studioWorkspace: { sync: () => feedback.push({ target: f.state.photoSwitchTarget, phase: f.state.photoSwitchPhase }),
      flush: () => flushes.push({ target: f.state.photoSwitchTarget, syncs: feedback.length }) },
    requestAnimationFrame: callback => frames.push(callback), setTimeout: callback => callback(),
    // The shared paint-then-continue helper (yieldToPaint.js), visible branch.
    yieldToPaint: () => new Promise(resolve => c.requestAnimationFrame(() => c.setTimeout(resolve, 0))),
    resetZoomPan: noop, updateFileListUI: noop, loadStudioThumbnails: noop,
    showToast: noop,
    cancelProvisionalFrame: noop,
    presentRetainedPreview: item => {
      presentations.push({ item, target: f.state.photoSwitchTarget, frames: frames.length });
      return presented;
    },
    requestProvisionalFrame: item => provisional.push({ item, loads: loads.length }),
    loadFile: (file, options) => {
      assert.equal(options.quiet, true);
      const generation = ++c.loadGeneration;
      const gate = deferred();
      loads.push({ ...gate, file, options });
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
  return { ...f, second, third, frames, loads, preparations, feedback, presentations, provisional, flushes };
}
// #236: a photo left during its detection tail holds provisional settings.
// It is neither persisted nor snapshotted: its settings stay null (roll
// analysis or the next visit detects again) and only its decoded base is kept.
{
  const f = coldFixture(), c = f.context;
  vm.runInContext(functionSource('rememberPhotoBase'), c);
  f.item.settings = null;
  f.item.isDirty = true;
  f.item.provisional = { wasDirty: false };
  c.getCurrentQueueItem = () => f.item;
  c.persistCurrentFileSettings = () => assert.fail('a provisional photo is never persisted');
  c.rememberPhotoSession = () => assert.fail('nor snapshotted into a photo session');
  // With its base in the cache, its planes are released like any photo left
  // (#244); a failed switch takes it back from there.
  let releases = 0;
  const reactivated = [];
  c.releaseOutgoingPhotoPlanes = () => { releases++; };
  c.reactivateReleasedPhoto = item => { reactivated.push(item); return true; };
  const pending = c.switchToFile(1);
  assert.equal(f.item.settings, null);
  assert.equal(f.item.isDirty, false, 'the automatic WB of the provisional render is not kept');
  assert.equal(f.item.provisional, undefined);
  const entry = f.photoSessions.peek(f.item);
  assert.equal(entry.base, f.base, 'the decoded base is reusable on return');
  assert.equal(entry.snapshot, undefined, 'no provisional snapshot is restored as settled');
  f.frames.shift()(); await tick();
  assert.equal(releases, 1, 'the provisional photo\'s planes are released once its base is kept');
  f.loads[0].resolve({ status: 'stale' });
  await pending;
}

for (const outcome of ['success', 'load-error', 'prepare-error']) {
  const f = coldFixture(), c = f.context;
  let redraws = 0;
  c.updatePreview = () => { redraws++; };
  const pending = c.switchToFile(1);
  assert.equal(f.state.photoSwitchTarget, f.second, 'target feedback is set synchronously on click');
  assert.equal(f.state.photoSwitchPhase, 'loading');
  assert.equal(f.feedback.at(-1).target, f.second);
  assert.deepEqual(f.flushes, [{ target: f.second, syncs: f.feedback.length }],
    'the cold announcement is flushed in the click turn, right after its sync');
  assert.equal(f.loads.length, 0, 'decoding cannot begin before the feedback paint');
  assert.equal(f.frames.length, 1);
  assert.deepEqual(f.presentations.map(p => [p.item, p.target, p.frames]), [[f.second, f.second, 0]],
    'retained pixels are presented in the same task that shows the veil');
  assert.deepEqual(f.provisional.map(p => [p.item, p.loads]), [[f.second, 0]],
    'the embedded-preview job is posted before the container read');
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
    assert.equal(redraws, 0, 'presentation images live on the veil: a failed target has nothing to restore');
  }
}

// #243: latest wins. Each switch begins an activation (aborting the previous
// one), a cold target waits a short dwell before its file is read, and the
// load runs under the activation's signal.
{
  const f = coldFixture(), c = f.context;
  c.photoActivation = null;
  c.lowMemoryPhotoDevice = () => false;
  c.abortHalfSizeTileDecode = () => {};
  vm.runInContext(['supersedeActivation', 'beginActivation'].map(functionSource).join('\n'), c);
  const first = c.switchToFile(1);
  const firstSignal = c.photoActivation.signal;
  f.frames.shift()(); await tick();
  assert.equal(c.dwells, 1, 'a cold target waits the dwell');
  assert.equal(f.loads.length, 1);
  assert.equal(f.loads[0].options.signal, firstSignal, 'the load runs under the activation');
  // A second click supersedes the first while it decodes.
  const second = c.switchToFile(2);
  assert.equal(firstSignal.aborted, true, 'the superseded activation is aborted at once');
  assert.equal(firstSignal.reason.name, 'AbortError');
  assert.equal(c.photoActivation.signal.aborted, false);
  f.loads[0].resolve({ status: 'stale' });
  await first;
  assert.equal(f.second.status, undefined, 'a superseded target is never marked');
  f.frames.shift()(); await tick();
  assert.equal(f.loads[1].file, f.third.file);
  f.loads[1].resolve({ status: 'loaded' }); await tick();
  f.preparations[0].resolve(); await second;
  assert.equal(c.dwells, 2);
}
{
  // Aborted during the dwell: the file is never read.
  const f = coldFixture(), c = f.context;
  c.photoActivation = null;
  c.lowMemoryPhotoDevice = () => false;
  c.abortHalfSizeTileDecode = () => {};
  vm.runInContext(['supersedeActivation', 'beginActivation'].map(functionSource).join('\n'), c);
  let release;
  c.activationDwell = () => new Promise(resolve => { release = resolve; });
  const first = c.switchToFile(1);
  f.frames.shift()(); await tick();
  const second = c.switchToFile(2);
  release(); await first;
  assert.equal(f.loads.length, 0, 'a double click never reads the first target');
  f.frames.shift()(); await tick();
  release(); await tick();
  assert.equal(f.loads.length, 1);
  assert.equal(f.loads[0].file, f.third.file);
  f.loads[0].resolve({ status: 'loaded' }); await tick();
  f.preparations[0].resolve(); await second;
}
{
  // No dwell for a retained base, a lane decode in flight, or a prefetched
  // base; the prefetched base is taken from its slot and skips the decode.
  for (const kind of ['session', 'shared', 'prefetch']) {
    const f = coldFixture(), c = f.context;
    const base = image();
    if (kind === 'session') f.photoSessions.put(f.second, { file: f.second.file, base, rawMetadata: null });
    // The switch takes its lease on the lane's decode as it begins (R1-061)
    // and hands it to loadFile.
    const lease = { releases: 0, release() { this.releases++; } };
    if (kind === 'shared') {
      c.sharedDecodeInFlight = file => file === f.second.file;
      c.adoptSharedDecode = (file, { signal }) => {
        assert.equal(file, f.second.file);
        assert.equal(signal, c.activations.at(-1).signal, 'under the switch\'s activation');
        assert.equal(f.frames.length, 0, 'before the switch yields to paint');
        return lease;
      };
    }
    if (kind === 'prefetch') {
      c.photoPrefetch.put(f.second, { file: f.second.file, base, rawMetadata: { lensModel: 'x' } });
      c.prefetchedItem = f.second;
    }
    const pending = c.switchToFile(1);
    f.frames.shift()(); await tick();
    assert.equal(c.dwells, 0, `${kind}: no dwell`);
    if (kind !== 'shared') assert.equal(f.loads[0].options.decoded?.base, base, `${kind}: the decode is skipped`);
    if (kind === 'prefetch') {
      assert.equal(c.photoPrefetch.size, 0, 'taken from the slot');
      assert.equal(c.prefetchedItem, null);
      assert.deepEqual({ ...f.loads[0].options.decoded.rawMetadata }, { lensModel: 'x' }, 'with its rawMetadata');
    }
    if (kind === 'shared') assert.equal(f.loads[0].options.adoption, lease, 'loadFile adopts through the switch\'s lease');
    else assert.equal(f.loads[0].options.adoption, null, `${kind}: no lease beside a retained base`);
    f.loads[0].resolve({ status: 'loaded' }); await tick();
    f.preparations[0].resolve(); await pending;
    if (kind === 'shared') assert.equal(lease.releases, 1, 'and releases it after the load');
  }
}

{
  // An exact 1200 px copy is already on screen: no camera JPEG is decoded.
  const f = coldFixture({ presented: 'cached' }), c = f.context;
  const pending = c.switchToFile(1);
  assert.equal(f.presentations.length, 1);
  assert.equal(f.provisional.length, 0, 'a matching photoPreviews entry needs no embedded preview');
  f.frames.shift()(); await tick();
  f.loads[0].resolve({ status: 'loaded' }); await tick();
  f.preparations[0].resolve(); await pending;
}
{
  // A retained decoded base reaches the exact positive in ~0.3 s: no job.
  const f = coldFixture(), c = f.context;
  f.photoSessions.put(f.second, { file: f.second.file, base: image(), rawMetadata: null });
  const pending = c.switchToFile(1);
  assert.equal(f.presentations.length, 1);
  assert.equal(f.provisional.length, 0, 'a base-only session skips the embedded preview');
  f.frames.shift()(); await tick();
  f.loads[0].resolve({ status: 'error', message: 'x' }); await pending;
}
{
  // A thumbnail is only a stand-in: the embedded preview is still requested.
  const f = coldFixture({ presented: 'thumbnail' }), c = f.context;
  const pending = c.switchToFile(1);
  assert.equal(f.provisional.length, 1);
  f.frames.shift()(); await tick();
  f.loads[0].resolve({ status: 'error', message: 'x' }); await pending;
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

// The 1200 px proxy is adjusted after paint with the settings of the click,
// and is stored only for a photo that is still queued under the same key.
for (const change of ['none', 'removed', 'rekeyed', 'curve edited in place']) {
  const f = fixture(), c = f.context;
  const curves = { r: new Uint8Array(256).fill(1), g: new Uint8Array(256).fill(2), b: new Uint8Array(256).fill(3) };
  let adjusted = null;
  c.buildAdjustmentSettings = () => ({ curves, vibrance: 4 });
  c.adjustPhotoPreviewSample = (sample, adjustments) => { adjusted = adjustments; return { ...sample }; };
  c.rememberPhotoSession(f.item);
  assert.equal(f.postPaint.length, 1);
  if (change === 'removed') f.state.fileQueue.splice(0, 1);
  if (change === 'rekeyed') f.item.settings = { ...f.item.settings, cyan: 5 };
  if (change === 'curve edited in place') curves.r[0] = 99;
  f.paint();
  const stored = change === 'none' || change === 'curve edited in place';
  assert.equal(f.photoPreviews.size, stored ? 1 : 0, `${change}: proxy stored only for an unchanged queued photo`);
  if (stored) {
    assert.equal(f.photoPreviews.peek(f.item).key, c.photoSettingsKey(f.item));
    assert.equal(adjusted.curves.r[0], 1, 'the proxy uses the curves of the click, not later in-place edits');
    assert.notEqual(adjusted.curves.r, curves.r);
    assert.equal(adjusted.vibrance, 4);
  }
}

// One list refresh per click. Persisting the outgoing photo, restoring the
// incoming one and its tile each ask for one; a warm switch refreshes in its
// finally, a cold one before its feedback paints (then once more when done).
for (const warm of [true, false]) {
  const f = coldFixture(), c = f.context;
  const renders = [], syncs = [];
  let tiles = 0;
  Object.assign(c, {
    getCurrentQueueItem: () => f.state.fileQueue[f.state.currentFileIndex],
    persistCurrentFileSettings: () => { c.updateFileListUI(); c.refreshThumbnailStates(); c.updateFileListUI(); },
    rememberPhotoSession: () => { c.updateFileListUI(); },
    updateFileListUI: undefined, renderFileListUI: () => renders.push({ target: f.state.photoSwitchTarget, syncs: syncs.length }),
    studioWorkspace: { sync: () => syncs.push(renders.length), flush: noop },
    expiredAnalysisKey: null, lensMapCache: new Map(), invalidateSilverCoreCache: noop,
    restoreSnapshot: () => { c.updateFileListUI(); c.refreshThumbnailStates(); },
    applyZoomPanTransform: noop, updateUndoRedoButtons: noop, scheduleFullResolutionRender: noop,
    updateStudioThumbnail: () => { tiles++; c.updateFileListUI(); }, adoptStudioThumbnailInputs: noop,
  });
  vm.runInContext(functionSource('updateFileListUI'), c);
  if (warm) {
    f.photoSessions.put(f.second, { file: f.second.file, base: f.base, key: c.photoSettingsKey(f.second),
      snapshot: { refs: {} }, undo: [], redo: [], zoom: 1, panX: 0, panY: 0, previewOnly: false, fullResolutionPending: false });
  }
  const pending = c.switchToFile(1);
  assert.equal(c.fileListRefreshDeferrals, 0, 'the deferral closes within the click task');
  assert.equal(renders.length, 1, `${warm ? 'warm' : 'cold'} click refreshes the list once, synchronously`);
  if (warm) {
    await pending;
    assert.equal(tiles, 1);
    assert.equal(renders.length, 1);
  } else {
    assert.equal(renders[0].target, f.second, 'the cold refresh already carries the target');
    assert.equal(renders[0].syncs, 0, 'and lands before studioWorkspace.sync() marks it');
    assert.deepEqual(syncs, [1]);
    f.frames.shift()(); await tick();
    f.loads[0].resolve({ status: 'loaded' }); await tick();
    f.preparations[0].resolve();
    await pending;
    assert.equal(renders.length, 2, 'plus the one refresh when the cold switch completes');
  }
}
// A switch that throws before closing its deferral cannot leave the list frozen.
{
  const f = fixture(), c = f.context;
  let renders = 0;
  Object.assign(c, { renderFileListUI: () => { renders++; } });
  const close = c.deferFileListRefresh();
  c.updateFileListUI();
  assert.equal(renders, 0);
  await Promise.resolve();
  assert.equal(c.fileListRefreshDeferrals, 0);
  assert.equal(renders, 1, 'the end-of-task close flushes the pending refresh');
  close();
  assert.equal(renders, 1);
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
    hasBeforeAfterReference: () => Boolean(f.converted),
  });
  f.state.coreExposure = 20;
  f.state.cyan = 10;
  Object.assign(c, { isLargeImage: () => false, isAiBrushEnabled: () => false });
  vm.runInContext(['performUndo', 'performRedo', 'pushHistoryEntry', 'trimHistorySnapshot', 'consoleChannelsEnabled', 'consoleColorKeysEnabled',
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
    resetUserZoom: () => { zoomCalls++; }, toggleActualPixels: () => { zoomCalls++; },
  });
  const zoomStart = source.indexOf('    // Keyboard zoom shortcuts');
  const zoomEnd = source.indexOf('    // Undo/Redo keyboard shortcuts', zoomStart);
  vm.runInContext(source.slice(zoomStart, zoomEnd), c);
  for (const key of ['+', '-', '0', '1']) zoomKeydown({ key, preventDefault: noop });
  assert.equal(zoomCalls, 0, 'global zoom keys cannot change the cached outgoing view');

  delete c.document.body.dataset.photoSwitching;
  assert.equal(c.canActivateBeforeAfter(), true);
  c.performUndo(); c.performRedo();
  assert.equal(restored, 2, 'ordinary undo/redo resumes immediately after activation');
  c.nudgeConsoleChannel('density', 1);
  assert.equal(f.state.coreExposure, 30);
  assert.equal(consoleCommits, 1);
  for (const key of ['+', '-', '0', '1']) zoomKeydown({ key, preventDefault: noop });
  assert.equal(zoomCalls, 4, 'ordinary keyboard zoom (and 1:1) resumes without a sticky lock');
}

for (const locked of [false, true]) {
  const f = fixture(), c = f.context;
  c.rememberPhotoSession(f.item);
  f.paint();
  assert.ok(f.photoSessions.bytes > 0 && f.photoPreviews.bytes > 0);
  let pickerOpened = 0, emptyListRefreshes = 0, abandoned = 0;
  // A two-stage import's full decode goes with the session (#255).
  f.state.rawDecodePending = true;
  Object.assign(c, {
    abandonFullDecode: () => { abandoned++; f.state.fullDecode = null; f.state.provisional = null; f.state.rawDecodePending = false; },
    isDesktopBatchExportLocked: () => locked,
    clearDustState: noop, clearUndoHistory: noop, clearProjectRecovery: noop, cancelCropDetection: noop,
    exitCropMode: noop, exitBeforeAfter: noop, resetZoomPan: noop, supersedeSettledDisplay: noop,
    composeDisplaySprocketFrame: { clear: noop },
    sprocketPreviewFrameCache: { key: 'old', sourceRef: f.base, metrics: {} },
    sprocketPreviewFrameCanvas: { width: 100, height: 100 },
    // #253: the GL border background and the display overlay go with the photo.
    glBorderReleases: 0, releaseGlBorder: () => { c.glBorderReleases++; },
    overlayReleases: 0, releaseDisplayOverlay: () => { c.overlayReleases++; },
    // The comparison canvas holds the last reference drawn into it (#242).
    beforeAfterCanvas: { width: 100, height: 80, style: { display: 'block' } }, beforeAfterCanvasSource: f.converted,
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
    warmImportPipeline: () => { assert.equal(pickerOpened, 0, 'the import pipeline warms before the picker opens'); },
  });
  c.document.body.dataset = { studioBusy: 'true', photoSwitching: 'true' };
  f.state.photoSwitchTarget = f.item;
  f.state.photoSwitchPhase = 'loading';
  vm.runInContext(['clearCoreReprocessTimer', 'releaseCorePreviewRetained', 'releaseBeforeAfterCanvas', 'closePhotoSession'].map(functionSource).join('\n'), c);
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
    assert.equal(c.photoPrefetch.size, 0, 'and the prefetch slot');
    assert.equal(c.backgroundAborts, 1, 'the lanes\' decodes of the closed session stop');
    assert.equal(f.thumbnailSources.size, 0, 'close releases retained tile sources (#247)');
    assert.equal(f.watchRollSamples.bytes, 0, 'and kept watch-folder roll samples');
    assert.equal(f.state.loadedFile, null);
    assert.equal(f.state.loadedBaseImageData, null);
    assert.equal(abandoned, 1, 'a two-stage full decode is abandoned with the session');
    assert.equal(f.state.rawDecodePending, false);
    assert.equal(c.isCurrentLoad(oldGeneration), false);
    assert.ok(c.coreReprocessToken > oldToken);
    assert.equal(c.document.body.dataset.photoSwitching, undefined);
    assert.equal(c.document.body.dataset.studioBusy, undefined);
    assert.equal(f.state.photoSwitchTarget, null);
    assert.equal(f.state.photoSwitchPhase, null);
    assert.equal(c.sprocketPreviewFrameCache.sourceRef, null);
    assert.equal(c.sprocketPreviewFrameCanvas.width, 1);
    assert.equal(c.glBorderReleases, 1, 'close releases the GL border background (#253)');
    assert.equal(c.overlayReleases, 1, 'and the display overlay');
    assert.deepEqual([c.beforeAfterCanvas.width, c.beforeAfterCanvas.height], [1, 1], 'close releases the comparison canvas');
    assert.equal(c.beforeAfterCanvas.style.display, 'none');
    assert.equal(c.beforeAfterCanvasSource, null, 'and forgets its reference');
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
    localExposureGeometryFor: () => ({}), buildRepairMask: () => ({ mask: f.mask, bounds: null }),
    inpaintDustOffMainThread: async () => f.converted,
    noteAiRepairUsed: noop, aiRepairRunsInFlight: 0,
  });
  c.aiRepair = { ...c.aiRepair, source: '', sourceRef: null, prefer: '', released: false, error: '', percent: 0 };
  vm.runInContext(['performAiRepairModelLoad', 'inpaintForCommit', 'inpaintManualBrush',
    'releaseAiRepairSession', 'aiRepairLoadArgs', 'countAiRepairRun']
    .map(functionSource).join('\n'), c);
  // `loadAiRepairModel` wraps performAiRepairModelLoad in a single-flight loader.
  c.loadAiRepairModel = (...args) => c.performAiRepairModelLoad(...args);
  return f;
}

// Hidden-window shedding (#241): releasing the MI-GAN session keeps its
// revision (photo keys and thumbnails stay valid); the next on-demand load
// brings back the same model on the same provider, still under that revision.
{
  const f = aiFixture(), c = f.context;
  let released = 0, loads = [];
  c.fetchModelBytes = async (url) => { loads.push(url); return new Uint8Array(8); };
  c.createInpaintSessionInWorker = async (bytes, { prefer }) => ({ run: async () => ({}), release: async () => { released++; }, provider: prefer });
  await c.performAiRepairModelLoad('/picked-model.onnx', { refresh: false });
  const key = c.photoSettingsKey(f.item);
  const revision = c.aiRepair.revision;
  c.aiRepairRunsInFlight = 1;
  assert.equal(await c.releaseAiRepairSession(), false, 'a run in flight keeps the session');
  c.aiRepairRunsInFlight = 0;
  assert.equal(await c.releaseAiRepairSession(), true);
  assert.equal(released, 1);
  assert.equal(c.aiRepair.status, 'idle');
  assert.equal(c.aiRepair.run, null);
  assert.equal(c.aiRepair.revision, revision, 'release keeps the revision');
  assert.equal(c.photoSettingsKey(f.item), key, 'release keeps every photo key');
  assert.equal(JSON.stringify(c.aiRepairLoadArgs({ refresh: false })), JSON.stringify(['/picked-model.onnx', { refresh: false, prefer: 'wasm' }]),
    'an on-demand load asks for the released model on its provider');
  let calls = 0;
  c.inpaintWithModel = async () => { calls++; return { imageData: f.converted, tiles: 1 }; };
  f.state.dustRemoval.ai = true;
  assert.equal(await c.inpaintForCommit(f.converted, f.mask), f.converted);
  assert.equal(calls, 1, 'the commit path reloads the model on demand');
  assert.deepEqual(loads, ['/picked-model.onnx', '/picked-model.onnx']);
  assert.equal(c.aiRepair.status, 'ready');
  assert.equal(c.aiRepair.revision, revision, 'a same-provider reload keeps the revision');
  assert.equal(c.photoSettingsKey(f.item), key);
  assert.equal(c.aiRepairRunsInFlight, 0);
  assert.equal(await c.releaseAiRepairSession(), true);
  // A reload that lands on another provider changes the pixels, so it bumps.
  c.createInpaintSessionInWorker = async () => ({ run: async () => ({}), release: async () => {}, provider: 'webgpu' });
  await c.loadAiRepairModel(...c.aiRepairLoadArgs({ refresh: false }));
  assert.notEqual(c.aiRepair.revision, revision);
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

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createCoreReprocessGates, previewDispatchAction, CORE_FULL_REPROCESS_DELAY_MS } from './coreReprocessDispatcher.js';
import {
  routeCoreConversion, keepsFullPlaneOnDowngrade, fullResolutionIsStale,
  restoredFrameFlags, viewportRefreshBranch, repairsNeedSettling
} from './fullResolutionRouting.js';
import { isLargeImage } from './imageMemoryBudget.js';
import { poolRepairMask } from './repairedPreview.js';
import { DISABLED_GPU_PREVIEW_SCHEDULER } from './gpuPreviewScheduler.js';

// #237 in the app itself: the real routing, restore, viewport, Step-3 and
// export-barrier functions of main.js (extracted with vm, as
// restartRender.test.mjs does) against counting stand-ins for the three
// conversion clients and the dust worker. Replies are deferred and timers run
// only when a test says so.
const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `runtime function exists: ${name}`);
  const end = source.indexOf('\n    }', match.index);
  assert.ok(end > match.index, `runtime function closes: ${name}`);
  return source.slice(match.index, end + '\n    }'.length);
}
const settle = () => new Promise(setImmediate);
const noop = () => {};

function fakeClock() {
  let nextId = 1;
  const timers = new Map();
  return {
    timers,
    setTimeout: (callback, delay) => { const id = nextId++; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => { timers.delete(id); },
    delays: () => [...timers.values()].map(timer => timer.delay).sort((a, b) => a - b),
    run(delay) {
      for (const [id, timer] of [...timers]) {
        if (delay !== undefined && timer.delay !== delay) continue;
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

const LARGE = { width: 9536, height: 6336 };
const SMALL = { width: 4000, height: 2672 };

function fixture({ large = true, repairs = false, strokes = 0, aiBrush = false, separatePreview = true, size: sourceSize = null, target: previewSize = null } = {}) {
  const clock = fakeClock();
  const size = sourceSize || (large ? LARGE : SMALL);
  const target = previewSize || (large ? { width: 1809, height: 1202 } : { width: 1800, height: 1202 });
  const conversionSource = { ...size, name: 'conversion source' };
  const fullPlane = { ...size, name: 'full plane' };
  const shown = { ...target, name: 'shown preview' };
  const state = {
    conversionSourceImageData: conversionSource,
    conversionPreviewImageData: separatePreview ? { ...target, name: 'conversion preview' } : conversionSource,
    processedImageData: fullPlane, processedImageDataIsPreview: false, fullResolutionPending: false,
    previewSourceImageData: shown, histogramSourceImageData: { sampleOf: shown }, webglSourceImageData: shown,
    displayImageData: null, currentStep: 3, cropping: false, beforeAfterActive: false, zoomLevel: 1,
    sprocketPreviewEnabled: false, lastRenderQuality: 'gl', fullResolutionPromise: null,
    repairStrokes: Array.from({ length: strokes }, () => ({ size: 0.02, points: [{ x: 0.5, y: 0.5 }] })),
    dustRemoval: {
      enabled: repairs, processing: false, mask: repairs || strokes ? new Uint8Array(4) : null,
      inpaintedImageData: null, cleanSource: repairs || strokes ? fullPlane : null, particleCount: 0, _state: null,
    },
  };
  let displayTarget = { ...target };
  const log = [];
  const clients = { preview: [], shared: [], exact: [], mainThread: [] };
  const client = (kind) => (request) => new Promise((resolve, reject) => {
    clients[kind].push({ request, resolve, reject });
    log.push(`convert:${kind}`);
  });
  const resampled = [];
  const previewRepairs = [];
  // Each test tick is a new frame.
  const timeline = { currentTime: 0 };
  const context = vm.createContext({
    state, console: { error: noop, warn: noop, info: noop }, document: { timeline: null },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, AbortController,
    coreReprocessGates: createCoreReprocessGates({ setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
      requestAnimationFrame: () => 0, cancelAnimationFrame: noop, timeline, isHidden: () => false }),
    previewDispatchAction, CORE_FULL_REPROCESS_DELAY_MS,
    routeCoreConversion, keepsFullPlaneOnDowngrade, fullResolutionIsStale, restoredFrameFlags,
    viewportRefreshBranch, repairsNeedSettling, isLargeImage,
    FULL_RESOLUTION_IDLE_DELAY_MS: 2500, FULL_RESOLUTION_INTERACTIVE_DELAY_MS: 600, HISTOGRAM_MAX_SAMPLES: 1,
    WORKER_ABORTED: 'WORKER_ABORTED', CONVERSION_FAILED: 'CONVERSION_FAILED', WORKER_TIMEOUT: 'WORKER_TIMEOUT',
    CORE_RETAIN_PREVIEW_PLANE: true, CORE_PREVIEW_COMMIT_IDLE_MS: 150,
    corePreviewRetained: null, corePreviewCommit: null, corePreviewCommitWanted: false,
    corePreviewCommitTimer: null, corePreviewSettleWaiters: [],
    coreReprocessTimer: null, coreReprocessScheduled: null, coreReprocessToken: 5, coreReprocessGeneration: 2,
    _coreReprocessFullInFlight: false, _coreReprocessPreviewInFlight: false, _coreReprocessPending: null,
    _coreReprocessActive: 0, _coreReprocessIdle: null, _resolveCoreReprocessIdle: null,
    coreSliderCommitRecord: null, processNegativeInFlight: null,
    fullResolutionRenderTimer: null, fullUpdateTimer: null, displayPreviewResizeTimer: null,
    step2AutoConvertTimer: null, dustDetectionTimer: null, dustDetectionRevision: 1, dustPassCache: null,
    dustDetectionRun: null, dustMaskSources: new WeakMap(), pendingBrushRepairs: 0, brushRepairWaiters: [],
    fullResolutionConversionAbort: null, conversionWorkerBroken: false, conversionWorkerTimeouts: 0,
    webglState: { gl: {}, sourceDirty: false, curveDirty: false },
    // The three conversion clients and the main-thread fallback.
    convertPreviewFrameInWorker: client('preview'), convertFrameInWorker: client('shared'),
    convertFullResolutionFrameInWorker: client('exact'), convertFrameWithRouter: client('mainThread'),
    buildRouterSettings: () => ({}), getColorAnalysisSample: () => null,
    usesSilverCoreConversion: () => true,
    hasFrameRepairs: () => Boolean(state.dustRemoval.enabled || state.repairStrokes.length),
    isAiBrushEnabled: () => aiBrush,
    getDisplayPreviewSize: () => ({ ...displayTarget }),
    resizeDisplayPreview: (image, size) => {
      if (size.width >= image.width && size.height >= image.height) return image;
      resampled.push(image);
      return { ...size, name: `resampled ${image.name}` };
    },
    buildHistogramSourceImageData: image => ({ sampleOf: image }),
    initWebGLRenderer: () => true, isWebGLActive: () => true,
    setMainCanvasDimensions: (width, height) => log.push(`canvas:${width}x${height}`),
    getSprocketFrameMetrics: (width, height) => ({ outputWidth: width, outputHeight: height }),
    updatePreview: () => log.push('paint'), updateFull: () => log.push('paint:full'),
    schedulePreviewUpdate: () => log.push('paint:scheduled'),
    carryStudioThumbnailSource: noop, displayResizeReplaces: () => null, displayResizeOrigin: () => null,
    waitForNextFrame: () => Promise.resolve(),
    createPerfTrace: (label, details) => { log.push(`render:${details.reason}`); return { end: noop, mark: noop }; },
    getImageDataPixelCount: image => (image ? image.width * image.height : 0),
    // Phase 2: the preview-repair dust worker and the stroke mask builder.
    poolRepairMask, previewRepairWorker: {
      inpaint: (image, mask, radius) => new Promise(resolve => previewRepairs.push({ image, mask, radius, resolve })),
      dispose: noop,
    },
    buildRepairMask: (strokes, geometry) => {
      const mask = new Uint8Array(geometry.width * geometry.height);
      mask[10 * geometry.width + 20] = 255;
      return { mask, bounds: { x: 20, y: 10, width: 1, height: 1 } };
    },
    localExposureGeometryFor: () => ({}),
    repairedPreviewMasks: null, repairedPreview: null, repairedPreviewBuild: null, repairedPreviewShown: null,
    repairedPreviewTimer: null, REPAIRED_PREVIEW_IDLE_MS: 300,
    // #263: outside a reduced preview-tier session the preview is sized as before.
    previewTier: 'normal', previewTierKept: null, previewTierPrebuilt: null, reducedDisplayImages: new WeakSet(),
    previewTierController: { active: false }, schedulePreviewTierPrebuild: noop,
    // Integration-branch state these functions read: no provisional import
    // (#236), no pending geometry build (#244) and the dust bookkeeping of #259.
    getCurrentQueueItem: () => null, cancelGeometryJob: noop, whenGeometrySettled: noop,
    noteDustReplaced: noop, syncDustWorkerPin: noop,
    // No GPU preview (#239): these frames take the worker path.
    gpuPreviewScheduler: DISABLED_GPU_PREVIEW_SCHEDULER, gpuPreviewCanTake: () => false,
    runDustDetectionPass: () => {
      log.push('detect');
      state.dustRemoval.processing = true;
      return new Promise(resolve => {
        context.finishDetection = (mask = new Uint8Array(4)) => {
          state.dustRemoval.mask = mask;
          state.dustRemoval.processing = false;
          resolve();
        };
      });
    },
  });
  vm.runInContext([
    'isDisplayImageDataFullResolution', 'applyProcessedImageToState', 'applyPreviewProcessedImageToState',
    'applyRestoredImageToState', 'histogramSourceFor', 'buildPreviewSourceImageData',
    'convertFrameOffMainThread', 'convertFromCurrentSource',
    'routeCoreRequest', 'beginFullResolutionConversion', 'endFullResolutionConversion',
    'abortSupersededFullResolutionConversion', 'ensureAiBrushPlane',
    'coreReprocessBusy', 'whenCoreReprocessIdle', 'noteCoreReprocessSettled', 'runCoreReprocess',
    'resetDustForCleanSource', 'rerenderWithCoreControls', 'postPendingPreviewEarly',
    'retainCorePreviewPlane', 'armCorePreviewCommitTimer', 'releaseCorePreviewRetained',
    'requestCorePreviewCommit', 'maybeCommitCorePreviewPlane', 'settleCorePreviewWaiters',
    'hasSeparateConversionPreview', 'startFullResolutionRender', 'scheduleFullResolutionRender',
    'postponeFullResolutionRenderForInteraction', 'cancelScheduledFullResolutionRender',
    'ensureFullResolutionReadyForExport', 'scheduleCoreReprocess', 'takeScheduledCoreReprocess',
    'fireCoreReprocessGate', 'clearCoreReprocessTimer', 'flushScheduledCoreReprocess',
    'scheduleFullUpdate', 'scheduleDisplayPreviewResize', 'refreshDisplayPreviewForViewport',
    'scheduleDustDetection', 'runDustDetection', 'ensureRepairsReadyForExport', 'dustMaskIsStale',
    'whenBrushRepairsSettled', 'noteBrushRepairSettled', 'getDustSource', 'cancelPendingTimers',
    'trimHistorySnapshot', 'rememberRepairMasks', 'clearRepairedPreview', 'repairedPreviewMatches',
    'repairedPreviewSourceFor', 'ensureRepairedPreview', 'buildRepairedPreview', 'applyExactPlaneKeepingView',
    'scheduleRepairedPreviewAfterInput', 'clearFullResolutionRenderState', 'ensureConversionPreviewForDisplay', 'noteTierImage',
  ].map(functionSource).join('\n'), context);
  const reply = (kind, index = -1) => {
    const entry = clients[kind].at(index);
    const { imageData } = entry.request;
    entry.resolve({ width: imageData.width, height: imageData.height, name: `${kind} result` });
  };
  return { context, state, clock, log, clients, reply, resampled, fullPlane, shown, conversionSource, previewRepairs,
    setTarget: size => { displayTarget = size; }, nextFrame: () => { timeline.currentTime += 1000 / 60; } };
}
const count = (f) => Object.fromEntries(Object.entries(f.clients).map(([kind, list]) => [kind, list.length]));

// ---- A: one routing rule ----

for (const aiBrush of [false, true]) {
  // Above 16 MP an Undo/Reset/engine-control request converts the display
  // preview; with repairs and the AI brush off it drops the stale full plane.
  const f = fixture({ aiBrush });
  const done = f.context.rerenderWithCoreControls({ full: true });
  await settle();
  assert.deepEqual(count(f), { preview: 1, shared: 0, exact: 0, mainThread: 0 }, 'no full-resolution worker call');
  f.reply('preview');
  assert.equal(await done, true);
  if (aiBrush) {
    assert.equal(f.state.processedImageData, f.fullPlane, 'the AI brush keeps its plane');
    assert.equal(f.state.processedImageDataIsPreview, false);
  } else {
    assert.deepEqual([f.state.processedImageData.width, f.state.processedImageData.height], [1809, 1202],
      'processedImageData has getDisplayPreviewSize dimensions');
    assert.equal(f.state.processedImageDataIsPreview, true);
  }
  assert.equal(f.state.fullResolutionPending, true, 'export owes an exact render');
  assert.ok(f.log.includes('paint'));
  assert.ok(!f.log.some(entry => entry.startsWith('render:')), 'no full-resolution render is scheduled');
  assert.equal(f.clock.timers.size, 0, 'no scheduleFullUpdate or idle render');
  assert.deepEqual(f.resampled.filter(image => image === f.fullPlane), [], 'no resample of the full plane');
}

{
  // 16 MP or less keeps today's routing: the request converts in full.
  const f = fixture({ large: false });
  const done = f.context.rerenderWithCoreControls({ full: true });
  await settle();
  assert.deepEqual(count(f), { preview: 0, shared: 1, exact: 0, mainThread: 0 });
  assert.equal(f.clients.shared[0].request.options.forceFullProcess, true);
  f.reply('shared');
  assert.equal(await done, true);
  assert.equal(f.state.processedImageDataIsPreview, false);
  assert.equal(f.state.fullResolutionPending, false);
}

for (const [label, options] of [['dust', { repairs: true }], ['stroke', { strokes: 1 }]]) {
  // Repairs keep the plane (its mask and brushes work on it) and settle on
  // idle: the preview converts now, the exact pass waits.
  const f = fixture(options);
  const mask = f.state.dustRemoval.mask;
  const done = f.context.rerenderWithCoreControls({ full: true });
  await settle();
  assert.deepEqual(count(f), { preview: 1, shared: 0, exact: 0, mainThread: 0 }, label);
  f.reply('preview');
  assert.equal(await done, true);
  assert.equal(f.state.processedImageData, f.fullPlane, `${label}: plane kept`);
  assert.equal(f.state.dustRemoval.mask, mask, `${label}: mask kept until the idle pass`);
  assert.equal(f.state.fullResolutionPending, true);
  assert.deepEqual(f.clock.delays(), [2500], `${label}: one idle repair pass is armed`);
  f.clock.run(2500);
  await settle();
  assert.deepEqual(count(f), { preview: 1, shared: 0, exact: 1, mainThread: 0 }, `${label}: the idle pass is exact`);
  assert.ok(f.log.includes('render:repair-idle'));
  f.reply('exact');
  await settle(); await settle();
  assert.equal(f.state.processedImageDataIsPreview, false);
  assert.equal(f.state.fullResolutionPending, false);
  assert.equal(f.state.dustRemoval.mask, null, `${label}: the exact pass starts the repairs over`);
  assert.deepEqual(f.clock.delays(), [300], `${label}: detection follows once`);
}

{
  // A slider drag with dust on paints every tick and starts nothing at full
  // resolution while input continues; one exact pass and one detection follow
  // the last input after FULL_RESOLUTION_IDLE_DELAY_MS.
  const f = fixture({ repairs: true });
  f.context.dustDetectionTimer = f.clock.setTimeout(() => f.log.push('stale detection'), 300);
  for (let tick = 0; tick < 5; tick++) {
    f.nextFrame();
    f.context.scheduleCoreReprocess({ full: false });
    await Promise.resolve();
    await settle();
    assert.equal(f.clock.delays().includes(300), false, 'a tick cancels detection queued before the drag');
    f.reply('preview');
    await settle();
  }
  const paints = f.log.filter(entry => entry === 'paint').length;
  assert.equal(paints, 5, 'every tick paints');
  assert.deepEqual(count(f), { preview: 5, shared: 0, exact: 0, mainThread: 0 });
  assert.deepEqual(f.clock.delays(), [2500], 'only the idle pass is armed');
  f.clock.run(2500);
  await settle();
  f.reply('exact');
  await settle(); await settle();
  f.clock.run(300);
  await settle();
  assert.equal(f.log.filter(entry => entry === 'detect').length, 1, 'exactly one detection');
  assert.equal(count(f).exact, 1, 'exactly one full-resolution conversion');
  assert.ok(!f.log.includes('stale detection'));
}

{
  // A display-sized frame with repairs has no idle pass: it still converts in
  // full and re-runs detection, so the next export is cleaned at the new tone.
  const f = fixture({ large: false, repairs: true, separatePreview: false });
  f.setTarget({ ...SMALL });
  f.context.scheduleCoreReprocess({ full: false });
  await Promise.resolve();
  await settle();
  assert.deepEqual(count(f), { preview: 0, shared: 1, exact: 0, mainThread: 0 });
  f.reply('shared');
  await settle();
  assert.deepEqual(f.clock.delays(), [300], 'detection re-runs');
}

{
  // The pending slot keeps the caller's full/exact and is routed again; a
  // queued downgraded request does not make a finished preview frame drop.
  const f = fixture();
  const first = f.context.rerenderWithCoreControls({ full: false });
  await settle();
  f.context.coreReprocessToken += 1;
  assert.equal(await f.context.rerenderWithCoreControls({ full: true }), false, 'queued behind the preview');
  assert.equal(f.context._coreReprocessPending.full, true, 'the caller\'s full is stored');
  assert.equal(f.context._coreReprocessPending.exact, false);
  f.reply('preview');
  assert.equal(await first, true, 'the superseded frame is still shown: the queued request routes to the preview');
  await settle();
  assert.deepEqual(count(f), { preview: 2, shared: 0, exact: 0, mainThread: 0 }, 'the queued request converts the preview');
  f.reply('preview');
  await settle();
  assert.equal(f.context.coreReprocessBusy(), false);
}

// ---- A: restoreSnapshot ----

function snapshotFixture(options) {
  const f = fixture(options);
  Object.assign(f.context, {
    SNAPSHOT_SCALAR_KEYS: ['coreExposure', 'currentStep'],
    SNAPSHOT_REF_KEYS: ['processedImageData', 'conversionSourceImageData', 'conversionPreviewImageData',
      'previewSourceImageData', 'histogramSourceImageData', 'webglSourceImageData'],
    structuredClone, sanitizeRepairStrokes: strokes => strokes || [], sanitizeFrameMetadata: () => null,
    createSprocketEdgeSettings: () => null, carryRestoredRepairStamp: noop,
    updateMirrorButtonState: noop, updateFileListUI: noop, updateLensCorrectionUI: noop, updateFilmEdgeUI: noop,
    updateDodgeBurnUI: noop, updateLabMatchUI: noop, updateExpiredRescueUI: noop, updateMetadataUI: noop,
    updateFilmModeUI: noop, updateSlidersFromState: noop, renderCurve: noop, updateDustControlsVisibility: noop,
    updateSprocketControlsUI: noop, displayNegative: noop, updateCanvasVisibility: noop,
    goToStep: step => { f.state.currentStep = step; f.log.push('goToStep'); },
  });
  Object.assign(f.state, { coreExposure: 0, semanticMap: null, rollFrame: null, filmBase: null, cropRegion: null,
    curves: { r: null, g: null, b: null }, curvePoints: { r: [], g: [], b: [] }, sprocketEdge: null,
    lensCorrection: null, filmEdge: null, learnedDefaults: null, localExposure: null, look: null,
    expiredAnalysis: null, frameMetadata: null, autoFrame: { lastDiagnostics: null } });
  Object.assign(f.state.dustRemoval, { strength: 3, maxParticleSize: 40, brushSize: 5, showMask: false });
  vm.runInContext(['captureSnapshot', 'restoreSnapshot'].map(functionSource).join('\n'), f.context);
  return f;
}

{
  // Undo paints the restored display planes before the conversion starts,
  // never resamples the full plane, and puts both flags back.
  const f = snapshotFixture();
  const snapshot = f.context.captureSnapshot('coreExposure');
  assert.deepEqual({ ...snapshot.frame }, { previewOnly: false, fullResolutionPending: false });
  f.state.coreExposure = 30;
  f.state.previewSourceImageData = { width: 1809, height: 1202, name: 'newer preview' };
  f.state.fullResolutionPending = true;
  f.log.length = 0;
  f.context.restoreSnapshot(snapshot);
  assert.equal(f.state.coreExposure, 0);
  assert.equal(f.state.previewSourceImageData, f.shown, 'the captured display plane is back');
  assert.equal(f.context.webglState.sourceDirty, true);
  assert.equal(f.log.indexOf('paint'), f.log.findIndex(entry => entry.startsWith('canvas:')) + 1, 'painted right after the canvas is sized');
  assert.ok(f.log.indexOf('paint') < f.log.indexOf('convert:preview'), 'painted before the conversion starts');
  assert.deepEqual(f.resampled, [], 'no main-thread resample');
  await settle();
  assert.deepEqual(count(f), { preview: 1, shared: 0, exact: 0, mainThread: 0 }, 'one downgraded conversion');
  f.reply('preview');
  await settle();
  assert.equal(f.state.processedImageDataIsPreview, true);
  assert.equal(f.state.fullResolutionPending, true);
  assert.equal(f.context.coreReprocessBusy(), false);
}

{
  // A photo-session snapshot whose plane was swapped for the display preview
  // restores as a preview, whatever flags it was captured with; the next
  // export renders the original.
  const f = snapshotFixture();
  f.state.fullResolutionPending = true;
  const snapshot = f.context.captureSnapshot('photoSession');
  snapshot.refs.processedImageData = f.state.previewSourceImageData;
  snapshot.frame = { previewOnly: true, fullResolutionPending: true };
  f.context.restoreSnapshot(snapshot, { reprocess: false, previewOnly: true });
  assert.equal(f.state.processedImageDataIsPreview, true);
  assert.equal(f.state.fullResolutionPending, true);
  // Flags captured before the swap (a caller that forgot to update them)
  // still cannot restore a display-sized plane as full resolution.
  const stale = f.context.captureSnapshot('photoSession');
  stale.frame = { previewOnly: false, fullResolutionPending: false };
  f.context.restoreSnapshot(stale, { reprocess: false });
  assert.equal(f.state.processedImageDataIsPreview, true);
  const exporting = f.context.ensureFullResolutionReadyForExport();
  await settle();
  assert.deepEqual(count(f), { preview: 0, shared: 0, exact: 1, mainThread: 0 });
  assert.deepEqual([f.clients.exact[0].request.imageData.width, f.clients.exact[0].request.imageData.height],
    [LARGE.width, LARGE.height], 'the export converts the full source');
  f.reply('exact');
  await exporting;
  assert.equal(f.state.processedImageDataIsPreview, false);
  assert.equal(f.state.processedImageData.width, LARGE.width);
}

{
  // History above 16 MP without repairs keeps no full-resolution plane.
  const f = snapshotFixture();
  const trimmed = f.context.trimHistorySnapshot(f.context.captureSnapshot('coreExposure'));
  assert.equal(trimmed.refs.processedImageData, f.shown);
  assert.deepEqual({ ...trimmed.frame }, { previewOnly: true, fullResolutionPending: true });
  for (const options of [{ repairs: true }, { aiBrush: true }, { large: false }]) {
    const g = snapshotFixture(options);
    const kept = g.context.trimHistorySnapshot(g.context.captureSnapshot('coreExposure'));
    assert.equal(kept.refs.processedImageData, g.fullPlane, JSON.stringify(options));
  }
}

// ---- C: display-size changes refresh the display fields only ----

{
  // Branch 1, settled repairs: resample the display fields from the current
  // full plane. No conversion, no detection, token and mask untouched.
  const f = fixture({ repairs: true });
  const { mask } = f.state.dustRemoval;
  const inpainted = f.state.dustRemoval.inpaintedImageData = { ...LARGE, name: 'inpainted' };
  f.state.processedImageData = inpainted;
  const token = f.context.coreReprocessToken;
  for (const zoom of [2, 1]) {
    f.state.zoomLevel = zoom;
    f.setTarget(zoom === 2 ? { width: 2452, height: 1630 } : { width: 1809, height: 1202 });
    f.context.scheduleDisplayPreviewResize();
    f.clock.run(100);
    await settle();
  }
  assert.deepEqual(count(f), { preview: 0, shared: 0, exact: 0, mainThread: 0 }, '0 conversions');
  assert.equal(f.context.coreReprocessToken, token, 'token unchanged');
  assert.equal(f.state.dustRemoval.mask, mask, 'mask identity kept');
  assert.equal(f.state.dustRemoval.inpaintedImageData, inpainted);
  assert.equal(f.state.processedImageData, inpainted, 'the repaired image stays on screen');
  assert.equal(f.state.fullResolutionPending, false);
  assert.deepEqual(f.resampled, [inpainted, inpainted], 'one resample per size change');
  assert.equal(f.state.previewSourceImageData.width, 1809);
  assert.equal(f.clock.timers.size, 0, 'no detection or render queued');
  // The same size again: no repeated resample.
  f.context.scheduleDisplayPreviewResize();
  f.clock.run(100);
  assert.equal(f.resampled.length, 2);
}

{
  // Branch 1 after an export (no repairs): the second export reuses the plane.
  const f = fixture();
  f.state.zoomLevel = 2;
  f.setTarget({ width: 2452, height: 1630 });
  f.context.scheduleDisplayPreviewResize();
  f.clock.run(100);
  await f.context.ensureFullResolutionReadyForExport();
  assert.equal(f.state.processedImageData, f.fullPlane, 'same processedImageData object');
  assert.deepEqual(count(f), { preview: 0, shared: 0, exact: 0, mainThread: 0 });
  // A slider change right after the zoom still invalidates.
  f.context.scheduleCoreReprocess({ full: false });
  assert.equal(f.state.fullResolutionPending, true);
}

{
  // Branch 2: a repair pass is pending (or detection is running): the zoom
  // leaves it alone and restarts nothing.
  const f = fixture({ repairs: true });
  f.state.fullResolutionPending = true;
  f.context.scheduleFullResolutionRender('repair-idle');
  const token = f.context.coreReprocessToken;
  f.setTarget({ width: 2452, height: 1630 });
  f.context.refreshDisplayPreviewForViewport();
  assert.deepEqual(f.clock.delays(), [2500], 'the armed pass stands');
  assert.equal(f.context.coreReprocessToken, token);
  assert.deepEqual(count(f), { preview: 0, shared: 0, exact: 0, mainThread: 0 });
  assert.deepEqual(f.resampled, []);
}

{
  // Branch 3: a preview-only frame converts the preview again at the new
  // size without superseding anything; a request already held does it.
  const f = fixture();
  f.state.processedImageData = f.shown;
  f.state.processedImageDataIsPreview = true;
  f.state.fullResolutionPending = true;
  const token = f.context.coreReprocessToken;
  f.setTarget({ width: 2452, height: 1630 });
  f.context.refreshDisplayPreviewForViewport();
  assert.equal(f.context.coreReprocessToken, token, 'no token bump');
  await Promise.resolve();
  await settle();
  assert.deepEqual(count(f), { preview: 1, shared: 0, exact: 0, mainThread: 0 });
  assert.equal(f.clients.preview[0].request.imageData.width, 2452);
  f.reply('preview');
  await settle();
  assert.equal(f.state.previewSourceImageData.width, 2452);

  f.context.scheduleCoreReprocess({ full: true });
  const held = f.context.coreReprocessScheduled;
  f.setTarget({ width: 1809, height: 1202 });
  f.context.refreshDisplayPreviewForViewport();
  assert.equal(f.context.coreReprocessScheduled, held, 'a held full request is not turned into a preview');
}

// ---- D: Step-3 commits invalidate nothing ----

for (const large of [false, true]) {
  const f = fixture({ large });
  f.context.scheduleFullUpdate();
  f.clock.run(1200);
  await settle();
  assert.ok(!f.log.some(entry => entry.startsWith('render:')), 'no fullResolutionRender after a Step-3 commit');
  assert.equal(f.clock.timers.size, 0);
  assert.equal(f.state.fullResolutionPending, false, 'current pixels stay current');
  assert.deepEqual(f.log.filter(entry => entry === 'paint:full'), large ? [] : ['paint:full'],
    large ? 'above 16 MP no full-resolution Step-3 pass' : '16 MP or less redraws in full');
  // A core change still leaves export a render to do.
  f.context.scheduleCoreReprocess({ full: false });
  await Promise.resolve();
  await settle();
  f.reply('preview');
  await settle();
  assert.equal(f.state.fullResolutionPending, true);
  const exporting = f.context.ensureFullResolutionReadyForExport();
  await settle();
  assert.equal(count(f)[large ? 'exact' : 'shared'], 1, 'export re-converts after a core change');
}

// ---- B: the export waits for repairs ----

{
  // Detection queued on its debounce: export clears the timer and awaits one
  // detection run before it reads pixels.
  const f = fixture({ repairs: true });
  f.state.dustRemoval.mask = null;
  f.context.scheduleDustDetection();
  const order = [];
  const exporting = f.context.ensureFullResolutionReadyForExport()
    .then(() => { order.push('full'); return f.context.ensureRepairsReadyForExport(); })
    .then(() => order.push('repairs'));
  await settle();
  assert.equal(f.clock.timers.size, 0, 'the debounce is cleared');
  assert.deepEqual(f.log.filter(entry => entry === 'detect'), ['detect']);
  assert.deepEqual(order, ['full']);
  f.context.finishDetection();
  await exporting;
  assert.deepEqual(order, ['full', 'repairs']);

  // A detection already running is awaited, not restarted.
  f.state.dustRemoval.mask = null;
  const running = f.context.runDustDetection();
  const waiting = f.context.ensureRepairsReadyForExport();
  await settle();
  assert.equal(f.log.filter(entry => entry === 'detect').length, 2, 'no second run');
  f.context.finishDetection();
  await running; await waiting;

  // A brush repair in flight is awaited.
  f.context.pendingBrushRepairs = 1;
  let settled = false;
  const brushWait = f.context.ensureRepairsReadyForExport().then(() => { settled = true; });
  await settle();
  assert.equal(settled, false);
  f.context.noteBrushRepairSettled();
  await brushWait;
  assert.equal(settled, true);
}

// ---- B: superseded exact renders are aborted ----

{
  const f = fixture();
  f.state.fullResolutionPending = true;
  const render = f.context.startFullResolutionRender('export');
  await settle();
  const exact = f.clients.exact[0];
  assert.ok(exact.request.signal, 'the exact render carries an abort signal');
  assert.equal(exact.request.signal.aborted, false);
  f.context.scheduleCoreReprocess({ full: false });
  assert.equal(exact.request.signal.aborted, true, 'a settings change aborts it');
  const aborted = new Error('aborted');
  aborted.code = 'WORKER_ABORTED';
  exact.reject(aborted);
  await render;
  assert.equal(f.context.conversionWorkerBroken, false, 'an aborted worker is not a broken one');
  assert.equal(count(f).mainThread, 0, 'no main-thread fallback');
  assert.equal(f.state.fullResolutionPending, true);
  // Discarding the pipeline (a new photo, a crop) aborts the render too.
  await Promise.resolve();
  await settle();
  f.reply('preview');
  await settle();
  f.state.fullResolutionPending = true;
  void f.context.startFullResolutionRender('export');
  await settle();
  const discarded = f.clients.exact.at(-1);
  assert.notEqual(discarded, exact);
  f.context.clearFullResolutionRenderState();
  assert.equal(discarded.request.signal.aborted, true, 'a discarded pipeline aborts its exact render');
  // Below 16 MP the shared client stays in use and nothing is aborted.
  const g = fixture({ large: false });
  g.state.fullResolutionPending = true;
  void g.context.startFullResolutionRender('export');
  await settle();
  assert.equal(count(g).shared, 1);
  assert.equal(g.clients.shared[0].request.signal, null);
}

// ---- B, Phase 2: the repaired preview source ----

{
  // After a settled repair, preview ticks convert the display preview source
  // with the remembered masks filled; the exact pass keeps that view until
  // detection replaces it; the exact render and exports never read it.
  const f = fixture({ large: false, repairs: true, strokes: 1, size: { width: 800, height: 600 }, target: { width: 400, height: 300 } });
  const dustMask = new Uint8Array(800 * 600);
  dustMask[300 * 800 + 500] = 255;
  f.state.dustRemoval.mask = dustMask;
  f.context.rememberRepairMasks(f.fullPlane);
  assert.equal(f.previewRepairs.length, 0, 'pooling leaves the task that asked');
  f.clock.run(0);
  await settle();
  assert.equal(f.previewRepairs.length, 1);
  const { image: base, mask: pooled, radius } = f.previewRepairs[0];
  assert.equal(base, f.state.conversionPreviewImageData, 'the display preview source is filled');
  assert.equal(radius, 3);
  const expected = new Uint8Array(400 * 300);
  poolRepairMask(dustMask, 800, 600, expected, 400, 300);
  poolRepairMask((() => { const m = new Uint8Array(800 * 600); m[10 * 800 + 20] = 255; return m; })(), 800, 600, expected, 400, 300);
  assert.deepEqual([...pooled], [...expected], 'dust and stroke masks pooled to the preview size');
  const repaired = { width: 400, height: 300, name: 'repaired preview source' };
  f.previewRepairs[0].resolve(repaired);
  await settle();

  f.nextFrame();
  f.context.scheduleCoreReprocess({ full: false });
  await Promise.resolve();
  await settle();
  assert.equal(f.clients.preview.at(-1).request.imageData, repaired, 'a tick converts the repaired source');
  f.reply('preview');
  await settle();
  const shownFrame = f.state.previewSourceImageData;
  assert.equal(f.context.repairedPreviewShown, shownFrame);
  // The idle pass converts the real source and keeps the repaired view.
  f.log.length = 0;
  f.clock.run(2500);
  await settle();
  assert.equal(f.clients.shared.at(-1).request.imageData, f.conversionSource, 'the exact render reads the real source');
  f.reply('shared');
  await settle(); await settle();
  assert.equal(f.state.previewSourceImageData, shownFrame, 'the repaired preview stays on screen');
  assert.equal(f.state.processedImageData.name, 'shared result');
  assert.equal(f.state.processedImageDataIsPreview, false);
  assert.ok(!f.log.includes('paint:full'), 'no dusty full frame is drawn');
  assert.equal(f.state.dustRemoval.mask, null, 'detection starts over on the exact frame');
  // Ticks during the wait still fill the preview with the remembered masks.
  f.nextFrame();
  f.context.scheduleCoreReprocess({ full: false });
  await Promise.resolve();
  await settle();
  assert.equal(f.clients.preview.at(-1).request.imageData, repaired);
  f.reply('preview');
  await settle();
  // A display preview of another size is filled only once input pauses.
  f.setTarget({ width: 500, height: 375 });
  const builds = f.previewRepairs.length;
  for (let tick = 0; tick < 3; tick++) {
    f.nextFrame();
    f.context.scheduleCoreReprocess({ full: false });
    await Promise.resolve();
    await settle();
    assert.equal(f.clients.preview.at(-1).request.imageData, f.state.conversionPreviewImageData, 'the resized source is not filled yet');
    f.reply('preview');
    await settle();
  }
  assert.equal(f.previewRepairs.length, builds, 'no dust request while input continues');
  assert.ok(f.clock.delays().includes(300));
  f.clock.run(300);
  f.clock.run(0);
  await settle();
  assert.equal(f.previewRepairs.length, builds + 1, 'filled once input paused');
  assert.equal(f.previewRepairs.at(-1).image, f.state.conversionPreviewImageData);
  f.previewRepairs.at(-1).resolve({ width: 500, height: 375, name: 'repaired at the new size' });
  await settle();
  f.nextFrame();
  f.context.scheduleCoreReprocess({ full: false });
  await Promise.resolve();
  await settle();
  assert.equal(f.clients.preview.at(-1).request.imageData.name, 'repaired at the new size');
  f.reply('preview');
  await settle();
  // New strokes: the remembered masks no longer match, the plain source is used.
  f.state.repairStrokes = [...f.state.repairStrokes, { size: 0.02, points: [{ x: 0.2, y: 0.2 }] }];
  f.nextFrame();
  f.context.scheduleCoreReprocess({ full: false });
  await Promise.resolve();
  await settle();
  assert.equal(f.clients.preview.at(-1).request.imageData, f.state.conversionPreviewImageData);
  f.reply('preview');
  await settle();
  assert.equal(f.context.repairedPreviewShown, null);
  // Export after the repair pass renders from the real planes.
  assert.ok(f.clients.shared.every(entry => entry.request.imageData === f.conversionSource));
  f.context.clearRepairedPreview();
  assert.equal(f.context.repairedPreviewSourceFor(f.state.conversionPreviewImageData), null);
}

console.log('previewPathRouting: downgraded undo/reset routing, kept planes, idle repair pass, restore flags and paint, viewport branches, Step-3 gate, export repair waits, aborted exact renders and the repaired preview source passed');

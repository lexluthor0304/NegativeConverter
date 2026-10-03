import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createCoreReprocessGates, previewDispatchAction, CORE_FULL_REPROCESS_DELAY_MS } from './coreReprocessDispatcher.js';
import {
  routeCoreConversion, keepsFullPlaneOnDowngrade, fullResolutionIsStale,
  restoredFrameFlags, viewportRefreshBranch, repairsNeedSettling
} from './fullResolutionRouting.js';
import { isLargeImage } from './imageMemoryBudget.js';
import { poolRepairMask, repoolRepairMaskRect, countPooledCells } from './repairedPreview.js';
import { DISABLED_GPU_PREVIEW_SCHEDULER } from './gpuPreviewScheduler.js';
import { step3FrameReference } from './displayCanvas.js';
import { getSprocketFrameLayout } from './sprocketFrame.js';
import { displayTargetFor, isDisplayTarget, displaySizeServes, displayLevelGeometry, noteDisplayFilter, displayLevelFactor } from './displayPreview.js';
import { displaySessionStubs, DISPLAY_SESSION_HELPERS } from './displaySessionHarness.mjs';

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
// An event listener of main.js as a named function (its own `this`).
function listenerSource(id, name) {
  const anchor = source.indexOf(`getElementById('${id}')`);
  assert.ok(anchor >= 0, `listener exists: ${id}`);
  const head = /addEventListener\('\w+', (?:function \(\)|\(\) =>) \{/g;
  head.lastIndex = anchor;
  const match = head.exec(source);
  assert.ok(match && match.index - anchor < 80, `${id} has a listener`);
  const body = match.index + match[0].length;
  return `function ${name}() {${source.slice(body, source.indexOf('\n    });', body))}\n    }`;
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
    // #248: the conversion preview is a display target on the level (the
    // source itself stands in for its level here).
    conversionPreviewImageData: separatePreview ? displayTargetFor(conversionSource, target) : conversionSource,
    displayLevelImageData: conversionSource,
    processedImageData: fullPlane, processedImageDataIsPreview: false, fullResolutionPending: false,
    previewSourceImageData: shown, histogramSourceImageData: { sampleOf: shown }, webglSourceImageData: shown,
    displayImageData: null, currentStep: 3, cropping: false, beforeAfterActive: false, zoomLevel: 1,
    sprocketPreviewEnabled: false, fullResolutionPromise: null,
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
  const displayNegatives = [];
  const previewClient = Object.assign(client('preview'), {
    // #248: the preview worker's copy of a display target's negative.
    displayNegative: (frame) => {
      displayNegatives.push(frame);
      return Promise.resolve({ ...frame.display.target, name: 'display negative' });
    },
    resample: (image, size) => { resampled.push(image); return Promise.resolve({ ...size, name: `worker-resampled ${image.name}` }); },
  });
  const resampled = [];
  const previewRepairs = [];
  // Each test tick is a new frame.
  const timeline = { currentTime: 0 };
  const context = vm.createContext({
    // #249: no photo here takes a display form.
    ...displaySessionStubs(),
    // #254 stand-ins: the live dodge frame note, the dust tint, the overlays.
    noteLiveFrame: () => {}, adoptDustTint: () => {}, patchDustTint: () => {}, displayOverlaySize: () => null,
    syncBrushTools: () => {}, cancelDustBrush: () => {},
    brushFeedback: { drawing: false, end: () => {}, cancel: () => {}, sync: () => {} }, remapBrushStroke: () => {},
    liveDisplaySerial: 0,
    state, console: { error: noop, warn: noop, info: noop }, document: { timeline: null },
    // No two-stage stand-in (#255).
    provisionalUnits: () => false, ensureFullDecode: async () => true,
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
    convertPreviewFrameInWorker: previewClient, convertFrameInWorker: client('shared'),
    convertFullResolutionFrameInWorker: client('exact'), convertFrameWithRouter: client('mainThread'),
    // #256: the band pool only exists during a single export.
    exportBands: null,
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
    // #248: display previews of full frames are rebuilt off the input path.
    resizeDisplayPreviewInBands: async (image, size) => {
      resampled.push(image);
      return { ...size, name: `banded ${image.name}` };
    },
    displayTargetFor, isDisplayTarget, displaySizeServes, displayLevelGeometry, noteDisplayFilter, displayLevelFactor,
    displayPreviewRebuild: null, FULL_UPDATE_SETTLE_MS: 400,
    displayCounters: { mainResamples: 0, mainFullResamples: 0, prebuilt: 0, workerRebuilds: 0, bandedRebuilds: 0 },
    buildHistogramSourceImageData: image => ({ sampleOf: image }),
    initWebGLRenderer: () => true, isWebGLActive: () => true,
    // #242: new planes fit the CSS box only (`canvas:` drawn size < reference);
    // no backing is sized before a frame is presented.
    adjustCanvasDisplay: (width, height, reference) => log.push(`canvas:${width}x${height}<${reference ? `${reference.width}x${reference.height}` : 'own'}`),
    mainCanvasFit: { width: 0, height: 0, reference: null },
    step3FrameReference, getSprocketFrameLayout, getSprocketFrameComposeOptions: () => ({}),
    updatePreview: () => log.push('paint'), updateFull: () => log.push('paint:full'),
    renderHistogramForWebGL: (force) => log.push(`histogram:${force ? 'forced' : 'throttled'}`),
    refreshGlBorderSmear: () => log.push('smear'),
    schedulePreviewUpdate: () => log.push('paint:scheduled'),
    carryStudioThumbnailSource: noop, displayResizeReplaces: () => null, displayResizeOrigin: () => null,
    waitForNextFrame: () => Promise.resolve(),
    createPerfTrace: (label, details) => { log.push(`render:${details.reason}`); return { end: noop, mark: noop }; },
    getImageDataPixelCount: image => (image ? image.width * image.height : 0),
    // Phase 2: the preview-repair dust worker and the stroke mask builder.
    poolRepairMask, repoolRepairMaskRect, countPooledCells, previewRepairWorker: {
      inpaint: (image, mask, radius) => new Promise(resolve => previewRepairs.push({ image, mask: mask.slice(), radius, resolve })),
      // It keeps the image it filled last.
      holds: image => previewRepairs.at(-1)?.image === image, dispose: noop,
    },
    buildRepairMask: (strokes, geometry) => {
      const mask = new Uint8Array(geometry.width * geometry.height);
      mask[10 * geometry.width + 20] = 255;
      return { mask, bounds: { x: 20, y: 10, width: 1, height: 1 } };
    },
    localExposureGeometryFor: () => ({}),
    repairedPreviewMasks: null, repairedPreview: null, repairedPreviewBuild: null, repairedPreviewShown: null,
    repairedPreviewPool: null, repairedPreviewTimer: null, REPAIRED_PREVIEW_IDLE_MS: 300,
    // #263: outside a reduced preview-tier session the preview is sized as before.
    previewTier: 'normal', previewTierKept: null, previewTierPrebuilt: null, reducedDisplayImages: new WeakSet(),
    previewTierController: { active: false }, schedulePreviewTierPrebuild: noop,
    // Integration-branch state these functions read: no provisional import
    // (#236), no pending geometry build (#244) and the dust bookkeeping of #259.
    getCurrentQueueItem: () => null, cancelGeometryJob: noop, whenGeometrySettled: noop,
    // No pending crop-area detection (#245).
    cropDetection: null, cancelCropDetection: noop, settlePendingCropDetection: async () => {},
    // The background lanes' gate (#243).
    backgroundGate: { bump: noop },
    noteDustReplaced: noop, syncDustWorkerPin: noop,
    // No undo or redo restored a dust state here (#259).
    restoredDust: null,
    // No GPU preview (#239): these frames take the worker path.
    gpuPreviewScheduler: DISABLED_GPU_PREVIEW_SCHEDULER, gpuPreviewCanTake: () => false, gpuPreview: { status: 'none' },
    GPU_PREVIEW_MODE: 'auto', gpuApplyUsable: () => false,
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
    ...DISPLAY_SESSION_HELPERS,
    'applyProcessedImageToState', 'applyPreviewProcessedImageToState',
    'fitStep3CanvasBox', 'setMainCanvasBox', 'displaySourceImageData', 'sprocketFrameSize', 'sprocketFrameReference',
    'applyRestoredImageToState', 'histogramSourceFor', 'buildPreviewSourceImageData',
    'convertFrameOffMainThread', 'convertFromCurrentSource',
    'routeCoreRequest', 'beginFullResolutionConversion', 'endFullResolutionConversion',
    'abortSupersededFullResolutionConversion', 'ensureAiBrushPlane',
    'coreReprocessBusy', 'whenCoreReprocessIdle', 'noteCoreReprocessSettled', 'runCoreReprocess',
    'resetDustForCleanSource', 'takeRestoredDust', 'restoredDustInputsHold', 'rerenderWithCoreControls', 'postPendingPreviewEarly',
    'retainCorePreviewPlane', 'armCorePreviewCommitTimer', 'releaseCorePreviewRetained',
    'requestCorePreviewCommit', 'maybeCommitCorePreviewPlane', 'settleCorePreviewWaiters',
    'retainingPreviewComing', 'corePreviewQueued',
    'hasSeparateConversionPreview', 'startFullResolutionRender', 'scheduleFullResolutionRender',
    'postponeFullResolutionRenderForInteraction', 'cancelScheduledFullResolutionRender',
    'ensureFullResolutionReadyForExport', 'scheduleCoreReprocess', 'takeScheduledCoreReprocess',
    'fireCoreReprocessGate', 'clearCoreReprocessTimer', 'flushScheduledCoreReprocess',
    'scheduleFullUpdate', 'scheduleDisplayPreviewResize', 'refreshDisplayPreviewForViewport',
    'scheduleDustDetection', 'runDustDetection', 'ensureRepairsReadyForExport', 'dustMaskIsStale',
    'whenBrushRepairsSettled', 'noteBrushRepairSettled', 'getDustSource', 'cancelPendingTimers',
    'trimHistorySnapshot', 'rememberRepairMasks', 'clearRepairedPreview', 'repairedPreviewMatches',
    'repairedPreviewSourceFor', 'ensureRepairedPreview', 'buildRepairedPreview', 'applyExactPlaneKeepingView',
    'poolRepairStroke', 'repairedPreviewBaseFor', 'currentRepairPool',
    'scheduleRepairedPreviewAfterInput', 'clearFullResolutionRenderState', 'ensureConversionPreviewForDisplay', 'noteTierImage',
    'previewRequestImage', 'convertRequestOnMain', 'installDisplayFor', 'installDisplayPreview', 'cancelDisplayPreviewRebuild',
    'rebuildDisplayPreview', 'captureSnapshotWithPendingDisplay', 'countMainResample', 'updateConversionTarget', 'conversionTargetFor',
  ].map(functionSource).join('\n'), context);
  // A result has the size the request converts at: its display target, or
  // the image it sent.
  const reply = (kind, index = -1) => {
    const entry = clients[kind].at(index);
    const { imageData, display } = entry.request;
    const size = display ? display.target : imageData;
    entry.resolve({ width: size.width, height: size.height, name: `${kind} result` });
  };
  return { context, state, clock, log, clients, reply, resampled, fullPlane, shown, conversionSource, previewRepairs, displayNegatives,
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
    // These snapshots' dust states are not kept across a conversion (#259).
    dustStateSettled: () => false,
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
  vm.runInContext([...DISPLAY_SESSION_HELPERS, 'captureSnapshot', 'restoreSnapshot'].map(functionSource).join('\n'), f.context);
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
  assert.ok(f.log.includes('canvas:1809x1202<9536x6336'), 'the box: the display plane fitted to the full frame');
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
  // Branch 1 in a CPU mode (#242): #canvas holds the display preview, not the
  // full frame, so a new size is drawn once it is rebuilt (#248), then settled
  // with the exact colour model; above 16 MP that settle is the display-size one.
  const f = fixture();
  f.context.isWebGLActive = () => false;
  f.context.renderSettledDisplay = () => f.log.push('paint:settled');
  f.log.length = 0;
  f.setTarget({ width: 2452, height: 1630 });
  f.context.refreshDisplayPreviewForViewport();
  assert.deepEqual(f.log.filter(entry => entry.startsWith('paint')), [], 'nothing drawn before the rebuild lands');
  await settle();
  assert.equal(f.state.previewSourceImageData.width, 2452);
  assert.deepEqual(f.log.filter(entry => entry.startsWith('paint')), ['paint:scheduled']);
  f.clock.run(f.context.FULL_UPDATE_SETTLE_MS);
  await settle();
  assert.deepEqual(f.log.filter(entry => entry.startsWith('paint')), ['paint:scheduled', 'paint:settled']);
  assert.deepEqual(count(f), { preview: 0, shared: 0, exact: 0, mainThread: 0 }, 'no conversion');
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
  // #248: the level goes (the worker's cached source), with the new size.
  assert.equal(f.clients.preview[0].request.imageData, f.conversionSource);
  assert.equal(f.clients.preview[0].request.display.target.width, 2452);
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

for (const armed of [false, true]) {
  // #242 A.5: a CPU mode above 16 MP settles its display preview with the
  // exact colour model after a commit, unless a full-resolution render is
  // armed and will land (and settle) anyway. GL modes draw nothing more.
  const f = fixture({ large: true });
  f.context.isWebGLActive = () => false;
  f.context.renderSettledDisplay = () => f.log.push('paint:settled');
  if (armed) f.context.fullResolutionRenderTimer = 99;
  f.context.scheduleFullUpdate();
  f.clock.run(f.context.FULL_UPDATE_SETTLE_MS);
  await settle();
  assert.deepEqual(f.log.filter(entry => entry.startsWith('paint')), armed ? [] : ['paint:settled'],
    armed ? 'the armed render settles it' : 'settled at display size, off this thread');
  assert.ok(!f.log.some(entry => entry.startsWith('render:')), 'no full-resolution render for a Step-3 commit');
}

for (const large of [false, true]) {
  const f = fixture({ large });
  f.context.scheduleFullUpdate();
  f.clock.run(400);
  await settle();
  assert.ok(!f.log.some(entry => entry.startsWith('render:')), 'no fullResolutionRender after a Step-3 commit');
  // #253: above 16 MP the GL display settles its histogram (and a border's
  // smear) here, since updateFull does not run.
  if (large) assert.deepEqual(f.log.filter(entry => entry === 'histogram:forced' || entry === 'smear'), ['histogram:forced', 'smear']);
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

// ---- B: both export entry points wait for repairs (R1-042) ----

for (const entry of ['prepareCurrentImageForExport', 'getCurrentExportImageData']) {
  // A detection waiting on its debounce when an export starts: the prepare
  // step (full resolution plus repairs) and the adjust step each run it, and
  // read no pixel until it has repaired the frame.
  const f = fixture({ repairs: true });
  const adjusted = [];
  Object.assign(f.context, {
    applyAdjustmentsWithSettings: async (image, settings, options = {}) => { adjusted.push(image); return image; },
    // TELEA dust removal and no strokes: once detection has settled, the
    // prepare step has no repair of its own to run.
    aiRepair: { status: 'ready', revision: 1 }, noteGeometryPixelRead: noop,
    // The adjust step marks the planes the editor patches in place (the
    // export lane's ownership check); nothing is patched in place here.
    markInPlaceEditedPlanes: noop,
  });
  vm.runInContext(functionSource(entry), f.context);
  f.state.dustRemoval.mask = null;
  f.context.scheduleDustDetection();
  let done = false;
  const exporting = f.context[entry]().then(() => { done = true; });
  await settle();
  assert.deepEqual(f.log.filter(item => item === 'detect'), ['detect'], `${entry}: runs the detection`);
  assert.equal(f.clock.timers.size, 0, `${entry}: in place of its debounce`);
  assert.equal(done, false, `${entry}: and waits for it`);
  assert.deepEqual(adjusted, [], `${entry}: no pixel is read before`);
  const repaired = { ...LARGE, name: 'repaired plane' };
  f.state.processedImageData = repaired;
  f.context.finishDetection();
  await exporting;
  if (entry === 'getCurrentExportImageData') assert.deepEqual(adjusted, [repaired], 'the repaired frame is exported');
}

// ---- B: a cleared mask or cleared strokes in the idle window (R1-041) ----

// The Clear handlers of the dust brush and the AI brush, and the photo
// session's settled test, against the fixture.
function clearFixture(options) {
  const f = fixture(options);
  const stored = [];
  const item = { file: 'photo' };
  Object.assign(f.state, { loadedFile: 'photo', loadedBaseImageData: f.conversionSource, rawDecodePending: false,
    fileQueue: [item], zoomLevel: 1, panX: 0, panY: 0, filmEdge: null });
  Object.assign(f.context, {
    unpinDustWorker: noop, disposeDustWorker: noop, updateDustStatusUI: noop, getLocalizedText: (key, text) => text,
    dustRefreshRepairMask: null, pushUndo: noop, markCurrentFileDirty: noop,
    hiddenJobs: { safeMode: false }, geometryDiagnostics: { coldSessions: false }, dustAiRefresh: { rects: [] },
    dustDrawing: false, undoStack: [], redoStack: [], photoSettingsKey: () => 'key',
    captureSnapshot: () => ({ refs: { processedImageData: f.state.processedImageData } }),
    photoSessions: { put: (key, entry) => { stored.push(entry); return true; } },
    photoPreviews: { put: () => true }, currentConvertedPreviewSource: () => null,
    buildAdjustmentSettings: () => ({ curves: { r: new Uint8Array(256), g: new Uint8Array(256), b: new Uint8Array(256) } }),
    samplePhotoPreviewSource: () => ({}), adjustPhotoPreviewSample: () => ({}), schedulePostPaintTask: noop,
  });
  vm.runInContext(['clearDustState', 'rememberPhotoSession', 'displayIsReduced'].map(functionSource).join('\n') + '\n'
    + listenerSource('dustClearMaskBtn', 'clearDustMask') + '\n' + listenerSource('aiBrushClear', 'clearAiBrushStrokes'), f.context);
  const remember = () => { f.context.rememberPhotoSession(item); return stored.at(-1); };
  const tick = async () => {
    f.nextFrame();
    f.context.scheduleCoreReprocess({ full: false });
    await Promise.resolve();
    await settle();
    f.reply('preview');
    await settle();
  };
  return { ...f, remember, tick };
}

{
  // Dust on: a tick keeps the plane for the brushes until the idle pass. The
  // kept plane waiting for its render is no settled view, and Clear mask
  // puts its clean source back without making it current (5f23eb0 cleared
  // fullResolutionPending: an export, and the photo session, took the
  // previous exposure). Export renders it again, once.
  const f = clearFixture({ repairs: true });
  assert.ok(f.remember().snapshot, 'settled before the tick');
  await f.tick();
  assert.equal(f.state.processedImageData, f.fullPlane, 'the plane is kept for the brushes');
  assert.equal(f.state.processedImageDataIsPreview, false);
  assert.deepEqual(f.clock.delays(), [2500], 'the idle repair pass is armed');
  assert.equal(f.remember().snapshot, null, 'a photo session left in the idle window stores no settled view');
  f.context.clearDustMask();
  assert.equal(f.state.processedImageData, f.fullPlane, 'Clear mask puts the clean source back');
  assert.equal(f.state.dustRemoval.mask, null);
  assert.equal(f.state.fullResolutionPending, true, 'which still lags its settings');
  assert.equal(fullResolutionIsStale(f.state), true);
  assert.deepEqual(f.clock.delays(), [300, 2500], 'detection is queued; the idle pass stands');
  const exporting = f.context.ensureFullResolutionReadyForExport();
  await settle();
  assert.deepEqual(count(f), { preview: 1, shared: 0, exact: 1, mainThread: 0 }, 'export renders the plane again, once');
  f.reply('exact');
  await exporting;
  assert.equal(f.state.processedImageData.name, 'exact result');
  assert.equal(f.state.fullResolutionPending, false);
  assert.deepEqual(f.clock.delays(), [300], 'the export took the idle pass over; detection follows the new plane');
}

{
  // AI-brush strokes only: Clear in the idle window. Nothing is detected, so
  // the idle pass is what renders the kept plane again; until it lands a
  // photo session stores no settled view (5f23eb0 stored the previous
  // exposure as settled and exported it after the return).
  const f = clearFixture({ strokes: 1 });
  await f.tick();
  f.context.clearAiBrushStrokes();
  assert.equal(f.state.repairStrokes.length, 0);
  assert.equal(f.state.processedImageData, f.fullPlane);
  assert.equal(f.state.fullResolutionPending, true, 'the kept plane still lags its settings');
  assert.deepEqual(f.clock.delays(), [2500], 'no detection without dust removal; the idle pass stands');
  assert.equal(f.remember().snapshot, null, 'no settled view while it waits');
  f.clock.run(2500);
  await settle();
  assert.equal(count(f).exact, 1, 'the idle pass renders it');
  f.reply('exact');
  await settle(); await settle();
  assert.equal(f.state.processedImageData.name, 'exact result');
  assert.equal(f.state.fullResolutionPending, false);
  const entry = f.remember();
  assert.equal(entry.snapshot.refs.processedImageData.name, 'exact result', 'settled on the new plane');
  assert.equal(entry.fullResolutionPending, false);
}

{
  // A cleared mask on a settled frame changes no flag: the clean source is
  // current, and export reuses it.
  const f = clearFixture({ repairs: true });
  f.context.clearDustMask();
  assert.equal(f.state.processedImageData, f.fullPlane);
  assert.equal(f.state.fullResolutionPending, false);
  await f.context.ensureFullResolutionReadyForExport();
  assert.deepEqual(count(f), { preview: 0, shared: 0, exact: 0, mainThread: 0 });
}

for (const large of [false, true]) {
  // A display preview waiting for its render (a photo just opened, with dust
  // removal on above 16 MP) is a settled view: the session keeps it as the
  // preview it is, and the restore arms the render again.
  const f = clearFixture({ large, repairs: large });
  Object.assign(f.state, { processedImageData: f.shown, processedImageDataIsPreview: true, fullResolutionPending: true });
  f.state.dustRemoval.mask = null;
  f.state.dustRemoval.cleanSource = null;
  f.context.scheduleFullResolutionRender('initial-preview');
  assert.deepEqual(f.clock.delays(), [2500]);
  const entry = f.remember();
  assert.ok(entry.snapshot, 'stored as a settled view');
  assert.equal(entry.snapshot.refs.processedImageData, f.shown);
  assert.equal(entry.previewOnly, true);
  assert.equal(entry.fullResolutionPending, true);
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
  // Below 16 MP the shared client stays in use and a settings change aborts
  // nothing: the request carries only the photo activation's signal (#243).
  const g = fixture({ large: false });
  g.state.fullResolutionPending = true;
  void g.context.startFullResolutionRender('export');
  await settle();
  assert.equal(count(g).shared, 1);
  const sharedSignal = g.clients.shared[0].request.signal;
  assert.equal(sharedSignal, g.context.fullResolutionRenderAbort.signal);
  g.context.scheduleCoreReprocess({ full: false });
  assert.equal(sharedSignal.aborted, false, 'a settings change does not abort it');
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
  // #248: main holds no display negative; the preview worker sends its copy.
  assert.equal(f.displayNegatives.length, 1);
  assert.equal(f.displayNegatives[0].imageData, f.conversionSource);
  assert.deepEqual({ ...f.displayNegatives[0].display.target }, { width: 400, height: 300 });
  assert.equal(base.name, 'display negative', 'the display preview source is filled');
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
  // A display preview of another size (the settle hook moved the target,
  // #248) is filled only once input pauses.
  f.setTarget({ width: 500, height: 375 });
  const target = f.context.conversionTargetFor(f.conversionSource, f.conversionSource, 'normal');
  f.state.conversionPreviewImageData = target;
  const builds = f.previewRepairs.length;
  for (let tick = 0; tick < 3; tick++) {
    f.nextFrame();
    f.context.scheduleCoreReprocess({ full: false });
    await Promise.resolve();
    await settle();
    const { request } = f.clients.preview.at(-1);
    assert.ok(request.imageData === f.conversionSource && request.display.target.width === 500, 'the resized source is not filled yet');
    f.reply('preview');
    await settle();
  }
  assert.equal(f.previewRepairs.length, builds, 'no dust request while input continues');
  assert.ok(f.clock.delays().includes(300));
  f.clock.run(300);
  f.clock.run(0);
  await settle();
  assert.equal(f.previewRepairs.length, builds + 1, 'filled once input paused');
  assert.deepEqual({ ...f.displayNegatives.at(-1).display.target }, { width: 500, height: 375 });
  assert.equal(f.previewRepairs.at(-1).image.width, 500);
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
  assert.equal(f.clients.preview.at(-1).request.imageData, f.conversionSource);
  assert.equal(f.clients.preview.at(-1).request.display.target.width, 500);
  f.reply('preview');
  await settle();
  assert.equal(f.context.repairedPreviewShown, null);
  // Export after the repair pass renders from the real planes.
  assert.ok(f.clients.shared.every(entry => entry.request.imageData === f.conversionSource));
  f.context.clearRepairedPreview();
  assert.equal(f.context.repairedPreviewSourceFor(f.state.conversionPreviewImageData), null);
}

// ---- #229 review R1-104: a dust stroke's fill waits for input to pause and
// is made from the display negative the preview repair worker kept, with the
// stroke's box pooled into the kept masks ----
{
  const f = fixture({ large: false, repairs: true, size: { width: 800, height: 600 }, target: { width: 400, height: 300 } });
  const dustMask = new Uint8Array(800 * 600);
  dustMask[300 * 800 + 500] = 255;
  f.state.dustRemoval.mask = dustMask;
  f.state.dustRemoval.revision = 1;
  f.context.rememberRepairMasks(f.fullPlane);
  f.clock.run(0);
  await settle();
  assert.equal(f.displayNegatives.length, 1);
  f.previewRepairs[0].resolve({ width: 400, height: 300, name: 'first fill' });
  await settle();
  // The stroke patched the mask in place and moved its revision (#259).
  dustMask[100 * 800 + 120] = 255;
  f.state.dustRemoval.revision += 1;
  f.context.rememberRepairMasks(f.fullPlane, { x: 120, y: 100, width: 1, height: 1 });
  assert.equal(f.previewRepairs.length, 1, 'the stroke itself fills nothing');
  assert.ok(f.clock.delays().includes(300));
  // A drag right after it converts the last fill, and every tick postpones
  // the new one: no dust request while input continues.
  for (let tick = 0; tick < 3; tick++) {
    const armed = f.context.repairedPreviewTimer;
    f.nextFrame();
    f.context.scheduleCoreReprocess({ full: false });
    await Promise.resolve();
    await settle();
    assert.equal(f.clients.preview.at(-1).request.imageData.name, 'first fill', 'the drag converts the last fill');
    assert.ok(f.context.repairedPreviewTimer && f.context.repairedPreviewTimer !== armed, 'the tick postpones the stroke\'s fill');
    f.reply('preview');
    await settle();
  }
  assert.equal(f.previewRepairs.length, 1);
  f.clock.run(300);
  f.clock.run(0);
  await settle();
  assert.equal(f.previewRepairs.length, 2, 'filled once input paused');
  assert.equal(f.displayNegatives.length, 1, 'no display negative asked again');
  assert.equal(f.previewRepairs[1].image, f.previewRepairs[0].image, 'the kept negative is filled again');
  const expected = new Uint8Array(400 * 300);
  poolRepairMask(dustMask, 800, 600, expected, 400, 300);
  assert.deepEqual([...f.previewRepairs[1].mask], [...expected], 'with the masks as the stroke left them');
  f.previewRepairs[1].resolve({ width: 400, height: 300, name: 'second fill' });
  await settle();
  f.nextFrame();
  f.context.scheduleCoreReprocess({ full: false });
  await Promise.resolve();
  await settle();
  assert.equal(f.clients.preview.at(-1).request.imageData.name, 'second fill');
  assert.equal(f.context.repairedPreviewTimer, null, 'nothing waits any more');
  f.reply('preview');
  await settle();
}

// ---- #229 review R1-120: a reduced preview-tier target (#263) converts the
// normal tier's fill, resampled by the preview worker to its own size ----
{
  const f = fixture({ large: false, repairs: true, size: { width: 800, height: 600 }, target: { width: 400, height: 300 } });
  const dustMask = new Uint8Array(800 * 600);
  dustMask[300 * 800 + 500] = 255;
  f.state.dustRemoval.mask = dustMask;
  f.context.rememberRepairMasks(f.fullPlane);
  f.clock.run(0);
  await settle();
  const fill = { width: 400, height: 300, name: 'normal fill' };
  f.previewRepairs[0].resolve(fill);
  await settle();
  const normal = f.state.conversionPreviewImageData;
  const reduced = displayTargetFor(f.conversionSource, { width: 300, height: 225 }, 'reduced');
  f.context.reducedDisplayImages.add(reduced);
  f.context.previewTierKept = { source: f.conversionSource, preview: normal };
  f.state.conversionPreviewImageData = reduced;
  f.nextFrame();
  f.context.scheduleCoreReprocess({ full: false });
  await Promise.resolve();
  await settle();
  const { request } = f.clients.preview.at(-1);
  assert.equal(request.imageData, fill, 'the worker converts from the normal fill');
  assert.deepEqual({ ...request.display.target }, { width: 300, height: 225 }, 'resampled to the reduced size');
  assert.deepEqual({ ...request.display.geometry }, { sourceWidth: 400, sourceHeight: 300, k: 1 });
  f.reply('preview');
  await settle();
  assert.equal(f.context.repairedPreviewShown, f.state.previewSourceImageData);
  assert.ok(!f.clock.delays().includes(300), 'no fill of the reduced target is scheduled');
  assert.equal(f.previewRepairs.length, 1);
}

// ---- #249: a Tier B session converts previews from its display proxy (the
// display level, #248) while its source is pending; a full conversion and
// the export barrier wait for ensureSource() ----
{
  const f = fixture();
  const proxy = f.state.displayLevelImageData;
  const target = f.state.conversionPreviewImageData;
  assert.equal(target.__displayOf, proxy);
  f.state.conversionSourceImageData = null;
  f.state.sourcePending = { ...LARGE, key: 'proxy key' };
  f.state.processedImageData = f.shown;
  f.state.processedImageDataIsPreview = true;
  f.state.fullResolutionPending = true;
  assert.equal(f.context.hasSeparateConversionPreview(), true, 'the proxy is a separate preview: export owes the frame');
  // A slider tick: a preview conversion of the proxy, no source needed.
  f.nextFrame();
  f.context.scheduleCoreReprocess({ full: false });
  await Promise.resolve();
  await settle();
  assert.deepEqual(count(f), { preview: 1, shared: 0, exact: 0, mainThread: 0 });
  assert.equal(f.clients.preview[0].request.imageData, proxy, 'the level is converted');
  assert.deepEqual([f.clients.preview[0].request.display.target.width, f.clients.preview[0].request.display.target.height],
    [target.width, target.height], 'at the display target');
  f.reply('preview');
  await settle();
  assert.equal(f.state.processedImageData.name, 'preview result', 'and shown');
  assert.equal(f.state.processedImageDataIsPreview, true);
  // An Undo/Reset asks for a full conversion: above 16 MP it is a display
  // preview conversion too, still without the source.
  const undone = f.context.rerenderWithCoreControls({ full: true });
  await settle();
  assert.equal(f.clients.preview.length, 2);
  f.reply('preview');
  assert.equal(await undone, true);
  // The source being rebuilt while a preview converts keeps that preview.
  let release;
  f.context.ensureSource = () => new Promise(resolve => { release = resolve; });
  f.nextFrame();
  f.context.scheduleCoreReprocess({ full: false });
  await Promise.resolve();
  await settle();
  f.state.conversionSourceImageData = f.conversionSource;
  f.state.sourcePending = null;
  f.reply('preview');
  await settle();
  assert.equal(f.state.processedImageData.name, 'preview result', 'a proxy frame still applies once the source is back');
  // An exact render waits for ensureSource() before it converts.
  f.state.conversionSourceImageData = null;
  f.state.sourcePending = { ...LARGE, key: 'proxy key' };
  const exporting = f.context.ensureFullResolutionReadyForExport();
  await settle();
  assert.equal(f.clients.exact.length + f.clients.shared.length, 0, 'nothing converts before the source is back');
  f.state.conversionSourceImageData = f.conversionSource;
  f.state.sourcePending = null;
  release(true);
  await settle();
  await settle();
  assert.equal(f.clients.exact.length, 1, 'then the exact render converts the source');
  assert.equal(f.clients.exact[0].request.imageData, f.conversionSource);
  f.reply('exact');
  await exporting;
  assert.equal(f.state.processedImageDataIsPreview, false);
}

// ---- #249: a Tier A session (its base dropped, its source kept) exports
// from that source without decoding its base ----
{
  const f = fixture();
  f.state.baseDescriptor = { width: 9536, height: 6336, released: true };
  let rebuilt = 0;
  f.context.ensureSource = async () => { rebuilt++; return true; };
  f.state.processedImageDataIsPreview = true;
  f.state.fullResolutionPending = true;
  const exporting = f.context.ensureFullResolutionReadyForExport();
  await settle();
  assert.equal(f.clients.exact.length, 1, 'the exact render converts the kept source');
  assert.equal(f.clients.exact[0].request.imageData, f.conversionSource);
  f.reply('exact');
  await exporting;
  assert.equal(rebuilt, 0, 'no decode of the base for an export');
}

// ---- #249 (R2-001): on a session without its base whose descriptor has no
// colour-analysis sample for the area, a settle (a full request, converted
// in full or routed to the display preview) waits for the base before it
// converts; a slider tick converts at once (ensureBase() has it converted
// again); the export barrier waits too ----
for (const large of [true, false]) {
  const f = fixture({ large });
  let missing = true, waits = 0, release;
  const back = new Promise(resolve => { release = resolve; });
  f.context.colorAnalysisSampleMissing = () => missing;
  f.context.ensureColorAnalysisSample = async () => { waits++; await back; missing = false; return true; };
  const tick = f.context.rerenderWithCoreControls({ full: false });
  await settle();
  assert.equal(f.clients.preview.length, 1, 'a tick converts at once');
  assert.equal(waits, 0, 'without waiting for the base');
  f.reply('preview');
  await tick;
  const settling = f.context.rerenderWithCoreControls({ full: true });
  await settle();
  assert.equal(waits, 1, 'the settle waits for the base');
  assert.equal(f.clients.preview.length + f.clients.shared.length + f.clients.exact.length, 1, 'and converts nothing before it is back');
  release();
  await settle();
  const kind = large ? 'preview' : 'shared';
  assert.equal(f.clients[kind].length, large ? 2 : 1, `then converts (${kind})`);
  f.reply(kind);
  assert.equal(await settling, true);
  // The export barrier: a base that cannot be read fails the export.
  missing = true;
  f.context.ensureColorAnalysisSample = async () => false;
  f.context.getLocalizedText = (key, fallback) => fallback;
  await assert.rejects(f.context.ensureFullResolutionReadyForExport(), /Error loading file/);
}

// #229 R1-044: a branch-3 reply must not stale the exact render that won.
{
  const f = fixture();
  f.state.processedImageData = f.shown;
  f.state.processedImageDataIsPreview = true;
  f.state.fullResolutionPending = true;
  const exporting = f.context.ensureFullResolutionReadyForExport();
  await settle();
  f.setTarget({ width: 1200, height: 800 });
  f.context.refreshDisplayPreviewForViewport();
  await settle();
  assert.equal(f.clients.preview.length, 1);
  assert.equal(f.clients.exact.length, 1);
  f.reply('exact');
  await settle();
  const exact = f.state.processedImageData;
  assert.equal(f.state.fullResolutionPending, false);
  f.reply('preview');
  await settle();
  assert.ok(f.state.processedImageData === exact, 'display-only reply preserves the exact plane');
  assert.equal(f.state.fullResolutionPending, false);
  await exporting;
  await f.context.ensureFullResolutionReadyForExport();
  assert.equal(f.clients.exact.length, 1, 'the barrier never repeats the exact conversion');
}

{
  const f = fixture();
  const exact = { ...LARGE, __displayPreview: { width: 100, height: 100 } };
  f.context.applyExactPlaneKeepingView(exact);
  assert.equal(Object.hasOwn(exact, '__displayPreview'), false, 'unused display planes cannot enter history');
}

// The real mode exits replay a viewport refresh skipped while they were open.
for (const mode of ['crop', 'comparison', 'step']) {
  const f = fixture();
  Object.assign(f.context, {
    beforeAfterCanvas: null, beforeAfterBtn: null, updateSprocketControlsUI: noop,
    renderHistogramForWebGL: noop, renderHistogram: noop, updateWorkflowUI: noop,
    updateCanvasVisibility: noop, cropPreviewRenderFrame: null, activeCropPointerId: null,
    releaseCropCanvas: noop, hideCropModeHint: noop, setCropActionUi: noop,
    updateBeforeAfterButtonState: noop, cropModeWaiters: [],
  });
  vm.runInContext(['exitBeforeAfter', 'exitCropMode', 'goToStep'].map(functionSource).join('\n'), f.context);
  if (mode === 'crop') f.state.cropping = true;
  if (mode === 'comparison') f.state.beforeAfterActive = true;
  if (mode === 'step') f.state.currentStep = 2;
  f.setTarget({ width: 1200, height: 800 });
  f.context.refreshDisplayPreviewForViewport();
  assert.equal(f.context.displayViewportPending, true, mode);
  assert.equal(f.resampled.length, 0);
  if (mode === 'crop') f.context.exitCropMode();
  if (mode === 'comparison') f.context.exitBeforeAfter();
  if (mode === 'step') f.context.goToStep(3);
  f.clock.run(100);
  await settle();
  assert.equal(f.context.displayViewportPending, false, mode);
  assert.equal(f.resampled.length, 1, mode + ' replays the resize');
}

{
  const f = snapshotFixture({ repairs: true });
  f.state.dustRemoval.maskTag = 1;
  const answers = [];
  f.context.convertPreviewFrameInWorker.resample = () => new Promise(resolve => { answers.push(resolve); });
  f.context.isLargeImage = () => false;
  f.setTarget({ width: 600, height: 400 });
  f.context.rebuildDisplayPreview(f.fullPlane, { width: 600, height: 400 });
  f.resampled.length = 0;
  const snapshot = f.context.captureSnapshot('sliderPointerdown');
  assert.equal(f.resampled.length, 0, 'captureSnapshot performs zero full resamples');
  assert.equal(snapshot.refs.displayPreviewPending, true);
  assert.ok(snapshot.refs.processedImageData === f.fullPlane);
  f.context.cancelDisplayPreviewRebuild();
  f.context.restoreSnapshot(snapshot, { reprocess: false });
  assert.equal(answers.length, 2, 'restore before completion restarts the asynchronous display build');
  assert.equal(f.resampled.length, 0, 'restore also performs no full resample');
  const preview = { width: 600, height: 400, name: 'finished snapshot display' };
  for (const answer of answers) answer(preview);
  await settle();
  assert.ok(snapshot.refs.previewSourceImageData === preview, 'snapshot completes with the pending worker result');
  assert.equal(snapshot.refs.displayPreviewPending, undefined);
}

console.log('previewPathRouting: routing, kept planes, both repair barriers, idle Clear, repaired stroke and reduced-tier fill, colour-analysis barrier, exact/display races, mode exits and asynchronous history display passed');

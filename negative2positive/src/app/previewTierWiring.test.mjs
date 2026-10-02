import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createCoreReprocessGates, previewDispatchAction, CORE_FULL_REPROCESS_DELAY_MS } from './coreReprocessDispatcher.js';
import {
  displayPreviewSize, resizeDisplayPreview, resizeDisplayPreviewInBands, displayTargetFor, isDisplayTarget, displaySizeServes,
  noteDisplayFilter, displayLevelFactor, displayLevelGeometry, resampleDisplayLevel
} from './displayPreview.js';
import { previewTierMaxPixels, capBackingSize, PREVIEW_TIER_REDUCED_MAX_PIXELS } from './previewTier.js';
import { routeCoreConversion, keepsFullPlaneOnDowngrade, viewportRefreshBranch } from './fullResolutionRouting.js';
import { isLargeImage } from './imageMemoryBudget.js';
import { DISABLED_GPU_PREVIEW_SCHEDULER } from './gpuPreviewScheduler.js';
import { displaySessionStubs, DISPLAY_SESSION_HELPERS } from './displaySessionHarness.mjs';
import { poolRepairMask, repoolRepairMaskRect, countPooledCells } from './repairedPreview.js';

// Drives the real preview-tier wiring of main.js (#263) together with the real
// scheduler, reprocess and state-application functions, on synthetic images:
// a reduced session must show <= 1 MP frames, and its end must settle on
// exactly the frame the normal path produces. Since #248 the conversion
// preview is a display target on the source's level, which the preview worker
// resamples: the stand-in conversion does that with the real resample.
globalThis.ImageData = class {
  constructor(dataOrWidth, width, height) {
    if (typeof dataOrWidth === 'number') {
      this.width = dataOrWidth; this.height = width;
      this.data = new Uint8ClampedArray(dataOrWidth * width * 4);
    } else {
      this.data = dataOrWidth; this.width = width; this.height = height;
    }
  }
};

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `runtime function exists: ${name}`);
  const end = source.indexOf('\n    }', match.index);
  assert.ok(end > match.index, `runtime function closes: ${name}`);
  return source.slice(match.index, end + '\n    }'.length);
}
const settle = () => new Promise(setImmediate);

function patternImage(width, height) {
  const image = new ImageData(width, height);
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i += 4) {
      image.data[i] = (x * 7 + y * 3) & 255;
      image.data[i + 1] = (x * 3 + y * 5 + 40) & 255;
      image.data[i + 2] = (x + y * 11 + 90) & 255;
      image.data[i + 3] = 255;
    }
  }
  return image;
}

// The pixels a conversion of `image` reads: a display target is resampled from
// its level, as the preview worker does.
function pixelsOf(image) {
  if (!isDisplayTarget(image)) return image;
  const level = image.__displayOf;
  return resampleDisplayLevel(level, displayLevelGeometry(level), image);
}

// A stand-in conversion: deterministic in its input pixels and the settings,
// like the real one.
function convertPixels(input, exposure) {
  input = pixelsOf(input);
  const out = new ImageData(input.width, input.height);
  for (let i = 0; i < input.data.length; i++) out.data[i] = (input.data[i] + exposure * 3) & 255;
  return out;
}

const CONTAINER = { width: 1120, height: 640, valid: true };
const DPR = 2;

function fixture({ width = 3000, height = 2000, repairs = false, largePreviewFrames = true } = {}) {
  const container = { ...CONTAINER };
  let nextId = 1;
  const timers = new Map();
  const frames = new Map();
  const timeline = { currentTime: 1000 };
  const clock = {
    timeline,
    setTimeout: (callback, delay) => { const id = nextId++; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => { timers.delete(id); },
    requestAnimationFrame: callback => { const id = nextId++; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => { frames.delete(id); },
    isHidden: () => false,
  };
  const runTimers = () => { const due = [...timers.values()]; timers.clear(); for (const timer of due) timer.callback(); };
  const nextFrame = () => { timeline.currentTime += 1000 / 60; };
  const base = patternImage(width, height);
  const state = {
    conversionSourceImageData: base, conversionPreviewImageData: null, displayLevelImageData: base,
    processedImageData: null, processedImageDataIsPreview: largePreviewFrames,
    previewSourceImageData: null, histogramSourceImageData: null, webglSourceImageData: null,
    currentStep: 3, coreExposure: 0, repairStrokes: [], fullResolutionPending: false, zoomLevel: 1,
    cropping: false, beforeAfterActive: false, sprocketPreviewEnabled: false,
    dustRemoval: { enabled: repairs, processing: false, mask: null, revision: 0 },
  };
  const conversions = [];
  const resizes = [];
  const log = [];
  // #237 phase 2: the preview repair worker's fills and the display negatives
  // the preview worker sent for them. A fill blacks out the pooled cells.
  const fills = [];
  const displayNegatives = [];
  let heldNegative = null;
  const glCanvas = { width: 0, height: 0 };
  const controllerStub = { active: false, ends: [], nextStartTier: 'normal',
    nextStart() { return { tier: this.nextStartTier, reason: null }; },
    end(reason) { this.ends.push(reason); this.active = false; context.onPreviewTierChange('normal'); } };
  const idleCallbacks = [];
  const context = vm.createContext({
    // #249: no photo here takes a display form.
    ...displaySessionStubs(),
    // #254 stand-ins: the live dodge frame note, the dust tint, the overlays.
    noteLiveFrame: () => {}, adoptDustTint: () => {}, patchDustTint: () => {}, displayOverlaySize: () => null,
    syncBrushTools: () => {}, cancelDustBrush: () => {},
    brushFeedback: { drawing: false, end: () => {}, cancel: () => {}, sync: () => {} }, remapBrushStroke: () => {},
    liveDisplaySerial: 0,
    state, console: { error: () => {}, warn: () => {}, info: () => {} },
    window: { devicePixelRatio: DPR },
    document: { documentElement: { dataset: {} } },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    requestIdleCallback: (callback) => { idleCallbacks.push(callback); return idleCallbacks.length; },
    cancelIdleCallback: () => {},
    coreReprocessGates: createCoreReprocessGates(clock),
    previewDispatchAction, CORE_FULL_REPROCESS_DELAY_MS,
    CORE_RETAIN_PREVIEW_PLANE: false, CORE_PREVIEW_COMMIT_IDLE_MS: 150,
    corePreviewRetained: null, corePreviewCommit: null, corePreviewCommitWanted: false,
    corePreviewCommitTimer: null, corePreviewSettleWaiters: [],
    convertPreviewFrameInWorker: {
      commit: async () => null,
      displayNegative: async ({ imageData, display }) => {
        displayNegatives.push({ ...display.target });
        const negative = resampleDisplayLevel(imageData, display.geometry, display.target);
        return new ImageData(negative.data, negative.width, negative.height);
      },
    },
    poolRepairMask, repoolRepairMaskRect, countPooledCells,
    previewRepairWorker: {
      inpaint: async (image, mask) => {
        heldNegative = image;
        const out = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
        for (let i = 0; i < mask.length; i++) if (mask[i]) out.data.fill(0, i * 4, i * 4 + 3);
        fills.push({ image, mask: mask.slice(), out });
        return out;
      },
      holds: image => image === heldNegative, dispose: () => {},
    },
    buildRepairMask: () => ({ mask: null, bounds: null }), localExposureGeometryFor: () => ({}),
    buildRouterSettings: () => ({}), getColorAnalysisSample: () => null,
    repairedPreview: null, repairedPreviewBuild: null, repairedPreviewPool: null,
    repairedPreviewTimer: null, REPAIRED_PREVIEW_IDLE_MS: 300,
    coreReprocessTimer: null, coreReprocessScheduled: null,
    coreReprocessToken: 0, coreReprocessGeneration: 0,
    _coreReprocessFullInFlight: false, _coreReprocessPreviewInFlight: false,
    _coreReprocessPending: null, _coreReprocessActive: 0,
    _coreReprocessIdle: null, _resolveCoreReprocessIdle: null,
    coreSliderCommitRecord: null, fullResolutionRenderTimer: null, displayPreviewResizeTimer: null,
    // The tier state main.js declares next to canvasContainerSize.
    previewTier: 'normal', previewTierKept: null,
    reducedDisplayImages: new WeakSet(), previewTierQuietEnd: false,
    renderEnvironment: { compositing: null }, previewTierController: controllerStub,
    webglState: { gl: {}, maxTextureSize: 8192, sourceDirty: false, curveDirty: false }, glCanvas,
    getCanvasContainerSize: () => container,
    displayPreviewSize, previewTierMaxPixels, capBackingSize,
    displayTargetFor, isDisplayTarget, displaySizeServes, noteDisplayFilter, displayLevelFactor, displayLevelGeometry,
    resizeDisplayPreviewInBands, displayPreviewRebuild: null,
    displayCounters: { mainResamples: 0, mainFullResamples: 0, prebuilt: 0, workerRebuilds: 0, bandedRebuilds: 0 },
    // Records the resamples that made a new image.
    resizeDisplayPreview: (image, size) => {
      const result = resizeDisplayPreview(image, size);
      if (result !== image) resizes.push({ from: image, size });
      return result;
    },
    buildHistogramSourceImageData: image => ({ sampleOf: image }),
    usesSilverCoreConversion: () => true,
    hasFrameRepairs: () => state.dustRemoval.enabled,
    convertFromCurrentSource: (settings, options) => new Promise(resolve => {
      // A filled display preview source (#237 phase 2) is converted instead.
      const input = options.previewSource
        || (options.preview && state.conversionPreviewImageData ? state.conversionPreviewImageData : state.conversionSourceImageData);
      const entry = { input, filled: Boolean(options.previewSource), exposure: state.coreExposure, full: !options.interactive,
        resolve: () => resolve(convertPixels(input, entry.exposure)) };
      conversions.push(entry);
    }),
    initWebGLRenderer: () => true, isWebGLActive: () => true,
    renderWebGL: () => { log.push(`gl:${context.previewTier}`); return true; },
    fitStep3CanvasBox: () => {},
    updatePreview: () => log.push('draw'), updateFull: () => log.push('draw'),
    schedulePreviewUpdate: () => log.push('schedule-draw'),
    scheduleFullUpdate: () => {}, resetDustForCleanSource: () => {}, scheduleDustDetection: () => {},
    carryStudioThumbnailSource: () => {}, updateDebugWidget: () => {},
    logWebviewDiagnostics: line => log.push(`log:${line}`), formatPreviewSessionLine: () => 'session',
    updateEnlargerUI: () => {},
    // #237: the one routing rule, the viewport refresh and the repaired preview
    // run for real; these synthetic frames are below 16 MP, so the routing is
    // unchanged. No exact render or AI brush is involved.
    routeCoreConversion, keepsFullPlaneOnDowngrade, viewportRefreshBranch, isLargeImage,
    fullResolutionConversionAbort: null, dustDetectionTimer: null, repairedPreviewShown: null, repairedPreviewMasks: null,
    isAiBrushEnabled: () => false,
    ensureAiBrushPlane: () => {},
    // No GPU preview (#239): the tier's frames take the worker path.
    gpuPreviewScheduler: DISABLED_GPU_PREVIEW_SCHEDULER, gpuPreviewCanTake: () => false, gpuPreview: { status: 'none' },
    // The background lanes' gate (#243).
    backgroundGate: { bump() {} },
    FULL_RESOLUTION_IDLE_DELAY_MS: 2500, scheduleFullResolutionRender: (reason) => { log.push(`full-render:${reason}`); return null; },
  });
  vm.runInContext([
    ...DISPLAY_SESSION_HELPERS,
    'getDisplayPreviewSize', 'noteTierImage', 'buildPreviewSourceImageData', 'buildWebglSourceImageData',
    'histogramSourceFor', 'scheduleDisplayPreviewResize', 'ensureConversionPreviewForDisplay', 'displayIsReduced',
    'reducedConversionInFlight', 'redrawForPreviewTier', 'leavePreviewTier', 'restoreNormalTierDisplay', 'onPreviewTierChange',
    'onPreviewTierSessionEnd', 'resetPreviewTierForActivation', 'resizeWebGLCanvas',
    'installDisplayFor', 'installDisplayPreview', 'cancelDisplayPreviewRebuild', 'rebuildDisplayPreview',
    'flushDisplayPreviewRebuild', 'countMainResample', 'updateConversionTarget', 'conversionTargetFor',
    'coreReprocessBusy', 'whenCoreReprocessIdle', 'noteCoreReprocessSettled', 'runCoreReprocess',
    'rerenderWithCoreControls', 'postPendingPreviewEarly', 'hasSeparateConversionPreview',
    'cancelScheduledFullResolutionRender', 'scheduleCoreReprocess', 'takeScheduledCoreReprocess',
    'fireCoreReprocessGate', 'clearCoreReprocessTimer', 'flushScheduledCoreReprocess',
    'retainCorePreviewPlane', 'armCorePreviewCommitTimer', 'releaseCorePreviewRetained', 'requestCorePreviewCommit',
    'maybeCommitCorePreviewPlane', 'settleCorePreviewWaiters', 'settleCorePreviewPlane',
    'retainingPreviewComing', 'corePreviewQueued', 'settleCoreInput',
    'currentConvertedPreviewSource', 'displayResizeOrigin', 'displayResizeReplaces',
    'applyProcessedImageToState', 'applyPreviewProcessedImageToState', 'coreReprocessHandlersFor',
    'refreshDisplayPreviewForViewport', 'routeCoreRequest', 'beginFullResolutionConversion',
    'endFullResolutionConversion', 'abortSupersededFullResolutionConversion',
    'previewRequestImage', 'scheduleRepairedPreviewAfterInput', 'rememberRepairMasks', 'poolRepairStroke',
    'clearRepairedPreview', 'repairedPreviewMatches', 'repairedPreviewBaseFor', 'repairedPreviewSourceFor',
    'ensureRepairedPreview', 'currentRepairPool', 'buildRepairedPreview',
  ].map(functionSource).join('\n'), context);

  // processNegative's first conversion: the normal display target and its frame.
  const normalTarget = displayPreviewSize(width, height, {
    viewportWidth: CONTAINER.width - 20, viewportHeight: CONTAINER.height - 20, dpr: DPR, zoom: 1, maxDimension: 8192 });
  state.conversionPreviewImageData = context.conversionTargetFor(base, base, 'normal');
  const first = convertPixels(state.conversionPreviewImageData, 0);
  if (largePreviewFrames && state.conversionPreviewImageData !== base) context.applyProcessedImageToState(first, { previewOnly: true });
  else context.applyProcessedImageToState(convertPixels(base, 0));
  resizes.length = 0;
  const handlers = context.coreReprocessHandlersFor('coreExposure');
  // One slider input per frame, each answered before the next.
  const input = async (value) => {
    nextFrame();
    state.coreExposure = value;
    handlers.onInput(value);
    await Promise.resolve();
    await settle();
    conversions.at(-1)?.resolve();
    await settle();
  };
  // One slider input whose conversion is posted and left unanswered (a slow
  // worker).
  const post = async (value) => {
    nextFrame();
    state.coreExposure = value;
    handlers.onInput(value);
    await Promise.resolve();
    await settle();
  };
  const answerAll = async () => {
    for (let round = 0; round < 4; round++) {
      await Promise.resolve();
      await settle();
      for (const entry of conversions) if (!entry.answered) { entry.answered = true; entry.resolve(); }
      await settle();
    }
  };
  // Runs only the timers of one delay (a pause of that length).
  const runTimersOf = (delay) => {
    for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback(); }
  };
  return { context, state, base, conversions, resizes, log, glCanvas, controllerStub, idleCallbacks,
    normalTarget, handlers, input, post, answerAll, runTimers, runTimersOf, nextFrame, timers, container,
    fills, displayNegatives };
}

const bytesEqual = (a, b) => a.width === b.width && a.height === b.height && Buffer.compare(Buffer.from(a.data), Buffer.from(b.data)) === 0;
const pixels = image => image.width * image.height;

// ---- Parity: outside a reduced session nothing is sized differently ----
{
  const f = fixture();
  // The code the tier replaced, kept here as the reference. Zoom no longer
  // resizes the base display image (#248 part 5).
  const referenceSize = (image, maxDimension = 8192) => displayPreviewSize(image.width, image.height, {
    viewportWidth: CONTAINER.width - 20 || 1280, viewportHeight: CONTAINER.height - 20 || 900,
    dpr: DPR, zoom: 1, maxDimension });
  for (const zoom of [1, 1.5, 3, 8]) {
    f.state.zoomLevel = zoom;
    for (const [w, h] of [[3000, 2000], [9504, 6336], [1200, 800], [640, 4000]]) {
      const image = { width: w, height: h };
      assert.deepEqual(f.context.getDisplayPreviewSize(image), referenceSize(image), `normal size ${w}x${h} @${zoom}`);
      assert.deepEqual(f.context.getDisplayPreviewSize(image, 2048), referenceSize(image, 2048));
    }
  }
  // At the normal tier a tick changes nothing (#248 part 2): the same display
  // target at any zoom, and nothing resampled on the main thread. The pixels
  // the worker converts for it equal HEAD's resample of the source (k = 1,
  // a reduction of at most 2x).
  for (const zoom of [1, 2.5]) {
    f.state.zoomLevel = zoom;
    const kept = f.state.conversionPreviewImageData;
    f.context.ensureConversionPreviewForDisplay();
    assert.equal(f.state.conversionPreviewImageData, kept, `the display target is kept @${zoom}`);
    assert.ok(bytesEqual(pixelsOf(kept), resizeDisplayPreview(f.base, referenceSize(f.base))), `same conversion pixels @${zoom}`);
  }
  assert.equal(f.resizes.length, 0, 'no main-thread resample in a tick');
  f.state.zoomLevel = 1;
  const frame = convertPixels(f.base, 5);
  assert.ok(bytesEqual(f.context.buildPreviewSourceImageData(frame), resizeDisplayPreview(frame, referenceSize(frame))));
  assert.ok(bytesEqual(f.context.buildWebglSourceImageData(frame, 4096), resizeDisplayPreview(frame, referenceSize(frame, 4096))));
  f.context.resizeWebGLCanvas(1860, 1240);
  assert.deepEqual([f.glCanvas.width, f.glCanvas.height], [1860, 1240], 'the drawing buffer follows the texture');
  f.context.previewTier = 'reduced';
  f.context.resizeWebGLCanvas(1860, 1240);
  assert.ok(f.glCanvas.width * f.glCanvas.height <= PREVIEW_TIER_REDUCED_MAX_PIXELS, 'reduced buffer is <= 1 MP');
  assert.ok(Math.abs(f.glCanvas.width / f.glCanvas.height - 1.5) < 0.01);
  f.context.resizeWebGLCanvas(900, 600);
  assert.deepEqual([f.glCanvas.width, f.glCanvas.height], [900, 600], 'a small texture is drawn at its own size');
}

// ---- A reduced SilverCore drag settles on exactly the normal path's frame ----
async function dragAndRelease({ reduced, largePreviewFrames = true, width = 3000, height = 2000, commitAfterTick = false }) {
  const f = fixture({ largePreviewFrames, width, height });
  const normalPreview = f.state.conversionPreviewImageData;
  if (reduced) f.context.onPreviewTierChange('reduced');
  assert.equal(f.log.at(-1), reduced ? 'gl:reduced' : undefined, 'entering the tier redraws at once');
  const snapshots = [];
  for (const value of [10, 20, 30]) {
    await f.input(value);
    snapshots.push({ preview: f.state.conversionPreviewImageData, shown: f.state.previewSourceImageData });
  }
  const during = { conversions: f.conversions.length, reducedShown: f.context.displayIsReduced(),
    kept: f.context.previewTierKept?.preview, snapshots, resizes: f.resizes.slice() };
  if (reduced) f.context.onPreviewTierChange('normal');
  // The slider's own change handler runs after the capture-phase session end:
  // in the same task (a `change` end), or after the tick landed (pointerup).
  if (commitAfterTick) await f.answerAll();
  f.handlers.onCommit(30);
  await f.answerAll();
  f.runTimers(); // the display-preview settle (100 ms)
  await f.answerAll();
  return { f, normalPreview, during };
}

for (const largePreviewFrames of [true, false]) {
  // largePreviewFrames: a large image, whose last preview tick is the settled
  // view. Otherwise the source is small enough to be its own preview.
  const size = largePreviewFrames ? { width: 3000, height: 2000 } : { width: 1500, height: 1000 };
  const label = largePreviewFrames ? 'large image' : 'image that is its own preview';
  const baseline = await dragAndRelease({ reduced: false, largePreviewFrames, ...size });
  const tier = await dragAndRelease({ reduced: true, largePreviewFrames, ...size });
  const b = baseline.f, t = tier.f;

  assert.equal(baseline.during.conversions, 3, `${label}: one conversion per input`);
  assert.equal(b.conversions.length, 3, `${label}: the baseline release converts nothing new`);
  assert.equal(tier.during.conversions, 3);
  for (const entry of t.conversions.slice(0, 3)) {
    assert.ok(pixels(entry.input) <= PREVIEW_TIER_REDUCED_MAX_PIXELS, `${label}: reduced frames convert <= 1 MP`);
    assert.ok(t.context.reducedDisplayImages.has(entry.input));
  }
  assert.ok(tier.during.reducedShown, `${label}: a reduced frame is on screen during the drag`);
  assert.equal(tier.during.kept, tier.normalPreview, `${label}: the normal-tier preview is kept`);
  // #248: the reduced display target is resampled by the preview worker,
  // never on the main thread.
  assert.equal(tier.during.resizes.length, 0, `${label}: no main-thread resample for the reduced tier`);
  if (largePreviewFrames) assert.equal(tier.during.snapshots[0].preview.__displayOf, t.base, 'from the level');
  assert.equal(t.conversions.length, 4, `${label}: the session end converts once more at the normal size, and the commit adds nothing`);
  assert.equal(t.conversions[3].input, tier.normalPreview, `${label}: from the kept normal-tier object`);
  assert.equal(t.conversions[3].exposure, 30);
  assert.equal(t.state.conversionPreviewImageData, tier.normalPreview, `${label}: the kept preview is back`);
  assert.equal(t.context.displayIsReduced(), false, `${label}: nothing reduced is left on screen`);
  assert.equal(t.context.previewTierKept, null);
  // The settled view is the normal path's, byte for byte.
  for (const key of ['previewSourceImageData', 'webglSourceImageData', 'processedImageData']) {
    assert.ok(bytesEqual(t.state[key], b.state[key]), `${label}: settled ${key} matches the normal path`);
  }
  assert.equal(t.state.processedImageDataIsPreview, b.state.processedImageDataIsPreview);
  assert.equal(t.state.fullResolutionPending, b.state.fullResolutionPending, `${label}: same export barrier state`);
  assert.equal(t.context.document.documentElement.dataset.previewTier, 'normal');
}

{
  // pointerup ends the session a task before `change`: still one conversion.
  const { f } = await dragAndRelease({ reduced: true, commitAfterTick: true });
  assert.equal(f.conversions.length, 4, 'a commit after the normal tick landed converts nothing new');
  assert.equal(f.context.displayIsReduced(), false);
}

// ---- #249: a Tier B session (source pending, the level kept) drags at the
// reduced tier from its level and gets its normal display target back at
// the end; a window that needs the source's own pixels rebuilds the source
// instead of pointing the preview at the pending descriptor ----
{
  const f = fixture();
  const normalPreview = f.state.conversionPreviewImageData;
  f.state.sourcePending = { width: 3000, height: 2000, key: 'proxy key' };
  f.state.conversionSourceImageData = null;
  let requested = 0;
  f.context.requestSourceForDisplay = () => { requested++; };
  f.context.onPreviewTierChange('reduced');
  for (const value of [10, 20]) await f.input(value);
  for (const entry of f.conversions) {
    assert.equal(entry.input.__displayOf, f.base, 'Tier B frames convert the level');
    assert.ok(pixels(entry.input) <= PREVIEW_TIER_REDUCED_MAX_PIXELS, 'at the reduced size');
  }
  f.context.onPreviewTierChange('normal');
  f.handlers.onCommit(20);
  await f.answerAll();
  f.runTimers();
  await f.answerAll();
  assert.equal(f.state.conversionPreviewImageData, normalPreview, 'the normal display target is back');
  assert.equal(f.context.displayIsReduced(), false, 'nothing reduced is left on screen');
  assert.equal(f.conversions.at(-1).input, normalPreview, 'and converted once at the normal size');
  assert.equal(requested, 0, 'no source was needed');
  // A frame that is its own level (a debug threshold) in a window that fits it.
  const own = fixture({ width: 1500, height: 1000, largePreviewFrames: false });
  own.state.sourcePending = { width: 1500, height: 1000, key: 'proxy key' };
  own.state.conversionSourceImageData = null;
  own.state.conversionPreviewImageData = displayTargetFor(own.base, { width: 1200, height: 800 });
  const shown = own.state.conversionPreviewImageData;
  let ownRequests = 0;
  own.context.requestSourceForDisplay = () => { ownRequests++; };
  assert.equal(own.context.pendingConversionTarget(), null, 'the window needs the source itself');
  assert.equal(own.context.updateConversionTarget(), false);
  assert.equal(own.state.conversionPreviewImageData, shown, 'the level stays on screen');
  assert.equal(ownRequests, 1, 'while the source is rebuilt');
}

// ---- Undo history keeps the normal-tier conversion preview ----
{
  const f = fixture();
  const normalPreview = f.state.conversionPreviewImageData;
  f.context.onPreviewTierChange('reduced');
  await f.input(15);
  assert.notEqual(f.state.conversionPreviewImageData, normalPreview);
  // captureSnapshot's guard, run on the refs it would capture.
  const snapshotSource = functionSource('captureSnapshot');
  assert.match(snapshotSource, /previewTierKept\.preview/);
  const guard = /\/\/ A reduced preview-tier session[\s\S]*?\n      }\n/.exec(snapshotSource)?.[0];
  assert.ok(guard, 'captureSnapshot swaps in the kept preview');
  const refs = { conversionPreviewImageData: f.state.conversionPreviewImageData };
  vm.runInContext(`(refs => {\n${guard}})`, f.context)(refs);
  assert.equal(refs.conversionPreviewImageData, normalPreview, 'a snapshot stores the normal-tier object');
}

// ---- Photo switch: the session closes without converting the old photo ----
{
  const f = fixture();
  f.context.onPreviewTierChange('reduced');
  f.controllerStub.active = true;
  await f.input(12);
  const before = f.conversions.length;
  f.context.resetPreviewTierForActivation();
  await f.answerAll();
  assert.deepEqual(f.controllerStub.ends, ['activation']);
  assert.equal(f.context.previewTier, 'normal');
  assert.equal(f.conversions.length, before, 'no normal tick for the outgoing photo');
  assert.equal(f.context.previewTierKept, null);
  assert.equal(f.context.displayIsReduced(), true, 'a reduced frame on screen stays unsettled for the session cache');
}

// ---- Repairs on: the session converts the reduced preview, and the
// full-resolution plane with its repairs waits for the idle pass (#237) ----
{
  const f = fixture({ repairs: true, largePreviewFrames: false });
  const plane = f.state.processedImageData;
  const normalPreview = f.state.conversionPreviewImageData;
  f.context.onPreviewTierChange('reduced');
  await f.input(8);
  const tick = f.conversions.at(-1);
  assert.equal(tick.full, false, 'an input with repairs on converts the display preview');
  assert.ok(pixels(tick.input) <= PREVIEW_TIER_REDUCED_MAX_PIXELS, 'at the reduced size');
  assert.equal(f.state.processedImageData, plane, 'the full-resolution plane stays for its repairs');
  assert.ok(pixels(f.state.previewSourceImageData) <= PREVIEW_TIER_REDUCED_MAX_PIXELS, 'its display copy is reduced');
  assert.ok(f.log.includes('full-render:repair-idle'), 'the idle repair pass is armed');
  const count = f.conversions.length;
  f.context.onPreviewTierChange('normal');
  f.runTimers(); // the queued tick's frame gate and the display-preview settle
  await f.answerAll();
  assert.equal(f.conversions.length, count + 1, 'the session end converts once at the normal size');
  assert.equal(f.conversions.at(-1).input, normalPreview, 'from the kept normal-tier preview');
  assert.equal(f.state.processedImageData, plane);
  assert.equal(f.state.webglSourceImageData, f.state.previewSourceImageData);
  assert.equal(f.context.displayIsReduced(), false);
}

// ---- The display-preview settle waits for the session end ----
{
  const f = fixture();
  f.context.onPreviewTierChange('reduced');
  // A panel closes during the session: the viewport grows.
  f.container.width = 1500;
  f.container.height = 900;
  f.context.scheduleDisplayPreviewResize();
  const before = f.conversions.length;
  f.runTimers();
  await f.answerAll();
  assert.equal(f.conversions.length, before, 'no display resize inside a reduced session');
  f.context.onPreviewTierChange('normal');
  // The kept target no longer fits the new viewport: the settle moves it.
  f.runTimers();
  await f.answerAll();
  const expected = displayPreviewSize(3000, 2000, { viewportWidth: 1480, viewportHeight: 880, dpr: DPR, zoom: 1, maxDimension: 8192 });
  assert.equal(f.state.conversionPreviewImageData.width, expected.width);
  assert.equal(f.context.displayIsReduced(), false);
}

// ---- #229 review R1-119: the session ends before its reduced tick is
// answered (a click on the track, or a release while the worker is slow).
// That frame lands after the end: the end still converts once at the normal
// size, and the settled view is the normal path's frame ----
{
  const sizes = f => f.conversions.map(entry => `${entry.input.width}x${entry.input.height}`);
  const baseline = fixture();
  await baseline.input(25);
  baseline.handlers.onCommit(25);
  await baseline.answerAll();
  baseline.runTimers();
  await baseline.answerAll();
  assert.deepEqual(sizes(baseline), ['1860x1240']);

  const f = fixture();
  const normalPreview = f.state.conversionPreviewImageData;
  f.context.onPreviewTierChange('reduced');
  await f.post(25);
  assert.equal(f.conversions.length, 1, 'the reduced tick is on its way');
  // pointerup ends the session in the capture phase; the slider's own change
  // handler follows.
  f.context.onPreviewTierChange('normal');
  f.handlers.onCommit(25);
  await f.answerAll();
  f.runTimers();
  await f.answerAll();
  assert.deepEqual(sizes(f), ['1224x816', '1860x1240'], 'the reduced tick, then one normal-size tick');
  assert.equal(f.conversions[1].input, normalPreview, 'from the kept normal-tier preview');
  assert.equal(f.conversions[1].exposure, 25);
  for (const key of ['previewSourceImageData', 'webglSourceImageData', 'processedImageData']) {
    assert.ok(bytesEqual(f.state[key], baseline.state[key]), `settled ${key} is the normal path's frame`);
  }
  assert.equal(f.state.processedImageData.width, 1860);
  assert.equal(f.context.displayIsReduced(), false, 'nothing reduced is left on screen');
  assert.equal(f.state.fullResolutionPending, baseline.state.fullResolutionPending);

  // A tick queued behind the one in flight is replaced by the end's tick, not
  // joined by it.
  const queued = fixture();
  queued.context.onPreviewTierChange('reduced');
  await queued.post(20);
  await queued.post(25);
  assert.equal(queued.conversions.length, 1, 'the second tick waits for the lane');
  queued.context.onPreviewTierChange('normal');
  queued.handlers.onCommit(25);
  await queued.answerAll();
  queued.runTimers();
  await queued.answerAll();
  assert.deepEqual(sizes(queued), ['1224x816', '1860x1240']);
  assert.equal(queued.conversions[1].exposure, 25);
  assert.ok(bytesEqual(queued.state.processedImageData, baseline.state.processedImageData));
  assert.equal(queued.context.displayIsReduced(), false);

  // A full-resolution plane that reads as current (a whole-frame result
  // landed meanwhile) does not turn the end into a display rebuild: the
  // reduced frame on its way is still replaced by a conversion.
  const plane = fixture({ largePreviewFrames: false });
  plane.context.convertPreviewFrameInWorker.resample = (image, target) => Promise.resolve(resizeDisplayPreview(image, target));
  plane.context.onPreviewTierChange('reduced');
  await plane.post(25);
  plane.state.fullResolutionPending = false;
  plane.context.onPreviewTierChange('normal');
  plane.handlers.onCommit(25);
  await plane.answerAll();
  plane.runTimers();
  await plane.answerAll();
  assert.deepEqual(sizes(plane), ['1224x816', '1860x1240'], 'the reduced tick, then one normal-size tick');
  assert.equal(plane.context.displayIsReduced(), false);
  assert.ok(bytesEqual(plane.state.previewSourceImageData, baseline.state.previewSourceImageData));
}

// ---- #229 review R1-089 / R1-122: a reduced target never becomes a normal
// one. Display targets are cached per (level, size); a later viewport whose
// normal size equals a reduced session's size gets an unmarked object ----
{
  const { f } = await dragAndRelease({ reduced: true });
  const reducedSize = f.context.getDisplayPreviewSize(f.base, undefined, 'reduced');
  // A window 428 px high at DPR 2 fits the photo at exactly that size.
  f.container.height = 428;
  assert.deepEqual(f.context.getDisplayPreviewSize(f.base, undefined, 'normal'), reducedSize);
  f.context.refreshDisplayPreviewForViewport();
  await f.answerAll();
  const target = f.state.conversionPreviewImageData;
  assert.deepEqual([target.width, target.height], [reducedSize.width, reducedSize.height], 'the normal target has the reduced size');
  assert.equal(f.context.reducedDisplayImages.has(target), false, 'and no reduced mark');
  assert.equal(f.context.displayIsReduced(), false, 'its frame is a settled view');
  await f.input(31);
  assert.equal(f.context.displayIsReduced(), false, 'so is every later tick');
  // Hysteresis still holds for it (a marked target had none).
  f.container.height = 430;
  f.context.refreshDisplayPreviewForViewport();
  assert.equal(f.state.conversionPreviewImageData, target, 'a size inside the band keeps the target');

  // Where the reduced size is the normal one, the tier changes nothing: the
  // drag converts the normal target and the end adds no conversion.
  const same = fixture();
  same.container.height = 428;
  same.context.refreshDisplayPreviewForViewport();
  await same.answerAll();
  const normalTarget = same.state.conversionPreviewImageData;
  assert.equal(normalTarget.width, reducedSize.width);
  const count = same.conversions.length;
  same.context.onPreviewTierChange('reduced');
  for (const value of [10, 20]) await same.input(value);
  assert.ok(same.conversions.slice(count).every(entry => entry.input === normalTarget), 'the drag converts the normal target');
  assert.equal(same.context.displayIsReduced(), false);
  same.context.onPreviewTierChange('normal');
  same.handlers.onCommit(20);
  await same.answerAll();
  same.runTimers();
  await same.answerAll();
  assert.equal(same.conversions.length, count + 2, 'the end converts nothing more');
}

// ---- #229 review R1-123: a whole-frame result of the same size (a repair
// pass, a cleared mask) landing inside a reduced session is rebuilt for the
// normal tier off the main thread, whichever tier's frame is on screen: the
// normal one during a curve drag or a slider drag before its first reduced
// frame, a reduced one after it ----
for (const kind of ['curve', 'slider', 'reduced frame']) {
  const f = fixture({ largePreviewFrames: false });
  const rebuilds = [];
  f.context.convertPreviewFrameInWorker.resample = (image, target) => {
    rebuilds.push({ image, target: { ...target } });
    return Promise.resolve(resizeDisplayPreview(image, target));
  };
  const plane = f.state.processedImageData;
  const normalShown = f.state.previewSourceImageData;
  f.context.onPreviewTierChange('reduced');
  if (kind === 'slider') await f.post(6);
  if (kind === 'reduced frame') await f.input(6);
  const shown = f.state.previewSourceImageData;
  assert.equal(f.state.processedImageData, plane, `${kind}: the full-resolution plane is on screen`);
  assert.equal(shown === normalShown, kind !== 'reduced frame', `${kind}: with the expected display preview`);
  assert.equal(f.context.reducedDisplayImages.has(shown), kind === 'reduced frame');
  const resamples = f.context.displayCounters.mainResamples;
  const result = convertPixels(f.base, kind === 'curve' ? 9 : 6);
  f.context.applyProcessedImageToState(result, { deferDisplay: true });
  assert.equal(f.context.displayCounters.mainResamples, resamples, `${kind}: no main-thread resample of the whole frame`);
  assert.equal(f.state.previewSourceImageData, shown, `${kind}: the frame on screen stays until its rebuild lands`);
  assert.equal(rebuilds.length, 1, `${kind}: the preview worker rebuilds it`);
  assert.deepEqual(rebuilds[0].target, { width: f.normalTarget.width, height: f.normalTarget.height }, `${kind}: at the normal tier's size`);
  await settle();
  assert.ok(bytesEqual(f.state.previewSourceImageData, resizeDisplayPreview(result, f.normalTarget)), `${kind}: the rebuild is shown`);
  await f.answerAll();
  f.context.onPreviewTierChange('normal');
  if (kind !== 'curve') f.handlers.onCommit(6);
  f.runTimers();
  await f.answerAll();
  assert.equal(f.context.displayCounters.mainResamples, resamples, `${kind}: nor after the session`);
  assert.equal(f.context.displayIsReduced(), false, `${kind}: nothing reduced is left on screen`);
  if (kind === 'slider') {
    assert.equal(f.conversions.at(-1).input.width, f.normalTarget.width, 'the slider settles at the normal size');
    assert.equal(f.conversions.at(-1).exposure, 6);
  }
}

// ---- #229 review R1-120: repairs on, the normal tier's display preview filled
// (#237 phase 2). A reduced session converts that fill, resampled to its own
// size, from its first tick; it never fills a reduced target of its own, so a
// pause mid-drag keeps the normal fill; and its settle tick converts the
// normal fill again ----
{
  const dustSource = { width: 3000, height: 2000 };
  const specks = (f) => {
    const mask = new Uint8Array(3000 * 2000);
    for (const [x, y] of [[500, 400], [1500, 1000], [2400, 1700], [2999, 1999]]) mask[y * 3000 + x] = 255;
    f.state.dustRemoval.mask = mask;
    f.state.dustRemoval.revision += 2;
  };
  // Lets a fill land: its build leaves the task first.
  const fillLands = async (f) => {
    for (let round = 0; round < 3; round++) {
      f.runTimersOf(0);
      await settle();
    }
  };
  // Identities are checked with assert.ok: a failing assert.equal inspects
  // these multi-megapixel images in full, for seconds and gigabytes.
  const reducedFromFill = (entry, fill) => isDisplayTarget(entry.input) && entry.input.__displayOf === fill
    && pixels(entry.input) <= PREVIEW_TIER_REDUCED_MAX_PIXELS && entry.filled;

  const f = fixture({ repairs: true });
  const normalPreview = f.state.conversionPreviewImageData;
  specks(f);
  // Detection settled the repair: its masks are remembered and filled.
  f.context.rememberRepairMasks(dustSource);
  await fillLands(f);
  const fill = f.context.repairedPreview?.image;
  assert.ok(fill, 'the normal tier\'s preview is filled');
  assert.ok(f.context.repairedPreview.base === normalPreview, 'for its own conversion preview');
  assert.equal(f.fills.length, 1);
  assert.deepEqual(f.displayNegatives, [{ width: normalPreview.width, height: normalPreview.height }]);

  f.context.onPreviewTierChange('reduced');
  for (const value of [10, 20]) await f.input(value);
  const drag = f.conversions.slice(-2);
  assert.ok(drag.every(entry => reducedFromFill(entry, fill)), 'every reduced tick converts the normal fill at its own size');
  assert.ok(drag[0].input === drag[1].input, 'one stand-in object, so the worker keeps its resample');
  assert.deepEqual([drag[0].input.width, drag[0].input.height], [f.state.conversionPreviewImageData.width, f.state.conversionPreviewImageData.height]);
  assert.ok(f.context.displayIsReduced(), 'a reduced frame is on screen');
  assert.ok(f.context.repairedPreviewShown === f.state.previewSourceImageData, 'shown as a repaired preview');
  // The tick's pixels: the normal fill resampled to the reduced size, converted.
  assert.ok(bytesEqual(f.state.processedImageData, convertPixels(drag[1].input, 20)));
  assert.ok(!bytesEqual(f.state.processedImageData, convertPixels(f.state.conversionPreviewImageData, 20)), 'the specks are filled');

  // The user holds still for 300 ms mid-drag: nothing is filled for the
  // reduced target, and the normal fill stays.
  f.runTimersOf(300);
  await fillLands(f);
  assert.ok(f.context.repairedPreview.base === normalPreview, 'the normal fill survives the pause');
  assert.ok(f.context.repairedPreview.image === fill, 'unchanged');
  assert.equal(f.fills.length, 1, 'no fill of a reduced target');
  assert.equal(f.displayNegatives.length, 1);

  await f.input(30);
  assert.ok(reducedFromFill(f.conversions.at(-1), fill));
  f.context.onPreviewTierChange('normal');
  f.handlers.onCommit(30);
  await f.answerAll();
  f.runTimers();
  await f.answerAll();
  const settleTick = f.conversions.at(-1);
  assert.ok(settleTick.input === fill, 'the settle tick converts the normal fill');
  assert.equal(settleTick.exposure, 30);
  assert.equal(f.context.displayIsReduced(), false);
  assert.ok(bytesEqual(f.state.processedImageData, convertPixels(fill, 30)), 'the settled frame is the filled one');
  assert.ok(f.context.repairedPreviewShown === f.state.previewSourceImageData, 'and the idle pass keeps it on screen');
  assert.equal(f.fills.length, 1, 'the session made no fill');

  // A repair that settles during a reduced session (detection after the idle
  // pass) is filled for the normal tier's preview, never the reduced target;
  // the ticks after it convert that fill, and so does the settle tick.
  const g = fixture({ repairs: true });
  const gNormal = g.state.conversionPreviewImageData;
  g.context.onPreviewTierChange('reduced');
  await g.input(10);
  assert.equal(g.conversions.at(-1).filled, false, 'nothing to fill with yet');
  specks(g);
  g.context.rememberRepairMasks(dustSource);
  await fillLands(g);
  assert.ok(g.context.repairedPreview?.base === gNormal, 'filled for the normal tier\'s preview');
  assert.deepEqual(g.displayNegatives, [{ width: gNormal.width, height: gNormal.height }]);
  const gFill = g.context.repairedPreview.image;
  await g.input(20);
  assert.ok(reducedFromFill(g.conversions.at(-1), gFill));
  g.runTimersOf(300);
  await fillLands(g);
  assert.ok(g.context.repairedPreview.base === gNormal, 'kept through the pause');
  g.context.onPreviewTierChange('normal');
  g.handlers.onCommit(20);
  await g.answerAll();
  g.runTimers();
  await g.answerAll();
  assert.ok(g.conversions.at(-1).input === gFill, 'the settle tick converts the normal fill');
  assert.equal(g.fills.length, 1);

  // A fill of another size (the window changed since) serves no reduced
  // tick; a pause mid-drag fills the normal tier's new preview, not the
  // reduced target, and the ticks after it convert that fill.
  const h = fixture({ repairs: true });
  specks(h);
  h.context.rememberRepairMasks(dustSource);
  await fillLands(h);
  const oldFill = h.context.repairedPreview.image;
  h.container.height = 560;
  h.state.conversionPreviewImageData = h.context.conversionTargetFor(h.base, h.base, 'normal');
  const hNormal = h.state.conversionPreviewImageData;
  assert.notEqual(hNormal.height, oldFill.height);
  h.context.onPreviewTierChange('reduced');
  await h.input(10);
  assert.equal(h.conversions.at(-1).filled, false, 'a fill of another size is not used');
  h.runTimersOf(300);
  await fillLands(h);
  assert.ok(h.context.repairedPreview?.base === hNormal, 'the pause fills the normal tier\'s preview');
  assert.deepEqual(h.displayNegatives.at(-1), { width: hNormal.width, height: hNormal.height });
  await h.input(20);
  assert.ok(reducedFromFill(h.conversions.at(-1), h.context.repairedPreview.image));
}

// ---- Session end diagnostics ----
{
  const f = fixture();
  f.context.renderEnvironment.compositing = { frameLog: true };
  f.context.onPreviewTierSessionEnd({ reduced: true });
  assert.equal(f.context.document.documentElement.dataset.previewTierLastSession, 'reduced');
  assert.equal(f.log.at(-1), 'log:session', 'NEGATIVE_CONVERTER_FRAME_LOG sends the summary to the terminal');
  f.context.renderEnvironment.compositing = null;
  f.context.onPreviewTierSessionEnd({ reduced: false });
  assert.equal(f.log.at(-1), 'log:session', 'no frame log without the flag');
}

console.log('previewTierWiring: reduced sessions show <= 1 MP, settle byte-identical to the normal path, keep history normal, skip the old photo and convert the normal fill of a repaired preview');

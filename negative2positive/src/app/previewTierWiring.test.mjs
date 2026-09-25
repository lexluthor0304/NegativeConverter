import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createCoreReprocessGates, previewDispatchAction, CORE_FULL_REPROCESS_DELAY_MS } from './coreReprocessDispatcher.js';
import { displayPreviewSize, resizeDisplayPreview } from './displayPreview.js';
import { previewTierMaxPixels, capBackingSize, PREVIEW_TIER_REDUCED_MAX_PIXELS } from './previewTier.js';
import { routeCoreConversion, keepsFullPlaneOnDowngrade, viewportRefreshBranch } from './fullResolutionRouting.js';
import { isLargeImage } from './imageMemoryBudget.js';
import { DISABLED_GPU_PREVIEW_SCHEDULER } from './gpuPreviewScheduler.js';

// Drives the real preview-tier wiring of main.js (#263) together with the real
// scheduler, reprocess and state-application functions, on synthetic images:
// a reduced session must show <= 1 MP frames, and its end must settle on
// exactly the frame the normal path produces.
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

// A stand-in conversion: deterministic in its input pixels and the settings,
// like the real one.
function convertPixels(input, exposure) {
  const out = new ImageData(input.width, input.height);
  for (let i = 0; i < input.data.length; i++) out.data[i] = (input.data[i] + exposure * 3) & 255;
  return out;
}

const CONTAINER = { width: 1120, height: 640, valid: true };
const DPR = 2;

function fixture({ width = 3000, height = 2000, repairs = false, largePreviewFrames = true } = {}) {
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
    conversionSourceImageData: base, conversionPreviewImageData: null,
    processedImageData: null, processedImageDataIsPreview: largePreviewFrames,
    previewSourceImageData: null, histogramSourceImageData: null, webglSourceImageData: null,
    currentStep: 3, coreExposure: 0, repairStrokes: [], fullResolutionPending: false, zoomLevel: 1,
    cropping: false, beforeAfterActive: false, sprocketPreviewEnabled: false,
    dustRemoval: { enabled: repairs, processing: false },
  };
  const conversions = [];
  const resizes = [];
  const log = [];
  const glCanvas = { width: 0, height: 0 };
  const controllerStub = { active: false, ends: [], nextStartTier: 'normal',
    nextStart() { return { tier: this.nextStartTier, reason: null }; },
    end(reason) { this.ends.push(reason); this.active = false; context.onPreviewTierChange('normal'); } };
  const idleCallbacks = [];
  const context = vm.createContext({
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
    convertPreviewFrameInWorker: { commit: async () => null },
    coreReprocessTimer: null, coreReprocessScheduled: null,
    coreReprocessToken: 0, coreReprocessGeneration: 0,
    _coreReprocessFullInFlight: false, _coreReprocessPreviewInFlight: false,
    _coreReprocessPending: null, _coreReprocessActive: 0,
    _coreReprocessIdle: null, _resolveCoreReprocessIdle: null,
    coreSliderCommitRecord: null, fullResolutionRenderTimer: null, displayPreviewResizeTimer: null,
    // The tier state main.js declares next to canvasContainerSize.
    previewTier: 'normal', previewTierKept: null, previewTierPrebuilt: null, previewTierPrebuildHandle: null,
    reducedDisplayImages: new WeakSet(), previewTierQuietEnd: false,
    renderEnvironment: { compositing: null }, previewTierController: controllerStub,
    webglState: { gl: {}, maxTextureSize: 8192, sourceDirty: false, curveDirty: false }, glCanvas,
    getCanvasContainerSize: () => CONTAINER,
    displayPreviewSize, previewTierMaxPixels, capBackingSize,
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
      const input = options.preview && state.conversionPreviewImageData ? state.conversionPreviewImageData : state.conversionSourceImageData;
      const entry = { input, exposure: state.coreExposure, full: !options.interactive,
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
    // #237: the one routing rule and the viewport refresh run for real; these
    // synthetic frames are below 16 MP, so the routing is unchanged. No exact
    // render, repaired preview or AI brush is involved.
    routeCoreConversion, keepsFullPlaneOnDowngrade, viewportRefreshBranch, isLargeImage,
    fullResolutionConversionAbort: null, dustDetectionTimer: null, repairedPreviewShown: null, repairedPreviewMasks: null,
    isAiBrushEnabled: () => false, repairedPreviewSourceFor: () => null, ensureRepairedPreview: () => {},
    ensureAiBrushPlane: () => {},
    // No GPU preview (#239): the tier's frames take the worker path.
    gpuPreviewScheduler: DISABLED_GPU_PREVIEW_SCHEDULER, gpuPreviewCanTake: () => false, gpuPreview: { status: 'none' },
    // The background lanes' gate (#243).
    backgroundGate: { bump() {} },
    FULL_RESOLUTION_IDLE_DELAY_MS: 2500, scheduleFullResolutionRender: (reason) => { log.push(`full-render:${reason}`); return null; },
  });
  vm.runInContext([
    'getDisplayPreviewSize', 'noteTierImage', 'buildPreviewSourceImageData', 'buildWebglSourceImageData',
    'histogramSourceFor', 'scheduleDisplayPreviewResize', 'ensureConversionPreviewForDisplay', 'displayIsReduced',
    'redrawForPreviewTier', 'leavePreviewTier', 'restoreNormalTierDisplay', 'onPreviewTierChange',
    'onPreviewTierSessionEnd', 'resetPreviewTierForActivation', 'cancelPreviewTierPrebuild',
    'schedulePreviewTierPrebuild', 'resizeWebGLCanvas',
    'coreReprocessBusy', 'whenCoreReprocessIdle', 'noteCoreReprocessSettled', 'runCoreReprocess',
    'rerenderWithCoreControls', 'postPendingPreviewEarly', 'hasSeparateConversionPreview',
    'cancelScheduledFullResolutionRender', 'scheduleCoreReprocess', 'takeScheduledCoreReprocess',
    'fireCoreReprocessGate', 'clearCoreReprocessTimer', 'flushScheduledCoreReprocess',
    'retainCorePreviewPlane', 'armCorePreviewCommitTimer', 'releaseCorePreviewRetained', 'requestCorePreviewCommit',
    'maybeCommitCorePreviewPlane', 'settleCorePreviewWaiters', 'settleCorePreviewPlane',
    'currentConvertedPreviewSource', 'displayResizeOrigin', 'displayResizeReplaces',
    'applyProcessedImageToState', 'applyPreviewProcessedImageToState', 'coreReprocessHandlersFor',
    'refreshDisplayPreviewForViewport', 'routeCoreRequest', 'beginFullResolutionConversion',
    'endFullResolutionConversion', 'abortSupersededFullResolutionConversion',
  ].map(functionSource).join('\n'), context);

  // processNegative's first conversion: the normal display preview and its frame.
  const normalTarget = displayPreviewSize(width, height, {
    viewportWidth: CONTAINER.width - 20, viewportHeight: CONTAINER.height - 20, dpr: DPR, zoom: 1, maxDimension: 8192 });
  state.conversionPreviewImageData = resizeDisplayPreview(base, normalTarget);
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
  const answerAll = async () => {
    for (let round = 0; round < 4; round++) {
      await Promise.resolve();
      await settle();
      for (const entry of conversions) if (!entry.answered) { entry.answered = true; entry.resolve(); }
      await settle();
    }
  };
  return { context, state, base, conversions, resizes, log, glCanvas, controllerStub, idleCallbacks,
    normalTarget, handlers, input, answerAll, runTimers, nextFrame, timers };
}

const bytesEqual = (a, b) => a.width === b.width && a.height === b.height && Buffer.compare(Buffer.from(a.data), Buffer.from(b.data)) === 0;
const pixels = image => image.width * image.height;

// ---- Parity: outside a reduced session nothing is sized differently ----
{
  const f = fixture();
  // The code the tier replaced, kept here as the reference.
  const referenceSize = (image, maxDimension = 8192) => displayPreviewSize(image.width, image.height, {
    viewportWidth: CONTAINER.width - 20 || 1280, viewportHeight: CONTAINER.height - 20 || 900,
    dpr: DPR, zoom: f.state.zoomLevel, maxDimension });
  for (const zoom of [1, 1.5, 3, 8]) {
    f.state.zoomLevel = zoom;
    for (const [w, h] of [[3000, 2000], [9504, 6336], [1200, 800], [640, 4000]]) {
      const image = { width: w, height: h };
      assert.deepEqual(f.context.getDisplayPreviewSize(image), referenceSize(image), `normal size ${w}x${h} @${zoom}`);
      assert.deepEqual(f.context.getDisplayPreviewSize(image, 2048), referenceSize(image, 2048));
    }
  }
  f.state.zoomLevel = 1;
  // The old inline check in rerenderWithCoreControls against its replacement.
  const reference = (state) => {
    const target = referenceSize(state.conversionSourceImageData);
    if (state.conversionPreviewImageData?.width !== target.width || state.conversionPreviewImageData?.height !== target.height) {
      state.conversionPreviewImageData = resizeDisplayPreview(state.conversionSourceImageData, target);
    }
  };
  for (const zoom of [1, 2.5]) {
    f.state.zoomLevel = zoom;
    const expected = { ...f.state };
    reference(expected);
    f.context.ensureConversionPreviewForDisplay();
    assert.ok(bytesEqual(f.state.conversionPreviewImageData, expected.conversionPreviewImageData), `same conversion preview @${zoom}`);
    const kept = f.state.conversionPreviewImageData;
    f.context.ensureConversionPreviewForDisplay();
    assert.equal(f.state.conversionPreviewImageData, kept, 'a preview of the right size is kept as the same object');
  }
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
  if (largePreviewFrames) {
    assert.equal(tier.during.resizes[0].from, tier.normalPreview, 'the reduced preview is resampled from the normal one, not the source');
  }
  assert.equal(tier.during.resizes.length, 1, `${label}: the reduced preview is built once per session`);
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
  f.state.zoomLevel = 2;
  f.context.scheduleDisplayPreviewResize();
  const before = f.conversions.length;
  f.runTimers();
  await f.answerAll();
  assert.equal(f.conversions.length, before, 'no display resize inside a reduced session');
  f.context.onPreviewTierChange('normal');
  // The kept preview no longer fits the new zoom: the settle builds one.
  f.runTimers();
  await f.answerAll();
  const expected = displayPreviewSize(3000, 2000, { viewportWidth: 1100, viewportHeight: 620, dpr: DPR, zoom: 2, maxDimension: 8192 });
  assert.equal(f.state.conversionPreviewImageData.width, expected.width);
  assert.equal(f.context.displayIsReduced(), false);
}

// ---- Known-slow hosts pre-build the reduced preview when idle ----
{
  const f = fixture();
  const normalPreview = f.state.conversionPreviewImageData;
  f.controllerStub.nextStartTier = 'reduced';
  f.context.schedulePreviewTierPrebuild();
  f.context.schedulePreviewTierPrebuild();
  assert.equal(f.idleCallbacks.length, 1, 'one pending pre-build');
  f.idleCallbacks[0]();
  const prebuilt = f.context.previewTierPrebuilt;
  assert.equal(prebuilt?.base, normalPreview);
  assert.ok(pixels(prebuilt.image) <= PREVIEW_TIER_REDUCED_MAX_PIXELS);
  const resizes = f.resizes.length;
  f.context.onPreviewTierChange('reduced');
  await f.input(5);
  assert.equal(f.resizes.length, resizes, 'the first reduced tick resamples nothing');
  assert.equal(f.conversions.at(-1).input, prebuilt.image);
  assert.equal(f.context.previewTierPrebuilt, null);
  // Hosts that start normal build nothing ahead.
  const g = fixture();
  g.context.schedulePreviewTierPrebuild();
  assert.equal(g.idleCallbacks.length, 0);
  // A frame landing outside a session schedules it (the settle after load).
  const h = fixture();
  h.controllerStub.nextStartTier = 'reduced';
  h.context.applyPreviewProcessedImageToState(convertPixels(h.state.conversionPreviewImageData, 1));
  assert.equal(h.idleCallbacks.length, 1, 'a settled frame schedules the idle pre-build');
  h.controllerStub.active = true;
  h.context.previewTierPrebuildHandle = null;
  h.context.applyPreviewProcessedImageToState(convertPixels(h.state.conversionPreviewImageData, 2));
  assert.equal(h.idleCallbacks.length, 1, 'frames inside a session do not');
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

console.log('previewTierWiring: reduced sessions show <= 1 MP, settle byte-identical to the normal path, keep history normal and skip the old photo');

// Test-only fixture for the GPU preview's settle paths in main.js (#239, #229
// review R1-046 to R1-048): the real reprocess scheduler, preview lane,
// retained-plane commit, GPU take test and profile loader run in a vm against
// a fake clock, with the real GPU scheduler. Conversions, plane commits, GPU
// draws and profile loads are recorded and answered by the test. Never
// imported by the app.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createCoreReprocessGates, previewDispatchAction, CORE_FULL_REPROCESS_DELAY_MS } from './coreReprocessDispatcher.js';
import { routeCoreConversion, keepsFullPlaneOnDowngrade } from './fullResolutionRouting.js';
import { createGpuPreviewScheduler, GPU_INPUT_RETRY_MS } from './gpuPreviewScheduler.js';
import { displaySessionStubs, DISPLAY_SESSION_HELPERS } from './displaySessionHarness.mjs';

export const mainSource = readFileSync(new URL('./main.js', import.meta.url), 'utf8');

export function mainFunction(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(mainSource);
  assert.ok(match, `runtime function exists: ${name}`);
  const end = mainSource.indexOf('\n    }', match.index);
  assert.ok(end > match.index, `runtime function closes: ${name}`);
  return mainSource.slice(match.index, end + '\n    }'.length);
}

// A handler main.js wires inline (`addEventListener('change', event => {`
// after `getElementById('<id>')`), as a function of `event` named `name`.
export function listenerFunction(id, name) {
  const head = new RegExp(`getElementById\\('${id}'\\)\\??\\.addEventListener\\('\\w+', (?:function \\(\\)|\\(\\) =>|event =>) \\{`);
  const match = head.exec(mainSource);
  assert.ok(match, `${id} has a listener`);
  const body = match.index + match[0].length;
  return `function ${name}(event) {${mainSource.slice(body, mainSource.indexOf('\n    });', body))}\n    }`;
}

export const settle = () => new Promise(setImmediate);

export function fakeClock() {
  let nextId = 1;
  const timers = new Map();
  const frames = new Map();
  const clock = {
    now: 0, timers, frames, hidden: false,
    timeline: { currentTime: 1000 },
    setTimeout: (callback, delay = 0) => { const id = nextId++; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => { timers.delete(id); },
    requestAnimationFrame: callback => { const id = nextId++; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => { frames.delete(id); },
    isHidden: () => clock.hidden,
    nextFrame() { clock.timeline.currentTime += 1000 / 60; },
    runFrame() {
      clock.nextFrame();
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(clock.timeline.currentTime);
    },
    // Runs the timers armed with `delay` (all when omitted).
    runTimers(delay) {
      const due = [...timers.entries()].filter(([, timer]) => delay === undefined || timer.delay === delay);
      for (const [id] of due) timers.delete(id);
      for (const [, timer] of due) timer.callback();
    },
    armed(delay) { return [...timers.values()].filter(timer => delay === undefined || timer.delay === delay).length; },
  };
  return clock;
}

const SETTLE_FUNCTIONS = [
  ...DISPLAY_SESSION_HELPERS,
  'coreReprocessBusy', 'whenCoreReprocessIdle', 'noteCoreReprocessSettled', 'runCoreReprocess',
  'rerenderWithCoreControls', 'postPendingPreviewEarly', 'hasSeparateConversionPreview',
  'cancelScheduledFullResolutionRender', 'scheduleCoreReprocess', 'takeScheduledCoreReprocess',
  'fireCoreReprocessGate', 'clearCoreReprocessTimer', 'flushScheduledCoreReprocess',
  'retainCorePreviewPlane', 'armCorePreviewCommitTimer', 'releaseCorePreviewRetained', 'requestCorePreviewCommit',
  'retainingPreviewComing', 'corePreviewQueued', 'maybeCommitCorePreviewPlane', 'settleCorePreviewWaiters',
  'settleCorePreviewPlane', 'settleCoreInput', 'histogramSourceFor', 'currentConvertedPreviewSource',
  'displayResizeOrigin', 'displayResizeReplaces', 'postGpuSettleFrame', 'ensureConversionPreviewForDisplay',
  'routeCoreRequest', 'beginFullResolutionConversion', 'endFullResolutionConversion',
  'abortSupersededFullResolutionConversion', 'scheduleSilverSourceRefresh',
  'gpuPreviewCanTake', 'gpuProfileLoaded', 'gpuProfileReady', 'gpuObjectId',
];

// A Step-3 frame with a separate display preview, the GPU path ready for it
// (prepared texture and analysis of this preview, generation and mode), and
// the preset's 3D profile `profile` (none by default).
export function gpuSettleFixture({ profile = 'none' } = {}) {
  const clock = fakeClock();
  const noop = () => {};
  const state = {
    conversionSourceImageData: { width: 400, height: 300, name: 'source' },
    conversionPreviewImageData: { width: 200, height: 150, name: 'preview' },
    processedImageData: { width: 200, height: 150, exposure: 0 }, processedImageDataIsPreview: true,
    previewSourceImageData: null, currentStep: 3, coreExposure: 0, coreEnhancedProfile: profile,
    repairStrokes: [], fullResolutionPending: false, beforeAfterActive: false, cropping: false,
    dustRemoval: { enabled: false, processing: false },
  };
  // What the draw needs besides the scheduler: `drawable` is false when
  // applyProgram fails for a reason the take test cannot see.
  const gpu = { usable: true, drawable: true, mode: 'color', tag: 'tag', prepares: 0, analyzes: 0 };
  const log = [];
  const conversions = [];
  const commits = [];
  const profileLoads = [];
  const applied = (processed) => {
    context.releaseCorePreviewRetained(processed);
    state.processedImageData = processed;
    state.processedImageDataIsPreview = true;
    log.push(`apply:${processed.exposure}`);
  };
  const context = vm.createContext({
    ...displaySessionStubs(),
    noteLiveFrame: noop, state, console: { error: noop, warn: noop, info: noop },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    performance: { now: () => clock.now },
    provisionalUnits: () => false,
    coreReprocessGates: createCoreReprocessGates(clock),
    previewDispatchAction, CORE_FULL_REPROCESS_DELAY_MS,
    CORE_RETAIN_PREVIEW_PLANE: true, CORE_PREVIEW_COMMIT_IDLE_MS: 150,
    corePreviewRetained: null, corePreviewCommit: null, corePreviewCommitWanted: false,
    corePreviewCommitTimer: null, corePreviewSettleWaiters: [],
    convertPreviewFrameInWorker: { commit: image => new Promise((resolve, reject) => {
      commits.push({ image, resolve, reject });
      log.push(`commit:${image.exposure}`);
    }) },
    buildPreviewSourceImageData: image => image,
    buildHistogramSourceImageData: image => ({ sampleOf: image }),
    webglState: { gl: null }, schedulePreviewUpdate: noop,
    coreReprocessTimer: null, coreReprocessScheduled: null,
    coreReprocessToken: 0, coreReprocessGeneration: 0,
    _coreReprocessFullInFlight: false, _coreReprocessPreviewInFlight: false,
    _coreReprocessPending: null, _coreReprocessActive: 0,
    _coreReprocessIdle: null, _resolveCoreReprocessIdle: null,
    coreSliderCommitRecord: null, fullResolutionRenderTimer: null,
    backgroundGate: { bump: noop }, WORKER_ABORTED: 'WORKER_ABORTED',
    usesSilverCoreConversion: () => true, hasFrameRepairs: () => false,
    routeCoreConversion, keepsFullPlaneOnDowngrade, isLargeImage: () => false, isAiBrushEnabled: () => false,
    fullResolutionConversionAbort: null, dustDetectionTimer: null,
    FULL_RESOLUTION_IDLE_DELAY_MS: 2500, ensureAiBrushPlane: noop,
    repairedPreviewShown: null, repairedPreviewMasks: null, repairedPreviewSourceFor: () => null, ensureRepairedPreview: noop,
    scheduleFullResolutionRender: noop, scheduleAutoConvertFromStep2: () => log.push('step2'),
    getDisplayPreviewSize: () => ({ width: 200, height: 150 }), displaySizeServes: () => true,
    scheduleDisplayPreviewResize: noop,
    previewTier: 'normal', previewTierKept: null, reducedDisplayImages: new WeakSet(),
    convertFromCurrentSource: (settings, options) => new Promise((resolve, reject) => {
      // The request reads live state when it starts, as the real one does.
      const entry = { exposure: state.coreExposure, token: context.coreReprocessToken,
        full: !options.interactive, retain16: Boolean(options.retain16), resolve, reject };
      conversions.push(entry);
      log.push(`convert:${entry.exposure}`);
    }),
    applyPreviewProcessedImageToState: applied, applyProcessedImageToState: applied,
    updatePreview: noop, updateFull: noop, scheduleFullUpdate: noop,
    resetDustForCleanSource: noop, scheduleDustDetection: noop, carryStudioThumbnailSource: noop,
    // #239: the GPU take test's inputs. The prepared texture and the analysis
    // are this preview's; the settings resolve to `gpu.mode` and the preset's profile.
    GPU_PREVIEW_MODE: 'auto', GPU_INPUT_RETRY_MS, gpuApplyUsable: () => gpu.usable,
    gpuObjectIds: new WeakMap(), gpuNextObjectId: 1,
    buildRouterSettings: () => ({ positiveEngine: 'silvercore' }),
    resolveConversionMode: () => gpu.mode,
    trySilverCoreParams: () => ({ enhancedProfile: state.coreEnhancedProfile }),
    gpuPreparedTag: () => gpu.tag,
    requestGpuPrepare: () => { gpu.prepares++; },
    requestGpuAnalyze: () => { gpu.analyzes++; },
    loadProfile: name => new Promise((resolve, reject) => {
      profileLoads.push({ name, resolve, reject });
      log.push(`load:${name}`);
    }),
  });
  vm.runInContext(SETTLE_FUNCTIONS.map(mainFunction).join('\n'), context);
  const previewId = context.gpuObjectId(state.conversionPreviewImageData);
  context.gpuPreview = {
    status: 'ready', engine: { enhancedLut: null }, lastDraw: null, lastFrame: null,
    prepared: { tag: 'tag', previewId, generation: 0 },
    analysis: { key: 'key', mode: 'color', previewId, generation: 0 },
    analysisFailed: null,
    profile: { name: 'none', lut: null, loading: null, failed: new Map() },
  };
  // renderWebGL2 at the animation frame: applyProgram when it can draw the
  // newest settings (texture, profile), else the exact frame with step3Program.
  context.gpuPreviewScheduler = createGpuPreviewScheduler({
    armFrame: fire => context.coreReprocessGates.armFrame(fire),
    cancelFrame: handle => context.coreReprocessGates.cancel(handle),
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    draw: () => {
      const drawn = gpu.drawable && context.gpuPreview.prepared.tag === gpu.tag
        && context.gpuProfileReady(state.coreEnhancedProfile);
      context.gpuPreview.lastDraw = drawn ? 'apply' : 'step3';
      log.push(`${drawn ? 'gpu' : 'step3'}:${state.coreExposure}`);
      return drawn;
    },
    postExact: token => context.postGpuSettleFrame(token),
    onIdle: () => context.noteCoreReprocessSettled(),
    onAbandon: () => log.push('abandon'),
  });
  // The frame a conversion of `entry` returns: the 8-bit planes, with the
  // 16-bit plane kept in the worker when it asked for that.
  const result = entry => ({ width: 200, height: 150, exposure: entry.exposure,
    ...(entry.retain16 ? { __retained16: true, __histogramSample: { sample: true } } : {}) });
  const answer = async (index = conversions.length - 1) => {
    conversions[index].resolve(result(conversions[index]));
    await settle();
  };
  return { context, state, gpu, clock, log, conversions, commits, profileLoads, result, answer };
}

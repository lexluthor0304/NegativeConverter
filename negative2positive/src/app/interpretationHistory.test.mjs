import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createExactGeometry } from './provisionalPhoto.js';
import * as provisionalHelpers from './provisionalPhoto.js';
import { makeBase, samePixels } from './geometryTestHarness.mjs';
import { convertFrameWithRouter } from '../pipeline/conversionRouter.js';
import { estimateAutoWhiteBalance } from './autoWhiteBalance.js';
import { filmInterpretationChanged } from './filmTypeOverride.js';
import { buildCropDetectionInput, workingPointsToBase } from './cropColorAnalysis.js';
import { routeCoreConversion, restoredFrameFlags } from './fullResolutionRouting.js';

// Reuse the real extraction, cloning, histogram, caller, router and rescue
// fixture without running its separate route matrix in this process.
const priorSelection = process.env.NC229_ROUTE_CASE;
process.env.NC229_ROUTE_CASE = 'history-fixture';
const { fixture, fn, base } = await import('./interpretationRoutes.test.mjs');
if (priorSelection === undefined) delete process.env.NC229_ROUTE_CASE;
else process.env.NC229_ROUTE_CASE = priorSelection;

const canon = value => JSON.parse(JSON.stringify(value));
const full = makeBase(128, 96, 3);
const interpretations = ['color', 'bw', 'positive'].flatMap(type => ['correct', 'edit'].map(mode => [type, mode]));
const selection = process.env.NC229_HISTORY_CASE || 'all';
let cases = 0;
// The worker is a controlled transport leaf. Dispatch, conversion requests,
// geometry, analysis sampling, kernels and warm history replay stay real.
async function measurementFixture(before = ['color', 'correct'], ownership = 'automatic', rescue = false, inputs = {}) {
  const f = await fixture({ ...inputs, type: before[0], mode: before[1] });
  const { context: c, target, state } = f;
  Object.assign(state, { expiredEnabled: rescue, semanticMap: ownership === 'semantic' ? state.semanticMap : null, wbSemanticApplied: ownership === 'semantic',
    wbUserOverride: ownership === 'manual', grayPointSampled: ownership === 'gray', coreExposure: 0,
    expiredBrightnessUserOverride: true, expiredContrastUserOverride: true });
  const requests = [], replays = [], errors = [];
  Object.assign(target, { routeCoreConversion, restoredFrameFlags, estimateAutoWhiteBalance, buildCropDetectionInput,
    workingPointsToBase, baseSizeSource: () => state.loadedBaseImageData,
    console: { ...console, error: (...args) => { errors.push(args); console.error(...args); } },
    quietLoadingOverlay: { show: async () => {}, updateProgress() {}, hide() {} },
    getLoadingOverlay: () => ({ show: async () => {}, updateProgress() {}, hide() {} }),
    HISTOGRAM_MAX_SAMPLES: 100000, _coreReprocessActive: 0, _coreReprocessFullInFlight: false,
    _coreReprocessPreviewInFlight: false, _coreReprocessPending: null, coreReprocessScheduled: null,
    repairedPreviewShown: null, repairedPreviewMasks: null, fullResolutionConversionAbort: null, CORE_RETAIN_PREVIEW_PLANE: false,
    conversionSourceSize: () => state.conversionSourceImageData || c.workingPlanes(),
    getImageDataPixelCount: image => image.width * image.height,
    buildPreviewSourceImageData: image => image,
    installDisplayFor: image => { state.previewSourceImageData = image; state.histogramSourceImageData = image; },
    goToStep: step => { state.currentStep = step; },
    convertFrameWithRouter,
    convertFrameOffMainThread: async request => {
      requests.push({ settings: canon(request.settings), options: request.options });
      if (f.holdConversion) await f.holdConversion(request);
      return c.convertRequestOnMain(request);
    }
  });
  target.convertPreviewFrameInWorker = target.convertFrameOffMainThread;
  vm.runInContext(['processNegative', 'convertFromCurrentSource', 'convertRequestOnMain', 'previewRequestImage',
    'automaticWhiteBalanceResult', 'maybeAutoWhiteBalance', 'provisionalWhiteBalanceMeasurement', 'autoWbSampleKey',
    'analysisRegionSample', 'getColorAnalysisSample', 'workingPlanes', 'renderGeometryChain', 'assertRepairCurrent',
    'applyProcessedImageToState', 'applyRestoredImageToState', 'routeCoreRequest', 'runCoreReprocess',
    'rerenderWithCoreControls', 'beginFullResolutionConversion', 'endFullResolutionConversion',
    'abortSupersededFullResolutionConversion'].map(fn).join('\n'), c);
  const replay = c.runCoreReprocess;
  target.runCoreReprocess = options => { const pending = replay(options); replays.push(pending); return pending; };
  target.scheduleSilverSourceRefresh = () => {
    target.coreReprocessToken++;
    target.runCoreReprocess({ full: true, token: target.coreReprocessToken, sourceRef: state.conversionSourceImageData });
  };
  const drainReplays = async () => { for (let i = 0; i < replays.length; i++) await replays[i]; };
  target.flushScheduledCoreReprocess = drainReplays;
  f.drain = async () => {
    await drainReplays();
    for (const callback of f.timers.splice(0)) await callback();
  };
  await c.processNegative({ automatic: false });
  assert.ok(state.processedImageData?.__image16, 'actual caller/kernel produced a true16 positive');
  return Object.assign(f, { requests, replays, errors });
}

async function cropMeasurementReference(f, settings) {
  const { context: c } = f;
  const source = await c.renderGeometryChain(base, settings, { isCurrent: () => true });
  const processed = await convertFrameWithRouter({ imageData: source, settings: c.buildRouterSettings(settings, base),
    options: { forceFullProcess: true, includeAnalysisPreview: true, analysisImageData: c.getColorAnalysisSample(settings, base) } });
  const result = c.automaticWhiteBalanceResult(processed, settings, { meta: settings.autoFrameMeta, base, wbSample: null });
  return { settings: { ...settings, ...result }, result };
}
async function strictMeasurementPixels(f, reference, label) {
  const { context: c, state } = f;
  const saved = c.cloneSettings(c.extractCurrentSettings());
  const differences = [];
  for (const depth of [8, 16]) {
    const actual = await c.processFileWithSettings(f.file, saved, { sourceImageData: base, bitDepth: depth, updateItemSettings: false });
    const expected = await c.processFileWithSettings(f.file, reference.settings, { sourceImageData: base, bitDepth: depth, updateItemSettings: false });
    assert.equal(actual.width, 56); assert.equal(actual.height, 40);
    const a = depth === 16 ? actual.__image16.data : actual.data, b = depth === 16 ? expected.__image16.data : expected.data;
    differences.push(a.reduce((sum, value, i) => sum + Number(value !== b[i]), 0));
    if (depth === 16) assert.ok(a.some((v, i) => i % 4 !== 3 && v % 257), 'true16 low bits');
    const live = f.adjusted(state.processedImageData, { ...state, autoFrameMeta: state.autoFrame.lastDiagnostics }, depth);
    assert.deepEqual(Array.from(depth === 16 ? live.__image16.data : live.data), Array.from(a), label + ': actual replay/live/batch');
  }
  console.log(`${label} WB=${[state.wbR, state.wbG, state.wbB]} reference=${[reference.settings.wbR, reference.settings.wbG, reference.settings.wbB]} differences=${differences}`);
  assert.deepEqual(differences, [0, 0], label + ': strict production 8/16 samples');
  assert.deepEqual([state.wbR, state.wbG, state.wbB, state.wbAutoConfidence],
    [reference.settings.wbR, reference.settings.wbG, reference.settings.wbB, reference.settings.wbAutoConfidence], label + ': measured WB ownership');
}

if (selection === 'all' || selection === 'crop-review-exact') {
  const f = await measurementFixture(), { context: c, state, target } = f;
  await c.applyGeometryFromBase({ cropRegion: { left: 0, top: 0, width: 56, height: 40 } });
  state.autoFrame.lastDiagnostics = { ...state.autoFrame.lastDiagnostics, analysisNeedsReview: true };
  let release;
  const held = new Promise(resolve => { release = resolve; });
  target.runOpenCvTask = async (_kind, options) => { await options.build(); await held;
    return [{ x: 2, y: 2 }, { x: 50, y: 2 }, { x: 50, y: 35 }, { x: 2, y: 35 }]; };
  const detection = c.startCropDetection({ meta: state.autoFrame.lastDiagnostics, base,
    frame: c.geometryFrameSize(base, 0), cropRegion: state.cropRegion, ready: state.geometryReady });
  await c.processNegative();
  f.listeners.bw(); await f.drain();
  await c.processNegative();
  release(); await detection.settled;
  assert.deepEqual(f.errors, [], 'actual dispatch/completion has no harness/runtime errors');
  const color = target.undoStack.at(-1).settings;
  const reference = await cropMeasurementReference(f, { ...color, autoFrameMeta: { ...color.autoFrameMeta, ...detection.token.hit.fields } });
  assert.ok(reference.result && reference.result.wbR !== 1, 'real old-color reference is measurably nonunit');
  await c.performUndo(); await f.drain();
  await strictMeasurementPixels(f, reference, 'pending color->BW actual warm Undo');
  await c.performRedo(); await f.drain();
  const bw = c.cloneSettings(c.extractCurrentSettings());
  await strictMeasurementPixels(f, { settings: { ...bw, wbR: 1, wbG: 1, wbB: 1 } }, 'pending color->BW actual warm Redo');
  f.pool.dispose(); cases++;
}

// The complete crop matrix has separate rescue OFF/ON test entries so npm's
// unchanged 120-second per-file deadline covers each bounded real-kernel run.
if (selection === 'crop-events') {
  const rescueCases = [false, true].filter(value => process.env.NC229_HISTORY_CROP_RESCUE === undefined
    || value === (process.env.NC229_HISTORY_CROP_RESCUE === 'on'));
  for (const before of interpretations) for (const after of interpretations) for (const rescue of rescueCases)
    for (const ownership of ['automatic', 'manual', 'gray', 'semantic']) for (const timing of ['pending', 'applied']) {
    const label = `${timing} crop ${before.join('/')} -> ${after.join('/')} ${ownership} rescue=${rescue}`;
    const f = await measurementFixture(before, ownership, rescue), { context: c, state, target } = f;
    await c.applyGeometryFromBase({ cropRegion: { left: 0, top: 0, width: 56, height: 40 } });
    state.autoFrame.lastDiagnostics = { ...state.autoFrame.lastDiagnostics, analysisNeedsReview: true };
    let release;
    const held = new Promise(resolve => { release = resolve; });
    target.runOpenCvTask = async (_kind, options) => { await options.build(); await held;
      return [{ x: 2, y: 2 }, { x: 50, y: 2 }, { x: 50, y: 35 }, { x: 2, y: 35 }]; };
    const detection = c.startCropDetection({ meta: state.autoFrame.lastDiagnostics, base,
      frame: c.geometryFrameSize(base, 0), cropRegion: state.cropRegion, ready: state.geometryReady });
    await c.processNegative();
    if (timing === 'applied') { release(); await detection.settled; }
    const old = c.cloneSettings(c.extractCurrentSettings());
    let edits = 0;
    if (before[0] !== after[0]) { f.listeners[after[0]](); await f.drain(); edits++; }
    if (before[1] !== after[1]) { f.listeners.mode({ target: { value: after[1] } }); await f.drain(); edits++; }
    await c.processNegative();
    const newer = c.cloneSettings(c.extractCurrentSettings());
    c.pushUndo('exposure'); state.exposure = .2;
    release(); await detection.settled;
    const withHit = settings => ({ ...settings, autoFrameMeta: { ...settings.autoFrameMeta, ...detection.token.hit.fields } });
    const oldReference = await cropMeasurementReference(f, withHit(old));
    const newReference = await cropMeasurementReference(f, withHit(newer));
    await c.performUndo(); await f.drain();
    await strictMeasurementPixels(f, newReference, label + ' new-entry Undo');
    for (let i = 0; i < edits; i++) { await c.performUndo(); await f.drain(); }
    await strictMeasurementPixels(f, oldReference, label + ' old-entry Undo');
    for (let i = 0; i < edits + 1; i++) { await c.performRedo(); await f.drain(); }
    await strictMeasurementPixels(f, { ...newReference, settings: { ...newReference.settings, exposure: .2 } }, label + ' Redo');
    assert.deepEqual(f.errors, [], label + ': no swallowed caller errors');
    assert.deepEqual(canon(state.filmBase), canon(old.filmBase), label + ': manual base');
    assert.deepEqual([state.expiredBrightness, state.expiredContrast], [17, 23], label + ': explicit strengths');
    assert.equal(state.expiredBrightnessUserOverride, true); assert.equal(state.expiredContrastUserOverride, true);
    if (!filmInterpretationChanged(old, newer)) assert.deepEqual(canon(state.semanticMap), canon(old.semanticMap), label + ': matching anchors');
    const saved = c.cloneSettings(c.extractCurrentSettings());
    assert.deepEqual([saved.wbR, saved.wbG, saved.wbB], [newReference.settings.wbR, newReference.settings.wbG, newReference.settings.wbB], label + ': saved WB');
    f.pool.dispose(); cases++;
  }
}

if (selection === 'all' || selection === 'input-ownership') {
  for (const input of ['filmBase', 'semanticMap', 'rollFrame']) {
    const f = await measurementFixture(['color', 'correct'], 'automatic', false, input === 'rollFrame' ? { roll: {} } : {});
    const { context: c, state, target } = f;
    await c.applyGeometryFromBase({ cropRegion: { left: 0, top: 0, width: 56, height: 40 } });
    state.autoFrame.lastDiagnostics = { ...state.autoFrame.lastDiagnostics, analysisNeedsReview: true };
    let release;
    const held = new Promise(resolve => { release = resolve; });
    target.runOpenCvTask = async (_kind, options) => { await options.build(); await held;
      return [{ x: 2, y: 2 }, { x: 50, y: 2 }, { x: 50, y: 35 }, { x: 2, y: 35 }]; };
    const detection = c.startCropDetection({ meta: state.autoFrame.lastDiagnostics, base,
      frame: c.geometryFrameSize(base, 0), cropRegion: state.cropRegion, ready: state.geometryReady });
    await c.processNegative();
    const old = c.cloneSettings(c.extractCurrentSettings());
    c.pushUndo(input);
    if (input === 'filmBase') state.filmBase = { r: 219, g: 187, b: 136, method: 'manual' };
    if (input === 'semanticMap') state.semanticMap = structuredClone(f.old.semanticMap);
    if (input === 'rollFrame') state.rollFrame = { ...state.rollFrame, offsetStops: state.rollFrame.offsetStops + .35 };
    await c.processNegative();
    const newer = c.cloneSettings(c.extractCurrentSettings());
    c.pushUndo('exposure'); state.exposure = .2;
    release(); await detection.settled;
    const withHit = settings => ({ ...settings, autoFrameMeta: { ...settings.autoFrameMeta, ...detection.token.hit.fields } });
    const oldReference = await cropMeasurementReference(f, withHit(old));
    const newReference = await cropMeasurementReference(f, withHit(newer));
    await c.performUndo(); await f.drain();
    await strictMeasurementPixels(f, newReference, `pending ${input} new-entry Undo`);
    await c.performUndo(); await f.drain();
    await strictMeasurementPixels(f, oldReference, `pending ${input} old-entry Undo`);
    assert.deepEqual(canon(state[input]), canon(old[input]), 'matching historical measurement input retained');
    await c.performRedo(); await f.drain();
    await strictMeasurementPixels(f, newReference, `pending ${input} new-entry Redo`);
    assert.deepEqual(canon(state[input]), canon(newer[input]), 'matching new measurement input retained');
    assert.deepEqual(f.errors, [], 'actual input/history caller errors');
    f.pool.dispose(); cases++;
  }
}

if (selection === 'all' || selection === 'held-measurements') {
  const crossings = [
    [['color', 'correct'], ['bw', 'correct']], [['color', 'correct'], ['positive', 'correct']],
    [['color', 'correct'], ['color', 'edit']], [['positive', 'correct'], ['positive', 'edit']],
    [['bw', 'correct'], ['color', 'correct']], [['positive', 'edit'], ['color', 'edit']]
  ];
  for (const [before, after] of crossings) for (const rescue of [false, true])
    for (const ownership of ['automatic', 'manual', 'gray', 'semantic']) for (const timing of ['dispatch', 'replay']) {
    const label = `held ${timing} ${before.join('/')} -> ${after.join('/')} ${ownership} rescue=${rescue}`;
    const f = await measurementFixture(before, ownership, rescue), { context: c, state, target } = f;
    await c.applyGeometryFromBase({ cropRegion: { left: 0, top: 0, width: 56, height: 40 } });
    state.autoFrame.lastDiagnostics = { ...state.autoFrame.lastDiagnostics, analysisNeedsReview: true };
    let releaseDetection;
    const detector = new Promise(resolve => { releaseDetection = resolve; });
    target.runOpenCvTask = async (_kind, options) => { await options.build(); await detector;
      return [{ x: 2, y: 2 }, { x: 50, y: 2 }, { x: 50, y: 35 }, { x: 2, y: 35 }]; };
    const detection = c.startCropDetection({ meta: state.autoFrame.lastDiagnostics, base,
      frame: c.geometryFrameSize(base, 0), cropRegion: state.cropRegion, ready: state.geometryReady });
    await c.processNegative();
    const old = c.cloneSettings(c.extractCurrentSettings());
    let entered, releaseConversion, held = false;
    const started = new Promise(resolve => { entered = resolve; });
    const conversion = new Promise(resolve => { releaseConversion = resolve; });
    const holdOne = () => { f.holdConversion = async request => {
      if (held) return;
      held = true; entered(canon(request.settings)); await conversion;
    }; };
    let edits = 0;
    const change = async () => {
      if (before[0] !== after[0]) { f.listeners[after[0]](); await f.drain(); edits++; }
      if (before[1] !== after[1]) { f.listeners.mode({ target: { value: after[1] } }); await f.drain(); edits++; }
    };
    if (timing === 'dispatch') {
      holdOne(); releaseDetection();
      const dispatched = await started;
      assert.deepEqual([dispatched.filmType, dispatched.positiveMode], before, 'held request retains dispatched interpretation');
      await change();
      if (!rescue && ownership === 'automatic' && after[0] === 'bw') {
        c.pushUndo('coreExposure'); state.coreExposure = 15; target.scheduleSilverSourceRefresh(); await f.drain(); edits++;
      }
    } else {
      releaseDetection(); await detection.settled;
      await change(); await c.processNegative();
    }
    const newer = c.cloneSettings(c.extractCurrentSettings());
    c.pushUndo('exposure'); state.exposure = .2;
    if (timing === 'dispatch') {
      releaseConversion(); await detection.settled; await f.drain();
    } else {
      holdOne(); await c.performUndo();
      const dispatched = await started;
      assert.deepEqual([dispatched.filmType, dispatched.positiveMode], after, 'actual warm replay dispatch');
      const lateType = after[0] === 'bw' ? 'color' : 'bw';
      f.listeners[lateType]();
      releaseConversion(); await f.drain();
      const late = c.cloneSettings(c.extractCurrentSettings());
      const gains = ownership === 'manual' || ownership === 'gray' ? [1.17, 1, .86] : [1, 1, 1];
      await strictMeasurementPixels(f, { settings: { ...late, wbR: gains[0], wbG: gains[1], wbB: gains[2] } }, label + ' superseding replay');
      await c.performUndo(); await f.drain();
    }
    const withHit = settings => ({ ...settings, autoFrameMeta: { ...settings.autoFrameMeta, ...detection.token.hit.fields } });
    const oldReference = await cropMeasurementReference(f, withHit(old));
    const newReference = await cropMeasurementReference(f, withHit(newer));
    if (timing === 'dispatch') { await c.performUndo(); await f.drain(); }
    await strictMeasurementPixels(f, newReference, label + ' new-entry Undo');
    for (let i = 0; i < edits; i++) { await c.performUndo(); await f.drain(); }
    await strictMeasurementPixels(f, oldReference, label + ' old-entry Undo');
    for (let i = 0; i < edits; i++) { await c.performRedo(); await f.drain(); }
    await strictMeasurementPixels(f, newReference, label + ' new-entry Redo');
    assert.deepEqual(f.errors, [], label + ': actual caller/replay errors');
    assert.ok(f.requests.every(request => request.settings.filmType && request.settings.positiveMode), 'real request carries both interpretation fields');
    f.pool.dispose(); cases++;
  }
  for (const late of ['type', 'mode', 'manual', 'gray', 'semantic']) {
    const f = await measurementFixture(), { context: c, state, target } = f;
    await c.applyGeometryFromBase({ cropRegion: { left: 0, top: 0, width: 56, height: 40 } });
    state.autoFrame.lastDiagnostics = { ...state.autoFrame.lastDiagnostics, analysisNeedsReview: true };
    let releaseDetection, entered, releaseMeasurement, measured = false;
    const detector = new Promise(resolve => { releaseDetection = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const measurement = new Promise(resolve => { releaseMeasurement = resolve; });
    target.runOpenCvTask = async (_kind, options) => { await options.build(); await detector;
      return [{ x: 2, y: 2 }, { x: 50, y: 2 }, { x: 50, y: 35 }, { x: 2, y: 35 }]; };
    const detection = c.startCropDetection({ meta: state.autoFrame.lastDiagnostics, base,
      frame: c.geometryFrameSize(base, 0), cropRegion: state.cropRegion, ready: state.geometryReady });
    await c.processNegative();
    const old = c.cloneSettings(c.extractCurrentSettings());
    f.listeners.bw(); await f.drain(); await c.processNegative();
    let edits = 1;
    f.holdConversion = async request => {
      if (request.settings.filmType !== 'color' || measured) return;
      measured = true; entered(); await measurement;
    };
    releaseDetection(); await started;
    if (late === 'type') { f.listeners.positive(); edits++; }
    else if (late === 'mode') { f.listeners.mode({ target: { value: 'edit' } }); edits++; }
    else {
      c.pushUndo('wbR'); edits++;
      Object.assign(state, { wbR: 1.42, wbG: 1, wbB: .77, wbAutoConfidence: null,
        wbUserOverride: late === 'manual', grayPointSampled: late === 'gray', wbSemanticApplied: late === 'semantic' });
    }
    releaseMeasurement(); await detection.settled; await f.drain();
    if (!['type', 'mode'].includes(late)) assert.deepEqual([state.wbR, state.wbG, state.wbB], [1.42, 1, .77], 'live lock survives awaited historical conversion');
    for (let i = 0; i < edits; i++) { await c.performUndo(); await f.drain(); }
    const reference = await cropMeasurementReference(f, { ...old, autoFrameMeta: { ...old.autoFrameMeta, ...detection.token.hit.fields } });
    await strictMeasurementPixels(f, reference, `held historical conversion, late ${late} actual Undo`);
    for (let i = 0; i < edits; i++) { await c.performRedo(); await f.drain(); }
    const saved = c.cloneSettings(c.extractCurrentSettings());
    const gains = ['type', 'mode'].includes(late) ? [1, 1, 1] : [1.42, 1, .77];
    await strictMeasurementPixels(f, { settings: { ...saved, wbR: gains[0], wbG: gains[1], wbB: gains[2] } }, `held historical conversion, late ${late} actual Redo`);
    assert.deepEqual(f.errors, [], 'awaited historical caller errors');
    f.pool.dispose(); cases++;
  }
}
async function historyFixture(before, ownership = 'automatic') {
  const f = await fixture({ type: before[0], mode: before[1], roll: {} });
  const { context: c, state, target } = f;
  Object.assign(state, { wbSemanticApplied: false, wbUserOverride: ownership === 'manual', grayPointSampled: ownership === 'gray',
    expiredBrightnessUserOverride: true, expiredContrastUserOverride: true });
  f.old = c.extractCurrentSettings();
  const geometry = createExactGeometry({ size: { width: 64, height: 48 }, fullSize: { width: 128, height: 96 } });
  geometry.project(f.old);
  Object.assign(target, provisionalHelpers, { filmInterpretationChanged, estimateAutoWhiteBalance,
    buildCropDetectionInput, workingPointsToBase,
    fullResolutionRenderAbort: null, twoStageDiagnostics: { swaps: 0 }, noteFullDecodeChange() {},
    baseSizeSource: () => state.loadedBaseImageData,
    // The small real router result is the worker leaf; all analysis and
    // history/geometry code below is production, including immutable events.
    convertFromCurrentSource: async (settings = state) => convertFrameWithRouter({
      imageData: state.conversionSourceImageData || state.loadedBaseImageData,
      settings: c.buildRouterSettings(settings, state.loadedBaseImageData),
      options: { forceFullProcess: true, includeAnalysisPreview: true,
        analysisImageData: c.getColorAnalysisSample(settings, state.loadedBaseImageData) }
    }),
    processNegative: async ({ automatic = true } = {}) => {
      await c.whenGeometrySettled();
      state.conversionSourceImageData = c.workingPlanes();
      state.processedImageData = await target.convertFromCurrentSource();
      state.previewSourceImageData = state.processedImageData;
      if (automatic) await c.maybeAutoWhiteBalance(state.processedImageData);
      c.maybeAnalyzeExpiredRescue(state.processedImageData);
    }
  });
  vm.runInContext(['liveGeometry', 'rebaseProvisionalHistory', 'promoteWhiteBalanceMeasurement', 'installFullDecode',
    'provisionalWhiteBalanceMeasurement', 'restorePromotedWhiteBalance', 'automaticWhiteBalanceResult',
    'maybeAutoWhiteBalance', 'analysisRegionSample', 'restoreColdSnapshotPixels', 'getColorAnalysisSample', 'windowFrameMetaOnFull',
    'renderGeometryChain', 'assertRepairCurrent', 'workingPlanes', 'hasPendingCropDetection', 'settlePendingCropDetection'].map(fn).join('\n'), c);
  geometry.installed(c.liveGeometry());
  const record = { status: 'decoded', decodedImage: full };
  const provisional = { size: { width: 64, height: 48 }, fullSize: { width: 128, height: 96 }, geometry,
    settledSnapshot: c.cloneSettings(f.old), swapped: false, record };
  state.provisional = provisional;
  return { ...f, record, provisional };
}
async function exactBatch(f, expectedGains, label) {
  const { context: c, state } = f;
  const saved = c.cloneSettings(c.extractCurrentSettings());
  for (const depth of [8, 16]) {
    const actual = await c.processFileWithSettings(f.file, c.cloneSettings(saved), { sourceImageData: full, bitDepth: depth, updateItemSettings: false });
    const reference = await c.processFileWithSettings(f.file, c.cloneSettings({ ...saved,
      wbR: expectedGains[0], wbG: expectedGains[1], wbB: expectedGains[2] }), { sourceImageData: full, bitDepth: depth, updateItemSettings: false });
    const a = depth === 16 ? actual.__image16.data : actual.data, b = depth === 16 ? reference.__image16.data : reference.data;
    const differing = a.reduce((n, v, i) => n + Number(v !== b[i]), 0);
    console.log(`${label} ${depth}-bit differing samples=${differing}`);
    assert.deepEqual(Array.from(a), Array.from(b), `${label}: strict ${depth}-bit production batch samples`);
    const live = f.adjusted(state.processedImageData, { ...state, autoFrameMeta: state.autoFrame.lastDiagnostics }, depth);
    assert.equal(live.width, actual.width, 'live/full export width'); assert.equal(live.height, actual.height, 'live/full export height');
    assert.deepEqual(Array.from(live.data), Array.from(actual.data), `${label}: exact live/production batch 8-bit samples`);
    if (depth === 16) {
      samePixels(actual, reference, `${label}: live recipe/real batch`);
      samePixels(live, actual, `${label}: exact live/production batch 16-bit samples`);
      assert.ok(a.some((value, i) => i % 4 !== 3 && value % 257), 'true 16-bit result retains low bits');
    }
  }
  assert.deepEqual([state.wbR, state.wbG, state.wbB], expectedGains, `${label}: live WB ownership`);
}

if (selection === 'all' || selection === 'pending-events') {
  for (const timing of ['pending', 'applied']) for (const change of ['type', 'mode', 'matching']) for (const stack of ['undo', 'redo']) {
    const f = await historyFixture(['color', 'correct']), { context: c, state, target } = f;
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    target.runOpenCvTask = async (_kind, options) => {
      await options.build(); entered(); await held;
      return [{ x: 4, y: 4 }, { x: 20, y: 4 }, { x: 20, y: 20 }, { x: 4, y: 20 }];
    };
    const ready = c.applyGeometryFromBase({ cropRegion: { left: 0, top: 0, width: 32, height: 32 } });
    state.autoFrame.lastDiagnostics = { ...state.autoFrame.lastDiagnostics, analysisNeedsReview: true };
    const detection = c.startCropDetection({ meta: state.autoFrame.lastDiagnostics, base: state.loadedBaseImageData,
      frame: c.geometryFrameSize(state.loadedBaseImageData, 0), cropRegion: state.cropRegion, ready });
    await started;
    assert.equal(detection.whiteBalance.positiveMode, 'correct', 'pending WB owns its original positive mode');
    assert.equal(detection.whiteBalance.filmType, 'color', 'pending WB owns its original film type');
    const event = c.provisionalWhiteBalanceMeasurement(detection.whiteBalance);
    if (timing === 'applied') { release(); await detection.settled; }
    if (change === 'type') f.listeners.bw();
    if (change === 'mode') f.listeners.mode({ target: { value: 'edit' } });
    c.pushUndo('exposure'); state.coreExposure = 23;
    // A completed WB reply retains the event's immutable recipe. The
    // pending route carries the preceding event while its token is unresolved.
    f.provisional.whiteBalanceMeasurement = event;
    if (stack === 'redo') await c.performUndo();
    c.installFullDecode(f.record, f.provisional, full, c.cloneSettings(f.old));
    release(); await detection.settled; await c.whenGeometrySettled();
    state.provisional = null;
    await target.processNegative();
    await (stack === 'redo' ? c.performRedo() : c.performUndo());
    const gains = change === 'matching' ? [1.17, 1, .86] : [1, 1, 1];
    await exactBatch(f, gains, `${timing} ${change} cold ${stack}`);
    f.pool.dispose(); cases++;
  }
}

if (selection === 'all' || selection === 'geometry') {
  for (const after of [['bw', 'correct'], ['positive', 'correct'], ['color', 'edit']]) for (const stack of ['undo', 'redo']) {
    const f = await historyFixture(['color', 'correct']), { context: c, state, target } = f;
    await c.applyRotation(90);
    await c.applyMirror();
    await c.applyGeometryFromBase({ cropRegion: { left: 4, top: 6, width: 32, height: 40 } });
    if (after[0] !== 'color') f.listeners[after[0]]();
    if (after[1] !== 'correct') f.listeners.mode({ target: { value: after[1] } });
    c.pushUndo('exposure'); state.coreExposure = 23;
    if (stack === 'redo') await c.performUndo();
    c.installFullDecode(f.record, f.provisional, full, c.cloneSettings(f.old));
    await c.whenGeometrySettled(); state.provisional = null;
    await target.processNegative();
    await (stack === 'redo' ? c.performRedo() : c.performUndo());
    assert.equal(state.rotationAngle, 90); assert.equal(state.mirrored, true);
    assert.deepEqual(canon(state.cropRegion), { left: 8, top: 12, width: 64, height: 80 }, 'exact full-base crop through rotation/mirror');
    await exactBatch(f, [1, 1, 1], `geometry ${after.join('/')} cold ${stack}`);
    f.pool.dispose(); cases++;
  }
}
for (const before of interpretations) for (const after of interpretations) for (const ownership of ['automatic', 'manual', 'gray']) {
  const label = `${before.join('/')} -> ${after.join('/')} ${ownership}`;
  if (selection === 'review-exact' && label !== 'color/correct -> bw/correct automatic') continue;
  if (!['all', 'review-exact'].includes(selection)) continue;
  const f = await historyFixture(before, ownership), { context: c, state, target, old } = f;
  const crossing = filmInterpretationChanged(old, { filmType: after[0], positiveMode: after[1] });
  if (before[0] !== after[0]) f.listeners[after[0]]();
  if (before[1] !== after[1]) f.listeners.mode({ target: { value: after[1] } });
  c.pushUndo('exposure'); state.coreExposure = 23;
  c.installFullDecode(f.record, f.provisional, full, c.cloneSettings(old));
  await c.whenGeometrySettled();
  assert.equal(target.twoStageDiagnostics.swaps, 1, 'actual full source installation');
  state.provisional = null;
  const gains = crossing && ownership === 'automatic' ? [1, 1, 1] : [old.wbR, old.wbG, old.wbB];
  await target.processNegative();
  await exactBatch(f, gains, `${label} live full install`);
  await c.performUndo();
  assert.equal(state.filmType, after[0]); assert.equal(state.positiveMode, after[1]);
  assert.equal(state.coreExposure, 19, 'actual Undo restores post-interpretation exposure entry');
  if (crossing) {
    assert.equal(state.semanticMap, null, 'promoted entry cannot restore old semantic anchors');
    assert.equal(state.rollFrame, null, 'promoted entry cannot restore old histogram/density');
    assert.notDeepEqual(canon(state.expiredAnalysis), canon(old.expiredAnalysis), 'new interpretation measures its own full positive');
  } else {
    assert.deepEqual(canon(state.semanticMap), canon(old.semanticMap), 'matching completed anchors survive');
    assert.deepEqual(canon(state.rollFrame), canon(old.rollFrame), 'matching histogram/density survives');
    assert.deepEqual(canon(state.expiredAnalysis), canon(old.expiredAnalysis), 'matching paired rescue survives');
  }
  await exactBatch(f, gains, `${label} Undo`);
  await c.performRedo();
  assert.equal(state.coreExposure, 23, 'actual Redo restores later edit');
  await exactBatch(f, gains, `${label} Redo`);
  assert.deepEqual(canon(state.filmBase), canon(old.filmBase), 'explicit film base survives promotion/replay');
  assert.deepEqual([state.expiredBrightness, state.expiredContrast], [old.expiredBrightness, old.expiredContrast], 'explicit measured-equal strengths survive');
  assert.equal(state.expiredBrightnessUserOverride, true); assert.equal(state.expiredContrastUserOverride, true);
  const extracted = c.extractCurrentSettings();
  const cloned = c.cloneSettings(extracted);
  assert.equal(cloned.filmType, after[0]); assert.equal(cloned.positiveMode, after[1]);
  assert.deepEqual([cloned.wbR, cloned.wbG, cloned.wbB], gains, 'saved recipe cannot reinstate old derived gains');
  f.pool.dispose(); cases++;
}

// A stored event may share the baseline's type/mode, and therefore have no
// interpretation fields in windowEdits. Full import must not relabel it.
if (selection === 'all' || selection === 'automatic-full') {
  for (const [before, after] of [
    [['color', 'correct'], ['bw', 'correct']], [['color', 'correct'], ['positive', 'correct']],
    [['bw', 'correct'], ['color', 'correct']], [['positive', 'correct'], ['bw', 'correct']],
    [['positive', 'correct'], ['positive', 'edit']]
  ]) {
    const f = await historyFixture(before), { context: c, state, target } = f;
    f.provisional.whiteBalanceMeasurement = c.provisionalWhiteBalanceMeasurement(state);
    c.pushUndo('exposure'); state.coreExposure = 23;
    const settled = c.applyInterpretationPatch(c.applyAutomaticFilmType(c.cloneSettings(f.old), {
      filmType: after[0], confidence: .94, reason: 'rollMonochrome'
    }), { positiveMode: after[1] });
    c.installFullDecode(f.record, f.provisional, full, settled);
    await c.whenGeometrySettled();
    const event = f.provisional.fullBaseWhiteBalance;
    assert.equal(event.settings.filmType, before[0]); assert.equal(event.settings.positiveMode, before[1]);
    await c.restorePromotedWhiteBalance(event, () => true);
    state.provisional = null; await target.processNegative();
    await c.performUndo();
    assert.equal(state.filmType, after[0]); assert.equal(state.positiveMode, after[1]);
    await exactBatch(f, [1, 1, 1], `automatic full ${before.join('/')} -> ${after.join('/')} Undo`);
    await c.performRedo();
    await exactBatch(f, [1, 1, 1], `automatic full ${before.join('/')} -> ${after.join('/')} Redo`);
    f.pool.dispose(); cases++;
  }
}
if (selection === 'all' || selection === 'event-provenance') {
  for (const before of interpretations) for (const after of interpretations) {
    const f = await historyFixture(before), { context: c, state, target, old } = f;
    const measurement = c.provisionalWhiteBalanceMeasurement(state);
    const settled = c.applyInterpretationPatch(c.cloneSettings(old), { filmType: after[0], positiveMode: after[1] });
    const promoted = c.promoteWhiteBalanceMeasurement(measurement, f.provisional, full, settled);
    assert.equal(promoted.settings.filmType, before[0], 'immutable event preserves film interpretation through promotion');
    assert.equal(promoted.settings.positiveMode, before[1], 'immutable event preserves positive mode through promotion');
    Object.assign(state, settled);
    let converted = 0;
    const convert = target.convertFromCurrentSource;
    target.convertFromCurrentSource = (...args) => { converted++; return convert(...args); };
    await c.restorePromotedWhiteBalance(promoted, () => true);
    assert.equal(converted, filmInterpretationChanged(old, settled) ? 0 : 1, 'only matching event may replay');
    assert.deepEqual([state.wbR, state.wbG, state.wbB], filmInterpretationChanged(old, settled) ? [1, 1, 1] : [old.wbR, old.wbG, old.wbB]);
    f.pool.dispose(); cases++;
  }
  for (const lateEdit of ['mode', 'type', 'manual', 'gray', 'semantic']) {
    const f = await historyFixture(['positive', 'correct']), { context: c, state, target } = f;
    const measurement = c.promoteWhiteBalanceMeasurement(c.provisionalWhiteBalanceMeasurement(state), f.provisional, full, c.cloneSettings(f.old));
    const convert = target.convertFromCurrentSource;
    target.convertFromCurrentSource = async settings => {
      const frame = await convert(settings);
      if (lateEdit === 'mode') state.positiveMode = 'edit';
      else if (lateEdit === 'type') state.filmType = 'bw';
      else if (lateEdit === 'manual') state.wbUserOverride = true;
      else if (lateEdit === 'gray') state.grayPointSampled = true;
      else state.wbSemanticApplied = true;
      return frame;
    };
    const original = target.automaticWhiteBalanceResult;
    let estimates = 0;
    target.automaticWhiteBalanceResult = (...args) => { estimates++; return original(...args); };
    await c.restorePromotedWhiteBalance(measurement, () => true);
    assert.equal(estimates, 0, 'asynchronous replay rechecks mode/type and user ownership before estimation');
    f.pool.dispose(); cases++;
  }
}
console.log(`interpretationHistory: ${cases} real full-install/Undo/Redo and immutable-measurement cases; exact production 8/16 samples`);

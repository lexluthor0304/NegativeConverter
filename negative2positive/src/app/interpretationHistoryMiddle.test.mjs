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
    'automaticWhiteBalanceResult', 'maybeAutoWhiteBalance', 'whiteBalanceMeasurementSettings', 'provisionalWhiteBalanceMeasurement', 'autoWbSampleKey',
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
  let expiredAnalysis = settings.expiredAnalysis;
  if (settings.expiredEnabled) {
    const sample = c.expiredAnalysisSample(processed, settings, base);
    expiredAnalysis = f.target.analyzeExpiredFilm(sample.image, { ...sample.options, anchors: settings.semanticMap, placement: sample.placement });
    assert.ok(expiredAnalysis, 'independent intermediate rescue measurement exists');
  }
  return { settings: { ...settings, ...result, expiredAnalysis }, result };
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


// Every intermediate pending history recipe must settle its own automatic
// WB. Actual controls/capture/Undo/Redo, caller and production 8/16 kernels.
for (const rescue of [false, true]) for (const ownership of ['automatic', 'manual', 'gray', 'semantic'])
  for (const kind of ['type', 'mode', 'filmBase', 'semanticMap', 'rollFrame']) {
  const before = kind === 'type' ? ['bw', 'correct'] : ['color', 'correct'];
  const f = await measurementFixture(before, ownership, rescue, kind === 'rollFrame' ? { roll: {} } : {});
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
  const offset = state.rollFrame?.offsetStops || 0;
  const edit = async last => {
    if (kind === 'type') f.listeners[last ? 'positive' : 'color']();
    else if (kind === 'mode') {
      if (last) f.listeners.bw();
      else f.listeners.mode({ target: { value: 'edit' } });
    } else {
      c.pushUndo(kind);
      if (kind === 'filmBase') state.filmBase = last
        ? { r: 211, g: 179, b: 127, method: 'manual' } : { r: 219, g: 187, b: 136, method: 'manual' };
      if (kind === 'semanticMap') state.semanticMap = { ...structuredClone(f.old.semanticMap), confidence: last ? .8 : .95 };
      if (kind === 'rollFrame') state.rollFrame = { ...state.rollFrame, offsetStops: offset + (last ? .7 : .35) };
    }
    await f.drain();
    await c.processNegative();
  };
  await edit(false);
  const middle = c.cloneSettings(c.extractCurrentSettings());
  await edit(true);
  const final = c.cloneSettings(c.extractCurrentSettings());
  release(); await detection.settled;
  const withHit = recipe => ({ ...recipe, autoFrameMeta: { ...recipe.autoFrameMeta, ...detection.token.hit.fields } });
  const middleReference = await cropMeasurementReference(f, withHit(middle));
  const finalReference = await cropMeasurementReference(f, withHit(final));
  for (let round = 0; round < 2; round++) {
    await c.performUndo(); await f.drain();
    await strictMeasurementPixels(f, middleReference, `${kind} ${ownership} rescue=${rescue} intermediate Undo ${round}`);
    for (const key of ['filmType', 'positiveMode', 'expiredEnabled', 'wbUserOverride', 'grayPointSampled']) {
      assert.equal(state[key], middle[key], 'middle entry keeps ' + key);
    }
    for (const key of ['filmBase', 'semanticMap', 'rollFrame']) {
      assert.deepEqual(canon(state[key]), canon(middle[key]), 'middle entry keeps ' + key);
    }
    assert.deepEqual([state.expiredBrightness, state.expiredContrast], [17, 23], 'explicit strengths preserved');
    assert.equal(state.expiredBrightnessUserOverride, true);
    assert.equal(state.expiredContrastUserOverride, true);
    await c.performRedo(); await f.drain();
    await strictMeasurementPixels(f, finalReference, `${kind} ${ownership} rescue=${rescue} final Redo ${round}`);
  }
  assert.deepEqual(f.errors, [], 'no hidden caller or harness failure');
  f.pool.dispose();
}
console.log('interpretationHistoryMiddle: 40 actual intermediate type/mode/base/semantic/roll recipes across rescueOFF/ON and automatic/manual/gray/semantic ownership; repeated Undo/Redo; exact live/batch8/16 samples');

import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createExactGeometry } from './provisionalPhoto.js';
import * as provisionalHelpers from './provisionalPhoto.js';
import { makeBase, samePixels } from './geometryTestHarness.mjs';
import { convertFrameWithRouter } from '../pipeline/conversionRouter.js';
import { estimateAutoWhiteBalance } from './autoWhiteBalance.js';
import { filmInterpretationChanged } from './filmTypeOverride.js';
import { buildCropDetectionInput, workingPointsToBase } from './cropColorAnalysis.js';

// Reuse the real extraction, cloning, histogram, caller, router and rescue
// fixture without running its separate route matrix in this process.
const priorSelection = process.env.NC229_ROUTE_CASE;
process.env.NC229_ROUTE_CASE = 'history-fixture';
const { fixture, fn } = await import('./interpretationRoutes.test.mjs');
if (priorSelection === undefined) delete process.env.NC229_ROUTE_CASE;
else process.env.NC229_ROUTE_CASE = priorSelection;

const canon = value => JSON.parse(JSON.stringify(value));
const full = makeBase(128, 96, 3);
const interpretations = ['color', 'bw', 'positive'].flatMap(type => ['correct', 'edit'].map(mode => [type, mode]));
const selection = process.env.NC229_HISTORY_CASE || 'all';
let cases = 0;
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
      if (automatic) c.maybeAutoWhiteBalance(state.processedImageData);
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

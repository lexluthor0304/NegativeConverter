import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { createHarness, makeBase, samePixels } from './geometryTestHarness.mjs';
import { createExactGeometry, windowEdits, overlayWindowEdits, analysisAreaEdited, confirmedImageArea } from './provisionalPhoto.js';
import { resolveAnalysisRegion, imageAreaFromWorkingRect } from './analysisRegion.js';
import { workingPointsToBase, buildCropDetectionInput, isSameAnalysisFrame } from './cropColorAnalysis.js';
import { estimateAutoWhiteBalance } from './autoWhiteBalance.js';
import { deepCopySanitizedSettings } from './settingsSnapshot.js';
import { filmInterpretationChanged } from './filmTypeOverride.js';
import { applyPreparedAdjustmentsToBuffer, applyPreparedAdjustmentsToBuffer16, stripLegacyToneSettingsForSilverCore } from './adjustmentPipeline.js';
import { convertColorWithSilverCore } from '../pipeline/silverAdapter.js';
import { analyzeExpiredFilm, defaultExpiredRescueParams, EXPIRED_RESCUE_DEFAULTS, EXPIRED_RESCUE_KEYS } from '../pipeline/expiredRescue.js';
import { createConversionWorkerClient } from './conversionWorkerClient.js';

// Real history capture, source installation, restore, undo/redo, geometry,
// Silver conversion, automatic WB and 8/16 adjustment samples. Detection is a leaf.
const source = readFileSync(process.env.NC229_CALLER_SOURCE || new URL('./main.js', import.meta.url), 'utf8');
const fn = name => {
  const pattern = new RegExp(`^    (?:async )?function ${name}\\(`, 'm');
  // A frozen earlier caller never invokes the new provenance helpers.
  const body = pattern.test(source) ? source : readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  const start = pattern.exec(body)?.index;
  assert.notEqual(start, undefined, name);
  return body.slice(start, body.indexOf('\n    }', start) + 6);
};
const canon = value => JSON.parse(JSON.stringify(value));
const full = makeBase(64, 48, 39), standIn = makeBase(32, 24, 79);
const area = (left, top, right, bottom) => [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }];
const fullMeta = { imageArea: area(.08, .06, .92, .94), method: 'hough', confidence: .93, appliedMode: 'crop', importAuto: true,
  detectedFormat: '135', confidenceLevel: 'high', rotateOnly: false, lowConfidenceApplied: false,
  analysisArea: null, analysisNeedsReview: false, frameIncomplete: false };
const standInMeta = { imageArea: area(.14, .12, .86, .88), method: 'hough', confidence: .77, appliedMode: 'crop', importAuto: true };
const rect = { left: 0, top: 0, width: 20, height: 16 };
const fullRect = { left: 0, top: 0, width: 40, height: 32 };
const fullFilmBase = { r: 228, g: 194, b: 144, method: 'auto' };
const standInFilmBase = { r: 210, g: 184, b: 150, method: 'auto' };
const manualFilmBase = { r: 208, g: 188, b: 156, method: 'manual' };
function fixture(staged, manualWb = false) {
  const h = createHarness(staged ? standIn : full, { realProcessNegative: true });
  const { context: c, target, state } = h;
  Object.assign(state, { filmType: 'color', positiveMode: 'correct', exposure: 0, coreExposure: 0, expiredEnabled: false,
    wbR: 1, wbG: 1, wbB: 1, wbAutoConfidence: null, wbSemanticApplied: false, wbUserOverride: false, grayPointSampled: false,
    semanticMap: null, filmBase: { ...(staged ? standInFilmBase : fullFilmBase) }, currentStep: 3,
    autoFrame: { lastDiagnostics: structuredClone(staged ? standInMeta : fullMeta) } });
  // restoreSettings treats saved user WB as sampled too; use that canonical
  // recipe in both fixtures so ownership comparisons test the same state.
  if (manualWb) Object.assign(state, { wbR: 1.17, wbG: 1, wbB: .83, wbUserOverride: true, grayPointSampled: true });
  const detections = [], held = [], conversionReplies = [], dispatched = [];
  Object.assign(target, { createExactGeometry, windowEdits, overlayWindowEdits, analysisAreaEdited, confirmedImageArea,
    resolveAnalysisRegion, imageAreaFromWorkingRect, workingPointsToBase, buildCropDetectionInput, isSameAnalysisFrame,
    estimateAutoWhiteBalance, deepCopySanitizedSettings, stripLegacyToneSettingsForSilverCore, filmInterpretationChanged, cropHitHold: false,
    usesSilverCoreConversion: () => true,
    // Use real geometry pixels and WB sampling; no display-sized stand-in.
    convertFromCurrentSource: async (settings = state) => {
      const recipe = canon(settings === state ? target.extractCurrentSettings() : settings);
      const processed = convertColorWithSilverCore(state.conversionSourceImageData,
        { filmBase: settings.filmBase, colorModel: 'standard', filmPreset: 'none', borderBuffer: 0, exposure: settings.coreExposure },
        { analysisImageData: c.getColorAnalysisSample(settings === state ? { ...settings, autoFrameMeta: state.autoFrame.lastDiagnostics } : settings) });
      dispatched.push(recipe);
      if (target.holdConversion?.({ live: settings === state, recipe })
        || target.conversionHold && (!target.measurementHold || recipe.coreExposure === 15)) await new Promise(resolve => {
        Object.assign(resolve, { live: settings === state, recipe });
        conversionReplies.push(resolve);
      });
      return processed;
    },
    buildRouterSettings: settings => settings,
    convertFrameOffMainThread: async ({ imageData, settings, options }) => convertColorWithSilverCore(imageData,
      { filmBase: settings.filmBase, colorModel: 'standard', filmPreset: 'none', borderBuffer: 0, exposure: settings.coreExposure },
      { analysisImageData: options.analysisImageData }),
    runOpenCvTask: async (_kind, options) => {
      await options.build();
      const base = state.loadedBaseImageData;
      detections.push({ base, crop: { ...state.cropRegion } });
      if (target.cropHitHold) await new Promise(resolve => held.push(resolve));
      if (target.cropMiss) return null;
      return base === standIn ? area(2, 2, 17, 13) : area(9, 7, 33, 27);
    },
    extractCurrentSettings: () => {
      const s = c.captureSnapshot('settings').settings;
      return state.provisional && !state.provisional.swapped ? { ...s, ...state.provisional.geometry.toExact(s) } : s;
    },
    getUndoLabel: label => label, inferConfidenceLevel: () => 'high', MAX_UNDO: 30 });
  vm.runInContext(['liveGeometry', 'rebaseProvisionalHistory', 'windowFrameMetaOnFull', 'windowFrameIntent', 'frameMetaWithWindowIntent',
    'installFullDecode', 'restoreAutoFrameDiagnostics', 'automaticWhiteBalanceResult', 'maybeAutoWhiteBalance', 'frameWantsAutoWhiteBalance', 'cropMeasurementInputs', 'cropMeasurementInputsMatch', 'analysisRegionSample',
    'whiteBalanceMeasurementSettings', 'provisionalWhiteBalanceMeasurement', 'promoteWhiteBalanceMeasurement', 'restorePromotedWhiteBalance',
    'restoreColdSnapshotPixels', 'hasPendingCropDetection', 'settlePendingCropDetection',
    'cancelGeometryJob', 'restoreSettings', 'pushUndo', 'resetAllAdjustments',
    'waitForProvisionalSwap', 'startCropDetection', 'applyCropDetectionOutcome', 'resolvePendingFrameEdits', 'cloneSettings', 'renderGeometryChain',
    'buildAdjustmentSettings', 'processNegative', 'captureSnapshot', 'restoreSnapshot'].map(fn).join('\n'), c);
  c.restoreAutoFrameDiagnostics(staged ? standInMeta : fullMeta);
  return { ...h, detections, held, conversionReplies, dispatched };
}
async function apply(h, crop, { held = false, analysisOnly = false, selectedArea = null } = {}) {
  const { context: c, state, target } = h;
  c.pushUndo('crop');
  const base = state.loadedBaseImageData;
  const selected = selectedArea || imageAreaFromWorkingRect(crop, state, base);
  const applied = c.appliedCropDiagnostics(state.autoFrame.lastDiagnostics, { selectedArea: selected, base, analysisOnly,
    previous: { ...state, frame: state.originalImageData } });
  c.recordProvisionalFrameEdit(selected, { analysisOnly, detect: applied.detect });
  state.autoFrame.lastDiagnostics = applied.meta;
  target.cropHitHold = held;
  const ready = analysisOnly ? Promise.resolve(true) : c.applyGeometryFromBase({ cropRegion: crop });
  if (applied.detect) c.startCropDetection({ meta: applied.meta, base, frame: c.geometryFrameSize(base, 0), cropRegion: crop, ready });
  await ready;
  await c.processNegative();
}
async function land(h) {
  h.target.cropHitHold = false;
  for (let i = 0; i < 8 && !h.held.length; i++) await new Promise(setImmediate);
  h.held.splice(0).forEach(resolve => resolve());
  await h.context.settlePendingCropDetection();
}
function samples(h, depth) {
  const source = h.state.processedImageData;
  const out = { width: source.width, height: source.height, data: new Uint8ClampedArray(source.data.length) };
  const identity = Uint8Array.from({ length: 256 }, (_, i) => i);
  const settings = h.context.buildAdjustmentSettings({ wbR: h.state.wbR, wbG: h.state.wbG, wbB: h.state.wbB, exposure: h.state.exposure,
    curves: { r: identity, g: identity, b: identity } });
  (depth === 16 ? applyPreparedAdjustmentsToBuffer16 : applyPreparedAdjustmentsToBuffer)(source, settings, out);
  return depth === 16 ? Array.from(out.__image16.data) : Array.from(out.data);
}
const selected = process.argv[2] || 'all';
let cases = 0;
for (const timing of ['pending-hit', 'completed-hit', 'confirmation']) for (const stack of ['undo', 'redo']) for (const manualWb of [false, true]) for (const manualBase of [false, true]) {
  if (selected !== 'all' && selected !== `${timing}-${stack}`) continue;
  const h = fixture(true, manualWb), { context: c, state } = h;
  const baseline = h.target.extractCurrentSettings();
  const record = { decodedImage: full, status: 'decoded' };
  const provisional = { size: { width: 32, height: 24 }, fullSize: { width: 64, height: 48 },
    geometry: createExactGeometry({ size: { width: 32, height: 24 }, fullSize: { width: 64, height: 48 } }), settledSnapshot: baseline, record };
  state.provisional = provisional;
  const confirmation = timing === 'confirmation' ? area(.2, .25, .8, .75) : null;
  await apply(h, rect, { held: timing === 'pending-hit', analysisOnly: Boolean(confirmation), selectedArea: confirmation });
  if (timing !== 'pending-hit') await c.settlePendingCropDetection();
  if (manualBase) state.filmBase = { ...manualFilmBase };
  c.pushUndo('exposure');
  state.exposure = 27;
  state.coreExposure = 15;
  await c.processNegative({ automatic: false });
  if (timing === 'pending-hit') await land(h);
  if (stack === 'redo') await c.performUndo();
  const settled = { ...baseline, autoFrameMeta: structuredClone(fullMeta), filmBase: { ...fullFilmBase }, cropRegion: null };
  c.installFullDecode(record, provisional, full, settled);
  await c.whenGeometrySettled();
  await c.processNegative();
  await c.settlePendingCropDetection();
  if (provisional.fullBaseWhiteBalance) await c.restorePromotedWhiteBalance(provisional.fullBaseWhiteBalance, () => true);
  state.provisional = null;
  record.status = 'installed';
  const promoted = [...h.target.undoStack, ...h.target.redoStack].filter(s => s.label === 'exposure');
  assert.ok(promoted.length, 'real exposure history survived source promotion');
  const reference = fixture(false, manualWb);
  await apply(reference, fullRect, { held: timing === 'pending-hit', analysisOnly: Boolean(confirmation), selectedArea: confirmation });
  if (timing !== 'pending-hit') await reference.context.settlePendingCropDetection();
  if (manualBase) reference.state.filmBase = { ...manualFilmBase };
  reference.context.pushUndo('exposure');
  Object.assign(reference.state, { exposure: 27, coreExposure: 15 });
  await reference.context.processNegative({ automatic: false });
  if (timing === 'pending-hit') await land(reference);
  if (stack === 'redo') await reference.context.performUndo();
  await reference.context.processNegative({ automatic: false });
  const restored = stack === 'undo' ? c.performUndo() : c.performRedo();
  // Exact consumers must wait for history's full-base analysis, not see the
  // entry's stand-in hit while an asynchronous restore runs.
  await c.settlePendingCropDetection();
  await restored;
  await (stack === 'undo' ? reference.context.performUndo() : reference.context.performRedo());
  await reference.context.processNegative({ automatic: false });
  assert.deepEqual(canon(state.filmBase), canon(reference.state.filmBase), 'automatic film base promotes; manual film base stays');
  assert.deepEqual(canon(state.autoFrame.lastDiagnostics), canon(reference.state.autoFrame.lastDiagnostics), `${timing}/${stack}: restored full-base diagnostics`);
  assert.deepEqual([state.wbR, state.wbG, state.wbB], [reference.state.wbR, reference.state.wbG, reference.state.wbB], 'full-base automatic WB');
  samePixels(state.processedImageData, reference.state.processedImageData, 'exact restored geometry/conversion samples');
  for (const depth of [8, 16]) assert.deepEqual(samples(h, depth), samples(reference, depth), `${depth}-bit adjustment samples match one stage`);
  await (stack === 'undo' ? c.performRedo() : c.performUndo());
  await c.settlePendingCropDetection();
  await (stack === 'undo' ? reference.context.performRedo() : reference.context.performUndo());
  await reference.context.processNegative({ automatic: false });
  await c.processNegative({ automatic: false });
  assert.deepEqual([state.wbR, state.wbG, state.wbB], [reference.state.wbR, reference.state.wbG, reference.state.wbB],
    `${timing}/${stack}/manual WB ${manualWb}/manual base ${manualBase}: opposite history WB`);
  for (const depth of [8, 16]) assert.ok(Buffer.from(new Uint16Array(samples(h, depth)).buffer).equals(Buffer.from(new Uint16Array(samples(reference, depth)).buffer)),
    `${timing}/${stack}/manual WB ${manualWb}/manual base ${manualBase}: exact ${depth}-bit samples after opposite history action`);
  assert.ok(h.detections.every(d => d.base === standIn || d.base === full));
  h.pool.dispose(); reference.pool.dispose();
  cases++;
}
if (selected === 'all') for (const timing of ['pending-hit', 'completed-hit']) {
  const h = fixture(true), reference = fixture(false), { context: c, state } = h;
  const baseline = h.target.extractCurrentSettings();
  const record = { decodedImage: full, status: 'decoded' };
  const provisional = { size: { width: 32, height: 24 }, fullSize: { width: 64, height: 48 },
    geometry: createExactGeometry({ size: { width: 32, height: 24 }, fullSize: { width: 64, height: 48 } }), settledSnapshot: baseline, record };
  state.provisional = provisional;
  for (const item of [h, reference]) {
    await item.context.processNegative();
    await apply(item, null, { analysisOnly: true, selectedArea: area(.2, .25, .8, .75) });
    await apply(item, item === h ? rect : fullRect, { held: timing === 'pending-hit' });
    if (timing === 'completed-hit') await item.context.settlePendingCropDetection();
    item.context.pushUndo('exposure');
    item.state.coreExposure = 15;
    await item.context.processNegative({ automatic: false });
    if (timing === 'pending-hit') await land(item);
  }
  const settled = { ...baseline, autoFrameMeta: structuredClone(fullMeta), filmBase: { ...fullFilmBase }, cropRegion: null };
  c.installFullDecode(record, provisional, full, settled);
  await c.whenGeometrySettled(); await c.processNegative(); await c.settlePendingCropDetection();
  await c.restorePromotedWhiteBalance(provisional.fullBaseWhiteBalance, () => true);
  state.provisional = null; record.status = 'installed';
  for (const action of ['Undo', 'Undo', 'Undo', 'Redo', 'Redo', 'Redo']) {
    await c[`perform${action}`](); await c.settlePendingCropDetection();
    await reference.context[`perform${action}`]();
    await reference.context.processNegative({ automatic: false });
    await c.processNegative({ automatic: false });
    assert.deepEqual(canon(state.autoFrame.lastDiagnostics), canon(reference.state.autoFrame.lastDiagnostics), `${timing}/${action}: entire Confirm/Crop/Exposure history diagnostics`);
    assert.deepEqual([state.wbR, state.wbG, state.wbB], [reference.state.wbR, reference.state.wbG, reference.state.wbB], `${timing}/${action}: measurement event's WB`);
    for (const depth of [8, 16]) assert.deepEqual(samples(h, depth), samples(reference, depth), `${timing}/${action}: entire history ${depth}-bit samples`);
  }
  h.pool.dispose(); reference.pool.dispose(); cases++;
}
if (selected === 'all' || selected === 'automatic-rescue') {
  // A WB event from before the user enabled rescue must not suppress the
  // other automatic measurements of a promoted cold entry's new full source.
  const h = fixture(false), { context: c, target, state } = h;
  Object.assign(state, EXPIRED_RESCUE_DEFAULTS, { expiredEnabled: true, expiredBrightness: 17,
    expiredContrast: 23, expiredNeutralize: 61, expiredAnalysis: null });
  Object.assign(target, { analyzeExpiredFilm, defaultExpiredRescueParams, EXPIRED_RESCUE_DEFAULTS, EXPIRED_RESCUE_KEYS,
    expiredAnalysisKey: 'stand-in', expiredTabPending: false, expiredSourceKey: () => 'full-history-source',
    expiredAnalysisSample: image => ({ image, options: {}, placement: { left: 0, top: 0, width: 1, height: 1 } }),
    runExpiredSpatialAnalysis: () => Promise.resolve(false) });
  vm.runInContext('SNAPSHOT_SCALAR_KEYS.push(...EXPIRED_RESCUE_KEYS)', c);
  vm.runInContext(['applyExpiredAnalysisDefaults', 'runExpiredAnalysis', 'maybeAnalyzeExpiredRescue'].map(fn).join('\n'), c);
  const snapshot = c.captureSnapshot('expired-core');
  snapshot.refs = { cold: true };
  snapshot.settings.fullBaseFrameEdit = { detect: false, automatic: true,
    whiteBalance: { settings: { filmType: 'color', expiredEnabled: false } } };
  await c.restoreSnapshot(snapshot);
  assert.ok(state.expiredAnalysis, 'promoted WB restoration also measures expired rescue on the full source');
  assert.deepEqual(state.expiredAnalysis, analyzeExpiredFilm(state.processedImageData,
    { anchors: null, placement: { left: 0, top: 0, width: 1, height: 1 } }), 'equals a fresh full-source rescue measurement');
  assert.deepEqual([state.expiredBrightness, state.expiredContrast, state.expiredNeutralize], [17, 23, 61], 'user rescue strengths survive');
  h.pool.dispose(); cases++;
}
for (const stack of ['undo', 'redo']) for (const wbMode of ['automatic', 'manual', 'late-manual', 'late-gray-point', 'late-semantic'])
  for (const manualBase of [false, true]) for (const outcome of ['hit', 'miss']) {
  if (selected !== 'all' && selected !== `pending-at-swap-${stack}`) continue;
  const manualWb = wbMode === 'manual';
  const h = fixture(true, manualWb), reference = fixture(false, manualWb), { context: c, state, target } = h;
  const baseline = target.extractCurrentSettings();
  const record = { decodedImage: full, status: 'decoded', urgent: true };
  const provisional = { size: { width: 32, height: 24 }, fullSize: { width: 64, height: 48 },
    geometry: createExactGeometry({ size: { width: 32, height: 24 }, fullSize: { width: 64, height: 48 } }), settledSnapshot: baseline, record };
  state.provisional = provisional;
  for (const item of [h, reference]) {
    item.target.cropMiss = outcome === 'miss';
    // Establish an earlier import measurement. The crop's measurement must
    // replace this event even though it has not produced a stand-in hit.
    await item.context.processNegative();
    await apply(item, item === h ? rect : fullRect, { held: true });
    for (let i = 0; i < 8 && !item.held.length; i++) await new Promise(setImmediate);
    assert.equal(item.held.length, 1, 'crop detector is explicitly held');
    assert.equal(item.target.cropDetection.token.hit, null, 'no crop hit before history capture');
    if (manualBase) item.state.filmBase = { ...manualFilmBase };
    item.context.pushUndo('exposure');
    Object.assign(item.state, { exposure: 27, coreExposure: 15 });
    await item.context.processNegative({ automatic: false });
    if (stack === 'redo') await item.context.performUndo();
    // Semantic colour is deferred until the full base. Test its live guard
    // there, rather than inventing semantic output on a provisional frame.
    if (wbMode.startsWith('late-') && (wbMode !== 'late-semantic' || item === reference)) Object.assign(item.state, { wbR: 1.17, wbG: 1, wbB: .83,
      ...(wbMode === 'late-manual' ? { grayPointSampled: true } : {}),
      ...(wbMode === 'late-semantic' ? { wbAutoConfidence: 'high' } : {}),
      [wbMode === 'late-manual' ? 'wbUserOverride' : wbMode === 'late-gray-point' ? 'grayPointSampled' : 'wbSemanticApplied']: true });
  }
  const old = target.cropDetection;
  if (process.env.NC229_HISTORY_TRACE) console.log('before swap', JSON.stringify({ event: Boolean(provisional.whiteBalanceMeasurement?.pending),
    previousExposure: provisional.whiteBalanceMeasurement?.previous?.settings.coreExposure, wb: [state.wbR, state.wbG, state.wbB] }));
  let cancelled = false;
  old.settled.then(() => { cancelled = true; });
  // Use the production admission caller. Never release/await the preview
  // detector here: promotion cancels it while its worker is still held.
  await c.waitForProvisionalSwap(record, provisional, () => true);
  assert.ok(cancelled, 'promotion cancelled the stand-in settlement barrier');
  assert.equal(old.token.hit, null, 'stand-in has no hit at the full-source swap');
  assert.equal(target.cropDetection, null, 'old detector no longer owns the current frame');
  assert.equal(h.held.length, 1, 'old worker remains held through promotion');
  target.cropHitHold = false;
  const settled = { ...baseline, autoFrameMeta: structuredClone(fullMeta), filmBase: { ...fullFilmBase }, cropRegion: null };
  c.installFullDecode(record, provisional, full, settled);
  if (wbMode === 'late-semantic') Object.assign(state, { wbR: 1.17, wbG: 1, wbB: .83, wbAutoConfidence: 'high', wbSemanticApplied: true });
  if (process.env.NC229_HISTORY_TRACE) console.log('installed', JSON.stringify({ event: Boolean(provisional.fullBaseWhiteBalance?.pending),
    bound: target.cropDetection?.whiteBalanceMeasurement === provisional.fullBaseWhiteBalance, detected: Boolean(target.cropDetection) }));
  await c.whenGeometrySettled(); await c.processNegative(); await c.settlePendingCropDetection();
  if (process.env.NC229_HISTORY_TRACE) console.log('full hit', JSON.stringify({ event: Boolean(provisional.fullBaseWhiteBalance?.pending),
    measuredExposure: provisional.fullBaseWhiteBalance?.measurement?.settings.coreExposure, wb: [state.wbR, state.wbG, state.wbB] }));
  assert.equal(old.token.hit, null, 'replacement settled without completing the cancelled token');
  assert.equal(target.cropDetectionStats.hits, outcome === 'hit' ? 1 : 0, 'only the full-base replacement may hit');
  assert.equal(target.cropDetectionStats.misses, outcome === 'miss' ? 1 : 0, 'replacement miss settles without a new measurement');
  assert.equal(h.detections.at(-1).base, full, 'replacement measured the full source');
  await c.restorePromotedWhiteBalance(provisional.fullBaseWhiteBalance, () => true);
  state.provisional = null; record.status = 'installed';
  await land(reference);
  // A hot Undo can still display its old plane while the core render is
  // queued. Exact export renders the restored recipe without remeasuring WB.
  await reference.context.processNegative({ automatic: false });
  const check = phase => {
    const label = `pending-at-swap/${stack}/${outcome}/${phase}/WB ${wbMode}/manual base ${manualBase}`;
    const hashes = item => Object.fromEntries([8, 16].map(depth => [depth,
      createHash('sha256').update(Buffer.from(new Uint16Array(samples(item, depth)).buffer)).digest('hex')]));
    const actual = hashes(h), expected = hashes(reference);
    if (actual[8] !== expected[8] || actual[16] !== expected[16]) console.log(label, JSON.stringify({
      wb: [state.wbR, state.wbG, state.wbB], referenceWb: [reference.state.wbR, reference.state.wbG, reference.state.wbB], actual, expected
    }));
    assert.deepEqual(canon(state.autoFrame.lastDiagnostics), canon(reference.state.autoFrame.lastDiagnostics), label + ': diagnostics');
    assert.deepEqual(canon(state.filmBase), canon(reference.state.filmBase), label + ': film base');
    assert.deepEqual([state.wbR, state.wbG, state.wbB, state.wbAutoConfidence],
      [reference.state.wbR, reference.state.wbG, reference.state.wbB, reference.state.wbAutoConfidence], label + ': WB event');
    assert.deepEqual([state.exposure, state.coreExposure], [reference.state.exposure, reference.state.coreExposure], label + ': exposure strengths');
    assert.deepEqual([state.wbUserOverride, state.grayPointSampled, state.wbSemanticApplied],
      [reference.state.wbUserOverride, reference.state.grayPointSampled, reference.state.wbSemanticApplied], label + ': WB ownership');
    samePixels(state.processedImageData, reference.state.processedImageData, label + ': Silver samples');
    for (const depth of [8, 16]) assert.deepEqual(samples(h, depth), samples(reference, depth), label + `: exact ${depth}-bit samples`);
  };
  check('live');
  const stale = target.cropDetectionStats.stale;
  h.held.splice(0).forEach(resolve => resolve());
  await old.done;
  assert.equal(target.cropDetectionStats.stale, stale + 1, 'cancelled late preview answer rejected');
  assert.equal(old.token.hit, null, 'late preview answer never becomes a saved measurement');
  check('late preview');
  for (const action of stack === 'undo' ? ['Undo', 'Redo'] : ['Redo', 'Undo']) {
    const restoring = c[`perform${action}`]();
    await c.settlePendingCropDetection(); await restoring;
    await reference.context[`perform${action}`]();
    await reference.context.processNegative({ automatic: false });
    await c.processNegative({ automatic: false });
    check(action);
  }
  h.pool.dispose(); reference.pool.dispose(); cases++;
}
for (const defect of ['conversion-in-flight', 'post-install-history', 'cold-undo-edit', 'cold-redo-edit', 'cold-wb-replay-edit']) for (const wbMode of ['automatic', 'late-manual', 'late-gray-point', 'late-semantic']) {
  if (selected !== 'all' && selected !== defect) continue;
  const historyRestore = defect.startsWith('cold-');
  const h = fixture(true), reference = fixture(false), { context: c, state, target } = h;
  const baseline = target.extractCurrentSettings();
  const record = { decodedImage: full, status: 'decoded', urgent: true };
  const provisional = { size: { width: 32, height: 24 }, fullSize: { width: 64, height: 48 },
    geometry: createExactGeometry({ size: { width: 32, height: 24 }, fullSize: { width: 64, height: 48 } }), settledSnapshot: baseline, record };
  state.provisional = provisional;
  for (const item of [h, reference]) {
    await item.context.processNegative();
    await apply(item, item === h ? rect : fullRect, { held: true });
    for (let i = 0; i < 8 && !item.held.length; i++) await new Promise(setImmediate);
    assert.equal(item.held.length, 1, 'preview/reference detector explicitly held');
    item.context.pushUndo('exposure');
    item.state.coreExposure = 15;
    await item.context.processNegative({ automatic: false });
  }
  const old = target.cropDetection;
  await c.waitForProvisionalSwap(record, provisional, () => true);
  assert.equal(old.token.hit, null, 'preview detector has no hit through promotion');
  assert.equal(h.held.length, 1, 'preview detector reply still held at swap');
  target.cropHitHold = false;
  c.installFullDecode(record, provisional, full, { ...baseline, autoFrameMeta: structuredClone(fullMeta), filmBase: { ...fullFilmBase }, cropRegion: null });
  await c.whenGeometrySettled(); await c.settlePendingCropDetection();
  assert.equal(target.cropDetection, null, 'full-source detector finishes before conversion dispatch');
  assert.ok(provisional.fullBaseWhiteBalance.hit, 'replacement hit owns the pending WB event');
  target.conversionHold = reference.target.conversionHold = true;
  const converting = c.processNegative();
  const referenceLanding = land(reference);
  for (let i = 0; i < 16 && (!h.conversionReplies.length || !reference.conversionReplies.length); i++) await new Promise(setImmediate);
  assert.equal(h.conversionReplies.length, 1, 'full-source conversion reply explicitly held');
  assert.equal(reference.conversionReplies.length, 1, 'single-stage conversion reply explicitly held');
  assert.equal(h.dispatched.at(-1).coreExposure, 15, 'staged pixels dispatched at exposure 15');
  assert.equal(reference.dispatched.at(-1).coreExposure, 15, 'reference pixels dispatched at exposure 15');
  for (const item of [h, reference]) {
    item.context.pushUndo('in-flight-exposure');
    item.state.coreExposure = 0;
    if (!historyRestore && wbMode !== 'automatic') Object.assign(item.state, { wbR: 1.17, wbG: 1, wbB: .83, wbAutoConfidence: 'high',
      [wbMode === 'late-manual' ? 'wbUserOverride' : wbMode === 'late-gray-point' ? 'grayPointSampled' : 'wbSemanticApplied']: true });
    item.target.conversionHold = false;
    item.conversionReplies.splice(0).forEach(resolve => resolve());
  }
  await converting; await referenceLanding;
  // Isolate the second defect: supply the correct dispatch recipe in memory
  // so an omitted post-install history event cannot hide behind recipe timing.
  if (defect === 'post-install-history') provisional.fullBaseWhiteBalance.measurement.settings.coreExposure = 15;
  await c.restorePromotedWhiteBalance(provisional.fullBaseWhiteBalance, () => true);
  state.provisional = null; record.status = 'installed';
  h.held.splice(0).forEach(resolve => resolve()); await old.done;
  let duringRestore = null;
  if (historyRestore) {
    const heldRestore = async action => {
      target.conversionHold = true;
      const restoring = c[`perform${action}`]();
      for (let i = 0; i < 32 && !h.conversionReplies.length; i++) await new Promise(setImmediate);
      assert.equal(h.conversionReplies.length, 1, action + ': cold history conversion reply explicitly held');
      if (target.measurementHold) assert.equal(h.conversionReplies[0].recipe.coreExposure, 15, 'only the immutable WB event measurement is held');
      assert.equal(state.provisional, null, 'promotion has finished before cold history rebuild');
      assert.ok(state.fullBaseHistoryPending, 'history barrier covers the held conversion');
      assert.equal(state.geometryPending, false, 'geometry finished before the new edit');
      assert.equal(target.cropDetection, null, 'detection finished before the new edit');
      return { restoring };
    };
    const release = () => {
      target.conversionHold = false;
      h.conversionReplies.splice(0).forEach(resolve => resolve());
    };
    if (defect === 'cold-redo-edit') {
      // A second Undo while the first cold rebuild waits captures its
      // unfinished state on Redo's stack. No history entry is manufactured.
      const first = await heldRestore('Undo');
      const second = c.performUndo();
      release();
      await first.restoring; await second; await c.settlePendingCropDetection();
      await reference.context.performUndo(); await reference.context.performUndo();
      await reference.context.processNegative({ automatic: false });
      assert.equal(target.redoStack.at(-1).refs.cold, true, 'Redo entry captured during the superseded cold Undo is cold');
    }
    if (defect === 'cold-wb-replay-edit') {
      await c.performUndo(); await c.settlePendingCropDetection();
      await reference.context.performUndo();
      // Only the off-state WB measurement reply is held: the restored
      // exposure-0 pixels have converted, but the exposure-15 event has not.
      target.measurementHold = true;
    }
    const action = defect === 'cold-redo-edit' ? 'Redo' : 'Undo';
    const { restoring } = await heldRestore(action);
    await reference.context[`perform${action}`]();
    const event = state.fullBaseFrameEdit;
    duringRestore = c.pushUndo('during-history-exposure');
    reference.context.pushUndo('during-history-exposure');
    assert.equal(duringRestore.settings.fullBaseFrameEdit.whiteBalance, event.whiteBalance, 'capture retains the same WB event');
    if (defect === 'cold-wb-replay-edit') {
      assert.equal(target.processNegativeInFlight, null, 'live pixels converted before the WB replay reply is held');
      assert.notDeepEqual([state.wbR, state.wbG, state.wbB], [reference.state.wbR, reference.state.wbG, reference.state.wbB], 'WB still belongs to the intermediate conversion');
    } else assert.deepEqual([state.wbR, state.wbG, state.wbB], [1, 1, 1], 'the held rebuild has temporary identity WB');
    for (const item of [h, reference]) {
      item.state.coreExposure = defect === 'cold-wb-replay-edit' ? 15 : 0;
      if (wbMode !== 'automatic') Object.assign(item.state, { wbR: 1.17, wbG: 1, wbB: .83, wbAutoConfidence: 'high',
        [wbMode === 'late-manual' ? 'wbUserOverride' : wbMode === 'late-gray-point' ? 'grayPointSampled' : 'wbSemanticApplied']: true });
    }
    release();
    await restoring; await c.settlePendingCropDetection();
    assert.equal(state.fullBaseHistoryPending, null, 'restoration releases its barrier');
    assert.equal(state.fullBaseFrameEdit, null, 'restoration releases its live event');
    assert.equal(state.coreExposure, defect === 'cold-wb-replay-edit' ? 15 : 0, 'the exposure edited during cold restoration survives');
  }
  const failures = [];
  const check = async phase => {
    await c.processNegative({ automatic: false });
    await reference.context.processNegative({ automatic: false });
    const actual = Object.fromEntries([8, 16].map(depth => [depth, createHash('sha256').update(Buffer.from(new Uint16Array(samples(h, depth)).buffer)).digest('hex')]));
    const expected = Object.fromEntries([8, 16].map(depth => [depth, createHash('sha256').update(Buffer.from(new Uint16Array(samples(reference, depth)).buffer)).digest('hex')]));
    console.log(defect, wbMode, phase, JSON.stringify({ capturedCold: duringRestore?.refs.cold || false,
      dispatchedExposure: 15, recordedExposure: provisional.fullBaseWhiteBalance.measurement.settings.coreExposure,
      liveExposure: state.coreExposure, wb: [state.wbR, state.wbG, state.wbB], referenceWb: [reference.state.wbR, reference.state.wbG, reference.state.wbB], actual, expected }));
    // Keep exercising real Undo/Redo on the negative control, retaining every
    // strict failure instead of stopping before the other sample depths run.
    for (const depth of [8, 16]) {
      try { assert.deepEqual(samples(h, depth), samples(reference, depth), defect + '/' + phase + `: exact ${depth}-bit samples`); }
      catch (error) { failures.push(error); }
    }
    try {
      assert.equal(state.coreExposure, reference.state.coreExposure, 'later live exposure edit survives WB replay');
      assert.equal(provisional.fullBaseWhiteBalance.measurement.settings.coreExposure, 15, 'recorded recipe is the actual immutable dispatch');
      assert.deepEqual([state.wbUserOverride, state.grayPointSampled, state.wbSemanticApplied],
        [reference.state.wbUserOverride, reference.state.grayPointSampled, reference.state.wbSemanticApplied], 'late WB ownership survives completion/replay');
      assert.deepEqual([state.wbR, state.wbG, state.wbB], [reference.state.wbR, reference.state.wbG, reference.state.wbB], defect + '/' + phase + ': actual WB');
      samePixels(state.processedImageData, reference.state.processedImageData, defect + '/' + phase + ': Silver samples');
    } catch (error) { failures.push(error); }
  };
  await check('live');
  for (const action of historyRestore ? ['Undo', 'Redo', 'Undo', 'Redo'] : ['Undo', 'Redo']) {
    const restoring = c[`perform${action}`](); await c.settlePendingCropDetection(); await restoring;
    await reference.context[`perform${action}`]();
    await check(action);
  }
  h.pool.dispose(); reference.pool.dispose();
  assert.equal(failures.length, 0, failures.map(error => error.message).join('\n'));
  cases++;
}
// A promoted Undo may have settled geometry while its full-base crop/WB
// measurement still runs. Parking must not save the previous recipe or
// dispose that photo's worker between those two barriers.
if (selected === 'all' || selected === 'parking-barrier') {
  const h = fixture(false), { context: c, target, state } = h;
  const item = { file: { name: 'tiny-history.png' }, settings: { previous: true }, isDirty: true };
  const worker = { terminated: false,
    postMessage(message) { queueMicrotask(() => this.onmessage?.({ data: { id: message.id, type: 'analyzed', key: message.key } })); },
    terminate() { this.terminated = true; } };
  const client = createConversionWorkerClient({ cacheInput: true, workerFactory: () => worker });
  Object.assign(target, { getCurrentQueueItem: () => item, safeStorageGet: () => 'on',
    gpuPreview: { prepared: null }, previewRepairWorker: { dispose() {} },
    convertPreviewFrameInWorker: client, dustTint: {}, displayOverlayState: {} });
  Object.assign(state, { loadedFile: item.file, fileQueue: [item], currentFileIndex: 0, cropRegion: { ...fullRect } });
  vm.runInContext(['hiddenParkEnabled', 'parkOpenPhotoForHiddenJob', 'persistCurrentFileSettings'].map(fn).join('\n'), c);
  await c.applyGeometryFromBase({ cropRegion: state.cropRegion });
  await c.processNegative();
  const outgoing = state.conversionSourceImageData;
  await client.analyze({ imageData: outgoing, settings: {} });
  const snapshot = c.captureSnapshot('promoted-crop').settings;
  snapshot.fullBaseFrameEdit = { detect: true, automatic: true };
  target.cropHitHold = true;
  const restoring = c.restoreColdSnapshotPixels(snapshot);
  try {
    for (let i = 0; i < 20 && !h.held.length; i++) await new Promise(setImmediate);
    assert.equal(h.held.length, 1, 'the real full-base crop detector is held');
    assert.ok(state.fullBaseHistoryPending, 'real promoted restoration owns its exact-frame barrier');
    assert.equal(state.geometryPending, false, 'geometry is already settled');
    assert.equal(Boolean(target.document.body.dataset.studioBusy), false);
    assert.equal(Boolean(target.processNegativeInFlight), false);
    const saved = item.settings, generation = target.loadGeneration;
    assert.equal(await c.parkOpenPhotoForHiddenJob(), false, 'never park before promoted history measurements settle');
    assert.equal(item.settings, saved, 'pending history cannot replace the saved recipe');
    assert.equal(target.loadGeneration, generation, 'parking cannot supersede the history restoration');
    assert.equal(client.holds(outgoing), true, 'the real cached client keeps this unsettled photo');
    assert.equal(worker.terminated, false);
  } finally {
    h.held.splice(0).forEach(resolve => resolve());
    await restoring;
    h.pool.dispose();
  }
  assert.equal(state.fullBaseHistoryPending, null);
  assert.equal(await c.parkOpenPhotoForHiddenJob(), true, 'settled history allows genuine ownership release');
  assert.equal(client.holds(outgoing), false);
  assert.equal(worker.terminated, true);
  client.dispose(); cases++;
}
// Supersession uses actual history entries created by promotion and later
// Confirm/slider edits. Only conversion replies are held; capture, clone,
// geometry and history callers always run their production implementations.
async function ownershipFixture() {
  const h = fixture(true), reference = fixture(false), { context: c, state, target } = h;
  const baseline = target.extractCurrentSettings();
  const record = { decodedImage: full, status: 'decoded', urgent: true };
  const provisional = { size: { width: 32, height: 24 }, fullSize: { width: 64, height: 48 },
    geometry: createExactGeometry({ size: { width: 32, height: 24 }, fullSize: { width: 64, height: 48 } }), settledSnapshot: baseline, record };
  state.provisional = provisional;
  for (const item of [h, reference]) {
    await item.context.processNegative();
    await apply(item, item === h ? rect : fullRect, { held: true });
    for (let i = 0; i < 32 && !item.held.length; i++) await new Promise(setImmediate);
    assert.equal(item.held.length, 1, 'unanswered preview/reference detector');
    item.context.pushUndo('exposure');
    item.state.coreExposure = 15;
    await item.context.processNegative({ automatic: false });
  }
  const old = target.cropDetection;
  await c.waitForProvisionalSwap(record, provisional, () => true);
  assert.equal(old.token.hit, null, 'preview has no hit through promotion');
  target.cropHitHold = false;
  c.installFullDecode(record, provisional, full, { ...baseline, autoFrameMeta: structuredClone(fullMeta), filmBase: { ...fullFilmBase }, cropRegion: null });
  await c.whenGeometrySettled(); await c.settlePendingCropDetection();
  target.conversionHold = reference.target.conversionHold = true;
  const converting = c.processNegative(), referenceLanding = land(reference);
  for (let i = 0; i < 32 && (!h.conversionReplies.length || !reference.conversionReplies.length); i++) await new Promise(setImmediate);
  assert.equal(h.conversionReplies.length, 1, 'full-base immutable dispatch held');
  assert.equal(reference.conversionReplies.length, 1, 'reference immutable dispatch held');
  for (const item of [h, reference]) {
    item.context.pushUndo('in-flight-exposure');
    item.state.coreExposure = 0;
    item.target.conversionHold = false;
    item.conversionReplies.splice(0).forEach(resolve => resolve());
  }
  await converting; await referenceLanding;
  await c.restorePromotedWhiteBalance(provisional.fullBaseWhiteBalance, () => true);
  state.provisional = null; record.status = 'installed';
  h.held.splice(0).forEach(resolve => resolve()); await old.done;
  for (const item of [h, reference]) {
    await item.context.processNegative({ automatic: false });
    await apply(item, null, { analysisOnly: true, selectedArea: area(.2, .25, .8, .75) });
    await item.context.settlePendingCropDetection();
  }
  return { h, reference, event: provisional.fullBaseWhiteBalance };
}
async function waitReply(h, live, label, exclude = []) {
  const matches = reply => reply.live === live && !exclude.includes(reply);
  for (let i = 0; i < 64 && !h.conversionReplies.some(matches); i++) await new Promise(setImmediate);
  const reply = h.conversionReplies.find(matches);
  assert.ok(reply, label + ': requested conversion phase held');
  assert.equal(h.state.geometryPending, false, label + ': geometry already finished');
  assert.equal(Boolean(h.target.cropDetection), false, label + ': detector already finished');
  assert.ok(h.state.fullBaseHistoryPending, label + ': restoration owns a live barrier');
  if (!live) assert.equal(h.target.processNegativeInFlight, null, label + ': only off-state WB is held, never live pixels');
  return reply;
}
function releaseReply(h, reply) {
  h.conversionReplies.splice(h.conversionReplies.indexOf(reply), 1);
  reply();
}
for (const phase of ['wb', 'conversion']) {
  if (selected !== 'all' && selected !== 'ownership' && selected !== `ownership-${phase}`) continue;
  const { h, reference, event } = await ownershipFixture(), { context: c, state, target } = h;
  for (const item of [h, reference]) await item.context.performUndo(); // Hot Confirm.
  target.holdConversion = ({ live }) => live === (phase === 'conversion');
  const obsolete = c.performUndo();
  const reply = await waitReply(h, phase === 'conversion', 'cold Undo');
  const oldPending = state.fullBaseHistoryPending, oldEvent = state.fullBaseFrameEdit;
  const sourceBefore = state.croppedImageData || state.originalImageData;
  await reference.context.performUndo();
  await c.performRedo(); await c.performRedo();
  await reference.context.performRedo(); await reference.context.performRedo();
  assert.equal(state.croppedImageData || state.originalImageData, sourceBefore, 'identical source planes cannot prove current ownership');
  const captured = c.pushUndo('superseding-exposure');
  reference.context.pushUndo('superseding-exposure');
  for (const item of [h, reference]) item.state.coreExposure = 15;
  console.log(`ownership-${phase} captured`, JSON.stringify({ cold: !!captured.refs.cold,
    staleBarrier: state.fullBaseHistoryPending === oldPending, staleEvent: captured.settings.fullBaseFrameEdit?.whiteBalance === oldEvent.whiteBalance,
    measurementExposure: event.measurement.settings.coreExposure, heldLivePixels: reply.live }));
  target.holdConversion = null;
  releaseReply(h, reply); await obsolete; await c.settlePendingCropDetection();
  const failures = [];
  const check = async label => {
    await c.processNegative({ automatic: false }); await reference.context.processNegative({ automatic: false });
    const hashes = item => Object.fromEntries([8, 16].map(depth => [depth,
      createHash('sha256').update(Buffer.from(new Uint16Array(samples(item, depth)).buffer)).digest('hex')]));
    const actual = hashes(h), expected = hashes(reference);
    console.log(`ownership-${phase}/${label}`, JSON.stringify({ actual, expected,
      wb: [state.wbR, state.wbG, state.wbB], referenceWb: [reference.state.wbR, reference.state.wbG, reference.state.wbB] }));
    for (const depth of [8, 16]) if (actual[depth] !== expected[depth]) failures.push(`${label}: strict ${depth}-bit samples differ`);
    if (JSON.stringify([state.wbR, state.wbG, state.wbB]) !== JSON.stringify([reference.state.wbR, reference.state.wbG, reference.state.wbB])) failures.push(label + ': WB differs');
    samePixels(state.processedImageData, reference.state.processedImageData, label + ': live Silver pixels equal');
    assert.equal(event.measurement.settings.coreExposure, 15, 'completed event retains its immutable dispatch recipe');
  };
  await check('live');
  for (const action of ['Undo', 'Redo', 'Undo', 'Redo']) {
    await c[`perform${action}`](); await c.settlePendingCropDetection();
    await reference.context[`perform${action}`](); await check(action);
  }
  h.pool.dispose(); reference.pool.dispose();
  assert.equal(failures.length, 0, failures.join('\n')); cases++;
}
const ownershipSchedules = [
  { name: 'Undo-hot-Redo', start: 'Undo', actions: ['Redo', 'Redo'], cold: false },
  { name: 'Undo-cold-Undo', start: 'Undo', actions: ['Undo'], cold: true },
  { name: 'Undo-nested-cold-Redo', start: 'Undo', actions: ['Undo', 'Redo'], cold: true },
  { name: 'Redo-hot-Undo', start: 'Redo', actions: ['Undo'], cold: false },
  { name: 'Redo-hot-Redo', start: 'Redo', actions: ['Redo', 'Redo'], cold: false },
  { name: 'Redo-nested-cold-Undo', start: 'Redo', actions: ['Undo', 'Undo'], cold: true },
  { name: 'Redo-cold-Redo', start: 'Redo', preparationUndos: 3, actions: ['Redo'], cold: true }
];
for (const schedule of ownershipSchedules) for (const phase of ['wb', 'conversion'])
  for (const order of phase === 'wb' && schedule.cold ? ['old-first', 'new-first'] : ['old-first']) {
  if (selected !== 'all' && selected !== 'ownership-matrix') continue;
  const label = `${schedule.name}/${phase}/${order}`;
  const { h, reference, event } = await ownershipFixture(), { context: c, state, target } = h;
  for (const item of [h, reference]) await item.context.performUndo();
  if (schedule.start === 'Redo') {
    // Nested Undo captures a real cold Redo entry, with its legitimate event.
    target.holdConversion = ({ live }) => !live;
    const preparing = [c.performUndo()];
    const first = await waitReply(h, false, label + '/prepare');
    for (let i = 1; i < (schedule.preparationUndos || 2); i++) {
      const previous = h.conversionReplies.slice();
      preparing.push(c.performUndo());
      await waitReply(h, false, label + '/prepare nested', previous);
    }
    target.holdConversion = null;
    h.conversionReplies.splice(0).forEach(resolve => resolve());
    await Promise.all(preparing); await c.settlePendingCropDetection();
    for (let i = 0; i < (schedule.preparationUndos || 2); i++) await reference.context.performUndo();
    assert.ok(first.recipe, 'preparation used an actual WB conversion');
    assert.equal(target.redoStack.at(-1).refs.cold, true, label + ': pending Undo captured a cold Redo entry');
  }
  target.holdConversion = ({ live }) => live === (phase === 'conversion');
  const restoring = [c[`perform${schedule.start}`]()];
  const oldReply = await waitReply(h, phase === 'conversion', label + '/old');
  const oldPending = state.fullBaseHistoryPending;
  await reference.context[`perform${schedule.start}`]();
  for (const [i, action] of schedule.actions.entries()) {
    const previous = h.conversionReplies.slice();
    restoring.push(c[`perform${action}`]());
    await reference.context[`perform${action}`]();
    if (phase === 'wb' && state.fullBaseHistoryPending) await waitReply(h, false, label + '/successor', previous);
    if (i === 0) assert.notEqual(state.fullBaseHistoryPending, oldPending, label + ': superseded promise is not live');
  }
  const newest = state.fullBaseHistoryPending, newestEvent = state.fullBaseFrameEdit;
  assert.equal(Boolean(newest), schedule.cold, label + ': target has the expected hot/cold ownership');
  if (schedule.cold) assert.ok(newestEvent.whiteBalance, label + ': cold successor retains valid saved measurement');
  const captured = c.pushUndo('matrix-exposure'); reference.context.pushUndo('matrix-exposure');
  assert.equal(Boolean(captured.refs.cold), schedule.cold, label + ': edit captures the current operation kind');
  if (schedule.cold) assert.equal(captured.settings.fullBaseFrameEdit.whiteBalance, newestEvent.whiteBalance,
    label + ': edit binds the actual current event');
  else assert.equal(captured.settings.fullBaseFrameEdit, undefined, label + ': hot edit has no obsolete event');
  for (const item of [h, reference]) item.state.coreExposure = item.state.coreExposure === 15 ? 0 : 15;
  if (phase === 'conversion') {
    // Live conversions serialize. The old reply must release the slot while
    // leaving the successor's barrier intact for its own conversion/WB.
    releaseReply(h, oldReply); await restoring[0];
    if (newest) {
      assert.equal(state.fullBaseHistoryPending, newest, label + ': old completion cannot clear the new barrier');
      assert.equal(state.fullBaseFrameEdit, newestEvent, label + ': old completion cannot clear the new event');
      await waitReply(h, true, label + '/new');
    }
    target.holdConversion = null;
    h.conversionReplies.splice(0).forEach(resolve => resolve());
  } else if (order === 'old-first') {
    releaseReply(h, oldReply); await restoring[0];
    if (newest) {
      assert.equal(state.fullBaseHistoryPending, newest, label + ': obsolete WB completion cannot clear the newer pending operation');
      assert.equal(state.fullBaseFrameEdit, newestEvent, label + ': newer binding survives old finalizer');
    }
    target.holdConversion = null;
    h.conversionReplies.splice(0).forEach(resolve => resolve());
  } else {
    const newerReplies = h.conversionReplies.filter(reply => reply !== oldReply);
    assert.ok(newerReplies.length, label + ': independent newer WB reply is held too');
    target.holdConversion = null;
    for (const reply of newerReplies.reverse()) releaseReply(h, reply);
    await Promise.all(restoring.slice(1));
    assert.equal(state.fullBaseHistoryPending, null, label + ': new completion releases only its own binding');
    const wbBefore = [state.wbR, state.wbG, state.wbB];
    releaseReply(h, oldReply); await restoring[0];
    assert.deepEqual([state.wbR, state.wbG, state.wbB], wbBefore, label + ': old WB cannot overwrite the completed successor');
  }
  await Promise.all(restoring); await c.settlePendingCropDetection();
  assert.equal(state.fullBaseHistoryPending, null, label + ': final barrier released');
  assert.equal(state.fullBaseFrameEdit, null, label + ': final live event released');
  const check = async name => {
    await c.processNegative({ automatic: false }); await reference.context.processNegative({ automatic: false });
    assert.deepEqual([state.wbR, state.wbG, state.wbB, state.coreExposure],
      [reference.state.wbR, reference.state.wbG, reference.state.wbB, reference.state.coreExposure], label + '/' + name + ': WB/strengths');
    assert.deepEqual(canon(state.autoFrame.lastDiagnostics), canon(reference.state.autoFrame.lastDiagnostics), label + '/' + name + ': diagnostics');
    samePixels(state.processedImageData, reference.state.processedImageData, label + '/' + name + ': Silver samples');
    for (const depth of [8, 16]) assert.deepEqual(samples(h, depth), samples(reference, depth), label + '/' + name + `: strict ${depth}-bit samples`);
    assert.equal(event.measurement.settings.coreExposure, 15, label + ': shared completed dispatch is immutable');
  };
  await check('live');
  for (const action of ['Undo', 'Redo', 'Undo', 'Redo']) {
    await c[`perform${action}`](); await c.settlePendingCropDetection();
    await reference.context[`perform${action}`](); await check(action);
  }
  console.log('ownership matrix passed:', label);
  h.pool.dispose(); reference.pool.dispose(); cases++;
}
for (const operation of ['snapshot-hot', 'snapshot-cold', 'settings', 'activation', 'release']) for (const phase of ['wb', 'conversion']) {
  if (selected !== 'all' && selected !== 'ownership-lifecycle') continue;
  const label = `${operation}/${phase}`;
  const { h, reference, event } = await ownershipFixture(), { context: c, state, target } = h;
  const saved = c.captureSnapshot('saved-confirm'), savedReference = reference.context.captureSnapshot('saved-confirm');
  const measuredEvent = event.measurement, measuredRecipe = canon(measuredEvent.settings);
  for (const item of [h, reference]) await item.context.performUndo();
  target.holdConversion = ({ live }) => live === (phase === 'conversion');
  const obsolete = c.performUndo();
  const reply = await waitReply(h, phase === 'conversion', label + '/old');
  await reference.context.performUndo();
  target.holdConversion = null;
  const cold = target.undoStack.at(-1), coldReference = reference.target.undoStack.at(-1);
  assert.equal(cold.refs.cold, true, label + ': saved cold entry is real promoted history');
  let newer;
  if (operation === 'snapshot-cold') {
    newer = c.restoreSnapshot(cold);
    await reference.context.restoreSnapshot(coldReference);
  } else if (operation === 'settings') {
    c.restoreSettings(saved.settings);
    reference.context.restoreSettings(savedReference.settings);
  } else {
    if (operation === 'activation') { c.invalidatePhotoActivation(); reference.context.invalidatePhotoActivation(); }
    if (operation === 'release') { c.releaseOutgoingPhotoPlanes(); reference.context.releaseOutgoingPhotoPlanes(); }
    newer = c.restoreSnapshot(saved);
    await reference.context.restoreSnapshot(savedReference);
  }
  assert.equal(state.fullBaseFrameEdit?.whiteBalance || null, operation === 'snapshot-cold' ? cold.settings.fullBaseFrameEdit.whiteBalance : null,
    label + ': only the newly restored entry can own live WB');
  // A conversion successor serializes behind the old request. A WB successor
  // can already be finished, but either completion order keeps its identity.
  releaseReply(h, reply); await obsolete; await newer; await c.settlePendingCropDetection();
  assert.equal(state.fullBaseHistoryPending, null, label + ': old operation leaves no live barrier');
  assert.equal(state.fullBaseFrameEdit, null, label + ': old operation leaves no live event');
  assert.equal(event.measurement, measuredEvent, label + ': saved entries still own their shared completed measurement');
  assert.deepEqual(canon(event.measurement.settings), measuredRecipe, label + ': completed analysis recipe is not erased or rewritten');
  for (const item of [h, reference]) {
    await item.context.processNegative({ automatic: false });
    item.context.pushUndo('lifecycle-exposure'); item.state.coreExposure = item.state.coreExposure === 15 ? 0 : 15;
  }
  for (const action of ['live', 'Undo', 'Redo', 'Undo', 'Redo']) {
    if (action !== 'live') {
      await c[`perform${action}`](); await c.settlePendingCropDetection(); await reference.context[`perform${action}`]();
    }
    await c.processNegative({ automatic: false }); await reference.context.processNegative({ automatic: false });
    assert.deepEqual([state.wbR, state.wbG, state.wbB, state.coreExposure],
      [reference.state.wbR, reference.state.wbG, reference.state.wbB, reference.state.coreExposure], label + '/' + action + ': current WB/recipe');
    for (const depth of [8, 16]) assert.deepEqual(samples(h, depth), samples(reference, depth), label + '/' + action + `: strict ${depth}-bit samples`);
  }
  console.log('ownership lifecycle passed:', label);
  h.pool.dispose(); reference.pool.dispose(); cases++;
}
if (selected === 'all' || selected === 'ownership-geometry-settings') {
  const { h, reference, event } = await ownershipFixture(), { context: c, state, target } = h;
  for (const item of [h, reference]) await item.context.performUndo();
  target.holdConversion = ({ live }) => !live;
  const preparing = [];
  for (let i = 0; i < 3; i++) {
    const previous = h.conversionReplies.slice();
    preparing.push(c.performUndo());
    await waitReply(h, false, 'geometry settings/prepare', previous);
    await reference.context.performUndo();
  }
  target.holdConversion = null;
  h.conversionReplies.splice(0).forEach(resolve => resolve());
  await Promise.all(preparing); await c.settlePendingCropDetection();
  const obsolete = c.performRedo();
  const obsoleteReference = reference.context.performRedo();
  assert.equal(state.geometryPending, true, 'actual cold Redo is rebuilding a different geometry');
  assert.ok(state.fullBaseHistoryPending, 'geometry-phase history owner installed synchronously');
  const settings = { ...target.extractCurrentSettings(), coreExposure: 31, filmBase: { ...manualFilmBase } };
  const referenceSettings = { ...reference.target.extractCurrentSettings(), coreExposure: 31, filmBase: { ...manualFilmBase } };
  c.restoreSettings(settings); reference.context.restoreSettings(referenceSettings);
  assert.equal(Boolean(state.fullBaseHistoryPending), false, 'saved settings replace the owner even when a pending job has the same geometry key');
  assert.equal(state.fullBaseFrameEdit, null, 'direct settings do not adopt the replaced restore event');
  await obsolete; await obsoleteReference; await c.whenGeometrySettled(); await reference.context.whenGeometrySettled();
  await c.processNegative(); await reference.context.processNegative();
  assert.deepEqual([state.wbR, state.wbG, state.wbB], [reference.state.wbR, reference.state.wbG, reference.state.wbB], 'new saved recipe owns automatic WB');
  for (const depth of [8, 16]) assert.deepEqual(samples(h, depth), samples(reference, depth), `geometry settings: strict ${depth}-bit samples`);
  assert.equal(event.measurement.settings.coreExposure, 15, 'the saved old dispatch remains valid for its entries');
  h.pool.dispose(); reference.pool.dispose(); cases++;
}
for (const replacement of ['confirm', 'confirm-history', 'reset']) {
  if (selected !== 'all' && selected !== (replacement === 'reset' ? 'ownership-swap-reset' : 'ownership-swap-completion')) continue;
  const h = fixture(true), reference = fixture(false), { context: c, state, target } = h;
  const baseline = target.extractCurrentSettings();
  const record = { file: { name: 'ownership.dng' }, decodedImage: full, status: 'decoded', urgent: true, decoded: async () => full };
  const provisional = { size: { width: 32, height: 24 }, fullSize: { width: 64, height: 48 },
    geometry: createExactGeometry({ size: { width: 32, height: 24 }, fullSize: { width: 64, height: 48 } }), settledSnapshot: baseline, record };
  state.provisional = provisional; state.fullDecode = record;
  target.backgroundGate = { bump() {} };
  target.settledImportSettings = async image => ({ image,
    settings: { ...baseline, autoFrameMeta: structuredClone(fullMeta), filmBase: { ...fullFilmBase }, cropRegion: null } });
  vm.runInContext(fn('settleProvisionalPhoto'), c);
  for (const item of [h, reference]) {
    await item.context.processNegative(); await apply(item, item === h ? rect : fullRect, { held: true });
    item.context.pushUndo('exposure'); item.state.coreExposure = 15;
    await item.context.processNegative({ automatic: false });
    item.target.conversionHold = true;
  }
  const oldDetector = target.cropDetection;
  target.cropHitHold = false;
  const settling = c.settleProvisionalPhoto(record, target.loadGeneration), referenceLanding = land(reference);
  for (let i = 0; i < 64 && (!h.conversionReplies.length || !reference.conversionReplies.length); i++) await new Promise(setImmediate);
  assert.equal(h.conversionReplies.length, 1, 'actual full-settle dispatch held');
  assert.equal(reference.conversionReplies.length, 1, 'single-stage dispatch held');
  target.holdConversion = ({ live }) => !live;
  for (const item of [h, reference]) {
    item.context.pushUndo('in-flight-exposure'); item.state.coreExposure = 0; item.target.conversionHold = false;
    item.conversionReplies.splice(0).forEach(resolve => resolve());
  }
  await referenceLanding;
  for (let i = 0; i < 64 && !h.conversionReplies.length; i++) await new Promise(setImmediate);
  assert.equal(h.conversionReplies.length, 1, 'only full-settle off-state WB reply remains held');
  assert.equal(h.conversionReplies[0].live, false, 'held full-settle replay cannot install late pixels');
  assert.equal(target.processNegativeInFlight, null, 'live conversion already finished');
  assert.equal(state.provisional, provisional, 'actual settlement still owns its record while WB waits');
  const event = provisional.fullBaseWhiteBalance, measurement = event.measurement;
  for (const item of [h, reference]) {
    await item.context.processNegative({ automatic: false });
    if (replacement === 'reset') resetAdjustments(item);
    else {
      await apply(item, null, { analysisOnly: true, selectedArea: area(.2, .25, .8, .75) });
      if (replacement === 'confirm-history') { await item.context.performUndo(); await item.context.performRedo(); }
    }
  }
  const wb = [state.wbR, state.wbG, state.wbB];
  c.pushUndo('after-swap-history'); reference.context.pushUndo('after-swap-history');
  for (const item of [h, reference]) item.state.coreExposure = 15;
  target.holdConversion = null;
  h.conversionReplies.splice(0).forEach(resolve => resolve()); await settling;
  const completedWb = [state.wbR, state.wbG, state.wbB];
  if (replacement !== 'reset') assert.deepEqual(completedWb, wb, 'superseded full-settle WB cannot overwrite hot restored history');
  assert.equal(state.provisional, null, 'superseded measurement still finishes full-decode admission');
  assert.equal(record.status, 'installed', 'full decode does not remain permanently provisional');
  assert.equal(event.measurement, measurement, 'saved entries retain their immutable completed event');
  h.held.splice(0).forEach(resolve => resolve()); await oldDetector.done;
  if (replacement === 'reset') await compareResetHistory(h, reference, 'full-swap reset');
  else for (const action of ['live', 'Undo', 'Redo', 'Undo', 'Redo']) {
    if (action !== 'live') {
      await c[`perform${action}`](); await c.settlePendingCropDetection(); await reference.context[`perform${action}`]();
    }
    await c.processNegative({ automatic: false }); await reference.context.processNegative({ automatic: false });
    for (const depth of [8, 16]) assert.deepEqual(samples(h, depth), samples(reference, depth), `swap completion/${action}: strict ${depth}-bit samples`);
  }
  if (replacement === 'reset') assert.deepEqual(completedWb, wb, 'superseded full-settle WB cannot overwrite reset');
  h.pool.dispose(); reference.pool.dispose(); cases++;
}
if (selected === 'all' || selected === 'ownership-cold-confirm') {
  const { h, reference, event } = await ownershipFixture(), { context: c, state, target } = h;
  for (const item of [h, reference]) await item.context.performUndo();
  target.holdConversion = ({ live }) => !live;
  const obsolete = c.performUndo(), reply = await waitReply(h, false, 'analysis-only replacement');
  await reference.context.performUndo();
  for (const item of [h, reference]) {
    await apply(item, null, { analysisOnly: true, selectedArea: area(.25, .15, .75, .85) });
    assert.equal(Boolean(item.state.fullBaseHistoryPending), false, 'new Confirm supersedes history WB without changing geometry');
    item.context.pushUndo('after-new-confirm'); item.state.coreExposure = 0;
  }
  const wb = [state.wbR, state.wbG, state.wbB];
  target.holdConversion = null;
  releaseReply(h, reply); await obsolete; await c.settlePendingCropDetection();
  assert.deepEqual([state.wbR, state.wbG, state.wbB], wb, 'old history WB cannot overwrite new Confirm');
  assert.equal(event.measurement.settings.coreExposure, 15, 'old saved event remains available for legitimately owning entries');
  for (const action of ['live', 'Undo', 'Redo', 'Undo', 'Redo']) {
    if (action !== 'live') {
      await c[`perform${action}`](); await c.settlePendingCropDetection(); await reference.context[`perform${action}`]();
    }
    await c.processNegative({ automatic: false }); await reference.context.processNegative({ automatic: false });
    for (const depth of [8, 16]) assert.deepEqual(samples(h, depth), samples(reference, depth), `cold Confirm/${action}: strict ${depth}-bit samples`);
  }
  h.pool.dispose(); reference.pool.dispose(); cases++;
}
function resetAdjustments(h) {
  // The reset caller is real. Its render dependency uses the same real
  // processNegative/Silver caller; only UI scheduling is replaced.
  h.target.rerenderWithCoreControls = () => h.context.processNegative({ automatic: false });
  h.context.resetAllAdjustments();
}
async function compareResetHistory(h, reference, label) {
  const failures = [];
  for (const action of ['live', 'Undo', 'Redo', 'Undo', 'Redo']) {
    if (action !== 'live') {
      await h.context[`perform${action}`](); await h.context.settlePendingCropDetection();
      await reference.context[`perform${action}`]();
    }
    await h.context.processNegative({ automatic: false }); await reference.context.processNegative({ automatic: false });
    for (const depth of [8, 16]) {
      try { assert.deepEqual(samples(h, depth), samples(reference, depth)); }
      catch { failures.push(`${action}: strict ${depth}-bit samples differ`); }
    }
  }
  console.log('ownership reset proof:', JSON.stringify({ label, failures }));
  assert.deepEqual(failures, [], label + ': reset live/repeated Undo/Redo samples');
}
for (const phase of ['wb', 'conversion']) {
  for (const repeated of [false, true]) {
    if (selected !== 'all' && selected !== 'ownership-reset' && selected !== `ownership-reset-${phase}`) continue;
    const { h, reference, event } = await ownershipFixture(), { context: c, state, target } = h;
    for (const item of [h, reference]) await item.context.performUndo();
    target.holdConversion = ({ live }) => live === (phase === 'conversion');
    const obsolete = c.performUndo(), reply = await waitReply(h, phase === 'conversion', 'reset/' + phase);
    await reference.context.performUndo();
    const measurement = event.measurement, recipe = canon(measurement.settings);
    for (const item of [h, reference]) {
      resetAdjustments(item);
      if (repeated) resetAdjustments(item);
      assert.deepEqual([item.state.wbR, item.state.wbG, item.state.wbB], [1, 1, 1], 'the actual reset installs unity WB');
    }
    target.holdConversion = null; releaseReply(h, reply); await obsolete; await c.settlePendingCropDetection();
    const after = [state.wbR, state.wbG, state.wbB];
    console.log('ownership reset completion:', JSON.stringify({ phase, repeated, heldLivePixels: phase === 'conversion', after,
      pending: Boolean(state.fullBaseHistoryPending), savedMeasurement: event.measurement === measurement }));
    await compareResetHistory(h, reference, `reset/${phase}/${repeated ? 'repeated' : 'once'}`);
    assert.deepEqual(after, [1, 1, 1], 'obsolete history WB cannot overwrite reset unity gains');
    assert.equal(event.measurement, measurement, 'reset leaves the saved completed event intact');
    assert.deepEqual(canon(measurement.settings), recipe, 'reset does not rewrite the saved measurement recipe');
    h.pool.dispose(); reference.pool.dispose(); cases++;
  }
}
for (const phase of ['wb', 'conversion']) {
  for (const order of phase === 'wb' ? ['old-first', 'new-first'] : ['old-first']) {
    if (selected !== 'all' && selected !== 'ownership-reset-overlap') continue;
    const { h, reference, event } = await ownershipFixture(), { context: c, state, target } = h;
    for (const item of [h, reference]) await item.context.performUndo();
    target.holdConversion = ({ live }) => live === (phase === 'conversion');
    const obsolete = c.performUndo(), reply = await waitReply(h, phase === 'conversion', 'reset overlap/' + phase);
    await reference.context.performUndo();
    for (const item of [h, reference]) resetAdjustments(item);
    const newer = c.performUndo(); await reference.context.performUndo();
    const pending = state.fullBaseHistoryPending, binding = state.fullBaseFrameEdit;
    assert.ok(pending && binding, 'Undo of reset creates a new actual pending owner');
    assert.equal(binding.whiteBalance, event, 'Undo still owns the saved immutable event');
    if (phase === 'wb') {
      const next = await waitReply(h, false, 'Undo reset WB', [reply]);
      if (order === 'new-first') {
        releaseReply(h, next); await newer;
        assert.equal(state.fullBaseHistoryPending, null, 'new owner completed normally');
        releaseReply(h, reply); await obsolete;
      } else {
        releaseReply(h, reply); await obsolete;
        assert.equal(state.fullBaseHistoryPending, pending, 'obsolete reset predecessor cannot clear new pending operation');
        assert.equal(state.fullBaseFrameEdit, binding, 'obsolete reset predecessor cannot clear new live event');
        releaseReply(h, next); await newer;
      }
    } else {
      releaseReply(h, reply); await obsolete;
      assert.equal(state.fullBaseHistoryPending, pending, 'serialized obsolete conversion cannot clear new owner');
      assert.equal(state.fullBaseFrameEdit, binding, 'serialized obsolete conversion cannot clear new event');
      const next = await waitReply(h, true, 'Undo reset conversion', [reply]);
      target.holdConversion = null; releaseReply(h, next); await newer;
    }
    target.holdConversion = null;
    await c.settlePendingCropDetection();
    await compareResetHistory(h, reference, `reset overlap/${phase}/${order}`);
    assert.equal(event.measurement.settings.coreExposure, 15, 'nested reset/history preserves the immutable dispatch');
    h.pool.dispose(); reference.pool.dispose(); cases++;
  }
}
if (selected === 'all' || selected === 'ownership-reset-snapshot') {
  const { h, reference, event } = await ownershipFixture(), { context: c, state, target } = h;
  for (const item of [h, reference]) await item.context.performUndo();
  target.holdConversion = ({ live }) => live;
  const obsolete = c.performUndo(), reply = await waitReply(h, true, 'reset awaiting pixels');
  await reference.context.performUndo();
  for (const item of [h, reference]) resetAdjustments(item);
  assert.equal(state.processedImageData, null, 'the replaced cold conversion has not installed positive pixels');
  const snapshot = c.captureSnapshot('reset awaiting pixels');
  assert.equal(snapshot.refs.cold, true, 'the current reset recipe stays cold until positive pixels exist');
  assert.equal(Boolean(snapshot.settings.fullBaseFrameEdit), false, 'the reset snapshot does not adopt the obsolete WB event');
  for (const item of [h, reference]) { item.context.pushUndo('coreExposure'); item.state.coreExposure = 15; }
  target.holdConversion = null; releaseReply(h, reply); await obsolete;
  await c.processNegative({ automatic: false }); await reference.context.processNegative({ automatic: false });
  await c.performUndo(); await reference.context.performUndo();
  assert.ok(state.processedImageData, 'actual Undo rebuilds the reset positive without a compensating render in the test');
  assert.equal(state.coreExposure, 0, 'actual Undo restores the reset exposure');
  // The one-stage hot restore schedules a UI reprocess, a leaf in this
  // harness. Render only that oracle's settled recipe for the comparison.
  await reference.context.processNegative({ automatic: false });
  for (const depth of [8, 16]) assert.deepEqual(samples(h, depth), samples(reference, depth), `reset snapshot Undo: strict ${depth}-bit samples`);
  await compareResetHistory(h, reference, 'reset awaiting pixels');
  assert.equal(event.measurement.settings.coreExposure, 15, 'the original saved measurement remains intact');
  h.pool.dispose(); reference.pool.dispose(); cases++;
}
if (selected === 'all' || selected === 'ownership-geometry-reset') {
  const { h, reference, event } = await ownershipFixture(), { context: c, state, target } = h;
  for (const item of [h, reference]) await item.context.performUndo();
  target.holdConversion = ({ live }) => !live;
  const preparing = [];
  for (let i = 0; i < 3; i++) {
    const previous = h.conversionReplies.slice();
    preparing.push(c.performUndo());
    await waitReply(h, false, 'geometry reset/prepare', previous);
    await reference.context.performUndo();
  }
  target.holdConversion = null;
  h.conversionReplies.splice(0).forEach(resolve => resolve());
  await Promise.all(preparing); await c.settlePendingCropDetection();
  const obsolete = c.performRedo(), obsoleteReference = reference.context.performRedo();
  assert.equal(state.geometryPending, true, 'actual cold Redo is rebuilding geometry when reset starts');
  const geometry = canon({ rotationAngle: state.rotationAngle, mirrored: state.mirrored, cropRegion: state.cropRegion });
  for (const item of [h, reference]) resetAdjustments(item);
  assert.equal(state.fullBaseHistoryPending, null, 'reset detaches the old geometry-phase history owner');
  assert.equal(state.fullBaseFrameEdit, null, 'reset owns no old WB binding');
  assert.equal(state.geometryPending, true, 'reset starts a real replacement geometry build');
  await obsolete; await obsoleteReference; await c.whenGeometrySettled(); await reference.context.whenGeometrySettled();
  assert.deepEqual(canon({ rotationAngle: state.rotationAngle, mirrored: state.mirrored, cropRegion: state.cropRegion }), geometry,
    'reset keeps the requested geometry rather than the superseded planes');
  await compareResetHistory(h, reference, 'reset during geometry');
  assert.equal(event.measurement.settings.coreExposure, 15, 'geometry reset preserves the saved measurement');
  h.pool.dispose(); reference.pool.dispose(); cases++;
}
if (selected === 'parking-barrier') console.log('provisionalHistoryAnalysis: real promoted history keeps the cached worker until full-base detection settles, then parking releases ownership');
else console.log(`provisionalHistoryAnalysis: ${cases} history/rescue cases; pending/completed/cancelled-at-swap hits, confirmations and edits during cold Undo/Redo promote full-base recipe/diagnostics/WB at the original event; manual WB/base, rescue strengths and exact Silver/8/16 samples preserved`);

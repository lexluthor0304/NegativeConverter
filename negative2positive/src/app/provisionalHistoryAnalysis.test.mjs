import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHarness, makeBase, samePixels } from './geometryTestHarness.mjs';
import { createExactGeometry, windowEdits, overlayWindowEdits, analysisAreaEdited, confirmedImageArea } from './provisionalPhoto.js';
import { resolveAnalysisRegion, imageAreaFromWorkingRect } from './analysisRegion.js';
import { workingPointsToBase, buildCropDetectionInput, isSameAnalysisFrame } from './cropColorAnalysis.js';
import { estimateAutoWhiteBalance } from './autoWhiteBalance.js';
import { applyPreparedAdjustmentsToBuffer, applyPreparedAdjustmentsToBuffer16 } from './adjustmentPipeline.js';
import { convertColorWithSilverCore } from '../pipeline/silverAdapter.js';
import { analyzeExpiredFilm, defaultExpiredRescueParams, EXPIRED_RESCUE_DEFAULTS, EXPIRED_RESCUE_KEYS } from '../pipeline/expiredRescue.js';

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
  if (manualWb) Object.assign(state, { wbR: 1.17, wbG: 1, wbB: .83, wbUserOverride: true });
  const detections = [], held = [];
  Object.assign(target, { createExactGeometry, windowEdits, overlayWindowEdits, analysisAreaEdited, confirmedImageArea,
    resolveAnalysisRegion, imageAreaFromWorkingRect, workingPointsToBase, buildCropDetectionInput, isSameAnalysisFrame,
    estimateAutoWhiteBalance, cropHitHold: false,
    usesSilverCoreConversion: () => true,
    // Use real geometry pixels and WB sampling; no display-sized stand-in.
    convertFromCurrentSource: async (settings = state) => convertColorWithSilverCore(state.conversionSourceImageData,
      { filmBase: settings.filmBase, colorModel: 'standard', filmPreset: 'none', borderBuffer: 0, exposure: settings.coreExposure },
      { analysisImageData: c.getColorAnalysisSample(settings === state ? { ...settings, autoFrameMeta: state.autoFrame.lastDiagnostics } : settings) }),
    runOpenCvTask: async (_kind, options) => {
      await options.build();
      detections.push({ base: state.loadedBaseImageData, crop: { ...state.cropRegion } });
      if (target.cropHitHold) await new Promise(resolve => held.push(resolve));
      return state.loadedBaseImageData === standIn ? area(2, 2, 17, 13) : area(9, 7, 33, 27);
    },
    extractCurrentSettings: () => {
      const s = c.captureSnapshot('settings').settings;
      return state.provisional && !state.provisional.swapped ? { ...s, ...state.provisional.geometry.toExact(s) } : s;
    },
    getUndoLabel: label => label, inferConfidenceLevel: () => 'high', MAX_UNDO: 30 });
  vm.runInContext(['liveGeometry', 'rebaseProvisionalHistory', 'windowFrameMetaOnFull', 'windowFrameIntent', 'frameMetaWithWindowIntent',
    'installFullDecode', 'restoreAutoFrameDiagnostics', 'automaticWhiteBalanceResult', 'maybeAutoWhiteBalance', 'analysisRegionSample',
    'provisionalWhiteBalanceMeasurement', 'promoteWhiteBalanceMeasurement', 'restorePromotedWhiteBalance',
    'restoreColdSnapshotPixels', 'hasPendingCropDetection', 'settlePendingCropDetection'].map(fn).join('\n'), c);
  c.restoreAutoFrameDiagnostics(staged ? standInMeta : fullMeta);
  return { ...h, detections, held };
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
  const settings = { wbR: h.state.wbR, wbG: h.state.wbG, wbB: h.state.wbB, exposure: h.state.exposure,
    curves: { r: identity, g: identity, b: identity } };
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
console.log(`provisionalHistoryAnalysis: ${cases} history/rescue cases; pending/completed hits and confirmations promote full-base recipe/diagnostics/WB at the original event; manual WB/base, rescue strengths and exact Silver/8/16 samples preserved`);

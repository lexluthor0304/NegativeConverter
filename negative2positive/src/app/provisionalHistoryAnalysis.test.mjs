import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHarness, makeBase, samePixels } from './geometryTestHarness.mjs';
import { createExactGeometry, windowEdits, overlayWindowEdits, analysisAreaEdited, confirmedImageArea } from './provisionalPhoto.js';
import { resolveAnalysisRegion, imageAreaFromWorkingRect } from './analysisRegion.js';
import { workingPointsToBase, buildCropDetectionInput, isSameAnalysisFrame } from './cropColorAnalysis.js';
import { estimateAutoWhiteBalance } from './autoWhiteBalance.js';
import { applyPreparedAdjustmentsToBuffer, applyPreparedAdjustmentsToBuffer16 } from './adjustmentPipeline.js';

// Real history capture, source installation, restore, undo/redo, geometry,
// automatic WB and 8/16 adjustment samples. Only detection/inversion are leaves.
const source = readFileSync(process.env.NC229_CALLER_SOURCE || new URL('./main.js', import.meta.url), 'utf8');
const fn = name => {
  const start = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source)?.index;
  assert.notEqual(start, undefined, name);
  return source.slice(start, source.indexOf('\n    }', start) + 6);
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
function fixture(staged, manualWb = false) {
  const h = createHarness(staged ? standIn : full, { realProcessNegative: true });
  const { context: c, target, state } = h;
  Object.assign(state, { filmType: 'color', positiveMode: 'correct', exposure: 0, coreExposure: 0, expiredEnabled: false,
    wbR: 1, wbG: 1, wbB: 1, wbAutoConfidence: null, wbSemanticApplied: false, wbUserOverride: false, grayPointSampled: false,
    semanticMap: null, currentStep: 3, autoFrame: { lastDiagnostics: structuredClone(staged ? standInMeta : fullMeta) } });
  if (manualWb) Object.assign(state, { wbR: 1.17, wbG: 1, wbB: .83, wbUserOverride: true });
  const detections = [], held = [];
  Object.assign(target, { createExactGeometry, windowEdits, overlayWindowEdits, analysisAreaEdited, confirmedImageArea,
    resolveAnalysisRegion, imageAreaFromWorkingRect, workingPointsToBase, buildCropDetectionInput, isSameAnalysisFrame,
    estimateAutoWhiteBalance, cropHitHold: false,
    usesSilverCoreConversion: () => true,
    // Use real geometry pixels and WB sampling; no display-sized stand-in.
    convertFromCurrentSource: async () => state.conversionSourceImageData,
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
for (const timing of ['pending-hit', 'completed-hit', 'confirmation']) for (const stack of ['undo', 'redo']) for (const manualWb of [false, true]) {
  if (selected !== 'all' && selected !== `${timing}-${stack}`) continue;
  const h = fixture(true, manualWb), { context: c, state } = h;
  const baseline = h.target.extractCurrentSettings();
  const record = { decodedImage: full, status: 'decoded' };
  const provisional = { size: { width: 32, height: 24 }, fullSize: { width: 64, height: 48 },
    geometry: createExactGeometry({ size: { width: 32, height: 24 }, fullSize: { width: 64, height: 48 } }), settledSnapshot: baseline, record };
  state.provisional = provisional;
  const confirmation = timing === 'confirmation' ? area(.2, .25, .8, .75) : null;
  await apply(h, rect, { held: timing === 'pending-hit', analysisOnly: Boolean(confirmation), selectedArea: confirmation });
  c.pushUndo('exposure');
  state.exposure = 27;
  if (timing === 'pending-hit') await land(h);
  if (stack === 'redo') await c.performUndo();
  const settled = { ...baseline, autoFrameMeta: structuredClone(fullMeta), cropRegion: null };
  c.installFullDecode(record, provisional, full, settled);
  await c.whenGeometrySettled();
  await c.processNegative();
  await c.settlePendingCropDetection();
  state.provisional = null;
  record.status = 'installed';
  const promoted = [...h.target.undoStack, ...h.target.redoStack].filter(s => s.label === 'exposure');
  assert.ok(promoted.length, 'real exposure history survived source promotion');
  const reference = fixture(false, manualWb);
  await apply(reference, fullRect, { analysisOnly: Boolean(confirmation), selectedArea: confirmation });
  await reference.context.settlePendingCropDetection();
  const restored = stack === 'undo' ? c.performUndo() : c.performRedo();
  // Exact consumers must wait for history's full-base analysis, not see the
  // entry's stand-in hit while an asynchronous restore runs.
  await c.settlePendingCropDetection();
  await restored;
  reference.state.exposure = stack === 'undo' ? 0 : 27;
  assert.deepEqual(canon(state.autoFrame.lastDiagnostics), canon(reference.state.autoFrame.lastDiagnostics), `${timing}/${stack}: restored full-base diagnostics`);
  assert.deepEqual([state.wbR, state.wbG, state.wbB], [reference.state.wbR, reference.state.wbG, reference.state.wbB], 'full-base automatic WB');
  samePixels(state.processedImageData, reference.state.processedImageData, 'exact restored geometry/conversion samples');
  for (const depth of [8, 16]) assert.deepEqual(samples(h, depth), samples(reference, depth), `${depth}-bit adjustment samples match one stage`);
  await (stack === 'undo' ? c.performRedo() : c.performUndo());
  await c.settlePendingCropDetection();
  reference.state.exposure = stack === 'undo' ? 27 : 0;
  for (const depth of [8, 16]) assert.deepEqual(samples(h, depth), samples(reference, depth), `${depth}-bit samples after opposite history action`);
  assert.ok(h.detections.every(d => d.base === standIn || d.base === full));
  h.pool.dispose(); reference.pool.dispose();
  cases++;
}
console.log(`provisionalHistoryAnalysis: ${cases} pending/completed hits and confirmations on undo/redo stacks promote full-base diagnostics/WB; manual WB and exact 8/16 samples preserved`);

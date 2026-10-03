// Standalone Node test: Apply Crop converts without waiting for the
// crop-area detection (#245). Runs the real handler and detection functions
// of main.js in the geometry harness - run with:
// node negative2positive/src/app/cropDetectionApply.test.mjs
//
// - The provisional diagnostics equal the miss outcome of the single pass
//   before #245, so a miss converts exactly once with the final meta.
// - A hit completes the diagnostics; a conversion that read the miss outcome
//   is redone once, and never while one is running.
// - A hit that lands before the conversion starts is converted once.
// - Undo, a second Apply and a new load end the detection; the barrier
//   settles only after a hit's conversion.
// - Apply inside another task's studioBusy (a detection tail) leaves that
//   lock set (R1-034).
// - With the expired rescue on, the conversion waits for the detection.
// - The hit's conversion supersedes a full-resolution render the provisional
//   pass armed: the exact plane installed is the hit's (R1-070).
// - History taken while the detection ran (an edit after Apply, a slider
//   drag across the hit) gets the hit and its auto white balance on undo or
//   redo, as the single pass's entries had them; an undo of such an edit
//   before the reply keeps the detection; entries of another Apply, or taken
//   before Apply, are left alone (R1-072, R1-134).
// - Applying, editing at once and exporting gives what applying, waiting for
//   the detection, editing and exporting gives (synthetic parity).
// - Until the detection ends, Studio reads it as running (the frame notice,
//   the filmstrip's review flag); it re-reads both when it ends (R1-148).

import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHarness, makeBase, applyCropHandlerSource, settle, functionSource } from './geometryTestHarness.mjs';
import { imageAreaFromWorkingRect } from './analysisRegion.js';
import { isSameAnalysisFrame, workingPointsToBase, buildCropDetectionInput } from './cropColorAnalysis.js';
import { normalizeAngleDegrees } from './imageGeometry.js';

const base = makeBase(90, 64, 5);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

// HEAD's single pass (1703835 + #244), for a miss: the meta Apply installed.
function headMissMeta(previous, state, cropRegion, nextGeometry) {
  const meta = structuredClone(previous || {});
  meta.analysisArea ||= imageAreaFromWorkingRect(state.cropRegion || { left: 0, top: 0, width: state.originalImageData.width, height: state.originalImageData.height }, state, base);
  meta.analysisNeedsReview = true;
  meta.importAuto = true;
  return meta;
}

// The white balance the stand-in auto white balance sets (below).
const HIT_WB = { wbR: 1.08, wbG: 1, wbB: 0.93, wbAutoConfidence: 'high' };
const whiteBalanceOf = state => ({ wbR: state.wbR, wbG: state.wbG, wbB: state.wbB, wbAutoConfidence: state.wbAutoConfidence ?? null });
const NO_WB = whiteBalanceOf({ wbR: 1, wbG: 1, wbB: 1 });

function setup({ expired = false, step = 3, points = null, immediate = false, autoWb = false, previous = { analysisArea: null, imageArea: null, method: 'import' } } = {}) {
  const h = createHarness(base);
  const c = h.context;
  const conversions = [];
  let release = null;
  const detection = { calls: 0, resolve: null, gate: null };
  Object.assign(h.target, {
    applyCropBtn: { disabled: false }, cancelCropBtn: { disabled: false },
    getLoadingOverlay: () => ({ show: async () => {}, hide() {} }),
    studioWorkspace: { sync() {}, text: key => key },
    imageAreaFromWorkingRect, isSameAnalysisFrame, workingPointsToBase, buildCropDetectionInput,
    estimateAutoWhiteBalance: () => ({ ...HIT_WB, confidence: HIT_WB.wbAutoConfidence }),
    resolveAnalysisRegion: () => null, analysisRegionSample: () => ({}), baseSizeSource: () => base,
    exitCropMode: () => { h.state.cropping = false; h.state.cropDraft = null; },
    // The worker's answer is released by the test.
    runOpenCvTask: async (type, task) => {
      assert.equal(type, 'detect-crop-area');
      detection.calls++;
      const input = await task.build();
      assert.ok(input.region.width > 0);
      if (!immediate) await new Promise(resolve => { detection.resolve = resolve; });
      return typeof points === 'function' ? points(input) : points;
    },
    // A conversion that reads the diagnostics when it starts and when it
    // ends (auto white balance), with processNegative's in-flight rule.
    processNegative: (options = {}) => {
      if (h.target.processNegativeInFlight) return h.target.processNegativeInFlight;
      c.noteConversionStarted();
      const promise = (async () => {
        await c.whenGeometrySettled();
        const start = structuredClone(h.state.autoFrame.lastDiagnostics);
        await new Promise(resolve => { release = resolve; });
        conversions.push({ start, end: structuredClone(h.state.autoFrame.lastDiagnostics), options });
        h.state.processedImageData = h.state.croppedImageData || h.state.originalImageData;
        h.state.currentStep = 3;
        if (autoWb && options.automatic !== false) await c.maybeAutoWhiteBalance(h.state.processedImageData);
      })();
      h.target.processNegativeInFlight = promise;
      return promise.finally(() => { if (h.target.processNegativeInFlight === promise) h.target.processNegativeInFlight = null; });
    },
    convertFromCurrentSource: async () => h.state.processedImageData
  });
  vm.runInContext(['automaticWhiteBalanceResult', 'maybeAutoWhiteBalance', 'autoWbSampleKey', 'frameWantsAutoWhiteBalance'].map(functionSource).join('\n'), c);
  vm.runInContext(applyCropHandlerSource(), c);
  h.state.currentStep = step;
  h.state.expiredEnabled = expired;
  h.state.autoFrame.lastDiagnostics = previous ? structuredClone(previous) : null;
  const openDraft = (rect = { left: 10.2, top: 8.6, width: 60.3, height: 40.1 }) => {
    const preview = c.renderFrameSample(700_000);
    h.state.cropping = true;
    h.state.cropDraft = { sourceImageData: h.state.originalImageData, rotatedSize: { width: preview.width, height: preview.height }, rect, rotationBase: 0, straightenAngle: 0 };
  };
  const finishConversion = async () => {
    for (let i = 0; i < 50 && !release; i++) await tick();
    assert.ok(release, 'a conversion is running');
    const done = release; release = null;
    done();
    await settle();
  };
  const answer = async () => {
    for (let i = 0; i < 50 && !detection.resolve; i++) await tick();
    assert.ok(detection.resolve, 'the detection was requested');
    const done = detection.resolve; detection.resolve = null;
    done();
    await settle();
  };
  return { h, c, conversions, detection, openDraft, finishConversion, answer, isConverting: () => Boolean(release) };
}

const hitPoints = input => {
  const { crop } = input;
  return [{ x: crop.left + 3, y: crop.top + 2 }, { x: crop.left + crop.width - 3, y: crop.top + 2 },
    { x: crop.left + crop.width - 3, y: crop.top + crop.height - 2 }, { x: crop.left + 3, y: crop.top + crop.height - 2 }];
};

// ---- A miss: one conversion, with the meta HEAD's single pass installed ----
{
  const t = setup({ points: null });
  const previous = structuredClone(t.h.state.autoFrame.lastDiagnostics);
  const stateBefore = { cropRegion: t.h.state.cropRegion, originalImageData: t.h.state.originalImageData, rotationAngle: 0, mirrored: false };
  t.openDraft();
  const applying = t.c.applyCropHandler();
  await t.finishConversion();
  await applying;
  const expected = headMissMeta(previous, stateBefore, t.h.state.cropRegion, { rotationAngle: 0, mirrored: false });
  assert.deepEqual(t.conversions[0].start, expected, 'the provisional meta is the miss outcome');
  assert.equal(t.detection.calls, 1);
  assert.ok(t.c.hasPendingCropDetection(), 'the detection outlives the conversion');
  await t.answer();
  assert.equal(t.c.hasPendingCropDetection(), false);
  assert.equal(t.conversions.length, 1, 'a miss converts once');
  assert.deepEqual(t.h.state.autoFrame.lastDiagnostics, expected, 'a miss leaves the meta as installed');
  assert.equal(t.h.target.cropDetectionStats.misses, 1);
}

// ---- R1-148: until the detection ends, its miss outcome asks for nothing ----
// Studio re-reads the frame notice when the detection starts and ends, and
// renders the filmstrip once when it ends by itself (a miss then flags the
// photo, a hit does not); Apply marks the photo dirty, which renders the
// filmstrip in a roll, once the detection is pending.
for (const outcome of ['miss', 'hit', 'undo']) {
  const t = setup({ points: outcome === 'miss' ? null : hitPoints });
  let syncs = 0, renders = 0;
  const pendingWhenDirty = [];
  Object.assign(t.h.target, {
    studioWorkspace: { sync() { syncs++; }, text: key => key },
    updateFileListUI: () => { renders++; },
    markCurrentFileDirty: () => { pendingWhenDirty.push(t.c.cropAreaDetecting()); }
  });
  t.openDraft();
  const applying = t.c.applyCropHandler();
  await t.finishConversion();
  await applying;
  assert.deepEqual(pendingWhenDirty, [true], outcome + ': the photo is marked dirty once the detection is pending');
  assert.equal(t.c.cropAreaDetecting(), true, outcome + ': the provisional positive is on screen while the detection runs');
  assert.equal(t.h.state.autoFrame.lastDiagnostics.analysisNeedsReview, true);
  const before = { syncs, renders };
  if (outcome === 'undo') {
    for (let i = 0; i < 50 && !t.detection.resolve; i++) await tick();
    t.c.performUndo();
    await settle();
    assert.ok(syncs > before.syncs, 'undo: Studio re-reads the frame notice');
    // The restore renders on its own; the late answer of the detection the
    // undo ended adds nothing.
    before.renders = renders;
    await t.answer();
  } else {
    await t.answer();
    if (outcome === 'hit') await t.finishConversion();
    await t.c.settlePendingCropDetection();
  }
  assert.equal(t.c.cropAreaDetecting(), false, outcome + ': the detection has ended');
  assert.ok(syncs > before.syncs, outcome + ': Studio re-reads the frame notice');
  assert.equal(renders - before.renders, outcome === 'undo' ? 0 : 1, outcome + ': one filmstrip render when the detection ends by itself, none when it is ended');
  assert.equal(t.h.state.autoFrame.lastDiagnostics?.analysisNeedsReview ?? null, outcome === 'hit' ? false : outcome === 'miss' ? true : null);
}

// ---- A hit after the conversion started: converted again, never mid-conversion ----
{
  const t = setup({ points: hitPoints });
  t.openDraft();
  const applying = t.c.applyCropHandler();
  for (let i = 0; i < 50 && !t.isConverting(); i++) await tick();
  await t.answer();
  assert.equal(t.conversions.length, 0, 'the hit waits for the running conversion');
  assert.equal(t.h.state.autoFrame.lastDiagnostics.analysisNeedsReview, true, 'the meta is not changed mid-conversion');
  let settled = false;
  const barrier = t.c.settlePendingCropDetection().then(() => { settled = true; });
  await t.finishConversion();
  await applying;
  assert.equal(t.conversions.length, 1);
  assert.deepEqual(t.conversions[0].start, t.conversions[0].end, 'the provisional conversion saw one meta');
  assert.equal(settled, false, 'the barrier waits for the hit\'s conversion');
  await t.finishConversion();
  await barrier;
  assert.equal(t.conversions.length, 2, 'a hit converts at most twice');
  const meta = t.conversions[1].start;
  assert.equal(meta.analysisNeedsReview, false);
  assert.equal(meta.frameIncomplete, false);
  assert.equal(meta.method, 'manual-image-window');
  assert.equal(meta.importAuto, true);
  assert.equal(meta.imageArea.length, 4);
  assert.equal(t.conversions[1].options.quiet, true, 'the hit converts quietly');
  assert.deepEqual(t.conversions[1].start, t.conversions[1].end);
  assert.equal(t.h.target.cropDetectionStats.reconversions, 1);
}

// ---- A hit before the conversion starts: one conversion, with the hit ----
{
  // The worker answers within the click's microtasks, while the geometry is
  // still building in the pool.
  const t = setup({ points: hitPoints, immediate: true });
  t.openDraft();
  const applying = t.c.applyCropHandler();
  await t.finishConversion();
  await applying;
  await t.c.settlePendingCropDetection();
  assert.equal(t.conversions.length, 1, 'converted once');
  assert.equal(t.conversions[0].start.method, 'manual-image-window');
  assert.equal(t.conversions[0].start.analysisNeedsReview, false);
}

// ---- Undo, a second Apply and a new load end the detection ----
for (const cancel of ['undo', 'apply', 'load']) {
  const t = setup({ points: hitPoints });
  t.openDraft();
  const applying = t.c.applyCropHandler();
  await t.finishConversion();
  await applying;
  const installed = t.h.state.autoFrame.lastDiagnostics;
  const first = t.h.target.cropDetection;
  const firstAnswer = () => { const done = t.detection.resolve; t.detection.resolve = null; done?.(); return Boolean(done); };
  // The worker has not answered the first detection yet.
  for (let i = 0; i < 50 && !t.detection.resolve; i++) await tick();
  const pendingAnswer = t.detection.resolve;
  t.detection.resolve = null;
  if (cancel === 'undo') {
    t.c.performUndo();
  } else if (cancel === 'apply') {
    t.openDraft({ left: 5, top: 5, width: 50, height: 35 });
    const second = t.c.applyCropHandler();
    await t.finishConversion();
    await second;
  } else {
    t.h.target.loadGeneration++;
    t.c.cancelCropDetection();
  }
  await first.settled;
  assert.notEqual(t.h.target.cropDetection, first, `${cancel}: the first detection ended`);
  const conversionsBefore = t.conversions.length;
  pendingAnswer();
  await settle();
  if (cancel === 'apply') {
    assert.equal(t.detection.calls, 2);
    assert.ok(t.c.hasPendingCropDetection(), 'the second Apply has its own detection');
    firstAnswer();
    await settle();
    await t.finishConversion();
    await t.c.settlePendingCropDetection();
  }
  assert.equal(installed.analysisNeedsReview, true, `${cancel}: the stale hit never completes the old meta`);
  assert.equal(t.conversions.length, conversionsBefore + (cancel === 'apply' ? 1 : 0), `${cancel}: no conversion from a stale hit`);
  assert.ok(t.h.target.cropDetectionStats.stale >= 1, `${cancel}: counted stale`);
}

// ---- Apply inside another task's lock (R1-034) ----
// A photo's detection tail holds studioBusy (editing and export locked);
// Apply leaves that lock to its owner, and releases only a lock it took.
{
  for (const held of [true, false]) {
    const t = setup({ points: null, immediate: true });
    const body = t.h.target.document.body;
    if (held) body.dataset.studioBusy = 'true';
    t.openDraft();
    const applying = t.c.applyCropHandler();
    await t.finishConversion();
    await applying;
    assert.equal(body.dataset.studioBusy, held ? 'true' : undefined,
      held ? 'the tail keeps its lock: Export stays disabled until it ends' : 'Apply releases the lock it took');
  }
}

// ---- Expired rescue on: the conversion waits for the detection ----
{
  const t = setup({ expired: true, points: hitPoints });
  t.openDraft();
  const applying = t.c.applyCropHandler();
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(t.isConverting(), false, 'no conversion before the detection');
  await t.answer();
  await t.finishConversion();
  await applying;
  assert.equal(t.conversions.length, 1);
  assert.equal(t.conversions[0].start.method, 'manual-image-window', 'converted with the hit, as before');
}

// ---- Same frame as the stored image area, and Confirm analysis: no detection ----
{
  const t = setup({ points: hitPoints });
  t.openDraft();
  // Store the image area of the frame about to be applied.
  const rect = t.h.state.cropDraft.rect;
  t.h.state.autoFrame.lastDiagnostics.imageArea = imageAreaFromWorkingRect({ left: Math.floor(rect.left), top: Math.floor(rect.top), width: Math.floor(rect.width), height: Math.floor(rect.height) }, { rotationAngle: 0, mirrored: false }, base);
  const applying = t.c.applyCropHandler();
  await t.finishConversion();
  await applying;
  assert.equal(t.detection.calls, 0, 'the same frame is not detected again');
  assert.equal(t.c.hasPendingCropDetection(), false);
}

// ---- Step 1/2: nothing converts; a hit only completes the meta ----
{
  const t = setup({ step: 1, points: hitPoints });
  t.openDraft();
  await t.c.applyCropHandler();
  await t.answer();
  assert.equal(t.conversions.length, 0);
  assert.equal(t.h.state.autoFrame.lastDiagnostics.method, 'manual-image-window');
  assert.equal(normalizeAngleDegrees(t.h.state.rotationAngle), 0);
}

// ---- History taken while the detection ran (R1-072, R1-134) ----
// Before #245 the hit was in place before any edit could be made, so every
// entry taken after Apply held it and its auto white balance. An entry taken
// while the detection runs gets them when it is restored after the hit.
const applyAndConvert = async t => {
  t.openDraft();
  const applying = t.c.applyCropHandler();
  await t.finishConversion();
  await applying;
};
const hitLands = async t => {
  await t.answer();
  await t.finishConversion();
  await t.c.settlePendingCropDetection();
};
const view = state => ({ exposure: state.exposure, wb: whiteBalanceOf(state), meta: structuredClone(state.autoFrame.lastDiagnostics) });
{
  const t = setup({ points: hitPoints, autoWb: true });
  await applyAndConvert(t);
  assert.deepEqual(whiteBalanceOf(t.h.state), NO_WB, 'the miss outcome skips auto white balance');
  t.c.pushUndo('exposure');
  t.h.state.exposure = 0.5;
  await hitLands(t);
  const hit = view(t.h.state);
  assert.equal(hit.meta.method, 'manual-image-window');
  assert.deepEqual(hit.wb, HIT_WB, 'the hit ran auto white balance');
  t.c.performUndo();
  const undone = view(t.h.state);
  assert.equal(undone.exposure, 0, 'the edit is undone');
  assert.equal(undone.meta.analysisNeedsReview, false, 'undoing an edit made while the detection ran keeps the hit');
  assert.equal(undone.meta.method, 'manual-image-window');
  assert.deepEqual(undone.meta.imageArea, hit.meta.imageArea);
  assert.deepEqual(undone.wb, HIT_WB, '...and its white balance');
  t.c.performRedo();
  assert.deepEqual(view(t.h.state), hit, 'redo brings the edit back over the hit');
  // Apply's own entry still holds the frame before Apply.
  t.c.performUndo();
  t.c.performUndo();
  assert.equal(t.h.state.cropRegion, null, 'undoing Apply restores the uncropped frame');
  assert.equal(t.h.state.autoFrame.lastDiagnostics.method, 'import', '...with the diagnostics before Apply');
  assert.deepEqual(whiteBalanceOf(t.h.state), NO_WB);
}

// ---- An undo before the reply keeps the detection; the hit reaches both entries ----
{
  const t = setup({ points: hitPoints, autoWb: true });
  await applyAndConvert(t);
  t.c.pushUndo('exposure');
  t.h.state.exposure = 0.5;
  t.c.performUndo();
  assert.ok(t.c.hasPendingCropDetection(), 'undoing an edit made after Apply does not end the detection');
  assert.equal(t.h.state.exposure, 0);
  await hitLands(t);
  const undone = view(t.h.state);
  assert.equal(undone.meta.method, 'manual-image-window', 'the hit applies to the restored state');
  assert.equal(undone.meta.analysisNeedsReview, false);
  assert.deepEqual(undone.wb, HIT_WB);
  assert.equal(t.h.target.cropDetectionStats.reconversions, 1);
  t.c.performRedo();
  const redone = view(t.h.state);
  assert.equal(redone.exposure, 0.5);
  assert.deepEqual({ ...redone, exposure: 0 }, undone, 'the redo entry has the hit too');
  // Undo of Apply itself still ends a pending detection (the accepted edge
  // case: its redo brings the miss outcome back).
  const u = setup({ points: hitPoints, autoWb: true });
  await applyAndConvert(u);
  u.c.performUndo();
  assert.equal(u.c.hasPendingCropDetection(), false, 'undoing Apply ends the detection');
}

// ---- A white balance the user set while the detection ran wins, in history too ----
{
  const t = setup({ points: hitPoints, autoWb: true });
  await applyAndConvert(t);
  t.c.pushUndo('exposure');
  t.h.state.exposure = 0.5;
  t.c.pushUndo('wbR');
  Object.assign(t.h.state, { wbR: 1.3, wbUserOverride: true, wbAutoConfidence: null });
  await hitLands(t);
  assert.equal(t.h.state.wbR, 1.3, 'the user\'s white balance wins over the hit\'s');
  assert.equal(t.h.state.autoFrame.lastDiagnostics.method, 'manual-image-window');
  t.c.performUndo();
  assert.deepEqual(whiteBalanceOf(t.h.state), HIT_WB, 'undoing manual WB restores the hit-derived automatic gains');
  assert.equal(t.h.state.autoFrame.lastDiagnostics.method, 'manual-image-window', 'but it has the hit');
  t.c.performUndo();
  assert.equal(t.h.state.exposure, 0);
  assert.deepEqual(whiteBalanceOf(t.h.state), HIT_WB, 'undoing the exposure also keeps automatic WB');
  t.c.performRedo();
  t.c.performRedo();
  assert.equal(t.h.state.wbR, 1.3, 'redo keeps the manual gains');
}

// ---- Entries of another Apply are left alone ----
{
  // Apply A's detection is still pending when the user edits and applies B,
  // which ends it; then A's late hit and B's hit come in. Neither A's edit
  // nor B's own 'crop' entry (both hold A's miss outcome) gets a hit.
  const t = setup({ points: hitPoints, autoWb: true });
  await applyAndConvert(t);
  for (let i = 0; i < 50 && !t.detection.resolve; i++) await tick();
  const answerA = t.detection.resolve;
  t.detection.resolve = null;
  assert.ok(answerA && t.c.hasPendingCropDetection(), 'A\'s detection is pending');
  t.c.pushUndo('exposure');
  t.h.state.exposure = 0.25;
  const missA = structuredClone(t.h.state.autoFrame.lastDiagnostics);
  const cropA = { ...t.h.state.cropRegion };
  t.openDraft({ left: 5, top: 5, width: 50, height: 35 });
  const applyingB = t.c.applyCropHandler();
  await t.finishConversion();
  await applyingB;
  t.c.pushUndo('exposure');
  t.h.state.exposure = 0.5;
  answerA();
  await settle();
  assert.equal(t.h.target.cropDetectionStats.stale, 1, 'A\'s hit is stale');
  await hitLands(t);
  assert.equal(t.h.state.autoFrame.lastDiagnostics.method, 'manual-image-window', 'B hit');
  assert.deepEqual(t.h.target.undoStack.map(entry => entry.label), ['crop', 'exposure', 'crop', 'exposure']);
  t.c.performUndo();
  assert.equal(t.h.state.exposure, 0.25);
  assert.equal(t.h.state.autoFrame.lastDiagnostics.method, 'manual-image-window', 'B\'s edit gets B\'s hit');
  assert.deepEqual(whiteBalanceOf(t.h.state), HIT_WB);
  t.c.performUndo();
  assert.deepEqual({ ...t.h.state.cropRegion }, cropA, 'undoing B brings A\'s frame back');
  assert.deepEqual(t.h.state.autoFrame.lastDiagnostics, missA, 'B\'s crop entry keeps A\'s miss outcome');
  assert.deepEqual(whiteBalanceOf(t.h.state), NO_WB, '...and its white balance');
  t.c.performUndo();
  assert.equal(t.h.state.exposure, 0);
  assert.deepEqual(t.h.state.autoFrame.lastDiagnostics, missA, 'A\'s edit keeps A\'s miss outcome');
  assert.deepEqual(whiteBalanceOf(t.h.state), NO_WB);
  t.c.performUndo();
  assert.equal(t.h.state.autoFrame.lastDiagnostics.method, 'import', 'A\'s crop entry holds the frame before A');
}

// ---- A slider drag across the hit, and a stale pre-drag snapshot ----
{
  // The slider takes its entry at pointerdown and commits it on release
  // (setupSlider): a drag started while the detection ran commits after the
  // hit landed, and its entry still gets the hit (R1-134).
  const t = setup({ points: hitPoints, autoWb: true });
  await applyAndConvert(t);
  const preDrag = t.c.captureSnapshot('exposure');
  t.h.state.exposure = 0.5;
  await hitLands(t);
  t.c.commitUndoSnapshot(preDrag);
  t.c.performUndo();
  assert.equal(t.h.state.exposure, 0);
  assert.equal(t.h.state.autoFrame.lastDiagnostics.method, 'manual-image-window', 'a drag across the hit keeps it on undo');
  assert.deepEqual(whiteBalanceOf(t.h.state), HIT_WB);
  // An entry taken before Apply (a pointerdown that never committed, then a
  // keyboard change) is the frame before Apply: it gets no hit.
  const u = setup({ points: hitPoints, autoWb: true });
  const stale = u.c.captureSnapshot('cyan');
  await applyAndConvert(u);
  u.c.commitUndoSnapshot(stale);
  await hitLands(u);
  u.c.performUndo();
  assert.equal(u.h.state.cropRegion, null);
  assert.equal(u.h.state.autoFrame.lastDiagnostics.method, 'import', 'an entry taken before Apply gets no hit');
  assert.deepEqual(whiteBalanceOf(u.h.state), NO_WB);
}

// ---- Parity: edit at once vs wait for the detection (synthetic) ----
// The same user actions, Apply then an exposure edit, export, undo, export,
// redo, give the same state whether the edit came before or after the hit.
{
  const run = async (immediate, manualWb) => {
    const t = setup({ points: hitPoints, autoWb: true });
    await applyAndConvert(t);
    if (!immediate) await hitLands(t);
    t.c.pushUndo('exposure');
    t.h.state.exposure = 0.5;
    if (manualWb) {
      t.c.pushUndo('wbR');
      // The same explicit RGB recipe in both runs: a one-channel edit owns
      // the untouched channels too, whose starting gains differ meanwhile.
      Object.assign(t.h.state, { wbR: 1.3, wbG: 1.1, wbB: 0.9, wbUserOverride: true, wbAutoConfidence: null });
    }
    if (immediate) await hitLands(t);
    const states = [view(t.h.state)];
    t.c.performUndo();
    states.push(view(t.h.state));
    if (manualWb) {
      t.c.performUndo();
      states.push(view(t.h.state));
      t.c.performRedo();
      states.push(view(t.h.state));
    }
    t.c.performRedo();
    states.push(view(t.h.state));
    return states;
  };
  for (const manualWb of [false, true]) {
    assert.deepEqual(await run(true, manualWb), await run(false, manualWb),
      `pending-window exposure${manualWb ? ' and manual WB' : ''} history matches waiting for the hit`);
  }
}

// ---- A full-resolution render in flight when the hit lands (R1-070) ----
// The real processNegative, full-resolution scheduling and core rerender;
// the conversion records the analysis area it read and full-resolution
// requests wait for the test.
async function fullResolutionRun({ hitFirst = false } = {}) {
  const h = createHarness(base, { realProcessNegative: true });
  const c = h.context;
  const fullRenders = [];
  // The frame on screen when each preview conversion starts.
  const previews = [];
  let answer = null;
  const areaOf = meta => JSON.stringify(meta?.imageArea || meta?.analysisArea || null);
  delete h.target.applyProcessedImageToState;
  Object.assign(h.target, {
    applyCropBtn: { disabled: false }, cancelCropBtn: { disabled: false },
    getLoadingOverlay: () => ({ show: async () => {}, updateProgress() {}, hide() {} }),
    studioWorkspace: { sync() {}, text: key => key },
    imageAreaFromWorkingRect, isSameAnalysisFrame, workingPointsToBase, buildCropDetectionInput,
    exitCropMode: () => { h.state.cropping = false; h.state.cropDraft = null; },
    runOpenCvTask: async (type, task) => {
      const input = await task.build();
      if (!hitFirst) await new Promise(resolve => { answer = resolve; });
      return hitPoints(input);
    },
    usesSilverCoreConversion: () => true, hasSeparateConversionPreview: () => true,
    routeCoreRequest: options => ({ full: Boolean(options?.full), downgraded: false }),
    waitForNextFrame: () => Promise.resolve(), backgroundGate: { bump() {} },
    fullResolutionRenderTimer: null, fullResolutionConversionAbort: null, FULL_RESOLUTION_IDLE_DELAY_MS: 0,
    FULL_RESOLUTION_INTERACTIVE_DELAY_MS: 0, displayedFrameToken: null, repairedPreviewShown: null, exportBands: null,
    _coreReprocessActive: 0, _coreReprocessFullInFlight: false, _coreReprocessPreviewInFlight: false, _coreReprocessPending: null,
    convertFromCurrentSource: async (settings, { preview = false } = {}) => {
      const area = areaOf(h.state.autoFrame.lastDiagnostics);
      const source = h.state.conversionSourceImageData;
      if (preview) {
        const shown = h.state.processedImageData;
        previews.push({ area, shown: shown ? { preview: shown.preview === true, flaggedPreview: h.state.processedImageDataIsPreview, pending: h.state.fullResolutionPending } : null });
        return { width: 20, height: 14, area, preview: true };
      }
      const request = { area, release: null };
      fullRenders.push(request);
      await new Promise(resolve => { request.release = resolve; });
      return { width: source.width, height: source.height, area };
    }
  });
  vm.runInContext(['applyProcessedImageToState', 'startFullResolutionRender', 'scheduleFullResolutionRender',
    'clearFullResolutionRenderState', 'abortSupersededFullResolutionConversion', 'beginFullResolutionConversion',
    'endFullResolutionConversion', 'rerenderWithCoreControls', 'runCoreReprocess'].map(functionSource).join('\n'), c);
  vm.runInContext(applyCropHandlerSource(), c);
  h.state.currentStep = 3;
  h.state.autoFrame.lastDiagnostics = { analysisArea: null, imageArea: null, method: 'import' };
  const preview = c.renderFrameSample(700_000);
  h.state.cropping = true;
  h.state.cropDraft = { sourceImageData: h.state.originalImageData, rotatedSize: { width: preview.width, height: preview.height }, rect: { left: 10.2, top: 8.6, width: 60.3, height: 40.1 }, rotationBase: 0, straightenAngle: 0 };
  const waitFor = async (what, check) => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.ok(check(), what);
  };
  await c.applyCropHandler();
  await h.target.processNegativeInFlight;
  const missArea = areaOf(h.state.autoFrame.lastDiagnostics);
  assert.equal(h.state.processedImageDataIsPreview, true, 'the conversion shows a preview');
  if (!hitFirst) {
    // The full-resolution render the provisional pass armed starts with the
    // miss outcome, and is still converting when the hit lands.
    await waitFor('a full-resolution render is in flight', () => fullRenders.length === 1);
    assert.equal(fullRenders[0].area, missArea);
    await waitFor('the detection was requested', () => answer);
    answer();
  }
  await c.settlePendingCropDetection();
  const hitArea = areaOf(h.state.autoFrame.lastDiagnostics);
  assert.equal(JSON.parse(hitArea).length, 4, 'the hit set the image area');
  if (!hitFirst) assert.notEqual(hitArea, missArea, 'the hit changed the analysis area');
  assert.equal(h.state.processedImageData.area, hitArea, 'the hit\'s conversion is on screen');
  if (!hitFirst) {
    // While the hit converted, the provisional preview stayed on screen
    // flagged as a preview that owes an exact render.
    assert.deepEqual(previews.map(entry => entry.area), [missArea, hitArea]);
    assert.deepEqual(previews[1].shown, { preview: true, flaggedPreview: true, pending: true }, 'the provisional preview never passes for the exact frame');
  }
  assert.equal(h.state.fullResolutionPending, true, 'the hit\'s conversion owes a full-resolution render');
  // Whatever the stale render brings back is not installed.
  for (const request of fullRenders) request.release();
  await settle();
  await waitFor('a full-resolution render of the hit', () => fullRenders.some(request => request.area === hitArea));
  for (const request of fullRenders) request.release?.();
  await waitFor('the exact plane landed', () => !h.state.processedImageDataIsPreview && !h.state.fullResolutionPending);
  await settle();
  assert.equal(h.state.processedImageData.area, hitArea, 'the exact plane is converted with the hit\'s analysis area');
  assert.equal(h.state.processedImageData.preview, undefined);
  return { exact: h.state.processedImageData.area, renders: fullRenders.map(request => request.area === hitArea ? 'hit' : 'miss') };
}
{
  const inFlight = await fullResolutionRun();
  assert.deepEqual(inFlight.renders, ['miss', 'hit'], 'the stale render is superseded by one of the hit');
  // The hit before the conversion: one pass, as before #245.
  const hitFirst = await fullResolutionRun({ hitFirst: true });
  assert.deepEqual(hitFirst.renders, ['hit']);
  assert.equal(inFlight.exact, hitFirst.exact, 'the exact plane does not depend on when the hit landed');
}

console.log('cropDetectionApply tests passed');

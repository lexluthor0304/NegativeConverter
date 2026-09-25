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
// - With the expired rescue on, the conversion waits for the detection.

import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHarness, makeBase, applyCropHandlerSource, settle } from './geometryTestHarness.mjs';
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

function setup({ expired = false, step = 3, points = null, immediate = false, previous = { analysisArea: null, imageArea: null, method: 'import' } } = {}) {
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
      })();
      h.target.processNegativeInFlight = promise;
      return promise.finally(() => { if (h.target.processNegativeInFlight === promise) h.target.processNegativeInFlight = null; });
    }
  });
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

console.log('cropDetectionApply tests passed');

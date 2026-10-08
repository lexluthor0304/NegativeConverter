import assert from 'node:assert/strict';
import vm from 'node:vm';
import { gpuSettleFixture, mainFunction, settle } from './gpuSettleHarness.mjs';

// #229 review R1-048: a photo switch right after a change the GPU drew (#239)
// sends that change's exact frame at once and waits for it, so the photo being
// left is remembered settled, with its exact frame and its history, as on the
// worker path (the warm return of #220/#222). Runs the real switchToFile and
// rememberPhotoSession up to the incoming photo, which is not under test.

class SwitchStopped extends Error {}

function switchFixture() {
  const f = gpuSettleFixture();
  const noop = () => {};
  const leaving = { file: 'a' };
  const target = { file: 'b' };
  const stored = [];
  Object.assign(f.state, {
    fileQueue: [leaving, target], currentFileIndex: 0, loadedFile: 'a', loadedBaseImageData: { width: 400, height: 300 },
    rawDecodePending: false, rawMetadata: null, filmEdge: null, zoomLevel: 1, panX: 0, panY: 0,
  });
  Object.assign(f.context, {
    studioAutoFrameRunning: false, singleExportActive: false, isDesktopBatchExportLocked: () => false, parkedPhoto: null,
    hasPendingCropDetection: () => false, exitCropMode: noop, exitBeforeAfter: noop, releaseBeforeAfterCanvas: noop,
    cancelProvisionalFrame: noop, getCurrentQueueItem: () => f.state.fileQueue[f.state.currentFileIndex],
    photoSessions: { take: () => null, put: (item, entry) => { stored.push({ item, entry }); return true; } },
    photoPrefetch: { take: () => null }, prefetchedItem: null, deferFileListRefresh: () => noop,
    persistCurrentFileSettings: noop, document: { body: { dataset: {} } }, loadGeneration: 0,
    beginActivation: () => { throw new SwitchStopped(); },
    hiddenJobs: { safeMode: false }, processNegativeInFlight: null, pendingBrushRepairs: 0, dustDrawing: false,
    dustAiRefresh: { rects: [] }, undoStack: [{ label: 'coreExposure' }], redoStack: [], photoSettingsKey: () => 'key',
    captureSnapshot: () => ({ refs: { processedImageData: f.state.processedImageData } }),
    photoPreviews: { put: () => true }, geometryDiagnostics: { coldSessions: false },
    buildAdjustmentSettings: () => ({ curves: { r: new Uint8Array(256), g: new Uint8Array(256), b: new Uint8Array(256) } }),
    samplePhotoPreviewSource: () => ({}), adjustPhotoPreviewSample: () => ({}), schedulePostPaintTask: noop,
  });
  vm.runInContext(['switchToFile', 'rememberPhotoSession', 'displayIsReduced'].map(mainFunction).join('\n'), f.context);
  let switched = false;
  const switchTo = (index, options) => f.context.switchToFile(index, options).then(
    () => assert.fail('the switch goes on to the incoming photo'),
    (err) => {
      if (!(err instanceof SwitchStopped)) throw err;
      switched = true;
    });
  return { ...f, leaving, stored, switchTo, get switched() { return switched; } };
}

{
  // A tick the GPU drew, its exact frame still waiting for the 150 ms idle
  // timer: the switch sends it at once, waits for it and for its plane.
  const f = switchFixture();
  f.clock.nextFrame();
  f.state.coreExposure = 10;
  f.context.scheduleCoreReprocess({ full: false });
  f.clock.runFrame();
  assert.deepEqual(f.log, ['gpu:10']);
  assert.equal(f.context.gpuPreviewScheduler.settleArmed(), true, 'its exact frame waits for the idle timer');
  const switching = f.switchTo(1);
  await settle();
  assert.equal(f.conversions.length, 1, 'the switch sends the exact frame at once');
  assert.equal(f.conversions[0].exposure, 10);
  assert.equal(f.stored.length, 0, 'nothing is remembered before it is on screen');
  await f.answer();
  assert.equal(f.commits.length, 1, 'its plane is committed as it lands');
  assert.equal(f.stored.length, 0);
  f.commits[0].resolve(new Uint16Array(4));
  await switching;
  assert.ok(f.switched);
  assert.equal(f.clock.armed(), 0, 'no timer was waited for');
  assert.equal(f.stored.length, 1);
  const { entry } = f.stored[0];
  assert.ok(entry.snapshot, 'the photo being left is remembered settled');
  assert.equal(entry.snapshot.refs.processedImageData.exposure, 10, 'with the exact frame of the change');
  assert.equal(entry.undo.length, 1, 'and its history');
}

{
  // A commit the GPU drew (a console key, a preset): its exact frame is still
  // converting at the click. The switch waits for it.
  const f = switchFixture();
  f.state.coreExposure = 20;
  f.context.scheduleCoreReprocess({ full: false, commit: true });
  f.clock.runFrame();
  assert.equal(f.conversions.length, 1, 'the commit converts at once');
  const switching = f.switchTo(1);
  await settle();
  assert.equal(f.conversions.length, 1, 'the switch converts nothing more');
  assert.equal(f.stored.length, 0);
  await f.answer();
  f.commits[0].resolve(new Uint16Array(4));
  await switching;
  assert.ok(f.stored[0].entry.snapshot, 'remembered settled');
  assert.equal(f.stored[0].entry.snapshot.refs.processedImageData.exposure, 20);
}

{
  // No GPU frame ahead: the switch remembers the photo at once, as before.
  const f = switchFixture();
  await f.switchTo(1);
  assert.equal(f.conversions.length, 0);
  assert.ok(f.stored[0].entry.snapshot);
}

{
  // A settle that cannot apply (its conversion fails) does not hold the switch.
  const f = switchFixture();
  f.state.coreExposure = 30;
  f.context.scheduleCoreReprocess({ full: false });
  f.clock.runFrame();
  const switching = f.switchTo(1);
  await settle();
  f.conversions[0].reject(new Error('worker restarted'));
  await switching;
  assert.ok(f.switched, 'the switch goes on');
  assert.ok(f.log.includes('abandon'), 'the display returns to its exact frame');
  assert.equal(f.stored.length, 1);
}

{
  // Restoring parked brush history precedes the GPU settle. Neither barrier
  // may let the outgoing photo be remembered with incomplete pixels.
  const f = switchFixture();
  let restored;
  const restoring = new Promise(resolve => { restored = resolve; });
  f.context.parkedPhoto = { file: 'a' };
  f.context.unparkOpenPhoto = async () => {
    await restoring;
    f.context.parkedPhoto = null;
  };
  f.state.coreExposure = 40;
  f.context.scheduleCoreReprocess({ full: false });
  f.clock.runFrame();
  const switching = f.switchTo(1);
  await settle();
  assert.equal(f.conversions.length, 0, 'no GPU settle before the parked history is restored');
  assert.equal(f.stored.length, 0, 'no incomplete outgoing session is remembered');
  restored();
  await settle();
  assert.equal(f.conversions.length, 1, 'restoration retains the immediate GPU settle');
  assert.equal(f.conversions[0].exposure, 40);
  await f.answer();
  f.commits[0].resolve(new Uint16Array(4));
  await switching;
  assert.equal(f.stored[0].entry.snapshot.refs.processedImageData.exposure, 40);
  assert.equal(f.stored[0].entry.undo.length, 1);
}

{
  const f = switchFixture();
  f.context.parkedPhoto = { file: 'a' };
  f.context.unparkOpenPhoto = async () => {};
  await f.context.switchToFile(1);
  assert.equal(f.switched, false, 'an unresolved parked restore keeps the current photo');
  assert.equal(f.stored.length, 0, 'cold brush history is never remembered as a live session');
}

{
  // A deferred reactivation of the current file must retain reopen through
  // both barriers. Losing it on either retry silently takes the same-file
  // early return and leaves the mismatched session live.
  const f = switchFixture();
  await f.context.switchToFile(0);
  assert.equal(f.switched, false, 'an ordinary click on the live file needs no activation');
  let restored;
  const restoring = new Promise(resolve => { restored = resolve; });
  f.context.parkedPhoto = { file: 'a' };
  f.context.unparkOpenPhoto = async () => {
    await restoring;
    f.context.parkedPhoto = null;
  };
  f.state.coreExposure = 50;
  f.context.scheduleCoreReprocess({ full: false });
  f.clock.runFrame();
  const reopening = f.switchTo(0, { reopen: true });
  await settle();
  assert.equal(f.conversions.length, 0, 'reactivation first restores the parked pixels');
  assert.equal(f.state.loadedFile, 'a', 'the identity stays live while restoration waits');
  restored();
  await settle();
  assert.equal(f.conversions.length, 1, 'reactivation also waits for the exact GPU frame');
  await f.answer();
  f.commits[0].resolve(new Uint16Array(4));
  await reopening;
  assert.equal(f.switched, true, 'the same-file reactivation survives both recursive retries');
  assert.equal(f.stored.length, 0, 'the invalid outgoing session is not cached during reopening');
}

console.log('settleOnSwitch: a switch right after a GPU-drawn change or commit settles it first and remembers the photo settled; without a GPU frame, or with a failed settle, it does not wait');

// Geometry chain (#244) stages 2, 3b, 3c and 3e: pending builds and their
// supersession, cold history entries, the exclusive history budget, photo
// sessions kept without their planes, and releasing the outgoing photo.
import assert from 'node:assert/strict';
import { createHarness, makeBase, samePixels, exportChain, settle, backingBuffers } from './geometryTestHarness.mjs';

const settingsFor = state => ({ rotationAngle: state.rotationAngle, mirrored: state.mirrored, cropRegion: state.cropRegion ? { ...state.cropRegion } : null });
const crop = (left, top) => ({ left, top, width: 40, height: 26 });

// ---- stage 2: a newer edit or an undo supersedes a pending build ----
{
  const base = makeBase(64, 44);
  const h = createHarness(base), c = h.context;
  c.restoreSettings({ rotationAngle: 1.3, mirrored: false, cropRegion: crop(5, 4) });
  await h.state.geometryReady;
  const installed = h.state.croppedImageData;
  const installedFrame = h.state.originalImageData;
  h.state.currentStep = 3;

  // Rotate, then undo before the pool is done: the undo restores the planes
  // at once (a reference swap) and the late result is dropped.
  c.applyRotation(90);
  assert.equal(h.state.geometryPending, true);
  assert.equal(h.target.document.body.dataset.studioBusy, 'true', 'editing is locked while the build runs');
  c.performUndo();
  assert.equal(h.state.geometryPending, false, 'undo supersedes the pending build');
  assert.equal(h.state.croppedImageData, installed, 'the hot entry is an instant reference swap');
  assert.equal(h.state.originalImageData, installedFrame);
  assert.equal(h.state.rotationAngle, 1.3);
  assert.equal(h.target.document.body.dataset.studioBusy, undefined, 'the lock is released with the build');
  assert.equal(h.target.canvasTransformWrapper.style.transform, 'matrix(1, 0, 0, 1, 0, 0)', 'the interim turn is dropped');
  await settle();
  assert.equal(h.state.croppedImageData, installed, 'the superseded result never lands');
  assert.equal(h.conversions.length, 0, 'the superseded edit does not convert');

  // The redo entry was captured while the build was pending: it is cold, and
  // redo rebuilds its planes from the base, then converts without new
  // automatic measurements.
  assert.equal(h.target.redoStack.at(-1).refs.cold, true);
  const redone = c.performRedo();
  assert.equal(h.state.rotationAngle, 91.3);
  await redone;
  samePixels(h.state.croppedImageData, exportChain(base, settingsFor(h.state)), 'cold redo rebuilds the exact planes');
  assert.deepEqual({ ...h.conversions.at(-1).options }, { quiet: true, automatic: false });
  assert.equal(h.conversions.at(-1).source, h.state.croppedImageData);
}

// Two edits before the first build lands: only the last is installed, and
// the interim display composes both turns.
{
  const base = makeBase(52, 36);
  const h = createHarness(base), c = h.context;
  c.restoreSettings({ rotationAngle: 0, mirrored: false, cropRegion: crop(4, 3) });
  await h.state.geometryReady;
  const first = c.applyRotation(90);
  const second = c.applyRotation(90);
  assert.match(h.target.canvasTransformWrapper.style.transform, /rotate\(180deg\)/);
  const jobsBefore = h.jobs();
  await Promise.all([first, second]);
  await settle();
  assert.equal(h.state.rotationAngle, 180);
  assert.ok(h.jobs() - jobsBefore <= 1, 'the superseded build does not complete');
  samePixels(h.state.croppedImageData, exportChain(base, settingsFor(h.state)), 'the latest edit wins');
  // The crop maps from the pending frame, exactly as two settled turns do.
  const k2 = createHarness(base);
  k2.context.restoreSettings({ rotationAngle: 0, mirrored: false, cropRegion: crop(4, 3) });
  await k2.state.geometryReady;
  await k2.context.applyRotation(90);
  await k2.context.applyRotation(90);
  assert.deepEqual({ ...h.state.cropRegion }, { ...k2.state.cropRegion }, 'quick turns map the crop like settled turns');
  assert.equal(h.target.canvasTransformWrapper.style.transform, 'matrix(1, 0, 0, 1, 0, 0)');
  // A mirror after a turn composes too: rotate(t) then mirror = mirror then rotate(-t).
  const k = createHarness(base);
  k.context.restoreSettings({ rotationAngle: 0, mirrored: false, cropRegion: crop(4, 3) });
  await k.state.geometryReady;
  const turned = k.context.applyRotation(90);
  const flipped = k.context.applyMirror();
  assert.match(k.target.canvasTransformWrapper.style.transform, /rotate\(-90deg\).*scaleX\(-1\)/);
  await Promise.all([turned, flipped]);
  samePixels(k.state.croppedImageData, exportChain(base, settingsFor(k.state)), 'rotate then mirror');
  const k3 = createHarness(base);
  k3.context.restoreSettings({ rotationAngle: 0, mirrored: false, cropRegion: crop(4, 3) });
  await k3.state.geometryReady;
  await k3.context.applyRotation(90);
  await k3.context.applyMirror();
  assert.deepEqual({ ...k.state.cropRegion }, { ...k3.state.cropRegion }, 'a mirror during a pending turn flips across the new frame');
}

// A snapshot taken while a build is pending keeps its scalars only.
{
  const h = createHarness(makeBase(40, 30)), c = h.context;
  c.restoreSettings({ rotationAngle: 2, mirrored: false, cropRegion: crop(2, 2) });
  const snapshot = c.captureSnapshot('exposure');
  assert.deepEqual({ ...snapshot.refs }, { cold: true });
  assert.equal(snapshot.settings.rotationAngle, 2);
  await h.state.geometryReady;
  assert.ok(c.captureSnapshot('exposure').refs.croppedImageData, 'a settled snapshot keeps its references');
}

// Pixel readers that ran during a pending build are counted (debug assertion).
{
  const h = createHarness(makeBase(40, 30)), c = h.context;
  c.restoreSettings({ rotationAngle: 2, mirrored: false, cropRegion: null });
  c.noteGeometryPixelRead('test');
  assert.equal(h.target.geometryDiagnostics.pendingReads, 1);
  await h.state.geometryReady;
  c.noteGeometryPixelRead('test');
  assert.equal(h.target.geometryDiagnostics.pendingReads, 1);
}

// ---- 3e: history budgets only what it holds exclusively ----
{
  const base = makeBase(90, 70);
  const cropBytes = 40 * 26 * 12;
  // Room for two entries' own planes beside live state.
  const h = createHarness(base, { historyBudget: cropBytes * 2 + 64 }), c = h.context;
  c.restoreSettings({ rotationAngle: 0.5, mirrored: false, cropRegion: crop(5, 5) });
  await h.state.geometryReady;
  const stack = h.target.undoStack;
  const recipes = [];
  // Three crop Applies and three rotations.
  for (let i = 0; i < 3; i++) {
    c.pushUndo('crop');
    c.restoreSettings({ ...settingsFor(h.state), cropRegion: crop(6 + i * 3, 6 + i) });
    await h.state.geometryReady;
  }
  for (let i = 0; i < 3; i++) {
    await c.applyRotation(90);
    recipes.push(settingsFor(h.state));
  }
  assert.equal(stack.length, 6, 'no history entry is lost');
  const hot = c.hotGeometrySnapshot();
  assert.equal(hot, stack.at(-1), 'the latest geometry entry stays hot');
  assert.ok(!hot.refs.cold);
  assert.ok(c.historyExclusiveBytes(hot) <= cropBytes * 2 + 64, 'bytes held only by history fit the budget beside the hot entry');
  assert.ok(stack.slice(0, 2).every(entry => entry.refs.cold), 'the oldest entries were stripped, not dropped');
  // Live buffers do not count against history.
  const live = backingBuffers(c.liveHistoryRoots());
  assert.ok(live.has(h.state.croppedImageData.data.buffer));

  // Undo of the most recent geometry edit is an instant swap.
  const beforeUndo = stack.at(-1).refs.croppedImageData;
  c.performUndo();
  assert.equal(h.state.geometryPending, false);
  assert.equal(h.state.croppedImageData, beforeUndo);
  // Undo down to a stripped entry restores its exact scalars and rebuilds.
  const target = stack[0];
  const expected = { ...target.settings.cropRegion };
  while (stack.length > 1) c.performUndo();
  await settle();
  const restoring = c.performUndo();
  assert.deepEqual({ ...h.state.cropRegion }, expected, 'exact cropRegion');
  assert.equal(h.state.rotationAngle, target.settings.rotationAngle);
  assert.equal(h.state.mirrored, target.settings.mirrored);
  await restoring;
  await settle();
  samePixels(h.state.croppedImageData, exportChain(base, settingsFor(h.state)), 'a stripped entry rebuilds the exact planes');
  // Redo all the way reproduces the last edit's pixels.
  while (h.target.redoStack.length) { c.performRedo(); await settle(); }
  await h.state.geometryReady;
  await settle();
  samePixels(h.state.croppedImageData, exportChain(base, recipes.at(-1)), 'redo reproduces the latest planes');
}

// 20 slider snapshots share live planes: none is stripped.
{
  const h = createHarness(makeBase(80, 60), { historyBudget: 1024 }), c = h.context;
  c.restoreSettings({ rotationAngle: 1, mirrored: false, cropRegion: crop(4, 4) });
  await h.state.geometryReady;
  h.state.exposure = 0;
  for (let i = 0; i < 20; i++) { c.pushUndo('exposure'); h.state.exposure = i + 1; }
  assert.equal(h.target.undoStack.length, 20);
  assert.ok(h.target.undoStack.every(entry => !entry.refs.cold), 'undo depth 20, all hot');
  for (let i = 19; i >= 0; i--) {
    c.performUndo();
    assert.equal(h.state.exposure, i, 'every undo restores the exact scalar');
  }
}

// ---- 3c: a session too large with its planes keeps its recipe and base ----
{
  const base = makeBase(70, 50);
  const baseBytes = base.data.byteLength + base.__image16.data.byteLength;
  const h = createHarness(base, { sessionBudget: baseBytes + 256 }), c = h.context;
  c.restoreSettings({ rotationAngle: 3, mirrored: true, cropRegion: crop(8, 6) });
  await h.state.geometryReady;
  h.state.currentStep = 3;
  h.state.processedImageData = h.state.croppedImageData;
  c.pushUndo('exposure');
  const item = { file: { name: 'a' }, settings: settingsFor(h.state) };
  h.state.loadedFile = item.file;
  assert.equal(c.rememberPhotoSession(item), true);
  const entry = h.target.photoSessions.take(item);
  assert.equal(entry.base, base);
  assert.deepEqual({ ...entry.snapshot.refs }, { cold: true }, 'the planes are not kept');
  assert.ok(entry.undo.every(snapshot => snapshot.refs.cold));
  assert.equal(entry.snapshot.settings.rotationAngle, 3);

  // Opening it again rebuilds the planes from the base.
  const k = createHarness(base);
  k.state.originalImageData = { width: 1, height: 1, released: true };
  const restoring = k.context.restoreSnapshot(entry.snapshot);
  assert.ok(restoring, 'a cold restore is asynchronous');
  assert.ok(k.state.originalImageData.__geometryFrame, 'another photo never stands in for the planes');
  await restoring;
  samePixels(k.state.croppedImageData, exportChain(base, settingsFor(k.state)), 'session planes rebuilt');
  assert.equal(k.conversions.at(-1).options.automatic, false);
}

// ---- 3b: the outgoing photo's planes and history are released ----
{
  const h = createHarness(makeBase(50, 40)), c = h.context;
  c.restoreSettings({ rotationAngle: 1.5, mirrored: false, cropRegion: crop(3, 3) });
  await h.state.geometryReady;
  h.state.processedImageData = h.state.croppedImageData;
  c.pushUndo('exposure');
  const frame = { width: h.state.originalImageData.width, height: h.state.originalImageData.height };
  c.releaseOutgoingPhotoPlanes();
  assert.deepEqual([h.state.originalImageData.width, h.state.originalImageData.height], [frame.width, frame.height]);
  assert.equal(h.state.originalImageData.data, undefined);
  for (const key of ['croppedImageData', 'processedImageData', 'conversionSourceImageData']) assert.equal(h.state[key], null);
  assert.equal(h.target.undoStack.length, 0);
  const planes = [...backingBuffers(h.state)].filter(buffer => buffer !== h.state.loadedBaseImageData.data.buffer && buffer !== h.state.loadedBaseImageData.__image16.data.buffer);
  assert.equal(planes.length, 0, 'only the base stays reachable from state');
}

// ---- 3b in a real switch: a failed decode reactivates the released photo ----
for (const coldSessions of [false, true]) {
  const baseA = makeBase(60, 44, 12);
  const h = createHarness(baseA), c = h.context;
  const itemA = { file: { name: 'a.png' }, settings: null, isDirty: true };
  const itemB = { file: { name: 'b.png' }, settings: null };
  Object.assign(h.state, { fileQueue: [itemA, itemB], currentFileIndex: 0, loadedFile: itemA.file });
  const recipe = { rotationAngle: 2.5, mirrored: false, cropRegion: crop(4, 4) };
  c.restoreSettings(recipe);
  await h.state.geometryReady;
  h.state.currentStep = 3;
  h.state.processedImageData = h.state.croppedImageData;
  const planesA = h.state.croppedImageData;
  h.target.geometryDiagnostics.coldSessions = coldSessions;
  h.target.getCurrentQueueItem = () => h.state.fileQueue[h.state.currentFileIndex];
  h.target.persistCurrentFileSettings = () => { const item = h.state.fileQueue[h.state.currentFileIndex]; item.settings = settingsFor(h.state); };
  let releasedDuringDecode = null;
  h.target.loadFile = async file => {
    // The outgoing planes and history are not reachable while B decodes.
    releasedDuringDecode = { cropped: h.state.croppedImageData, processed: h.state.processedImageData, frame: h.state.originalImageData };
    return file === itemB.file ? { status: 'error', message: 'decode failed' } : { status: 'loaded' };
  };
  await c.switchToFile(1);
  await settle();
  await h.state.geometryReady;
  await settle();
  assert.equal(releasedDuringDecode.cropped, null, `released before the decode (cold sessions ${coldSessions})`);
  assert.equal(releasedDuringDecode.processed, null);
  assert.equal(releasedDuringDecode.frame.released, true);
  assert.equal(itemB.status, 'error');
  assert.equal(h.state.loadedFile, itemA.file, 'the outgoing photo is active again');
  assert.equal(h.state.currentFileIndex, 0);
  if (coldSessions) {
    samePixels(h.state.croppedImageData, exportChain(baseA, recipe), 'reactivated from a cold session');
    assert.equal(h.target.geometryDiagnostics.coldRestores, 1);
  } else {
    assert.equal(h.state.croppedImageData, planesA, 'reactivated from the warm session');
  }
  assert.equal(h.target.document.body.dataset.photoSwitching, undefined);
  assert.equal(h.target.document.body.dataset.studioBusy, undefined);
}

// ---- A failed build is rolled back (R1-065, R2-005) ----
// The pool cannot allocate a plane (a RangeError at 60 MP under memory
// pressure). The rotation, the mirror, Apply Crop and a settings refresh then
// leave the settings on the geometry of the planes on screen: no interim turn
// stays, the failed edit leaves no undo entry, the user is told, and a
// conversion or an export reads planes and settings that agree.
const failingRender = h => {
  const render = h.pool.render;
  h.pool.render = async () => { throw new RangeError('Array buffer allocation failed'); };
  return () => { h.pool.render = render; };
};
const { functionSource } = await import('./geometryTestHarness.mjs');
const vm = await import('node:vm');
const withExportBarrier = h => {
  vm.runInContext(functionSource('ensureFullResolutionReadyForExport'), h.context);
  return h.context;
};
const NO_TURN = 'matrix(1, 0, 0, 1, 0, 0)';

// (Restore full frame installs the base itself here, which cannot fail; on
// a session without its base it waits for the original: displaySessions.)
for (const edit of ['rotation', 'mirror']) {
  const base = makeBase(64, 44, 31);
  const h = createHarness(base, { realProcessNegative: true }), c = withExportBarrier(h);
  c.restoreSettings({ rotationAngle: 1.3, mirrored: false, cropRegion: crop(5, 4) });
  await h.state.geometryReady;
  await c.processNegative({ quiet: true });
  const installed = h.state.croppedImageData;
  const converted = h.state.processedImageData;
  const recipe = settingsFor(h.state);
  c.pushUndo('exposure');
  const depth = h.target.undoStack.length;
  const conversions = h.conversions.length;
  const restore = failingRender(h);
  const editing = edit === 'rotation' ? c.applyRotation(90) : c.applyMirror();
  const pushed = h.target.undoStack.at(-1);
  assert.equal(h.target.undoStack.length, depth + 1, `${edit}: the edit pushed its entry`);
  assert.notEqual(h.target.canvasTransformWrapper.style.transform, NO_TURN, `${edit}: the interim turn shows while the build runs`);
  await editing;
  await settle();
  restore();
  assert.deepEqual(settingsFor(h.state), recipe, `${edit}: the settings are the installed geometry again`);
  assert.equal(c.geometryOutOfStep(), false);
  assert.equal(h.state.croppedImageData, installed, `${edit}: the planes on screen stay`);
  assert.equal(h.state.processedImageData, converted, `${edit}: the edit's entry gave their conversion back (as Undo does)`);
  assert.equal(h.target.canvasTransformWrapper.style.transform, NO_TURN, `${edit}: no interim turn is left`);
  assert.equal(h.target.undoStack.length, depth, `${edit}: the failed edit leaves no undo entry`);
  assert.ok(!h.target.undoStack.includes(pushed));
  assert.equal(h.target.redoStack.length, 0, `${edit}: and no redo entry`);
  assert.equal(h.target.toasts.length, 1, `${edit}: the user is told`);
  assert.equal(h.target.geometryDiagnostics.rollbacks, 1);
  assert.equal(h.target.document.body.dataset.studioBusy, undefined, `${edit}: editing is unlocked`);
  // A conversion reads the installed planes under their own settings; an
  // export of them is the chain of those settings (what batch export builds).
  await c.processNegative({ quiet: true });
  assert.equal(h.conversions.length, conversions + 1, `${edit}: converted once`);
  assert.equal(h.conversions.at(-1).source, installed);
  samePixels(installed, exportChain(base, settingsFor(h.state)), `${edit}: single export == batch export of the saved settings`);
  await c.ensureFullResolutionReadyForExport();
  // Undo still steps back over the exposure entry, not into the failed edit.
  c.performUndo();
  assert.deepEqual(settingsFor(h.state), recipe);
}

// Apply Crop (a straightened crop, with its crop-area detection pending).
{
  const { applyCropHandlerSource } = await import('./geometryTestHarness.mjs');
  const { imageAreaFromWorkingRect } = await import('./analysisRegion.js');
  const { isSameAnalysisFrame, workingPointsToBase, buildCropDetectionInput } = await import('./cropColorAnalysis.js');
  const geometryCore = await import('./imageGeometry.js');
  const base = makeBase(90, 64, 33);
  const h = createHarness(base, { realProcessNegative: true }), c = withExportBarrier(h);
  c.restoreSettings({ rotationAngle: 1.3, mirrored: false, cropRegion: { left: 6, top: 5, width: 70, height: 45 } });
  await h.state.geometryReady;
  await c.processNegative({ quiet: true });
  const meta = { appliedMode: 'crop', imageArea: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 }] };
  h.state.autoFrame.lastDiagnostics = structuredClone(meta);
  const installed = h.state.croppedImageData;
  const recipe = settingsFor(h.state);
  Object.assign(h.target, {
    applyCropBtn: { disabled: false }, cancelCropBtn: { disabled: false },
    getLoadingOverlay: () => ({ show: async () => {}, hide() {} }),
    requestAnimationFrame: callback => setTimeout(callback, 0),
    studioWorkspace: { sync() {}, text: key => key },
    imageAreaFromWorkingRect, isSameAnalysisFrame, workingPointsToBase, buildCropDetectionInput,
    runOpenCvTask: async (type, task) => { await task.build(); return null; },
    exitCropMode: () => { h.state.cropping = false; h.state.cropDraft = null; }
  });
  vm.runInContext(applyCropHandlerSource(), c);
  const preview = c.renderFrameSample(700_000);
  const rotatedPreview = geometryCore.applyRotationToImageData(preview, -0.5);
  h.state.cropping = true;
  h.state.cropDraft = {
    sourceImageData: h.state.originalImageData, rotatedSize: { width: rotatedPreview.width, height: rotatedPreview.height },
    rect: { left: 11.3, top: 7.8, width: 52.4, height: 37.1 }, rotationBase: 0, straightenAngle: -0.5
  };
  const depth = h.target.undoStack.length;
  const restore = failingRender(h);
  await c.applyCropHandler();
  await settle();
  restore();
  assert.deepEqual(settingsFor(h.state), recipe, 'Apply Crop: the settings are the installed geometry again');
  assert.equal(h.state.croppedImageData, installed);
  assert.deepEqual(h.state.autoFrame.lastDiagnostics, meta, 'Apply Crop: the frame record it replaced is back');
  assert.equal(h.target.cropDetection, null, 'Apply Crop: its crop-area detection ended');
  assert.equal(h.target.undoStack.length, depth, 'Apply Crop: no undo entry');
  assert.equal(h.target.toasts.length, 1);
  assert.equal(c.geometryOutOfStep(), false);
  assert.equal(h.target.document.body.dataset.studioBusy, undefined);
  assert.equal(h.target.studioAutoFrameRunning, false);
  await c.processNegative({ quiet: true });
  assert.equal(h.conversions.at(-1).source, installed);
  samePixels(installed, exportChain(base, settingsFor(h.state)), 'Apply Crop: single export == batch export of the saved settings');
  await c.ensureFullResolutionReadyForExport();
}

// Parity, old vs new: the old code kept the edit's settings over the old
// planes, so single export (the planes) and batch export or a reopen (the
// chain of the saved settings) differed; now they are the same pixels.
{
  const base = makeBase(64, 44, 32);
  const h = createHarness(base), c = h.context;
  c.restoreSettings({ rotationAngle: 1.3, mirrored: false, cropRegion: crop(5, 4) });
  await h.state.geometryReady;
  const installed = h.state.croppedImageData;
  const restore = failingRender(h);
  const rotating = c.applyRotation(90);
  const old = settingsFor(h.state);
  await rotating;
  await settle();
  restore();
  assert.notEqual(exportChain(base, old).width, installed.width, 'old: the saved settings name another frame than the exported planes');
  samePixels(exportChain(base, settingsFor(h.state)), installed, 'new: the saved settings name the exported planes');
}

// ---- A settings refresh (restoreSettings) whose build fails ----
{
  // On a load's planes (the base itself, nothing memoised): back to no geometry.
  const base = makeBase(64, 44, 35);
  const h = createHarness(base, { realProcessNegative: true }), c = withExportBarrier(h);
  const restore = failingRender(h);
  c.restoreSettings({ rotationAngle: 1.3, mirrored: true, cropRegion: crop(5, 4) });
  await h.state.geometryReady;
  await settle();
  restore();
  assert.deepEqual(settingsFor(h.state), { rotationAngle: 0, mirrored: false, cropRegion: null }, 'the base\'s own geometry again');
  assert.equal(h.state.originalImageData, base);
  assert.equal(c.geometryOutOfStep(), false);
  assert.equal(h.target.undoStack.length, 0, 'no undo entry');
  assert.equal(h.target.toasts.length, 1);
  assert.doesNotMatch(String(h.target.canvasTransformWrapper.style.transform), /rotate|scaleX\(-1\)/);
  await c.processNegative({ quiet: true });
  assert.equal(h.conversions.at(-1).source, base, 'the conversion reads the planes its settings name');
  await c.ensureFullResolutionReadyForExport();
}
{
  // On a converted photo (a roll commit's refresh): back to its installed
  // crop, which is converted again.
  const base = makeBase(64, 44, 36);
  const h = createHarness(base, { realProcessNegative: true }), c = withExportBarrier(h);
  c.restoreSettings({ rotationAngle: 1.3, mirrored: false, cropRegion: crop(5, 4) });
  await h.state.geometryReady;
  await c.processNegative({ quiet: true });
  const installed = h.state.croppedImageData;
  const recipe = settingsFor(h.state);
  const conversions = h.conversions.length;
  const restore = failingRender(h);
  c.restoreSettings({ rotationAngle: -2, mirrored: false, cropRegion: crop(8, 6) });
  await h.state.geometryReady;
  await settle();
  restore();
  assert.deepEqual(settingsFor(h.state), recipe);
  assert.equal(h.state.croppedImageData, installed);
  assert.equal(h.conversions.length, conversions + 1, 'converted again');
  assert.equal(h.conversions.at(-1).source, installed);
  await c.ensureFullResolutionReadyForExport();
}

// ---- Planes no rollback can reach (a two-stage import's stand-in after
// its swap, #255): the conversion builds the planes the settings name
// first, and converts nothing when that fails too; an export refuses ----
{
  const standIn = makeBase(64, 44, 37), full = makeBase(64, 44, 38);
  const h = createHarness(standIn, { realProcessNegative: true }), c = withExportBarrier(h);
  c.restoreSettings({ rotationAngle: 1.3, mirrored: false, cropRegion: crop(5, 4) });
  await h.state.geometryReady;
  h.state.loadedBaseImageData = full;
  assert.equal(c.geometryOutOfStep(), true);
  await assert.rejects(c.ensureFullResolutionReadyForExport(), /not exported/, 'an export refuses them');
  const restore = failingRender(h);
  const conversions = h.conversions.length;
  await c.processNegative({ quiet: true });
  await settle();
  assert.equal(h.conversions.length, conversions, 'a build that fails again converts nothing');
  assert.deepEqual(settingsFor(h.state), { rotationAngle: 1.3, mirrored: false, cropRegion: crop(5, 4) }, 'the settings stay');
  restore();
  await c.processNegative({ quiet: true });
  samePixels(h.state.croppedImageData, exportChain(full, settingsFor(h.state)), 'built from the base the settings belong to');
  assert.equal(h.conversions.at(-1).source, h.state.croppedImageData);
  await c.ensureFullResolutionReadyForExport();
}

// ---- 3e with Undo and Redo (R1-064, R1-066): the budget covers the redo
// stack, and the geometry the user left last stays hot ----
// Two slider steps on the base (which live state holds anyway), then three
// rotations of the whole frame.
const frameBytes = 90 * 70 * 12;
async function rotatedThrice(budget) {
  const base = makeBase(90, 70, 41);
  const h = createHarness(base, { historyBudget: budget }), c = h.context;
  for (let i = 0; i < 2; i++) { c.pushUndo('exposure'); h.state.exposure = i + 1; }
  const planes = [h.state.originalImageData];
  for (let i = 0; i < 3; i++) {
    await c.applyRotation(90);
    planes.push(h.state.originalImageData);
  }
  return { h, c, planes, undo: h.target.undoStack, redo: h.target.redoStack };
}
const fitsBudget = (c, budget, label) => {
  assert.ok(c.historyExclusiveBytes(c.hotGeometrySnapshot()) <= budget, `${label}: history holds at most its budget beside the hot entry`);
};
// Which rotation's planes each entry holds ('cold' when stripped).
const heldPlanes = (entries, planes) => entries.map(entry => (entry.refs.cold ? 'cold' : planes.indexOf(entry.refs.originalImageData)));

// Room for one frame beside the hot entry: three Undos keep the redo stack
// in the budget, from its far end, and the next redo hot.
{
  const budget = frameBytes + 64;
  const { h, c, planes, undo, redo } = await rotatedThrice(budget);
  assert.deepEqual(heldPlanes(undo, planes), [0, 0, 0, 1, 2], 'nothing is over the budget before the Undos');
  for (let i = 1; i <= 3; i++) {
    const jobs = h.jobs();
    c.performUndo();
    assert.equal(h.state.geometryPending, false, `undo ${i}: a reference swap`);
    assert.equal(h.state.originalImageData, planes[3 - i]);
    assert.equal(h.jobs(), jobs);
    fitsBudget(c, budget, `undo ${i}`);
    assert.equal(c.hotGeometrySnapshot(), redo.at(-1), `undo ${i}: the state just left is the hot entry`);
  }
  assert.deepEqual(heldPlanes(redo, planes), ['cold', 2, 1], 'the far end of redo goes cold first; the next redo stays hot');
  assert.deepEqual(heldPlanes(undo, planes), [0, 0], 'slider steps on the planes on screen stay hot');
  // Redo, Undo and Redo twice: reference swaps.
  const jobs = h.jobs();
  c.performRedo();
  assert.equal(h.state.originalImageData, planes[1]);
  fitsBudget(c, budget, 'redo');
  c.performUndo();
  assert.equal(h.state.originalImageData, planes[0]);
  c.performRedo();
  c.performRedo();
  assert.equal(h.state.originalImageData, planes[2]);
  assert.equal(h.jobs(), jobs, 'redo and undo of hot entries build nothing');
  fitsBudget(c, budget, 'redo twice');
  // A slider edit ends the redo branch: every step stays hot.
  c.performUndo();
  c.performUndo();
  c.pushUndo('exposure');
  assert.equal(redo.length, 0);
  assert.deepEqual(heldPlanes(undo, planes), [0, 0, 0], 'a slider edit after the Undos keeps every step hot');
  fitsBudget(c, budget, 'slider edit');
}

// A new geometry edit after an Undo: the redo branch it ends is not counted
// against the steps that stay (R1-066).
{
  const budget = frameBytes + 64;
  const { h, c, planes, undo } = await rotatedThrice(budget);
  c.performUndo();
  await c.applyRotation(90);
  assert.deepEqual(heldPlanes(undo, planes), [0, 0, 0, 1, 2], 'the second rotation keeps its planes');
  fitsBudget(c, budget, 'rotation after an Undo');
  const jobs = h.jobs();
  c.performUndo();
  c.performUndo();
  assert.equal(h.state.originalImageData, planes[1]);
  assert.equal(h.jobs(), jobs, 'both Undos are reference swaps');
}

// A budget below one geometry snapshot, as on a 60 MP frame: the step the
// user just left is the one kept hot, so Undo and Redo of it stay swaps.
{
  const budget = 64;
  const { h, c, planes, undo, redo } = await rotatedThrice(budget);
  assert.deepEqual(heldPlanes(undo, planes), [0, 0, 0, 'cold', 2], 'only the newest geometry step is kept beside the budget');
  const jobs = h.jobs();
  c.performUndo();
  assert.deepEqual(heldPlanes(redo, planes), [3], 'the redo of the step just undone stays hot');
  c.performRedo();
  assert.equal(h.state.originalImageData, planes[3]);
  c.performUndo();
  assert.equal(h.state.originalImageData, planes[2]);
  assert.equal(h.jobs(), jobs, 'Undo, Redo and Undo of the last step are reference swaps');
  fitsBudget(c, budget, 'toggling');
  // The stripped step rebuilds; the step left for it stays hot.
  const restoring = c.performUndo();
  await restoring;
  await settle();
  samePixels(h.state.originalImageData, exportChain(h.state.loadedBaseImageData, settingsFor(h.state)), 'the stripped step rebuilds its planes');
  fitsBudget(c, budget, 'cold undo');
  assert.deepEqual(heldPlanes(redo, planes), ['cold', 2]);
  const rebuilt = h.jobs();
  c.performRedo();
  assert.equal(h.state.originalImageData, planes[2]);
  assert.equal(h.jobs(), rebuilt, 'its redo is a reference swap');
}

// ---- The film border's paints end the interim turn too (R1-063) ----
// The real paint of the main canvas, with the border composed or drawn over
// its cached background (a drag frame); the border's pixels do not matter.
function withMainCanvasPaints(h) {
  const paints = { fast: 0, composed: 0, plain: 0 };
  delete h.target.displayNegative;
  Object.assign(h.target, {
    ctx: {
      putImageData: image => { if (!image.framed && !paints.drawn) paints.plain++; paints.drawn = false; },
      clearRect() {}, drawImage: () => { paints.fast++; paints.drawn = true; }
    },
    getSprocketFrameComposeOptions: () => ({ edgeMarkings: { fontLocale: 'en' } }),
    sprocketFrameReference: (image, reference) => reference,
    composeDisplaySprocketFrame: image => { paints.composed++; return { width: image.width + 8, height: image.height + 12, framed: true }; },
    getSprocketFrameLayout: (width, height) => ({ x: 4, y: 6, width, height, frameWidth: width + 8, frameHeight: height + 12 }),
    ensureSprocketPreviewFrameBackground: image => ({ metrics: { outputWidth: image.width + 8, outputHeight: image.height + 12, sideMargin: 4, bandHeight: 6 } })
  });
  vm.runInContext(['renderAdjustedImageDataToMainCanvas', 'renderFastSprocketPreview', 'displayNegative', 'presentCpuFrame']
    .map(functionSource).join('\n'), h.context);
  return paints;
}

for (const step of [1, 3]) {
  const base = makeBase(64, 44, 51);
  const h = createHarness(base), c = h.context;
  const paints = withMainCanvasPaints(h);
  c.restoreSettings({ rotationAngle: 0, mirrored: false, cropRegion: crop(5, 4) });
  await h.state.geometryReady;
  h.state.sprocketPreviewEnabled = true;
  h.state.currentStep = step;
  Object.assign(paints, { fast: 0, composed: 0, plain: 0 });
  const transform = () => h.target.canvasTransformWrapper.style.transform;
  // A landscape crop (a drag frame takes the cached border), then portrait
  // and landscape again; at Step 3 the slider path's frame, then a settled one.
  const edits = [['mirror', /scaleX\(-1\)/, { fastSprocketPreview: true }], ['rotation', /rotate\(90deg\)/, { fastSprocketPreview: true }], ['rotation', /rotate\(90deg\)/, {}]];
  for (const [edit, interim, options] of edits) {
    const label = `step ${step}, ${edit} to ${h.state.rotationAngle + (edit === 'rotation' ? 90 : 0)}`;
    const editing = edit === 'mirror' ? c.applyMirror() : c.applyRotation(90);
    assert.match(transform(), interim, `${label}: the stand-in shows while the build runs`);
    await editing;
    if (step >= 3) {
      // The conversion has not painted yet: the stand-in still turns the old frame.
      assert.match(transform(), interim, `${label}: no paint, no change`);
      c.presentCpuFrame(h.state.croppedImageData || h.state.originalImageData, options);
    }
    assert.doesNotMatch(transform(), /rotate|scaleX\(-1\)/, `${label}: the paint with the border ends the stand-in`);
  }
  assert.ok(paints.composed > 0, `step ${step}: the composed border path ran`);
  if (step >= 3) assert.ok(paints.fast > 0, 'the cached border path ran');
  assert.equal(paints.plain, 0, 'every paint went through the border');
}

// ---- A histogram redraw (a window resize) while the planes have no pixels
// (R1-068): the last histogram stays ----
{
  const { Histogram } = await import('../silvercore/ui/Histogram.js');
  const base = makeBase(64, 44, 53);
  const h = createHarness(base), c = h.context;
  // main.js's histogram, drawing into a canvas that ignores the strokes.
  const histogram = new Histogram({ width: 256, height: 64, getContext: () => new Proxy({}, { get: () => () => {} }) });
  const draw = histogram.draw.bind(histogram);
  let draws = 0;
  histogram.draw = image => { draws++; return draw(image); };
  h.target.histogram = histogram;
  vm.runInContext(['getCurrentHistogramSource', 'redrawHistogramIfPossible', 'renderHistogram'].map(functionSource).join('\n'), c);
  c.restoreSettings({ rotationAngle: 1.3, mirrored: false, cropRegion: crop(5, 4) });
  await h.state.geometryReady;
  c.redrawHistogramIfPossible();
  assert.equal(draws, 1, 'the negative is drawn');
  const cold = { ...c.captureSnapshot('photoSession'), refs: { cold: true } };
  // A photo switch's decode: the outgoing planes are a size-only stand-in.
  c.releaseOutgoingPhotoPlanes();
  c.redrawHistogramIfPossible();
  assert.equal(draws, 1, 'a released stand-in is not read');
  // A session kept without its planes reopens: a whole-frame descriptor
  // while the pool rebuilds the crop.
  const restoring = c.restoreSnapshot(cold);
  assert.ok(c.isGeometryFrame(h.state.originalImageData) && !h.state.croppedImageData);
  c.redrawHistogramIfPossible();
  assert.equal(draws, 1, 'a frame descriptor is not read');
  assert.equal(h.target.geometryDiagnostics.frameSyncReads, 0, 'its frame was not built on this thread');
  await restoring;
  c.redrawHistogramIfPossible();
  assert.equal(draws, 2, 'the rebuilt planes are drawn');
  assert.equal(h.target.geometryDiagnostics.frameSyncReads, 0);
}

// ---- A photo switch while a geometry build is pending (R1-069) ----
// The import detection tail's settings refresh (the film strip stays
// navigable while it runs; prepareStudioPhoto holds the lock) and a Rotate
// (its build holds the lock). The switch supersedes the build: its late
// planes never land on the photo switched to, the photo left keeps no
// snapshot of the half-built state (it reopens from its base and saved
// recipe), and editing is unlocked once the switch ends.
// Without room for the photo left in the session cache, only the switch's
// own cancellation stops the build (its planes are not released).
for (const [pending, sessionBudget] of [['refresh', undefined], ['rotation', undefined], ['rotation', 0]]) {
  const baseA = makeBase(60, 44, 61), baseB = makeBase(52, 36, 62);
  const h = createHarness(baseA, { realProcessNegative: true, sessionBudget }), c = h.context;
  const dataset = h.target.document.body.dataset;
  const itemA = { file: { name: 'a.png' }, settings: null, isDirty: true };
  const itemB = { file: { name: 'b.png' }, settings: null };
  Object.assign(h.state, { fileQueue: [itemA, itemB], currentFileIndex: 0, loadedFile: itemA.file });
  c.restoreSettings({ rotationAngle: 1.5, mirrored: false, cropRegion: crop(4, 4) });
  await h.state.geometryReady;
  await c.processNegative({ quiet: true });
  c.pushUndo('exposure');
  h.target.getCurrentQueueItem = () => h.state.fileQueue[h.state.currentFileIndex];
  h.target.persistCurrentFileSettings = () => { h.state.fileQueue[h.state.currentFileIndex].settings = settingsFor(h.state); };
  // A decode installs the photo's base as its working image (loadFile).
  const decodes = [];
  h.target.loadFile = async file => {
    decodes.push({ file, busy: dataset.studioBusy, switching: dataset.photoSwitching, pending: h.state.geometryPending });
    const base = file === itemA.file ? baseA : baseB;
    Object.assign(h.state, {
      loadedFile: file, loadedBaseImageData: base, originalImageData: base, croppedImageData: null,
      processedImageData: null, rotationAngle: 0, mirrored: false, cropRegion: null, currentStep: 1
    });
    return { status: 'loaded' };
  };
  // The pool holds the build until the switch is over.
  let release, entered;
  const held = new Promise(resolve => { release = resolve; });
  const inPool = new Promise(resolve => { entered = resolve; });
  const render = h.pool.render;
  h.pool.render = async (...args) => { entered(); await held; return render(...args); };
  if (pending === 'refresh') {
    dataset.studioBusy = 'true';
    c.restoreSettings({ rotationAngle: -2, mirrored: true, cropRegion: crop(6, 5) }, { refreshDisplay: false });
  } else {
    void c.applyRotation(90);
  }
  await inPool;
  assert.equal(h.state.geometryPending, true, `${pending}: the build is in the pool`);
  const recipe = settingsFor(h.state);
  const conversions = h.conversions.length;
  await c.switchToFile(1);
  release();
  await settle();
  await settle();
  assert.equal(h.state.loadedFile, itemB.file, `${pending}: the switch went through`);
  assert.equal(decodes.length, 1);
  assert.equal(decodes[0].pending, false, `${pending}: the switch superseded the build before the next photo decoded`);
  assert.equal(decodes[0].switching, 'true', `${pending}: the switch held its lock while the next photo decoded`);
  // A Rotate's build lets go of the lock it holds when the switch supersedes
  // it; photoSwitching keeps the workspace locked. (The film strip is inert
  // while such a build runs, so only a direct call starts this switch; see
  // audit-backlog.md.)
  if (pending === 'refresh') assert.equal(decodes[0].busy, 'true');
  assert.equal(h.state.originalImageData, baseB, `${pending}: the late planes never land on the photo switched to`);
  assert.equal(h.state.croppedImageData, null);
  assert.deepEqual(settingsFor(h.state), { rotationAngle: 0, mirrored: false, cropRegion: null }, `${pending}: its settings are its own`);
  assert.equal(h.state.geometryPending, false);
  assert.equal(h.conversions.length, conversions, `${pending}: nothing converted the late planes`);
  assert.equal(h.target.geometryDiagnostics.rollbacks, 0, `${pending}: the superseded build is not rolled back`);
  assert.equal(h.target.toasts.length, 0);
  assert.equal(dataset.studioBusy, undefined, `${pending}: editing is unlocked`);
  assert.equal(dataset.photoSwitching, undefined);
  const session = h.target.photoSessions.get(itemA);
  if (sessionBudget === 0) assert.equal(session, null, `${pending}: no room, nothing kept`);
  else {
    assert.equal(session?.base, baseA, `${pending}: the photo left keeps its base`);
    assert.equal(session.snapshot, null, `${pending}: and no snapshot of the half-built state`);
  }
  assert.deepEqual(itemA.settings, recipe, `${pending}: its recipe names the pending geometry`);
  // Back on it: the planes its recipe names, built from its base.
  await c.switchToFile(0);
  await h.state.geometryReady;
  await settle();
  assert.equal(h.state.loadedFile, itemA.file);
  assert.equal(decodes.at(-1).file, itemA.file);
  samePixels(h.state.croppedImageData, exportChain(baseA, recipe), `${pending}: reopened with the planes of its recipe`);
  assert.equal(dataset.studioBusy, undefined);
  assert.equal(dataset.photoSwitching, undefined);
}

console.log('geometry history tests passed');

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

console.log('geometry history tests passed');

// The export's plane-release probe (#250, liveEditorBuffers in main.js) over
// #244's geometry frame descriptors. Every export release and every
// transferPlane hand-off asks the probe which buffers the editor still holds.
// Beside a crop, state.originalImageData and the hot geometry snapshot are
// size-only descriptors whose `data` / `__image16` getters build the whole
// rotated frame on the main thread and keep it: the probe must never read
// them, and frame pixels a reader already built must still count as live.
// Runs the real main.js functions in a vm (geometryTestHarness.mjs).
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHarness, makeBase, functionSource } from './geometryTestHarness.mjs';

const {
  configurePlaneRelease, markOwnedPlanes, mayTransferBuffer, planeBuffersOf, releaseOwnedPlanes, setLiveReferenceProbe
} = await import('./planeRelease.js');

// A worker that records what each request transfers and answers with a Blob.
const posts = [];
class RecordingWorker {
  constructor() { this.onmessage = null; this.onerror = null; this.onmessageerror = null; }
  postMessage(message, transfers = []) {
    posts.push({ type: message.type, transfers });
    structuredClone(message, { transfer: transfers });
    queueMicrotask(() => this.onmessage({ data: { type: 'blobResult', id: message.id, blob: new Blob(['ok']) } }));
  }
  terminate() {}
}
const { createExportWorkerBridge } = await import('../workers/workerBridge.js');

configurePlaneRelease({ engine: 'webkit' });

const base = makeBase(61, 43);
const h = createHarness(base), c = h.context;
// What liveEditorBuffers reads besides the harness's state, history and
// sessions: no display buffers and no decode shared with a lane.
Object.assign(h.target, { planeBuffersOf, previewAdjustedBuffer: null, settledAdjustedBuffer: null });
h.target.sharedDecodes.bases = () => [];
vm.runInContext(functionSource('liveEditorBuffers'), c);
setLiveReferenceProbe(() => c.liveEditorBuffers());

try {
  // A tilted crop, a crop history entry, and a second crop: one descriptor
  // in state and one in the hot geometry snapshot.
  c.restoreSettings({ rotationAngle: 1.3, mirrored: false, cropRegion: { left: 4, top: 3, width: 40, height: 30 } });
  assert.equal(await h.state.geometryReady, true);
  const first = h.state.originalImageData;
  const firstCrop = h.state.croppedImageData;
  c.pushUndo('crop');
  c.restoreSettings({ rotationAngle: 1.3, mirrored: false, cropRegion: { left: 7, top: 5, width: 36, height: 27 } });
  assert.equal(await h.state.geometryReady, true);
  const second = h.state.originalImageData;
  assert.ok(first.__geometryFrame && second.__geometryFrame && first !== second, 'two frame descriptors');
  assert.equal(h.target.undoStack.at(-1).refs.originalImageData, first, 'the crop entry holds the first descriptor');
  const diagnostics = h.target.geometryDiagnostics;
  assert.deepEqual([diagnostics.frameSyncReads, diagnostics.mainRotations], [0, 0]);

  // The end of an export: its own planes are released, the editor's kept.
  const exported = markOwnedPlanes(makeBase(20, 10, 7));
  const summary = releaseOwnedPlanes(exported);
  assert.equal(summary.released, 2, 'the export-owned planes are released');
  assert.equal(exported.__image16.data.byteLength, 0);
  // A transferPlane hand-off of a plane the export made.
  const owned = markOwnedPlanes(makeBase(20, 10, 8));
  assert.equal(mayTransferBuffer(owned.__image16.data.buffer), true, 'an export-owned plane may move');
  assert.equal(mayTransferBuffer(owned.data.buffer), true);
  assert.equal(diagnostics.frameSyncReads, 0, 'the probe built no frame (5f23eb0: 2)');
  assert.equal(diagnostics.mainRotations, 0, 'no rotation ran on this thread (5f23eb0: 2)');
  assert.equal(first.__geometryFrame.pixels, null, 'the history descriptor keeps no pixels');
  assert.equal(second.__geometryFrame.pixels, null, 'the live descriptor keeps no pixels');

  // What the probe does name: the base behind both descriptors and the crop
  // windows of state and history.
  const live = c.liveEditorBuffers();
  for (const image of [base, h.state.croppedImageData, firstCrop]) {
    for (const buffer of planeBuffersOf(image)) assert.ok(live.has(buffer), 'base and crop planes are live');
  }

  // A descriptor whose pixels a synchronous reader already built: those
  // pixels are live, even stamped, so an export never moves or frees them.
  assert.equal(second.data.length, second.width * second.height * 4, 'the counted fallback still works');
  assert.equal(diagnostics.frameSyncReads, 1);
  const pixels = second.__geometryFrame.pixels;
  assert.ok(pixels && pixels.__image16);
  markOwnedPlanes(pixels);
  const withPixels = c.liveEditorBuffers();
  for (const buffer of planeBuffersOf(pixels)) assert.ok(withPixels.has(buffer), 'built frame pixels count as live');
  assert.equal(mayTransferBuffer(pixels.__image16.data.buffer), false);
  assert.equal(mayTransferBuffer(pixels.data.buffer), false);
  const refused = releaseOwnedPlanes({ width: pixels.width, height: pixels.height, data: pixels.data, __image16: pixels.__image16 });
  assert.deepEqual([refused.released, refused.refused], [0, 2], 'built frame pixels are never released');
  const bridge = createExportWorkerBridge({ workerFactory: () => new RecordingWorker() });
  try {
    const frame = { width: pixels.width, height: pixels.height, data: pixels.data, __image16: pixels.__image16 };
    posts.length = 0;
    assert.ok(await bridge.workerEncodeTiff(frame, 16, { transferPlane: true }));
    assert.equal(posts.length, 1);
    for (const moved of posts[0].transfers) assert.ok(!planeBuffersOf(pixels).includes(moved), 'transferPlane copies a live frame plane');
  } finally {
    bridge.terminateWorker();
  }
  assert.equal(pixels.__image16.data.length, pixels.width * pixels.height * 4, 'the frame pixels are intact');
  assert.equal(pixels.data.length, pixels.width * pixels.height * 4);
  assert.equal(diagnostics.frameSyncReads, 1, 'only the deliberate read built the frame');
  assert.equal(first.__geometryFrame.pixels, null);
} finally {
  setLiveReferenceProbe(null);
}

console.log('planeReleaseProbe.test.mjs passed');

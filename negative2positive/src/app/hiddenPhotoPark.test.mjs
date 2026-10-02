// #241 part 2e: parking the open photo while a hidden job is held back
// (opt-in). Runs the real main.js functions with the editor stubbed: parking
// keeps only the decoded base and the undo history (as cold entries, #229
// review R1-136), and showing the window rebuilds the planes through the cold
// photo-switch path without a decode.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source)?.index;
  assert.notEqual(start, undefined, `${name} exists in main.js`);
  const end = source.indexOf('\n    }', start);
  return source.slice(start, end + '\n    }'.length);
}
const refKeys = /const SNAPSHOT_REF_KEYS = (\[[^\]]+\]);/.exec(source)[1];
const plane = (tag) => ({ tag, data: new Uint8ClampedArray(16), width: 2, height: 2 });

function fixture({ enabled = true, hidden = true } = {}) {
  const base = plane('base');
  const file = { name: 'L1009967.dng' };
  const item = { file, settings: null, isDirty: true };
  const calls = [];
  const storage = new Map(enabled ? [['nc_hidden_park_v1', 'on']] : []);
  const state = {
    fileQueue: [{ file: { name: 'other' } }, item], currentFileIndex: 1, loadedFile: file,
    loadedBaseImageData: base, originalImageData: plane('rotated'), croppedImageData: plane('crop'),
    processedImageData: plane('processed'), conversionSourceImageData: plane('source'),
    conversionPreviewImageData: plane('preview'), previewSourceImageData: plane('previewSource'),
    histogramSourceImageData: plane('hist'), webglSourceImageData: plane('webgl'), displayImageData: plane('display'),
    rawMetadata: { camera: 'M11' }, rawDecodePending: false, currentStep: 3, cropping: false,
    dustRemoval: { processing: false, mask: new Uint8Array(4), inpaintedImageData: plane('dust'), cleanSource: plane('clean'), _state: {} },
    zoomLevel: 2, panX: 5, panY: 6
  };
  const stroke = { label: 'dustBrushStroke', dustDelta: { target: state.dustRemoval.inpaintedImageData } };
  const undoStack = [{ label: 'rotate', refs: { originalImageData: state.originalImageData } }, stroke];
  const redoStack = [{ label: 'exposure', refs: { processedImageData: state.processedImageData } }];
  const c = vm.createContext({
    state, undoStack, redoStack, SNAPSHOT_REF_KEYS: vm.runInNewContext(refKeys),
    document: { visibilityState: hidden ? 'hidden' : 'visible', body: { dataset: {} } },
    parkedPhoto: null, loadGeneration: 4, processNegativeInFlight: null, coreReprocessTimer: null,
    dustDetectionTimer: null, pendingBrushRepairs: 0, dustDrawing: false,
    safeStorageGet: key => storage.get(key) ?? null,
    getCurrentQueueItem: () => state.fileQueue[state.currentFileIndex],
    coreReprocessBusy: () => false,
    persistCurrentFileSettings: () => { calls.push('persist'); item.settings = { rotationAngle: 1.5, mirrored: true, cropRegion: { left: 1 } }; item.isDirty = false; },
    invalidatePhotoActivation: () => { calls.push('invalidate'); c.parkedPhoto = null; },
    supersedeActivation: () => {},
    isCurrentLoad: generation => generation === c.loadGeneration,
    loadFile: async (loaded, options) => {
      calls.push(['loadFile', loaded === file, options.decoded?.base === base, options.autoConvert, options.quiet]);
      c.loadGeneration++;
      state.loadedFile = loaded; state.loadedBaseImageData = options.decoded.base; state.originalImageData = options.decoded.base;
      undoStack.length = 0; redoStack.length = 0;
      return { status: 'loaded' };
    },
    resetZoomPan: () => calls.push('resetZoomPan'),
    restoreSettings: (settings, options) => calls.push(['restoreSettings', settings === item.settings, options.refreshDisplay]),
    prepareStudioPhoto: async (generation, prepared, options) => {
      calls.push(['prepare', generation === c.loadGeneration, prepared === item, options.quiet]);
      state.processedImageData = plane('rebuilt');
    },
    updateUndoRedoButtons: () => calls.push('buttons'), updateFileListUI: () => {}, updateRollAnalysisUI: () => {}, studioWorkspace: { sync: () => {} },
    // #239: the GPU preview's prepared copy of the photo.
    gpuPreview: { prepared: { tag: 'open photo' } },
    webglState: { renderer2: { dropPrepared: () => calls.push('dropPrepared') } }
  });
  vm.runInContext(['hiddenParkEnabled', 'parkOpenPhotoForHiddenJob', 'unparkOpenPhoto'].map(functionSource).join('\n'), c);
  return { c, state, item, base, file, calls, undoStack, redoStack, stroke };
}

// Off by default: nothing is parked until the measurement run turns it on.
{
  const f = fixture({ enabled: false });
  assert.equal(f.c.parkOpenPhotoForHiddenJob(), false);
  assert.ok(f.state.processedImageData);
}
// Only a hidden window with a settled editor is parked.
{
  const f = fixture({ hidden: false });
  assert.equal(f.c.parkOpenPhotoForHiddenJob(), false);
  const busy = fixture();
  busy.c.processNegativeInFlight = Promise.resolve();
  assert.equal(busy.c.parkOpenPhotoForHiddenJob(), false, 'never while a conversion runs');
  const decoding = fixture();
  decoding.state.rawDecodePending = true;
  assert.equal(decoding.c.parkOpenPhotoForHiddenJob(), false, 'never while the full-resolution decode is pending');
}

// Park: recipe persisted, only the base and the history kept; show: rebuilt
// from that base through the cold switch path, history restored as it was.
{
  const f = fixture();
  const undo = f.undoStack.slice(), redo = f.redoStack.slice();
  assert.equal(f.c.parkOpenPhotoForHiddenJob(), true);
  assert.deepEqual(f.calls.slice(0, 2), ['persist', 'invalidate'], 'the recipe is saved before the planes go');
  for (const key of ['originalImageData', 'croppedImageData', 'processedImageData', 'conversionSourceImageData',
    'conversionPreviewImageData', 'previewSourceImageData', 'histogramSourceImageData', 'webglSourceImageData', 'displayImageData']) {
    assert.equal(f.state[key], null, `${key} is dropped`);
  }
  assert.equal(f.state.dustRemoval.inpaintedImageData, null);
  assert.equal(f.c.gpuPreview.prepared, null, 'the GPU preview drops its copy');
  assert.ok(f.calls.includes('dropPrepared'), 'and its texture');
  assert.equal(f.state.loadedBaseImageData, f.base, 'the decoded base stays');
  assert.equal(f.undoStack.length, 2, 'the undo history is never dropped');
  // A hot entry would pin the planes just dropped: every step goes cold,
  // except a dust-brush stroke, which cannot and stays as it is.
  assert.equal(f.undoStack[0].refs.cold, true);
  assert.equal(f.redoStack[0].refs.cold, true);
  assert.equal(f.undoStack[1], f.stroke);
  assert.equal(f.stroke.dustDelta.target.tag, 'dust');
  assert.equal(f.c.parkOpenPhotoForHiddenJob(), false, 'parked once');
  f.calls.length = 0;
  f.c.document.visibilityState = 'visible';
  await f.c.unparkOpenPhoto();
  assert.equal(f.c.parkedPhoto, null);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls)), [
    ['loadFile', true, true, false, true],
    'resetZoomPan',
    ['restoreSettings', true, false],
    ['prepare', true, true, true],
    'buttons'
  ], 'rebuilt from the kept base (no decode), with the persisted recipe');
  assert.equal(f.state.processedImageData.tag, 'rebuilt');
  assert.deepEqual(f.undoStack, undo, 'undo history restored');
  assert.deepEqual(f.redoStack, redo, 'redo history restored');
  assert.equal(f.item.isDirty, false);
}

// A queue that moved on while hidden is not re-activated by a stale park.
{
  const f = fixture();
  assert.equal(f.c.parkOpenPhotoForHiddenJob(), true);
  f.state.currentFileIndex = 0;
  f.calls.length = 0;
  await f.c.unparkOpenPhoto();
  assert.deepEqual(f.calls, []);
}

console.log('hiddenPhotoPark tests passed');

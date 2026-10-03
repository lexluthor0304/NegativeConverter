// #241 part 2e: parking the open photo while a hidden job is held back
// (opt-in). Runs the real main.js functions with the editor stubbed: parking
// keeps only the decoded base and cold/persisted undo history (#229 review
// R1-136). Showing restores exact archived brush planes or rebuilds ordinary
// cold planes through the photo-switch path, without decoding.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDustHistoryArchive } from './dustHistoryArchive.js';
import { archiveDatabaseFixture } from './dustHistoryArchiveHarness.mjs';
import { applyStrokePatch, applyDustDelta } from './dustStrokeHistory.js';
import { createMemoryBudget, createRetainedLedger } from './memoryBudget.js';
import { createDustWorkerClient } from './dustWorkerClient.js';
import { createHiddenJobGate } from './hiddenJobGate.js';
import { ROLL_OPENCV_REALM_BYTES } from './batchExportScheduler.js';
import { isSharedPlane } from './crossOriginIsolation.js';
import { createConversionWorkerClient } from './conversionWorkerClient.js';
import { createHarness, makeBase, samePixels } from './geometryTestHarness.mjs';
import { encodeTiffBlob } from './exportImageEncoders.js';

const source = readFileSync(process.env.NC229_PARK_MAIN || new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source)?.index;
  assert.notEqual(start, undefined, `${name} exists in main.js`);
  const end = source.indexOf('\n    }', start);
  return source.slice(start, end + '\n    }'.length);
}
const refKeys = /const SNAPSHOT_REF_KEYS = (\[[^\]]+\]);/.exec(source)[1];
const plane = (tag) => ({ tag, data: new Uint8ClampedArray(16), width: 2, height: 2 });

function fixture({ enabled = true, hidden = true, brush = true, geometry = null } = {}) {
  const base = geometry?.state.loadedBaseImageData || plane('base');
  const file = { name: 'L1009967.dng' };
  const item = { file, settings: null, isDirty: true };
  const calls = [];
  const storage = new Map(enabled ? [['nc_hidden_park_v1', 'on']] : []);
  const state = {
    fileQueue: [{ file: { name: 'other' } }, item], currentFileIndex: 1, loadedFile: file,
    loadedBaseImageData: base, originalImageData: geometry?.state.originalImageData || plane('rotated'),
    croppedImageData: geometry?.state.croppedImageData || plane('crop'),
    processedImageData: plane('processed'), conversionSourceImageData: plane('source'),
    conversionPreviewImageData: plane('preview'), previewSourceImageData: plane('previewSource'),
    histogramSourceImageData: plane('hist'), webglSourceImageData: plane('webgl'), displayImageData: plane('display'),
    rawMetadata: { camera: 'M11' }, rawDecodePending: false, currentStep: 3, cropping: false,
    dustRemoval: { processing: false, mask: new Uint8Array(geometry ? 12 : 4),
      inpaintedImageData: geometry ? makeBase(4, 3, 43) : plane('dust'),
      cleanSource: geometry ? makeBase(4, 3, 41) : plane('clean'), _state: {} },
    zoomLevel: 2, panX: 5, panY: 6
  };
  const db = archiveDatabaseFixture();
  const archive = createDustHistoryArchive({ indexedDB: db.indexedDB,
    createGeometryFrame: geometry ? (...args) => geometry.context.createGeometryFrame(...args) : null,
    geometryKeyOf: image => geometry?.target.geometryMemo.get(image),
    restoreGeometryKey: (image, key) => geometry?.target.geometryMemo.set(image, key) });
  const target = state.dustRemoval.inpaintedImageData;
  state.processedImageData = target;
  const rect = { x: 0, y: 0, width: 1, height: 1 };
  const stroke = { label: 'dustBrushStroke', dustDelta: applyStrokePatch(target, state.dustRemoval.mask, {
    rect, maskRect: rect, rgba8: Uint8ClampedArray.of(41, 42, 43, 255),
    ...(geometry ? { rgba16: Uint16Array.of(10511, 10783, 11039, 65535) } : {}),
    maskBytes: Uint8Array.of(255), particleCount: 1
  }, { cleanSource: state.dustRemoval.cleanSource, countBefore: 0, tagBefore: 0, tagAfter: 1 }) };
  if (!brush) { state.dustRemoval.mask = state.dustRemoval.inpaintedImageData = state.dustRemoval.cleanSource = null; }

  const undoStack = [{ label: 'rotate', refs: { originalImageData: state.originalImageData } }, ...(brush ? [stroke] : [])];
  const redoStack = [{ label: 'exposure', refs: { processedImageData: state.processedImageData, dustInpaintedImageData: state.dustRemoval.inpaintedImageData } }];
  const c = vm.createContext({
    state, undoStack, redoStack, SNAPSHOT_REF_KEYS: vm.runInNewContext(refKeys),
    document: { visibilityState: hidden ? 'hidden' : 'visible', body: { dataset: {} } },
    parkedPhoto: null, parkingPhoto: false, manualEditRevision: 0, dustHistoryArchive: archive,
    memoryBudget: createMemoryBudget({ budgetBytes: 10000 }), loadGeneration: 4, processNegativeInFlight: null, coreReprocessTimer: null,
    dustDetectionTimer: null, pendingBrushRepairs: 0, dustDrawing: false,
    safeStorageGet: key => storage.get(key) ?? null,
    getCurrentQueueItem: () => state.fileQueue[state.currentFileIndex],
    coreReprocessBusy: () => false,
    persistCurrentFileSettings: () => { calls.push('persist'); item.settings = { rotationAngle: 1.5, mirrored: true, cropRegion: { left: 1 } }; item.isDirty = false; },
    invalidatePhotoActivation: () => { calls.push('invalidate'); c.parkedPhoto = null; },
    supersedeActivation: () => {}, beginActivation: () => {},
    unpinDustWorker: () => {}, disposeDustWorker: () => {}, noteDustReplaced: () => {}, carryRestoredRepairStamp: () => {},
    convertPreviewFrameInWorker: { dispose() {} },
    updatePreview: () => calls.push('preview'), syncDustWorkerPin: () => {}, rememberRepairMasks: () => {},
    repairStamps: { recipeOf: () => null }, coreReprocessToken: 0,
    clearRepairedPreview() {}, previewRepairWorker: { dispose() {} }, dustRefreshRepairMask: null,
    dustTint: { mask: state.dustRemoval.mask, image: null, building: null }, displayOverlayState: { tint: null },
    settledAdjustedBuffer: null, previewAdjustedBuffer: null,
    glBorder: { photo: plane('border'), smear: plane('smear'), source: state.webglSourceImageData, smearSource: state.webglSourceImageData, smearFlight: 2, smearToken: 3 },
    liveHistoryRoots: () => [state.loadedBaseImageData, ...c.SNAPSHOT_REF_KEYS.map(key => state[key]), state.dustRemoval],
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
    webglState: { renderer2: { dropPrepared: () => calls.push('dropPrepared') }, borderUnderlay: { release: () => calls.push('releaseBorder') } }
  });
  vm.runInContext(['hiddenParkEnabled', 'parkOpenPhotoForHiddenJob', 'unparkOpenPhoto', 'performUndo', 'performRedo', 'releaseGlBorder', 'openPhotoMemoryRoots'].map(functionSource).join('\n'), c);
  const ledger = createRetainedLedger([
    { name: 'editor', roots: () => c.openPhotoMemoryRoots() },
    { name: 'history', roots: () => [undoStack, redoStack] },
    { name: 'workers', bytes: () => c.workerResidentBytes?.() || 0 }
  ]);
  return { c, state, item, base, file, calls, undoStack, redoStack, stroke, db, target, ledger };
}

// A real rotated/mirrored/cropped RAW descriptor must stay lazy through the
// actual park/unpark functions, and its brush still patches exact 16-bit data.
{
  const h = createHarness(makeBase(8, 6, 37)), c = h.context;
  c.restoreSettings({ rotationAngle: 17.3, mirrored: true, cropRegion: { left: 1, top: 1, width: 4, height: 3 } });
  await h.state.geometryReady;
  const sample = c.renderFrameSample(12, { with16: true });
  const f = fixture({ geometry: h });
  f.undoStack[0].refs.originalImageData = f.state.originalImageData;
  f.undoStack[0].refs.croppedImageData = f.state.croppedImageData;
  const liveFrame = f.state.originalImageData, liveDelta = f.stroke.dustDelta;
  f.db.failures.writeAt = 3;
  assert.equal(await f.c.parkOpenPhotoForHiddenJob(), false, 'partial geometry storage failure rolls back');
  assert.equal(f.state.originalImageData, liveFrame);
  assert.equal(f.stroke.dustDelta, liveDelta);
  assert.equal(liveFrame.__geometryFrame.pixels, null);
  assert.equal(f.db.records.size, 0);
  f.db.failures.writeAt = null;
  const tiff = await encodeTiffBlob(f.target, 16).arrayBuffer();
  const cropTiff = await encodeTiffBlob(f.state.croppedImageData, 16).arrayBuffer();
  assert.equal(await f.c.parkOpenPhotoForHiddenJob(), true);
  assert.equal(h.target.geometryDiagnostics.frameSyncReads, 0, 'parking never expands a lazy geometry frame');
  f.c.document.visibilityState = 'visible';
  await f.c.unparkOpenPhoto();
  assert.equal(f.state.originalImageData.__geometryFrame.pixels, null);
  assert.equal(f.state.originalImageData.__geometryFrame.base, f.base);
  assert.equal(f.undoStack[0].refs.originalImageData, f.state.originalImageData);
  assert.equal(f.undoStack[0].refs.croppedImageData, f.state.croppedImageData);
  h.state.originalImageData = f.state.originalImageData;
  samePixels(c.renderFrameSample(12, { with16: true }), sample, 'unparked frame sample');
  assert.deepEqual(await encodeTiffBlob(f.state.croppedImageData, 16).arrayBuffer(), cropTiff, 'transformed TIFF16 stays exact');
  applyDustDelta(f.stroke.dustDelta, 'undo');
  samePixels(f.state.processedImageData, makeBase(4, 3, 43), 'archived brush undo retains low sample bits');
  applyDustDelta(f.stroke.dustDelta, 'redo');
  assert.deepEqual(await encodeTiffBlob(f.state.processedImageData, 16).arrayBuffer(), tiff, 'brush redo TIFF16 stays exact');
  assert.equal(h.target.geometryDiagnostics.frameSyncReads, 0);
  assert.equal(f.db.records.size, 0);
}

// Off by default: nothing is parked until the measurement run turns it on.
{
  const f = fixture({ enabled: false });
  assert.equal(await f.c.parkOpenPhotoForHiddenJob(), false);
  assert.ok(f.state.processedImageData);
}
// Only a hidden window with a settled editor is parked.
{
  const f = fixture({ hidden: false });
  assert.equal(await f.c.parkOpenPhotoForHiddenJob(), false);
  const busy = fixture();
  busy.c.processNegativeInFlight = Promise.resolve();
  assert.equal(await busy.c.parkOpenPhotoForHiddenJob(), false, 'never while a conversion runs');
  const decoding = fixture();
  decoding.state.rawDecodePending = true;
  assert.equal(await decoding.c.parkOpenPhotoForHiddenJob(), false, 'never while the full-resolution decode is pending');
}

// Park: persist exact brush history and current pixels, keeping only the base
// live. Show: restore their shared references and bytes without a decode.
{
  const f = fixture();
  const undo = f.undoStack.slice(), redo = f.redoStack.slice();
  assert.equal(await f.c.parkOpenPhotoForHiddenJob(), true);
  assert.deepEqual(f.calls.slice(0, 2), ['persist', 'invalidate'], 'the recipe is saved before the planes go');
  for (const key of ['originalImageData', 'croppedImageData', 'processedImageData', 'conversionSourceImageData',
    'conversionPreviewImageData', 'previewSourceImageData', 'histogramSourceImageData', 'webglSourceImageData', 'displayImageData']) {
    assert.equal(f.state[key], null, `${key} is dropped`);
  }
  assert.equal(f.state.dustRemoval.inpaintedImageData, null);
  assert.equal(f.c.gpuPreview.prepared, null, 'the GPU preview drops its copy');
  assert.ok(f.calls.includes('dropPrepared'), 'and its texture');
  assert.equal(f.state.loadedBaseImageData, f.base, 'the decoded base stays');
  assert.ok(f.calls.includes('releaseBorder'), 'parking releases the derived border texture');
  assert.equal(f.c.glBorder.smear, null, 'the stored border smear does not keep hidden planes live');
  assert.equal(f.c.glBorder.source, null, 'the border source relinquishes its plane ownership');
  assert.equal(f.ledger.retained(), f.base.data.byteLength, 'only the retained decoded base remains in the editor/history ledger');
  assert.equal(f.undoStack.length, 2, 'the undo history is never dropped');
  // Ordinary steps go cold; the stroke releases its actual full planes
  // only after their exact, aliased graph is committed to storage.
  assert.equal(f.undoStack[0].refs.cold, true);
  assert.equal(f.redoStack[0].refs.cold, true);
  assert.equal(f.undoStack[1], f.stroke);
  assert.equal(f.stroke.dustDelta.cold, true);
  assert.equal(f.stroke.dustDelta.target, undefined, 'the target is no longer retained');
  assert.ok(f.c.parkedPhoto.dustHistoryKey);
  f.c.performUndo(); f.c.performRedo();
  assert.deepEqual(f.undoStack, undo, 'cold brush entries cannot be consumed before restoration');
  assert.deepEqual(f.redoStack, redo);
  assert.equal(await f.c.parkOpenPhotoForHiddenJob(), false, 'parked once');
  f.calls.length = 0;
  f.c.document.visibilityState = 'visible';
  await f.c.unparkOpenPhoto();
  assert.equal(f.c.parkedPhoto, null);
  assert.deepEqual(f.calls, ['resetZoomPan', 'preview', 'buttons'], 'the exact saved repair is restored without decode or re-detection');
  assert.deepEqual([...f.state.processedImageData.data], [...f.target.data]);
  assert.equal(f.state.processedImageData, f.stroke.dustDelta.target);
  assert.equal(f.state.dustRemoval.mask, f.stroke.dustDelta.mask);
  assert.equal(f.redoStack[0].refs.processedImageData, f.stroke.dustDelta.target, 'snapshot/stroke aliases survive');
  applyDustDelta(f.stroke.dustDelta, 'undo');
  assert.deepEqual([...f.state.processedImageData.data], new Array(16).fill(0));
  assert.deepEqual([...f.state.dustRemoval.mask], [0, 0, 0, 0]);
  applyDustDelta(f.stroke.dustDelta, 'redo');
  assert.deepEqual([...f.state.processedImageData.data], [...f.target.data]);
  assert.equal(f.db.records.size, 0, 'the archive is removed after restoration');
  assert.deepEqual(f.undoStack, undo, 'undo history restored');
  assert.deepEqual(f.redoStack, redo, 'redo history restored');
  assert.equal(f.item.isDirty, false);
}

// A queue that moved on while hidden is not re-activated by a stale park.
{
  const f = fixture();
  assert.equal(await f.c.parkOpenPhotoForHiddenJob(), true);
  f.state.currentFileIndex = 0;
  f.calls.length = 0;
  await f.c.unparkOpenPhoto();
  assert.deepEqual(f.calls, []);
}

// Without a brush, ordinary cold history still rebuilds from the retained base.
{
  const f = fixture({ brush: false });
  assert.equal(await f.c.parkOpenPhotoForHiddenJob(), true);
  f.calls.length = 0;
  f.c.document.visibilityState = 'visible';
  await f.c.unparkOpenPhoto();
  assert.equal(f.state.processedImageData.tag, 'rebuilt');
  assert.equal(f.calls[0][0], 'loadFile');
}
for (const failure of ['open', 'write']) {
  const f = fixture(); f.db.failures[failure] = true;
  const delta = f.stroke.dustDelta, refs = f.undoStack[0].refs;
  assert.equal(await f.c.parkOpenPhotoForHiddenJob(), false);
  assert.equal(f.stroke.dustDelta, delta);
  assert.equal(f.undoStack[0].refs, refs);
  assert.equal(f.state.processedImageData, f.target, 'storage failure preserves actual live planes and history');
  assert.equal(f.c.parkedPhoto, null);
  assert.ok(f.c.glBorder.smear, 'a failed archive keeps the live border planes');
  assert.equal(f.calls.includes('releaseBorder'), false, 'archive failure cannot release the active presentation');
}
{
  const f = fixture();
  assert.equal(await f.c.parkOpenPhotoForHiddenJob(), true);
  const parked = f.c.parkedPhoto;
  f.c.document.visibilityState = 'visible'; f.db.failures.read = true;
  await assert.rejects(f.c.unparkOpenPhoto(), /Storage read failed/);
  assert.equal(f.c.parkedPhoto, parked);
  assert.equal(f.stroke.dustDelta.cold, true, 'the stored history remains available for retry');
  f.db.failures.read = false;
  await f.c.unparkOpenPhoto();
  assert.deepEqual([...f.state.processedImageData.data], [...f.target.data]);
}
for (const change of ['visible', 'edit', 'plane', 'core', 'timer', 'dust', 'negative']) {
  const f = fixture();
  const save = f.c.dustHistoryArchive.save;
  let finish;
  const wait = new Promise(resolve => { finish = resolve; });
  f.c.dustHistoryArchive.save = async (...args) => { await wait; return save(...args); };
  const delta = f.stroke.dustDelta;
  const parking = f.c.parkOpenPhotoForHiddenJob();
  if (change === 'visible') f.c.document.visibilityState = 'visible';
  if (change === 'edit') f.c.manualEditRevision++;
  if (change === 'plane') f.state.processedImageData = plane('newer');
  if (change === 'core') f.c.coreReprocessBusy = () => true;
  if (change === 'timer') f.c.coreReprocessTimer = 1;
  if (change === 'dust') f.state.dustRemoval.processing = true;
  if (change === 'negative') f.c.processNegativeInFlight = Promise.resolve();
  finish();
  assert.equal(await parking, false, `a ${change} change during storage invalidates the park`);
  assert.equal(f.stroke.dustDelta, delta, 'history was never made cold');
  assert.equal(f.db.records.size, 0, 'an unused committed record is removed');
}
{
  const f = fixture();
  assert.equal(await f.c.parkOpenPhotoForHiddenJob(), true);
  f.c.document.visibilityState = 'visible';
  const load = f.c.dustHistoryArchive.load;
  let finish, reads = 0;
  const wait = new Promise(resolve => { finish = resolve; });
  f.c.dustHistoryArchive.load = async (...args) => { reads++; await wait; return load(...args); };
  const one = f.c.unparkOpenPhoto(), two = f.c.unparkOpenPhoto();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1, 'a switch and visibility restore share one read');
  assert.equal(f.c.memoryBudget.foregroundOutstanding, 1, 'archive allocation owns foreground memory too');
  assert.equal(f.c.memoryBudget.tryReserve(1), null, 'new jobs wait while stored planes are restored');
  finish(); await Promise.all([one, two]);
  assert.equal(f.c.memoryBudget.idle, true);
  assert.equal(f.db.records.size, 0);
}
// The cached conversion client is another owner outside the parked graph.
// Release it only after successful archival and exact-plane settlement; a
// restored source starts a new worker and keeps its genuine low sample bits.
{
  const f = fixture(), workers = [];
  const client = createConversionWorkerClient({ cacheInput: true, workerFactory: () => {
    const worker = {
      source: null, terminated: false,
      postMessage(message, transfers) {
        this.source = structuredClone(message, { transfer: transfers });
        queueMicrotask(() => this.onmessage?.({ data: { id: message.id, type: 'analyzed', key: message.key } }));
      },
      terminate() { this.terminated = true; this.source = null; }
    };
    workers.push(worker);
    return worker;
  } });
  const outgoing = f.state.conversionSourceImageData;
  outgoing.__image16 = { width: 2, height: 2, data: new Uint16Array(16).fill(7723) };
  f.c.convertPreviewFrameInWorker = client;
  await client.analyze({ imageData: outgoing, settings: {} });
  assert.equal(client.holds(outgoing), true);
  assert.ok(workers[0].source, 'the real client has dispatched and cached the photo');
  f.c.coreReprocessBusy = () => true;
  assert.equal(await f.c.parkOpenPhotoForHiddenJob(), false, 'an unsettled exact plane cannot be parked');
  assert.equal(client.holds(outgoing), true);
  f.c.coreReprocessBusy = () => false;
  f.db.failures.write = true;
  assert.equal(await f.c.parkOpenPhotoForHiddenJob(), false);
  assert.equal(client.holds(outgoing), true, 'failed archival retains the live conversion source');
  assert.equal(workers[0].terminated, false);
  f.db.failures.write = false;
  const save = f.c.dustHistoryArchive.save;
  let finish;
  const wait = new Promise(resolve => { finish = resolve; });
  f.c.dustHistoryArchive.save = async (...args) => { await wait; return save(...args); };
  const parking = f.c.parkOpenPhotoForHiddenJob();
  f.c.coreReprocessBusy = () => true;
  finish();
  assert.equal(await parking, false, 'an exact flight starting during storage prevents ownership release');
  assert.equal(client.holds(outgoing), true, 'the newly busy conversion keeps its cached source');
  assert.equal(workers[0].terminated, false);
  assert.equal(f.db.records.size, 0, 'the unused archive is removed without dropping live ownership');
  f.c.coreReprocessBusy = () => false;
  f.c.dustHistoryArchive.save = save;
  assert.equal(await f.c.parkOpenPhotoForHiddenJob(), true);
  assert.equal(client.holds(outgoing), false, 'committed parking releases the cached conversion source');
  assert.equal(workers[0].terminated, true, 'the unused preview worker is actually terminated');
  assert.equal(workers[0].source, null);
  f.c.document.visibilityState = 'visible';
  await f.c.unparkOpenPhoto();
  const restored = f.state.conversionSourceImageData;
  assert.deepEqual([...restored.__image16.data], [...outgoing.__image16.data]);
  await client.analyze({ imageData: restored, settings: {} });
  assert.equal(workers.length, 2, 'restoration lazily starts a fresh preview worker');
  assert.equal(client.holds(restored), true);
  client.dispose();
}

// The combined background/display/roll contract: no tag or pending request
// is needed for a live worker's bytes to remain counted. A failed archive
// keeps that ownership. Only actual worker and plane release lets the held
// hidden item start. Both private and shared 16-bit inputs use tiny planes.
for (const shared of [false, true]) {
  const f = fixture();
  let terminated = 0;
  const dust = createDustWorkerClient({ workerFactory: () => ({
    postMessage(message) { queueMicrotask(() => this.onmessage?.({ data: { id: message.id } })); },
    terminate() { terminated++; }
  }) });
  const clean = f.state.dustRemoval.cleanSource, mask = f.state.dustRemoval.mask;
  clean.__image16 = { width: 2, height: 2,
    data: new Uint16Array(shared ? new SharedArrayBuffer(32) : new ArrayBuffer(32)) };
  clean.__image16.data.fill(7723);
  Object.assign(f.c, { workerResidents: new Map(), dustWorkerPlaneBytes: 0, dustWorker: dust,
    ROLL_OPENCV_REALM_BYTES, isSharedPlane, disposeDustWorker: dust.dispose, unpinDustWorker: dust.unpin });
  const start = source.indexOf("    workerResidents.set('dust', {");
  assert.ok(start >= 0, 'the real dust resident registration exists');
  const registration = source.slice(start, source.indexOf('\n    });', start) + 8);
  vm.runInContext(['noteDustWorkerMemory', 'workerResidentBytes'].map(functionSource).join('\n') + '\n' + registration, f.c);
  f.c.noteDustWorkerMemory(clean, mask);
  await dust.pin(clean, { mask, tag: null });
  assert.equal(dust.pendingCount, 0);
  assert.equal(dust.maskTag, null, 'the seeded worker deliberately has no reuse tag');
  const opaque = clean.data.byteLength + (shared ? 0 : clean.__image16.data.byteLength) + mask.byteLength + ROLL_OPENCV_REALM_BYTES;
  assert.equal(f.c.workerResidentBytes(), opaque, 'every live tagless worker byte remains counted');
  const before = f.ledger.retained();
  const gate = createHiddenJobGate({ isHidden: () => true, limitsApply: () => true,
    graceMs: 0, budgetBytes: f.base.data.byteLength + 32, residentBytes: f.ledger.retained });
  let admitted = false;
  const admission = gate.admit({ bytes: 32 }).then(release => { admitted = true; return release; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(gate.waiting, 1);
  assert.equal(admitted, false, 'the live worker and brush planes hold the item back');
  f.db.failures.write = true;
  assert.equal(await f.c.parkOpenPhotoForHiddenJob(), false);
  gate.recheck();
  assert.equal(terminated, 0, 'a failed archive retains the actual worker');
  assert.equal(f.c.workerResidentBytes(), opaque);
  assert.equal(f.ledger.retained(), before, 'no accounting is hidden to pass the budget');
  assert.equal(admitted, false);
  f.db.failures.write = false;
  assert.equal(await f.c.parkOpenPhotoForHiddenJob(), true);
  assert.equal(terminated, 1, 'committed parking actually terminates the unused worker');
  assert.equal(dust.holds(clean), false, 'the client also relinquishes its source reference');
  assert.equal(f.c.workerResidentBytes(), 0, 'worker accounting disappears only after termination');
  assert.equal(f.ledger.retained(), f.base.data.byteLength, 'archived page/brush/border planes are also relinquished');
  gate.recheck();
  const release = await admission;
  assert.equal(admitted, true, 'the waiting hidden item resumes on the real ownership drop');
  release(); gate.dispose();
}

console.log('hiddenPhotoPark: exact brush restoration, ordinary cold history, storage races/failures and shared foreground restoration passed');

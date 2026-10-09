// #241 part 2e + #229 review: parking the open photo for a held hidden job
// must never take the planes an export owns. A single export can be waiting
// for the repair model while the window is hidden; parking then cleared its
// planes and the export failed with "No image available for export". Runs the
// real main.js functions with the editor stubbed: an export lock held at entry
// or taken while the brush archive is being written keeps the photo live and
// rolls the new archive back; an idle photo still parks.
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

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
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
    singleExportActive: false, batchLocked: false, isDesktopBatchExportLocked: () => c.batchLocked, parkedPhoto: null, parkingPhoto: false, manualEditRevision: 0, dustHistoryArchive: archive,
    // No cold history entry's dust state is being compacted (#281).
    finishColdDustJobs() {},
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
for(const brush of [false,true]) for(const lock of ['single','batch']) {
 const f=fixture({brush});const live=f.state.processedImageData;const bytes=f.ledger.retained();
 if(lock==='single')f.c.singleExportActive=true;else f.c.batchLocked=true;
 assert.equal(await f.c.parkOpenPhotoForHiddenJob(),false,lock+' locked export cannot park');
 assert.equal(f.state.processedImageData,live);assert.equal(f.ledger.retained(),bytes,'live bytes remain genuinely accounted');assert.equal(f.c.loadGeneration,4);assert.equal(f.db.records.size,0);
 console.log('parking ownership PASS initial '+lock+' brush '+brush);
}
for(const lock of ['single','batch']) {
 const f=fixture();const save=f.c.dustHistoryArchive.save;let release;const wait=new Promise(r=>release=r);
 f.c.dustHistoryArchive.save=async(...args)=>{await wait;return save(...args);};const live=f.state.processedImageData;const bytes=f.ledger.retained();
 const parking=f.c.parkOpenPhotoForHiddenJob();if(lock==='single')f.c.singleExportActive=true;else f.c.batchLocked=true;release();
 assert.equal(await parking,false,lock+' export beginning during archive retains ownership');assert.equal(f.state.processedImageData,live);assert.equal(f.ledger.retained(),bytes);assert.equal(f.c.loadGeneration,4);assert.equal(f.db.records.size,0,'unused new archive rolled back');
 console.log('parking ownership PASS after archive '+lock);
}
for(const brush of [false,true]) {
 const f=fixture({brush});assert.equal(await f.c.parkOpenPhotoForHiddenJob(),true,'idle parking remains valid');assert.equal(f.ledger.retained(),f.base.data.byteLength,'only genuinely retained base remains');console.log('parking ownership PASS idle brush '+brush);
}

// Standalone Node test for the export plane lifecycle in main.js (#250). The
// real export functions run in a vm context against the real bridge, whose
// worker is the real exportWorker.js running in-process (every message
// crosses a structured clone with its transfer list, both ways).
//
// - exportSingle creates its own bridge, disposes of it exactly once after the
//   last request settled, and rejects no request; it never touches the
//   module-level bridge.
// - A 16-bit TIFF/PNG single export is one adjust16AndEncode request whose
//   bytes equal the main-thread adjust + encode; the editor's plane is copied.
// - PNG8 and JPEG (with the gain map in the same request) encode in the worker.
// - After every format, state.displayImageData carries no export plane.
// - A 1-lane batch uses a pool of one, disposes it, never the module bridge;
//   it transfers the frame's planes; a lost plane re-renders the frame once
//   with identical output; the frame's owned planes are released.
// - The dust-repaired image the editor patches in place (#259) is marked for
//   a one-task copy before a single export hands it over, with the same bytes.
// - Without OffscreenCanvas in the worker (WebKit before 16.4), single and
//   batch PNG8 and JPEG encode through the canvas: the frame and the map's
//   plane come back from the worker, the canvas encodes the restored frame,
//   and the map has its own request, equal to the main-thread map. That map
//   stops with the export (Cancel, a failed encode): no fallback, no worker
//   after the bridge was disposed of.
// - A batch frame rendered again after a lost plane frees the failed
//   attempt's planes before it decodes again.
import { MEMORY_FUNCTIONS, memoryGlobals } from './memoryHarness.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

class TestImageData {
  constructor(data, width, height) {
    if (!(data instanceof Uint8ClampedArray) || data.length !== width * height * 4) throw new TypeError('bad ImageData');
    Object.assign(this, { data, width, height });
  }
}
globalThis.ImageData = TestImageData;

// A CPU OffscreenCanvas stand-in: encodes `type|quality|pixels`, so a test can
// read back exactly which pixels and options reached the encoder.
class StubOffscreenCanvas {
  constructor(width, height) { Object.assign(this, { width, height, drawn: null }); }
  getContext(kind) {
    return kind === '2d' ? { putImageData: (image) => { this.drawn = new Uint8ClampedArray(image.data); } } : null;
  }
  async convertToBlob({ type, quality } = {}) { return new Blob([`${type}|${quality}|`, this.drawn], { type }); }
}
globalThis.OffscreenCanvas = StubOffscreenCanvas;

// ------------------------------------------------ in-process export worker
let activeWorker = null;
const workerPosts = [];
globalThis.self = {
  onmessage: null,
  postMessage(message, transfers = []) {
    const cloned = structuredClone(message, { transfer: transfers });
    const target = activeWorker;
    queueMicrotask(() => target && !target.terminated && target.onmessage && target.onmessage({ data: cloned }));
  }
};
await import('../workers/exportWorker.js');
const workerInstances = [];
class InProcessWorker {
  constructor() {
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
    this.terminated = false;
    this.crashOn = null;
    activeWorker = this;
    workerInstances.push(this);
  }
  postMessage(message, transfers = []) {
    // `sizes`: the transferred buffers' lengths when posted (they detach here).
    workerPosts.push({ type: message.type, transfers: transfers.slice(), sizes: transfers.map((buffer) => buffer.byteLength), worker: this });
    const received = structuredClone(message, { transfer: transfers });
    if (crashNext && crashNext(message)) {
      crashNext = null;
      queueMicrotask(() => this.onerror(new Error('worker crashed')));
      return;
    }
    // A long pass: the request is received and never answered.
    if (holdNext && holdNext(message)) {
      holdNext = null;
      return;
    }
    activeWorker = this;
    queueMicrotask(() => { if (!this.terminated) self.onmessage({ data: received }); });
  }
  terminate() { this.terminated = true; }
}
let crashNext = null;
let holdNext = null;
// #256: the band pool a test installs (none by default).
let bandPoolSize = 0;
let bandMinPixels = 4_000_000;
let bandPoolFactory = () => assert.fail('no band pool in this fixture');
const { createBandedExportBridge } = await import('./bandedExportBridge.js');
const { bandThreadFactory } = await import('./bandWorkerThreads.mjs');
const { bandsSupported } = await import('../pipeline/silverBands.js');

const bridgeModule = await import('../workers/workerBridge.js');
const {
  markOwnedPlanes, planeBuffersOf, releaseOwnedPlanes, setLiveReferenceProbe, configurePlaneRelease, markLiveMutableBuffer, isLiveMutableBuffer,
  isOwnedBuffer
} = await import('./planeRelease.js');
const { requestExportGainMap, gainMapInputsMatch } = await import('./exportGainMap.js');
const adjustment = await import('./adjustmentPipeline.js');
const encoders = await import('./exportImageEncoders.js');
const { computeGainMap } = await import('./gainMapJpeg.js');
const { runBatchPipeline, createLearningBarrier, planDecodeAhead, EXPORT_MAX_UNWRITTEN_BYTES, LANE_BYTES_PER_PIXEL } = await import('./batchExportScheduler.js');
const { createRetainedLedger } = await import('./memoryBudget.js');
const { downconvertPlane16 } = await import('../workers/pixelAdjustments16.js');

configurePlaneRelease({ engine: 'webkit' });

// ------------------------------------------------------ main.js functions
const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source)?.index;
  assert.notEqual(start, undefined, `${name} exists`);
  const end = source.indexOf('\n    }', start);
  return source.slice(start, end + '\n    }'.length);
}
const runtime = [
  'getEffectiveExportBitDepth', 'getExportInfo', 'applySprocketFrameForExport', 'getCurrentExportImageData',
  'prepareCurrentImageForExport', 'renderCurrentImageDataForExport', 'encodeFused16', 'renderAndEncodeCurrentImage',
  'exportSingle', 'applyAdjustmentsWithSettings', 'applyPreparedAdjustmentsWithWorkers', 'startExportGainMap',
  'imageDataToBlob', 'png16EncodeSettings', 'makeExportCancelledError', 'createBatchExportWorkers',
  'renderBatchExportFile', 'runBatchExport', 'batchPipelineMode', 'batchDecodeAhead', 'mayLearnFromExport',
  'encodeResidentFrame', 'createExportBands', 'convertForExportInBands', 'markInPlaceEditedPlanes', 'memoryLedgerConsumers',
  ...MEMORY_FUNCTIONS
].map(functionSource).join('\n')
  // vm scripts have no dynamic import: hand the module over directly.
  .replaceAll("await import('./gainMapJpeg.js')", 'await importGainMapJpeg()');

// ------------------------------------------------------------- the frame
const W = 1201; // > 1 MP with H, so the adjustment stage runs in the worker
const H = 853;
function makeProcessed(seed = 1) {
  const plane = new Uint16Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    const t = x / (W - 1) * 0.7 + y / (H - 1) * 0.3;
    plane[o] = Math.round(t * 60000) + ((x * seed) & 255);
    plane[o + 1] = Math.round(t * 52000) + ((y * seed) & 127);
    plane[o + 2] = Math.round(t * 44000) + 7;
    plane[o + 3] = 65535;
  }
  const image = new TestImageData(downconvertPlane16(plane, new Uint8ClampedArray(plane.length)), W, H);
  image.__image16 = { width: W, height: H, data: plane };
  return image;
}
const ramp = () => Uint8Array.from({ length: 256 }, (_, v) => v);
const sCurve = () => Uint8Array.from({ length: 256 }, (_, v) => Math.round(255 * (0.5 - 0.5 * Math.cos(Math.PI * v / 255))));
const recipe = () => ({
  curves: { r: sCurve(), g: ramp(), b: sCurve() }, exposure: 0.2, contrast: 8, highlights: -10, shadows: 6,
  temperature: 4, tint: -2, saturation: 5, vibrance: 10, cyan: 0, magenta: 0, yellow: 0, wbR: 1.03, wbG: 1, wbB: 0.97, look: null
});

function stubBlobText(blob) { return blob.arrayBuffer().then((b) => new Uint8Array(b)); }
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// ------------------------------------------------------------- the context
const bridges = [];
const saved = [];
const released = [];
function createContext({ gainMap = 'on' } = {}) {
  const processed = makeProcessed();
  markOwnedPlanes(processed); // a conversion result
  const state = {
    currentStep: 3, processedImageData: processed, processedImageDataIsPreview: false, displayImageData: null,
    exportSprocketHolesEnabled: false, jpegQuality: 92, exportFormat: 'png', exportBitDepth: 8,
    currentFileIndex: 0, fileQueue: [], dustRemoval: { enabled: false }, repairStrokes: [],
    conversionSourceImageData: null
  };
  // The editor's planes: never transferred, never released.
  setLiveReferenceProbe(() => new Set([...planeBuffersOf(state.processedImageData), ...planeBuffersOf(state.displayImageData)]));
  const moduleBridgeUse = [];
  const guardedDefault = new Proxy({}, { get: (_, key) => () => { moduleBridgeUse.push(key); throw new Error(`module bridge used: ${String(key)}`); } });
  // Counts full-frame 8-bit allocations made by the main.js functions (#250:
  // none in the adjust or encode stages of a 16-bit TIFF/PNG or a gain map).
  const CountingUint8ClampedArray = new Proxy(Uint8ClampedArray, {
    construct(target, args) {
      const array = new target(...args);
      if (array.length >= W * H * 4 && !(args[0] instanceof ArrayBuffer)) fullFrameAllocations.push(array.length);
      return array;
    }
  });
  const context = vm.createContext({
    state, console, Blob, Uint8ClampedArray: CountingUint8ClampedArray, Uint16Array, Promise, Error, Object, Array, Number, Boolean, Math, JSON,
    ImageData: TestImageData,
    // Not a two-stage import's stand-in (#255).
    ensureFullDecode: async () => true,
    setTimeout: (fn) => setImmediate(fn),
    manualEditRevision: 0,
    i18n: { en: { loadingExporting: 'e', loadingAdjusting: 'a', loadingEncoding: 'n', loadingComplete: 'c' } },
    currentLang: 'en',
    processNegativeInFlight: null,
    getCurrentQueueItem: () => null,
    buildActiveExportFileName: () => 'frame.out',
    isTauriDesktop: () => false,
    notifyReviewExport: () => {},
    // The export's Cancel button: `overlayCancel()` presses it once offered.
    getLoadingOverlay: () => ({
      show: async () => {}, updateProgress: () => {}, hide: () => {},
      setCancelable: (on, options) => { overlayCancel = on && options && options.onCancel ? options.onCancel : null; }
    }),
    // The integration branch's export path (#241 hidden jobs, #244 geometry,
    // #257 PNG16 band pool, single-export Cancel).
    AbortController,
    whenGeometrySettled: async () => {},
    settlePendingCropDetection: async () => {},
    getLocalizedText: (key, fallback) => fallback,
    isAbortError: bridgeModule.isAbortError,
    createOperationPng16Pool: (lanes = 1) => (png16PoolFactory ? png16PoolFactory(lanes) : null),
    planGeometryBandsInFlight: () => 2,
    geometryPool: { size: 1 },
    hiddenJobs: { safeMode: false, admit: async () => () => {}, status: () => ({ hidden: false, limited: false, safeMode: false }) },
    ...memoryGlobals(),
    hiddenJobBytesFor: async () => 0,
    activeLongJobs: 0,
    navigator: { deviceMemory: 8, hardwareConcurrency: 8 },
    persistCurrentFileSettings: () => {},
    exportMetadataFor: () => ({ exif: { Make: 'Test' }, xmp: null }),
    saveBlob: async (blob) => { saved.push(blob); return { saved: true }; },
    learnFromExport: async () => {},
    ensureFullResolutionReadyForExport: async () => {}, ensureRepairsReadyForExport: async () => {},
    aiRepairReady: () => false, aiRepair: { status: 'idle', revision: 0 },
    isWebGLActive: () => true,
    safeStorageGet: (key) => (key === 'nc_hdr_gain_map_v1' ? gainMap : null),
    buildAdjustmentSettings: (settings) => (settings === state ? state.recipe : settings.recipe),
    createPerfTrace: () => ({ mark() {}, end(extra) { traces.push(extra); } }),
    getImageDataPixelCount: (image) => (image ? image.width * image.height : 0),
    attachMetadataToBlob: async (blob, kind, metadata) => { attached.push({ kind, metadata: Boolean(metadata) }); return blob; },
    getExportImageEncoders: async () => encoders,
    imageDataToCanvasBlob: async (image, type, quality) => {
      canvasEncodes.push(type);
      canvasImages.push(image);
      return new Blob([`${type}|${quality}|`, new Uint8ClampedArray(image.data)], { type });
    },
    importGainMapJpeg: async () => ({
      computeGainMap,
      packGainMapJpeg: async (blob, gain, map) => new Blob([blob, '|GAIN|', gain, `|${map.gainMax}|${map.gainMin}`])
    }),
    gainMapInputsMatch, requestExportGainMap,
    ...adjustment,
    adjustmentLutScratch: adjustment.createAdjustmentLutScratch(),
    markOwnedPlanes, planeBuffersOf, markLiveMutableBuffer,
    // History: dust-stroke entries patch the images they hold (#259).
    undoStack: [], redoStack: [],
    releaseOwnedPlanes: (...items) => { released.push(items); return releaseOwnedPlanes(...items); },
    isExportInputLostError: bridgeModule.isExportInputLostError,
    isConversionInputLost: (err) => Boolean(err) && err.code === 'INPUT_LOST',
    defaultExportWorkers: guardedDefault,
    createExportWorkerBridge: () => {
      const bridge = bridgeModule.createExportWorkerBridge({ workerFactory: () => new InProcessWorker() });
      const record = { bridge, disposed: 0, pendingAtDispose: [], terminated: 0, rejected: 0, workersAtDispose: null };
      const spied = {};
      for (const [key, value] of Object.entries(bridge)) {
        if (typeof value !== 'function') continue;
        spied[key] = (...args) => {
          if (key === 'dispose') {
            record.disposed++;
            record.pendingAtDispose.push(bridge.pendingCount);
            record.workersAtDispose = workerInstances.length;
            return value(...args);
          }
          if (key === 'terminateWorker') {
            record.terminated++;
            return value(...args);
          }
          const result = value(...args);
          if (result && typeof result.then === 'function') result.catch(() => { record.rejected++; });
          return result;
        };
      }
      bridges.push(record);
      return spied;
    },
    createExportWorkerPool: (options) => {
      const pool = bridgeModule.createExportWorkerPool({ ...options, workerFactory: () => new InProcessWorker() });
      const record = { pool, size: options.size, disposed: 0 };
      pools.push(record);
      return { ...pool, dispose: () => { record.disposed++; pool.dispose(); } };
    },
    createDustWorkerClient: () => ({ dispose() {} }),
    conversionWorkerBroken: false,
    usesSilverCoreConversion: () => true,
    createConversionWorkerPool: () => { const convert = async () => assert.fail('no conversion in this fixture'); convert.dispose = () => {}; return convert; },
    convertFrameWithRouter: async () => assert.fail('no main-thread conversion in this fixture'),
    planBatchExportLanes: async () => ({ lanes: 1, pixelsPerFile: W * H }),
    runBatchPipeline, createLearningBarrier, planDecodeAhead, EXPORT_MAX_UNWRITTEN_BYTES,
    // #256 stages: decode-ahead only for RAW names here, never admitted by
    // default (the fixture decodes nothing); tests below switch it on.
    batchPipelineDiagnostics: { batches: 0, droppedPlanes16: 0, residentFrames: 0, bandBridge: {}, bands: null, singleExport: null,
      decodeAhead: { admitted: 0, refused: { ceiling: 0, 'low-memory': 0, engine: 0, hidden: 0, foreground: 0, format: 0 } } },
    // #256 band pool: none in this fixture (a 1 MP frame, and no pool size),
    // unless a test below sets one.
    exportBands: null,
    Worker: function Worker() { throw new Error('band workers come from the pool factory'); },
    planBandPoolSize: () => bandPoolSize, planBandCount: () => 2, BAND_POOL_MIN_PIXELS: bandMinPixels,
    createConversionBandPool: (options) => bandPoolFactory(options),
    createBandedExportBridge: (...args) => createBandedExportBridge(...args),
    bandsSupported: (...args) => bandsSupported(...args),
    WORKER_ABORTED: 'WORKER_ABORTED',
    convertFullResolutionFrameInWorker: async () => assert.fail('no full-resolution render in this fixture'),
    isRawLikeFileName: (name) => /\.(dng|nef)$/.test(name), isPngFile: () => false,
    imagePixelsForBatch: async () => W * H, hiddenResidentBytes: () => 0,
    backgroundGate: { idle: async () => true }, BACKGROUND_STEP_WAIT_CAP_MS: 2000,
    loadFileToImageData: async () => assert.fail('no decode in this fixture'),
    updateFileListUI: () => {},
    renderLinearDngBlob: () => assert.fail('no DNG here'),
    getSprocketFrameComposeOptions: () => ({}),
    ensureSprocketFrameFonts: async () => {},
    composeSprocketFrame: (image) => new TestImageData(new Uint8ClampedArray(image.data), image.width, image.height),
    canvas: { width: 0, height: 0 }, ctx: null
  });
  vm.runInContext(runtime, context);
  state.recipe = recipe();
  return { context, state, processed, moduleBridgeUse };
}
// The PNG16 band pool of an export operation; null: no pool (a batch of
// three or more lanes, or no Worker), so a PNG16 takes the fused request.
let png16PoolFactory = null;
const png16Pools = [];
const traces = [];
const fullFrameAllocations = [];
const attached = [];
const canvasEncodes = [];
const canvasImages = [];
const pools = [];
let overlayCancel = null;

// Main-thread references.
function referenceAdjusted8(processed, settings) {
  const output = new TestImageData(new Uint8ClampedArray(processed.data.length), W, H);
  adjustment.applyPreparedAdjustmentsToBuffer(processed, settings, output, { quality: 'full' });
  return output;
}
function referencePlane16(processed, settings) {
  return adjustment.applyPreparedAdjustmentsToPlane16(processed, settings, { quality: 'full' });
}

// ============================================================ single export
for (const [format, bitDepth] of [['tiff', 16], ['png', 16], ['png', 8], ['jpeg', 8], ['tiff', 8]]) {
  const f = createContext();
  f.state.exportFormat = format;
  f.state.exportBitDepth = bitDepth;
  const label = `${format}${bitDepth}`;
  const plane = f.state.processedImageData.__image16;
  const planeBefore = plane.data.slice();
  workerPosts.length = 0;
  traces.length = 0;
  canvasEncodes.length = 0;
  saved.length = 0;
  released.length = 0;
  fullFrameAllocations.length = 0;
  const result = await f.context.exportSingle();
  if (bitDepth === 16 || format === 'jpeg') {
    assert.deepEqual(fullFrameAllocations, [], `${label}: no full-frame 8-bit array on the main thread`);
  }
  assert.equal(released.length, 1, `${label}: one release when the export ends`);
  assert.equal(result.saved, true, `${label}: saved`);
  const record = bridges.at(-1);
  assert.equal(record.disposed, 1, `${label}: the per-export bridge is disposed of exactly once`);
  assert.deepEqual(record.pendingAtDispose, [0], `${label}: after its last request settled`);
  assert.equal(record.terminated, 0, `${label}: never merely terminated (that bridge would start a worker again)`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(record.rejected, 0, `${label}: no request was rejected`);
  assert.deepEqual(f.moduleBridgeUse, [], `${label}: the module-level bridge is never used`);
  assert.ok(workerInstances.at(-1).terminated, `${label}: the export's worker is gone`);
  assert.deepEqual(canvasEncodes, [], `${label}: nothing is encoded on the main thread`);
  assert.ok(traces.some((t) => t && t.worker === true), `${label}: the imageDataToBlob trace reports worker: true`);
  assert.equal(plane.data.length, W * H * 4, `${label}: the editor's plane is never transferred`);
  assert.ok(same(plane.data, planeBefore), `${label}: nor written`);
  for (const post of workerPosts) {
    assert.ok(!post.transfers.includes(plane.data.buffer), `${label}: ${post.type} names no editor buffer`);
  }
  const bytes = await stubBlobText(saved[0]);
  const settings = f.state.recipe;
  if (bitDepth === 16) {
    assert.deepEqual(workerPosts.map((p) => p.type), ['adjust16AndEncode'], `${label}: one fused request`);
    const expectedPlane = referencePlane16(f.state.processedImageData, settings);
    const expected = new Uint8Array(await (format === 'tiff'
      ? encoders.encodeTiffBlob({ width: W, height: H, __image16: expectedPlane }, 16, { exif: { Make: 'Test' }, xmp: null })
      : encoders.encodePng16Blob({ width: W, height: H, __image16: expectedPlane })).arrayBuffer());
    assert.ok(same(bytes, expected), `${label}: fused bytes == main-thread adjust + encode`);
  } else if (format === 'tiff') {
    assert.deepEqual(workerPosts.map((p) => p.type), ['applyAdjustments', 'encodeTiff']);
    const expected = new Uint8Array(await encoders.encodeTiffBlob(referenceAdjusted8(f.state.processedImageData, settings), 8, { exif: { Make: 'Test' }, xmp: null }).arrayBuffer());
    assert.ok(same(bytes, expected), `${label}: bytes`);
    assert.equal(workerPosts[1].transfers.length, 1);
  } else {
    assert.deepEqual(workerPosts.map((p) => p.type), ['applyAdjustments', 'encodeImage'], `${label}: adjust, then encode in the worker`);
    const sdr = referenceAdjusted8(f.state.processedImageData, settings);
    const text = new TextDecoder('latin1').decode(bytes);
    const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const quality = format === 'jpeg' ? '0.92' : 'undefined';
    const head = `${mime}|${quality}|`;
    assert.ok(text.startsWith(head), `${label}: encoder options`);
    const sdrBytes = bytes.subarray(head.length, head.length + sdr.data.length);
    assert.ok(same(sdrBytes, sdr.data), `${label}: SDR pixels == main-thread adjustment`);
    if (format === 'jpeg') {
      const map = computeGainMap(sdr, referencePlane16(f.state.processedImageData, settings));
      const tail = new Uint8Array(await new Blob(['|GAIN|', `image/jpeg|0.85|`, map.data, `|${map.gainMax}|${map.gainMin}`]).arrayBuffer());
      assert.ok(same(bytes.subarray(head.length + sdr.data.length), tail), 'JPEG: gain map from the same request == main-thread map');
      assert.equal(workerPosts[1].transfers.length, 2, 'the SDR frame and a copy of the plane');
    }
    // The fresh adjusted frame was transferred (no copy); the editor plane copied.
    const [adjustedFrame] = released.at(-1);
    assert.equal(workerPosts[1].transfers[0], adjustedFrame.data.buffer, `${label}: the adjusted frame itself moved to the worker`);
  }
  // No export plane on live state.
  assert.equal(f.state.displayImageData, null);
}

// ================================== single export of an image patched in place
// #259: with dust removal on, the export's source is the repaired image that
// brush strokes and their undo and redo patch in place, and undo is not
// blocked while an export runs. The export marks it, and every image a stroke
// entry patches, before it hands the planes to the bridge, which then copies
// them in one task (workerBridgeOwnership.test.mjs: no torn rows). The bytes
// are those of the same export without dust.
for (const [format, bitDepth] of [['tiff', 16], ['png', 16], ['png', 8], ['jpeg', 8]]) {
  const label = `dust ${format}${bitDepth}`;
  const plain = createContext();
  Object.assign(plain.state, { exportFormat: format, exportBitDepth: bitDepth });
  saved.length = 0;
  assert.equal((await plain.context.exportSingle()).saved, true, `${label}: reference export`);
  const expected = await stubBlobText(saved[0]);
  for (const image of [plain.processed]) {
    for (const buffer of planeBuffersOf(image)) assert.equal(isLiveMutableBuffer(buffer), false, `${label}: without dust nothing is marked`);
  }

  const f = createContext();
  Object.assign(f.state, { exportFormat: format, exportBitDepth: bitDepth });
  const repaired = f.state.processedImageData;
  const earlier = makeProcessed(3);
  const redone = makeProcessed(5);
  f.state.dustRemoval = { enabled: true, inpaintedImageData: repaired, mask: new Uint8Array(W * H) };
  f.context.undoStack.push({ label: 'dustBrushStroke', dustDelta: { target: earlier } }, { label: 'exposure', refs: { processedImageData: repaired } });
  f.context.redoStack.push({ label: 'dustBrushStroke', dustDelta: { target: redone } });
  saved.length = 0;
  assert.equal((await f.context.exportSingle()).saved, true, label);
  for (const image of [repaired, earlier, redone]) {
    for (const buffer of planeBuffersOf(image)) assert.ok(isLiveMutableBuffer(buffer), `${label}: patched-in-place planes are marked`);
  }
  assert.ok(same(await stubBlobText(saved[0]), expected), `${label}: the same bytes`);

  // The clean source standing in for a repaired image (no dust found yet) is
  // never patched: a stroke clones it first. It keeps its sliced copy.
  const clean = createContext();
  Object.assign(clean.state, { exportFormat: format, exportBitDepth: bitDepth });
  clean.state.dustRemoval = { enabled: true, inpaintedImageData: clean.processed, cleanSource: clean.processed, mask: new Uint8Array(W * H) };
  saved.length = 0;
  assert.equal((await clean.context.exportSingle()).saved, true, `${label}: clean-source stand-in`);
  for (const buffer of planeBuffersOf(clean.processed)) assert.equal(isLiveMutableBuffer(buffer), false, `${label}: the clean source is not marked`);
  assert.ok(same(await stubBlobText(saved[0]), expected), `${label}: clean-source bytes`);
}

// ============================================= single export on the band pool
// #256 Part 5: the export's Step 3 runs in row bands on the conversion band
// pool (real band workers in worker_threads) and the per-export bridge only
// encodes; the bytes are those of the one-worker path, the editor's plane is
// only ever copied, and the pool ends with the export.
{
  const { createConversionBandPool } = await import('./conversionWorkerClient.js');
  const bandThreads = [];
  const pools = [];
  bandPoolSize = 3;
  bandMinPixels = 0;
  bandPoolFactory = (options) => {
    const pool = createConversionBandPool({ ...options, shared: false, workerFactory: bandThreadFactory({ threads: bandThreads }) });
    pools.push(pool);
    return pool;
  };
  try {
    for (const [format, bitDepth] of [['tiff', 16], ['png', 16], ['png', 8], ['jpeg', 8], ['tiff', 8]]) {
      const f = createContext();
      f.state.exportFormat = format;
      f.state.exportBitDepth = bitDepth;
      const label = `banded ${format}${bitDepth}`;
      const plane = f.state.processedImageData.__image16;
      const planeBefore = plane.data.slice();
      workerPosts.length = 0;
      saved.length = 0;
      const result = await f.context.exportSingle();
      assert.equal(result.saved, true, label);
      assert.equal(pools.length, 1, `${label}: one band pool for the export`);
      assert.ok(pools[0].stats.adjusts >= 1, `${label}: Step 3 ran on the bands`);
      assert.equal(pools[0].available, false, `${label}: the pool ends with the export`);
      assert.ok(same(plane.data, planeBefore) && plane.data.length === W * H * 4, `${label}: the editor's plane is only copied`);
      const types = workerPosts.map((p) => p.type);
      assert.ok(!types.some((type) => type.startsWith('applyAdjustments') || type === 'adjust16AndEncode'), `${label}: the export worker only encodes (${types})`);
      const bytes = await stubBlobText(saved[0]);
      const settings = f.state.recipe;
      if (bitDepth === 16) {
        const expectedPlane = referencePlane16(f.state.processedImageData, settings);
        const expected = new Uint8Array(await (format === 'tiff'
          ? encoders.encodeTiffBlob({ width: W, height: H, __image16: expectedPlane }, 16, { exif: { Make: 'Test' }, xmp: null })
          : encoders.encodePng16Blob({ width: W, height: H, __image16: expectedPlane })).arrayBuffer());
        assert.ok(same(bytes, expected), `${label}: banded bytes == one-worker bytes`);
      } else if (format === 'tiff') {
        const expected = new Uint8Array(await encoders.encodeTiffBlob(referenceAdjusted8(f.state.processedImageData, settings), 8, { exif: { Make: 'Test' }, xmp: null }).arrayBuffer());
        assert.ok(same(bytes, expected), `${label}: bytes`);
      } else {
        const sdr = referenceAdjusted8(f.state.processedImageData, settings);
        const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
        const head = `${mime}|${format === 'jpeg' ? '0.92' : 'undefined'}|`;
        assert.ok(same(bytes.subarray(head.length, head.length + sdr.data.length), sdr.data), `${label}: SDR pixels`);
        if (format === 'jpeg') {
          const map = computeGainMap(sdr, referencePlane16(f.state.processedImageData, settings));
          const tail = new Uint8Array(await new Blob(['|GAIN|', `image/jpeg|0.85|`, map.data, `|${map.gainMax}|${map.gainMin}`]).arrayBuffer());
          assert.ok(same(bytes.subarray(head.length + sdr.data.length), tail), `${label}: gain map from the banded 16-bit pass`);
        }
      }
      pools.length = 0;
    }
  } finally {
    bandPoolSize = 0;
    bandMinPixels = 4_000_000;
    bandPoolFactory = () => assert.fail('no band pool in this fixture');
    await Promise.all(bandThreads.map((thread) => thread.terminate()));
  }
}

{
  // The CPU display path (#242): the frame on screen (display-size, or drawn
  // without the rescue while "hold to see before" is held) is never an
  // export's pixels. Every format adjusts the processed frame in the export's
  // own worker; the display frame is neither read, transferred nor written.
  for (const [format, bitDepth] of [['jpeg', 8], ['png', 8], ['tiff', 16]]) {
    const f = createContext();
    f.context.isWebGLActive = () => false;
    f.state.exportFormat = format;
    f.state.exportBitDepth = bitDepth;
    const display = new TestImageData(new Uint8ClampedArray(W * H * 4).fill(7), W, H);
    f.state.displayImageData = display;
    const displayBytes = display.data.slice();
    workerPosts.length = 0;
    saved.length = 0;
    await f.context.exportSingle();
    assert.equal(workerPosts[0].type, bitDepth === 16 ? 'adjust16AndEncode' : 'applyAdjustments', `${format}${bitDepth}: adjusted in the worker`);
    for (const post of workerPosts) assert.ok(!post.transfers.includes(display.data.buffer), 'the display buffer never moves');
    assert.ok(same(display.data, displayBytes), 'the display frame is untouched');
    for (const key of ['__image16', '__gainMap', '__gainMapSource']) {
      assert.equal(display[key], undefined, `${format}${bitDepth}: state.displayImageData carries no ${key}`);
    }
    if (bitDepth === 8) {
      const bytes = await stubBlobText(saved[0]);
      const sdr = referenceAdjusted8(f.state.processedImageData, f.state.recipe);
      const head = format === 'jpeg' ? 'image/jpeg|0.92|' : 'image/png|undefined|';
      assert.ok(same(bytes.subarray(head.length, head.length + sdr.data.length), sdr.data),
        `${format}${bitDepth}: the exported pixels are the worker's adjustment, not the display frame`);
    }
    assert.equal(bridges.at(-1).disposed, 1);
  }
}

{
  // A crash while the worker holds the export's own adjusted frame: the
  // frame renders again with copies (the editor planes were only copied).
  const f = createContext();
  f.state.exportFormat = 'jpeg';
  let crashes = 0;
  crashNext = (message) => message.type === 'encodeImage' && ++crashes === 1;
  saved.length = 0;
  const warn = console.warn;
  const error = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    await f.context.exportSingle();
  } finally {
    console.warn = warn;
    console.error = error;
  }
  assert.equal(crashes, 1);
  assert.equal(saved.length, 1, 'the export still saves one file');
  assert.equal(bridges.at(-1).disposed, 1);
}

// ============================================================ batch export
function batchContext({ format, bitDepth, lose = null }) {
  const f = createContext();
  const frames = [];
  const makeFrame = () => {
    const processed = markOwnedPlanes(makeProcessed(3));
    frames.push(processed);
    return processed;
  };
  f.context.processFileWithSettings = async (file, settings, options) => {
    assert.equal(options.stage, 'processed', 'a batch frame stops before the adjustment stage');
    const processed = makeFrame();
    options.ownedPlanes.push(processed);
    return { processed, settings };
  };
  f.context.state.exportSprocketHolesEnabled = false;
  const exportInfo = f.context.getExportInfo(format, bitDepth);
  const jobs = [{ item: { file: { name: 'a' } }, file: { name: 'a' }, settings: { recipe: recipe() }, outputName: 'a' }];
  return { f, frames, exportInfo, jobs, lose };
}

for (const [format, bitDepth] of [['jpeg', 8], ['png', 8], ['tiff', 16], ['png', 16]]) {
  const label = `batch ${format}${bitDepth}`;
  const { f, frames, exportInfo, jobs } = batchContext({ format, bitDepth });
  pools.length = 0;
  released.length = 0;
  workerPosts.length = 0;
  const written = [];
  fullFrameAllocations.length = 0;
  const result = await f.context.runBatchExport(jobs, { exportInfo, sink: async (job, blob) => { written.push(blob); } });
  assert.equal(result.successCount, 1, `${label}: exported`);
  assert.deepEqual(fullFrameAllocations, [], `${label}: no full-frame 8-bit array on the main thread`);
  assert.equal(pools.length, 1, `${label}: one pool for the batch`);
  assert.equal(pools[0].size, 1, `${label}: a pool of one for one lane`);
  assert.equal(pools[0].disposed, 1, `${label}: disposed when the batch ends`);
  assert.deepEqual(f.moduleBridgeUse, [], `${label}: never the module-level bridge`);
  const [frame] = frames;
  if (format === 'png' && bitDepth === 8) {
    // An 8-bit output drops the unadjusted plane before the adjustment (#256).
    assert.equal(frame.__image16, null, `${label}: the 16-bit plane is dropped`);
  } else {
    assert.equal(frame.__image16.data.byteLength, 0, `${label}: the frame's plane moved to the worker`);
  }
  assert.ok(released.length >= 1 && released.at(-1).includes(frame), `${label}: the frame's planes are released`);
  const bytes = await stubBlobText(written[0]);
  const settings = jobs[0].settings.recipe;
  const reference = makeProcessed(3);
  if (bitDepth === 16) {
    assert.deepEqual(workerPosts.map((p) => p.type), ['adjust16AndEncode']);
    const plane = referencePlane16(reference, settings);
    const expected = new Uint8Array(await (format === 'tiff'
      ? encoders.encodeTiffBlob({ width: W, height: H, __image16: plane }, 16, { exif: { Make: 'Test' }, xmp: null })
      : encoders.encodePng16Blob({ width: W, height: H, __image16: plane })).arrayBuffer());
    assert.ok(same(bytes, expected), `${label}: bytes`);
  } else {
    assert.deepEqual(workerPosts.map((p) => p.type), ['applyAdjustments', 'encodeImage']);
    assert.equal(frame.data.byteLength, 0, `${label}: the 8-bit frame moved into the adjust stage`);
    const encode = workerPosts[1];
    assert.equal(encode.transfers.length, format === 'jpeg' ? 2 : 1, `${label}: SDR${format === 'jpeg' ? ' and plane' : ''} transferred`);
    const sdr = referenceAdjusted8(reference, settings);
    const head = format === 'jpeg' ? 'image/jpeg|0.92|' : 'image/png|undefined|';
    assert.ok(same(bytes.subarray(head.length, head.length + sdr.data.length), sdr.data), `${label}: SDR pixels`);
  }
}

{
  // A plane lost with its worker: the frame renders once more, from
  // scratch, with copies, and writes the same file.
  const run = async (lose) => {
    const { f, frames, exportInfo, jobs } = batchContext({ format: 'jpeg', bitDepth: 8 });
    let crashes = 0;
    crashNext = lose ? (message) => message.type === 'encodeImage' && ++crashes === 1 : null;
    const written = [];
    const warn = console.warn;
    const error = console.error;
    console.warn = () => {};
    console.error = () => {};
    workerPosts.length = 0;
    try {
      await f.context.runBatchExport(jobs, { exportInfo, sink: async (job, blob) => { written.push(blob); } });
    } finally {
      console.warn = warn;
      console.error = error;
      crashNext = null;
    }
    return { bytes: await stubBlobText(written[0]), frames, crashes, posts: workerPosts.slice() };
  };
  const clean = await run(false);
  const lost = await run(true);
  assert.equal(lost.crashes, 1);
  assert.equal(lost.frames.length, 2, 'the frame was rendered twice');
  const second = lost.frames[1];
  const secondBuffers = [second.data.buffer, second.__image16.data.buffer];
  const retry = lost.posts.slice(lost.posts.findIndex((p) => p.type === 'encodeImage') + 1);
  assert.deepEqual(retry.map((p) => p.type), ['applyAdjustments', 'encodeImage'], 'the frame was adjusted and encoded again');
  for (const post of retry) {
    assert.ok(!post.transfers.some((buffer) => secondBuffers.includes(buffer)), 'the second render copied its planes');
  }
  assert.ok(same(lost.bytes, clean.bytes), 'identical output after the re-render');

  // #229 R1-094: the conversion lane lost the frame's geometry output
  // (INPUT_LOST) while the frame's base, never sent, was still held. The
  // render from decode starts only after the failed attempt's planes were
  // released, not with them still resident until it ends.
  const { f, exportInfo, jobs } = batchContext({ format: 'jpeg', bitDepth: 8 });
  const process = f.context.processFileWithSettings;
  const base = markOwnedPlanes(makeProcessed(11));
  const baseBuffers = planeBuffersOf(base);
  let attempts = 0;
  let atRetry = null;
  f.context.processFileWithSettings = async (file, settings, options) => {
    attempts++;
    if (attempts === 1) {
      options.ownedPlanes.push(base);
      throw Object.assign(new Error('the lane lost the geometry output'), { code: 'INPUT_LOST' });
    }
    atRetry = {
      released: released.some((items) => items.includes(base)),
      detached: baseBuffers.every((buffer) => buffer.byteLength === 0)
    };
    return process(file, settings, options);
  };
  released.length = 0;
  const written = [];
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal((await f.context.runBatchExport(jobs, { exportInfo, sink: async (job, blob) => { written.push(blob); } })).successCount, 1);
  } finally {
    console.warn = warn;
  }
  assert.equal(attempts, 2, 'the frame was rendered again once');
  assert.deepEqual(atRetry, { released: true, detached: true }, 'the failed attempt\'s base was released before the frame was decoded again');
  assert.ok(same(await stubBlobText(written[0]), clean.bytes), 'the same file');
}

{
  // With a PNG16 band pool (#257: a single export, or a batch of one or two
  // lanes) a 16-bit PNG is not fused: the adjusted plane comes back by
  // transfer and the pool encodes its bands, with the fused request's bytes.
  png16PoolFactory = () => {
    const pool = bridgeModule.createPng16BandPool({ size: 1, workerFactory: () => new InProcessWorker() });
    const record = { disposed: 0 };
    png16Pools.push(record);
    return { size: pool.size, encode: pool.encode, dispose: () => { record.disposed++; pool.dispose(); } };
  };
  try {
    const expectedBytes = async (processed, settings) => new Uint8Array(await encoders.encodePng16Blob(
      { width: W, height: H, __image16: referencePlane16(processed, settings) }).arrayBuffer());
    const bandedOnly = (types, label) => {
      assert.equal(types[0], 'applyAdjustments16', `${label}: the adjust request first`);
      assert.ok(types.length > 1 && types.slice(1).every((type) => type === 'encodePng16Band'), `${label}: then only band requests (${types})`);
    };

    const f = createContext();
    f.state.exportFormat = 'png';
    f.state.exportBitDepth = 16;
    workerPosts.length = 0;
    saved.length = 0;
    png16Pools.length = 0;
    await f.context.exportSingle();
    bandedOnly(workerPosts.map((p) => p.type), 'single PNG16 with a pool');
    assert.equal(png16Pools.length, 1, 'single PNG16: one band pool');
    assert.equal(png16Pools[0].disposed, 1, 'single PNG16: the pool ends with the export');
    assert.equal(bridges.at(-1).disposed, 1);
    assert.ok(same(await stubBlobText(saved[0]), await expectedBytes(f.state.processedImageData, f.state.recipe)), 'single PNG16: banded bytes == fused bytes');

    const { f: b, frames, exportInfo, jobs } = batchContext({ format: 'png', bitDepth: 16 });
    workerPosts.length = 0;
    png16Pools.length = 0;
    const written = [];
    const result = await b.context.runBatchExport(jobs, { exportInfo, sink: async (job, blob) => { written.push(blob); } });
    assert.equal(result.successCount, 1);
    bandedOnly(workerPosts.map((p) => p.type), 'batch PNG16 with a pool');
    assert.ok(workerPosts[0].transfers.includes(frames[0].__image16.data.buffer), 'batch PNG16: the adjust request transfers the frame\'s plane');
    assert.equal(frames[0].__image16.data.byteLength, 0, 'batch PNG16: the frame\'s plane moved into the adjust stage');
    assert.equal(png16Pools.length, 1, 'batch PNG16: one band pool');
    assert.equal(png16Pools[0].disposed, 1, 'batch PNG16: the pool ends with the batch');
    assert.ok(same(await stubBlobText(written[0]), await expectedBytes(makeProcessed(3), jobs[0].settings.recipe)), 'batch PNG16: banded bytes == fused bytes');
  } finally {
    png16PoolFactory = null;
  }
}

{
  // #256 stages in runBatchExport: frames after the first are decoded ahead
  // (one at a time, one frame ahead) and handed over as the frame's owned
  // base; a lane goes on while its payload waits for the write; a
  // never-analysed frame reads the learned defaults only after an earlier
  // learning frame's write. 'serial' turns the stages off. `beforeBase` and
  // `onProcess` run in a frame's processing (before and after it reports its
  // base), `outstandingBytes` is a background reservation held during the
  // batch (a roll lane's), `engine` the page's memoryEngine().
  const run = async (mode, { budgetBytes = null, engine = null, outstandingBytes = 0, beforeBase = null, onProcess = null, signal = null } = {}) => {
    const { f, exportInfo } = batchContext({ format: 'png', bitDepth: 8 });
    const log = [];
    const decoded = [];
    f.context.safeStorageGet = (key) => (key === 'nc_batch_pipeline_v1' ? mode : null);
    f.context.state.rollReference = { applyLock: false };
    if (budgetBytes !== null) f.context.memoryBudget.setBudget(budgetBytes);
    if (engine) f.context.memoryRuntime.engine = engine;
    const outstanding = outstandingBytes
      ? await f.context.memoryBudget.reserve(outstandingBytes, { priority: 'background', label: 'roll lane' })
      : null;
    f.context.loadFileToImageData = async (file, options) => {
      assert.ok(options.signal instanceof AbortSignal, 'a prepared decode can be aborted');
      assert.equal(options.filmStats, !fileSettings.get(file.name), 'the options the lane would decode with');
      // Admitted at once against the memory budget's ceiling (#258); the
      // decode reserves nothing a lane could be waiting on.
      assert.equal(options.claim?.fixed, true, 'a prepared decode takes no reservation of its own');
      log.push(`decode-ahead:${file.name}${f.context.memoryBudget.foregroundOutstanding ? ':during-foreground' : ''}`);
      const base = makeProcessed(5);
      decoded.push(base);
      return base;
    };
    const fileSettings = new Map();
    let learnedAt = null;
    f.context.processFileWithSettings = async (file, settings, options) => {
      if (options.sourceImageData) {
        assert.equal(options.sourceOwned, true);
        assert.ok(decoded.includes(options.sourceImageData));
        log.push(`process:${file.name}:prepared`);
      } else {
        log.push(`process:${file.name}:self`);
        await beforeBase?.(file.name, f);
        options.onBaseReady?.();
      }
      await onProcess?.(file.name, options, f);
      if (!settings) {
        await options.learningBarrier();
        log.push(`learned-read:${file.name}:${learnedAt === null ? 'before' : 'after'}`);
      }
      const processed = markOwnedPlanes(makeProcessed(3));
      options.ownedPlanes.push(processed);
      return { processed, settings: settings || { recipe: recipe() } };
    };
    const names = ['a.dng', 'b.dng', 'c.dng', 'd.dng'];
    const jobs = names.map((name, i) => {
      const item = { file: { name }, touchedKeys: new Set(i === 0 ? ['exposure'] : []) };
      const settings = i === 2 ? null : { recipe: recipe() };
      fileSettings.set(name, settings);
      return { item, file: item.file, settings, outputName: name };
    });
    const written = [];
    const result = await f.context.runBatchExport(jobs, {
      exportInfo,
      learnsInSink: true,
      signal,
      sink: async (job, blob) => {
        written.push(job.file.name);
        log.push(`written:${job.file.name}`);
        const learned = job.item.touchedKeys.size
          ? new Promise((resolve) => setTimeout(() => { learnedAt = log.length; log.push(`learned:${job.file.name}`); resolve(); }, 5))
          : Promise.resolve();
        return { learned };
      }
    });
    outstanding?.release();
    if (signal) return { log, diagnostics: f.context.batchPipelineDiagnostics, f, result, written };
    assert.equal(result.successCount, 4);
    assert.deepEqual(written, names, 'written in order');
    assert.equal(f.context.heldJobFrames.size, 0, 'no frame decoded ahead is left in the ledger');
    assert.equal(f.context.memoryBudget.idle, true, 'every lane reservation was released');
    return { log, diagnostics: f.context.batchPipelineDiagnostics, f };
  };
  const staged = await run(null);
  assert.deepEqual(staged.log.filter((line) => line.startsWith('process:')),
    ['process:a.dng:self', 'process:b.dng:prepared', 'process:c.dng:prepared', 'process:d.dng:prepared']);
  assert.ok(staged.log.indexOf('decode-ahead:b.dng') < staged.log.indexOf('process:b.dng:prepared'));
  assert.ok(staged.log.indexOf('learned:a.dng') < staged.log.indexOf('learned-read:c.dng:after'), staged.log.join());
  assert.equal(staged.diagnostics.decodeAhead.admitted, 3);
  assert.equal(staged.diagnostics.last.prepare.taken, 3);
  // The memory budget (#258) is the ceiling: below one frame's estimate,
  // every lane decodes its own frame.
  const tight = await run(null, { budgetBytes: 1 });
  assert.deepEqual(tight.log.filter((line) => line.startsWith('decode-ahead')), [], 'no decode-ahead over the budget');
  assert.ok(tight.diagnostics.decodeAhead.refused.ceiling >= 1, 'refused by the ceiling');
  const serial = await run('serial');
  assert.deepEqual(serial.log.filter((line) => line.startsWith('decode-ahead')), [], 'serial: no decode-ahead');
  assert.equal(serial.diagnostics.last.earlyReleases, 0, 'serial: lanes held until their write');
  assert.ok(serial.log.includes('learned-read:c.dng:after'));

  const selfOnly = ['process:a.dng:self', 'process:b.dng:self', 'process:c.dng:self', 'process:d.dng:self'];
  const until = async (condition, what) => {
    for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(condition(), what);
  };

  // WebKit engines decode every frame in its lane until the #230 harness has
  // measured one (#256 Part 3); the engine is read at the batch's admissions.
  for (const engine of ['wkwebview', 'webkitgtk', 'webkit']) {
    const webkit = await run(null, { engine });
    assert.deepEqual(webkit.log.filter((line) => line.startsWith('process:')), selfOnly, engine);
    assert.equal(webkit.diagnostics.decodeAhead.admitted, 0, engine);
    assert.ok(webkit.diagnostics.decodeAhead.refused.engine >= 1, engine);
  }

  // A foreground reservation (a photo opened during the batch) refuses every
  // decode-ahead offered while it is out; once it ends, offers are admitted.
  {
    let foreground = null;
    const opened = await run(null, {
      beforeBase: async (name, f) => {
        if (name === 'a.dng') foreground = await f.context.memoryBudget.reserve(1, { priority: 'foreground', label: 'open photo' });
      },
      onProcess: async (name, _options, f) => {
        if (name !== 'a.dng') return;
        await until(() => f.context.batchPipelineDiagnostics.decodeAhead.refused.foreground >= 1, 'the offer was decided while the photo opened');
        for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
        foreground.release();
      }
    });
    assert.deepEqual(opened.log.filter((line) => line.endsWith(':during-foreground')), [], 'nothing decoded ahead while the photo opened');
    assert.ok(opened.log.includes('process:d.dng:prepared'), opened.log.join());
  }

  // The budget's outstanding reservations count, the batch's own lanes do not
  // (their frames and payloads are counted apart): a ceiling half a lane above
  // the estimate admits beside the batch's own lane, and refuses beside a
  // roll lane's reservation of one lane.
  {
    const estimate = planDecodeAhead({ candidatePixels: W * H, processingPixels: [W * H] }).bytes;
    const laneBytes = W * H * LANE_BYTES_PER_PIXEL;
    const own = await run(null, { budgetBytes: estimate + laneBytes / 2 });
    assert.ok(own.log.includes('process:b.dng:prepared'), 'the batch\'s own lane is not counted twice: ' + own.log.join());
    const beside = await run(null, { budgetBytes: estimate + laneBytes / 2, outstandingBytes: laneBytes });
    assert.deepEqual(beside.log.filter((line) => line.startsWith('process:')), selfOnly, 'refused beside a roll lane');
    assert.equal(beside.diagnostics.decodeAhead.admitted, 0);
    assert.ok(beside.diagnostics.decodeAhead.refused.ceiling >= 1);
  }

  // A frame decoded ahead is in the ledger (heldJobFrames, #258) until its
  // lane takes it, and a cancelled batch drops it from there. The ledger is
  // main.js's (memoryLedgerConsumers), its other consumers empty here.
  {
    const frameBytes = 12 * W * H;
    let retainedWaiting = null;
    let heldWhenTaken = null;
    const counted = await run(null, {
      onProcess: async (name, options, f) => {
        Object.assign(f.context, {
          openPhotoMemoryRoots: () => [], photoSessions: { buffers: () => [] }, photoPreviews: { buffers: () => [] },
          boundedStoreBuffers: () => [], sampleStoreBytes: () => 0, workerResidentBytes: () => 0
        });
        const ledger = createRetainedLedger(() => f.context.memoryLedgerConsumers());
        if (name === 'a.dng') {
          await until(() => f.context.heldJobFrames.size === 1, 'frame b was decoded ahead');
          retainedWaiting = ledger.measure();
        } else if (name === 'b.dng') {
          heldWhenTaken = f.context.heldJobFrames.has(options.sourceImageData);
        }
      }
    });
    assert.ok(counted.log.includes('process:b.dng:prepared'));
    assert.equal(retainedWaiting.total, frameBytes, 'the untaken base counts in the ledger');
    assert.equal(retainedWaiting.breakdown.jobs, frameBytes, 'as a job\'s frame');
    assert.equal(heldWhenTaken, false, 'the lane that takes it holds it in its reservation instead');

    const stop = new AbortController();
    const cancelled = await run(null, {
      signal: stop.signal,
      onProcess: async (name, _options, f) => {
        if (name !== 'a.dng') return;
        await until(() => f.context.heldJobFrames.size === 1, 'frame b was decoded ahead');
        stop.abort();
      }
    });
    assert.equal(cancelled.result.cancelled, true);
    assert.deepEqual(cancelled.written, ['a.dng']);
    assert.equal(cancelled.f.context.heldJobFrames.size, 0, 'the dropped frame left the ledger');
    assert.equal(cancelled.f.context.memoryBudget.idle, true);
  }
}

{
  // #256 Part 5 in a one-lane batch: frames convert in row bands; a frame
  // whose later steps need no pixels keeps its bands in the pool and runs
  // Step 3 there (the processed frame is never assembled on this thread); a
  // JPEG with its gain map converts in bands and adjusts through the banded
  // bridge. Every file is byte-identical to the serial run (the lane alone).
  // A band worker that crashes hands the frame to the lane with the same
  // bytes, and the pool is not used again.
  const { createConversionBandPool } = await import('./conversionWorkerClient.js');
  const { convertFrameWithRouter } = await import('../pipeline/conversionRouter.js');
  const bandThreads = [];
  const created = [];
  let crashOn = null;
  bandPoolSize = 3;
  bandMinPixels = 0;
  bandPoolFactory = (options) => {
    const pool = createConversionBandPool({ ...options, shared: false, onError: () => {}, workerFactory: bandThreadFactory({ threads: bandThreads, crashOn }) });
    created.push(pool);
    return pool;
  };
  const negativeSettings = { filmType: 'color', colorModel: 'standard', filmBase: { r: 210, g: 140, b: 90 } };
  const run = async ({ format, bitDepth, mode, gainMap = 'off', frames = 1, role = 'derived' }) => {
    const f = createContext({ gainMap });
    f.context.safeStorageGet = (key) => (key === 'nc_batch_pipeline_v1' ? mode : key === 'nc_hdr_gain_map_v1' ? gainMap : null);
    // Each lane decodes its own frame here: no decode-ahead, whichever of a
    // lane's admission (#258's memory budget) and the next frame's offer
    // settles first.
    f.context.isRawLikeFileName = () => false;
    f.context.createConversionWorkerPool = () => {
      const lane = async (request) => markOwnedPlanes(await convertFrameWithRouter({ imageData: request.imageData, settings: request.settings, options: request.options }));
      lane.dispose = () => {};
      return lane;
    };
    const kinds = [];
    f.context.processFileWithSettings = async (file, settings, options) => {
      const source = markOwnedPlanes(makeProcessed(7));
      options.ownedPlanes.push(source);
      const processed = await options.convert({
        imageData: source, settings: negativeSettings, options: { forceFullProcess: true }, sourceRole: role,
        ...(options.bandResident ? { resident: true } : {})
      });
      kinds.push(processed.__bands ? 'resident' : processed.data ? 'assembled' : 'other');
      if (role === 'derived' && mode !== 'serial' && created.length) assert.equal(source.__image16.data.byteLength, 0, 'the geometry output was released once sliced');
      options.ownedPlanes.push(processed);
      return { processed, settings };
    };
    const exportInfo = f.context.getExportInfo(format, bitDepth);
    const jobs = Array.from({ length: frames }, (_, i) => ({ item: { file: { name: `f${i}.dng` } }, file: { name: `f${i}.dng` }, settings: { recipe: recipe() }, outputName: `f${i}` }));
    const written = [];
    const result = await f.context.runBatchExport(jobs, { exportInfo, sink: async (job, blob) => { written.push(await stubBlobText(blob)); } });
    assert.equal(result.successCount, frames);
    return { written, kinds, diagnostics: f.context.batchPipelineDiagnostics };
  };
  try {
    for (const [format, bitDepth, gainMap, expectKind] of [
      ['tiff', 16, 'off', 'resident'], ['png', 8, 'off', 'resident'], ['jpeg', 8, 'off', 'resident'], ['jpeg', 8, 'on', 'assembled']
    ]) {
      const label = `batch bands ${format}${bitDepth}${gainMap === 'on' ? ' + gain map' : ''}`;
      created.length = 0;
      const serial = await run({ format, bitDepth, mode: 'serial', gainMap });
      assert.equal(created.length, 0, `${label}: serial runs without the band pool`);
      const banded = await run({ format, bitDepth, mode: null, gainMap });
      assert.equal(created.length, 1, `${label}: one band pool for the batch`);
      assert.equal(created[0].available, false, `${label}: released at batch end`);
      assert.ok(created[0].stats.frames >= 1, `${label}: the frame converted in bands`);
      assert.deepEqual(banded.kinds, [expectKind], label);
      if (expectKind === 'resident') assert.equal(banded.diagnostics.residentFrames, 1, `${label}: Step 3 on the resident bands`);
      assert.ok(same(banded.written[0], serial.written[0]), `${label}: bytes == serial`);
    }
    // A band worker crash: the lane converts the frame, and the pool is not
    // used for the next one. The base (not released) was only lent.
    created.length = 0;
    const serial = await run({ format: 'png', bitDepth: 8, mode: 'serial', frames: 2, role: 'base' });
    crashOn = (message) => message.type === 'apply';
    const warn = console.warn;
    console.warn = () => {};
    let crashed;
    try {
      crashed = await run({ format: 'png', bitDepth: 8, mode: null, frames: 2, role: 'base' });
    } finally {
      console.warn = warn;
      crashOn = null;
    }
    assert.equal(created[0].stats.failures, 1);
    assert.deepEqual(crashed.kinds, ['assembled', 'assembled'], 'the lane converted both frames');
    assert.ok(same(crashed.written[0], serial.written[0]) && same(crashed.written[1], serial.written[1]), 'the same bytes after the crash');
  } finally {
    bandPoolSize = 0;
    bandMinPixels = 4_000_000;
    bandPoolFactory = () => assert.fail('no band pool in this fixture');
    await Promise.all(bandThreads.map((thread) => thread.terminate()));
  }
}

{
  // #256 Part 5, single export: the export-time full-resolution render of a
  // large frame converts in bands (the editor's source is copied, never
  // released) and, without dust or repairs, leaves the bands in the pool; the
  // export's Step 3 then runs on them. The plane equals the one worker's
  // conversion, the adjusted plane the one worker's Step 3.
  const { createConversionBandPool } = await import('./conversionWorkerClient.js');
  const { convertFrameWithRouter } = await import('../pipeline/conversionRouter.js');
  const bandThreads = [];
  bandPoolSize = 3;
  bandMinPixels = 0;
  bandPoolFactory = (options) => createConversionBandPool({ ...options, shared: false, workerFactory: bandThreadFactory({ threads: bandThreads }) });
  try {
    const f = createContext();
    const source = makeProcessed(9);
    const sourceBefore = source.__image16.data.slice();
    const request = { imageData: source, settings: { filmType: 'bw', preSaturation: 120 }, options: { forceFullProcess: true, includeAnalysisPreview: false } };
    const expected = await convertFrameWithRouter({ imageData: makeProcessed(9), settings: request.settings, options: request.options });
    vm.runInContext('exportBands = createExportBands();', f.context);
    const bands = f.context.exportBands;
    const processed = await f.context.convertForExportInBands({ ...request, signal: null });
    assert.ok(same(processed.__image16.data, expected.__image16.data) && same(processed.data, expected.data), 'the banded render == one worker');
    assert.ok(same(source.__image16.data, sourceBefore), 'the editor source was copied, not released');
    assert.equal(bands.pool.stats.resident, 1, 'the bands stayed in the pool');
    const bridge = bridgeModule.createExportWorkerBridge({ workerFactory: () => new InProcessWorker() });
    const stats = {};
    const banded = createBandedExportBridge(bridge, bands.pool, { resident: bands.resident, stats, minPixels: 0 });
    const settings = recipe();
    const adjusted = await banded.workerApplyAdjustments16(processed, settings, 'full', { planeOnly: true });
    assert.equal(stats.residentAdjusts, 1, 'Step 3 ran on the resident bands');
    assert.ok(same(adjusted.__image16.data, referencePlane16(processed, settings).data), 'resident Step 3 == one worker');
    // Consumed: a second pass slices the plane again, with the same result.
    const again = await banded.workerApplyAdjustments16(processed, settings, 'full', { planeOnly: true });
    assert.equal(stats.bandAdjusts, 1);
    assert.ok(same(again.__image16.data, adjusted.__image16.data));
    bridge.terminateWorker();
    bands.dispose();
    assert.equal(bands.pool.available, false);
  } finally {
    bandPoolSize = 0;
    bandMinPixels = 4_000_000;
    bandPoolFactory = () => assert.fail('no band pool in this fixture');
    await Promise.all(bandThreads.map((thread) => thread.terminate()));
  }
}

// ================================== no OffscreenCanvas in the export worker
// #250 Part 3's fallback, the normal path on the macOS 10.15-12 system WebKit
// (no OffscreenCanvas encode in workers before Safari 16.4). The worker
// refuses the encode and hands back the frame, and the map's plane, it was
// given; the frame is restored (an ImageData cannot be refilled: a new one),
// the main thread's canvas encodes it, and the JPEG gain map runs on its own
// `gainMap16` request. Checked here (#229 R1-096): the canvas encodes the
// restored frame's bytes, the map equals the main-thread reference, and a
// transferred map plane is re-attached before the map's request takes it.
// The map stops with the export (R1-050): Cancel reaches it, and after a
// failed canvas encode the disposed bridge cancels it, with no fallback and
// no worker started after the export.
{
  const offscreen = globalThis.OffscreenCanvas;
  const offscreenWorker = self.onmessage;
  // The worker's own module instance, which looks for OffscreenCanvas on its
  // first encode.
  delete globalThis.OffscreenCanvas;
  await import('../workers/exportWorker.js?no-offscreen');
  const expectedFile = async (processed, settings, format) => {
    const sdr = referenceAdjusted8(processed, settings);
    const parts = [format === 'jpeg' ? 'image/jpeg|0.92|' : 'image/png|undefined|', sdr.data];
    if (format === 'jpeg') {
      const map = computeGainMap(sdr, referencePlane16(processed, settings));
      parts.push('|GAIN|', 'image/jpeg|0.85|', map.data, `|${map.gainMax}|${map.gainMin}`);
    }
    return { bytes: new Uint8Array(await new Blob(parts).arrayBuffer()), sdr };
  };
  const reset = () => {
    // The page learns "no OffscreenCanvas encode" from the worker's first
    // refusal; forget it, so each export below hands its frame over.
    bridgeModule.resetEncodeImageSupport();
    workerPosts.length = 0;
    canvasEncodes.length = 0;
    canvasImages.length = 0;
    saved.length = 0;
    released.length = 0;
  };
  try {
    for (const format of ['jpeg', 'png']) {
      const requests = format === 'jpeg' ? ['applyAdjustments', 'encodeImage', 'gainMap16'] : ['applyAdjustments', 'encodeImage'];
      const encodes = format === 'jpeg' ? ['image/jpeg', 'image/jpeg'] : ['image/png'];

      // A single export.
      let label = `no OffscreenCanvas: single ${format}8`;
      reset();
      const f = createContext();
      f.state.exportFormat = format;
      f.state.exportBitDepth = 8;
      const plane = f.state.processedImageData.__image16;
      const planeBefore = plane.data.slice();
      assert.equal((await f.context.exportSingle()).saved, true, label);
      assert.equal(bridgeModule.encodeImageSupported(), false, `${label}: the worker refused the encode`);
      assert.deepEqual(workerPosts.map((p) => p.type), requests, `${label}: requests`);
      const [adjusted] = released.at(-1);
      assert.equal(workerPosts[1].transfers[0], adjusted.data.buffer, `${label}: the adjusted frame went to the worker`);
      assert.deepEqual(canvasEncodes, encodes, `${label}: encoded on the canvas`);
      const restored = canvasImages[0];
      assert.notEqual(restored, adjusted, `${label}: the canvas encodes the frame the worker handed back`);
      assert.ok(isOwnedBuffer(restored.data.buffer), `${label}: restored as a frame this export owns`);
      let expected = await expectedFile(f.state.processedImageData, f.state.recipe, format);
      assert.ok(same(restored.data, expected.sdr.data), `${label}: the restored frame holds the adjusted pixels`);
      assert.ok(same(await stubBlobText(saved[0]), expected.bytes), `${label}: the file (SDR, and the map == the main-thread map)`);
      for (const post of workerPosts) assert.ok(!post.transfers.includes(plane.data.buffer), `${label}: ${post.type} names no editor buffer`);
      assert.ok(same(plane.data, planeBefore), `${label}: the editor's plane is intact`);
      assert.equal(bridges.at(-1).disposed, 1, `${label}: the bridge ends with the export`);
      // The next export knows: its frame never goes to the worker.
      workerPosts.length = 0;
      saved.length = 0;
      assert.equal((await f.context.exportSingle()).saved, true);
      assert.deepEqual(workerPosts.map((p) => p.type), requests.filter((type) => type !== 'encodeImage'), `${label}: not asked again`);
      assert.ok(same(await stubBlobText(saved[0]), expected.bytes), `${label}: the same file`);

      // A batch frame: every plane is the frame's own and moves.
      label = `no OffscreenCanvas: batch ${format}8`;
      reset();
      const { f: b, frames, exportInfo, jobs } = batchContext({ format, bitDepth: 8 });
      const written = [];
      assert.equal((await b.context.runBatchExport(jobs, { exportInfo, sink: async (job, blob) => { written.push(blob); } })).successCount, 1, label);
      assert.deepEqual(workerPosts.map((p) => p.type), requests, `${label}: requests`);
      assert.deepEqual(canvasEncodes, encodes, `${label}: encoded on the canvas`);
      const encode = workerPosts[1];
      assert.equal(encode.transfers.length, format === 'jpeg' ? 2 : 1, `${label}: the SDR frame${format === 'jpeg' ? ' and the map\'s plane' : ''} went to the worker`);
      expected = await expectedFile(makeProcessed(3), jobs[0].settings.recipe, format);
      assert.notEqual(canvasImages[0].data.buffer, encode.transfers[0], `${label}: the canvas encodes the frame handed back`);
      assert.ok(same(canvasImages[0].data, expected.sdr.data), `${label}: the restored frame's bytes`);
      assert.ok(same(await stubBlobText(written[0]), expected.bytes), `${label}: the file (SDR, and the map == the main-thread map)`);
      if (format === 'jpeg') {
        const [frame] = frames;
        const map = workerPosts[2];
        assert.notEqual(map.transfers[0], encode.transfers[1], `${label}: the map's request takes the plane the worker handed back`);
        assert.equal(map.transfers[0], frame.__image16.data.buffer, `${label}: re-attached to the frame's plane`);
        assert.equal(map.sizes[0], W * H * 8, `${label}: whole when the map's request took it`);
        assert.equal(frame.__image16.data.byteLength, 0, `${label}: and moved into that request`);
      } else {
        assert.equal(frames[0].__image16, null, `${label}: no plane for an 8-bit file`);
      }
      assert.equal(pools.at(-1).disposed, 1);
    }

    // The canvas encode fails while the map's pass is still in the worker:
    // the export fails, and disposing of its bridge cancels the map. Before
    // (terminateWorker), the map took that as a worker failure: it used up
    // the once-per-session warning and fell back to the plane-only pass,
    // which started a worker on the terminated bridge.
    reset();
    bridgeModule.resetWorkerFallbackWarnings();
    const failing = createContext();
    failing.state.exportFormat = 'jpeg';
    failing.context.imageDataToCanvasBlob = async () => { throw new Error('Failed to render export image.'); };
    holdNext = (message) => message.type === 'gainMap16';
    const warnings = [];
    const warn = console.warn;
    console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
    let failure = null;
    try {
      await failing.context.exportSingle();
    } catch (err) {
      failure = err;
    } finally {
      holdNext = null;
    }
    try {
      for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
    } finally {
      console.warn = warn;
    }
    assert.match(String(failure && failure.message), /Failed to render export image/, 'the export fails');
    const record = bridges.at(-1);
    assert.equal(record.disposed, 1);
    assert.deepEqual(workerPosts.map((p) => p.type), ['applyAdjustments', 'encodeImage', 'gainMap16'], 'no fallback pass for the map');
    assert.equal(workerInstances.length, record.workersAtDispose, 'no worker started after the export');
    assert.ok(workerInstances.at(-1).terminated, 'the map\'s worker is gone');
    assert.equal(record.bridge.hasWorker, false);
    assert.deepEqual(warnings.filter((text) => /gainMap16|applyAdjustments16/.test(text)), [], 'no fallback warning is used up');

    // Cancel while the map's pass runs: the export ends at once.
    reset();
    const cancelled = createContext();
    cancelled.state.exportFormat = 'jpeg';
    holdNext = (message) => {
      if (message.type !== 'gainMap16') return false;
      setImmediate(() => overlayCancel());
      return true;
    };
    let timer = null;
    let outcome;
    try {
      outcome = await Promise.race([
        cancelled.context.exportSingle(),
        new Promise((resolve) => { timer = setTimeout(() => resolve('still waiting'), 3000); })
      ]);
    } finally {
      clearTimeout(timer);
      holdNext = null;
    }
    assert.deepEqual(outcome === 'still waiting' ? outcome : { ...outcome }, { saved: false, path: null }, 'Cancel ends the export during the map\'s pass');
    assert.equal(saved.length, 0);
    assert.deepEqual(workerPosts.map((p) => p.type), ['applyAdjustments', 'encodeImage', 'gainMap16'], 'no fallback pass');
    assert.ok(workerInstances.at(-1).terminated, 'the map\'s worker is terminated');
    assert.equal(bridges.at(-1).disposed, 1);
  } finally {
    globalThis.OffscreenCanvas = offscreen;
    self.onmessage = offscreenWorker;
    bridgeModule.resetEncodeImageSupport();
    holdNext = null;
  }
}

// ============================================== batch job options (#241)
// A batch job writes with the options it started with (R1-125): quality,
// sprocket switch, edge markings and dust removal with its AI switch come
// from runBatchExport's `options`, never from the controls. Parity, old vs
// new: options captured from the controls write the bytes a batch wrote
// before (a call without options reads the controls, as every batch did);
// with the controls back at a reload's defaults, the same options still
// write those bytes, where the old live read wrote the defaults' frame.
{
  const edgeOf = (text) => ({ textEnabled: true, text, frameNumberEnabled: true, frameNumber: 3 });
  const jobDust = { enabled: true, strength: 6, maxParticleSize: 28, ai: false };
  const jobControls = { jpegQuality: 61, exportSprocketHolesEnabled: true, sprocketEdge: edgeOf('SMOKE 400'), dustRemoval: { ...jobDust } };
  const reloaded = { jpegQuality: 92, exportSprocketHolesEnabled: false, sprocketEdge: edgeOf('DEFAULT'), dustRemoval: { enabled: false, ai: true } };
  const options = { jpegQuality: 61, sprocket: true, sprocketEdge: edgeOf('SMOKE 400'), dustRemoval: { ...jobDust } };
  const run = async ({ format, bitDepth, controls, jobOptions = null }) => {
    const { f, exportInfo, jobs } = batchContext({ format, bitDepth });
    Object.assign(f.state, structuredClone(controls));
    // As main.js: the edge markings default to the live ones.
    f.context.getSprocketFrameComposeOptions = (settings, position, edge = f.state.sprocketEdge) => ({ edgeMarkings: { ...edge } });
    // The edge markings land in the frame's pixels.
    f.context.composeSprocketFrame = (image, compose) => {
      const out = new TestImageData(new Uint8ClampedArray(image.data), image.width, image.height);
      const text = JSON.stringify(compose.edgeMarkings);
      for (let i = 0; i < text.length; i++) out.data[i * 4] = text.charCodeAt(i);
      return out;
    };
    const process = f.context.processFileWithSettings;
    let dust = 'unset';
    f.context.processFileWithSettings = async (file, settings, processOptions) => {
      dust = processOptions.dustRemoval;
      return process(file, settings, processOptions);
    };
    const written = [];
    const result = await f.context.runBatchExport(jobs, { exportInfo, options: jobOptions, sink: async (job, blob) => { written.push(blob); } });
    assert.equal(result.successCount, 1);
    return { bytes: await stubBlobText(written[0]), dust };
  };
  for (const [format, bitDepth] of [['jpeg', 8], ['png', 8], ['tiff', 16]]) {
    const label = `job options ${format}${bitDepth}`;
    const before = await run({ format, bitDepth, controls: jobControls });
    const captured = await run({ format, bitDepth, controls: jobControls, jobOptions: structuredClone(options) });
    const resumed = await run({ format, bitDepth, controls: reloaded, jobOptions: structuredClone(options) });
    const liveAfterReload = await run({ format, bitDepth, controls: reloaded });
    assert.ok(same(captured.bytes, before.bytes), `${label}: a job's captured options write the bytes the live controls wrote`);
    assert.ok(same(resumed.bytes, before.bytes), `${label}: after a reload the job's options still write those bytes`);
    assert.ok(!same(liveAfterReload.bytes, before.bytes), `${label}: the old live read after a reload wrote another frame`);
    assert.equal(before.dust, null, `${label}: without options the conversion reads the live dust removal`);
    assert.deepEqual({ ...captured.dust }, jobDust, `${label}: with options it gets the job's, AI switch included`);
    assert.deepEqual({ ...resumed.dust }, jobDust);
  }
}

setLiveReferenceProbe(null);
configurePlaneRelease();
console.log('exportPlaneLifecycle.test.mjs passed');

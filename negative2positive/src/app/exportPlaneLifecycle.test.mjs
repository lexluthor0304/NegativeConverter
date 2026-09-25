// Standalone Node test for the export plane lifecycle in main.js (#250). The
// real export functions run in a vm context against the real bridge, whose
// worker is the real exportWorker.js running in-process (every message
// crosses a structured clone with its transfer list, both ways).
//
// - exportSingle creates its own bridge, terminates it exactly once after the
//   last request settled, and rejects no request; it never touches the
//   module-level bridge.
// - A 16-bit TIFF/PNG single export is one adjust16AndEncode request whose
//   bytes equal the main-thread adjust + encode; the editor's plane is copied.
// - PNG8 and JPEG (with the gain map in the same request) encode in the worker.
// - After every format, state.displayImageData carries no export plane.
// - A 1-lane batch uses a pool of one, disposes it, never the module bridge;
//   it transfers the frame's planes; a lost plane re-renders the frame once
//   with identical output; the frame's owned planes are released.
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
    workerPosts.push({ type: message.type, transfers: transfers.slice(), worker: this });
    const received = structuredClone(message, { transfer: transfers });
    if (crashNext && crashNext(message)) {
      crashNext = null;
      queueMicrotask(() => this.onerror(new Error('worker crashed')));
      return;
    }
    activeWorker = this;
    queueMicrotask(() => { if (!this.terminated) self.onmessage({ data: received }); });
  }
  terminate() { this.terminated = true; }
}
let crashNext = null;
// #256: the band pool a test installs (none by default).
let bandPoolSize = 0;
let bandMinPixels = 4_000_000;
let bandPoolFactory = () => assert.fail('no band pool in this fixture');
const { createBandedExportBridge } = await import('./bandedExportBridge.js');
const { bandThreadFactory } = await import('./bandWorkerThreads.mjs');
const { bandsSupported } = await import('../pipeline/silverBands.js');

const bridgeModule = await import('../workers/workerBridge.js');
const { markOwnedPlanes, planeBuffersOf, releaseOwnedPlanes, setLiveReferenceProbe, configurePlaneRelease } = await import('./planeRelease.js');
const { requestExportGainMap, gainMapInputsMatch } = await import('./exportGainMap.js');
const adjustment = await import('./adjustmentPipeline.js');
const encoders = await import('./exportImageEncoders.js');
const { computeGainMap } = await import('./gainMapJpeg.js');
const { runBatchPipeline, createLearningBarrier, planDecodeAhead, EXPORT_MAX_UNWRITTEN_BYTES } = await import('./batchExportScheduler.js');
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
  'encodeResidentFrame', 'createExportBands', 'convertForExportInBands', ...MEMORY_FUNCTIONS
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
    getLoadingOverlay: () => ({ show: async () => {}, updateProgress: () => {}, setCancelable: () => {}, hide: () => {} }),
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
    aiRepairReady: () => false,
    isWebGLActive: () => true,
    safeStorageGet: (key) => (key === 'nc_hdr_gain_map_v1' ? gainMap : null),
    buildAdjustmentSettings: (settings) => (settings === state ? state.recipe : settings.recipe),
    createPerfTrace: () => ({ mark() {}, end(extra) { traces.push(extra); } }),
    getImageDataPixelCount: (image) => (image ? image.width * image.height : 0),
    attachMetadataToBlob: async (blob, kind, metadata) => { attached.push({ kind, metadata: Boolean(metadata) }); return blob; },
    getExportImageEncoders: async () => encoders,
    imageDataToCanvasBlob: async (image, type, quality) => {
      canvasEncodes.push(type);
      return new Blob([`${type}|${quality}|`, new Uint8ClampedArray(image.data)], { type });
    },
    importGainMapJpeg: async () => ({
      computeGainMap,
      packGainMapJpeg: async (blob, gain, map) => new Blob([blob, '|GAIN|', gain, `|${map.gainMax}|${map.gainMin}`])
    }),
    gainMapInputsMatch, requestExportGainMap,
    ...adjustment,
    adjustmentLutScratch: adjustment.createAdjustmentLutScratch(),
    markOwnedPlanes, planeBuffersOf,
    releaseOwnedPlanes: (...items) => { released.push(items); return releaseOwnedPlanes(...items); },
    isExportInputLostError: bridgeModule.isExportInputLostError,
    isConversionInputLost: (err) => Boolean(err) && err.code === 'INPUT_LOST',
    defaultExportWorkers: guardedDefault,
    createExportWorkerBridge: () => {
      const bridge = bridgeModule.createExportWorkerBridge({ workerFactory: () => new InProcessWorker() });
      const record = { bridge, terminated: 0, pendingAtTerminate: [], rejected: 0 };
      const spied = {};
      for (const [key, value] of Object.entries(bridge)) {
        if (typeof value !== 'function') continue;
        spied[key] = (...args) => {
          if (key === 'terminateWorker') {
            record.terminated++;
            record.pendingAtTerminate.push(bridge.pendingCount);
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
      decodeAhead: { admitted: 0, refused: { ceiling: 0, 'low-memory': 0, hidden: 0, format: 0 } } },
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
const pools = [];

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
  assert.equal(record.terminated, 1, `${label}: the per-export bridge is terminated exactly once`);
  assert.deepEqual(record.pendingAtTerminate, [0], `${label}: after its last request settled`);
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
    assert.equal(bridges.at(-1).terminated, 1);
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
  assert.equal(bridges.at(-1).terminated, 1);
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
    assert.equal(bridges.at(-1).terminated, 1);
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
  // learning frame's write. 'serial' turns the stages off.
  const run = async (mode, { budgetBytes = null } = {}) => {
    const { f, exportInfo } = batchContext({ format: 'png', bitDepth: 8 });
    const log = [];
    const decoded = [];
    f.context.safeStorageGet = (key) => (key === 'nc_batch_pipeline_v1' ? mode : null);
    f.context.state.rollReference = { applyLock: false };
    if (budgetBytes !== null) f.context.memoryBudget.setBudget(budgetBytes);
    f.context.loadFileToImageData = async (file, options) => {
      assert.ok(options.signal instanceof AbortSignal, 'a prepared decode can be aborted');
      assert.equal(options.filmStats, !fileSettings.get(file.name), 'the options the lane would decode with');
      // Admitted at once against the memory budget's ceiling (#258); the
      // decode reserves nothing a lane could be waiting on.
      assert.equal(options.claim?.fixed, true, 'a prepared decode takes no reservation of its own');
      log.push(`decode-ahead:${file.name}`);
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
        options.onBaseReady?.();
      }
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
      sink: async (job, blob) => {
        written.push(job.file.name);
        log.push(`written:${job.file.name}`);
        const learned = job.item.touchedKeys.size
          ? new Promise((resolve) => setTimeout(() => { learnedAt = log.length; log.push(`learned:${job.file.name}`); resolve(); }, 5))
          : Promise.resolve();
        return { learned };
      }
    });
    assert.equal(result.successCount, 4);
    assert.deepEqual(written, names, 'written in order');
    return { log, diagnostics: f.context.batchPipelineDiagnostics };
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

setLiveReferenceProbe(null);
configurePlaneRelease();
console.log('exportPlaneLifecycle.test.mjs passed');

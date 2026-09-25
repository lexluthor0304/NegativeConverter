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

const bridgeModule = await import('../workers/workerBridge.js');
const { markOwnedPlanes, planeBuffersOf, releaseOwnedPlanes, setLiveReferenceProbe, configurePlaneRelease } = await import('./planeRelease.js');
const { requestExportGainMap, gainMapInputsMatch } = await import('./exportGainMap.js');
const adjustment = await import('./adjustmentPipeline.js');
const encoders = await import('./exportImageEncoders.js');
const { computeGainMap } = await import('./gainMapJpeg.js');
const { runBatchPipeline } = await import('./batchExportScheduler.js');
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
  'imageDataToBlob', 'createBatchExportWorkers', 'renderBatchExportFile', 'runBatchExport'
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
    currentFileIndex: 0, fileQueue: [], lastRenderQuality: 'gl', dustRemoval: { enabled: false }, repairStrokes: [],
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
    setTimeout: (fn) => setImmediate(fn),
    manualEditRevision: 0,
    i18n: { en: { loadingExporting: 'e', loadingAdjusting: 'a', loadingEncoding: 'n', loadingComplete: 'c' } },
    currentLang: 'en',
    processNegativeInFlight: null,
    getCurrentQueueItem: () => null,
    buildActiveExportFileName: () => 'frame.out',
    isTauriDesktop: () => false,
    notifyReviewExport: () => {},
    getLoadingOverlay: () => ({ show: async () => {}, updateProgress: () => {}, hide: () => {} }),
    persistCurrentFileSettings: () => {},
    exportMetadataFor: () => ({ exif: { Make: 'Test' }, xmp: null }),
    saveBlob: async (blob) => { saved.push(blob); return { saved: true }; },
    learnFromExport: async () => {},
    ensureFullResolutionReadyForExport: async () => {},
    aiRepairReady: () => false,
    isDisplayImageDataFullResolution: () => Boolean(state.displayImageData && state.displayImageData.width === W),
    isWebGLActive: () => true,
    ensureFullRender: () => {},
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
    planBatchExportLanes: async () => 1,
    runBatchPipeline,
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

{
  // The CPU display path: the export reads the display buffer; it is copied
  // (never transferred) and gets no export plane attached.
  for (const [format, bitDepth] of [['jpeg', 8], ['png', 8], ['tiff', 16]]) {
    const f = createContext();
    f.state.exportFormat = format;
    f.state.exportBitDepth = bitDepth;
    const display = referenceAdjusted8(f.state.processedImageData, f.state.recipe);
    f.state.displayImageData = display;
    f.state.lastRenderQuality = 'full';
    const displayBytes = display.data.slice();
    workerPosts.length = 0;
    await f.context.exportSingle();
    for (const post of workerPosts) assert.ok(!post.transfers.includes(display.data.buffer), 'a copy of the display buffer, never the buffer');
    assert.equal(display.data.length, W * H * 4, `${format}${bitDepth}: the display buffer is never transferred`);
    assert.ok(same(display.data, displayBytes));
    for (const key of ['__image16', '__gainMap', '__gainMapSource']) {
      assert.equal(display[key], undefined, `${format}${bitDepth}: state.displayImageData carries no ${key}`);
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
  assert.equal(frame.__image16.data.byteLength, 0, `${label}: the frame's plane moved to the worker`);
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

setLiveReferenceProbe(null);
configurePlaneRelease();
console.log('exportPlaneLifecycle.test.mjs passed');

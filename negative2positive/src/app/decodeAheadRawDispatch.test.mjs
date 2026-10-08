import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createMemoryBudget } from './memoryBudget.js';
import { planDecodeAhead } from './batchExportScheduler.js';
import { estimateRawDecodeBytes } from './rawDecodeEstimate.js';
import { createEmbeddedPreviewSource } from './nefJpegPreview.js';
import { makeRawResult } from './rawPostDecode.fixtures.mjs';
import { handleRawPostDecodeMessage } from './rawPostDecode.js';
import { startRawPostDecode } from './rawPostDecodeClient.js';
import { createLibRaw, resetLibRawRuntime } from './librawRuntime.js';
import { createNativeLibRaw } from './nativeRawDecoder.js';
import { markDerivedEightBit } from './crossOriginIsolation.js';

const baseline = process.env.NC229_ADMISSION_BASELINE;
const read = name => baseline
  ? execFileSync('git', ['show', `${baseline}:negative2positive/src/app/${name}`], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  : readFileSync(new URL(name, import.meta.url), 'utf8');
const main = read('main.js');
const rawSource = read('rawFileLoader.js').replace(/^import .*\n/gm, '')
  .replace(/^export \{[^\n]*\n/gm, '').replace(/\bexport (?=(async )?function)/g, '');
function fn(name) {
  const start = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(main)?.index;
  assert.notEqual(start, undefined, name);
  return main.slice(start, main.indexOf('\n    }\n', start) + 6);
}
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
const watchdog = setTimeout(() => { console.error('RAW dispatch test timed out'); process.exit(1); }, 10000);
watchdog.unref();
globalThis.ImageData ||= class ImageData {
  constructor(data, width, height) { Object.assign(this, { data, width, height }); }
};
let scene;
globalThis.Worker = class Worker {
  constructor() { this.stops = 0; scene.workers.push(this); scene.postCreated.resolve(this); }
  terminate() { this.stops++; }
  postMessage(message, transfer = []) {
    if (message.type === 'ping') {
      if (!scene.holdPost) queueMicrotask(() => this.onmessage?.({ data: { type: 'pong' } }));
      return;
    }
    scene.starts.push({ kind: 'post', foreground: scene.budget.foregroundOutstanding, reserved: scene.budget.reserved });
    const moved = structuredClone(message, { transfer });
    queueMicrotask(() => handleRawPostDecodeMessage(moved, data => this.onmessage?.({ data })));
  }
};

function fixture(boundary) {
  const f = { budget: createMemoryBudget({ budgetBytes: 1e9 }), factory: defer(), created: defer(),
    slot: defer(), slotWaiting: defer(), postCreated: defer(), demosaic: defer(), starts: [], workers: [], rawReleases: 0, slotReleases: 0 };
  scene = f; f.holdPost = boundary === 'post-ready';
  const raw = {
    open: async bytes => { structuredClone(bytes, { transfer: [bytes.buffer] }); },
    metadata: async () => ({ width: 4, height: 4 }),
    imageData: async () => {
      f.starts.push({ kind: 'raw', foreground: f.budget.foregroundOutstanding, reserved: f.budget.reserved });
      f.demosaic.resolve();
      return makeRawResult({ width: 4, height: 4, seed: 21, channels: 3, bits: 16 });
    },
    dispose() { f.rawReleases++; }
  };
  const rawContext = vm.createContext({
    console: { info() {}, warn() {}, error() {} }, setTimeout, clearTimeout, DOMException,
    Uint8Array, Uint16Array, Uint8ClampedArray, ArrayBuffer, ImageData, estimateRawDecodeBytes, markDerivedEightBit,
    isIPhoneDngHeader: () => false, createEmbeddedPreviewSource, startRawPostDecode,
    createRawDecoder: async (_factory, options) => {
      f.created.resolve(); await f.factory.promise;
      if (boundary !== 'threaded') return raw;
      resetLibRawRuntime();
      class Threaded {
        static features = { threads: true };
        runtimeInfo = async () => ({});
        open = raw.open;
        metadata = raw.metadata;
        imageData = raw.imageData;
        dispose = raw.dispose;
      }
      return createLibRaw({ LibRawClass: Threaded, beforeDecode: options.beforeDecode,
        env: { crossOriginIsolated: true, SharedArrayBuffer, navigator: { hardwareConcurrency: 8 } } }).raw;
    }
  });
  vm.runInContext(rawSource, rawContext);
  const c = vm.createContext({
    AbortController, DOMException, memoryBudget: f.budget, planDecodeAhead, estimateRawDecodeBytes,
    heldJobFrames: new Set(), navigator: { deviceMemory: 16 }, memoryRuntime: { engine: 'webview2' },
    hiddenJobs: { status: () => ({ hidden: false }) }, hiddenResidentBytes: () => 0,
    isTauriDesktop: () => true, backgroundGate: { idle: async () => {} }, BACKGROUND_STEP_WAIT_CAP_MS: 2000,
    imagePixelsForBatch: async () => 16, isRawLikeFileName: () => true, isPngFile: () => false,
    markOwnedPlanes: value => value, releaseOwnedPlanes: value => { value.released = true; }, DECODED_BYTES_PER_PIXEL: 12,
    sharedPlanesAvailable: () => false, rememberImageDimensions() {},
    loadRawImageData: (buffer, name, options) => rawContext.loadRawFile(buffer, name, {
      ...options, suppressSensorDefects: false,
      ...(boundary === 'slot' ? { decodeSlot: { acquire: async () => {
        f.slotWaiting.resolve(); await f.slot.promise; return () => { f.slotReleases++; };
      } } } : {})
    }),
    batchPipelineDiagnostics: { decodeAhead: { admitted: 0, refused: { ceiling: 0, foreground: 0 }, lastEstimate: 0 } }
  });
  vm.runInContext(['decodePeakBytes', 'decodeReservationBytes', 'loadFileToImageData', 'batchDecodeAhead'].map(fn).join('\n'), c);
  const ahead = c.batchDecodeAhead('default', { pixelsPerFile: 16 }), controller = new AbortController();
  const job = { file: new File([new Uint8Array(32)], 'frame.dng'), settings: {} };
  Object.assign(f, { ahead, controller, c });
  f.start = async () => {
    assert.equal(await ahead.admitPrepare({ job, prepared: [], unwrittenBytes: 0, processing: 0 }), true);
    const pending = ahead.prepare(job, { signal: controller.signal, stage() {} });
    pending.catch(() => {}); await f.created.promise; return { pending };
  };
  return f;
}

for (const boundary of ['factory', 'slot', 'post-ready', 'threaded']) for (const abort of [false, true]) {
  const f = fixture(boundary), { pending } = await f.start();
  if (boundary !== 'factory') {
    f.factory.resolve();
    if (boundary === 'slot') await f.slotWaiting.promise;
    else if (boundary === 'post-ready') { await f.demosaic.promise; await tick(); }
    else await tick();
  }
  // The threaded wrapper also waits after its caller's metadata gate. Its
  // standalone readiness test below isolates that deferred dispatch.
  if (boundary === 'threaded') {
    const base = await pending;
    assert.ok(f.starts.every(start => start.foreground === 0 && start.reserved >= estimateRawDecodeBytes(4, 4)));
    f.ahead.disposePrepared(base); assert.equal(f.budget.idle, true); continue;
  }
  const foreground = await f.budget.reserve(100, { priority: 'foreground' });
  f.factory.resolve(); f.slot.resolve();
  if (boundary === 'post-ready') f.workers[0].onmessage({ data: { type: 'pong' } });
  await tick();
  console.log(`RAW ${boundary}:`, JSON.stringify(f.starts));
  assert.equal(f.starts.filter(start => start.kind === (boundary === 'post-ready' ? 'post' : 'raw')).length, 0,
    `${boundary}: actual RAW dispatch waits for foreground`);
  if (abort) { f.controller.abort(); await assert.rejects(pending, { name: 'AbortError' }); }
  foreground.release(); await tick();
  if (!abort) {
    const base = await pending;
    assert.ok(f.starts.every(start => start.foreground === 0 && start.reserved === estimateRawDecodeBytes(4, 4)));
    assert.equal(f.starts.filter(start => start.kind === 'raw').length, 1);
    assert.equal(f.starts.filter(start => start.kind === 'post').length, 1);
    assert.equal(f.c.heldJobFrames.has(base), true); f.ahead.disposePrepared(base);
  }
  assert.equal(f.budget.idle, true);
  assert.equal(f.rawReleases, 1);
  assert.ok(f.workers.every(worker => worker.stops === 1));
  if (boundary === 'slot') assert.equal(f.slotReleases, 1);
}

// Actual threaded wrapper: demosaic readiness and a failed threaded startup's
// single-thread retry both recheck admission before imageData dispatch.
for (const retry of [false, true]) {
  resetLibRawRuntime();
  const ready = defer(), granted = defer(), starts = [];
  let released = 0;
  class Decoder {
    static features = { threads: true };
    constructor(options) { this.threaded = Boolean(options); }
    runtimeInfo() { return ready.promise.then(() => { if (retry && this.threaded) throw Error('startup failed'); }); }
    imageData() { starts.push(this.threaded); return { width: 4, height: 4 }; }
    dispose() { released++; }
  }
  const { raw } = createLibRaw({ LibRawClass: Decoder, beforeDecode: () => granted.promise,
    env: { crossOriginIsolated: true, SharedArrayBuffer } });
  const pending = raw.imageData(); ready.resolve(); await tick();
  assert.equal(starts.length, 0, 'threaded readiness or retry cannot bypass admission');
  granted.resolve(); assert.equal((await pending).width, 4); assert.deepEqual(starts, [!retry]);
  raw.dispose(); assert.equal(released, retry ? 2 : 1);
}

// Native process failure waits for a lazy WASM factory/open retry. A new
// foreground must hold back its real imageData call, and gate rejection is
// never classified as native unavailability.
for (const denied of [false, true]) {
  const opening = defer(), grant = defer(), started = defer(), error = Error('Native retry admission denied');
  let gates = 0, decodes = 0, closed = 0, wasmDisposed = 0;
  const raw = createNativeLibRaw({
    core: { invoke: async command => {
      if (command === 'native_raw_begin') return 'tiny-native-session';
      if (command === 'native_raw_open') return { status: 'ok', metadata: { width: 4, height: 4 } };
      if (command === 'native_raw_process') throw Error('IPC lost');
    } },
    openPlaneReader: () => ({ close() { closed++; } }),
    createWasm: () => ({ open: async () => { started.resolve(); await opening.promise; },
      imageData: async () => { decodes++; return { width: 4, height: 4 }; }, dispose() { wasmDisposed++; } }),
    beforeDecode: async () => { if (++gates >= 3) { await grant.promise; if (denied) throw error; } }
  });
  await raw.open(new Uint8Array(32), { noInterpolation: false, useAutoWb: true, useCameraWb: true,
    useCameraMatrix: 3, outputColor: 1, halfSize: false, outputBps: 16 });
  const pending = raw.imageData(); pending.catch(() => {}); await started.promise;
  opening.resolve(); await tick(); assert.equal(decodes, 0);
  grant.resolve();
  if (denied) await assert.rejects(pending, candidate => candidate === error);
  else assert.equal((await pending).width, 4);
  assert.equal(decodes, denied ? 0 : 1);
  raw.dispose(); assert.ok(closed >= 1); assert.equal(wasmDisposed, 1);
}
clearTimeout(watchdog);
console.log('decodeAheadRawDispatch: actual RAW factory/slot/post readiness, threaded and native retry admission, abort and release passed');

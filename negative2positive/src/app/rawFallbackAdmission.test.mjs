import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createMemoryBudget } from './memoryBudget.js';
import { planDecodeAhead } from './batchExportScheduler.js';
import { estimateRawDecodeBytes } from './rawDecodeEstimate.js';
import { createEmbeddedPreviewSource, decodeNefPreviewJpeg, tryNefJpegPreview } from './nefJpegPreview.js';
import { fromImageData8 } from '../silvercore/util/image16.js';
import { decodeJpegInWorker } from './scanDecodeClient.js';

globalThis.ImageData ||= class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};

const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const rawSource = readFileSync(new URL('./rawFileLoader.js', import.meta.url), 'utf8')
  .replace(/^import .*\n/gm, '').replace(/^export \{[^\n]*\n/gm, '').replace(/\bexport (?=(async )?function)/g, '');
function fn(name) {
  const start = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(main)?.index;
  assert.notEqual(start, undefined, name);
  return main.slice(start, main.indexOf('\n    }\n', start) + 6);
}
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
// Real extraction, with a minimum-size usable preview header in a tiny RAW
// container. Only the decoder/worker boundary is simulated (no LibRaw heap).
const width = 1000, height = 300;
function container() {
  const bytes = new Uint8Array(128);
  bytes.set([255, 216, 255, 192, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255,
    3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 255, 217], 32);
  return bytes.buffer;
}
const image = () => ({ width, height, data: new Uint8ClampedArray(width * height * 4) });

function fixture(route = 'open-timeout', { retry = false, fails = false, workerStartup = false } = {}) {
  const reading = defer(), read = defer(), decoded = defer(), starting = defer(), ready = defer();
  const starts = [], workers = [];
  const budget = createMemoryBudget({ budgetBytes: 1e9 });
  let reads = 0, retryForeground = null, released = 0;
  const file = { name: route === 'iiq' ? 'frame.iiq' : 'frame.dng', arrayBuffer: async () => {
    if (++reads === 1 && route !== 'iiq') return container();
    reading.resolve(); await read.promise; return container();
  } };
  const timeout = () => Object.assign(Error('LibRaw timed out'), { code: 'RAW_DECODE_TIMEOUT' });
  const raw = { disposed: false,
    open: async bytes => {
      structuredClone(bytes, { transfer: [bytes.buffer] });
      if (route === 'open-timeout') throw timeout();
    },
    metadata: async () => ({ width: 4, height: 4 }),
    imageData: async () => {
      if (route === 'image-timeout') throw timeout();
      if (route === 'empty') return null;
      return { width: 4, height: 4, data: new Uint16Array(48) };
    },
    dispose() { this.disposed = true; }
  };
  const post = { disposed: false,
    run: async () => {
      if (route === 'lost') throw Object.assign(Error('Worker lost pixels'), { code: 'RAW_POST_DECODE_LOST' });
      return { garbled: true };
    },
    terminate() { this.disposed = true; }
  };
  workers.push(raw, post);
  const rawContext = vm.createContext({
    console: { info() {}, warn() {}, error() {} }, setTimeout, clearTimeout, DOMException,
    Uint8Array, Uint16Array, Uint8ClampedArray, ArrayBuffer,
    RAW_SIZE_HEAVY: route === 'iiq' ? 1 : 100e6, isIPhoneDngHeader: () => false, estimateRawDecodeBytes, fromImageData8,
    createRawDecoder: async () => raw, startRawPostDecode: () => post, createEmbeddedPreviewSource, tryNefJpegPreview,
    decodeNefPreviewJpeg: (preview, options) => decodeNefPreviewJpeg(preview, { ...options,
      decodeInWorker: async (extracted, workerOptions) => {
        if (workerStartup) return decodeJpegInWorker(extracted, { ...workerOptions, workerFactory: () => {
          const worker = {
            disposed: false,
            terminate() { this.disposed = true; },
            postMessage(message, transfer) {
              structuredClone(message, { transfer });
              starts.push({ kind: 'worker', foreground: budget.foregroundOutstanding, reserved: budget.reserved });
              decoded.promise.then(() => { if (!worker.disposed) worker.onmessage?.({ data: { id: 1, width, height,
                data: new Uint8ClampedArray(width * height * 4).buffer, image16: new Uint16Array(width * height * 4).buffer } }); });
            }
          };
          workers.push(worker); starting.resolve();
          ready.promise.then(() => { if (!worker.disposed) worker.onmessage?.({ data: { ready: true, canDecodeImages: true } }); });
          return worker;
        } });
        starts.push({ kind: 'worker', foreground: budget.foregroundOutstanding, reserved: budget.reserved });
        if (retry) { retryForeground = await budget.reserve(100, { priority: 'foreground' }); return null; }
        await decoded.promise;
        if (fails) throw new DOMException('Preview failed', 'AbortError');
        return image();
      }
    })
  });
  vm.runInContext(rawSource, rawContext);
  const c = vm.createContext({
    AbortController, DOMException, memoryBudget: budget, planDecodeAhead, estimateRawDecodeBytes,
    heldJobFrames: new Set(), navigator: { deviceMemory: 16 }, memoryRuntime: { engine: 'webview2' },
    hiddenJobs: { status: () => ({ hidden: false }) }, hiddenResidentBytes: () => 0,
    isTauriDesktop: () => true, backgroundGate: { idle: async () => {} }, BACKGROUND_STEP_WAIT_CAP_MS: 2000,
    imagePixelsForBatch: async () => 16, isRawLikeFileName: () => true, isPngFile: () => false,
    markOwnedPlanes: value => value, releaseOwnedPlanes: () => { released++; }, DECODED_BYTES_PER_PIXEL: 12,
    defaultFilmBaseBuffer: () => 10, sharedPlanesAvailable: () => false, rememberImageDimensions() {},
    loadRawImageData: (...args) => rawContext.loadRawFile(...args),
    batchPipelineDiagnostics: { decodeAhead: { admitted: 0, refused: { ceiling: 0, foreground: 0 }, lastEstimate: 0 } }
  });
  vm.runInContext(['decodePeakBytes', 'decodeReservationBytes', 'loadFileToImageData', 'batchDecodeAhead', 'rememberShotMetadata'].map(fn).join('\n'), c);
  // Every decode records the photo's focal length and aperture (#278).
  c.shotMetadataByFile = new WeakMap();
  const ahead = c.batchDecodeAhead('default', { pixelsPerFile: 16 });
  const job = { file, settings: {} }, controller = new AbortController();
  globalThis.createImageBitmap = async () => {
    starts.push({ kind: 'browser', foreground: budget.foregroundOutstanding, reserved: budget.reserved });
    await decoded.promise; return { width, height, close() {} };
  };
  globalThis.document = { createElement: () => ({ getContext: () => ({ drawImage() {}, getImageData: image }) }) };
  const start = async () => {
    assert.equal(await ahead.admitPrepare({ job, prepared: [], unwrittenBytes: 0, processing: 0 }), true);
    const pending = ahead.prepare(job, { signal: controller.signal, stage() {} });
    pending.catch(() => {});
    await reading.promise;
    return { pending };
  };
  return { start, c, budget, reading, read, decoded, starting, ready, starts, ahead, controller, workers,
    retryForeground: () => retryForeground, released: () => released };
}
for (const abort of [false, true]) {
  const f = fixture('open-timeout', { workerStartup: true }), { pending } = await f.start();
  f.read.resolve(); await f.starting.promise;
  const foreground = await f.budget.reserve(100, { priority: 'foreground' });
  f.ready.resolve(); await tick();
  assert.equal(f.starts.length, 0, 'actual scan-worker startup cannot bypass foreground ownership');
  if (abort) {
    f.controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  }
  foreground.release(); await tick();
  if (!abort) {
    assert.equal(f.starts.length, 1);
    assert.equal(f.starts[0].foreground, 0);
    assert.equal(f.starts[0].reserved, width * height * 12);
    f.decoded.resolve(); f.ahead.disposePrepared(await pending);
  } else assert.equal(f.starts.length, 0, 'aborted worker gate never transfers input');
  assert.equal(f.budget.idle, true);
  assert.ok(f.workers.every(worker => worker.disposed));
}

for (const route of ['open-timeout', 'image-timeout', 'empty', 'lost', 'garbled']) {
  const f = fixture(route), { pending } = await f.start();
  const foreground = await f.budget.reserve(100, { priority: 'foreground' });
  f.read.resolve(); await tick();
  assert.equal(f.starts.length, 0, `${route}: no preview dispatch during foreground ownership`);
  foreground.release(); await tick();
  assert.equal(f.starts.length, 1, `${route}: exactly one preview decode`);
  assert.equal(f.starts[0].foreground, 0);
  assert.equal(f.starts[0].reserved, width * height * 12, 'the extracted preview size owns a counted prepare');
  f.decoded.resolve(); const base = await pending;
  assert.ok(base.__image16, 'existing preview promotion is retained');
  assert.equal(f.c.heldJobFrames.has(base), true);
  assert.equal(f.budget.idle, true, 'claim transfers to the held frame ledger');
  f.ahead.disposePrepared(base);
  assert.equal(f.c.heldJobFrames.size, 0); assert.equal(f.released(), 1);
  assert.ok(f.workers.every(worker => worker.disposed));
}
{
  const f = fixture('iiq'), { pending } = await f.start();
  const foreground = await f.budget.reserve(100, { priority: 'foreground' });
  f.read.resolve(); await tick();
  assert.equal(f.starts.length, 0, 'the IIQ shortcut uses the same preview admission');
  foreground.release(); await tick();
  assert.equal(f.starts.length, 1); assert.equal(f.starts[0].kind, 'browser');
  assert.equal(f.starts[0].foreground, 0); assert.equal(f.starts[0].reserved, width * height * 12);
  f.decoded.resolve(); f.ahead.disposePrepared(await pending);
  assert.equal(f.budget.idle, true);
}
{
  const f = fixture('open-timeout', { retry: true }), { pending } = await f.start();
  f.read.resolve(); await tick();
  assert.deepEqual(f.starts.map(s => s.kind), ['worker'], 'browser retry rechecks foreground ownership');
  f.retryForeground().release(); await tick();
  assert.deepEqual(f.starts.map(s => s.kind), ['worker', 'browser']);
  assert.equal(f.starts[1].foreground, 0);
  assert.equal(f.starts[1].reserved, width * height * 12);
  f.decoded.resolve(); f.ahead.disposePrepared(await pending);
  assert.equal(f.budget.idle, true);
}
for (const boundary of ['read', 'gate', 'decode']) {
  const f = fixture(), { pending } = await f.start();
  const foreground = boundary === 'gate' ? await f.budget.reserve(100, { priority: 'foreground' }) : null;
  if (boundary !== 'read') { f.read.resolve(); await tick(); }
  f.controller.abort(); f.read.resolve(); f.decoded.resolve();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(f.starts.length, boundary === 'decode' ? 1 : 0, `${boundary}: no subsequent decode`);
  foreground?.release(); assert.equal(f.budget.idle, true);
  assert.equal(f.c.heldJobFrames.size, 0);
  assert.ok(f.workers.every(worker => worker.disposed));
}
{
  const f = fixture('open-timeout', { fails: true }), { pending } = await f.start();
  f.read.resolve(); await tick(); f.decoded.resolve();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(f.budget.idle, true, 'preview failure releases prepare memory');
}
{
  const error = Error('Memory admission denied'), preview = { jpegBytes: new Uint8Array(container()), width, height };
  let calls = 0, posted = false, stopped = false;
  const worker = { terminate() { stopped = true; }, postMessage() { posted = true; } };
  await assert.rejects(decodeNefPreviewJpeg(preview, {
    reserveDecode: () => { if (++calls === 2) throw error; },
    decodeInWorker: (input, options) => decodeJpegInWorker(input, { ...options, workerFactory: () => {
      queueMicrotask(() => worker.onmessage?.({ data: { ready: true, canDecodeImages: true } })); return worker;
    } })
  }), candidate => candidate === error, 'a rejected worker admission cannot turn into a browser retry');
  assert.equal(calls, 2); assert.equal(posted, false); assert.equal(stopped, true);
}
console.log('rawFallbackAdmission: actual timeout/empty/lost/garbled loader fallback, retry, ownership and abort cleanup passed');

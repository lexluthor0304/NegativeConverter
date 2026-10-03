import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createMemoryBudget } from './memoryBudget.js';
import { planDecodeAhead } from './batchExportScheduler.js';
import { estimateRawDecodeBytes } from './rawDecodeEstimate.js';
import * as pako from 'pako';
import UPNG from 'upng-js';
import UTIF from 'utif';
import { encodePng16Blob, encodeTiffBlob } from '../workers/imageEncoders.js';
import { loadPngFile } from './pngFileLoader.js';
import { decodeTiffBuffer } from './tiffFileLoader.js';

const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function fn(name) {
  const start = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(main)?.index;
  assert.notEqual(start, undefined, name);
  return main.slice(start, main.indexOf('\n    }\n', start) + 6);
}
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
globalThis.ImageData ||= class ImageData {
  constructor(data, width, height) { Object.assign(this, { data, width, height }); }
};
let scene;
const watchdog = setTimeout(() => {
  console.error('Loader test timed out', { starts: scene?.starts, budget: scene?.budget.snapshot() });
  process.exit(1);
}, 10000);
watchdog.unref();
globalThis.Worker = class Worker {
  constructor(url) {
    this.stops = 0; scene.workers.push(this); scene.created.resolve(this);
    scene.onFactory?.();
    if (/heif-worker/.test(String(url))) queueMicrotask(() => this.onmessage?.({ data: { ready: true } }));
  }
  postMessage(message, transfer = []) {
    scene.starts.push({ kind: 'worker', foreground: scene.budget.foregroundOutstanding, reserved: scene.budget.reserved });
    this.message = structuredClone(message, { transfer });
  }
  reply() {
    scene.inWorker = true;
    let image;
    try { image = this.message.format === 'tiff' ? decodeTiffBuffer(this.message.buffer) : loadPngFile(this.message.buffer); }
    finally { scene.inWorker = false; }
    this.onmessage({ data: { width: image.width, height: image.height, data: image.data, image16: image.__image16 } });
  }
  terminate() { this.stops++; }
};
const { loadPngImageData, loadStandardImage, isPngFile, isRawLikeFileName } = await import('./imageFileLoaders.js');
const { loadRawFile } = await import('./rawFileLoader.js');
const { decodeHeifInWorker } = await import('./heifLoader.js');
const pixels = new Uint16Array(64);
for (let i = 0; i < pixels.length; i++) pixels[i] = i % 4 === 3 ? 65535 : 0x1234 + i;
const buffers = {
  png16: await encodePng16Blob(pixels, 4, 4, pako).arrayBuffer(),
  tiff: await encodeTiffBlob(pixels, 4, 4, 16).arrayBuffer(),
  png8: UPNG.encode([new Uint8Array(Array.from(pixels, value => value >>> 8)).buffer], 4, 4, 0),
  jpeg: new Uint8Array([255, 216, 255, 0]).buffer,
  heif: new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112, 104, 101, 105, 99, 0, 0, 0, 0]).buffer
};
const noteStart = kind => scene.starts.push({ kind, foreground: scene.budget.foregroundOutstanding, reserved: scene.budget.reserved });
for (const [codec, label] of [[UPNG, 'upng'], [UTIF, 'utif']]) {
  const decode = codec.decode;
  codec.decode = Object.assign(function (...args) { if (!scene?.inWorker) noteStart(label); return decode.apply(this, args); }, decode);
}

globalThis.document = { createElement: () => ({ getContext: () => ({ drawImage() { scene.readbacks++; },
  getImageData: () => new ImageData(new Uint8ClampedArray(64).fill(17), 4, 4) }) }) };
globalThis.createImageBitmap = async () => {
  noteStart('bitmap');
  if (scene.bitmapFails) { scene.bitmapFailed.resolve(); throw Error('unsupported bitmap'); }
  if (scene.bitmapWait) await scene.bitmapWait.promise;
  return { width: 4, height: 4, close() { scene.closed++; } };
};
globalThis.Image = class {
  constructor() { scene.nativeCreated.resolve(this); scene.onImageFactory?.(); }
  set src(url) {
    if (!url) return;
    noteStart('image');
    this.width = this.height = 4;
    if (scene.imageFails) queueMicrotask(() => this.onerror?.());
    else if (!scene.imageWait) queueMicrotask(() => this.onload?.());
  }
};

function fixture(route = 'png16') {
  const bytes = buffers[route === 'renamed-png' ? 'png16' : route === 'standard' ? 'jpeg' : route];
  const file = new File([bytes], ['tiff', 'renamed-png', 'standard', 'heif'].includes(route) ? 'scan.tif' : 'scan.png',
    { type: route.startsWith('png') ? 'image/png' : '' });
  const f = { budget: createMemoryBudget({ budgetBytes: 1e9 }), created: defer(), workers: [], starts: [],
    nativeCreated: defer(), bitmapFailed: defer(), closed: 0, readbacks: 0, reservations: [] };
  const reserve = f.budget.tryReserve;
  f.budget.tryReserve = (...args) => {
    const handle = reserve(...args);
    if (handle) {
      const record = { bytes: handle.bytes, releases: 0 }, release = handle.release;
      f.reservations.push(record);
      handle.release = () => { record.releases++; release(); };
    }
    return handle;
  };
  scene = f;
  const c = vm.createContext({
    AbortController, DOMException, planDecodeAhead, memoryBudget: f.budget, heldJobFrames: new Set(),
    navigator: { deviceMemory: 16 }, memoryRuntime: { engine: 'webview2' },
    hiddenJobs: { status: () => ({ hidden: false }) }, hiddenResidentBytes: () => 0,
    isTauriDesktop: () => true, backgroundGate: { idle: async () => {} }, BACKGROUND_STEP_WAIT_CAP_MS: 2000,
    imagePixelsForBatch: async () => 16, isRawLikeFileName, isPngFile,
    markOwnedPlanes: value => value, releaseOwnedPlanes: value => { value.released = true; },
    DECODED_BYTES_PER_PIXEL: 12, estimateRawDecodeBytes, loadPngImageData, loadStandardImage,
    loadRawImageData: loadRawFile, sharedPlanesAvailable: () => false, rememberImageDimensions() {},
    batchPipelineDiagnostics: { decodeAhead: { admitted: 0, refused: { ceiling: 0, foreground: 0, format: 0 }, lastEstimate: 0 } }
  });
  vm.runInContext(['decodePeakBytes', 'decodeReservationBytes', 'loadFileToImageData', 'batchDecodeAhead'].map(fn).join('\n'), c);
  const ahead = c.batchDecodeAhead('default', { pixelsPerFile: 16 });
  const job = { file, settings: {} }, controller = new AbortController();
  Object.assign(f, { c, ahead, job, controller });
  f.start = async () => {
    assert.equal(await ahead.admitPrepare({ job, prepared: [], unwrittenBytes: 0, processing: 0 }), true);
    const pending = ahead.prepare(job, { signal: controller.signal, stage() {} });
    pending.catch(() => {});
    return { pending };
  };
  f.cleanup = base => {
    if (base) ahead.disposePrepared(base);
    assert.equal(c.heldJobFrames.size, 0);
    assert.equal(f.budget.idle, true);
    assert.ok(f.workers.every(worker => worker.stops === 1), 'every disposable worker terminates exactly once');
    assert.ok(f.reservations.every(record => record.releases === 1), 'every prepare claim releases exactly once');
  };
  return f;
}

for (const route of ['png16', 'tiff', 'renamed-png']) for (const boundary of ['factory', 'ready']) {
  const f = fixture(route);
  let foreground;
  // Foreground claims are unqueued; construct one inside the worker factory.
  if (boundary === 'factory') f.onFactory = () => { void f.budget.reserve(100, { priority: 'foreground' }).then(handle => { foreground = handle; }); };
  const { pending } = await f.start();
  const worker = await f.created.promise;
  await tick();
  if (boundary === 'ready') foreground = await f.budget.reserve(100, { priority: 'foreground' });
  worker.onmessage({ data: { ready: true } });
  worker.onmessage({ data: { ready: true } }); // Duplicate handshakes never post twice.
  await tick();
  console.log(`${route} ${boundary} boundary:`, JSON.stringify({ starts: f.starts, foreground: f.budget.foregroundOutstanding, reserved: f.budget.reserved }));
  assert.equal(f.starts.length, 0, `${route}: actual caller never transfers while foreground is held`);
  foreground.release();
  await tick();
  assert.deepEqual(f.starts, [{ kind: 'worker', foreground: 0, reserved: 192 }]);
  worker.reply();
  const base = await pending;
  assert.equal(base.__image16.data[0], 0x1234);
  assert.equal(worker.stops, 1);
  assert.equal(f.budget.idle, true);
  assert.equal(f.c.heldJobFrames.has(base), true);
  f.cleanup(base);
  assert.equal(base.released, true);
  assert.equal(f.c.heldJobFrames.size, 0);
}

// Worker unavailability retries the real synchronous codec only after a new
// gate; no transfer occurred and every low sample byte is still exact.
for (const route of ['png16', 'tiff']) {
  const f = fixture(route), { pending } = await f.start();
  const worker = await f.created.promise; await tick();
  const foreground = await f.budget.reserve(100, { priority: 'foreground' });
  worker.onerror(); await tick();
  assert.equal(f.starts.length, 0, `${route}: no page codec retry while foreground owns memory`);
  foreground.release();
  const base = await pending;
  assert.deepEqual(f.starts, [{ kind: route === 'tiff' ? 'utif' : 'upng', foreground: 0, reserved: 192 }]);
  assert.deepEqual(base.__image16.data, pixels);
  f.cleanup(base);
}

for (const route of ['png16', 'tiff']) for (const exit of ['abort-ready', 'abort-gate', 'abort-decode', 'error', 'messageerror-gate', 'refused']) {
  const f = fixture(route), { pending } = await f.start();
  const worker = await f.created.promise; await tick();
  let foreground;
  if (exit === 'abort-gate' || exit === 'messageerror-gate') foreground = await f.budget.reserve(100, { priority: 'foreground' });
  const held = exit === 'refused' ? await f.budget.reserve(1e9 - 100, { priority: 'user' }) : null;
  if (exit !== 'abort-ready') worker.onmessage({ data: { ready: true } });
  await tick();
  const lateReady = worker.onmessage;
  if (exit.startsWith('abort')) {
    f.controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
  } else if (exit === 'error') {
    worker.onmessage({ data: { error: 'corrupt scan', code: 'SCAN_DECODE_FAILED' } });
    await assert.rejects(pending, /corrupt scan/);
  } else if (exit === 'messageerror-gate') {
    worker.onmessageerror();
    await assert.rejects(pending, /unreadable pixels/);
  } else assert.equal(await pending, null, 'refused prepare cannot report a successful frame');
  foreground?.release(); held?.release();
  lateReady?.({ data: { ready: true } }); await tick();
  assert.equal(f.starts.length, exit === 'abort-decode' || exit === 'error' ? 1 : 0);
  f.cleanup();
}

for (const route of ['png8', 'standard']) {
  const f = fixture(route), denied = Error('Browser admission denied');
  f.budget.tryReserve = () => { throw denied; };
  const { pending } = await f.start();
  await assert.rejects(pending, candidate => candidate === denied);
  assert.equal(f.starts.length, 0, 'browser admission rejection cannot enter any codec retry');
  f.cleanup();
}
console.log('PNG/TIFF worker abort, decode error and refusal checks passed');

for (const retry of ['worker', 'upng']) {
  const f = fixture('png8'); f.bitmapFails = f.imageFails = true;
  const { pending } = await f.start(), worker = await f.created.promise; await tick();
  const foreground = await f.budget.reserve(100, { priority: 'foreground' });
  if (retry === 'worker') worker.onmessage({ data: { ready: true } });
  else worker.onerror();
  await tick(); assert.deepEqual(f.starts.map(start => start.kind), ['bitmap', 'image']);
  foreground.release(); await tick();
  if (retry === 'worker') worker.reply();
  const base = await pending;
  assert.deepEqual(f.starts.at(-1), { kind: retry, foreground: 0, reserved: 192 });
  assert.equal(base.__image16, undefined);
  f.cleanup(base);
}

// Real PNG8 and TIFF-named JPEG callers yield in content sniffing. The Image
// retry's factory may start a foreground operation after the failed bitmap.
for (const route of ['png8', 'standard']) for (const retry of [false, true]) {
  const f = fixture(route);
  console.log(`Browser caller ${route}, retry=${retry}`);
  let foreground;
  f.bitmapFails = retry;
  if (retry) f.onImageFactory = () => { void f.budget.reserve(100, { priority: 'foreground' }).then(handle => { foreground = handle; }); };
  else {
    const read = defer(), fileRead = f.job.file.arrayBuffer.bind(f.job.file);
    f.job.file.arrayBuffer = async () => { await read.promise; return fileRead(); };
    f.onRead = read;
  }
  const { pending } = await f.start();
  if (!retry) {
    foreground = await f.budget.reserve(100, { priority: 'foreground' });
    f.onRead.resolve();
  } else await f.nativeCreated.promise;
  await tick();
  assert.deepEqual(f.starts.map(start => start.kind), retry ? ['bitmap'] : []);
  foreground.release();
  const base = await pending;
  assert.deepEqual(f.starts.at(-1), { kind: retry ? 'image' : 'bitmap', foreground: 0, reserved: 192 });
  assert.equal(base.__image16, undefined, 'an 8-bit source gains no false precision');
  assert.equal(f.closed, retry ? 0 : 1);
  f.cleanup(base);
}

// Cancellation while the non-cancelable bitmap runs closes its late output
// before canvas readback; neither the img nor UPNG retry can follow it.
for (const route of ['png8', 'standard']) {
  const f = fixture(route); f.bitmapWait = defer();
  const { pending } = await f.start(); await tick();
  assert.equal(f.starts.length, 1);
  f.controller.abort(); f.bitmapWait.resolve();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(f.closed, 1); assert.equal(f.readbacks, 0); assert.equal(f.starts.length, 1);
  f.cleanup();
}

// A generic admission failure must propagate unchanged, even if startup also
// reports a codec error while the gate is waiting.
for (const route of ['png16', 'tiff']) {
  const f = fixture(route), gate = defer(), denied = Error('Memory admission denied');
  f.budget.whenForegroundIdle = () => gate.promise;
  const { pending } = await f.start(), worker = await f.created.promise; await tick();
  const foreground = await f.budget.reserve(100, { priority: 'foreground' });
  worker.onmessage({ data: { ready: true } }); worker.onerror();
  // A rejected promise supplied by the real claim's foreground wait.
  gate.resolve(Promise.reject(denied));
  await assert.rejects(pending, error => error === denied);
  assert.equal(f.starts.length, 0);
  foreground.release(); f.cleanup();
}

// HEIF is excluded from decode-ahead offers unless disguised as a supported
// container. Its worker still receives the same signal and scan gate.
for (const outcome of ['complete', 'abort', 'denied', 'error']) {
  const f = fixture(), gate = defer(), denied = Error('HEIF admission denied');
  let calls = 0;
  const controller = new AbortController();
  const pending = decodeHeifInWorker(f.job.file, {
    signal: controller.signal, workerFactory: () => new Worker(),
    reserveDecode: async size => { assert.deepEqual(size, { kind: 'scan' }); calls++; await gate.promise; }
  });
  pending.catch(() => {});
  const worker = await f.created.promise;
  worker.onmessage({ data: { ready: true } });
  await tick(); assert.equal(f.starts.length, 0);
  if (outcome === 'abort') { controller.abort(); gate.resolve(); await assert.rejects(pending, { name: 'AbortError' }); }
  else if (outcome === 'denied') { gate.resolve(Promise.reject(denied)); await assert.rejects(pending, error => error === denied); }
  else {
    gate.resolve(); await tick(); assert.equal(f.starts.length, 1);
    if (outcome === 'error') { worker.onerror(); await assert.rejects(pending, /could not start/); }
    else { worker.onmessage({ data: { width: 4, height: 4, data: new Uint8ClampedArray(64) } }); await pending; }
  }
  assert.equal(calls, 1); assert.equal(worker.stops, 1);
}

// The actual TIFF-named HEIF caller reaches the browser retries and then the
// lazy HEIF worker, retaining counted prepare ownership all the way through.
for (const abort of [false, true]) {
  const f = fixture('heif'); f.bitmapFails = f.imageFails = true;
  let foreground;
  f.onFactory = () => { void f.budget.reserve(100, { priority: 'foreground' }).then(handle => { foreground = handle; }); };
  const { pending } = await f.start(), worker = await f.created.promise; await tick();
  assert.deepEqual(f.starts.map(start => start.kind), ['bitmap', 'image']);
  if (abort) {
    f.controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
    foreground.release(); await tick(); f.cleanup();
  } else {
    foreground.release(); await tick();
    assert.deepEqual(f.starts.at(-1), { kind: 'worker', foreground: 0, reserved: 192 });
    worker.onmessage({ data: { width: 4, height: 4, data: new Uint8ClampedArray(64).fill(17) } });
    const base = await pending; f.cleanup(base);
  }
}
console.log('decodeAheadLoaders: actual PNG8/16/TIFF/browser dispatch, real codec retry, counted claims, abort/error/refusal/disposal and HEIF gate passed');
clearTimeout(watchdog);

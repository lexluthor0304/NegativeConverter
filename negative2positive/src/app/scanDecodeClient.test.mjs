import assert from 'node:assert/strict';
import { Worker as NodeWorker } from 'node:worker_threads';
import * as pako from 'pako';
import { decodeScanInWorker, decodeJpegInWorker, createEmbeddedPreviewPool } from './scanDecodeClient.js';
import { decodeNefPreviewJpeg } from './nefJpegPreview.js';
import { encodePng16Blob, encodeTiffBlob } from '../workers/imageEncoders.js';

globalThis.ImageData = class ImageData {
  constructor(data, width, height) { Object.assign(this, { data, width, height }); }
};
const workerUrl = new URL('../workers/scanDecodeWorker.js', import.meta.url).href;
let terminated = 0;
class RealWorker {
  constructor() {
    this.worker = new NodeWorker(`
      const { parentPort } = require('node:worker_threads');
      globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
      globalThis.self = { postMessage: (message, transfers) => parentPort.postMessage(message, transfers) };
      const ready = import(${JSON.stringify(workerUrl)});
      parentPort.on('message', async data => { await ready; self.onmessage({ data }); });
    `, { eval: true });
    this.worker.on('message', data => this.onmessage?.({ data }));
    this.worker.on('error', error => this.onerror?.(error));
  }
  postMessage(message, transfers) { this.worker.postMessage(message, transfers); }
  terminate() { terminated++; void this.worker.terminate(); }
}

const pixels = new Uint16Array([0x1234, 0x0001, 0xFEDC, 65535, 0xACBD, 0x8001, 0x0002, 65535]);
for (const format of ['png', 'tiff']) {
  const blob = format === 'png' ? encodePng16Blob(pixels, 2, 1, pako) : encodeTiffBlob(pixels, 2, 1, 16);
  const buffer = await blob.arrayBuffer();
  const pending = decodeScanInWorker(buffer, format, { workerFactory: () => new RealWorker() });
  const result = await pending;
  assert.equal(buffer.byteLength, 0, 'input ownership transfers without a full scan clone');
  assert.deepEqual(result.__image16.data, pixels, `${format}: exact low-byte precision`);
  assert.deepEqual(result.data, new Uint8ClampedArray(Array.from(pixels, x => x >>> 8)));
}
assert.equal(terminated, 2, 'each decode must release its worker heap');
await assert.rejects(decodeScanInWorker(new ArrayBuffer(8), 'png', { workerFactory: () => new RealWorker() }));
assert.equal(terminated, 3, 'decoder errors release their heap');

const intact = new ArrayBuffer(8);
assert.equal(await decodeScanInWorker(intact, 'png', { workerFactory: null }), null);
assert.equal(await decodeScanInWorker(intact, 'png', { workerFactory: () => { throw Error('unavailable'); } }), null);
assert.equal(intact.byteLength, 8, 'fallback keeps the input container');
{
  let worker;
  const pending = decodeScanInWorker(intact, 'png', { workerFactory: () => (worker = { terminate() {} }) });
  worker.onerror();
  assert.equal(await pending, null, 'asynchronous startup failure uses the main decoder');
  assert.equal(intact.byteLength, 8, 'startup failure must retain input ownership');
}
let stopped = false;
await assert.rejects(decodeScanInWorker(new ArrayBuffer(8), 'png', {
  workerFactory: () => ({ postMessage() {}, terminate() { stopped = true; } }), timeoutMs: 1
}), /timed out/);
assert.ok(stopped, 'a timed out decoder is terminated');

// ---------------------------------------------------------------------------
// HE NEF `jpeg` job: capability handshake before any transfer
// ---------------------------------------------------------------------------
const tick = () => new Promise(resolve => setImmediate(resolve));
class FakeImageWorker {
  constructor({ canDecodeImages = true, reply = 'planes', readyDelay = 0 } = {}) {
    Object.assign(this, { canDecodeImages, reply, posted: [], terminated: false });
    setTimeout(() => this.onmessage?.({ data: { ready: true, canDecodeImages } }), readyDelay);
  }
  postMessage(message, transfers = []) {
    // Emulate transfer: detach every listed buffer.
    const moved = transfers.map(buffer => buffer.transfer ? buffer.transfer() : buffer);
    this.posted.push({ message, moved });
    if (message.type !== 'jpeg') return;
    setImmediate(() => {
      if (this.reply === 'error') this.onmessage?.({ data: { id: message.id, error: 'corrupt', bytes: moved[0] } });
      else {
        const data = new Uint8ClampedArray([10, 20, 30, 255]).buffer;
        const image16 = new Uint16Array([2570, 5140, 7710, 65535]).buffer;
        this.onmessage?.({ data: { id: message.id, width: 1, height: 1, data, image16 } });
      }
    });
  }
  terminate() { this.terminated = true; }
}
{
  const stash = { jpegBytes: new Uint8Array([0xFF, 0xD8, 1, 2, 3, 4, 0xFF, 0xD9]) };
  let worker;
  assert.equal(await decodeJpegInWorker(stash, { workerFactory: () => (worker = new FakeImageWorker({ canDecodeImages: false })) }), null);
  assert.equal(worker.posted.length, 0, 'no job is posted without the image capability');
  assert.equal(stash.jpegBytes.byteLength, 8, 'the stashed bytes are never detached before the fallback decision');
  assert.ok(worker.terminated);

  const decoded = await decodeJpegInWorker(stash, { workerFactory: () => (worker = new FakeImageWorker()) });
  assert.deepEqual([decoded.width, decoded.height, Array.from(decoded.data)], [1, 1, [10, 20, 30, 255]]);
  assert.deepEqual(Array.from(decoded.__image16.data), [2570, 5140, 7710, 65535], 'both planes arrive from the worker');
  assert.equal(worker.posted[0].message.type, 'jpeg');

  const failing = { jpegBytes: new Uint8Array([0xFF, 0xD8, 9, 9, 0xFF, 0xD9]) };
  assert.equal(await decodeJpegInWorker(failing, { workerFactory: () => new FakeImageWorker({ reply: 'error' }) }), null);
  assert.deepEqual(Array.from(failing.jpegBytes), [0xFF, 0xD8, 9, 9, 0xFF, 0xD9], 'a failed worker decode hands the bytes back');

  // A view into a larger container is copied, never detaching the container.
  const container = new Uint8Array(64).fill(7);
  const view = { jpegBytes: container.subarray(8, 24) };
  await decodeJpegInWorker(view, { workerFactory: () => new FakeImageWorker() });
  assert.equal(container.buffer.byteLength, 64, 'container stays attached');

  // The real worker in Node has no OffscreenCanvas: it reports no capability.
  const real = { jpegBytes: new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9]) };
  assert.equal(await decodeJpegInWorker(real, { workerFactory: () => new RealWorker() }), null);
  assert.equal(real.jpegBytes.byteLength, 4, 'real worker handshake keeps the stash intact');
}
{
  // decodeNefPreviewJpeg prefers the worker result, which already carries
  // __image16 so rawFileLoader's `||=` never rebuilds it on the main thread.
  const fromWorker = { width: 1, height: 1, data: new Uint8ClampedArray(4), __image16: { width: 1, height: 1, data: new Uint16Array(4) } };
  const stash = { jpegBytes: new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9]) };
  assert.equal(await decodeNefPreviewJpeg(stash, { decodeInWorker: async () => fromWorker }), fromWorker);
  let attempted = false;
  // Without a worker result the main-thread decoder runs (Node has none: null).
  const warn = console.warn; console.warn = () => {};
  try { assert.equal(await decodeNefPreviewJpeg(stash, { decodeInWorker: async () => { attempted = true; return null; } }), null); }
  finally { console.warn = warn; }
  assert.ok(attempted);
}

// ---------------------------------------------------------------------------
// Embedded-preview pool
// ---------------------------------------------------------------------------
class FakePreviewWorker {
  static all = [];
  constructor({ canDecodeImages = true } = {}) {
    Object.assign(this, { jobs: [], terminated: false });
    FakePreviewWorker.all.push(this);
    setImmediate(() => this.onmessage?.({ data: { ready: true, canDecodeImages } }));
  }
  postMessage(message) { this.jobs.push(message); }
  reply(index = 0, extra = {}) {
    const [job] = this.jobs.splice(index, 1);
    this.onmessage?.({ data: { id: job.id, dataUrl: `data:${job.file.name}`, width: 32, height: 24,
      located: { previews: [], orientation: 1, rawSize: null }, bytesRead: 1000, ...extra } });
    return job;
  }
  terminate() { this.terminated = true; }
}
const fakeFile = name => Object.assign(new Blob(['x']), { name });
{
  FakePreviewWorker.all = [];
  const pool = createEmbeddedPreviewPool({ workerFactory: () => new FakePreviewWorker(), idleMs: 5 });
  const results = [];
  const jobs = Array.from({ length: 7 }, (_, i) => pool.request({ file: fakeFile(`f${i}`), purpose: 'tile', output: 'dataUrl' },
    { priority: i === 5 ? 0 : 2 }).then(result => results.push([i, result?.dataUrl])));
  await tick(); await tick(); await tick();
  assert.ok(FakePreviewWorker.all.length <= 2, 'at most two workers');
  const posted = FakePreviewWorker.all.flatMap(worker => worker.jobs);
  assert.equal(posted.length, 4, `four jobs in flight across two workers (${posted.length})`);
  assert.deepEqual(FakePreviewWorker.all.map(worker => worker.jobs.length), [2, 2], 'reads overlap decodes on both workers');
  assert.equal(posted[0].file.name, 'f5', 'the first photo / visible rows go first');
  assert.equal(posted[0].type, 'embedded-preview');
  while (FakePreviewWorker.all.some(worker => worker.jobs.length)) {
    for (const worker of FakePreviewWorker.all) if (worker.jobs.length) worker.reply();
    await tick(); await tick();
  }
  await Promise.all(jobs);
  assert.equal(results.length, 7);
  assert.ok(results.every(([i, url]) => url === `data:f${i}`));
  // Idle workers terminate unless one is kept warm.
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(FakePreviewWorker.all.every(worker => worker.terminated), 'idle pool releases its workers');
  pool.setKeepWarm(true);
  await tick();
  const warm = FakePreviewWorker.all.at(-1);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(warm.terminated, false, 'one worker stays warm while the queue holds TIFF RAWs');
  pool.clear();
  assert.equal(warm.terminated, true, 'clearing the queue terminates the pool');
}
{
  // Abort: a superseded viewer frame never resolves with a bitmap.
  FakePreviewWorker.all = [];
  const pool = createEmbeddedPreviewPool({ workerFactory: () => new FakePreviewWorker() });
  const controller = new AbortController();
  const pending = pool.request({ file: fakeFile('old'), purpose: 'viewer' }, { priority: -1, signal: controller.signal });
  await tick(); await tick();
  let closed = false;
  controller.abort();
  FakePreviewWorker.all[0].reply(0, { bitmap: { close: () => { closed = true; } } });
  assert.equal(await pending, null);
  assert.ok(closed, 'a late bitmap for an aborted frame is released');
  pool.clear();
}
{
  // Without the capability: viewer frames are skipped, tiles decode on the
  // main thread one per animation frame, and no job is ever posted.
  FakePreviewWorker.all = [];
  const frames = [];
  const rendered = [];
  const pool = createEmbeddedPreviewPool({
    workerFactory: () => new FakePreviewWorker({ canDecodeImages: false }),
    requestFrame: fn => frames.push(fn),
    mainThreadRender: async job => { rendered.push(job.file.name); return { dataUrl: 'main:' + job.file.name }; },
  });
  const viewer = pool.request({ file: fakeFile('v'), purpose: 'viewer' }, { priority: -1 });
  const tiles = ['a', 'b', 'c'].map(name => pool.request({ file: fakeFile(name), purpose: 'tile' }));
  await tick(); await tick();
  assert.equal(await viewer, null, 'no provisional viewer frame without the capability');
  assert.equal(pool.capability, false);
  assert.ok(FakePreviewWorker.all.every(worker => worker.jobs.length === 0 && worker.terminated));
  assert.equal(frames.length, 1, 'tiles are scheduled one per frame');
  for (let i = 0; i < 3; i++) { frames.shift()(); await tick(); await tick(); }
  assert.deepEqual(rendered, ['a', 'b', 'c']);
  assert.deepEqual((await Promise.all(tiles)).map(result => result.dataUrl), ['main:a', 'main:b', 'main:c']);
}
{
  // A worker that fails to start leaves the pool without the capability.
  const pool = createEmbeddedPreviewPool({ workerFactory: () => { throw new Error('CSP'); } });
  assert.equal(await pool.request({ file: fakeFile('x'), purpose: 'tile' }), null);
  assert.equal(pool.capability, false);
  // No worker support at all.
  const none = createEmbeddedPreviewPool({ workerFactory: null });
  assert.equal(await none.request({ file: fakeFile('x'), purpose: 'viewer' }), null);
}
{
  // A job that never answers retires its worker; the next job gets a fresh one.
  FakePreviewWorker.all = [];
  const pool = createEmbeddedPreviewPool({ workerFactory: () => new FakePreviewWorker(), timeoutMs: 10 });
  const stuck = pool.request({ file: fakeFile('stuck'), purpose: 'tile' });
  assert.equal(await stuck, null);
  assert.ok(FakePreviewWorker.all[0].terminated);
  const next = pool.request({ file: fakeFile('next'), purpose: 'tile' });
  await tick(); await tick();
  FakePreviewWorker.all.at(-1).reply();
  assert.equal((await next).dataUrl, 'data:next');
  pool.clear();
}

// ---------------------------------------------------------------------------
// The real worker module with a stand-in image stack: the capability probe,
// the embedded-preview reply (located structure, bytes read, transfer) and
// the HE NEF `jpeg` reply (both planes) go through the actual message code.
// ---------------------------------------------------------------------------
const renderUrl = new URL('./embeddedPreviewRender.js', import.meta.url).href;
class StackWorker {
  static decodes = 0;
  constructor() {
    this.worker = new NodeWorker(`
      const { parentPort } = require('node:worker_threads');
      globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
      const ready = import(${JSON.stringify(renderUrl)}).then(({ transformPixels }) => {
        // Every JPEG decodes to an 8x6 orange negative ramp.
        globalThis.createImageBitmap = async () => {
          parentPort.postMessage({ decoded: true });
          const data = new Uint8ClampedArray(8 * 6 * 4);
          for (let i = 0; i < 48; i++) { const t = (i % 8) / 7; data.set([230 - 110 * t, 170 - 100 * t, 120 - 80 * t, 255], i * 4); }
          return { width: 8, height: 6, data, close() {} };
        };
        globalThis.OffscreenCanvas = class {
          constructor(width, height) { Object.assign(this, { width, height, pixels: new Uint8ClampedArray(width * height * 4) }); }
          getContext() {
            const canvas = this; let matrix = [1, 0, 0, 1, 0, 0];
            return {
              setTransform: (...m) => { matrix = m; },
              drawImage: bitmap => canvas.pixels.set(transformPixels(bitmap.data, bitmap.width, bitmap.height,
                { width: canvas.width, height: canvas.height, matrix }).data),
              getImageData: (x, y, w, h) => new ImageData(canvas.pixels.slice(0, w * h * 4), w, h),
              putImageData: image => canvas.pixels.set(image.data),
            };
          }
          transferToImageBitmap() { return { width: this.width, height: this.height, bitmap: true }; }
          async convertToBlob() { return new Blob([this.pixels.slice(0, 4)], { type: 'image/jpeg' }); }
        };
        globalThis.FileReaderSync = class { readAsDataURL(blob) { return 'data:image/jpeg;base64,' + blob.size; } };
      });
      // Node cannot transfer stand-in bitmaps; ArrayBuffers are transferred as in browsers.
      globalThis.self = { postMessage: (message, transfers = []) => parentPort.postMessage(message, transfers.filter(t => t instanceof ArrayBuffer)) };
      const loaded = ready.then(() => import(${JSON.stringify(workerUrl)}));
      parentPort.on('message', async data => { await loaded; self.onmessage({ data }); });
    `, { eval: true });
    this.worker.on('message', data => { if (data?.decoded) { StackWorker.decodes++; return; } this.onmessage?.({ data }); });
    this.worker.on('error', error => this.onerror?.(error));
  }
  postMessage(message, transfers) { this.worker.postMessage(message, transfers); }
  terminate() { void this.worker.terminate(); }
}
{
  const { buildDngWithPreviews } = await import('./rawEmbeddedPreview.fixtures.mjs');
  const { bytes } = buildDngWithPreviews({ previews: [{ width: 160, height: 120 }, { width: 720, height: 480 }, { width: 2112, height: 1408 }] });
  const file = new File([bytes], 'stack.dng');
  const pool = createEmbeddedPreviewPool({ workerFactory: () => new StackWorker() });
  const tile = await pool.request({ file, purpose: 'tile', output: 'dataUrl' });
  assert.equal(pool.capability, true, 'the probe passes with a working decoder and OffscreenCanvas');
  assert.equal(tile.preview.width, 720);
  assert.ok(tile.dataUrl.startsWith('data:image/jpeg'), 'tiles come back as JPEG data URLs');
  assert.ok(tile.located && tile.bytesRead > tile.preview.length, 'the first job locates and reports its reads');
  const viewer = await pool.request({ file, purpose: 'viewer', output: 'bitmap', longSidePx: 2400 });
  assert.equal(viewer.preview.width, 2112);
  assert.equal(viewer.bytesRead, viewer.preview.length, 'the cached location is reused: only the preview is read');
  assert.deepEqual([viewer.bitmap.width, viewer.bitmap.height], [8, 6]);
  const none = await pool.request({ file: new File([new Uint8Array(64)], 'x.dng'), purpose: 'viewer', longSidePx: 2000 });
  assert.equal(none.empty, true);
  pool.clear();

  const stash = { jpegBytes: new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9]) };
  const decoded = await decodeJpegInWorker(stash, { workerFactory: () => new StackWorker() });
  assert.deepEqual([decoded.width, decoded.height], [8, 6]);
  assert.equal(decoded.data.length, 8 * 6 * 4);
  assert.deepEqual(Array.from(decoded.__image16.data.subarray(0, 4)), Array.from(decoded.data.subarray(0, 4), v => v * 257),
    'the worker builds the same x257 mirror as fromImageData8');
  assert.equal(stash.jpegBytes.byteLength, 0, 'with the capability the stashed bytes are transferred');
}
// Abort (#243): before dispatch the input stays with the caller; after it the
// disposable worker is terminated. Both reject with an AbortError, never null
// (null would start the main-thread decoder).
{
  const already = new AbortController();
  already.abort();
  const kept = new ArrayBuffer(16);
  let spawned = 0;
  await assert.rejects(decodeScanInWorker(kept, 'png', { workerFactory: () => { spawned++; return {}; }, signal: already.signal }),
    error => error.name === 'AbortError');
  assert.equal(spawned, 0, 'an aborted request never spawns a worker');
  assert.equal(kept.byteLength, 16);

  // Aborted while the worker starts: nothing was posted.
  const early = new AbortController();
  let worker, stops = 0;
  const posted = [];
  const input = new ArrayBuffer(16);
  const pending = decodeScanInWorker(input, 'tiff', {
    workerFactory: () => (worker = { postMessage: (message) => posted.push(message), terminate() { stops++; } }),
    signal: early.signal
  });
  early.abort(new DOMException('Superseded photo activation', 'AbortError'));
  await assert.rejects(pending, error => error.name === 'AbortError' && /Superseded/.test(error.message));
  assert.equal(stops, 1, 'the idle worker is terminated');
  assert.equal(posted.length, 0, 'no dispatch after an abort');
  assert.equal(input.byteLength, 16, 'the input is still the caller\'s');
  worker.onmessage?.({ data: { ready: true } });
  assert.equal(posted.length, 0, 'a late ready message dispatches nothing');

  // Aborted after dispatch: the worker is terminated at once.
  const late = new AbortController();
  let lateStops = 0, lateWorker;
  const moved = new ArrayBuffer(32);
  const running = decodeScanInWorker(moved, 'png', {
    workerFactory: () => (lateWorker = { postMessage(message, transfers) { structuredClone(message, { transfer: transfers }); }, terminate() { lateStops++; } }),
    signal: late.signal
  });
  lateWorker.onmessage({ data: { ready: true } });
  assert.equal(moved.byteLength, 0, 'dispatched');
  late.abort();
  await assert.rejects(running, error => error.name === 'AbortError');
  assert.equal(lateStops, 1, 'the decoding worker is terminated');
}

console.log('scanDecodeClient tests passed: real worker PNG/TIFF precision, transfer and lifecycle; jpeg capability handshake; preview pool');

// JPEG cancellation preserves bytes before dispatch, terminates the worker
// after dispatch, and never starts the NEF main-thread fallback.
for (const phase of ['before', 'handshake', 'decode']) {
  const controller = new AbortController();
  const stash = { jpegBytes: new Uint8Array([255, 216, 255, 217]) };
  let worker, dispatched = 0, terminated = 0;
  if (phase === 'before') controller.abort();
  const pending = decodeNefPreviewJpeg(stash, {
    signal: controller.signal,
    decodeInWorker: (input, options) => decodeJpegInWorker(input, { ...options, workerFactory: () => (worker = {
      terminate() { terminated++; },
      postMessage(message, transfers) { dispatched++; structuredClone(message, { transfer: transfers }); }
    }) })
  });
  if (phase === 'decode') worker.onmessage({ data: { ready: true, canDecodeImages: true } });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(dispatched, phase === 'decode' ? 1 : 0);
  assert.equal(terminated, phase === 'before' ? 0 : 1);
  assert.equal(stash.jpegBytes.byteLength, phase === 'decode' ? 0 : 4);
}
console.log('scanDecodeClient: NEF JPEG cancellation before dispatch and during decode passed');

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
console.log('scanDecodeClient tests passed: real worker PNG/TIFF precision, transfer and lifecycle; jpeg capability handshake; preview pool');

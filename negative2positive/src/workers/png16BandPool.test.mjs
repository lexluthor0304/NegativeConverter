// Standalone Node test for the PNG16 band pool (createPng16BandPool in
// workerBridge.js) - run with:
// node negative2positive/src/workers/png16BandPool.test.mjs
//
// The pool's workers run the real exportWorker.js message handler in
// process, so the bytes compared here are what a browser worker produces.
// The file must not depend on how many workers encode the bands, and every
// failure mode must stop (terminate) the workers busy with that frame.
import assert from 'node:assert/strict';
import * as pako from 'pako';

let deliver = null;
globalThis.self = { onmessage: null, postMessage(message) { deliver(message); } };
await import('./exportWorker.js');
const workerHandler = self.onmessage;

globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    if (!(data instanceof Uint8ClampedArray) || data.length !== width * height * 4) throw new TypeError('bad ImageData');
    this.data = data;
    this.width = width;
    this.height = height;
  }
};

const { createPng16BandPool, createExportWorkerBridge, computeWorkerTimeoutMs, isAbortError, resetWorkerFallbackWarnings } = await import('./workerBridge.js');
const { encodePng16Blob } = await import('./imageEncoders.js');
const { encodePng16Blob: mainThreadEncodePng16 } = await import('../app/exportImageEncoders.js');
const { planPng16Bands } = await import('./png16Bands.js');

/**
 * A worker that answers asynchronously with the real handler. `behaviour`
 * may return 'hang' (never answer) or 'crash' (fire onerror) per message.
 */
function createWorkerFactory({ behaviour = () => 'run', delayMs = 1 } = {}) {
  const stats = { created: [], posts: [], inFlight: 0, maxInFlight: 0, perWorkerMax: 0 };
  class InProcessWorker {
    constructor() {
      this.onmessage = null;
      this.onerror = null;
      this.onmessageerror = null;
      this.terminated = false;
      this.busy = 0;
      stats.created.push(this);
    }

    postMessage(message, transfers = []) {
      const received = structuredClone(message, { transfer: transfers });
      stats.posts.push(received);
      stats.inFlight += 1;
      this.busy += 1;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      stats.perWorkerMax = Math.max(stats.perWorkerMax, this.busy);
      const plan = behaviour(received, this);
      const done = () => { stats.inFlight -= 1; this.busy -= 1; };
      if (plan === 'hang') { this.release = done; return; }
      setTimeout(() => {
        done();
        if (this.terminated) return;
        if (plan === 'crash') {
          this.onerror(new Error('band worker crashed'));
          return;
        }
        const replies = [];
        deliver = (reply) => replies.push(reply);
        workerHandler({ data: received });
        for (const reply of replies) if (!this.terminated) this.onmessage({ data: reply });
      }, delayMs);
    }

    terminate() {
      if (!this.terminated && this.release) this.release();
      this.release = null;
      this.terminated = true;
    }
  }
  return { factory: () => new InProcessWorker(), stats };
}

const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());

let seed = 99;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed;
};
function frame16(width, height) {
  const plane = new Uint16Array(width * height * 4);
  for (let i = 0; i < plane.length; i++) plane[i] = i % 4 === 3 ? 65535 : (Math.round((i % (width * 4)) / (width * 4) * 50000) + (random() >>> 22)) & 0xFFFF;
  const imageData = new ImageData(Uint8ClampedArray.from(plane, (v) => v >>> 8), width, height);
  imageData.__image16 = { width, height, data: plane };
  return imageData;
}
function frame8(width, height, alpha) {
  return new ImageData(Uint8ClampedArray.from({ length: width * height * 4 }, (_, i) => i % 4 === 3 ? (alpha ? random() >>> 24 : 255) : random() >>> 24), width, height);
}

const W = 61, H = 47, BAND_BYTES = 1500; // 367-byte rows: 4 rows per band, 12 bands
assert.equal(planPng16Bands(W, H, 3, { bandBytes: BAND_BYTES }).bands.length, 12);

// ---------------- identical bytes with 1, 2 and 6 workers, one worker, main thread

for (const imageData of [frame16(W, H), frame8(W, H, false), frame8(W, H, true)]) {
  const source = imageData.__image16 ? imageData.__image16.data : imageData.data;
  const reference = await bytesOf(encodePng16Blob(source, W, H, pako, { bandBytes: BAND_BYTES }));
  for (const size of [1, 2, 6]) {
    const { factory, stats } = createWorkerFactory({ delayMs: size === 6 ? 3 : 1 });
    const pool = createPng16BandPool({ size, workerFactory: factory });
    const progress = [];
    const blob = await pool.encode(imageData, { bandBytes: BAND_BYTES, onProgress: (percent) => progress.push(percent) });
    assert.ok(blob instanceof Blob, `pool of ${size} produced a file`);
    assert.equal(blob.type, 'image/png');
    assert.deepEqual(await bytesOf(blob), reference, `pool of ${size}: same bytes as the serial encoder`);
    const channels = imageData.__image16 ? 3 : (imageData.data.some((v, i) => i % 4 === 3 && v !== 255) ? 4 : 3);
    assert.equal(stats.posts.length, planPng16Bands(W, H, channels, { bandBytes: BAND_BYTES }).bands.length, 'one message per band');
    assert.ok(stats.posts.every((m) => m.channels === channels), 'the channel count is decided once for the frame');
    assert.ok(stats.posts.every((m) => m.type === 'encodePng16Band'));
    assert.ok(stats.created.length <= size, 'never more workers than the pool size');
    assert.ok(stats.maxInFlight <= size, `at most ${size} band slices in flight (saw ${stats.maxInFlight})`);
    assert.equal(stats.perWorkerMax, 1, 'one band per worker at a time');
    if (size === 6) assert.ok(stats.maxInFlight > 1, 'bands really run in parallel');
    // Each worker got only its band's rows, never the whole frame.
    assert.ok(stats.posts.every((m) => m.pixelData.byteLength === m.rows * W * 4 * (imageData.__image16 ? 2 : 1)));
    assert.deepEqual(progress, [...progress].sort((a, b) => a - b), 'progress rises');
    assert.equal(progress.at(-1), 100);
    // The caller's planes are untouched.
    assert.equal(imageData.data.length, W * H * 4);
    if (imageData.__image16) assert.equal(imageData.__image16.data.length, W * H * 4);
    pool.dispose();
    assert.ok(stats.created.every((worker) => worker.terminated), 'dispose terminates every band worker');
  }
  // One export worker (the lanes >= 3 path) and the main-thread fallback.
  const { factory } = createWorkerFactory();
  const bridge = createExportWorkerBridge({ workerFactory: factory });
  assert.deepEqual(await bytesOf(await bridge.workerEncodePng16(imageData, { bandBytes: BAND_BYTES })), reference, 'one export worker');
  bridge.terminateWorker();
  assert.deepEqual(await bytesOf(mainThreadEncodePng16(imageData, { bandBytes: BAND_BYTES })), reference, 'main thread');
}

// Default layout: one band for a small frame, still identical.
{
  const imageData = frame16(40, 30);
  const { factory } = createWorkerFactory();
  const pool = createPng16BandPool({ size: 3, workerFactory: factory });
  assert.deepEqual(await bytesOf(await pool.encode(imageData)), await bytesOf(mainThreadEncodePng16(imageData)));
  pool.dispose();
}

// ------------------------------- band timeouts: per band, from dispatch

{
  const realSetTimeout = globalThis.setTimeout;
  const timers = [];
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (ms >= 30_000) timers.push(ms);
    return realSetTimeout(fn, ms, ...rest);
  };
  try {
    const { factory, stats } = createWorkerFactory();
    const pool = createPng16BandPool({ size: 2, workerFactory: factory });
    await pool.encode(frame16(W, H), { bandBytes: BAND_BYTES });
    pool.dispose();
    assert.equal(timers.length, stats.posts.length, 'one timer per dispatched band');
    const rows = planPng16Bands(W, H, 3, { bandBytes: BAND_BYTES }).bands.map((band) => band.rows);
    assert.deepEqual(timers, rows.map((r) => computeWorkerTimeoutMs(W * r)));
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}

// ----------------------------------- abort terminates every band worker

{
  const { factory, stats } = createWorkerFactory({ behaviour: () => 'hang' });
  const pool = createPng16BandPool({ size: 3, workerFactory: factory });
  const controller = new AbortController();
  const pending = pool.encode(frame16(W, H), { bandBytes: BAND_BYTES, signal: controller.signal });
  while (stats.posts.length < 3) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(stats.posts.length, 3, 'only as many bands as workers are dispatched');
  const aborted = Date.now();
  controller.abort();
  await assert.rejects(pending, (err) => isAbortError(err));
  assert.ok(Date.now() - aborted < 1000);
  assert.equal(stats.created.length, 3);
  assert.ok(stats.created.every((worker) => worker.terminated), 'every busy band worker is terminated');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(stats.posts.length, 3, 'queued bands are never dispatched after the abort');
  pool.dispose();
  // An already-aborted signal starts nothing.
  const fresh = createWorkerFactory();
  const idlePool = createPng16BandPool({ size: 2, workerFactory: fresh.factory });
  await assert.rejects(idlePool.encode(frame16(W, H), { signal: controller.signal }), (err) => isAbortError(err));
  assert.equal(fresh.stats.posts.length, 0);
  idlePool.dispose();
}

// ------------------------ a failed band stops the frame and falls back

{
  resetWorkerFallbackWarnings();
  const warn = console.warn;
  console.warn = () => {};
  const originalError = console.error;
  console.error = () => {};
  try {
    const { factory, stats } = createWorkerFactory({
      behaviour: (message) => (message.index === 3 ? 'crash' : message.index > 3 ? 'hang' : 'run')
    });
    const pool = createPng16BandPool({ size: 3, workerFactory: factory });
    assert.equal(await pool.encode(frame16(W, H), { bandBytes: BAND_BYTES }), null, 'a crashed band worker falls back');
    const alive = stats.created.filter((worker) => !worker.terminated && worker.busy > 0);
    assert.equal(alive.length, 0, 'no worker keeps working on the failed frame');
    assert.equal(stats.inFlight, 0);
    pool.dispose();

    // A pool that cannot start a worker reports null too.
    const broken = createPng16BandPool({ size: 2, workerFactory: () => { throw new Error('no workers here'); } });
    assert.equal(await broken.encode(frame16(W, H), { bandBytes: BAND_BYTES }), null);
    broken.dispose();

    // Two frames share one pool (two lanes); one frame's failure leaves the
    // other's bands alone.
    const shared = createWorkerFactory({ behaviour: (message) => (message.width === 29 && message.index === 1 ? 'crash' : 'run') });
    const lanePool = createPng16BandPool({ size: 4, workerFactory: shared.factory });
    const good = frame16(W, H);
    const [failed, ok] = await Promise.all([
      lanePool.encode(frame16(29, 40), { bandBytes: 500 }),
      lanePool.encode(good, { bandBytes: BAND_BYTES })
    ]);
    assert.equal(failed, null);
    assert.deepEqual(await bytesOf(ok), await bytesOf(mainThreadEncodePng16(good, { bandBytes: BAND_BYTES })));
    // The pool recovers with fresh workers for the next frame.
    assert.ok(await lanePool.encode(frame16(W, H), { bandBytes: BAND_BYTES }) instanceof Blob);
    lanePool.dispose();
    assert.ok(shared.stats.created.every((worker) => worker.terminated));
  } finally {
    console.warn = warn;
    console.error = originalError;
  }
}

// ------------------------------------------------------------- dispose

{
  const { factory, stats } = createWorkerFactory({ behaviour: () => 'hang' });
  const pool = createPng16BandPool({ size: 2, workerFactory: factory });
  const pending = pool.encode(frame16(W, H), { bandBytes: BAND_BYTES });
  while (stats.posts.length < 2) await new Promise((resolve) => setTimeout(resolve, 1));
  pool.dispose();
  await assert.rejects(pending, (err) => isAbortError(err), 'an encode cut off by dispose is not retried');
  assert.ok(stats.created.every((worker) => worker.terminated));
  assert.equal(pool.disposed, true);
  await assert.rejects(pool.encode(frame16(W, H)), (err) => isAbortError(err));
}

console.log('png16BandPool.test.mjs passed');

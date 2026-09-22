import assert from 'node:assert/strict';
import { createInpaintWorkerSession, createInpaintSessionInWorker } from './aiInpaintWorkerClient.js';
import { createInpaintWorkerProcessor } from '../workers/aiInpaintWorkerProcessor.js';
import { inpaintWithModel } from './aiInpaint.js';
globalThis.ImageData ||= class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
const bytes = new Uint8Array([1, 2, 3]).buffer;
function announceReady(worker) {
  queueMicrotask(() => worker.onmessage?.({ data: { ready: true } }));
  return worker;
}
let creates = 0, releases = 0, active = 0, peakActive = 0, failNext = false, blockRun = null;
const messages = [];
const process = createInpaintWorkerProcessor({ createSession: async (modelBytes, options) => {
  creates++;
  assert.deepEqual(new Uint8Array(modelBytes), new Uint8Array(bytes));
  assert.equal(options.prefer, 'wasm');
  return { provider: 'wasm', inputNames: ['image', 'mask'], outputNames: ['result'],
    release: async () => { releases++; },
    run: async (image) => {
      active++; peakActive = Math.max(peakActive, active);
      try {
        if (blockRun) await blockRun;
        if (failNext) { failNext = false; throw new Error('inference failed'); }
        return Float32Array.from(image, value => 1 - value);
      } finally { active--; }
    }
  };
} });
const worker = {
  postMessage(message, transfer = []) {
    const cloned = structuredClone(message, { transfer });
    messages.push(cloned);
    process(cloned).then(({ payload, transfers }) => {
      if (!this.terminated) this.onmessage({ data: structuredClone(payload, { transfer: transfers }) });
    }, error => { if (!this.terminated) this.onmessage({ data: { id: cloned.id, error: error.message } }); });
  },
  terminate() { this.terminated = true; }
};
const session = await createInpaintWorkerSession(bytes, { prefer: 'wasm' }, { workerFactory: () => {
  queueMicrotask(() => assert.equal(messages.length, 0, 'model dispatch waits for the worker ready handshake'));
  return announceReady(worker);
} });
assert.equal(bytes.byteLength, 3, 'model bytes remain available for a backend retry');
assert.equal(session.provider, 'wasm');
const image = new Float32Array([0.2, 0.5, 0.8]), mask = new Float32Array([1]);
assert.deepEqual(await session.run(image, mask, 1), Float32Array.from(image, value => 1 - value));
assert.equal(image.byteLength, 12, 'default public runner preserves caller inputs');
const exclusiveImage = image.slice(), exclusiveMask = mask.slice();
await session.run(exclusiveImage, exclusiveMask, 1, { transferInputs: true });
assert.equal(exclusiveImage.byteLength, 0); assert.equal(exclusiveMask.byteLength, 0);
failNext = true;
await assert.rejects(session.run(image, mask, 1), /inference failed/);
await session.run(image, mask, 1);
assert.equal(creates, 1, 'one model session is reused after a failed tile');

const source = new ImageData(new Uint8ClampedArray([51, 127, 204, 255]), 1, 1);
const repaired = await inpaintWithModel(source, new Uint8Array([255]), session.run, { tile: 1, feather: 0 });
assert.deepEqual([...repaired.imageData.data], [204, 128, 51, 255], 'blending retains feather weights after tile inputs transfer');

let unblock;
blockRun = new Promise(resolve => { unblock = resolve; });
const runMessagesBeforeQueue = messages.filter(message => message.type === 'run').length;
const first = session.run(image, mask, 1), second = session.run(image, mask, 1);
let current = true;
const cancelled = session.run(image, mask, 1, { shouldContinue: () => current });
const cancelledOutcome = assert.rejects(cancelled, { name: 'AbortError' });
await Promise.resolve();
current = false;
const release = session.release();
assert.equal(release, session.release(), 'repeated release waits for the same cleanup');
await assert.rejects(session.run(image, mask, 1), /released/);
assert.equal(worker.terminated, undefined, 'release waits for accepted tile work');
unblock();
await first; await second; await release;
await cancelledOutcome;
assert.equal(messages.filter(message => message.type === 'run').length, runMessagesBeforeQueue + 2,
  'stale queued tile never reaches the worker');
assert.equal(peakActive, 1); assert.equal(releases, 1); assert.equal(worker.terminated, true);
assert.equal(messages.filter(message => message.type === 'initialize').length, 1);

let timedWorker;
await assert.rejects(createInpaintWorkerSession(bytes, {}, { timeoutMs: 5, workerFactory: () => announceReady(timedWorker = {
  postMessage() {}, terminate() { this.terminated = true; }
}) }), error => /timed out/.test(error.message) && error.code !== 'WORKER_UNAVAILABLE');
assert.equal(timedWorker.terminated, true);
await assert.rejects(createInpaintWorkerSession(bytes, {}, { workerFactory: () => { throw new Error('blocked'); } }), { code: 'WORKER_UNAVAILABLE' });
let crashedWorker;
await assert.rejects(createInpaintWorkerSession(bytes, {}, { workerFactory: () => announceReady(crashedWorker = {
  postMessage() { queueMicrotask(() => this.onerror()); }, terminate() { this.terminated = true; }
}) }), error => /crashed/.test(error.message) && error.code !== 'WORKER_UNAVAILABLE');
assert.equal(crashedWorker.terminated, true);

// Exercise the public fallback path with real client bootstrap behavior. No
// model bytes may leave the caller before a failed worker announces readiness.
for (const failure of ['error', 'messageerror', 'timeout', 'malformed']) {
  let startupWorker, fallbackCalls = 0, posted = 0;
  const originalBytes = new Uint8Array([7, 8, 9]).buffer;
  const options = { prefer: 'wasm', warmUp: false };
  const fallbackSession = { provider: 'wasm', run() {}, release() {} };
  const actual = await createInpaintSessionInWorker(originalBytes, options, {
    workerSupported: true,
    createWorkerSession: (model, settings) => createInpaintWorkerSession(model, settings, {
      startupTimeoutMs: 5,
      workerFactory: () => {
        startupWorker = { postMessage() { posted++; }, terminate() { this.terminated = true; } };
        if (failure === 'error' || failure === 'messageerror') queueMicrotask(() => startupWorker[`on${failure}`]());
        if (failure === 'malformed') queueMicrotask(() => startupWorker.onmessage({ data: null }));
        return startupWorker;
      }
    }),
    createMainThreadSession: async (model, settings) => {
      fallbackCalls++;
      assert.equal(model, originalBytes, 'fallback receives the original, attached model buffer');
      assert.deepEqual([...new Uint8Array(model)], [7, 8, 9]);
      assert.equal(settings, options, 'fallback retains the requested backend and warmup options');
      return fallbackSession;
    }
  });
  assert.equal(actual, fallbackSession);
  assert.equal(fallbackCalls, 1, `${failure} during bootstrap invokes fallback exactly once`);
  assert.equal(posted, 0, 'unready workers never receive the model');
  assert.equal(startupWorker.terminated, true);
  assert.equal(startupWorker.onmessage, null);
  assert.equal(startupWorker.onerror, null);
}

// Readiness separates runtime/model failures from unavailable-worker failures:
// a malformed model, stalled initialization, or crash after ready must surface.
for (const failure of ['model', 'timeout', 'crash']) {
  let modelWorker, fallbackCalls = 0;
  await assert.rejects(createInpaintSessionInWorker(bytes, {}, {
    workerSupported: true,
    createWorkerSession: (model, settings) => createInpaintWorkerSession(model, settings, {
      timeoutMs: 5,
      workerFactory: () => announceReady(modelWorker = {
        postMessage(message) {
          if (failure === 'model') queueMicrotask(() => this.onmessage({ data: { id: message.id, error: 'Invalid MI-GAN model' } }));
          if (failure === 'crash') queueMicrotask(() => this.onerror());
        },
        terminate() { this.terminated = true; }
      })
    }),
    createMainThreadSession: async () => { fallbackCalls++; throw new Error('unexpected fallback'); }
  }), error => error.code !== 'WORKER_UNAVAILABLE' && /Invalid MI-GAN model|timed out|crashed/.test(error.message));
  assert.equal(fallbackCalls, 0, `${failure} after ready must not run main-thread inference`);
  assert.equal(modelWorker.terminated, true);
  assert.equal(bytes.byteLength, 3);
}

console.log('AI worker session transfer/queue/cancel/release passed; bootstrap failures fall back while model failures surface');

import assert from 'node:assert/strict';
import { createInpaintWorkerSession } from './aiInpaintWorkerClient.js';
import { createInpaintWorkerProcessor } from '../workers/aiInpaintWorkerProcessor.js';
import { inpaintWithModel } from './aiInpaint.js';
globalThis.ImageData ||= class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
const bytes = new Uint8Array([1, 2, 3]).buffer;
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
const session = await createInpaintWorkerSession(bytes, { prefer: 'wasm' }, { workerFactory: () => worker });
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
await assert.rejects(createInpaintWorkerSession(bytes, {}, { timeoutMs: 5, workerFactory: () => timedWorker = {
  postMessage() {}, terminate() { this.terminated = true; }
} }), /timed out/);
assert.equal(timedWorker.terminated, true);
await assert.rejects(createInpaintWorkerSession(bytes, {}, { workerFactory: () => { throw new Error('blocked'); } }), { code: 'WORKER_UNAVAILABLE' });
let crashedWorker;
await assert.rejects(createInpaintWorkerSession(bytes, {}, { workerFactory: () => crashedWorker = {
  postMessage() { queueMicrotask(() => this.onerror()); }, terminate() { this.terminated = true; }
} }), /crashed/);
assert.equal(crashedWorker.terminated, true);
console.log('AI worker session reuses model, transfers exclusive tiles, serializes runs and cleans timeout/release/crash');

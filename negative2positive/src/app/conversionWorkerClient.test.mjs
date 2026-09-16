import assert from 'node:assert/strict';
import { createConversionWorkerClient, WORKER_CRASHED, WORKER_UNAVAILABLE, CONVERSION_FAILED } from './conversionWorkerClient.js';
import { isLargeImage } from './imageMemoryBudget.js';
globalThis.ImageData = class {
  constructor(data, width, height) { Object.assign(this, { data, width, height }); }
};
class FakeWorker {
  messages = [];
  postMessage(message) { this.messages.push(structuredClone(message)); }
  terminate() { this.terminated = true; }
  complete(type = 'result') {
    const message = this.messages.at(-1);
    this.onmessage({ data: { id: message.id, type, width: 1, height: 1, rgba: new Uint8ClampedArray([1, 2, 3, 255]).buffer } });
  }
}
const workers = [];
const client = createConversionWorkerClient({ cacheInput: true, workerFactory: () => { const w = new FakeWorker(); workers.push(w); return w; } });
const input = new ImageData(new Uint8ClampedArray([10, 20, 30, 255]), 1, 1);
const analysis = new ImageData(input.data.slice(), 1, 1);
const request = { imageData: input, settings: {}, options: { analysisImageData: analysis } };
let promise = client(request);
workers[0].complete(); await promise;
assert.equal(workers[0].messages[0].reuseSource, false);
promise = client(request);
assert.equal(workers[0].messages.at(-1).reuseSource, true);
assert.equal(workers[0].messages.at(-1).reuseAnalysis, true);
assert.ok(!('rgba' in workers[0].messages.at(-1)));
assert.ok(!('analysisImageData' in workers[0].messages.at(-1).options));
workers[0].complete(); await promise;
promise = client({ ...request, options: {} });
assert.equal(workers[0].messages.at(-1).reuseAnalysis, false);
workers[0].complete(); await promise;
assert.equal(input.data.byteLength, 4, '元画像は転送で切り離さない');
promise = client(request);
workers[0].onerror(new Error('test crash'));
await assert.rejects(promise, { code: WORKER_CRASHED });
promise = client(request);
assert.equal(workers[1].messages[0].reuseSource, false);
assert.equal(workers[1].messages[0].reuseAnalysis, false);
workers[0].onerror(new Error('late error'));
assert.ok(!workers[1].terminated);
workers[1].complete(); await promise;
promise = client(request); workers[1].complete('error');
await assert.rejects(promise, { code: CONVERSION_FAILED });
const buffer = new Uint16Array([999, 1, 2, 3, 65535, 999]);
const subview = { ...input, __image16: { data: buffer.subarray(1, 5), width: 1, height: 1 } };
promise = client({ ...request, imageData: subview });
assert.deepEqual([...new Uint16Array(workers[1].messages.at(-1).image16)], [1, 2, 3, 65535]);
workers[1].complete(); await promise;
const fullWorker = new FakeWorker();
const fullClient = createConversionWorkerClient({ workerFactory: () => fullWorker });
const fullPromise = fullClient(request);
promise = client(request);
workers[1].complete(); await promise;
assert.equal(fullWorker.messages.length, 1, 'プレビューは原寸処理の完了を待たない');
fullWorker.complete(); await fullPromise;
const unavailable = createConversionWorkerClient({ workerFactory: () => { throw new Error('blocked'); } });
await assert.rejects(unavailable(request), { code: WORKER_UNAVAILABLE });
assert.equal(isLargeImage({ width: 4000, height: 4000 }), false);
assert.equal(isLargeImage({ width: 9536, height: 6336 }), true);
// A fake payload exercises lifetime only; no large allocation is needed.
const largeWorkers = [];
const largeClient = createConversionWorkerClient({ workerFactory: () => {
  const w = new FakeWorker(); largeWorkers.push(w); return w;
} });
const largeRequest = { ...request, imageData: { ...input, width: 9536, height: 6336 } };
let largeResult = largeClient(largeRequest);
largeWorkers[0].complete();
assert.equal((await largeResult).data[0], 1, 'result remains usable after worker release');
assert.equal(largeWorkers[0].terminated, true, 'large conversion releases its source/cache heap');
largeResult = largeClient(largeRequest);
assert.equal(largeWorkers.length, 2, 'next large export starts a fresh worker');
largeWorkers[1].complete(); await largeResult;
const smallResult = largeClient(request);
largeWorkers[2].complete(); await smallResult;
assert.equal(largeWorkers[2].terminated, undefined, 'small conversions retain the reusable worker');
console.log('conversionWorkerClient: 入力再利用・参照解除・再起動・独立キュー・部分配列を検証');

// ---- pool: least-busy dispatch, retained workers, dispose ----
{
  const { createConversionWorkerPool } = await import('./conversionWorkerClient.js');
  const poolWorkers = [];
  const pool = createConversionWorkerPool({ size: 2, workerFactory: () => { const w = new FakeWorker(); poolWorkers.push(w); return w; } });
  assert.equal(pool.size, 2);
  const big = { ...input, width: 9536, height: 6336 };
  const a = pool({ imageData: big, settings: {}, options: {} });
  const b = pool({ imageData: big, settings: {}, options: {} });
  const c = pool({ imageData: big, settings: {}, options: {} });
  assert.equal(poolWorkers.length, 2, 'two lanes start two workers');
  assert.equal(poolWorkers[0].messages.length, 2, 'third request joins the least-busy lane (tie -> first)');
  assert.equal(poolWorkers[1].messages.length, 1);
  const answer = (w, message, value) => w.onmessage({ data: { id: message.id, type: 'result', width: 1, height: 1, rgba: new Uint8ClampedArray([value, value, value, 255]).buffer } });
  answer(poolWorkers[0], poolWorkers[0].messages[0], 1); answer(poolWorkers[1], poolWorkers[1].messages[0], 2);
  assert.equal((await a).data[0], 1); assert.equal((await b).data[0], 2);
  assert.equal(poolWorkers[0].terminated, undefined, 'a batch lane keeps its worker after a large frame');
  assert.equal(poolWorkers[1].terminated, undefined);
  answer(poolWorkers[0], poolWorkers[0].messages[1], 9);
  assert.equal((await c).data[0], 9);
  const d = pool({ imageData: big, settings: {}, options: {} });
  assert.equal(poolWorkers.length, 2, 'no new worker for the next frame');
  pool.dispose();
  await assert.rejects(d, { code: WORKER_CRASHED });
  assert.equal(poolWorkers[0].terminated, true);
  assert.equal(poolWorkers[1].terminated, true);
  await assert.rejects(pool({ imageData: input, settings: {}, options: {} }), { code: WORKER_UNAVAILABLE });
  console.log('conversionWorkerPool: least-busy dispatch, retained lanes, dispose verified');
}

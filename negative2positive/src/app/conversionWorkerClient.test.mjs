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
{
  // #233: a retaining preview keeps its 16-bit plane in the worker until the
  // caller commits that exact result.
  const retainWorkers = [];
  const retainClient = createConversionWorkerClient({ cacheInput: true, workerFactory: () => { const w = new FakeWorker(); retainWorkers.push(w); return w; } });
  const w0 = () => retainWorkers[0];
  const reply = (data) => w0().onmessage({ data });
  let pendingResult = retainClient({ ...request, options: { retain16: true, histogramSamples: 4 } });
  const posted = w0().messages.at(-1);
  assert.equal(posted.retain16, true);
  reply({ id: posted.id, type: 'result', width: 1, height: 1, rgba: new Uint8ClampedArray([1, 2, 3, 255]).buffer, retained16: true,
    histogram: { width: 1, height: 1, rgba: new Uint8ClampedArray([4, 5, 6, 255]).buffer, image16: new Uint16Array([1028, 1285, 1542, 65535]).buffer } });
  const retainedFrame = await pendingResult;
  assert.equal(retainedFrame.__retained16, true);
  assert.equal(retainedFrame.__image16, undefined);
  assert.deepEqual([...retainedFrame.__histogramSample.__image16.data], [1028, 1285, 1542, 65535]);
  const committing = retainClient.commit(retainedFrame);
  const commitMessage = w0().messages.at(-1);
  assert.deepEqual([commitMessage.type, commitMessage.resultId], ['commit', posted.id]);
  reply({ id: commitMessage.id, type: 'committed', resultId: posted.id, image16: new Uint16Array([7, 8, 9, 65535]).buffer });
  assert.deepEqual([...await committing], [7, 8, 9, 65535]);
  assert.equal(await retainClient.commit(retainedFrame), null, 'a plane is committed once');
  assert.equal(w0().messages.at(-1).type, 'commit', 'no second commit is posted');
  assert.equal(await retainClient.commit({ width: 1, height: 1 }), null, 'an ordinary result has nothing to commit');

  pendingResult = retainClient({ ...request, options: { retain16: true } });
  const second = w0().messages.at(-1);
  reply({ id: second.id, type: 'result', width: 1, height: 1, rgba: new Uint8ClampedArray(4).buffer, retained16: true });
  const lostFrame = await pendingResult;
  const gone = retainClient.commit(lostFrame);
  const goneMessage = w0().messages.at(-1);
  reply({ id: goneMessage.id, type: 'committed', resultId: second.id, image16: null });
  assert.equal(await gone, null, 'a reused plane commits as null');

  pendingResult = retainClient({ ...request, options: { retain16: true } });
  const third = w0().messages.at(-1);
  reply({ id: third.id, type: 'result', width: 1, height: 1, rgba: new Uint8ClampedArray(4).buffer, retained16: true });
  const orphan = await pendingResult;
  w0().onerror(new Error('test crash'));
  assert.equal(await retainClient.commit(orphan), null, 'a crashed worker took the plane with it');
}
console.log('conversionWorkerClient: 入力再利用・参照解除・再起動・独立キュー・部分配列・16bit 保持と確定を検証');

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

// ---- preview lane: unchanged dodge-and-burn strokes are posted once ----
{
  const laneWorkers = [];
  const lane = createConversionWorkerClient({ cacheInput: true, workerFactory: () => { const w = new FakeWorker(); laneWorkers.push(w); return w; } });
  const strokes = { strokes: [{ stops: 1, size: 0.1, feather: 0.5, points: [{ x: 0.5, y: 0.5, p: 1 }] }] };
  const send = async (settings, crash = false) => {
    const pending = lane({ imageData: input, settings, options: {} });
    const worker = laneWorkers.at(-1), message = worker.messages.at(-1);
    if (crash) { worker.onerror(new Error('crash')); await assert.rejects(pending); }
    else { worker.complete(); await pending; }
    return message;
  };
  let message = await send({ exposure: 1, localExposure: strokes });
  assert.equal(message.reuseLocalExposure, false);
  assert.deepEqual(message.settings.localExposure, strokes, 'the first frame carries the strokes');
  message = await send({ exposure: 2, localExposure: strokes });
  assert.equal(message.reuseLocalExposure, true);
  assert.equal(message.settings.localExposure, null, 'later frames do not clone them again');
  assert.equal(message.settings.exposure, 2);
  message = await send({ exposure: 3, localExposure: structuredClone(strokes) });
  assert.equal(message.reuseLocalExposure, false, 'a replaced stroke set is posted');
  message = await send({ exposure: 4, localExposure: null });
  assert.equal(message.reuseLocalExposure, false);
  assert.equal(message.settings.localExposure, null);
  const kept = { strokes: [] };
  await send({ localExposure: kept });
  await send({ localExposure: kept }, true);
  message = await send({ localExposure: kept });
  assert.equal(laneWorkers.length, 2);
  assert.equal(message.reuseLocalExposure, false, 'a new worker receives the strokes again');
  const full = [];
  const fullLane = createConversionWorkerClient({ workerFactory: () => { const w = new FakeWorker(); full.push(w); return w; } });
  for (let i = 0; i < 2; i++) {
    const pending = fullLane({ imageData: input, settings: { localExposure: strokes }, options: {} });
    assert.equal(full[0].messages.at(-1).reuseLocalExposure, undefined, 'full-resolution requests always carry their strokes');
    assert.deepEqual(full[0].messages.at(-1).settings.localExposure, strokes);
    full[0].complete(); await pending;
  }
  console.log('conversionWorkerClient: preview lane posts unchanged dodge-and-burn strokes once per worker');
}

import assert from 'node:assert/strict';
import { createConversionWorkerClient, WORKER_CRASHED, WORKER_UNAVAILABLE, CONVERSION_FAILED, WORKER_ABORTED } from './conversionWorkerClient.js';
import { isLargeImage } from './imageMemoryBudget.js';
globalThis.ImageData = class {
  constructor(data, width, height) { Object.assign(this, { data, width, height }); }
};
class FakeWorker {
  messages = [];
  postMessage(message, transfers = []) { this.messages.push(structuredClone(message)); this.lastTransfers = transfers; }
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
// The import warm-up starts the worker the first conversion then uses.
let warm = client.warmUp();
assert.equal(workers.length, 1);
assert.deepEqual(workers[0].messages[0], { type: 'warm-up', id: 1 });
workers[0].onmessage({ data: { type: 'ready', id: 1 } });
assert.equal(await warm, true);
let promise = client(request);
workers[0].complete(); await promise;
assert.equal(workers.length, 1, 'the conversion reuses the warmed worker');
assert.equal(workers[0].messages[1].reuseSource, false);
// A warm-up while a photo is open leaves the cached preview source alone.
warm = client.warmUp();
workers[0].onmessage({ data: { type: 'ready', id: workers[0].messages.at(-1).id } });
assert.equal(await warm, true);
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
assert.equal(await unavailable.warmUp(), false, 'a blocked worker never rejects the warm-up');
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

// ---- live loupe (#261): its recipe is posted once per worker, frames are
// handed over rather than copied, and dispose() releases the worker ----
{
  class TransferWorker extends FakeWorker {
    postMessage(message, transfer = []) {
      this.transfers.push(transfer.length);
      this.messages.push(structuredClone(message, { transfer }));
    }
    transfers = [];
  }
  const loupeWorkers = [];
  const loupe = createConversionWorkerClient({ workerFactory: () => { const w = new TransferWorker(); loupeWorkers.push(w); return w; } });
  const router = { filmType: 'color', exposure: 3 };
  const adjust = { cyan: 4, curves: { r: new Uint8Array(256), g: new Uint8Array(256), b: new Uint8Array(256) } };
  const frame = () => new ImageData(new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]), 2, 1);
  const send = async (recipe, { crash = false } = {}) => {
    const image = frame();
    const pending = loupe({ imageData: image, settings: router, adjust, recipe, options: { preview: true }, transfer: true });
    const worker = loupeWorkers.at(-1), message = worker.messages.at(-1);
    if (crash) { worker.onerror(new Error('crash')); await assert.rejects(pending, { code: WORKER_CRASHED }); }
    else { worker.complete(); await pending; }
    return { message, image, worker };
  };
  const recipeA = { name: 'A' }, recipeB = { name: 'B' };
  let { message, image, worker } = await send(recipeA);
  assert.equal(message.cacheRecipe, true);
  assert.deepEqual(message.settings, router);
  assert.deepEqual(message.adjust.curves.r, adjust.curves.r);
  assert.equal(message.adjust.cyan, 4);
  assert.equal(worker.transfers.at(-1), 1, 'the frame is transferred');
  assert.equal(image.data.byteLength, 0, 'and detached from the caller');
  ({ message } = await send(recipeA));
  assert.equal(message.reuseRecipe, true, 'an unchanged recipe stays in the worker');
  assert.ok(!('settings' in message) && !('adjust' in message) && !message.cacheRecipe);
  ({ message } = await send(recipeB));
  assert.equal(message.cacheRecipe, true, 'a rebuilt recipe is posted');
  assert.equal(message.reuseRecipe, undefined);
  await send(recipeB, { crash: true });
  ({ message } = await send(recipeB));
  assert.equal(loupeWorkers.length, 2);
  assert.equal(message.cacheRecipe, true, 'a new worker receives the recipe again');
  const held = loupe({ imageData: frame(), settings: router, adjust, recipe: recipeB, options: {}, transfer: true });
  loupe.dispose();
  await assert.rejects(held, { code: WORKER_CRASHED });
  assert.equal(loupeWorkers[1].terminated, true, 'dispose terminates the loupe worker');
  // Without a recipe every request carries its settings and adjustments.
  const plain = createConversionWorkerClient({ workerFactory: () => { const w = new TransferWorker(); loupeWorkers.push(w); return w; } });
  const copy = frame();
  const request = plain({ imageData: copy, settings: router, adjust, options: {} });
  const plainMessage = loupeWorkers.at(-1).messages.at(-1);
  assert.ok(!plainMessage.cacheRecipe && !plainMessage.reuseRecipe);
  assert.equal(plainMessage.adjust.cyan, 4);
  assert.equal(loupeWorkers.at(-1).transfers.at(-1), 0, 'without transfer the frame is copied');
  assert.equal(copy.data.byteLength, 8);
  loupeWorkers.at(-1).complete(); await request;
  console.log('conversionWorkerClient: loupe recipe posted once per worker, frames transferred, dispose releases the worker');
}

{
  // #237: an exact render that is superseded aborts. The worker it had to
  // itself stops; the caller sees WORKER_ABORTED, never a crash.
  const exact = [];
  const lane = createConversionWorkerClient({ workerFactory: () => { const w = new FakeWorker(); exact.push(w); return w; } });
  const large = new ImageData(new Uint8ClampedArray(4), 9536, 6336);
  let controller = new AbortController();
  let pending = lane({ imageData: large, settings: {}, options: {}, signal: controller.signal });
  assert.ok(!('signal' in exact[0].messages[0]), 'the signal is not posted');
  controller.abort();
  await assert.rejects(pending, { code: WORKER_ABORTED });
  assert.equal(exact[0].terminated, true, 'the idle worker stops at once');
  // The next request starts a fresh worker; a late reply of the old one is dropped.
  controller = new AbortController();
  pending = lane({ imageData: large, settings: {}, options: {}, signal: controller.signal });
  assert.equal(exact.length, 2);
  exact[1].complete();
  await pending;
  controller.abort();
  // Already aborted: nothing is posted.
  await assert.rejects(lane({ imageData: large, settings: {}, options: {}, signal: controller.signal }), { code: WORKER_ABORTED });
  assert.equal(exact.length, 2);
  // A worker that still owes another caller finishes; only this request is dropped.
  const shared = [];
  const sharedLane = createConversionWorkerClient({ workerFactory: () => { const w = new FakeWorker(); shared.push(w); return w; } });
  const other = sharedLane({ imageData: input, settings: {}, options: {} });
  const abortable = new AbortController();
  const dropped = sharedLane({ imageData: input, settings: {}, options: {}, signal: abortable.signal });
  abortable.abort();
  await assert.rejects(dropped, { code: WORKER_ABORTED });
  assert.ok(!shared[0].terminated);
  const firstId = shared[0].messages[0].id;
  shared[0].onmessage({ data: { id: firstId, type: 'result', width: 1, height: 1, rgba: new Uint8ClampedArray(4).buffer } });
  await other;
  console.log('conversionWorkerClient: superseded exact renders abort with WORKER_ABORTED and stop an idle worker');
}

// #239: prepare and analyze go through the same cached-source contract as frames and
// hand back typed arrays; the source, sample and strokes are sent only when changed.
{
  const previewWorkers = [];
  const preview = createConversionWorkerClient({ cacheInput: true, workerFactory: () => { const w = new FakeWorker(); previewWorkers.push(w); return w; } });
  const image = new ImageData(new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]), 2, 1);
  const sample = new ImageData(image.data.slice(), 2, 1);
  const strokes = { strokes: [{ stops: 1 }] };
  const frame = { imageData: image, settings: { localExposure: strokes }, options: { analysisImageData: sample } };
  const worker = () => previewWorkers[0];
  let pending = preview.prepare(frame);
  let message = worker().messages.at(-1);
  assert.equal(message.type, 'prepare');
  assert.equal(message.reuseSource, false);
  assert.ok(message.rgba && message.options.analysisImageData);
  worker().onmessage({ data: { id: message.id, type: 'prepared', width: 2, height: 1,
    pristine: new Uint16Array(8).fill(7).buffer, stops: new Float32Array([0, 1]).buffer,
    histogram: { width: 1, height: 1, image16: new Uint16Array([1, 2, 3, 4]).buffer, stops: null } } });
  const prepared = await pending;
  assert.ok(prepared.pristine instanceof Uint16Array && prepared.pristine[0] === 7);
  assert.ok(prepared.stops instanceof Float32Array && prepared.stops[1] === 1);
  assert.deepEqual([...prepared.histogram.data], [1, 2, 3, 4]);
  assert.equal(prepared.histogram.stops, null);

  pending = preview.analyze(frame, 'key-1');
  message = worker().messages.at(-1);
  assert.equal(message.type, 'analyze');
  assert.equal(message.key, 'key-1');
  assert.equal(message.reuseSource, true);
  assert.equal(message.reuseAnalysis, true);
  assert.equal(message.reuseLocalExposure, true);
  assert.ok(!('rgba' in message) && !('analysisImageData' in message.options));
  worker().onmessage({ data: { id: message.id, type: 'analyzed', key: 'key-1', channelData: [{ whitePointOrigin: 1 }], autoColor: null, positiveAnalysis: { gain: 1, wb: [1, 1, 1] } } });
  assert.deepEqual(await pending, { key: 'key-1', channelData: [{ whitePointOrigin: 1 }], autoColor: null, positiveAnalysis: { gain: 1, wb: [1, 1, 1] } });

  // A frame after them reuses everything as well.
  pending = preview(frame);
  message = worker().messages.at(-1);
  assert.equal(message.type, 'convert');
  assert.equal(message.reuseSource, true);
  worker().complete(); await pending;

  pending = preview.analyze(frame, 'key-2');
  worker().complete('error');
  await assert.rejects(pending, { code: CONVERSION_FAILED });
  console.log('conversionWorkerClient: prepare/analyze share the preview contract');
}

// #248: a display target sends the level once, then only the size; the
// auto-WB sample, the prebuilt display preview and the display negative come
// back as ImageData; the uncached resample and detail regions leave the cached
// level alone.
{
  const previewWorkers = [];
  const preview = createConversionWorkerClient({ cacheInput: true, workerFactory: () => { const w = new FakeWorker(); previewWorkers.push(w); return w; } });
  const worker = () => previewWorkers[0];
  const level = { width: 4, height: 2, __image16: { width: 4, height: 2, data: new Uint16Array(32).fill(9) } };
  const geometry = { sourceWidth: 4, sourceHeight: 2, k: 1 };
  const frame = (width) => ({ imageData: level, display: { target: { width, height: 1 }, geometry }, settings: {}, options: {},
    wbSample: width === 2 ? { geometry } : null });
  let pending = preview(frame(2));
  let message = worker().messages.at(-1);
  assert.equal(message.reuseSource, false);
  assert.ok(message.image16 && !message.rgba, 'the level goes once as its 16-bit plane');
  assert.deepEqual(message.display.target, { width: 2, height: 1 });
  assert.deepEqual(message.wbSample, { geometry });
  worker().onmessage({ data: { id: message.id, type: 'result', width: 2, height: 1, rgba: new Uint8ClampedArray(8).buffer,
    wbSample: { width: 1, height: 1, rgba: new Uint8ClampedArray([1, 2, 3, 255]).buffer },
    displayPreview: { width: 1, height: 1, rgba: new Uint8ClampedArray([4, 5, 6, 255]).buffer, image16: new Uint16Array([7, 8, 9, 65535]).buffer,
      histogram: { width: 1, height: 1, rgba: new Uint8ClampedArray([4, 5, 6, 255]).buffer } } } });
  const result = await pending;
  assert.deepEqual([...result.__wbSample.data], [1, 2, 3, 255]);
  assert.deepEqual([...result.__displayPreview.__image16.data], [7, 8, 9, 65535]);
  assert.deepEqual([...result.__displayPreview.__histogramSample.data], [4, 5, 6, 255]);
  // Another size: no pixels.
  pending = preview(frame(3));
  message = worker().messages.at(-1);
  assert.equal(message.reuseSource, true);
  assert.ok(!('image16' in message) && !('rgba' in message), 'a new display size sends no pixels');
  worker().complete(); await pending;
  // The display negative for the repaired preview.
  pending = preview.displayNegative(frame(2));
  message = worker().messages.at(-1);
  assert.equal(message.type, 'displayNegative');
  assert.equal(message.reuseSource, true);
  worker().onmessage({ data: { id: message.id, type: 'displayNegative', width: 2, height: 1,
    image16: new Uint16Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer, rgba: new Uint8ClampedArray(8).fill(1).buffer } });
  const negative = await pending;
  assert.equal(negative.width, 2);
  assert.deepEqual([...negative.__image16.data], [1, 2, 3, 4, 5, 6, 7, 8]);
  // The uncached resample: no cache fields, the 16-bit plane only.
  const full = new ImageData(new Uint8ClampedArray(16), 2, 2);
  full.__image16 = { width: 2, height: 2, data: new Uint16Array(16).fill(3) };
  pending = preview.resample(full, { width: 1, height: 1 });
  message = worker().messages.at(-1);
  assert.equal(message.type, 'resample');
  assert.ok(!('cacheInput' in message) && !('reuseSource' in message) && message.image16 && !message.rgba);
  worker().onmessage({ data: { id: message.id, type: 'resampled', width: 1, height: 1, rgba: new Uint8ClampedArray(4).buffer,
    image16: new Uint16Array([3, 3, 3, 3]).buffer } });
  assert.deepEqual([...(await pending).__image16.data], [3, 3, 3, 3]);
  assert.equal(full.__image16.data.length, 16, 'the frame stays the caller\'s');
  // A detail region transfers its rows and leaves the cache alone.
  const rows = new Uint16Array(8).fill(5);
  pending = preview.roi({ settings: {}, base: { levelWidth: 4, levelHeight: 2, display: null }, rows,
    region: { x: 0, y: 0, width: 2, height: 1, outWidth: 2, outHeight: 1, slotWidth: 256, slotHeight: 256 } });
  message = worker().messages.at(-1);
  assert.equal(message.type, 'roi');
  assert.ok(message.image16 && !('cacheInput' in message));
  assert.ok(worker().lastTransfers.includes(rows.buffer), 'the rows are transferred');
  worker().onmessage({ data: { id: message.id, type: 'roi', width: 2, height: 1, rgba: new Uint8ClampedArray(8).fill(2).buffer } });
  assert.deepEqual([...(await pending).data], [2, 2, 2, 2, 2, 2, 2, 2]);
  assert.equal(preview.holds(level), true, 'the worker keeps the level');
  assert.equal(preview.holds(full), false);
  pending = preview(frame(3));
  assert.equal(worker().messages.at(-1).reuseSource, true, 'the cached level survives the uncached requests');
  worker().complete(); await pending;
  console.log('conversionWorkerClient: display targets, WB sample, prebuilt previews, display negatives, resample and regions');
}

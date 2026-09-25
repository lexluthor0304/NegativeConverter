import assert from 'node:assert/strict';
import { createAutoFrameWorkerClient } from './autoFrameWorkerClient.js';
globalThis.ImageData = class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};
const source = new ImageData(new Uint8ClampedArray([1, 2, 3, 255]), 1, 1);
source.__image16 = { width: 1, height: 1, data: new Uint16Array([123, 456, 789, 65535]) };
let worker, count = 0;
const analyze = createAutoFrameWorkerClient({ workerFactory: () => {
  count++;
  return worker = {
    terminate() { this.terminated = true; },
    postMessage(message, transfers) {
      assert.notEqual(message.rgba.buffer, source.data.buffer);
      assert.notEqual(message.image16.buffer, source.__image16.data.buffer);
      assert.equal(transfers.length, 2);
      queueMicrotask(() => this.onmessage({ data: { id: message.id, result: {
        angle: 0, rotatedImageData: { width: 1, height: 1, data: message.rgba, image16: message.image16 },
      } } }));
    },
  };
} });
const result = await analyze(source, {});
assert.deepEqual(result.rotatedImageData.__image16.data, source.__image16.data);
assert.equal(source.data.byteLength, 4);
await analyze(source, {});
assert.equal(count, 1);
worker.postMessage = () => queueMicrotask(() => worker.onerror());
await assert.rejects(analyze(source, {}), /crashed/);
assert.equal(worker.terminated, true);
await analyze(source, {});
assert.equal(count, 2);
let timedWorker;
const timeout = createAutoFrameWorkerClient({ timeoutMs: 10, workerFactory: () => timedWorker = {
  postMessage() {}, terminate() { this.terminated = true; },
} });
await assert.rejects(timeout(source, {}), /timed out/);
assert.equal(timedWorker.terminated, true);

// A superseded activation aborts its requests: before posting nothing is
// copied or sent; once posted the promise settles at once, the late reply is
// ignored, and the worker is only released by its idle timer.
{
  const posted = [];
  let abortWorker;
  const client = createAutoFrameWorkerClient({ idleTimeoutMs: 5, workerFactory: () => abortWorker = {
    postMessage(message) { posted.push(message); }, terminate() { this.terminated = true; },
  } });
  const early = new AbortController();
  early.abort();
  await assert.rejects(client(source, {}, 'read-film-edge', { signal: early.signal }), { name: 'AbortError' });
  assert.equal(posted.length, 0, 'an aborted request never copies or posts the planes');
  const late = new AbortController();
  const running = client(source, {}, 'analyze-frame', { signal: late.signal });
  assert.equal(posted.length, 1);
  late.abort();
  await assert.rejects(running, { name: 'AbortError' });
  assert.equal(abortWorker.terminated, undefined, 'the shared worker is not terminated for an abort');
  abortWorker.onmessage({ data: { id: posted[0].id, result: { angle: 3 } } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(abortWorker.terminated, true, 'the idle timer still releases the worker after the ignored reply');
  const kept = new AbortController();
  const answered = client(source, {}, 'analyze-frame', { signal: kept.signal });
  posted.at(-1) && abortWorker.onmessage({ data: { id: posted.at(-1).id, result: { angle: 1 } } });
  assert.deepEqual(await answered, { angle: 1 });
  kept.abort();
}
// #245's analysis requests: the page's buffers are transferred as they are
// (no copy), an analysis error rejects that request only and keeps the warm
// worker, and a crash still rejects and releases it.
{
  let posted = null, created = 0, analysisWorker = null;
  const run = createAutoFrameWorkerClient({ workerFactory: () => {
    created++;
    return analysisWorker = {
      terminate() { this.terminated = true; },
      postMessage(message, transfers) {
        posted = { message, transfers };
        queueMicrotask(() => this.onmessage({ data: message.region.data[0] === 9
          ? { id: message.id, error: 'cv exception', taskError: true }
          : { id: message.id, result: { points: null } } }));
      },
    };
  } });
  const region = { width: 1, height: 1, data: new Uint8ClampedArray([1, 2, 3, 255]) };
  const result = await run.run('detect-crop-area', { region, left: 0 }, [region.data.buffer]);
  assert.deepEqual(result, { points: null });
  assert.equal(posted.message.type, 'detect-crop-area');
  assert.equal(posted.message.region.data.buffer, region.data.buffer, 'transferred, not copied');
  assert.deepEqual(posted.transfers, [region.data.buffer]);
  const failing = { width: 1, height: 1, data: new Uint8ClampedArray([9, 0, 0, 255]) };
  const error = await run.run('detect-crop-area', { region: failing }, []).then(() => null, e => e);
  assert.match(error.message, /cv exception/);
  assert.equal(error.workerReported, true);
  assert.notEqual(analysisWorker.terminated, true, 'an analysis error keeps the worker');
  await run.run('detect-crop-area', { region }, []);
  assert.equal(created, 1);
  analysisWorker.postMessage = () => queueMicrotask(() => analysisWorker.onerror());
  const crash = await run.run('detect-crop-area', { region }, []).then(() => null, e => e);
  assert.match(crash.message, /crashed/);
  assert.notEqual(crash.workerReported, true, 'a crash lets the page fall back');
  const broken = createAutoFrameWorkerClient({ workerFactory: () => { throw new Error('Worker is not defined'); } });
  await assert.rejects(broken.run('expired-spatial-maps', {}, []), /not defined/);
}
console.log('autoFrameWorkerClient tests passed');

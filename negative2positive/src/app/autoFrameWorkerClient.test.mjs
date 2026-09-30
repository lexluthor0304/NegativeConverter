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
// copied or sent; once posted the promise settles at once. A worker that owes
// nobody else is terminated (#243) so its plane copies go with it; one that
// still owes another request keeps running and the late reply is ignored.
{
  const posted = [];
  const spawned = [];
  const client = createAutoFrameWorkerClient({ idleTimeoutMs: 5, workerFactory: () => {
    const created = { postMessage(message) { posted.push({ message, worker: created }); }, terminate() { this.terminated = true; } };
    spawned.push(created);
    return created;
  } });
  const early = new AbortController();
  early.abort();
  await assert.rejects(client(source, {}, 'read-film-edge', { signal: early.signal }), { name: 'AbortError' });
  assert.equal(posted.length, 0, 'an aborted request never copies or posts the planes');
  assert.equal(client.abortReleases, 0);

  // The only pending request: the worker is terminated in the abort task.
  const only = new AbortController();
  const running = client(source, {}, 'analyze-frame', { signal: only.signal });
  assert.equal(posted.length, 1);
  assert.equal(client.alive, true);
  only.abort();
  assert.equal(spawned[0].terminated, true, 'a worker owing nobody else is terminated at once');
  assert.equal(client.alive, false);
  assert.equal(client.abortReleases, 1);
  await assert.rejects(running, { name: 'AbortError' });
  // A late reply of the terminated worker reaches nobody.
  spawned[0].onmessage?.({ data: { id: posted[0].message.id, result: { angle: 3 } } });

  // Another request is pending: this one is dropped, the worker keeps running.
  const other = client(source, {}, 'read-film-edge');
  const dropped = new AbortController();
  const superseded = client(source, {}, 'analyze-frame', { signal: dropped.signal });
  assert.equal(spawned.length, 2, 'the next request started a fresh worker');
  dropped.abort();
  await assert.rejects(superseded, { name: 'AbortError' });
  assert.equal(spawned[1].terminated, undefined, 'a worker that still owes a request keeps running');
  assert.equal(client.abortReleases, 1);
  spawned[1].onmessage({ data: { id: posted[2].message.id, result: { angle: 7 } } });
  spawned[1].onmessage({ data: { id: posted[1].message.id, result: { angle: 2 } } });
  assert.deepEqual(await other, { angle: 2 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(spawned[1].terminated, true, 'the idle timer still releases it after the ignored reply');

  const kept = new AbortController();
  const answered = client(source, {}, 'analyze-frame', { signal: kept.signal });
  posted.at(-1).worker.onmessage({ data: { id: posted.at(-1).message.id, result: { angle: 1 } } });
  assert.deepEqual(await answered, { angle: 1 });
  kept.abort();
  assert.equal(client.abortReleases, 1, 'an abort after the answer releases nothing');
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
// The memory ledger's worker resident (#258): the OpenCV heap the worker
// reports with each reply, released by the idle check only when nothing is
// pending; the next request starts a fresh worker.
{
  const spawned = [];
  let reply = true;
  const client = createAutoFrameWorkerClient({ workerFactory: () => {
    const created = {
      postMessage(message) {
        if (!reply) return;
        queueMicrotask(() => this.onmessage({ data: { id: message.id, result: { ok: true }, heapBytes: 48 * 1024 * 1024 } }));
      },
      terminate() { this.terminated = true; }
    };
    spawned.push(created);
    return created;
  } });
  assert.equal(client.residentBytes, 0, 'no worker, nothing resident');
  assert.equal(client.releaseIdle(), false);
  await client.run('detect-crop-area', {}, []);
  assert.equal(client.residentBytes, 48 * 1024 * 1024);
  assert.equal(client.busy, false);
  reply = false;
  const hung = client.run('detect-crop-area', {}, []).catch(error => error);
  assert.equal(client.busy, true);
  assert.equal(client.releaseIdle(), false, 'a pending request keeps the worker');
  assert.notEqual(spawned[0].terminated, true);
  client.dispose();
  assert.match((await hung).message, /released/);
  reply = true;
  await client.run('detect-crop-area', {}, []);
  assert.equal(client.releaseIdle(), true);
  assert.equal(spawned[1].terminated, true);
  assert.equal(client.residentBytes, 0);
  assert.equal(client.alive, false);
  await client.run('detect-crop-area', {}, []);
  assert.equal(spawned.length, 3, 'respawned lazily');
  client.dispose();
}
// #252: while a roll analysis holds it, the worker outlives its idle timeout
// (a cold switch finds OpenCV warm); the last release re-arms the timer. The
// worker's request for the shared OpenCV module is answered, not taken for a
// reply.
{
  const spawned = [];
  const posted = [];
  const client = createAutoFrameWorkerClient({ idleTimeoutMs: 5, workerFactory: () => {
    const created = { postMessage(message) { posted.push(message); }, terminate() { this.terminated = true; } };
    spawned.push(created);
    return created;
  } });
  const releaseA = client.holdIdle();
  const releaseB = client.holdIdle();
  const answered = client(source, {}, 'read-film-edge');
  spawned[0].onmessage({ data: { type: 'opencv-module-request' } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(posted.at(-1), { type: 'opencv-module', opencvModule: null }, 'the module request is answered');
  spawned[0].onmessage({ data: { id: posted[0].id, result: { found: false } } });
  assert.deepEqual(await answered, { found: false });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(spawned[0].terminated, undefined, 'held: not released when idle');
  releaseA();
  releaseA();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(spawned[0].terminated, undefined, 'another hold remains');
  releaseB();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(spawned[0].terminated, true, 'the last release re-arms the idle release');
  // The memory idle check (#258) does not release a held worker either.
  const hold = client.holdIdle();
  const warm = client(source, {}, 'read-film-edge');
  spawned[1].onmessage({ data: { id: posted.at(-1).id, result: { found: true } } });
  assert.deepEqual(await warm, { found: true });
  assert.equal(client.held, true);
  assert.equal(client.releaseIdle(), false, 'held by a roll analysis');
  assert.equal(spawned[1].terminated, undefined);
  hold();
  assert.equal(client.held, false);
  assert.equal(client.releaseIdle(), true, 'released once the hold ends');
  assert.equal(spawned[1].terminated, true);
}
// #252 part 4: the shared worker's two detection helpers. Started next to a
// running worker, each gets a port and a warm-up, the worker gets the other
// ends; they go after helperIdleMs without requests, with the worker, or
// when one fails (the worker is told, and detects serially).
{
  const spawned = [], helpers = [];
  const make = kind => () => {
    const created = { kind, messages: [], postMessage(message, transfer) { this.messages.push({ message, transfer }); }, terminate() { this.terminated = true; } };
    (kind === 'a' ? spawned : helpers).push(created);
    return created;
  };
  const client = createAutoFrameWorkerClient({ idleTimeoutMs: 1000, helperIdleMs: 15, workerFactory: make('a'), helperFactory: make('h') });
  assert.equal(client.warmHelpers(), false, 'no worker yet: nothing to connect to');
  const warming = client(source, {}, 'warm-up');
  assert.equal(client.warmHelpers(), true);
  assert.equal(helpers.length, 2);
  assert.equal(client.warmHelpers(), true, 'a connected set is reused');
  assert.equal(helpers.length, 2);
  const handed = spawned[0].messages.find(entry => entry.message.type === 'helpers');
  assert.equal(handed.message.ports.length, 2);
  assert.deepEqual(handed.transfer, handed.message.ports, 'the ports are transferred');
  for (const helper of helpers) {
    assert.deepEqual(helper.messages.map(entry => entry.message.type), ['port', 'warm-up']);
    assert.deepEqual(helper.messages[0].transfer, [helper.messages[0].message.port]);
  }
  // A helper's request for the compiled OpenCV module is answered.
  helpers[0].onmessage({ data: { type: 'opencv-module-request' } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(helpers[0].messages.at(-1).message.type, 'opencv-module');
  spawned[0].onmessage({ data: { id: spawned[0].messages[0].message.id, result: { ready: true } } });
  await warming;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(helpers.every(helper => helper.terminated), 'released after the idle period');
  assert.deepEqual(spawned[0].messages.at(-1).message, { type: 'helpers', ports: [] }, 'the worker detects serially again');
  assert.equal(client.helpersAlive, false);
  // A failing helper releases both.
  assert.equal(client.warmHelpers(), true);
  helpers[2].onerror({ message: 'boom', preventDefault() {} });
  assert.ok(helpers[2].terminated && helpers[3].terminated);
  assert.equal(client.helpersAlive, false);
  // They go with the worker.
  assert.equal(client.warmHelpers(), true);
  client.dispose();
  assert.ok(helpers[4].terminated && helpers[5].terminated);
  assert.equal(client.helperStarts, 3);
  // Without a factory there are none.
  const plain = createAutoFrameWorkerClient({ workerFactory: make('a') });
  void plain(source, {}, 'warm-up').catch(() => {});
  assert.equal(plain.warmHelpers(), false);
  plain.dispose();
}
console.log('autoFrameWorkerClient tests passed');

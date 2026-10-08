// Standalone Node test for multiShotWorkerClient.js - run with:
// node negative2positive/src/app/multiShotWorkerClient.test.mjs
// Worker lifecycle with scripted fake workers: the handshake, transfers,
// termination on success, failure and Cancel, crash and silence handling,
// the main-thread fallback, the memory estimate and the progress model.
import assert from 'node:assert/strict';
import {
  createMultiShotMergeJob, createMultiShotProgress, estimateMultiShotWorkerBytes, multiShotFitsBudget
} from './multiShotWorkerClient.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// A scripted worker: `script(message, worker)` answers each posted message.
class ScriptedWorker {
  constructor({ hello = true, script = () => {} } = {}) {
    this.posted = [];
    this.terminated = 0;
    this.script = script;
    if (hello) setTimeout(() => this.emit({ type: 'hello' }), 0);
  }
  emit(data) { setTimeout(() => { if (!this.terminated) this.onmessage?.({ data }); }, 0); }
  crash() { setTimeout(() => this.onerror?.({ preventDefault() {} }), 0); }
  postMessage(message, transfer = []) {
    if (this.terminated) throw new Error('posted to a terminated worker');
    const copy = structuredClone(message, { transfer });
    this.posted.push(copy);
    this.script(copy, this);
  }
  terminate() { this.terminated++; }
}
const image = (width = 64, height = 48, plane = false) => {
  const data = new Uint8ClampedArray(width * height * 4).map((_, i) => (i * 37) & 255);
  const result = { width, height, data };
  if (plane) result.__image16 = { width, height, data: Uint16Array.from(data, (v) => v * 257) };
  return result;
};
// Acknowledges frames and answers a merge with a result.
const cooperative = (message, worker) => {
  if (message.type === 'frame') worker.emit({ type: 'progress', stage: 'frame', index: message.index, aligned: true });
  if (message.type === 'merge') {
    worker.emit({ type: 'progress', stage: 'merge', done: 1, total: 1 });
    worker.emit({ type: 'result', blob: 'PNG', width: 1, height: 1, used: 2, skipped: 0 });
  }
};

// Success: start after the handshake, transfers, one worker, terminated at the end.
{
  let worker;
  const events = [];
  const job = createMultiShotMergeJob({ mode: 'hdr', workerFactory: () => (worker = new ScriptedWorker({ script: cooperative })), onProgress: (e) => events.push(e.stage) });
  const first = image(64, 48, true);
  const second = image();
  await job.addFrame(0, first);
  await job.addFrame(1, second);
  assert.deepEqual(worker.posted.map((m) => m.type), ['start', 'frame', 'frame']);
  assert.equal(worker.posted[0].mode, 'hdr');
  assert.equal(first.__image16.data.length, 0, 'the 16-bit plane is transferred');
  assert.equal(first.data.length, 64 * 48 * 4, 'the 8-bit plane of a 16-bit source is not sent');
  assert.equal(second.data.length, 0, 'an 8-bit source transfers its samples');
  assert.ok(worker.posted[1].image16 && !worker.posted[1].rgba);
  assert.ok(worker.posted[2].rgba && !worker.posted[2].image16);
  assert.equal(worker.posted[1].gray.width, 64, 'grey proxy at the frame size under 1200 px');
  const result = await job.merge();
  assert.deepEqual(result, { blob: 'PNG', width: 1, height: 1, used: 2, skipped: 0 });
  assert.equal(worker.terminated, 1, 'terminated after the result');
  assert.ok(events.includes('posted') && events.includes('merging') && events.includes('merge'));
  job.dispose();
  assert.equal(worker.terminated, 1, 'dispose after success does not post or fail');
}

// Views that do not own their buffer are copied before transfer.
{
  let worker;
  const job = createMultiShotMergeJob({ workerFactory: () => (worker = new ScriptedWorker({ script: cooperative })) });
  const backing = new Uint8ClampedArray(64 * 48 * 4 + 16);
  const partial = { width: 64, height: 48, data: backing.subarray(8, 8 + 64 * 48 * 4) };
  await job.addFrame(0, partial);
  assert.equal(backing.length, 64 * 48 * 4 + 16, 'the shared backing store is not detached');
  assert.equal(worker.posted[1].rgba.length, 64 * 48 * 4);
  job.dispose();
  assert.equal(worker.terminated, 1);
}

// Large frames: the grey proxy is capped at 1200 px and the reference is not
// resampled; a small reference is resampled when a larger frame follows.
{
  let worker;
  const job = createMultiShotMergeJob({ workerFactory: () => (worker = new ScriptedWorker({ script: cooperative })) });
  await job.addFrame(0, image(1600, 1000));
  await job.addFrame(1, image(1500, 1000));
  assert.equal(worker.posted[1].gray.width, 1200);
  assert.equal(worker.posted[2].gray.width, 1200);
  assert.equal(worker.posted[2].referenceGray, undefined);
  job.dispose();
  const small = createMultiShotMergeJob({ workerFactory: () => (worker = new ScriptedWorker({ script: cooperative })) });
  await small.addFrame(0, image(400, 300));
  await small.addFrame(1, image(800, 600));
  await small.addFrame(2, image(300, 200));
  assert.equal(worker.posted[1].gray.width, 400);
  assert.equal(worker.posted[2].referenceGray.width, 800, 'reference sampled again at the larger side');
  assert.equal(worker.posted[2].gray.width, 800);
  assert.equal(worker.posted[3].referenceGray, undefined, 'a smaller frame uses the reference sample as is');
  small.dispose();
}

// Worker errors arrive classified; the worker is terminated.
{
  let worker;
  const job = createMultiShotMergeJob({
    workerFactory: () => (worker = new ScriptedWorker({ script: (m, w) => { if (m.type === 'frame' && m.index === 1) w.emit({ type: 'error', code: 'memory', message: 'Insufficient memory' }); } }))
  });
  await job.addFrame(0, image());
  await job.addFrame(1, image());
  await assert.rejects(job.failed, (error) => error.code === 'memory' && error.name === 'MultiShotError');
  await assert.rejects(job.addFrame(2, image()), (error) => error.code === 'memory');
  await assert.rejects(job.merge(), (error) => error.code === 'memory');
  assert.equal(worker.terminated, 1);
}

// A crash after the handshake is a memory failure; so is a worker that goes
// silent with work in hand.
{
  let worker;
  const job = createMultiShotMergeJob({ workerFactory: () => (worker = new ScriptedWorker({ script: (m, w) => { if (m.type === 'frame') w.crash(); } })) });
  await job.addFrame(0, image());
  await assert.rejects(job.failed, (error) => error.code === 'memory');
  assert.equal(worker.terminated, 1);

  const silent = createMultiShotMergeJob({ idleTimeoutMs: 20, workerFactory: () => (worker = new ScriptedWorker()) });
  await silent.addFrame(0, image());
  await new Promise((resolve) => setTimeout(resolve, 60)); // the watchdog timer is unref'd
  await assert.rejects(silent.failed, (error) => error.code === 'memory' && /stopped responding/.test(error.message));
  assert.equal(worker.terminated, 1);
}

// Cancel: immediate rejection with 'cancelled', worker terminated, nothing
// posted afterwards; a pending wait for the handshake ends too.
{
  let worker;
  const job = createMultiShotMergeJob({ workerFactory: () => (worker = new ScriptedWorker({ script: cooperative })) });
  await job.addFrame(0, image());
  job.cancel();
  assert.equal(worker.terminated, 1, 'terminated synchronously on Cancel');
  await assert.rejects(job.failed, (error) => error.code === 'cancelled');
  await assert.rejects(job.addFrame(1, image()), (error) => error.code === 'cancelled');
  await assert.rejects(job.merge(), (error) => error.code === 'cancelled');
  job.dispose();
  assert.equal(worker.terminated, 1);

  let late;
  const early = createMultiShotMergeJob({ helloTimeoutMs: 60000, workerFactory: () => (late = new ScriptedWorker({ hello: false })) });
  const adding = early.addFrame(0, image());
  await tick();
  early.cancel();
  await assert.rejects(adding, (error) => error.code === 'cancelled');
  assert.equal(late.terminated, 1);
  assert.deepEqual(late.posted, [], 'no pixels reach a worker that never started');
}

// No module worker (constructor throws, load error, no handshake): the same
// processor runs on the main thread; without OpenCV the job fails as 'opencv'.
for (const factory of [
  () => { throw new Error('module workers unsupported'); },
  () => { const w = new ScriptedWorker({ hello: false }); w.crash(); return w; },
  () => new ScriptedWorker({ hello: false })
]) {
  const posted = [];
  const job = createMultiShotMergeJob({
    helloTimeoutMs: 30,
    workerFactory: factory,
    createInlineProcessor: async ({ post, signal }) => (message) => {
      posted.push(message.type);
      assert.ok(signal instanceof AbortSignal);
      if (message.type === 'merge') post({ type: 'result', blob: 'inline', width: 1, height: 1, used: 2, skipped: 0 });
    }
  });
  await job.addFrame(0, image());
  await job.addFrame(1, image());
  assert.equal((await job.merge()).blob, 'inline');
  assert.ok(job.fallback);
  assert.deepEqual(posted, ['start', 'frame', 'frame', 'merge']);
}
{
  const job = createMultiShotMergeJob({ workerFactory: () => { throw new Error('no'); }, createInlineProcessor: async () => null });
  await assert.rejects(job.addFrame(0, image()), (error) => error.code === 'opencv');
}

// Peak estimate from #260: about 3.0 GB for 3 x 60.4 MP, 4.0 GB for 5.
{
  const mp = 9536 * 6336;
  const three = estimateMultiShotWorkerBytes([mp, mp, mp]);
  const five = estimateMultiShotWorkerBytes([mp, mp, mp, mp, mp]);
  assert.ok(three > 2.9e9 && three < 3.1e9, `3 x 60 MP -> ${three}`);
  assert.ok(five > 3.9e9 && five < 4.1e9, `5 x 60 MP -> ${five}`);
  assert.equal(estimateMultiShotWorkerBytes([]), 0);
  assert.ok(estimateMultiShotWorkerBytes([1e6, 1e6]) < 50e6, 'small frames need little');
  assert.ok(multiShotFitsBudget([mp, mp, mp], Infinity), 'no budget: attempt the merge');
  assert.ok(multiShotFitsBudget([mp, mp, mp], 3.2e9));
  assert.ok(!multiShotFitsBudget([mp, mp, mp, mp, mp], 3.2e9), '5 x 60 MP is refused on a 3.2 GB budget');
}

// Progress: labels for the running stage, a fraction that only grows.
{
  const progress = createMultiShotProgress(3);
  const steps = [
    [{ stage: 'decode', index: 0 }, 'multiShotStageDecode', { current: '1', total: '3' }],
    [{ stage: 'posted', index: 0, reference: true }, 'multiShotStageDecode'],
    [{ stage: 'frame', index: 0, aligned: true }, 'multiShotStageDecode'],
    [{ stage: 'decode', index: 1 }, 'multiShotStageDecode', { current: '2', total: '3' }],
    [{ stage: 'posted', index: 1, reference: false }, 'multiShotStageAlign', { current: '2', total: '3' }],
    [{ stage: 'align', index: 1, aligned: true }, 'multiShotStageWarp'],
    [{ stage: 'warp', index: 1 }, 'multiShotStageExposure'],
    [{ stage: 'exposure', index: 1 }, 'multiShotStageExposure'],
    [{ stage: 'frame', index: 1, aligned: true }, 'multiShotStageExposure'],
    [{ stage: 'decode', index: 2 }, 'multiShotStageDecode'],
    [{ stage: 'posted', index: 2, reference: false }, 'multiShotStageAlign'],
    [{ stage: 'align', index: 2, aligned: false }, 'multiShotStageAlign'],
    [{ stage: 'frame', index: 2, aligned: false }, 'multiShotStageAlign'],
    [{ stage: 'merging' }, 'multiShotStageMerge', { percent: '0' }],
    [{ stage: 'merge', done: 21, total: 50 }, 'multiShotStageMerge', { percent: '42' }],
    [{ stage: 'merge', done: 50, total: 50 }, 'multiShotStageMerge', { percent: '100' }],
    [{ stage: 'encode' }, 'multiShotStageEncode']
  ];
  let last = 0;
  for (const [event, key, params] of steps) {
    const view = progress.update(event);
    assert.equal(view.key, key, `${event.stage} -> ${key}`);
    if (params) assert.deepEqual(view.params, params);
    assert.ok(view.fraction >= last - 1e-12, `fraction grows at ${event.stage}`);
    last = view.fraction;
  }
  assert.ok(Math.abs(last - 1) < 1e-9, 'encoding reaches the end of the bar');
  assert.equal(progress.update({ stage: 'decode', index: 1 }).index, 1);
}

console.log('multiShotWorkerClient.test.mjs passed');

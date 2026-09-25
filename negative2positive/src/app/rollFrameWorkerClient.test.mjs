// The roll's frame workers from the page's side (#252): one worker per frame
// in flight, reused across frames; the RAW loader's post-decode interface
// with every fallback keeping today's bytes; the held frame's sample, planes
// and release.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    if (!(data instanceof Uint8ClampedArray)) throw new TypeError('ImageData needs a Uint8ClampedArray');
    this.data = data; this.width = width; this.height = height;
  }
};
const { createRollFramePool, imageFromRollPlanes } = await import('./rollFrameWorkerClient.js');
const { createRollFrameTask } = await import('../workers/rollFrameTask.js');
const { runRawPostDecode } = await import('./rawPostDecode.js');
const { buildRollSample } = await import('./rollSample.js');
const { hasCachedFilmBase } = await import('./filmStatsCache.js');

const sha = view => createHash('sha256').update(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)).digest('hex');
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(setImmediate); };

function result(width = 48, height = 32, seed = 3) {
  const data = new Uint16Array(width * height * 3);
  let s = seed;
  for (let i = 0; i < data.length; i++) { s = (s * 1103515245 + 12345) >>> 0; data[i] = 20000 + (s >>> 20); }
  return { width, height, bits: 16, colors: 3, data };
}
const postOptions = { suppressSensorDefects: true, filmStats: { borderBufferPct: 10 } };

// A worker stand-in running the real task: structured clone with transfer
// both ways, a macrotask per message.
function taskWorkers({ silent = false, crashOn = null, detect = () => ({ angle: 0, cropRegion: null, confidence: 0 }) } = {}) {
  const created = [];
  const factory = () => {
    const task = createRollFrameTask({
      loadCv: async () => {}, detect, rotate: image => image, readEdge: async image => ({ found: false, width: image.width }),
      yieldTask: () => new Promise(setImmediate)
    });
    const worker = {
      terminated: false, messages: [],
      terminate() { worker.terminated = true; },
      postMessage(message, transfers = []) {
        const received = structuredClone(message, { transfer: transfers });
        worker.messages.push(received.type);
        if (worker.terminated || silent) return;
        setTimeout(() => {
          if (worker.terminated) return;
          if (crashOn?.(received)) { worker.onerror?.({ message: 'crash', preventDefault() {} }); return; }
          void task.handle(received, (reply, out) => {
            if (!worker.terminated) worker.onmessage?.({ data: structuredClone(reply, { transfer: out }) });
          });
        }, 0);
      }
    };
    created.push(worker);
    return worker;
  };
  return { factory, created };
}

async function loaderRun(adapter, input, options = postOptions, signal = null) {
  try { return await adapter.run(input, options, { signal }); }
  finally { adapter.terminate(); }
}

// The worker keeps the planes and returns plain data; the sample is the one
// the page would build from the same planes; the worker serves the next frame.
{
  const { factory, created } = taskWorkers();
  const pool = createRollFramePool({ size: 1, workerFactory: factory });
  assert.equal(pool.warm(1), 1);
  const input = result();
  const expected = runRawPostDecode({ ...input, data: input.data.slice() }, postOptions);
  const adapter = pool.frame({ options: { frame: { settings: {} }, filmTypeChoice: { automatic: true }, filmEdge: true } });
  const outcome = await loaderRun(adapter, { ...input, data: input.data.slice() });
  assert.equal(outcome.held, true);
  assert.deepEqual([outcome.width, outcome.height], [48, 32]);
  assert.deepEqual(outcome.filmStats, expected.filmStats);
  assert.equal(adapter.ranInWorker, true);
  assert.equal(adapter.analysis.complete, true);
  assert.deepEqual(adapter.analysis.edge, { found: false, width: 48 });
  const settings = { rotationAngle: 0, mirrored: true, cropRegion: { left: 2, top: 3, width: 30, height: 20 }, autoFrameMeta: null };
  const { sample } = await adapter.held.sample(settings, { tileMax: 16 });
  const page = buildRollSample(imageFromRollPlanes({ width: 48, height: 32, rgba8: expected.rgba8, rgba16: expected.rgba16 }), settings, { tileMax: 16 });
  assert.equal(sha(sample.data), sha(page.data));
  assert.equal(sha(sample.__image16.data), sha(page.__image16.data));
  assert.equal(sha(sample.__tileWorking.data), sha(page.__tileWorking.data));
  assert.ok(sample instanceof ImageData);
  // The next frame reuses the worker.
  const next = pool.frame({ options: {} });
  const second = await loaderRun(next, result(48, 32, 9));
  assert.equal(second.held, true);
  next.held.release();
  assert.equal(created.length, 1, 'one worker for consecutive frames');
  assert.equal(pool.created, 1);
  pool.dispose();
  assert.equal(created[0].terminated, true);
}

// returnPlanes: the planes come back with the analysis, as the loader wraps them.
{
  const { factory } = taskWorkers();
  const pool = createRollFramePool({ size: 1, workerFactory: factory });
  const sizes = [];
  const adapter = pool.frame({ options: {}, returnPlanes: size => { sizes.push(size); return true; } });
  const input = result();
  const expected = runRawPostDecode({ ...input, data: input.data.slice() }, postOptions);
  const outcome = await loaderRun(adapter, input);
  assert.deepEqual(sizes, [{ width: 48, height: 32, bits: 16, colors: 3 }]);
  assert.equal(outcome.held, undefined);
  assert.equal(sha(outcome.rgba16), sha(expected.rgba16));
  assert.equal(sha(outcome.rgba8), sha(expected.rgba8));
  assert.equal(adapter.held, null);
  adapter.done();
  const image = imageFromRollPlanes({ width: 48, height: 32, rgba8: outcome.rgba8, rgba16: outcome.rgba16, filmStats: outcome.filmStats });
  assert.ok(hasCachedFilmBase(image, 10), 'the base carries its statistics');
  pool.dispose();
}

// The foreground adopts while the worker runs: planes back between steps.
{
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { factory } = taskWorkers();
  const pool = createRollFramePool({ size: 1, workerFactory: factory });
  const adapter = pool.frame({ options: { frame: { settings: {} } } });
  const input = result();
  const running = loaderRun(adapter, input);
  adapter.wantPlanes();
  const outcome = await running;
  assert.ok(outcome.rgba8 && outcome.rgba16, 'the planes came back');
  assert.equal(adapter.analysis.interrupted, true);
  release();
  await gate;
  adapter.done();
  pool.dispose();
}

// A held frame's planes on request (a late adoption); release drops it.
{
  const { factory, created } = taskWorkers();
  const pool = createRollFramePool({ size: 1, workerFactory: factory });
  const adapter = pool.frame({ options: {} });
  const input = result();
  const expected = runRawPostDecode({ ...input, data: input.data.slice() }, postOptions);
  await loaderRun(adapter, input);
  const base = await adapter.held.takePlanes();
  assert.equal(sha(base.data), sha(expected.rgba8));
  assert.equal(sha(base.__image16.data), sha(expected.rgba16));
  assert.ok(hasCachedFilmBase(base, 10));
  await assert.rejects(adapter.held.sample({}, { tileMax: 16 }), /already released/);
  assert.equal(pool.alive, 1);
  pool.dispose();
  assert.ok(created[0].messages.includes('release'));
}

// Fallbacks keep today's bytes: no answer to the ping in time, and a worker
// that dies holding the pixels (the loader's embedded-preview path).
{
  const { factory } = taskWorkers({ silent: true });
  const warn = console.warn; console.warn = () => {};
  const pool = createRollFramePool({ size: 1, workerFactory: factory, readyTimeoutMs: 20 });
  const adapter = pool.frame({ options: {} });
  const input = result();
  const expected = runRawPostDecode({ ...input, data: input.data.slice() }, postOptions);
  let outcome;
  try { outcome = await loaderRun(adapter, input); } finally { console.warn = warn; }
  assert.equal(outcome.held, undefined);
  assert.equal(sha(outcome.rgba16), sha(expected.rgba16), 'finished on the page with the same functions');
  assert.equal(adapter.ranInWorker, false);
  adapter.done();
  pool.dispose();
}
{
  let crashes = 0;
  const { factory } = taskWorkers({ crashOn: message => message.type === 'process' && crashes++ === 0 });
  const warn = console.warn; console.warn = () => {};
  const pool = createRollFramePool({ size: 1, workerFactory: factory });
  const adapter = pool.frame({ options: {} });
  try { await assert.rejects(loaderRun(adapter, result()), error => error.code === 'RAW_POST_DECODE_LOST'); }
  finally { console.warn = warn; }
  adapter.done();
  // The pool starts a fresh worker for the next frame.
  const next = pool.frame({ options: {} });
  assert.equal((await loaderRun(next, result())).held, true);
  assert.equal(pool.created, 2);
  next.held.release();
  pool.dispose();
}

// An abort while the worker runs costs that worker, and nothing is finished here.
{
  const { factory, created } = taskWorkers();
  const pool = createRollFramePool({ size: 1, workerFactory: factory });
  const adapter = pool.frame({ options: {} });
  const controller = new AbortController();
  const running = adapter.run(result(), postOptions, { signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort(new DOMException('superseded', 'AbortError'));
  adapter.terminate();
  await assert.rejects(running, error => error.name === 'AbortError' || error.code === 'RAW_POST_DECODE_LOST');
  assert.equal(created[0].terminated, true);
  adapter.done();
  pool.dispose();
}

// A second lane while the first frame is still held gets its own worker; the
// pool keeps as many as frames in flight.
{
  const { factory, created } = taskWorkers();
  const pool = createRollFramePool({ size: 2, workerFactory: factory });
  const a = pool.frame({ options: {} });
  const b = pool.frame({ options: {} });
  await Promise.all([loaderRun(a, result()), loaderRun(b, result())]);
  assert.equal(created.length, 2);
  a.held.release(); b.held.release();
  const c = pool.frame({ options: {} });
  await loaderRun(c, result());
  assert.equal(created.length, 2, 'reused');
  c.held.release();
  pool.resize(1);
  assert.equal(pool.alive, 1, 'a smaller plan releases idle workers');
  pool.dispose();
  assert.equal(pool.alive, 0);
  await flush();
}
console.log('rollFrameWorkerClient: held frames, samples, planes, fallbacks and worker reuse');

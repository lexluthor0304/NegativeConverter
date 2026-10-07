import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { decodeHeifInWorker } from './heifLoader.js';
import { createMemoryBudget } from './memoryBudget.js';
let terminated = 0;
const good = () => {
  const worker = { terminate() { terminated++; }, postMessage() { queueMicrotask(() => this.onmessage({ data: { width: 1, height: 1, data: new Uint8ClampedArray([1, 2, 3, 255]) } })); } };
  queueMicrotask(() => worker.onmessage?.({ data: { ready: true } }));
  return worker;
};
const file = new Blob(['tiny']);
assert.equal((await decodeHeifInWorker(file, { workerFactory: good })).width, 1);
assert.equal(terminated, 1);
await assert.rejects(decodeHeifInWorker({}, { timeoutMs: 2, workerFactory: () => ({ postMessage() {}, terminate() { terminated++; } }) }), /timed out/);
assert.equal(terminated, 2);
assert.equal((await decodeHeifInWorker(file, { workerFactory: good })).height, 1, 'a timeout must not poison the next decode');
console.log('HEIF worker timeout, retry and heap disposal passed');

// Abort must never become HEIC_DECODE_FAILED or retain a decoder heap.
{
  const c = new AbortController(); c.abort(); let created = 0;
  await assert.rejects(decodeHeifInWorker({}, { signal: c.signal, workerFactory: () => { created++; } }), { name: 'AbortError' });
  assert.equal(created, 0);
}
for (const duringFactory of [false, true]) {
  const c = new AbortController(); let stopped = 0, posts = 0, lateReply;
  const worker = { terminate() { stopped++; }, postMessage() { posts++; lateReply = this.onmessage; } };
  const result = decodeHeifInWorker(file, { signal: c.signal, workerFactory: () => {
    if (duringFactory) c.abort();
    return worker;
  } });
  const rejection = assert.rejects(result, error => error.name === 'AbortError' && error.code !== 'HEIC_DECODE_FAILED');
  if (!duringFactory) {
    worker.onmessage({ data: { ready: true } });
    for (let i = 0; i < 8; i++) await new Promise(setImmediate);
  }
  c.abort(); await rejection;
  lateReply?.({ data: { width: 1, height: 1 } });
  assert.equal(stopped, 1, 'abort/late reply dispose exactly once');
  assert.equal(posts, duringFactory ? 0 : 1);
  assert.equal(worker.onmessage, null); assert.equal(worker.onerror, null);
}
assert.equal((await decodeHeifInWorker(file, { workerFactory: good })).width, 1, 'abort does not poison another decode');
console.log('HEIF pre-dispatch/in-flight abort, late reply and recovery passed');

const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
const source = readFileSync(new URL('../../public/codecs/heif-worker.js', import.meta.url), 'utf8');
// Execute the served worker protocol, delaying only the library factory and
// file IO. The actual client must dispatch after BOTH waits and admission.
for (const abort of [false, true]) {
  const ready = defer(), reading = defer(), read = defer(), controller = new AbortController();
  const budget = createMemoryBudget({ budgetBytes: 1000 });
  let starts = 0, stopped = 0, claim = null;
  const worker = { terminate() { stopped++; }, postMessage(message, transfer) {
    const moved = structuredClone(message, { transfer });
    context.self.onmessage({ data: moved });
  } };
  const primary = { handle: 1, get_width: () => 4, get_height: () => 4,
    display(image, done) { image.data.fill(17); done(image); } };
  const context = vm.createContext({
    Uint8Array, Uint8ClampedArray, URL, importScripts() {},
    self: { location: { href: 'http://localhost/codecs/heif-worker.js' }, addEventListener() {},
      postMessage(data) { if (!stopped) worker.onmessage?.({ data }); } },
    // libheif-js returns its module (the options object, extended), not a
    // promise; its runtime starts later, here when `ready` resolves.
    libheif: options => {
      const module = Object.assign(options, { heif_image_handle_is_primary_image: () => true,
        HeifDecoder: class { decode(bytes) {
          assert.equal(budget.foregroundOutstanding, 0, 'actual worker decode starts after foreground release');
          assert.equal(budget.reserved, 192, 'actual worker decode owns its counted claim');
          assert.equal(bytes.length, 32); starts++; return [primary];
        } } });
      ready.promise.then(() => { module.calledRun = true; module.onRuntimeInitialized?.(); });
      return module;
    }
  });
  const pending = decodeHeifInWorker({ arrayBuffer: async () => { reading.resolve(); await read.promise; return new ArrayBuffer(32); } }, {
    signal: controller.signal,
    workerFactory: () => { vm.runInContext(source, context); return worker; },
    reserveDecode: async size => {
      assert.deepEqual(size, { kind: 'scan' });
      while (budget.foregroundOutstanding) await budget.whenForegroundIdle({ signal: controller.signal });
      claim = budget.tryReserve(192);
    }
  });
  pending.catch(() => {});
  const foreground = await budget.reserve(100, { priority: 'foreground' });
  ready.resolve(); await reading.promise; read.resolve(); await tick();
  assert.equal(starts, 0, 'no HEIF decode while factory/readiness admission waits');
  if (abort) { controller.abort(); await assert.rejects(pending, { name: 'AbortError' }); }
  foreground.release();
  if (!abort) {
    const result = await pending;
    assert.deepEqual(Array.from(result.data), Array(64).fill(17));
    assert.equal(starts, 1);
  }
  claim?.release(); await tick();
  assert.equal(starts, abort ? 0 : 1); assert.equal(stopped, 1); assert.equal(budget.idle, true);
}
console.log('HEIF served worker: library readiness and file-read dispatch admission, counted bytes and abort passed');

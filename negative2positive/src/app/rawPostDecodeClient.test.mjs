// Standalone Node test for rawPostDecodeClient.js - run with:
// node negative2positive/src/app/rawPostDecodeClient.test.mjs
//
// The per-decode worker path must give bit-identical planes to the
// main-thread path, and every failure mode must either keep the pixels
// (finishing on this thread with the same functions) or report them lost:
//  - no Worker; a worker that cannot start; a handshake that fails or times out;
//  - postMessage refusing the transfer;
//  - a worker error that hands pixels back, at each stage;
//  - a worker that dies holding the pixels (RAW_POST_DECODE_LOST).
import assert from 'node:assert/strict';
import { handleRawPostDecodeMessage } from './rawPostDecode.js';
import { makeRawResult, cloneRawResult } from './rawPostDecode.fixtures.mjs';

const realSetTimeout = globalThis.setTimeout;
const flush = () => new Promise((resolve) => realSetTimeout(resolve, 0));

// Behaviour of the next FakeWorker(s).
const fake = {
  constructorThrows: false,
  ping: 'answer',        // 'answer' | 'ignore' | 'crash'
  process: 'real',       // 'real' | 'crash' | 'refuse' | 'errorAfterClone'
  afterClone: null,      // (message) => void, failure injection on the worker side
  instances: [],
};

class FakeWorker {
  constructor(url, options) {
    if (fake.constructorThrows) throw new Error('blocked by CSP');
    this.url = String(url);
    this.options = options;
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
    this.terminated = false;
    this.received = [];
    fake.instances.push(this);
  }

  postMessage(message, transfer = []) {
    if (this.terminated) return;
    if (message.type === 'process' && fake.process === 'refuse') {
      throw new DOMException('could not clone', 'DataCloneError');
    }
    // Real postMessage semantics: clone and move the transferred buffers.
    const moved = structuredClone({ message }, { transfer }).message;
    this.received.push(moved.type);
    queueMicrotask(() => {
      if (this.terminated) return;
      if (moved.type === 'ping') {
        if (fake.ping === 'ignore') return;
        if (fake.ping === 'crash') { this.onerror?.({ type: 'error', message: 'module failed to load', preventDefault() {} }); return; }
      }
      if (moved.type === 'process' && fake.process === 'crash') {
        // Died holding the pixels: nothing comes back.
        this.onerror?.({ type: 'error', message: 'out of memory', preventDefault() {} });
        return;
      }
      fake.afterClone?.(moved);
      handleRawPostDecodeMessage(moved, (reply, replyTransfer = []) => {
        const back = structuredClone({ reply }, { transfer: replyTransfer }).reply;
        queueMicrotask(() => { if (!this.terminated) this.onmessage?.({ data: back }); });
      });
    });
  }

  terminate() {
    this.terminated = true;
  }
}

function reset() {
  fake.constructorThrows = false;
  fake.ping = 'answer';
  fake.process = 'real';
  fake.afterClone = null;
  fake.instances.length = 0;
}

async function importClient() {
  return import('./rawPostDecodeClient.js');
}

function assertSamePlanes(got, want, label) {
  assert.equal(got.garbled, false, label);
  assert.deepEqual(got.defects, want.defects, `${label}: stats`);
  assert.equal(got.width, want.width);
  assert.equal(got.height, want.height);
  assert.ok(Buffer.from(got.rgba16.buffer, got.rgba16.byteOffset, got.rgba16.byteLength)
    .equals(Buffer.from(want.rgba16.buffer, want.rgba16.byteOffset, want.rgba16.byteLength)), `${label}: RGBA16`);
  assert.ok(Buffer.from(got.rgba8.buffer).equals(Buffer.from(want.rgba8.buffer)), `${label}: RGBA8`);
  assert.deepEqual(got.filmStats, want.filmStats, `${label}: film statistics`);
}

const OPTIONS = { suppressSensorDefects: true, filmStats: { borderBufferPct: 10 } };
const FIXTURES = [
  makeRawResult({ width: 60, height: 44, seed: 1, channels: 3, bits: 16 }),
  makeRawResult({ width: 51, height: 40, seed: 2, channels: 3, bits: 16, byteOffset: 6, padding: 9 }),
  makeRawResult({ width: 48, height: 36, seed: 3, channels: 4, bits: 16, byteOffset: 8, padding: 4 }),
  makeRawResult({ width: 50, height: 38, seed: 4, channels: 3, bits: 8 }),
  makeRawResult({ width: 47, height: 35, seed: 5, channels: 1, bits: 16 }),
];

// --- baseline: no Worker at all ----------------------------------------------
delete globalThis.Worker;
const { startRawPostDecode } = await importClient();
const mainThread = [];
for (const fixture of FIXTURES) {
  const handle = startRawPostDecode();
  assert.equal(handle.usesWorker, false);
  mainThread.push(await handle.run(cloneRawResult(fixture), OPTIONS));
  handle.terminate();
}

globalThis.Worker = FakeWorker;

// --- worker path: same bytes, input transferred away, worker terminated -------
for (let i = 0; i < FIXTURES.length; i++) {
  reset();
  const handle = startRawPostDecode();
  assert.equal(handle.usesWorker, true);
  const worker = fake.instances[0];
  assert.match(worker.url, /rawPostDecodeWorker\.js$/);
  assert.deepEqual(worker.options, { type: 'module' });
  const input = cloneRawResult(FIXTURES[i]);
  const out = await handle.run(input, OPTIONS);
  assertSamePlanes(out, mainThread[i], `worker path #${i}`);
  assert.equal(handle.ranInWorker, true);
  assert.equal(input.data.buffer.byteLength, 0, 'LibRaw buffer moved to the worker, not copied');
  assert.deepEqual(worker.received, ['ping', 'process']);
  handle.terminate();
  assert.equal(worker.terminated, true);
}

// --- a worker that cannot be constructed -------------------------------------
{
  reset();
  fake.constructorThrows = true;
  const handle = startRawPostDecode();
  assert.equal(handle.usesWorker, false);
  assertSamePlanes(await handle.run(cloneRawResult(FIXTURES[0]), OPTIONS), mainThread[0], 'constructor throws');
}

// --- handshake fails (module did not load) ------------------------------------
{
  reset();
  fake.ping = 'crash';
  const handle = startRawPostDecode();
  await flush();
  assertSamePlanes(await handle.run(cloneRawResult(FIXTURES[1]), OPTIONS), mainThread[1], 'handshake failed');
  assert.equal(fake.instances[0].terminated, true, 'a failed worker is dropped');
}

// --- handshake times out --------------------------------------------------------
{
  reset();
  fake.ping = 'ignore';
  const handle = startRawPostDecode({ readyTimeoutMs: 5 });
  const input = cloneRawResult(FIXTURES[2]);
  assertSamePlanes(await handle.run(input, OPTIONS), mainThread[2], 'handshake timed out');
  assert.equal(handle.ranInWorker, false);
  assert.deepEqual(fake.instances[0].received, ['ping'], 'no pixels handed to a worker that never answered');
  handle.terminate();
}

// --- a slow start-up that answers before the decode ends still uses the worker -
{
  reset();
  fake.ping = 'ignore';
  const handle = startRawPostDecode({ readyTimeoutMs: 1000 });
  const worker = fake.instances[0];
  realSetTimeout(() => worker.onmessage({ data: { type: 'pong', id: 0 } }), 20);
  assertSamePlanes(await handle.run(cloneRawResult(FIXTURES[3]), OPTIONS), mainThread[3], 'late pong');
  assert.deepEqual(worker.received, ['ping', 'process']);
  handle.terminate();
}

// --- postMessage refuses the transfer: pixels are still ours ---------------------
{
  reset();
  fake.process = 'refuse';
  const handle = startRawPostDecode();
  assertSamePlanes(await handle.run(cloneRawResult(FIXTURES[0]), OPTIONS), mainThread[0], 'transfer refused');
  handle.terminate();
}

// --- worker errors that hand pixels back finish on this thread, bit-identical -----
for (const [label, inject] of [
  ['input returned', (moved) => { moved.width = -1; }],
  ['packed plane returned', (moved) => { moved.options = { ...OPTIONS, get suppressSensorDefects() { throw new Error('boom'); } }; }],
  ['repaired plane returned', (moved) => { moved.options = { suppressSensorDefects: true, filmStats: { get borderBufferPct() { throw new Error('boom'); } } }; }],
]) {
  reset();
  // Failures injected on the worker side of the clone ('input returned': a
  // width the worker cannot use fails before packing; the client re-runs
  // with its own copy of the shape).
  fake.afterClone = (moved) => { if (moved.type === 'process') inject(moved); };
  const handle = startRawPostDecode();
  const out = await handle.run(cloneRawResult(FIXTURES[0]), OPTIONS);
  assertSamePlanes(out, mainThread[0], label);
  handle.terminate();
}

// --- a worker that dies holding the pixels ---------------------------------------
{
  reset();
  fake.process = 'crash';
  const handle = startRawPostDecode();
  await assert.rejects(handle.run(cloneRawResult(FIXTURES[0]), OPTIONS), (err) => err.code === 'RAW_POST_DECODE_LOST');
  assert.equal(fake.instances[0].terminated, true);
}

// --- terminate() while a run is in flight reports the pixels lost -------------
{
  reset();
  const handle = startRawPostDecode();
  const input = cloneRawResult(FIXTURES[0]);
  fake.afterClone = (moved) => { if (moved.type === 'process') handle.terminate(); };
  await assert.rejects(handle.run(input, OPTIONS), (err) => err.code === 'RAW_POST_DECODE_LOST');
}

// --- data that cannot be transferred stays on this thread ------------------------
{
  reset();
  const handle = startRawPostDecode();
  // A view into shared memory (a WASM heap, say) cannot be transferred.
  const shared = cloneRawResult(FIXTURES[0]);
  const sab = new Uint16Array(new SharedArrayBuffer(shared.data.byteLength));
  sab.set(shared.data);
  shared.data = sab;
  assertSamePlanes(await handle.run(shared, OPTIONS), mainThread[0], 'shared-memory input');
  assert.equal(sab.length, FIXTURES[0].data.length, 'shared memory is never detached');
  assert.deepEqual(fake.instances[0].received, ['ping']);
  handle.terminate();
}

// --- suppressSensorDefects: false reaches the worker --------------------------------
{
  reset();
  const handle = startRawPostDecode();
  const out = await handle.run(cloneRawResult(FIXTURES[0]), { suppressSensorDefects: false });
  assert.equal(out.defects.repaired, 0);
  const none = startRawPostDecode();
  delete globalThis.Worker;
  const reference = await startRawPostDecode().run(cloneRawResult(FIXTURES[0]), { suppressSensorDefects: false });
  globalThis.Worker = FakeWorker;
  assert.deepEqual(out.rgba16, reference.rgba16);
  handle.terminate();
  none.terminate();
}

console.log('rawPostDecodeClient.test.mjs passed');

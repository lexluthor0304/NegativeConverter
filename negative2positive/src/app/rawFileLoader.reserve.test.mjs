// Standalone Node test for loadRawFile's memory-budget gate (#258) - run with:
// node negative2positive/src/app/rawFileLoader.reserve.test.mjs
//
// LibRaw and the post-decode worker are faked at the Worker boundary (as in
// rawFileLoader.abort.test.mjs). The gate must run with LibRaw's real size
// after metadata() and before imageData(), hold the demosaic while the
// reservation waits, reject with an AbortError when the activation is
// superseded there, and run before a decode that has no size of its own.
import assert from 'node:assert/strict';
import { handleRawPostDecodeMessage } from './rawPostDecode.js';
import { makeRawResult, cloneRawResult } from './rawPostDecode.fixtures.mjs';

console.info = () => {};
console.warn = () => {};

if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class ImageData {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

let bitmapDecodes = 0;
globalThis.createImageBitmap = async () => { bitmapDecodes++; return { width: 8, height: 8, close() {} }; };
globalThis.document = {
  createElement: () => ({ getContext: () => ({ drawImage() {}, getImageData: (x, y, w, h) => new ImageData(new Uint8ClampedArray(w * h * 4), w, h) }) })
};

const scene = { hold: null, workers: [], held: null, onReply: null, postDecode: 'real', result: null };

class FakeWorker {
  constructor(url) {
    this.url = String(url);
    this.kind = /rawPostDecodeWorker/.test(this.url) ? 'post' : /libraw-wasm/.test(this.url) ? 'libraw' : 'other';
    if (this.kind === 'post' && scene.postDecode === 'blocked') throw new Error('blocked');
    this.terminated = false;
    this.terminatedAt = null;
    this.received = [];
    scene.workers.push(this);
  }

  deliver(data, transfer = []) {
    const back = structuredClone({ data }, { transfer }).data;
    const send = () => {
      if (this.terminated) return;
      this.onmessage?.({ data: back });
      scene.onReply?.(this.kind, data);
    };
    queueMicrotask(send);
  }

  postMessage(message, transfer = []) {
    if (this.terminated) return;
    const moved = structuredClone({ message }, { transfer }).message;
    const stage = moved.fn || moved.type;
    this.received.push(stage);
    const answer = () => {
      if (this.kind === 'libraw') {
        const { id } = moved;
        if (stage === 'open') return this.deliver({ id });
        if (stage === 'metadata') return this.deliver({ id, out: { make: 'Fake', model: 'Sensor', width: 64, height: 48 } });
        if (stage === 'imageData') {
          const out = scene.result;
          return this.deliver({ id, out }, out?.data ? [out.data.buffer] : []);
        }
        return;
      }
      if (this.kind === 'post') {
        queueMicrotask(() => {
          if (!this.terminated) handleRawPostDecodeMessage(moved, (reply, replyTransfer) => this.deliver(reply, replyTransfer));
        });
      }
    };
    if (scene.hold === stage) {
      scene.held = { stage, worker: this, release: answer };
      return;
    }
    answer();
  }

  terminate() {
    if (this.terminated) return;
    this.terminated = true;
    this.terminatedAt = scene.clock;
  }
}
globalThis.Worker = FakeWorker;

const { loadRawFile } = await import('./rawFileLoader.js');

const fixture = makeRawResult({ width: 64, height: 48, seed: 21, channels: 3, bits: 16 });

function container() {
  const bytes = new Uint8Array(32 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0x7F;
  return bytes;
}

function countingBlob() {
  const blob = new Blob([container()]);
  const spy = { reads: 0, blob };
  const read = blob.arrayBuffer.bind(blob);
  blob.arrayBuffer = () => { spy.reads++; return read(); };
  return spy;
}

function reset(overrides = {}) {
  Object.assign(scene, { hold: null, workers: [], held: null, onReply: null, postDecode: 'real', result: cloneRawResult(fixture), clock: 0 }, overrides);
  bitmapDecodes = 0;
}

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(setImmediate); };
const workersOf = kind => scene.workers.filter(worker => worker.kind === kind);

async function expectAbort(label, pending, blob) {
  await assert.rejects(pending, error => error.name === 'AbortError' && /Superseded/.test(error.message), label);
  for (const worker of scene.workers) assert.equal(worker.terminated, true, `${label}: ${worker.kind} worker gone`);
  assert.equal(blob.reads, 0, `${label}: the embedded preview is never read`);
  assert.equal(bitmapDecodes, 0, `${label}: no fallback decode`);
}


const { estimateRawDecodeBytes } = await import('./rawDecodeEstimate.js');
const superseded = () => new DOMException('Superseded photo activation', 'AbortError');

// --- the gate sees LibRaw's size, after metadata and before the demosaic ---------
{
  reset();
  const calls = [];
  const image = await loadRawFile(container().buffer, 'frame.dng', {
    sourceBlob: countingBlob().blob,
    reserveDecode: async (size) => {
      calls.push({ ...size, received: [...workersOf('libraw')[0].received] });
    }
  });
  assert.equal(image.width, 64);
  assert.equal(calls.length, 1, 'one gate per decode');
  assert.deepEqual({ kind: calls[0].kind, width: calls[0].width, height: calls[0].height },
    { kind: 'raw', width: 64, height: 48 });
  assert.equal(calls[0].estimatedBytes, estimateRawDecodeBytes(64, 48));
  assert.ok(calls[0].received.includes('metadata'), 'after metadata()');
  assert.ok(!calls[0].received.includes('imageData'), 'before imageData()');
}

// --- a waiting reservation holds the demosaic ---------------------------------------
{
  reset();
  let grant;
  const gate = new Promise(resolve => { grant = resolve; });
  const pending = loadRawFile(container().buffer, 'frame.dng', {
    sourceBlob: countingBlob().blob,
    reserveDecode: () => gate
  });
  await flush();
  const libraw = workersOf('libraw')[0];
  assert.ok(libraw.received.includes('metadata'));
  assert.ok(!libraw.received.includes('imageData'), 'no demosaic while the reservation waits');
  grant();
  const image = await pending;
  assert.ok(libraw.received.includes('imageData'));
  assert.equal(image.height, 48);
}

// --- superseded while waiting at the gate: AbortError, both workers gone ------------
{
  reset();
  const controller = new AbortController();
  const blob = countingBlob();
  const pending = loadRawFile(container().buffer, 'frame.dng', {
    signal: controller.signal,
    sourceBlob: blob.blob,
    // The budget rejects a waiting request when its signal aborts.
    reserveDecode: () => new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }))
  });
  await flush();
  controller.abort(superseded());
  await assert.rejects(pending, error => error.name === 'AbortError');
  for (const worker of scene.workers) assert.equal(worker.terminated, true, `${worker.kind} worker gone`);
  assert.ok(!workersOf('libraw')[0].received.includes('imageData'));
  assert.equal(blob.reads, 0, 'no embedded-preview fallback');
}

// --- a gate that resolves after the signal aborted still stops the decode ------------
{
  reset();
  const controller = new AbortController();
  const pending = loadRawFile(container().buffer, 'frame.dng', {
    signal: controller.signal,
    sourceBlob: countingBlob().blob,
    reserveDecode: async () => { controller.abort(superseded()); }
  });
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.ok(!workersOf('libraw')[0].received.includes('imageData'));
}

// --- a decode without LibRaw gates before it runs, without a size ---------------------
{
  reset();
  // A PNG renamed .tif (scanner software does this): decoded by the browser.
  const png = new Uint8Array(64);
  png.set([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 8, 0, 0, 0, 8, 8, 6, 0, 0, 0]);
  const order = [];
  const realBitmap = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async (...args) => { order.push('decode'); return realBitmap(...args); };
  try {
    const image = await loadRawFile(png.buffer, 'scan.tif', { reserveDecode: async (size) => { order.push(size.kind); } });
    assert.equal(image.width, 8);
  } finally {
    globalThis.createImageBitmap = realBitmap;
  }
  assert.deepEqual(order, ['scan', 'decode'], 'the gate runs first, with no size (the host reads the header)');
}

// --- no gate: unchanged ------------------------------------------------------------
{
  reset();
  const image = await loadRawFile(container().buffer, 'frame.dng', { sourceBlob: countingBlob().blob });
  assert.equal(image.width, 64);
}

console.log('rawFileLoader.reserve.test.mjs passed');

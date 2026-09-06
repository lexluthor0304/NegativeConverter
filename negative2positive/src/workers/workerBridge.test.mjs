// Standalone Node test for workerBridge.js - run with:
// node negative2positive/src/workers/workerBridge.test.mjs
import assert from 'node:assert/strict';

/**
 * Scriptable stand-in for the export Worker. `script` decides how each
 * postMessage is answered, so the error / crash / progress / timeout branches
 * are reachable instead of only the blobResult happy path.
 */
let workers = [];
let lastPost = null;
let script = () => ({ kind: 'blob' });

class FakeWorker {
  constructor() {
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
    this.terminated = false;
    this.posts = [];
    workers.push(this);
  }

  postMessage(message, transfers = []) {
    lastPost = { message, transfers };
    this.posts.push(message);
    structuredClone(message, { transfer: transfers });
    const plan = script(message, this) || { kind: 'blob' };
    if (plan.kind === 'throw') throw plan.error || new Error('postMessage failed');
    if (plan.kind === 'hang') return;
    queueMicrotask(() => {
      if (this.terminated) return;
      if (plan.kind === 'crash') {
        this.onerror(new Error('boom'));
        return;
      }
      if (plan.kind === 'messageerror') {
        this.onmessageerror({});
        return;
      }
      if (plan.kind === 'progress') {
        this.onmessage({ data: { type: 'progress', id: message.id, phase: 'encoding', percent: 42 } });
      }
      if (plan.kind === 'error') {
        this.onmessage({ data: { type: 'error', id: message.id, message: 'worker said no' } });
        return;
      }
      if (plan.kind === 'result') {
        const out = new Uint8ClampedArray(message.width * message.height * 4);
        out.fill(7);
        this.onmessage({
          data: { type: 'result', id: message.id, data: out.buffer, width: message.width, height: message.height }
        });
        return;
      }
      this.onmessage({ data: { type: 'blobResult', id: message.id, blob: new Blob(['ok']) } });
    });
  }

  terminate() {
    this.terminated = true;
  }
}

globalThis.Worker = FakeWorker;
globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
};

const {
  cancelWorkerRequests,
  computeWorkerTimeoutMs,
  isAbortError,
  isWorkerTimeoutError,
  terminateWorker,
  workerApplyAdjustments,
  workerEncodePng16,
  workerEncodeTiff
} = await import('./workerBridge.js');

function reset(nextScript = () => ({ kind: 'blob' })) {
  terminateWorker();
  workers = [];
  lastPost = null;
  script = nextScript;
}

function createImageData() {
  return new ImageData(
    new Uint8ClampedArray([
      0, 64, 128, 255,
      255, 128, 64, 255
    ]),
    2,
    1
  );
}

function identityCurves() {
  const ramp = new Uint8Array(256);
  for (let i = 0; i < 256; i++) ramp[i] = i;
  return { r: ramp, g: new Uint8Array(ramp), b: new Uint8Array(ramp) };
}

function identitySettings() {
  return { curves: identityCurves() };
}

/** Keeps the event loop alive while a (deliberately unref'd) timer fires. */
async function withEventLoopAlive(fn) {
  const keepAlive = setInterval(() => {}, 5);
  try {
    return await fn();
  } finally {
    clearInterval(keepAlive);
  }
}

// ------------------------- the caller's ImageData survives a transferred copy

async function assertEncodePreservesImageDataBuffer(encode) {
  reset();
  const imageData = createImageData();
  const originalBuffer = imageData.data.buffer;
  const originalLength = imageData.data.byteLength;

  const blob = await encode(imageData);

  assert.equal(blob.size, 2);
  assert.ok(lastPost, 'expected worker postMessage to be called');
  assert.equal(lastPost.transfers.length, 1);
  assert.notEqual(lastPost.transfers[0], originalBuffer);
  assert.equal(lastPost.transfers[0].byteLength, 0);
  assert.equal(originalBuffer.byteLength, originalLength);
  assert.equal(imageData.data.byteLength, originalLength);
  assert.doesNotThrow(() => new Uint8ClampedArray(originalBuffer));
}

await assertEncodePreservesImageDataBuffer((imageData) => workerEncodePng16(imageData));
await assertEncodePreservesImageDataBuffer((imageData) => workerEncodeTiff(imageData, 16));

// ------------------------------------- the 16-bit plane is what gets encoded

{
  reset();
  const imageData = createImageData();
  const plane = { width: 2, height: 1, data: new Uint16Array([0x1234, 1, 2, 65535, 0xABCD, 4, 5, 65535]) };
  imageData.__image16 = plane;

  await workerEncodePng16(imageData);
  assert.equal(lastPost.message.sourceBits, 16, 'PNG16 must send the 16-bit plane');
  assert.equal(lastPost.message.pixelData.byteLength, 0, 'plane copy must be transferred, not cloned');
  assert.equal(plane.data.byteLength, 16, 'caller-owned plane must not be detached');

  await workerEncodeTiff(imageData, 16);
  assert.equal(lastPost.message.sourceBits, 16);

  // An 8-bit TIFF must not smuggle the 16-bit plane through.
  await workerEncodeTiff(imageData, 8);
  assert.equal(lastPost.message.sourceBits, 8);

  // No plane at all -> documented 8-bit fallback.
  const plain = createImageData();
  await workerEncodePng16(plain);
  assert.equal(lastPost.message.sourceBits, 8);
}

// ------------------------------------------------ progress + result branches

{
  reset(() => ({ kind: 'progress' }));
  const seen = [];
  await workerEncodePng16(createImageData(), (percent, phase) => seen.push([percent, phase]));
  assert.deepEqual(seen, [[42, 'encoding']]);

  // Options-object form must work too (it carries signal/timeoutMs).
  reset(() => ({ kind: 'progress' }));
  const seen2 = [];
  await workerEncodeTiff(createImageData(), 16, { onProgress: (p) => seen2.push(p) });
  assert.deepEqual(seen2, [42]);
}

{
  reset(() => ({ kind: 'result' }));
  const imageData = createImageData();
  const out = await workerApplyAdjustments(imageData, identitySettings(), 'full');
  assert.equal(out.width, 2);
  assert.equal(out.height, 1);
  assert.equal(out.data.length, 8);
  assert.equal(out.data[0], 7);
  assert.equal(imageData.data.byteLength, 8, "caller's buffer must be intact");
}

// -------- identity adjustments keep the 16-bit plane; real ones must drop it

{
  reset(() => ({ kind: 'result' }));
  const imageData = createImageData();
  const plane = { width: 2, height: 1, data: new Uint16Array(8) };
  imageData.__image16 = plane;

  const identical = await workerApplyAdjustments(imageData, identitySettings(), 'full');
  assert.equal(identical.__image16, plane, 'a no-op adjustment stage must preserve 16-bit');

  const adjusted = await workerApplyAdjustments(
    imageData,
    { ...identitySettings(), exposure: 0.5 },
    'full'
  );
  assert.equal(adjusted.__image16, undefined, 'an 8-bit adjustment must not claim 16-bit output');
}

// ------------------------------------------------------------ error handling

{
  reset(() => ({ kind: 'error' }));
  assert.equal(await workerEncodePng16(createImageData()), null, 'worker error -> main-thread fallback');
}

{
  reset(() => ({ kind: 'crash' }));
  assert.equal(await workerEncodeTiff(createImageData(), 16), null);
  assert.equal(workers.length, 1);
  assert.ok(workers[0].terminated, 'a crashed worker must be terminated, not just dropped');

  // The next call transparently spins up a fresh worker.
  script = () => ({ kind: 'blob' });
  assert.ok(await workerEncodePng16(createImageData()));
  assert.equal(workers.length, 2);
}

{
  reset(() => ({ kind: 'messageerror' }));
  assert.equal(await workerEncodePng16(createImageData()), null);
  assert.ok(workers[0].terminated);
}

{
  // A synchronous postMessage failure must not leak the pending entry.
  reset(() => ({ kind: 'throw', error: new Error('DataCloneError') }));
  assert.equal(await workerEncodePng16(createImageData()), null);
  // If the entry leaked, terminateWorker() below would reject an orphan and the
  // next request would reuse a stale id; assert the bridge still works.
  script = () => ({ kind: 'blob' });
  assert.ok(await workerEncodePng16(createImageData()));
}

// ------------------------------------------------------------------ timeouts

{
  reset(() => ({ kind: 'hang' }));
  const started = Date.now();
  const blob = await withEventLoopAlive(() =>
    workerEncodePng16(createImageData(), { timeoutMs: 30 })
  );
  assert.equal(blob, null, 'a hung worker must time out instead of hanging the export');
  assert.ok(Date.now() - started >= 25);
  assert.ok(workers[0].terminated, 'a timed-out worker must be terminated');

  script = () => ({ kind: 'blob' });
  assert.ok(await workerEncodePng16(createImageData()), 'bridge recovers after a timeout');
}

{
  // A timeout while several requests are in flight must settle all of them.
  reset(() => ({ kind: 'hang' }));
  const a = workerEncodePng16(createImageData(), { timeoutMs: 30 });
  const b = workerEncodeTiff(createImageData(), 16, { timeoutMs: 5_000 });
  const [ra, rb] = await withEventLoopAlive(() => Promise.all([a, b]));
  assert.equal(ra, null);
  assert.equal(rb, null, 'sibling requests on a killed worker must not hang');
}

assert.equal(computeWorkerTimeoutMs(0), 30_000);
assert.equal(computeWorkerTimeoutMs(90_000_000), 120_000);
assert.ok(computeWorkerTimeoutMs(Number.MAX_SAFE_INTEGER) <= 600_000);

// -------------------------------------------------------------- cancellation

{
  reset(() => ({ kind: 'hang' }));
  const controller = new AbortController();
  const promise = workerEncodePng16(createImageData(), { signal: controller.signal });
  controller.abort();
  await assert.rejects(promise, (err) => {
    assert.ok(isAbortError(err), `expected AbortError, got ${err.name}`);
    assert.ok(!isWorkerTimeoutError(err));
    return true;
  });
  assert.ok(workers[0].terminated, 'cancelling must free the worker');
}

{
  // Already-aborted signal short-circuits without touching the worker.
  reset(() => ({ kind: 'hang' }));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    workerApplyAdjustments(createImageData(), identitySettings(), 'full', { signal: controller.signal }),
    (err) => isAbortError(err)
  );
}

{
  reset(() => ({ kind: 'hang' }));
  const promise = workerEncodeTiff(createImageData(), 16);
  cancelWorkerRequests();
  await assert.rejects(promise, (err) => isAbortError(err));
  assert.ok(workers[0].terminated);

  script = () => ({ kind: 'blob' });
  assert.ok(await workerEncodeTiff(createImageData(), 16), 'bridge recovers after cancellation');
}

{
  // terminateWorker() must settle in-flight requests rather than strand them.
  reset(() => ({ kind: 'hang' }));
  const promise = workerApplyAdjustments(createImageData(), identitySettings(), 'full');
  terminateWorker();
  assert.equal(await promise, null);
}

terminateWorker();

console.log('workerBridge.test.mjs passed');

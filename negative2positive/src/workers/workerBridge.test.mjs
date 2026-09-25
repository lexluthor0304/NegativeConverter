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
    const plan = script(message, this) || { kind: 'blob' };
    // A failed postMessage transfers nothing.
    if (plan.kind === 'throw') throw plan.error || new Error('postMessage failed');
    // What the worker would receive: transferred buffers move, the caller's
    // copies detach, exactly as with a real Worker.
    const received = structuredClone(message, { transfer: transfers });
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
      if (plan.kind === 'respond') {
        // `respond(received)` returns the worker's reply and what it transfers.
        const { data, transfer = [] } = plan.respond(received);
        this.onmessage({ data: { id: message.id, ...structuredClone(data, { transfer }) } });
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
// Blink and WebKit reject a buffer whose length is not 4 * width * height
// (IndexSizeError) and anything but a Uint8ClampedArray (TypeError). A stub
// that accepts any length hid #240: the 16-bit result never became an
// ImageData in a browser.
globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    if (!(data instanceof Uint8ClampedArray)) throw new TypeError('ImageData needs a Uint8ClampedArray');
    if (data.length !== 4 * width * height) {
      throw new DOMException('The input data length is not equal to (4 * width * height).', 'IndexSizeError');
    }
    this.data = data;
    this.width = width;
    this.height = height;
  }
};

const {
  cancelWorkerRequests,
  computeWorkerTimeoutMs,
  copyTypedArrayInSlices,
  isAbortError,
  isExportInputLostError,
  isWorkerTimeoutError,
  resetWorkerFallbackWarnings,
  terminateWorker,
  workerApplyAdjustments,
  workerApplyAdjustments16,
  workerGainMap16,
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

// ------------------------------------------------ 16-bit adjustment results

/** Counts console.warn calls whose text mentions `needle` while `fn` runs. */
async function countWarnings(needle, fn) {
  const original = console.warn;
  let count = 0;
  console.warn = (...args) => {
    if (args.some((arg) => String(arg && arg.message ? arg.message : arg).includes(needle))) count++;
  };
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return count;
}

const W16 = 3;
const H16 = 2;
// Deliberately not multiples of 257, so a byte/sample mix-up cannot pass.
const POSTED16 = Uint16Array.from({ length: W16 * H16 * 4 }, (_, i) => (i % 4 === 3 ? 65535 : (0x1234 + i * 0x0a3b) & 0xffff));

function create16BitImage() {
  const image = new ImageData(new Uint8ClampedArray(W16 * H16 * 4).fill(9), W16, H16);
  image.__image16 = {
    width: W16,
    height: H16,
    data: Uint16Array.from({ length: W16 * H16 * 4 }, (_, i) => (i * 1031) & 0xffff)
  };
  return image;
}

/** The worker's applyAdjustments16 reply: the known plane plus (optionally) its mirror. */
function reply16({ mirror = true, samples = POSTED16, bits = 16 } = {}) {
  return {
    kind: 'respond',
    respond: (received) => {
      const out = new Uint16Array(samples);
      const data = { type: 'result', data: out.buffer, width: received.width, height: received.height, bits };
      const transfer = [out.buffer];
      if (mirror) {
        const data8 = Uint8ClampedArray.from(out, (v) => v >>> 8);
        data.data8 = data8.buffer;
        transfer.push(data8.buffer);
      }
      return { data, transfer };
    }
  };
}

function assertAdjusted16(out, label) {
  assert.ok(out, `${label}: the worker's 16-bit result must be used, not dropped`);
  assert.ok(out instanceof ImageData, `${label}: an ImageData`);
  assert.equal(out.width, W16);
  assert.equal(out.height, H16);
  assert.ok(out.__image16.data instanceof Uint16Array, `${label}: the plane is viewed as 16-bit samples`);
  assert.equal(out.__image16.data.length, 4 * W16 * H16);
  assert.deepEqual(Array.from(out.__image16.data), Array.from(POSTED16), `${label}: posted samples, not bytes`);
  assert.equal(out.data.length, 4 * W16 * H16);
  for (let i = 0; i < POSTED16.length; i++) assert.equal(out.data[i], POSTED16[i] >>> 8, `${label}: mirror sample ${i}`);
}

{
  // The regression: a 16-bit buffer read as bytes and "converted" doubles the
  // length, which a real ImageData rejects.
  const bytes = new Uint8ClampedArray(new Uint16Array([0x1234, 0xabcd]).buffer);
  assert.deepEqual(Array.from(new Uint16Array(bytes)), [0x34, 0x12, 0xcd, 0xab], 'a converting copy yields byte values');
  assert.deepEqual(Array.from(new Uint16Array(bytes.buffer)), [0x1234, 0xabcd], 'a view yields the samples');
  assert.throws(() => new ImageData(new Uint8ClampedArray(2 * 4 * W16 * H16), W16, H16), { name: 'IndexSizeError' });
}

{
  reset(() => reply16());
  const image = create16BitImage();
  const planeBefore = Array.from(image.__image16.data);
  const out = await workerApplyAdjustments16(image, identitySettings(), 'full');
  assertAdjusted16(out, 'bits: 16 with mirror');
  assert.equal(lastPost.message.type, 'applyAdjustments16');
  assert.equal(lastPost.message.planeOnly, false);
  assert.equal(lastPost.message.inputBuffer.byteLength, 0, 'the plane copy is transferred, not cloned');
  assert.deepEqual(Array.from(image.__image16.data), planeBefore, "the caller's plane is intact");
  assert.ok(out.__image16.data.buffer !== image.__image16.data.buffer);
}

{
  // A reply without the mirror: the bridge builds it with downconvertPlane16.
  reset(() => reply16({ mirror: false }));
  assertAdjusted16(await workerApplyAdjustments16(create16BitImage(), identitySettings(), 'full'), 'bits: 16 without mirror');
}

{
  reset(() => reply16({ mirror: false }));
  const out = await workerApplyAdjustments16(create16BitImage(), identitySettings(), 'full', { planeOnly: true });
  assert.equal(lastPost.message.planeOnly, true, 'the worker is told to skip the mirror');
  assert.ok(out && !('data' in out), 'planeOnly returns no 8-bit mirror');
  assert.equal(out.width, W16);
  assert.equal(out.height, H16);
  assert.deepEqual(Array.from(out.__image16.data), Array.from(POSTED16));
}

{
  // Wrong-length results (bytes posted as if they were samples, or a plane of
  // another size) fall back and warn once per session.
  resetWorkerFallbackWarnings();
  const warnings = await countWarnings('applyAdjustments16', async () => {
    reset(() => reply16({ bits: 8, mirror: false }));
    assert.equal(await workerApplyAdjustments16(create16BitImage(), identitySettings(), 'full'), null, 'a byte result is rejected');
    reset(() => reply16({ samples: new Uint16Array(4 * W16 * H16 * 2) }));
    assert.equal(await workerApplyAdjustments16(create16BitImage(), identitySettings(), 'full'), null, 'a doubled plane is rejected');
  });
  assert.equal(warnings, 1, 'two failures log exactly one warning');
}

{
  // A plane of another size never reaches the worker: the main-thread path
  // runs the 8-bit stage for it.
  reset(() => reply16());
  const image = create16BitImage();
  image.__image16 = { width: 2, height: 2, data: new Uint16Array(16) };
  assert.equal(await workerApplyAdjustments16(image, identitySettings(), 'full'), null);
  assert.equal(lastPost, null, 'nothing was posted');
  image.__image16 = null;
  assert.equal(await workerApplyAdjustments16(image, identitySettings(), 'full'), null);
}

{
  // A malformed buffer must fail the request rather than strand it.
  reset(() => ({
    kind: 'respond',
    respond: (received) => {
      const odd = new ArrayBuffer(4 * W16 * H16 * 2 + 1);
      return { data: { type: 'result', data: odd, width: received.width, height: received.height, bits: 16 }, transfer: [odd] };
    }
  }));
  assert.equal(await workerApplyAdjustments16(create16BitImage(), identitySettings(), 'full'), null);
}

// ------------------------------------------------------------- sliced copies

{
  const backing = Uint8Array.from({ length: 103 }, (_, i) => (i * 37) & 0xff);
  const view = new Uint16Array(backing.buffer, 2, 50); // offset view, 100 bytes
  let done = false;
  const copying = copyTypedArrayInSlices(view, { sliceBytes: 7 }).then((buffer) => { done = true; return buffer; });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(done, false, 'the copy yields to other tasks between slices');
  const copy = await copying;
  assert.ok(copy instanceof ArrayBuffer);
  assert.equal(copy.byteLength, 100);
  assert.deepEqual(new Uint8Array(copy), backing.subarray(2, 102), 'the sliced copy equals the source bytes');
  const small = await copyTypedArrayInSlices(view);
  assert.deepEqual(new Uint8Array(small), backing.subarray(2, 102), 'a copy below one slice is a single set');

  const controller = new AbortController();
  const pending = copyTypedArrayInSlices(view, { sliceBytes: 10, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (err) => isAbortError(err), 'the abort signal is honoured between slices');
}

// ---------------------------------------------------------- gain-map requests

function createGainMapInputs() {
  const source = create16BitImage();
  const sdr = new ImageData(Uint8ClampedArray.from({ length: W16 * H16 * 4 }, (_, i) => (i * 11) & 0xff), W16, H16);
  return { source, sdr, plane: source.__image16 };
}

const MAP_BYTES = [10, 10, 10, 255];
const replyGainMap = () => ({
  kind: 'respond',
  respond: () => {
    const map = new Uint8ClampedArray(MAP_BYTES);
    return { data: { type: 'gainMapResult', data: map.buffer, width: 1, height: 1, gainMax: 0.25, gainMin: 0 }, transfer: [map.buffer] };
  }
});
const replyEcho = () => ({
  kind: 'respond',
  respond: (received) => ({
    data: { type: 'error', message: 'adjustment failed', returned: { plane: received.inputBuffer, sdr: received.sdrBuffer } },
    transfer: [received.inputBuffer, received.sdrBuffer]
  })
});

{
  // Copy mode: the caller's plane and SDR frame stay intact.
  reset(replyGainMap);
  const { source, sdr, plane } = createGainMapInputs();
  const buffer = plane.data.buffer;
  const samples = Array.from(plane.data);
  const map = await workerGainMap16(source, sdr, identitySettings());
  assert.deepEqual(Array.from(map.data), MAP_BYTES);
  assert.equal(map.gainMax, 0.25);
  assert.equal(map.width, 1);
  assert.equal(lastPost.message.type, 'gainMap16');
  assert.equal(lastPost.transfers.length, 2);
  assert.ok(lastPost.transfers[0] !== buffer, 'copy mode sends a copy');
  assert.equal(plane.data.buffer, buffer);
  assert.deepEqual(Array.from(plane.data), samples, 'copy mode leaves the source intact');
  assert.equal(sdr.data.length, W16 * H16 * 4, 'the SDR frame is always copied');
  assert.ok(lastPost.message.settings.curves.r instanceof Uint8Array);
}

{
  // Transfer mode: the plane itself goes to the worker and stays there.
  reset(replyGainMap);
  const { source, sdr, plane } = createGainMapInputs();
  const buffer = plane.data.buffer;
  const map = await workerGainMap16(source, sdr, identitySettings(), { transferPlane: true });
  assert.ok(map);
  assert.equal(lastPost.transfers[0], buffer, 'transfer mode hands over the plane without a copy');
  assert.equal(plane.data.byteLength, 0, 'transfer mode detaches the source');
  assert.equal(sdr.data.length, W16 * H16 * 4, 'the SDR frame is never transferred');
}

{
  // A plane that is a view into a larger buffer is copied even in transfer mode.
  reset(replyGainMap);
  const { source, sdr, plane } = createGainMapInputs();
  const larger = new Uint16Array(plane.data.length + 8);
  larger.set(plane.data, 4);
  plane.data = larger.subarray(4, 4 + W16 * H16 * 4);
  assert.ok(await workerGainMap16(source, sdr, identitySettings(), { transferPlane: true }));
  assert.equal(larger.byteLength, (W16 * H16 * 4 + 8) * 2, 'a shared buffer is not detached');
}

{
  // Error echo: the worker hands the buffers back; the plane is re-attached.
  resetWorkerFallbackWarnings();
  let result;
  const { source, sdr, plane } = createGainMapInputs();
  const samples = Array.from(plane.data);
  const warnings = await countWarnings('gainMap16', async () => {
    reset(replyEcho);
    result = await workerGainMap16(source, sdr, identitySettings(), { transferPlane: true });
  });
  assert.equal(result, null, 'an error resolves null for the main-thread fallback');
  assert.equal(source.__image16, plane, 'the same plane object');
  assert.deepEqual(Array.from(plane.data), samples, 'the returned buffer is re-attached to the plane');
  assert.equal(warnings, 1);
}

{
  // A crash after a transfer loses the plane: that must not look like "no map".
  reset(() => ({ kind: 'crash' }));
  const { source, sdr } = createGainMapInputs();
  await assert.rejects(
    workerGainMap16(source, sdr, identitySettings(), { transferPlane: true }),
    (err) => {
      assert.ok(isExportInputLostError(err), `expected ExportInputLostError, got ${err.name}`);
      return true;
    }
  );
  // The same crash in copy mode is an ordinary fallback.
  reset(() => ({ kind: 'crash' }));
  const copy = createGainMapInputs();
  const samples = Array.from(copy.plane.data);
  assert.equal(await workerGainMap16(copy.source, copy.sdr, identitySettings()), null);
  assert.deepEqual(Array.from(copy.plane.data), samples);
  // A timeout after a transfer is lost input too.
  reset(() => ({ kind: 'hang' }));
  const timed = createGainMapInputs();
  await withEventLoopAlive(() => assert.rejects(
    workerGainMap16(timed.source, timed.sdr, identitySettings(), { transferPlane: true, timeoutMs: 20 }),
    (err) => isExportInputLostError(err)
  ));
}

{
  // A worker that cannot be posted to never detaches the plane.
  reset(() => ({ kind: 'throw', error: new Error('DataCloneError') }));
  const { source, sdr, plane } = createGainMapInputs();
  assert.equal(await workerGainMap16(source, sdr, identitySettings(), { transferPlane: true }), null);
  assert.equal(plane.data.length, W16 * H16 * 4);
}

{
  // Cancellation rejects instead of falling back.
  reset(() => ({ kind: 'hang' }));
  const controller = new AbortController();
  const { source, sdr } = createGainMapInputs();
  const promise = workerGainMap16(source, sdr, identitySettings(), { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  await assert.rejects(promise, (err) => isAbortError(err));
}

{
  // Inputs that produce no map never reach the worker.
  reset(replyGainMap);
  const { source, sdr } = createGainMapInputs();
  assert.equal(await workerGainMap16(source, new ImageData(new Uint8ClampedArray(16), 2, 2), identitySettings()), null);
  const unmatched = createGainMapInputs();
  unmatched.source.__image16 = { width: 2, height: 2, data: new Uint16Array(16) };
  assert.equal(await workerGainMap16(unmatched.source, unmatched.sdr, identitySettings()), null);
  assert.equal(await workerGainMap16({ width: W16, height: H16, data: sdr.data }, sdr, identitySettings()), null);
  assert.equal(lastPost, null);
  assert.ok(source);
}

terminateWorker();

console.log('workerBridge.test.mjs passed');

// ------------------------- independent bridges and the batch pool
{
  const { createExportWorkerBridge, createExportWorkerPool } = await import('./workerBridge.js');
  reset(() => ({ kind: 'hang' }));
  const a = createExportWorkerBridge();
  const b = createExportWorkerBridge();
  const pa = a.workerEncodePng16(createImageData(), { timeoutMs: 0 });
  assert.equal(workers.length, 1, 'a bridge starts its own worker lazily');
  assert.equal(a.pendingCount, 1);
  assert.equal(b.pendingCount, 0);
  const pb = b.workerEncodePng16(createImageData(), { timeoutMs: 0 });
  assert.equal(workers.length, 2, 'the second bridge gets a second worker');
  assert.equal(a.workerAlive, true, 'workerAlive reports the lazily started worker');
  a.terminateWorker();
  assert.equal(a.workerAlive, false, 'and never spawns one itself');
  assert.equal(workers.length, 2);
  assert.equal(await pa, null, 'terminating one bridge fails only its own request');
  assert.equal(b.pendingCount, 1, 'the other bridge is untouched');
  assert.ok(workers[0].terminated && !workers[1].terminated);
  b.terminateWorker();
  assert.equal(await pb, null);

  reset(() => ({ kind: 'hang' }));
  const pool = createExportWorkerPool({ size: 2 });
  assert.equal(pool.size, 2);
  assert.equal(typeof pool.workerGainMap16, 'function', 'the pool exposes the gain-map request');
  const r1 = pool.workerEncodeTiff(createImageData(), 8, { timeoutMs: 0 });
  const r2 = pool.workerEncodeTiff(createImageData(), 8, { timeoutMs: 0 });
  const r3 = pool.workerEncodeTiff(createImageData(), 8, { timeoutMs: 0 });
  assert.equal(workers.length, 2, 'the pool spreads requests over its lanes');
  assert.equal(workers[0].posts.length, 2, 'the third request joins the least-busy lane');
  assert.equal(workers[1].posts.length, 1);
  assert.equal(pool.pendingCount, 3);
  pool.dispose();
  assert.deepEqual(await Promise.all([r1, r2, r3]), [null, null, null]);
  assert.ok(workers.every(w => w.terminated), 'dispose terminates every lane');
  console.log('workerBridge: independent bridges and pool dispatch verified');
}

// Standalone Node test for the plane ownership rules of workerBridge.js (#250):
// which inputs move to the worker without a copy, how a returned input is
// re-attached, when an input is lost, the one-task copy of the display buffer,
// the fused 16-bit request, the PNG8/JPEG encode request and the idle release.
import assert from 'node:assert/strict';

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
    this.posts.push({ message, transfers });
    const plan = script(message, this) || { kind: 'blob' };
    if (plan.kind === 'throw') throw plan.error || new Error('postMessage failed');
    // Transferred buffers move and the caller's views detach, as with a real Worker.
    const received = structuredClone(message, { transfer: transfers });
    if (plan.kind === 'hang') return;
    queueMicrotask(() => {
      if (this.terminated) return;
      if (plan.kind === 'crash') {
        this.onerror(new Error('boom'));
        return;
      }
      if (plan.kind === 'respond') {
        const { data, transfer = [] } = plan.respond(received);
        this.onmessage({ data: { id: message.id, ...structuredClone(data, { transfer }) } });
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
// A real ImageData's fields are read-only. Chrome reports them as own,
// enumerable, non-writable properties: model that, so a bridge that tried to
// refill one in place, or copied them onto a new frame, would fail here.
globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    if (!(data instanceof Uint8ClampedArray)) throw new TypeError('ImageData needs a Uint8ClampedArray');
    if (data.length !== 4 * width * height) throw new DOMException('bad length', 'IndexSizeError');
    for (const [key, value] of Object.entries({ data, width, height })) {
      Object.defineProperty(this, key, { value, enumerable: true, writable: false, configurable: false });
    }
  }
};

const bridgeModule = await import('./workerBridge.js');
const {
  COPY_SLICE_BYTES,
  IDLE_RELEASE_MIN_PIXELS,
  createExportWorkerBridge,
  createExportWorkerPool,
  encodeImageSupported,
  isAbortError,
  isExportInputLostError,
  resetEncodeImageSupport,
  resetWorkerFallbackWarnings
} = bridgeModule;
const {
  isOwnedBuffer,
  markLiveMutableBuffer,
  markOwnedPlanes,
  planeBuffersOf,
  setLiveReferenceProbe
} = await import('../app/planeRelease.js');

const W = 3;
const H = 2;
const N = W * H * 4;

function frame8(fill = 9) {
  return new ImageData(Uint8ClampedArray.from({ length: N }, (_, i) => (i % 4 === 3 ? 255 : (fill + i * 7) & 0xff)), W, H);
}

function frame16() {
  const image = frame8();
  image.__image16 = { width: W, height: H, data: Uint16Array.from({ length: N }, (_, i) => (i % 4 === 3 ? 65535 : (i * 1031) & 0xffff)) };
  return image;
}

const identity = () => {
  const ramp = Uint8Array.from({ length: 256 }, (_, v) => v);
  return { curves: { r: ramp, g: new Uint8Array(ramp), b: new Uint8Array(ramp) } };
};

function fresh(nextScript) {
  workers = [];
  lastPost = null;
  script = nextScript;
  resetWorkerFallbackWarnings();
  return createExportWorkerBridge();
}

// The worker's in-place reply: the same buffer back, each sample + 1.
const replyInPlace16 = ({ mirror = false } = {}) => ({
  kind: 'respond',
  respond: (received) => {
    const plane = new Uint16Array(received.inputBuffer);
    for (let i = 0; i < plane.length; i++) plane[i] = (plane[i] + 1) & 0xffff;
    const data = { type: 'result', data: received.inputBuffer, width: received.width, height: received.height, bits: 16 };
    const transfer = [received.inputBuffer];
    if (mirror) {
      data.data8 = Uint8ClampedArray.from(plane, (v) => v >>> 8).buffer;
      transfer.push(data.data8);
    }
    return { data, transfer };
  }
});
const replyInPlace8 = () => ({
  kind: 'respond',
  respond: (received) => ({
    data: { type: 'result', data: received.inputBuffer, width: received.width, height: received.height },
    transfer: [received.inputBuffer]
  })
});
// A handled error before the write: the worker hands its inputs back.
const replyEcho = (key = 'input', code = null) => ({
  kind: 'respond',
  respond: (received) => {
    const buffers = {};
    const transfer = [];
    for (const [name, field] of Object.entries({ input: 'inputBuffer', pixels: 'pixelData', plane: null })) {
      const buffer = field ? received[field] : received.gainMap && received.gainMap.plane;
      if (buffer && (key === name || key === 'all')) {
        buffers[name] = buffer;
        transfer.push(buffer);
      }
    }
    return { data: { type: 'error', message: 'refused before writing', returned: buffers, ...(code ? { code } : {}) }, transfer };
  }
});
// An error after an in-place write: nothing comes back.
const replyWrittenError = () => ({ kind: 'respond', respond: () => ({ data: { type: 'error', message: 'failed after writing' } }) });

async function withEventLoopAlive(fn) {
  const keepAlive = setInterval(() => {}, 5);
  try {
    return await fn();
  } finally {
    clearInterval(keepAlive);
  }
}

// --------------------------------------------- transferPlane: who may move

{
  // A stamped 16-bit plane moves; the result is the same buffer, stamped.
  const bridge = fresh(() => replyInPlace16());
  const image = frame16();
  markOwnedPlanes(image.__image16);
  const buffer = image.__image16.data.buffer;
  const expected = Array.from(image.__image16.data, (v) => (v + 1) & 0xffff);
  const out = await bridge.workerApplyAdjustments16(image, identity(), 'full', { planeOnly: true, transferPlane: true });
  assert.equal(lastPost.transfers[0], buffer, 'the plane itself goes to the worker');
  assert.equal(image.__image16.data.byteLength, 0, 'transferPlane detaches the source');
  assert.deepEqual(Array.from(out.__image16.data), expected);
  assert.ok(isOwnedBuffer(out.__image16.data.buffer), 'bridge results are export-owned');
}

{
  // An unstamped plane (an editor plane) is copied even with transferPlane.
  const bridge = fresh(() => replyInPlace16());
  const image = frame16();
  const buffer = image.__image16.data.buffer;
  await bridge.workerApplyAdjustments16(image, identity(), 'full', { planeOnly: true, transferPlane: true });
  assert.notEqual(lastPost.transfers[0], buffer);
  assert.equal(image.__image16.data.length, N, 'the editor plane is intact');
}

{
  // A stamped plane that a live editor plane references is copied too (spy on
  // the transfer lists of every request).
  const editor = markOwnedPlanes(frame16());
  setLiveReferenceProbe(() => new Set(planeBuffersOf(editor)));
  try {
    const bridge = fresh(() => ({ kind: 'blob' }));
    const editorBuffers = planeBuffersOf(editor);
    const requests = [
      () => bridge.workerEncodeTiff(editor, 16, { transferPlane: true }),
      () => bridge.workerEncodeTiff(editor, 8, { transferPlane: true, onRestore: () => {} }),
      () => bridge.workerEncodePng16(editor, { transferPlane: true }),
      () => bridge.workerAdjust16AndEncode(editor, identity(), { format: 'tiff', transferPlane: true })
    ];
    for (const request of requests) {
      await request();
      for (const moved of lastPost.transfers) assert.ok(!editorBuffers.includes(moved), 'an editor plane never moves');
    }
    script = () => replyInPlace16();
    await bridge.workerApplyAdjustments16(editor, identity(), 'full', { transferPlane: true });
    script = () => replyInPlace8();
    await bridge.workerApplyAdjustments(editor, identity(), 'full', { transferPlane: true, onRestore: () => {} });
    script = () => ({ kind: 'respond', respond: () => ({ data: { type: 'imageResult', blob: new Blob(['x']), gain: null } }) });
    await bridge.workerEncodeImage(editor, { mimeType: 'image/jpeg', transferPlane: true, onRestore: () => {}, gainMap: { source: editor, settings: identity(), transferPlane: true } });
    for (const moved of lastPost.transfers) assert.ok(!editorBuffers.includes(moved));
    assert.equal(editor.data.length, N);
    assert.equal(editor.__image16.data.length, N);
  } finally {
    setLiveReferenceProbe(null);
  }
}

{
  // A real ImageData moves only when the caller can take a refilled frame back.
  const bridge = fresh(() => replyInPlace8());
  const image = markOwnedPlanes(frame8());
  await bridge.workerApplyAdjustments(image, identity(), 'full', { transferPlane: true });
  assert.equal(image.data.length, N, 'no onRestore: copied');
  const out = await bridge.workerApplyAdjustments(image, identity(), 'full', { transferPlane: true, onRestore: () => assert.fail('no restore on success') });
  assert.equal(image.data.byteLength, 0, 'with onRestore: transferred');
  assert.equal(out.data.length, N);
  assert.ok(isOwnedBuffer(out.data.buffer));
}

// ------------------------------------------------ echo, re-attach, lost

{
  // 16-bit plane: an echo re-attaches the buffer and resolves null.
  const bridge = fresh(() => replyEcho('input'));
  const image = frame16();
  markOwnedPlanes(image.__image16);
  const samples = Array.from(image.__image16.data);
  const plane = image.__image16;
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await bridge.workerApplyAdjustments16(image, identity(), 'full', { transferPlane: true }), null);
    assert.equal(image.__image16, plane);
    assert.deepEqual(Array.from(plane.data), samples, 'the returned buffer is re-attached');
    assert.equal(await bridge.workerAdjust16AndEncode(image, identity(), { format: 'png', transferPlane: true }), null);
    assert.deepEqual(Array.from(plane.data), samples);
  } finally {
    console.warn = warn;
  }
}

{
  // 8-bit ImageData: an echo hands a refilled copy of the frame to onRestore,
  // expando properties included.
  const bridge = fresh(() => replyEcho('input'));
  const image = markOwnedPlanes(frame8());
  image.__gainMapSource = { tag: 'kept' };
  const samples = Array.from(image.data);
  let restored = null;
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await bridge.workerApplyAdjustments(image, identity(), 'full', { transferPlane: true, onRestore: (frame) => { restored = frame; } }), null);
  } finally {
    console.warn = warn;
  }
  assert.ok(restored instanceof ImageData);
  assert.deepEqual(Array.from(restored.data), samples);
  assert.equal(restored.__gainMapSource.tag, 'kept');
  assert.ok(isOwnedBuffer(restored.data.buffer), 'the refilled frame is still export-owned');
}

{
  // A failure after the in-place write, a crash or a timeout loses a
  // transferred input: ExportInputLostError. A copied input just falls back.
  const cases = [
    ['written error', () => replyWrittenError()],
    ['crash', () => ({ kind: 'crash' })]
  ];
  const errorLog = console.error;
  const warn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  try {
    for (const [label, plan] of cases) {
      let bridge = fresh(plan);
      const image = frame16();
      markOwnedPlanes(image.__image16);
      await assert.rejects(bridge.workerApplyAdjustments16(image, identity(), 'full', { transferPlane: true }), (err) => isExportInputLostError(err), label);
      bridge = fresh(plan);
      const owned = frame16();
      markOwnedPlanes(owned.__image16);
      await assert.rejects(bridge.workerAdjust16AndEncode(owned, identity(), { format: 'tiff', transferPlane: true }), (err) => isExportInputLostError(err), `${label}: fused`);
      bridge = fresh(plan);
      const sdr = markOwnedPlanes(frame8());
      await assert.rejects(bridge.workerEncodeTiff(sdr, 8, { transferPlane: true, onRestore: () => {} }), (err) => isExportInputLostError(err), `${label}: 8-bit TIFF`);
      bridge = fresh(plan);
      const copy = frame16();
      assert.equal(await bridge.workerApplyAdjustments16(copy, identity(), 'full', { transferPlane: true }), null, `${label}: copy mode falls back`);
      assert.equal(copy.__image16.data.length, N);
    }
    const bridge = fresh(() => ({ kind: 'hang' }));
    const image = frame16();
    markOwnedPlanes(image.__image16);
    await withEventLoopAlive(() => assert.rejects(
      bridge.workerAdjust16AndEncode(image, identity(), { format: 'tiff', transferPlane: true, timeoutMs: 20 }),
      (err) => isExportInputLostError(err)
    ));
    // Cancellation stays a cancellation.
    const cancelled = fresh(() => ({ kind: 'hang' }));
    const controller = new AbortController();
    const other = frame16();
    markOwnedPlanes(other.__image16);
    const pending = cancelled.workerAdjust16AndEncode(other, identity(), { format: 'tiff', transferPlane: true, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await assert.rejects(pending, (err) => isAbortError(err) && err.inputLost === true);
  } finally {
    console.error = errorLog;
    console.warn = warn;
  }
}

{
  // A postMessage that throws moved nothing: an ordinary fallback.
  const bridge = fresh(() => ({ kind: 'throw', error: new Error('DataCloneError') }));
  const image = frame16();
  markOwnedPlanes(image.__image16);
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await bridge.workerAdjust16AndEncode(image, identity(), { format: 'tiff', transferPlane: true }), null);
  } finally {
    console.warn = warn;
  }
}

// ------------------------------------------------- copies: sliced or one task

{
  // A large plane is copied in slices (the request is posted after other
  // tasks ran); the display buffer the editor rewrites in place is copied in
  // one task (posted in the caller's task), so it cannot tear.
  const big = COPY_SLICE_BYTES + 4096;
  const pixels = big / 4;
  const width = 1024;
  const height = Math.floor(pixels / width);
  const make = () => ({ width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) });
  const bridge = fresh(() => ({ kind: 'blob' }));
  const sliced = make();
  const request = bridge.workerEncodeTiff(sliced, 8);
  assert.equal(lastPost, null, 'a sliced copy yields before posting');
  await request;
  assert.ok(lastPost);
  lastPost = null;
  const display = make();
  markLiveMutableBuffer(display);
  const request2 = bridge.workerEncodeTiff(display, 8);
  assert.ok(lastPost, 'the display buffer is copied and posted in one task');
  assert.notEqual(lastPost.transfers[0], display.data.buffer, 'a copy, never the display buffer itself');
  assert.equal(display.data.length, width * height * 4);
  await request2;
}

// ------------------------------------------------------ adjust16AndEncode

{
  const bridge = fresh(() => ({ kind: 'blob' }));
  const image = frame16();
  const metadata = { exif: { Make: 'x' }, xmp: null };
  const blob = await bridge.workerAdjust16AndEncode(image, identity(), { format: 'tiff', metadata });
  assert.equal(blob.size, 2);
  assert.equal(lastPost.message.type, 'adjust16AndEncode');
  assert.equal(lastPost.message.format, 'tiff');
  assert.deepEqual(lastPost.message.metadata, metadata, 'TIFF metadata goes into the IFD in the worker');
  assert.ok(lastPost.message.settings.curves.r instanceof Uint8Array);
  await bridge.workerAdjust16AndEncode(image, identity(), { format: 'png', metadata });
  assert.equal(lastPost.message.metadata, null, 'PNG metadata stays on the main thread');
  lastPost = null;
  assert.equal(await bridge.workerAdjust16AndEncode(frame8(), identity(), { format: 'tiff' }), null, 'no plane: today\'s path');
  const mismatched = frame16();
  mismatched.__image16 = { width: 2, height: 2, data: new Uint16Array(16) };
  assert.equal(await bridge.workerAdjust16AndEncode(mismatched, identity(), { format: 'tiff' }), null);
  assert.equal(await bridge.workerAdjust16AndEncode(frame16(), identity(), { format: 'jpeg' }), null);
  assert.equal(lastPost, null, 'nothing that does not qualify reaches the worker');
}

// ------------------------------------------------------------ encodeImage

{
  resetEncodeImageSupport();
  const replyImage = (gain = null) => ({
    kind: 'respond',
    respond: () => ({ data: { type: 'imageResult', blob: new Blob(['jpeg']), gain } })
  });
  let bridge = fresh(() => replyImage({ blob: new Blob(['map']), gainMax: 1.5, gainMin: 0 }));
  const sdr = markOwnedPlanes(frame8());
  const processed = frame16();
  markOwnedPlanes(processed.__image16);
  const result = await bridge.workerEncodeImage(sdr, {
    mimeType: 'image/jpeg', quality: 0.92, transferPlane: true, onRestore: () => {},
    gainMap: { source: processed, settings: identity(), transferPlane: true }
  });
  assert.equal(result.blob.size, 4);
  assert.equal(result.gain.gainMax, 1.5);
  assert.equal(lastPost.message.type, 'encodeImage');
  assert.equal(lastPost.message.quality, 0.92);
  assert.equal(lastPost.transfers.length, 2, 'the SDR frame and the plane move in one request');
  assert.equal(sdr.data.byteLength, 0);
  assert.equal(processed.__image16.data.byteLength, 0);
  assert.equal(encodeImageSupported(), true);

  // PNG carries no quality and no map.
  await bridge.workerEncodeImage(frame8(), { mimeType: 'image/png', quality: 0.5, gainMap: { source: frame16(), settings: identity() } });
  assert.equal(lastPost.message.quality, undefined);
  assert.equal(lastPost.message.gainMap, null);
  // A plane of another size produces no map, as before.
  const odd = frame16();
  odd.__image16 = { width: 2, height: 2, data: new Uint16Array(16) };
  await bridge.workerEncodeImage(frame8(), { mimeType: 'image/jpeg', gainMap: { source: odd, settings: identity() } });
  assert.equal(lastPost.message.gainMap, null);

  // A non-opaque frame: null for this call, pixels back, support not cached.
  bridge = fresh(() => replyEcho('all', 'unsupported-alpha'));
  let restored = null;
  const translucent = markOwnedPlanes(frame8());
  const plane = frame16();
  markOwnedPlanes(plane.__image16);
  const planeSamples = Array.from(plane.__image16.data);
  assert.equal(await bridge.workerEncodeImage(translucent, {
    mimeType: 'image/jpeg', transferPlane: true, onRestore: (frame) => { restored = frame; },
    gainMap: { source: plane, settings: identity(), transferPlane: true }
  }), null);
  assert.equal(restored.data.length, N, 'the frame comes back for the canvas path');
  assert.deepEqual(Array.from(plane.__image16.data), planeSamples, 'the plane comes back for the fallback map');
  assert.equal(encodeImageSupported(), true, 'a non-opaque frame says nothing about support');

  // No OffscreenCanvas encode: detected once for the page, not once per frame
  // (single exports use a fresh bridge each time).
  resetEncodeImageSupport();
  bridge = fresh(() => replyEcho('all', 'unsupported'));
  const warn = console.warn;
  let warnings = 0;
  console.warn = () => { warnings++; };
  try {
    assert.equal(await bridge.workerEncodeImage(frame8(), { mimeType: 'image/png' }), null);
    assert.equal(encodeImageSupported(), false);
    const posts = workers.reduce((sum, w) => sum + w.posts.length, 0);
    const next = fresh(() => assert.fail('an unsupported engine is not asked again'));
    assert.equal(await next.workerEncodeImage(frame8(), { mimeType: 'image/jpeg' }), null);
    assert.equal(await bridge.workerEncodeImage(frame8(), { mimeType: 'image/png' }), null);
    assert.equal(workers.reduce((sum, w) => sum + w.posts.length, 0), 0, 'no request was posted');
    assert.equal(posts, 1);
    assert.equal(warnings, 0, 'unsupported is not a failure');
  } finally {
    console.warn = warn;
  }
  resetEncodeImageSupport();
}

// --------------------------------------------------------- idle release

{
  workers = [];
  script = () => ({ kind: 'blob' });
  const bridge = createExportWorkerBridge({ idleReleaseMs: 20 });
  const small = { width: 10, height: 10, data: new Uint8ClampedArray(8) };
  const large = { width: 5000, height: Math.ceil(IDLE_RELEASE_MIN_PIXELS / 5000) + 1, data: new Uint8ClampedArray(8) };
  await bridge.workerEncodeTiff(small, 8);
  await withEventLoopAlive(() => new Promise((resolve) => setTimeout(resolve, 40)));
  assert.ok(bridge.hasWorker && !workers[0].terminated, 'small requests do not arm the release');

  await bridge.workerEncodeTiff(large, 8);
  await withEventLoopAlive(() => new Promise((resolve) => setTimeout(resolve, 40)));
  assert.equal(bridge.hasWorker, false, 'an idle worker is released after a large request');
  assert.ok(workers[0].terminated);

  // A new request cancels the timer.
  await bridge.workerEncodeTiff(large, 8);
  await bridge.workerEncodeTiff(small, 8);
  assert.ok(bridge.hasWorker);
  await withEventLoopAlive(() => new Promise((resolve) => setTimeout(resolve, 5)));
  const again = bridge.workerEncodeTiff(small, 8);
  await again;
  await withEventLoopAlive(() => new Promise((resolve) => setTimeout(resolve, 40)));
  assert.equal(bridge.hasWorker, false);

  // Never with something pending: a hung request keeps the worker.
  script = () => ({ kind: 'hang' });
  const hung = bridge.workerEncodeTiff(small, 8, { timeoutMs: 0 });
  script = () => ({ kind: 'blob' });
  await bridge.workerEncodeTiff(large, 8);
  await withEventLoopAlive(() => new Promise((resolve) => setTimeout(resolve, 40)));
  assert.ok(bridge.hasWorker, 'a pending request keeps the worker alive');
  assert.equal(bridge.pendingCount, 1);
  bridge.terminateWorker();
  assert.equal(await hung, null);

  // Bridges without the option never release on their own.
  workers = [];
  const plain = createExportWorkerBridge();
  await plain.workerEncodeTiff(large, 8);
  await withEventLoopAlive(() => new Promise((resolve) => setTimeout(resolve, 40)));
  assert.ok(plain.hasWorker);
  plain.terminateWorker();
  assert.equal(bridgeModule.defaultExportBridge.hasWorker, false);
}

// ------------------------------------------------------------------ pool

{
  workers = [];
  script = () => ({ kind: 'blob' });
  const pool = createExportWorkerPool({ size: 1 });
  assert.equal(pool.size, 1);
  for (const name of ['workerAdjust16AndEncode', 'workerEncodeImage']) assert.equal(typeof pool[name], 'function', `the pool exposes ${name}`);
  assert.ok(await pool.workerAdjust16AndEncode(frame16(), identity(), { format: 'png' }));
  pool.dispose();
  assert.ok(workers.every((w) => w.terminated), 'dispose releases a size-1 pool too');
}

console.log('workerBridgeOwnership.test.mjs passed');

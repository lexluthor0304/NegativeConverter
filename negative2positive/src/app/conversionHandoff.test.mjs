// Standalone Node test for the batch conversion hand-off (#250 Part 4): the
// real conversion worker module runs in-process behind the real client, and
// every message crosses a structured clone with its transfer list.
// - 'lend' posts the 16-bit source with a transfer list and gets it back,
//   byte for byte, with the result or the error;
// - 'consume' posts it with `ownedSource` and does not get it back; the output
//   is bit-identical to the cloned path;
// - a crash after a transfer rejects with INPUT_LOST, never a detached plane
//   for the main-thread fallback;
// - `releaseAfter` leaves the lane's slot without source or pristine plane.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

globalThis.ImageData = class ImageData {
  constructor(data, width, height) { Object.assign(this, { data, width, height }); }
};

let activeWorker = null;
globalThis.self = {
  onmessage: null,
  postMessage(message, transfers = []) {
    const cloned = structuredClone(message, { transfer: transfers });
    const target = activeWorker;
    queueMicrotask(() => target && !target.terminated && target.onmessage && target.onmessage({ data: cloned }));
  }
};
await import('../workers/conversionWorker.js');

const posts = [];
class InProcessWorker {
  constructor() {
    this.onmessage = null;
    this.onerror = null;
    this.terminated = false;
    activeWorker = this;
  }
  postMessage(message, transfers = []) {
    posts.push({ message, transfers: transfers.slice() });
    const received = structuredClone(message, { transfer: transfers });
    if (this.crashNext) {
      this.crashNext = false;
      queueMicrotask(() => this.onerror(new Error('lane crashed')));
      return;
    }
    queueMicrotask(() => self.onmessage({ data: received }));
  }
  terminate() { this.terminated = true; }
}

const { createConversionWorkerPool, createConversionWorkerClient, isConversionInputLost, CONVERSION_FAILED } = await import('./conversionWorkerClient.js');
const { markOwnedPlanes, setLiveReferenceProbe, isOwnedBuffer } = await import('./planeRelease.js');
const { convertFrameWithRouter } = await import('../pipeline/conversionRouter.js');
const { inspectSlotBuffers, invalidateSilverCoreCache } = await import('../pipeline/silverAdapter.js');

const W = 41;
const H = 29;
const hash = (view) => createHash('sha256').update(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)).digest('hex');

function frame(seed = 3) {
  const plane = new Uint16Array(W * H * 4);
  for (let i = 0; i < plane.length; i += 4) {
    const t = ((i >> 2) % W) / W;
    plane[i] = 50000 - Math.round(t * 30000) + ((i * seed) % 997);
    plane[i + 1] = 36000 - Math.round(t * 22000) + ((i * seed) % 661);
    plane[i + 2] = 24000 - Math.round(t * 15000) + ((i * seed) % 331);
    plane[i + 3] = 65535;
  }
  const image = new ImageData(Uint8ClampedArray.from(plane, (v) => v >>> 8), W, H);
  image.__image16 = { width: W, height: H, data: plane };
  return image;
}

const modes = {
  colour: { filmType: 'color', colorModel: 'standard', filmBase: { r: 210, g: 140, b: 90 } },
  bw: { filmType: 'bw' },
  positive: { filmType: 'positive' }
};

for (const [mode, settings] of Object.entries(modes)) {
  // Reference: the main-thread router on a copy.
  invalidateSilverCoreCache();
  const reference = await convertFrameWithRouter({ imageData: frame(), settings, options: { forceFullProcess: true } });
  invalidateSilverCoreCache();

  const convert = createConversionWorkerPool({ size: 1, workerFactory: () => new InProcessWorker() });

  // Lend: the source moves and comes back unchanged.
  const lent = markOwnedPlanes(frame());
  const before = hash(lent.__image16.data);
  const moved = lent.__image16.data.buffer;
  posts.length = 0;
  const lentResult = await convert({ imageData: lent, settings, options: { forceFullProcess: true }, handoff: 'lend', releaseAfter: true });
  assert.equal(posts[0].transfers[0], moved, `${mode}: the lent source is posted with a transfer list`);
  assert.equal(posts[0].message.returnSource, true);
  assert.equal(posts[0].message.releaseAfter, true);
  assert.ok(!posts[0].message.rgba, `${mode}: the 8-bit plane of a 16-bit source is never sent`);
  assert.equal(hash(lent.__image16.data), before, `${mode}: the lent source comes back byte for byte`);
  assert.equal(hash(lentResult.__image16.data), hash(reference.__image16.data), `${mode}: lent output == main thread`);
  assert.equal(hash(lentResult.data), hash(reference.data));
  assert.ok(isOwnedBuffer(lentResult.__image16.data.buffer) && isOwnedBuffer(lentResult.data.buffer), `${mode}: conversion results are export-owned`);
  const slot = inspectSlotBuffers('full');
  assert.equal(slot.pristineBuffer, null, `${mode}: releaseAfter: no pristine plane in the lane`);
  assert.equal(slot.lastSourceRef, null, `${mode}: releaseAfter: no source in the lane`);
  assert.equal(slot.analysis, null);

  // Consume: the source moves, the adapter writes into it, nothing comes back.
  const consumed = markOwnedPlanes(frame());
  posts.length = 0;
  const consumedResult = await convert({ imageData: consumed, settings, options: { forceFullProcess: true }, handoff: 'consume', releaseAfter: true });
  assert.equal(posts[0].message.options.ownedSource, true, `${mode}: consume passes ownedSource`);
  assert.equal(posts[0].message.returnSource, undefined);
  assert.equal(consumed.__image16.data.byteLength, 0, `${mode}: a consumed source stays with the worker`);
  assert.equal(hash(consumedResult.__image16.data), hash(reference.__image16.data), `${mode}: owned-source output == main thread`);
  assert.equal(hash(consumedResult.data), hash(reference.data));
  convert.dispose();
}

{
  // An unstamped or live-referenced source is cloned as before (no transfer list).
  const convert = createConversionWorkerClient({ retainWorker: true, workerFactory: () => new InProcessWorker() });
  const editor = frame();
  posts.length = 0;
  await convert({ imageData: editor, settings: modes.colour, options: { forceFullProcess: true }, handoff: 'lend' });
  assert.deepEqual(posts[0].transfers, [], 'an unstamped source is cloned');
  assert.equal(editor.__image16.data.length, W * H * 4);
  const live = markOwnedPlanes(frame());
  setLiveReferenceProbe(() => new Set([live.__image16.data.buffer]));
  posts.length = 0;
  await convert({ imageData: live, settings: modes.colour, options: { forceFullProcess: true }, handoff: 'consume' });
  assert.deepEqual(posts[0].transfers, [], 'a source the editor references is cloned');
  assert.equal(posts[0].message.options.ownedSource, undefined);
  setLiveReferenceProbe(null);
  // No hand-off: the historical clone.
  const plain = markOwnedPlanes(frame());
  posts.length = 0;
  await convert({ imageData: plain, settings: modes.colour, options: { forceFullProcess: true } });
  assert.deepEqual(posts[0].transfers, []);
  convert.dispose();
}

{
  // A conversion that throws in the worker hands a lent source back: the
  // caller may convert on the main thread with intact pixels.
  const convert = createConversionWorkerClient({ retainWorker: true, workerFactory: () => new InProcessWorker() });
  const lent = markOwnedPlanes(frame());
  const before = hash(lent.__image16.data);
  await assert.rejects(
    convert({ imageData: lent, settings: null, options: { forceFullProcess: true }, handoff: 'lend' }),
    (err) => err.code === CONVERSION_FAILED && !err.returnedSource
  );
  assert.equal(hash(lent.__image16.data), before, 'the returned source is re-attached');

  // A consumed source is gone after an error: INPUT_LOST, not a fallback.
  const consumed = markOwnedPlanes(frame());
  await assert.rejects(
    convert({ imageData: consumed, settings: null, options: { forceFullProcess: true }, handoff: 'consume' }),
    (err) => isConversionInputLost(err)
  );

  // A crash after a transfer loses a lent source too.
  const errorLog = console.error;
  console.error = () => {};
  try {
    activeWorker.crashNext = true;
    const crashed = markOwnedPlanes(frame());
    await assert.rejects(
      convert({ imageData: crashed, settings: modes.colour, options: { forceFullProcess: true }, handoff: 'lend' }),
      (err) => isConversionInputLost(err)
    );
    assert.equal(crashed.__image16.data.byteLength, 0);
    // The same crash without a hand-off is the ordinary WORKER_CRASHED.
    activeWorker = null;
    const next = createConversionWorkerClient({ retainWorker: true, workerFactory: () => { const w = new InProcessWorker(); w.crashNext = true; return w; } });
    await assert.rejects(next({ imageData: frame(), settings: modes.colour, options: {} }), (err) => err.code === 'WORKER_CRASHED');
  } finally {
    console.error = errorLog;
  }
  convert.dispose();
}

invalidateSilverCoreCache();
console.log('conversionHandoff.test.mjs passed');

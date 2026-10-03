// Standalone Node test for loadRawFile's abort signal (#243) - run with:
// node negative2positive/src/app/rawFileLoader.abort.test.mjs
//
// LibRaw (the real libraw-wasm client) and the post-decode worker are faked at
// the Worker boundary. Every stage can be held, so the test aborts during
// open, metadata and imageData, between imageData and the post-decode post,
// and while the post-decode job runs. An abort must reject with an AbortError,
// dispose LibRaw and terminate the post-decode worker in the same task, never
// post work for a superseded decode, and never reach a fallback (the embedded
// preview is never read or decoded).
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
    this.kind = /rawPostDecodeWorker/.test(this.url) ? 'post' : /libraw-wasm/.test(this.url) ? 'libraw' : /scanDecodeWorker/.test(this.url) ? 'jpeg' : 'other';
    if (this.kind === 'post' && scene.postDecode === 'blocked') throw new Error('blocked');
    this.terminated = false;
    this.terminatedAt = null;
    this.received = [];
    scene.workers.push(this);
    if (this.kind === 'jpeg') queueMicrotask(() => this.onmessage?.({ data: { ready: true, canDecodeImages: true } }));
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

const superseded = () => new DOMException('Superseded photo activation', 'AbortError');

// --- a signal that is already aborted: nothing starts ----------------------------
{
  reset();
  const controller = new AbortController();
  controller.abort(superseded());
  const blob = countingBlob();
  await expectAbort('pre-aborted', loadRawFile(container().buffer, 'frame.dng', { signal: controller.signal, sourceBlob: blob.blob }), blob);
  assert.equal(scene.workers.length, 0, 'no LibRaw or post-decode worker spawned');
}

// --- abort while each LibRaw call is pending --------------------------------------
for (const stage of ['open', 'metadata', 'imageData']) {
  reset({ hold: stage });
  const controller = new AbortController();
  const blob = countingBlob();
  const metadata = [];
  const pending = loadRawFile(container().buffer, 'frame.dng', {
    signal: controller.signal, sourceBlob: blob.blob, onMetadata: meta => metadata.push(meta)
  });
  await flush();
  assert.equal(scene.held?.stage, stage, `${stage} is pending`);
  controller.abort(superseded());
  // dispose() and terminate() run inside the abort dispatch: same task.
  const libraw = workersOf('libraw')[0];
  assert.equal(libraw.terminated, true, `${stage}: LibRaw worker terminated synchronously`);
  assert.equal(workersOf('post')[0].terminated, true, `${stage}: post-decode worker terminated synchronously`);
  await expectAbort(`abort during ${stage}`, pending, blob);
  assert.ok(!libraw.received.includes('imageData') || stage === 'imageData', `${stage}: no later LibRaw call`);
  assert.deepEqual(workersOf('post')[0].received, ['ping'], `${stage}: no post-decode job posted`);
  if (stage !== 'imageData') assert.equal(metadata.length, 0, `${stage}: no metadata reported for a superseded decode`);
}

// --- abort between imageData() and the post-decode post ------------------------------
{
  reset();
  const controller = new AbortController();
  const blob = countingBlob();
  // The abort lands in the task that delivers LibRaw's pixels, before the
  // loader's continuation runs.
  scene.onReply = (kind, data) => { if (kind === 'libraw' && data.out?.data) controller.abort(superseded()); };
  const pending = loadRawFile(container().buffer, 'frame.dng', { signal: controller.signal, sourceBlob: blob.blob });
  await expectAbort('abort before the post-decode post', pending, blob);
  assert.deepEqual(workersOf('post')[0].received, ['ping'], 'no pack / defect / 8-bit job posted');
}

// --- same, with the post-decode worker unavailable (main-thread steps) -------------
{
  reset({ postDecode: 'blocked' });
  const controller = new AbortController();
  const blob = countingBlob();
  scene.onReply = (kind, data) => { if (kind === 'libraw' && data.out?.data) controller.abort(superseded()); };
  const pending = loadRawFile(container().buffer, 'frame.dng', { signal: controller.signal, sourceBlob: blob.blob });
  await expectAbort('abort before main-thread post-decode', pending, blob);
}

// --- abort while the post-decode job runs --------------------------------------------
{
  reset({ hold: 'process' });
  const controller = new AbortController();
  const blob = countingBlob();
  const pending = loadRawFile(container().buffer, 'frame.dng', { signal: controller.signal, sourceBlob: blob.blob });
  await flush();
  assert.equal(scene.held?.stage, 'process', 'the defect pass is running');
  const post = scene.held.worker;
  controller.abort(superseded());
  assert.equal(post.terminated, true, 'the per-decode worker is terminated at once');
  await expectAbort('abort during the defect pass', pending, blob);
  scene.held.release();
  await flush();
}

// --- an abort after the result has been returned changes nothing --------------------
{
  reset();
  const controller = new AbortController();
  const image = await loadRawFile(container().buffer, 'frame.dng', { signal: controller.signal, sourceBlob: countingBlob().blob });
  controller.abort(superseded());
  assert.equal(image.width, 64);
  assert.ok(image.__image16.data instanceof Uint16Array);
}

// --- a timeout without an abort still takes the embedded-preview path ------------------
// (covered in rawFileLoader.postDecode.test.mjs); here: an abort racing the
// open timeout never reaches it.
{
  reset({ hold: 'open' });
  const controller = new AbortController();
  const blob = countingBlob();
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(ms >= 10_000 ? () => { controller.abort(superseded()); fn(); } : fn, ms >= 10_000 ? 0 : ms, ...rest);
  try {
    const pending = loadRawFile(container().buffer, 'frame.dng', { signal: controller.signal, sourceBlob: blob.blob });
    await expectAbort('abort racing the open timeout', pending, blob);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}

console.log('rawFileLoader.abort.test.mjs passed');

// A LibRaw failure falls back to an embedded JPEG; superseding the photo
// during that worker decode must terminate it, with no main-thread retry.
{
  reset({ result: null, hold: 'jpeg' });
  const bytes = container();
  const app0 = [255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof0 = [255, 192, 0, 17, 8, 1080 >> 8, 1080 & 255, 1620 >> 8, 1620 & 255, 3,
    1, 34, 0, 2, 17, 1, 3, 17, 1];
  bytes.set([255, 216, ...app0, ...sof0], 4096);
  const controller = new AbortController();
  const pending = loadRawFile(bytes.buffer, 'frame.nef', { signal: controller.signal });
  await flush();
  assert.equal(scene.held?.stage, 'jpeg', 'the loader reached the JPEG worker');
  controller.abort(superseded());
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(workersOf('jpeg')[0].terminated, true);
  assert.equal(bitmapDecodes, 0, 'aborted JPEG work never falls back on the main thread');
}
console.log('rawFileLoader: embedded JPEG fallback receives the activation abort signal');

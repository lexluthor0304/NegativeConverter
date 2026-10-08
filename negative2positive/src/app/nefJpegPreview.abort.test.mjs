import assert from 'node:assert/strict';
import { decodeNefPreviewJpeg, tryNefJpegPreview } from './nefJpegPreview.js';
import { decodeJpegInWorker } from './scanDecodeClient.js';
const stash = () => ({ jpegBytes: new Uint8Array([255, 216, 1, 2, 255, 217]), width: 1, height: 1 });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const oldBitmap = globalThis.createImageBitmap, oldDocument = globalThis.document;
let canvasCopies = 0, closed = 0;
globalThis.document = { createElement() { canvasCopies++; throw new Error('no raster after abort'); } };
try {
  const c = new AbortController(); c.abort();
  await assert.rejects(tryNefJpegPreview(null, { signal: c.signal }), { name: 'AbortError' });
  await assert.rejects(decodeNefPreviewJpeg(stash(), { signal: c.signal, decodeInWorker: () => assert.fail('pre-aborted dispatch') }), { name: 'AbortError' });
  await assert.rejects(decodeJpegInWorker(stash(), { signal: c.signal, workerFactory: () => assert.fail('pre-aborted worker') }), { name: 'AbortError' });

  for (const phase of ['factory', 'ready', 'decode']) {
    const c = new AbortController(); let stops = 0, posts = 0, worker;
    const decoded = decodeJpegInWorker(stash(), { signal: c.signal, workerFactory: () => {
      worker = { terminate() { stops++; }, postMessage() { posts++; } };
      if (phase === 'factory') c.abort();
      return worker;
    } });
    const rejection = assert.rejects(decoded, { name: 'AbortError' });
    const late = worker.onmessage;
    if (phase === 'decode') worker.onmessage({ data: { ready: true, canDecodeImages: true } });
    c.abort(); await rejection;
    late?.({ data: { ready: true, canDecodeImages: true } });
    assert.equal(posts, phase === 'decode' ? 1 : 0); assert.equal(stops, 1);
    assert.equal(worker.onmessage, null);
  }
  // Even a worker implementation which ignores cancellation cannot return a
  // late frame or trigger native fallback after the caller aborts.
  for (const outcome of ['result', 'null', 'error']) {
    const c = new AbortController(), pending = deferred(); let forwarded;
    globalThis.createImageBitmap = () => assert.fail('native fallback after abort');
    const decoded = decodeNefPreviewJpeg(stash(), { signal: c.signal, decodeInWorker: (_bytes, options) => {
      forwarded = options.signal; return pending.promise;
    } });
    assert.equal(forwarded, c.signal); c.abort();
    if (outcome === 'error') pending.reject(new Error('late failure'));
    else pending.resolve(outcome === 'null' ? null : { width: 1, height: 1 });
    await assert.rejects(decoded, { name: 'AbortError' });
  }
  for (const fails of [false, true]) {
    const c = new AbortController(), pending = deferred();
    globalThis.createImageBitmap = () => pending.promise;
    const decoded = decodeNefPreviewJpeg(stash(), { signal: c.signal, decodeInWorker: null });
    c.abort();
    if (fails) pending.reject(new Error('decode failed'));
    else pending.resolve({ width: 1, height: 1, close() { closed++; } });
    await assert.rejects(decoded, { name: 'AbortError' });
  }
  assert.equal(closed, 1); assert.equal(canvasCopies, 0);
} finally {
  if (oldBitmap) globalThis.createImageBitmap = oldBitmap; else delete globalThis.createImageBitmap;
  if (oldDocument) globalThis.document = oldDocument; else delete globalThis.document;
}
console.log('Embedded JPEG cancellation: worker lifecycle, no fallback, late bitmap closure passed');

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { loadStandardImage, loadPngImageData, sniffImageKind } from './imageFileLoaders.js';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const original = new Map(['createImageBitmap', 'document', 'Image', 'Worker'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const oldCreateUrl = URL.createObjectURL, oldRevokeUrl = URL.revokeObjectURL;
let copies = 0, canvases = 0, closed = 0, images = [], revoked = [];
const pixels = { data: new Uint8ClampedArray([3, 5, 7, 255]), width: 1, height: 1 };
const bitmap = () => ({ width: 1, height: 1, close() { closed++; } });
const jpeg = new File([new Uint8Array([255, 216, 255, 0])], 'scan.jpg', { type: 'image/jpeg' });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 30 && !predicate(); i++) await tick(); assert.ok(predicate(), 'fake decoder reached'); }
try {
  globalThis.document = { createElement() { canvases++; return { getContext() { return { drawImage() { copies++; }, getImageData() { return pixels; } }; } }; } };
  globalThis.Image = class { constructor() { this.width = this.height = 1; images.push(this); } set src(value) { this.source = value; } };
  URL.createObjectURL = () => 'blob:test-image';
  URL.revokeObjectURL = url => revoked.push(url);

  // Aborted before sniffing: no IO, decode or allocation.
  {
    const c = new AbortController(); c.abort();
    await assert.rejects(loadStandardImage({ slice() { assert.fail('sniff after abort'); } }, { signal: c.signal }), { name: 'AbortError' });
  }
  // Abort during sniffing cannot start a native decode.
  {
    const c = new AbortController(), read = deferred();
    globalThis.createImageBitmap = () => assert.fail('bitmap after aborted sniff');
    const result = loadStandardImage({ slice: () => ({ arrayBuffer: () => read.promise }) }, { signal: c.signal });
    c.abort(); read.resolve(new Uint8Array([255, 216, 255]).buffer);
    await assert.rejects(result, { name: 'AbortError' });
  }
  // Native ImageBitmap has no cancel method: a late result must be closed
  // without canvas readback, and an aborted rejection must not fall back.
  for (const fails of [false, true]) {
    const c = new AbortController(), decoded = deferred(); let started = false;
    globalThis.createImageBitmap = () => { started = true; return decoded.promise; };
    const result = loadStandardImage(jpeg, { signal: c.signal });
    await until(() => started); c.abort();
    if (fails) decoded.reject(new Error('unsupported')); else decoded.resolve(bitmap());
    await assert.rejects(result, { name: 'AbortError' });
    assert.equal(canvases, 0); assert.equal(copies, 0); assert.equal(images.length, 0);
  }
  assert.equal(closed, 1);

  // <img> cancellation releases the URL and handlers; even an already-queued
  // load callback must not read pixels or start HEIF fallback.
  {
    const c = new AbortController();
    globalThis.createImageBitmap = async () => { throw new Error('unsupported'); };
    const file = new File([new Uint8Array(16)], 'scan.heic', { type: 'image/heic' });
    const result = loadStandardImage(file, { signal: c.signal });
    const rejection = assert.rejects(result, { name: 'AbortError' });
    await until(() => images.length === 1);
    const img = images[0], lateLoad = img.onload;
    c.abort(); await rejection; lateLoad();
    assert.equal(img.source, ''); assert.equal(img.onload, null); assert.equal(img.onerror, null);
    assert.deepEqual(revoked, ['blob:test-image']); assert.equal(canvases, 0);
  }

  // PNG8's browser path must forward cancellation, not start UPNG fallback.
  {
    const png = new Uint8Array(33); png.set([137, 80, 78, 71, 13, 10, 26, 10]);
    png.set([73, 72, 68, 82], 12); png[24] = 8; png[25] = 2;
    const c = new AbortController(), decoded = deferred(); let started = false;
    globalThis.createImageBitmap = () => { started = true; return decoded.promise; };
    const result = loadPngImageData(png.buffer, { signal: c.signal });
    await until(() => started); c.abort(); decoded.resolve(bitmap());
    await assert.rejects(result, { name: 'AbortError' }); assert.equal(canvases, 0);
  }

  // A PNG16 without its extension routes through content sniffing into the
  // real scan-decode client. Cancellation must reach that disposable worker.
  {
    const png = new Uint8Array(33); png.set([137, 80, 78, 71, 13, 10, 26, 10]);
    png.set([73, 72, 68, 82], 12); png[24] = 16; png[25] = 2;
    const c = new AbortController(); let stops = 0, posts = 0;
    globalThis.Worker = class {
      constructor() { queueMicrotask(() => this.onmessage?.({ data: { ready: true } })); }
      terminate() { stops++; }
      postMessage(message) {
        posts++; assert.equal(message.format, 'png');
        c.abort();
        // Make a lost signal fail promptly rather than wait for the timeout.
        this.onerror?.(new Error('abort was not forwarded'));
      }
    };
    try {
      await assert.rejects(loadStandardImage(new File([png], 'unnamed'), { signal: c.signal }), { name: 'AbortError' });
      assert.equal(posts, 1); assert.equal(stops, 1); assert.equal(canvases, 0);
    } finally {
      const descriptor = original.get('Worker');
      if (descriptor) Object.defineProperty(globalThis, 'Worker', descriptor); else delete globalThis.Worker;
    }
  }

  // Without workers, cancellation can arrive during the decoder module
  // import. Mock only that async boundary in the actual PNG loader body.
  {
    const source = fs.readFileSync(new URL('./imageFileLoaders.js', import.meta.url), 'utf8');
    const start = source.indexOf('export async function loadPngImageData(');
    const end = source.indexOf('\n}', start) + 2;
    assert.ok(start >= 0 && end > start);
    const body = source.slice(start, end).replace('export ', '')
      .replace("import('./scanDecodeClient.js')", "fakeImport('scan')")
      .replace("import('./pngFileLoader.js')", "fakeImport('png')");
    const png = new Uint8Array(33); png.set([137, 80, 78, 71, 13, 10, 26, 10]);
    png.set([73, 72, 68, 82], 12); png[24] = 16; png[25] = 2;
    const module = deferred(), c = new AbortController(); let waiting = false, decoded = 0;
    const abortStart = source.indexOf('function throwIfAborted(');
    const abortEnd = source.indexOf('\n}', abortStart) + 2;
    assert.ok(abortStart >= 0 && abortEnd > abortStart, 'real PNG abort helper exists');
    const load = vm.runInNewContext(`${source.slice(abortStart, abortEnd)}\n(${body})`, {
      DOMException, sniffImageKind,
      fakeImport: name => name === 'scan' ? Promise.resolve({ decodeScanInWorker: async () => null })
        : (waiting = true, module.promise)
    });
    const result = load(png.buffer, { signal: c.signal });
    await until(() => waiting); c.abort();
    module.resolve({ loadPngFile() { decoded++; return {}; } });
    await assert.rejects(result, { name: 'AbortError' }); assert.equal(decoded, 0);
  }

  // Exercise the actual shared UI loader used by mergeSelectedShots. The
  // supplied reservation may resolve despite an abort; no decode may follow.
  const source = fs.readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  const start = source.indexOf('    async function loadFileToImageData(');
  const end = source.indexOf('\n    // PNG16 compression settings.', start);
  assert.ok(start > 0 && end > start);
  let loaderCalls = 0;
  const load = vm.runInNewContext(`(${source.slice(start, end).trim()})`, {
    DOMException, isRawLikeFileName: () => false, isPngFile: () => false,
    sharedPlanesAvailable: () => false, rememberImageDimensions() {},
    loadStandardImage: (...args) => { loaderCalls++; return loadStandardImage(...args); }
  });
  {
    const c = new AbortController(), grant = deferred();
    const result = load(jpeg, { signal: c.signal, claim: { atDecode: () => grant.promise } });
    c.abort(); grant.resolve();
    await assert.rejects(result, { name: 'AbortError' }); assert.equal(loaderCalls, 0);
  }
  {
    const c = new AbortController(), decoded = deferred(); let started = false;
    globalThis.createImageBitmap = () => { started = true; return decoded.promise; };
    const result = load(jpeg, { signal: c.signal, claim: { atDecode: async () => {} } });
    await until(() => started); c.abort(); decoded.resolve(bitmap());
    await assert.rejects(result, { name: 'AbortError' }); assert.equal(loaderCalls, 1);
    assert.equal(canvases, 0); assert.equal(copies, 0);
  }
  // TIFF-named JPEGs take the RAW dispatcher's content-sniffed fallback.
  {
    const { loadRawFile } = await import('./rawFileLoader.js');
    const c = new AbortController(), decoded = deferred(); let started = false;
    globalThis.createImageBitmap = () => { started = true; return decoded.promise; };
    const result = loadRawFile(new Uint8Array([255, 216, 255, 0]).buffer, 'renamed.tif', { signal: c.signal });
    await until(() => started); c.abort(); decoded.resolve(bitmap());
    await assert.rejects(result, { name: 'AbortError' }); assert.equal(canvases, 0);
  }
  // Ordinary successful decode keeps its exact pixels and closes its bitmap.
  globalThis.createImageBitmap = async () => bitmap();
  assert.equal(await loadStandardImage(jpeg), pixels);
  assert.equal(canvases, 1); assert.equal(copies, 1); assert.equal(closed, 5);
} finally {
  for (const [key, descriptor] of original) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
  URL.createObjectURL = oldCreateUrl; URL.revokeObjectURL = oldRevokeUrl;
}
console.log('Standard image cancellation: sniff, late bitmap, img, PNG8 and actual UI loader passed');

import assert from 'node:assert/strict';
import { createPhotoSessionCache } from './photoSessionCache.js';

const pixels = bytes => ({ data: new Uint8ClampedArray(bytes) });

// ImageData's native data property is inherited/non-enumerable in browsers.
class NativeImageShape {
  #plane;
  constructor(plane) { this.#plane = plane; }
  get data() { return this.#plane; }
}

{
  const buffer = new ArrayBuffer(64);
  const image = new NativeImageShape(new Uint8ClampedArray(buffer, 8, 16));
  image.__image16 = { data: new Uint16Array(buffer, 0, 8) };
  const extra = new ArrayBuffer(12);
  const snapshot = {
    base: image,
    history: [{ refs: { image, slice: new DataView(buffer, 4, 4) } }],
    nested: new Map([[new Uint8Array(extra), new Set([buffer, image])]]),
    originalFile: new Blob([new Uint8Array(1024)]),
  };
  snapshot.self = snapshot;
  snapshot[Symbol('history')] = new Uint8Array(extra);
  const cache = createPhotoSessionCache({ maxBytes: 76 });
  assert.equal(cache.put('a', snapshot), true);
  assert.equal(cache.bytes, 76, 'charge complete backing stores, not view lengths, once per graph');
  assert.equal(cache.size, 1);
  assert.equal(cache.put('b', { refs: [image, new Uint8Array(extra)] }), true);
  assert.equal(cache.bytes, 76, 'deduplicate backing stores across different entries');
  assert.equal(cache.size, 2);
  assert.equal(cache.take('a'), snapshot);
  assert.equal(cache.bytes, 76, 'remaining entry still owns the shared stores');
  assert.equal(cache.delete('b'), true);
  assert.equal(cache.bytes, 0);
  assert.equal(cache.size, 0);
  assert.equal(buffer.byteLength, 64, 'taking/evicting never detaches buffers');
  assert.equal(cache.delete('missing'), false);
  assert.equal(cache.take('missing'), null);
  assert.equal(cache.peek('missing'), null);
}

{
  const cache = createPhotoSessionCache({ maxBytes: 32 });
  const a = pixels(16), b = pixels(16), c = pixels(16);
  cache.put('a', a); cache.put('b', b);
  assert.equal(cache.peek('a'), a, 'peek touches LRU order');
  cache.put('c', c);
  assert.equal(cache.peek('b'), null);
  assert.equal(cache.bytes, 32);
  assert.equal(cache.take('a'), a);
  assert.equal(cache.bytes, 16);
  assert.equal(cache.put('c', pixels(24)), true, 'replacement releases the old store');
  assert.equal(cache.bytes, 24);
  assert.equal(cache.size, 1);
  assert.equal(cache.put('c', pixels(33)), false, 'reject oversized replacement');
  assert.equal(cache.peek('c'), null, 'do not resurrect the old same-key snapshot');
  assert.equal(cache.bytes, 0);
}

{
  const cache = createPhotoSessionCache({ maxBytes: 24 });
  const shared = new Uint8Array(16);
  cache.put('a', { shared }); cache.put('b', pixels(8));
  assert.equal(cache.put('c', { shared, extra: new Uint8Array(8) }), true);
  assert.equal(cache.peek('a'), null, 'evict oldest first even if its buffer remains shared');
  assert.equal(cache.peek('b'), null, 'continue eviction until distinct backing bytes fit');
  assert.equal(cache.size, 1);
  assert.equal(cache.bytes, 24);
  cache.put('alias', { shared });
  const rejected = { shared, extra: new Uint8Array(25) };
  assert.equal(cache.put('alias', rejected), false);
  assert.equal(cache.size, 1, 'oversized rejection does not evict unrelated entries');
  assert.equal(cache.bytes, 24);
  assert.notEqual(cache.peek('c'), null);
}

{
  const cache = createPhotoSessionCache({ maxBytes: 48 });
  const a = pixels(16), b = pixels(16), c = pixels(16);
  const key = {};
  cache.put(key, a); cache.put('b', b); cache.put('c', c);
  cache.retainKeys([key, 'c', 'absent']);
  assert.equal(cache.bytes, 32);
  assert.equal(cache.size, 2);
  assert.equal(cache.peek('b'), null);
  assert.equal(cache.take(key), a, 'keys retain their original Map identity');
  cache.retainKeys([]);
  assert.equal(cache.bytes, 0);
  assert.equal(cache.size, 0);
  cache.put('a', a); cache.clear(); cache.clear();
  assert.equal(cache.bytes, 0);
  assert.equal(cache.size, 0);
  assert.equal(cache.peek('a'), null);
  assert.equal(cache.put('a', a), true, 'clear leaves a reusable empty cache');
  assert.equal(cache.bytes, 16);
}

{
  const cache = createPhotoSessionCache({ maxBytes: 0 });
  assert.equal(cache.put('pixels', pixels(4)), false);
  assert.equal(cache.put('metadata', { exposure: 0 }), false);
  assert.equal(cache.bytes, 0);
  assert.equal(cache.size, 0);
  for (const maxBytes of [-1, NaN, Infinity, 1.5, '16']) {
    assert.throws(() => createPhotoSessionCache({ maxBytes }), RangeError);
  }
}

{
  const cache = createPhotoSessionCache({ maxBytes: 16 });
  const snapshot = { history: [], data: new Uint8Array(8) };
  cache.put('a', snapshot);
  assert.equal(cache.take('a'), snapshot);
  snapshot.history.push({ image: pixels(8) });
  cache.put('a', snapshot);
  assert.equal(cache.bytes, 16, 'take/edit/put recomputes the graph after ownership transfer');
  const detached = cache.take('a');
  const moved = structuredClone(detached, { transfer: [detached.data.buffer] });
  assert.equal(cache.bytes, 0);
  assert.equal(moved.data.byteLength, 8, 'caller can transfer a taken snapshot safely');
}

if (typeof SharedArrayBuffer !== 'undefined') {
  const buffer = new SharedArrayBuffer(16);
  const cache = createPhotoSessionCache({ maxBytes: 16 });
  cache.put('a', { buffer, view: new Uint8Array(buffer) });
  cache.put('b', { view: new Uint16Array(buffer) });
  assert.equal(cache.bytes, 16);
  cache.delete('a'); assert.equal(cache.bytes, 16);
  cache.clear(); assert.equal(cache.bytes, 0);
}

console.log('photoSessionCache: shared backing stores/history, LRU, ownership, replacement, limits and cleanup passed');

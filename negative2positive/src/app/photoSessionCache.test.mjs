import assert from 'node:assert/strict';
import { createPhotoSessionCache, backingBuffers } from './photoSessionCache.js';

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

// Several graphs counted once (#241 resident bytes): a plane shared by the
// open photo, its undo history and a cached session counts one time.
{
  const shared = pixels(64);
  const own = pixels(32);
  const cache = createPhotoSessionCache({ maxBytes: 1024 });
  cache.put('a', { base: shared, other: pixels(8) });
  const set = new Set();
  backingBuffers([{ planes: [shared, own] }, [{ refs: { originalImageData: shared } }]], set);
  for (const buffer of cache.buffers()) set.add(buffer);
  let total = 0;
  for (const buffer of set) total += buffer.byteLength;
  assert.equal(total, 64 + 32 + 8);
  assert.equal(backingBuffers(null).size, 0);
}

// putIfRoom (#243): a lane's finished base is kept only beside what is
// retained, never by evicting a visited photo's session.
{
  const cache = createPhotoSessionCache({ maxBytes: 100 });
  const visited = { base: new Uint8Array(60) };
  assert.equal(cache.put('visited', visited), true);
  assert.equal(cache.putIfRoom('lane', { base: new Uint8Array(50) }), false, 'would need an eviction');
  assert.equal(cache.peek('visited'), visited, 'the visited session stays');
  assert.equal(cache.bytes, 60);
  const small = { base: new Uint8Array(40) };
  assert.equal(cache.putIfRoom('lane', small), true, 'fits exactly');
  assert.equal(cache.bytes, 100);
  // A buffer already retained counts once.
  assert.equal(cache.putIfRoom('alias', { base: visited.base }), true);
  assert.equal(cache.bytes, 100);
  // Replacing an entry counts only what the replacement adds.
  assert.equal(cache.putIfRoom('lane', { base: new Uint8Array(40) }), true, 'the old 40 bytes are released first');
  assert.equal(cache.putIfRoom('lane', { base: new Uint8Array(41) }), false);
  assert.ok(cache.peek('lane'), 'a refused replacement keeps the previous entry');
  assert.equal(createPhotoSessionCache({ maxBytes: 0 }).putIfRoom('x', {}), false);
  // has() does not touch the LRU order: 'visited' stays the oldest entry.
  const order = createPhotoSessionCache({ maxBytes: 100 });
  order.put('old', { base: new Uint8Array(50) });
  order.put('new', { base: new Uint8Array(50) });
  assert.equal(order.has('old'), true);
  order.put('third', { base: new Uint8Array(50) });
  assert.equal(order.has('old'), false, 'has() left it least recently used');
  assert.equal(order.has('new'), true);
}

// #249: an entry a put pushed out is handed to onEvict after the put, oldest
// first. A demoted form filed as the oldest entry never displaces a photo
// visited after it; one that does not fit next to them is refused.
{
  const evicted = [];
  let cache;
  cache = createPhotoSessionCache({
    maxBytes: 100,
    onEvict: (key, value) => {
      evicted.push(key);
      if (value.small && !key.endsWith("'")) cache.putIfRoom(key + "'", { small: value.small }, { oldest: true });
    }
  });
  cache.put('a', { base: new Uint8Array(40), small: new Uint8Array(10) });
  cache.put('b', { base: new Uint8Array(40), small: new Uint8Array(5) });
  assert.deepEqual(evicted, [], 'nothing evicted yet');
  cache.put('c', { base: new Uint8Array(40) });
  assert.deepEqual(evicted, ['a'], 'the oldest entry went, after the put');
  assert.deepEqual(cache.keys(), ["a'", 'b', 'c'], 'its demoted form is the least recently used entry');
  assert.equal(cache.bytes, 95, 'b and c keep their bytes; the demoted entry holds only its small plane');
  cache.put('d', { base: new Uint8Array(40) });
  assert.deepEqual(evicted, ['a', "a'", 'b'], 'the demoted entry goes before b');
  assert.equal(cache.has('c'), true);
  assert.equal(cache.has("b'"), true, 'b demoted into the room left');
  assert.equal(cache.get('c') !== null, true, 'get does not touch the order');
  assert.deepEqual(cache.keys(), ["b'", 'c', 'd']);
  evicted.length = 0;
  cache.take('c'); cache.delete('d'); cache.retainKeys([]);
  assert.deepEqual(evicted, [], 'take, delete and retainKeys are not evictions');
  // A demoted form that does not fit is refused, not stored over newer entries.
  const strict = createPhotoSessionCache({ maxBytes: 50, onEvict: (key) => {
    assert.equal(strict.putIfRoom(key + "'", { plane: new Uint8Array(20) }, { oldest: true }), false);
  } });
  strict.put('x', { plane: new Uint8Array(30) });
  strict.put('y', { plane: new Uint8Array(40) });
  assert.deepEqual(strict.keys(), ['y']);
  // A throwing handler does not break the put.
  const quiet = console.warn; console.warn = () => {};
  const throwing = createPhotoSessionCache({ maxBytes: 10, onEvict: () => { throw new Error('boom'); } });
  throwing.put('p', { plane: new Uint8Array(10) });
  assert.equal(throwing.put('q', { plane: new Uint8Array(10) }), true);
  console.warn = quiet;
}

// #258 + #249: the entries a trim lets go reach onEvict too, after the trim,
// so a trimmed session is demoted to its small form instead of dropped; the
// kept key is never handed over, and the trim returns what it freed net of
// the demoted forms stored again.
{
  const evicted = [];
  let cache;
  cache = createPhotoSessionCache({
    maxBytes: 200,
    onEvict: (key, value) => {
      evicted.push(key);
      if (value.small) cache.putIfRoom(key + "'", { small: value.small }, { oldest: true });
    }
  });
  cache.put('a', { base: new Uint8Array(40), small: new Uint8Array(10) });
  cache.put('b', { base: new Uint8Array(40) });
  cache.put('c', { base: new Uint8Array(40), small: new Uint8Array(5) });
  assert.equal(cache.bytes, 135);
  const freed = cache.trim(0, { keep: [cache.lastStoredKey] });
  assert.deepEqual(evicted, ['a', 'b'], 'oldest first; the kept key is not handed over');
  assert.deepEqual(cache.keys(), ["a'", 'c'], 'a is demoted; b had no small form and is gone');
  assert.equal(cache.bytes, 55);
  assert.equal(freed, 80, 'freed net of the demoted form stored again');
  assert.equal(cache.lastStoredKey, 'c', 'a demoted form is not the entry stored last');
  evicted.length = 0;
  assert.equal(cache.trim(1000), 0, 'nothing to trim below the target');
  assert.deepEqual(evicted, []);
}

// #229 review R2-038: a background lane's hand-over (putIfRoom) never
// becomes the protected 1-back key, and lane entries are let go before any
// session the user left, by a trim and by a put that needs room.
{
  const cache = createPhotoSessionCache({ maxBytes: 10_000 });
  cache.put('A', { base: new Uint8Array(3000) });
  assert.equal(cache.putIfRoom('F', { base: new Uint8Array(3000) }, { background: true }), true);
  assert.equal(cache.lastStoredKey, 'A', 'the lane hand-over leaves the protected key at the photo just left');
  const protectedKey = cache.lastStoredKey;
  const freed = cache.trim(cache.bytes - 1000, { keep: [protectedKey] });
  assert.equal(freed, 3000);
  assert.deepEqual([cache.has('A'), cache.has('F')], [true, false], 'the trim lets the lane base go and keeps A');
  // Without the flag a putIfRoom does not move the key either.
  assert.equal(cache.putIfRoom('G', { base: new Uint8Array(100) }), true);
  assert.equal(cache.lastStoredKey, 'A');

  // Lane entries go first even when they are more recent than the user's,
  // and a peek (a lane job reading a retained base) keeps them lane entries.
  const order = createPhotoSessionCache({ maxBytes: 100 });
  const evicted = [];
  const watched = createPhotoSessionCache({ maxBytes: 100, onEvict: key => evicted.push(key) });
  for (const cache2 of [order, watched]) {
    cache2.put('U1', { base: new Uint8Array(30) });
    cache2.put('U2', { base: new Uint8Array(30) });
    assert.equal(cache2.putIfRoom('L1', { base: new Uint8Array(20) }, { background: true }), true);
    assert.equal(cache2.putIfRoom('L2', { base: new Uint8Array(20) }, { background: true }), true);
    cache2.peek('L1');
    assert.deepEqual(cache2.keys(), ['U1', 'U2', 'L2', 'L1']);
    assert.equal(cache2.lastStoredKey, 'U2');
  }
  // The user leaves U3: the put evicts the lane entries, oldest first, before U1.
  order.put('U3', { base: new Uint8Array(30) });
  assert.deepEqual(order.keys(), ['U1', 'U2', 'U3'], 'both lane bases went, no session the user left');
  assert.equal(order.lastStoredKey, 'U3');
  watched.put('U3', { base: new Uint8Array(50) });
  assert.deepEqual(evicted, ['L2', 'L1', 'U1'], 'lane entries first (least recently used first), then the oldest session');
  // A trim without a kept key: lane entries first, then the oldest sessions.
  const trimmed = createPhotoSessionCache({ maxBytes: 100 });
  trimmed.put('U1', { base: new Uint8Array(30) });
  trimmed.putIfRoom('L1', { base: new Uint8Array(30) }, { background: true });
  trimmed.put('U2', { base: new Uint8Array(30) });
  assert.equal(trimmed.trim(60), 30);
  assert.deepEqual(trimmed.keys(), ['U1', 'U2'], 'the lane entry goes before the older U1');
  // A user put over a lane entry's key makes it the user's.
  trimmed.putIfRoom('L2', { base: new Uint8Array(10) }, { background: true });
  trimmed.put('L2', { base: new Uint8Array(10) });
  assert.equal(trimmed.lastStoredKey, 'L2');
  assert.equal(trimmed.trim(40), 30);
  assert.deepEqual(trimmed.keys(), ['U2', 'L2'], 'no longer a lane entry: U1 is the oldest and goes first');
}

console.log('photoSessionCache: shared backing stores/history, LRU, ownership, replacement, limits and cleanup passed');

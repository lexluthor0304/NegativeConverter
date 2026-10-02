// The display-proxy spill and persistent store (#249) with in-memory
// records: exact round trips, budgets (the spill's free-space floor, the
// store's min(setting, 25 % of the free space above 10 GiB)), LRU eviction,
// corrupted and truncated records, the index across restarts, Clear cache,
// and the desktop records' chunked IPC.
import assert from 'node:assert/strict';

globalThis.ImageData = class ImageData {
  constructor(dataOrWidth, width, height) {
    if (typeof dataOrWidth === 'number') { this.width = dataOrWidth; this.height = width; this.data = new Uint8ClampedArray(dataOrWidth * width * 4); }
    else { this.data = dataOrWidth; this.width = width; this.height = height; }
  }
};
const {
  createDisplayProxySpill, createDisplayProxyPort, createDisplayProxyWorkerCore, createDisplayProxyStore,
  displayProxyStoreBudget, displayProxyFileKey, namedRecords, sha256Hex, DISPLAY_PROXY_STORE_FLOOR_BYTES
} = await import('./displayProxyStore.js');
const { createDesktopProxyRecords, DISPLAY_PROXY_CHUNK_BYTES } = await import('./displayProxyDesktop.js');
const { resizeDisplayPreview } = await import('./displayPreview.js');

const GiB = 1024 ** 3;
function proxyImage(width = 40, height = 24, seed = 3) {
  let s = seed;
  const source = new ImageData(width * 3, height * 3);
  const plane = new Uint16Array(source.data.length);
  for (let i = 0; i < plane.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    plane[i] = (i & 3) === 3 ? 65535 : s % 65536;
    source.data[i] = plane[i] >>> 8;
  }
  source.__image16 = { width: source.width, height: source.height, data: plane };
  return resizeDisplayPreview(source, { width, height });
}
const same = (a, b, label) => {
  assert.equal(a.width, b.width, label);
  assert.ok(Buffer.from(a.data.buffer, a.data.byteOffset, a.data.byteLength).equals(Buffer.from(b.data.buffer, b.data.byteOffset, b.data.byteLength)), `${label}: 8-bit`);
  assert.ok(Buffer.from(a.__image16.data.buffer).equals(Buffer.from(b.__image16.data.buffer)), `${label}: 16-bit`);
};
function memoryRecords() {
  const data = new Map();
  let time = 0;
  return {
    data,
    async write(name, record) { data.set(name, { bytes: new Uint8Array(record instanceof ArrayBuffer ? record : record.buffer).slice(), modifiedMs: ++time }); },
    async read(name) { const entry = data.get(name); return entry ? entry.bytes.slice().buffer : null; },
    async delete(name) { data.delete(name); },
    async clear() { data.clear(); },
    async list() { return [...data].map(([name, entry]) => ({ name, bytes: entry.bytes.byteLength, modifiedMs: entry.modifiedMs })); }
  };
}
const localPort = () => createDisplayProxyPort({ core: createDisplayProxyWorkerCore({ backend: null }) });

// ---- The store's budget follows the disk ----
assert.equal(displayProxyStoreBudget(11 * GiB, 2 * GiB), Math.floor(0.25 * GiB), '11 GiB free gives a quarter GiB');
assert.equal(displayProxyStoreBudget(2.7 * GiB, 2 * GiB), 0, 'below the 10 GiB floor it is off');
assert.equal(displayProxyStoreBudget(100 * GiB, 2 * GiB), 2 * GiB, 'the setting caps it');
assert.equal(displayProxyStoreBudget(100 * GiB, 0), 0, 'a zero setting turns it off');
assert.equal(displayProxyStoreBudget(null, 2 * GiB), 2 * GiB, 'without a free-space reading the setting applies');
assert.equal(DISPLAY_PROXY_STORE_FLOOR_BYTES, 10 * GiB);

// ---- The store: exact round trip, index across a restart, LRU, Clear cache ----
{
  const records = memoryRecords();
  let free = 20 * GiB;
  let clock = 0;
  const make = () => createDisplayProxyStore({
    port: localPort(), records, availableBytes: async () => free, limitBytes: () => 2 * GiB, now: () => ++clock
  });
  const store = make();
  const image = proxyImage();
  const sample = { width: 3, height: 2, data: Uint16Array.from({ length: 24 }, (_, i) => i * 999) };
  const file = { size: 1234, lastModified: 99 };
  assert.equal(await store.put('file-a', 'proxy-1', { file, image, sample, meta: { base: { width: 120, height: 72 } } }), true);
  await store.settled();
  assert.equal(store.size, 1);
  assert.ok(records.data.has('index'), 'the index is kept with the records');
  // A new run reads the index back.
  const restarted = make();
  await restarted.load();
  assert.equal(restarted.hasCandidate(file), true, 'a file of the same size and date is a candidate without hashing');
  assert.equal(restarted.hasCandidate({ size: 1234, lastModified: 98 }), false);
  const [found] = await restarted.find('file-a');
  assert.equal(found.proxyKey, 'proxy-1');
  const read = await restarted.read(found.name);
  same(read.image, image, 'stored proxy');
  assert.deepEqual(read.sample, sample);
  assert.deepEqual(read.meta, { base: { width: 120, height: 72 } });
  // A corrupted record fails its checksum, is purged and reads as a miss.
  const stored = records.data.get(found.name).bytes;
  stored[stored.length >> 1] ^= 0x10;
  assert.equal(await restarted.read(found.name), null);
  assert.equal(restarted.stats.corrupt, 1);
  assert.equal(records.data.has(found.name), false, 'purged');
  // Truncated.
  await restarted.put('file-b', 'proxy-2', { file, image });
  const [b] = await restarted.find('file-b');
  records.data.get(b.name).bytes = records.data.get(b.name).bytes.slice(0, 100);
  assert.equal(await restarted.read(b.name), null, 'a truncated record reads as a miss');
  // LRU within the budget: 25 % of (free - 10 GiB).
  const bytesEach = (await (async () => { await restarted.put('file-c', 'p', { file, image }); return restarted.bytes; })());
  free = 10 * GiB + Math.floor(bytesEach * 4 * 2.5); // room for about two records
  const tight = make();
  await tight.put('file-d', 'p', { file, image });
  await tight.put('file-e', 'p', { file, image });
  await tight.put('file-f', 'p', { file, image });
  assert.ok(tight.bytes <= displayProxyStoreBudget(free, 2 * GiB), 'the store stays within its budget');
  assert.equal((await tight.find('file-c')).length + (await tight.find('file-d')).length, 0, 'the least recently used went first');
  assert.equal((await tight.find('file-f')).length, 1);
  // Below the floor nothing is written.
  free = 3 * GiB;
  const off = make();
  assert.equal(await off.put('file-g', 'p', { file, image }), false);
  assert.equal(off.stats.refused, 1);
  // Clear cache empties it.
  await off.clear();
  assert.equal(records.data.size, 0);
  assert.equal(off.size, 0);
  // Orphans of a lost index are removed.
  const orphans = memoryRecords();
  orphans.data.set('f'.repeat(64), { bytes: new Uint8Array(10), modifiedMs: 1 });
  const cleaned = createDisplayProxyStore({ port: localPort(), records: orphans, availableBytes: async () => 20 * GiB });
  await cleaned.load();
  assert.equal(orphans.data.size, 0, 'a record without an index entry is deleted');
  // The file key reads the head (the project hash) and the last 64 KiB.
  const blob = new Blob([new Uint8Array(200_000).map((_, i) => i & 255)]);
  blob.lastModified = 5;
  const hashed = [];
  const key = await displayProxyFileKey(blob, { hashHead: async file => { hashed.push(file.size); return 'head'; }, decoderHash: 'wasm', codeHash: 'code' });
  const parsed = JSON.parse(key);
  assert.deepEqual(parsed.slice(0, 5), ['ncdp-file', 1, 200_000, 5, 'head']);
  assert.equal(parsed[5], await sha256Hex(new Uint8Array(await blob.slice(200_000 - 65536).arrayBuffer())));
  assert.deepEqual(parsed.slice(6), ['wasm', 'code']);
  const changedCode = await displayProxyFileKey(blob, { hashHead: async () => 'head', decoderHash: 'wasm', codeHash: 'other' });
  assert.notEqual(changedCode, key, 'another code hash is another key');
}

// ---- has(): a fill finds a stored proxy before rendering it again (#249,
// R2-003), without reading the record, and marks it used as the put it
// replaces did ----
{
  const records = memoryRecords();
  let clock = 0;
  const store = createDisplayProxyStore({ port: localPort(), records, availableBytes: async () => 20 * GiB, now: () => ++clock });
  const image = proxyImage();
  const file = { size: 10, lastModified: 1 };
  assert.equal(await store.put('file-a', 'proxy-1', { file, image }), true);
  assert.equal(await store.put('file-b', 'proxy-1', { file, image }), true);
  assert.equal(await store.putBytes('file-a', 'proxy-2', new Uint8Array(10), { file }), true);
  const restarted = createDisplayProxyStore({ port: localPort(), records, availableBytes: async () => 20 * GiB, now: () => ++clock });
  assert.equal(await restarted.has('file-a', 'proxy-1'), true, 'the index of an earlier run answers');
  assert.equal(await restarted.has('file-a', 'proxy-3'), false, 'another proxy key');
  assert.equal(await restarted.has('file-c', 'proxy-1'), false, 'another file');
  assert.equal(await restarted.has('file-a', 'proxy-2'), false, 'a presentation preview is no proxy');
  assert.equal(restarted.stats.reads + restarted.stats.writes, 0, 'nothing is read or written');
  const [a] = await restarted.find('file-a');
  const [b] = await restarted.find('file-b');
  assert.ok(a.lastUsed > b.lastUsed, 'the proxy found is the more recently used');
  await restarted.settled();
  const reloaded = createDisplayProxyStore({ port: localPort(), records, availableBytes: async () => 20 * GiB });
  assert.equal((await reloaded.find('file-a'))[0].lastUsed, a.lastUsed, 'and the index keeps it');
}

// ---- Presentation previews (#235 slice 3): opaque bytes with a checksum ----
{
  const records = memoryRecords();
  const store = createDisplayProxyStore({ port: localPort(), records, availableBytes: async () => 20 * GiB });
  const jpeg = Uint8Array.from({ length: 5000 }, (_, i) => (i * 13) & 255);
  const file = { size: 77, lastModified: 3 };
  assert.equal(await store.putBytes('file-p', 'recipe-1', jpeg, { file }), true);
  assert.equal(store.hasCandidate(file, { kind: 'presentation' }), true);
  assert.equal(store.hasCandidate(file), false, 'not a proxy candidate');
  assert.deepEqual([...(await store.readBytes('file-p', 'recipe-1'))], [...jpeg]);
  assert.equal(await store.readBytes('file-p', 'recipe-2'), null, 'another recipe misses');
  assert.deepEqual(await store.find('file-p'), [], 'presentations are not proxies');
  const [name] = [...records.data.keys()].filter(key => key !== 'index');
  records.data.get(name).bytes[20] ^= 1;
  assert.equal(await store.readBytes('file-p', 'recipe-1'), null, 'a corrupted preview is purged');
  assert.equal(records.data.has(name), false);
}

// ---- The spill: a floor, a budget and failures read as misses ----
{
  const records = new Map();
  const backend = {
    async put(key, value) { records.set(key, value); }, async get(key) { return records.get(key) || null; },
    async delete(key) { records.delete(key); }, async clear() { records.clear(); }
  };
  let free = 50 * GiB;
  const spill = createDisplayProxySpill({ port: createDisplayProxyPort({ core: createDisplayProxyWorkerCore({ backend }) }), availableBytes: async () => free });
  const image = proxyImage();
  assert.equal(await spill.put('a', { image, proxyKey: 'k' }), true);
  same((await spill.get('a', { proxyKey: 'k' })).image, image, 'spilled');
  assert.equal(await spill.get('a', { proxyKey: 'other' }), null, 'another key misses');
  free = 1 * GiB;
  assert.equal(await spill.put('b', { image, proxyKey: 'k' }), false, 'below the floor the spill writes nothing');
  assert.equal(spill.stats.refusedForSpace, 1);
  // A worker without a database turns the spill off.
  const off = createDisplayProxySpill({ port: localPort() });
  assert.equal(await off.put('x', { image, proxyKey: 'k' }), false);
  assert.equal(off.enabled, false);
  // Desktop: records through the Rust store, named by hash.
  const disk = memoryRecords();
  const desktop = createDisplayProxySpill({ port: localPort(), recordStore: namedRecords(disk) });
  assert.equal(await desktop.put('item::1', { image, proxyKey: 'k' }), true);
  assert.ok([...disk.data.keys()][0].match(/^[0-9a-f]{64}$/), 'a hashed record name');
  same((await desktop.get('item::1', { proxyKey: 'k' })).image, image, 'desktop spill');
  await desktop.clear();
  assert.equal(disk.data.size, 0);
}

// ---- Desktop records move in chunks of the IPC limit ----
{
  const files = new Map();
  const calls = [];
  const invoke = async (command, args, options) => {
    calls.push(command);
    if (command === 'display_proxy_write') {
      const { 'x-proxy-name': name, 'x-proxy-offset': offset, 'x-proxy-last': last, 'x-proxy-scope': scope } = options.headers;
      assert.equal(scope, 'store');
      assert.ok(args.byteLength <= DISPLAY_PROXY_CHUNK_BYTES);
      const previous = Number(offset) === 0 ? new Uint8Array(0) : files.get(`${name}.part`);
      assert.equal(previous.byteLength, Number(offset), 'chunks arrive in order');
      const next = new Uint8Array(previous.byteLength + args.byteLength);
      next.set(previous); next.set(args, previous.byteLength);
      files.set(`${name}.part`, next);
      if (last === '1') { files.set(name, next); files.delete(`${name}.part`); }
      return next.byteLength;
    }
    if (command === 'display_proxy_read') {
      const data = files.get(args.name);
      if (!data) return new ArrayBuffer(0);
      return data.slice(args.offset, args.offset + args.length).buffer;
    }
    if (command === 'display_proxy_space') return { freeBytes: 42, totalBytes: 100 };
    return null;
  };
  const records = createDesktopProxyRecords(invoke, 'store');
  const big = new Uint8Array(DISPLAY_PROXY_CHUNK_BYTES * 2 + 1234).map((_, i) => (i * 31) & 255);
  assert.equal(await records.write('a'.repeat(64), big.buffer), big.byteLength);
  assert.equal(calls.filter(c => c === 'display_proxy_write').length, 3, 'three chunks');
  const back = new Uint8Array(await records.read('a'.repeat(64)));
  assert.ok(Buffer.from(back).equals(Buffer.from(big)), 'read back in chunks');
  assert.equal(await records.read('b'.repeat(64)), null, 'absent');
  assert.deepEqual(await records.space(), { freeBytes: 42, totalBytes: 100 });
  const empty = new Uint8Array(0);
  await records.write('c'.repeat(64), empty.buffer);
  assert.equal(files.get('c'.repeat(64)).byteLength, 0, 'an empty record still renames into place');
}

console.log('displayProxyStore: spill, persistent store, budgets, LRU, checksum purge, index restart, Clear cache and desktop chunks passed');

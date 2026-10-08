// The display-proxy spill and persistent store (#249) with in-memory
// records: exact round trips, budgets (the spill's free-space floor, the
// store's min(setting, 25 % of the free space above 10 GiB) on a volume and
// half of the quota left on the web), LRU eviction, corrupted and truncated
// records, the index across restarts, Clear cache, and the desktop records'
// chunked IPC. The origin-private file system's records run on a fake
// directory whose sync access handles behave as WebKit's before Safari 17 or
// as the standard ones (R2-067), and two tabs share one store (R2-010).
import assert from 'node:assert/strict';

globalThis.ImageData = class ImageData {
  constructor(dataOrWidth, width, height) {
    if (typeof dataOrWidth === 'number') { this.width = dataOrWidth; this.height = width; this.data = new Uint8ClampedArray(dataOrWidth * width * 4); }
    else { this.data = dataOrWidth; this.width = width; this.height = height; }
  }
};
const {
  createDisplayProxySpill, createDisplayProxyPort, createDisplayProxyWorkerCore, createDisplayProxyStore: createStore,
  displayProxyStoreBudget, displayProxyFileKey, namedRecords, sha256Hex, createOpfsRecords, createPortRecords,
  DISPLAY_PROXY_STORE_FLOOR_BYTES, DISPLAY_PROXY_STORE_QUOTA_FLOOR_BYTES, DISPLAY_PROXY_STORE_LOCK,
  DISPLAY_PROXY_LOCK_WAIT_MS
} = await import('./displayProxyStore.js');
const { createDesktopProxyRecords, DISPLAY_PROXY_CHUNK_BYTES } = await import('./displayProxyDesktop.js');
const { resizeDisplayPreview } = await import('./displayPreview.js');

// Node has no Web Locks; provide the same serialization contract as the browser.
const defaultStoreLocks = locksStub();
const createDisplayProxyStore = options => createStore({ locks: defaultStoreLocks, ...options });

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

// ---- On the web the figure is the origin's quota left, which the volume's
// 10 GiB floor does not apply to (R2-068): Firefox caps an origin at 10 GiB
// and Chrome reports its usage plus 10 GiB, so the store never wrote there ----
for (const free of [11 * GiB, 2.7 * GiB, 100 * GiB, null]) {
  assert.equal(displayProxyStoreBudget({ bytes: free, kind: 'volume' }, 2 * GiB), displayProxyStoreBudget(free, 2 * GiB),
    `a volume figure of ${free} is read as before`);
}
assert.equal(displayProxyStoreBudget({ bytes: 10 * GiB, kind: 'volume' }, 2 * GiB), 0, 'a volume of 10 GiB free stays off');
assert.ok(displayProxyStoreBudget({ bytes: 10 * GiB, kind: 'quota' }, 2 * GiB) > 0, 'a Firefox-like 10 GiB quota stores');
assert.equal(displayProxyStoreBudget({ bytes: 10 * GiB, kind: 'quota' }, 2 * GiB), 2 * GiB, 'the setting caps it');
assert.equal(displayProxyStoreBudget({ bytes: 3 * GiB, kind: 'quota' }, 2 * GiB), 1.5 * GiB, 'at most half of the quota left');
assert.equal(displayProxyStoreBudget({ bytes: 10 * GiB, kind: 'quota' }, 0), 0, 'Off stays off');
assert.equal(displayProxyStoreBudget({ bytes: null, kind: 'quota' }, 2 * GiB), 2 * GiB, 'without an estimate the setting applies');
assert.equal(DISPLAY_PROXY_STORE_QUOTA_FLOOR_BYTES, 512 * 1024 ** 2);
assert.equal(displayProxyStoreBudget({ bytes: DISPLAY_PROXY_STORE_QUOTA_FLOOR_BYTES - 1, kind: 'quota' }, 2 * GiB), 0, 'off below the quota floor');
assert.equal(displayProxyStoreBudget({ bytes: DISPLAY_PROXY_STORE_QUOTA_FLOOR_BYTES, kind: 'quota' }, 2 * GiB), DISPLAY_PROXY_STORE_QUOTA_FLOOR_BYTES / 2);
// The usage includes the store's own records: they count as left to it, so
// the budget does not shrink as the store fills (nor evict to a smaller one).
for (const stored of [0, 0.5 * GiB, 1 * GiB, 1.4 * GiB]) {
  assert.equal(displayProxyStoreBudget({ bytes: 3 * GiB - stored, kind: 'quota' }, 2 * GiB, undefined, stored), 1.5 * GiB,
    `the same budget with ${stored} bytes stored`);
  assert.equal(displayProxyStoreBudget(20 * GiB - stored, 2 * GiB, undefined, stored), displayProxyStoreBudget(20 * GiB - stored, 2 * GiB),
    'a volume figure ignores them, as before');
}

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

// ---- A lens-corrected display level (#278) is stored under a key whose
// lens part names the correction, with that lens in its metadata: an index
// read after a restart finds it by that key alone (not by the key without
// the lens, nor by another lens's), and the record gives back the level
// byte for byte, 16-bit only, with its lens ----
{
  const { buildDisplayLevel } = await import('./displayPreview.js');
  const { displayProxyKey } = await import('./displayProxy.js');
  const records = memoryRecords();
  const make = () => createDisplayProxyStore({ port: localPort(), records, availableBytes: async () => 20 * GiB });
  const lens = focal => JSON.stringify([{ handle: 2741040, maker: 'Test', model: 'Test 18-55mm' }, { focal, crop: 1.5, aperture: 5.6, distance: 1000, stepMode: 'auto', step: 2 },
    { includeTca: true, includeVignetting: true }]);
  const keyOf = lensPart => displayProxyKey({ route: 'libraw16', base: { width: 120, height: 80, has16: true }, rotationAngle: 1.3,
    cropRegion: { left: 9, top: 7, width: 96, height: 60 }, lens: lensPart, area: '[]' });
  const source = proxyImage(96, 60, 17);
  const level = buildDisplayLevel(source, 2);
  const file = { size: 4321, lastModified: 7 };
  const meta = { base: { width: 120, height: 80, has16: true, route: 'libraw16' }, levelLens: lens(18) };
  const writer = make();
  assert.equal(await writer.put('file-a', keyOf(lens(18)), { file, image: level, meta }), true);
  await writer.settled();
  const restarted = make();
  await restarted.load();
  const entries = await restarted.find('file-a');
  assert.deepEqual(entries.map(entry => entry.proxyKey), [keyOf(lens(18))], 'found by the key with its lens');
  for (const other of [keyOf(null), keyOf(lens(24))]) {
    assert.equal(entries.some(entry => entry.proxyKey === other), false, 'not by the key without it or with another lens');
    assert.equal(await restarted.has('file-a', other), false);
  }
  assert.equal(await restarted.has('file-a', keyOf(lens(18))), true);
  const read = await restarted.read(entries[0].name);
  assert.equal(read.image.data, undefined, 'a 16-bit level');
  assert.ok(Buffer.from(read.image.__image16.data.buffer).equals(Buffer.from(level.__image16.data.buffer)), 'byte for byte');
  assert.equal(read.meta.levelLens, lens(18), 'with the lens it carries');
  assert.equal(read.proxyKey, keyOf(lens(18)));
}

// ---- A store on a Firefox-like quota (R2-068): 10 GiB for the origin, its
// usage the records it holds. Every put is stored and the budget stays the
// setting as it fills ----
{
  const records = memoryRecords();
  const usage = () => [...records.data.values()].reduce((sum, entry) => sum + entry.bytes.byteLength, 0);
  const store = createDisplayProxyStore({
    port: localPort(), records, availableBytes: async () => ({ bytes: 10 * GiB - usage(), kind: 'quota' }), limitBytes: () => 2 * GiB
  });
  const image = proxyImage();
  for (let i = 0; i < 4; i++) assert.equal(await store.put(`file-${i}`, 'p', { file: { size: i, lastModified: 1 }, image }), true, `put ${i} stored`);
  assert.equal(store.stats.refused, 0);
  assert.equal(store.size, 4);
  assert.equal(await store.budget(), 2 * GiB, 'the budget on a 10 GiB quota is the setting');
  // The same figure read as a volume's free space (the old reading) stores nothing.
  const asVolume = createDisplayProxyStore({ port: localPort(), records: memoryRecords(), availableBytes: async () => 10 * GiB - usage() });
  assert.equal(await asVolume.put('file-v', 'p', { file: { size: 1, lastModified: 1 }, image }), false);
  assert.equal(asVolume.stats.refused, 1);
  // Above the setting, the budget is half of the quota however full the
  // store is: its own records count as left to it.
  const own = memoryRecords();
  const ownUsage = () => [...own.data.values()].reduce((sum, entry) => sum + entry.bytes.byteLength, 0);
  let clock = 0;
  const unbounded = createDisplayProxyStore({
    port: localPort(), records: own, availableBytes: async () => ({ bytes: 10 * GiB - ownUsage(), kind: 'quota' }),
    limitBytes: () => 10 * GiB, now: () => (clock += 20_000)
  });
  for (let i = 0; i < 3; i++) await unbounded.put(`file-${i}`, 'p', { file: { size: i, lastModified: 1 }, image });
  // (The index is the one byte count of the store's usage it does not hold.)
  const indexBytes = own.data.get('index').bytes.byteLength;
  assert.ok(ownUsage() > 10 * indexBytes);
  assert.equal(await unbounded.budget(), Math.floor(0.5 * (10 * GiB - indexBytes)), 'half of the quota with the store filled');
}

// ---- A fake origin-private file system ----
// A fake OPFS tree. With `webkit16`, its sync access handles behave as
// WebKit's before Safari 17 (15.2-16.x): getSize(), truncate(), flush() and
// close() return promises and take effect a task later, read() and write()
// are synchronous. A file has one sync access handle at a time, and
// `onAccess(fileName)` hears each one opened; `beforeOpen(fileName)`, when
// set, is awaited first. `sizeOf` stands for an engine whose getSize() is no
// byte count, `readCap` for one whose read() stops short, `openError` for a
// getFileHandle() that fails for another reason than a missing file.
function fakeOpfs({ webkit16 = false, onAccess = () => {} } = {}) {
  let clock = 0;
  let root = null;
  const later = effect => (webkit16 ? new Promise(resolve => setTimeout(() => resolve(effect()), 0)) : effect());
  const error = (name, message) => Object.assign(new Error(message), { name });
  function file(name) {
    const node = { kind: 'file', name, bytes: new Uint8Array(0), modified: ++clock, open: false };
    node.getFile = async () => ({ size: node.bytes.byteLength, lastModified: node.modified });
    node.createSyncAccessHandle = async () => {
      await root.beforeOpen?.(name);
      if (node.open) throw error('NoModificationAllowedError', `${name} has an open access handle`);
      node.open = true;
      onAccess(name);
      let closed = false;
      const live = () => { if (closed) throw error('InvalidStateError', 'closed'); };
      return {
        getSize: () => { live(); return later(() => root.sizeOf(node)); },
        truncate: size => { live(); return later(() => { node.bytes = node.bytes.slice(0, size); node.modified = ++clock; }); },
        read: (buffer, { at = 0 } = {}) => {
          live();
          const part = node.bytes.subarray(at, at + Math.min(buffer.byteLength, root.readCap ?? Infinity));
          buffer.set(part);
          return part.byteLength;
        },
        write: (buffer, { at = 0 } = {}) => {
          live();
          const data = ArrayBuffer.isView(buffer) ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) : new Uint8Array(buffer);
          if (at + data.byteLength > node.bytes.byteLength) {
            const grown = new Uint8Array(at + data.byteLength);
            grown.set(node.bytes);
            node.bytes = grown;
          }
          node.bytes.set(data, at);
          node.modified = ++clock;
          return data.byteLength;
        },
        flush: () => { live(); return later(() => {}); },
        close: () => { closed = true; return later(() => { node.open = false; }); }
      };
    };
    return node;
  }
  function directory() {
    const children = new Map();
    return {
      kind: 'directory', children,
      async getDirectoryHandle(name, { create = false } = {}) {
        if (!children.has(name)) {
          if (!create) throw error('NotFoundError', name);
          children.set(name, directory());
        }
        return children.get(name);
      },
      async getFileHandle(name, { create = false } = {}) {
        if (root.openError) throw error(root.openError, name);
        if (!children.has(name)) {
          if (!create) throw error('NotFoundError', name);
          children.set(name, file(name));
        }
        return children.get(name);
      },
      async removeEntry(name) {
        if (children.get(name)?.open) throw error('NoModificationAllowedError', `${name} is open`);
        if (!children.delete(name)) throw error('NotFoundError', name);
      },
      async *entries() { for (const entry of [...children]) yield entry; }
    };
  }
  root = Object.assign(directory(), { sizeOf: node => node.bytes.byteLength });
  return root;
}
// A tab: its worker's records in `root`, as main.js wires the web store.
function opfsTab(root, options = {}) {
  const port = createDisplayProxyPort({ core: createDisplayProxyWorkerCore({ backend: null, records: () => createOpfsRecords(async () => root) }) });
  return createDisplayProxyStore({ port, records: createPortRecords(port), encodeInWorker: true, availableBytes: async () => 20 * GiB, ...options });
}
const recordFiles = async root => {
  const folder = await root.getDirectoryHandle('display-proxies');
  return new Map([...folder.children].map(([name, node]) => [name, node]));
};
// ---- The worker's records in the origin-private file system (R2-067):
// WebKit before Safari 17 returns promises from four of the sync access
// handle's methods; awaited, a record and the index round-trip across a
// reload there as with the standard handles, and an index that cannot be
// read is never taken for a lost one ----
{
  const image = proxyImage();
  const sample = { width: 3, height: 2, data: Uint16Array.from({ length: 24 }, (_, i) => i * 777) };
  const file = { size: 4321, lastModified: 17 };
  const jpeg = Uint8Array.from({ length: 3000 }, (_, i) => (i * 29) & 255);
  for (const webkit16 of [true, false]) {
    const label = webkit16 ? 'WebKit before Safari 17' : 'standard sync access handles';
    const root = fakeOpfs({ webkit16 });
    const store = opfsTab(root);
    assert.equal(await store.put('file-a', 'proxy-1', { file, image, sample, meta: { base: { width: 120, height: 72 } } }), true, `${label}: stored`);
    assert.equal(await store.putBytes('file-a', 'recipe-1', jpeg, { file }), true, `${label}: preview stored`);
    await store.settled();
    const written = await recordFiles(root);
    assert.equal(written.size, 3, `${label}: two records and the index`);
    for (const [name, node] of written) {
      assert.ok(node.bytes.byteLength > 0, `${label}: ${name} written in full`);
      assert.equal(node.open, false, `${label}: ${name} closed`);
    }
    // A reload: another worker and store over the same directory.
    const reloaded = opfsTab(root);
    await reloaded.load();
    assert.deepEqual([...(await recordFiles(root)).keys()].sort(), [...written.keys()].sort(), `${label}: no record deleted as an orphan`);
    assert.equal(reloaded.hasCandidate(file), true, `${label}: the index came back`);
    const [entry] = await reloaded.find('file-a');
    const back = await reloaded.read(entry.name);
    same(back.image, image, `${label}: the proxy round-trips`);
    assert.deepEqual(back.sample, sample, `${label}: with its sample`);
    assert.deepEqual(back.meta, { base: { width: 120, height: 72 } });
    assert.deepEqual([...(await reloaded.readBytes('file-a', 'recipe-1'))], [...jpeg], `${label}: the preview round-trips`);
    assert.equal(reloaded.stats.corrupt + reloaded.stats.misses + reloaded.stats.failures, 0, `${label}: no miss, purge or failure`);
    // A put of another proxy rewrites the index right after its record.
    assert.equal(await reloaded.put('file-b', 'proxy-1', { file: { size: 9, lastModified: 9 }, image }), true, `${label}: a second put`);
    await reloaded.settled();
    const again = opfsTab(root);
    assert.equal((await again.find('file-b')).length, 1, `${label}: the rewritten index lists it`);
    same((await again.read((await again.find('file-a'))[0].name)).image, image, `${label}: the first proxy is still there`);
  }
  // An engine whose getSize() is no byte count: the index cannot be read, so
  // nothing is deleted and nothing written over it (it read as lost, and
  // every record as an orphan, before).
  const root = fakeOpfs();
  const store = opfsTab(root);
  assert.equal(await store.put('file-a', 'proxy-1', { file, image }), true);
  await store.settled();
  const kept = [...(await recordFiles(root)).keys()].sort();
  root.sizeOf = () => ({});
  const unreadable = opfsTab(root);
  await unreadable.load();
  assert.deepEqual([...(await recordFiles(root)).keys()].sort(), kept, 'an unreadable index deletes nothing');
  assert.equal(await unreadable.put('file-c', 'proxy-1', { file, image }), false, 'nor is anything written over it');
  assert.ok(unreadable.stats.failures >= 2, 'the failures are counted');
  root.sizeOf = node => node.bytes.byteLength;
  // Nor when a read stops short, or the file cannot be opened for another
  // reason than its absence.
  root.readCap = 10;
  await opfsTab(root).load();
  assert.deepEqual([...(await recordFiles(root)).keys()].sort(), kept, 'an index read short deletes nothing');
  root.readCap = null;
  root.openError = 'SecurityError';
  await opfsTab(root).load();
  assert.deepEqual([...(await recordFiles(root)).keys()].sort(), kept, 'an index that cannot be opened deletes nothing');
  root.openError = null;
  const readable = opfsTab(root);
  assert.equal((await readable.find('file-a')).length, 1, 'readable again, the records are all there');
}

// ---- Two tabs share one store (R2-010): each keeps a copy of the index;
// every change of it runs under the store's Web Lock on the index the
// records hold, so neither writes over the other's entries nor deletes its
// records as orphans, and the budget and LRU count both tabs' records ----
function locksStub() {
  let tail = Promise.resolve();
  const stub = {
    held: 0, grants: 0,
    request(name, options, callback) {
      assert.equal(name, DISPLAY_PROXY_STORE_LOCK);
      assert.equal(options.mode, 'exclusive');
      const run = tail.then(async () => {
        stub.held++;
        stub.grants++;
        try { return await callback({ name, mode: options.mode }); } finally { stub.held--; }
      });
      tail = run.catch(() => {});
      return run;
    }
  };
  return stub;
}
const fileOf = i => ({ size: 100 + i, lastModified: i });
async function sharedByTwoTabs({ webkit16 = false } = {}) {
  const image = proxyImage();
  const jpeg = Uint8Array.from({ length: 2000 }, (_, i) => (i * 7) & 255);
  const label = webkit16 ? 'WebKit before Safari 17' : 'standard';
  const locks = locksStub();
  let outside = 0;
  const root = fakeOpfs({ webkit16, onAccess: name => { if (name === 'index.ncdp' && locks.held !== 1) outside++; } });
  let clock = 0;
  const tab = () => opfsTab(root, { locks, now: () => ++clock });
  const a = tab(), b = tab();
  // Both tabs start and write at once.
  const results = await Promise.all([
    a.load(), b.load(),
    a.put('file-1', 'p', { file: fileOf(1), image }), b.put('file-2', 'p', { file: fileOf(2), image }),
    b.putBytes('file-2', 'recipe', jpeg, { file: fileOf(2) }), a.put('file-3', 'p', { file: fileOf(3), image })
  ]);
  assert.deepEqual(results.slice(2), [true, true, true, true], `${label}: every write stored`);
  // A third tab (a reload) starts while the two write, ask and forget again.
  const c = tab();
  const more = await Promise.all([
    c.load(), a.put('file-4', 'p', { file: fileOf(4), image }), b.has('file-1', 'p'),
    b.put('file-5', 'p', { file: fileOf(5), image }), a.forget('file-3')
  ]);
  assert.equal(more[3], true, `${label}: stored again`);
  await Promise.all([a.settled(), b.settled(), c.settled()]);
  assert.equal(outside, 0, `${label}: the index is only read and written under the lock`);
  // A later tab finds every tab's records, and every record is listed.
  const d = tab();
  for (const i of [1, 2, 4, 5]) {
    const [entry] = await d.find(`file-${i}`);
    assert.ok(entry, `${label}: file-${i} is listed`);
    same((await d.read(entry.name)).image, image, `${label}: file-${i} reads back`);
  }
  assert.deepEqual([...(await d.readBytes('file-2', 'recipe'))], [...jpeg], `${label}: the other tab's preview reads back`);
  assert.deepEqual(await d.find('file-3'), [], `${label}: a forgotten file is gone in every tab`);
  const onDisk = [...(await recordFiles(root)).keys()].filter(name => name !== 'index.ncdp');
  assert.equal(onDisk.length, 5, `${label}: four proxies and a preview on disk, nothing orphaned`);
  // A tab's copy follows the records' index at its next change.
  assert.equal(await b.has('file-4', 'p'), true, `${label}: a tab finds a record the other tab stored`);
  // A tab that starts while another is between writing a record and listing
  // it in the index waits for the entry: it never takes the record for an
  // orphan.
  let release, gated, recordOpened = false;
  const gate = new Promise(resolve => { release = resolve; });
  const between = new Promise(resolve => { gated = resolve; });
  root.beforeOpen = async name => {
    if (name !== 'index.ncdp') { recordOpened = true; return; }
    if (!recordOpened) return;
    root.beforeOpen = null;
    gated();
    await gate;
  };
  const writing = a.put('file-7', 'p', { file: fileOf(7), image });
  await between;
  const loading = tab().load();
  for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 0));
  release();
  assert.equal(await writing, true);
  await loading;
  const [seventh] = await tab().find('file-7');
  assert.ok(seventh && (await tab().read(seventh.name)), `${label}: a record written while another tab starts is kept`);
  // Reads take no lock.
  const grants = locks.grants;
  await d.read((await d.find('file-1'))[0].name);
  await d.readBytes('file-2', 'recipe');
  await d.find('file-5');
  assert.equal(locks.grants, grants, `${label}: reads take no lock`);
  // Their last uses are merged into the index by the next change.
  const used = (await d.find('file-1'))[0].lastUsed;
  await d.settled();
  assert.equal((await tab().find('file-1'))[0].lastUsed, used, `${label}: a read's last use reaches the index`);
  // Clear cache empties every tab's records; the other tabs follow.
  await a.clear();
  assert.equal((await recordFiles(root)).size, 0, `${label}: cleared`);
  assert.equal(await b.read((await b.find('file-5'))[0].name), null, `${label}: a stale entry reads as a miss`);
  assert.equal(await b.put('file-6', 'p', { file: fileOf(6), image }), true);
  assert.equal([...(await recordFiles(root)).keys()].filter(name => name !== 'index.ncdp').length, 1, `${label}: only the new record`);
  assert.equal(b.size, 1, `${label}: the other tab's copy is the records' index again`);
}
await sharedByTwoTabs();
await sharedByTwoTabs({ webkit16: true });
// The budget and the LRU count every tab's records: room for about two
// proxies in all, three puts from each of two tabs leave two.
{
  const image = proxyImage();
  const probe = opfsTab(fakeOpfs(), { locks: locksStub() });
  await probe.put('probe', 'p', { file: fileOf(0), image });
  const recordBytes = probe.bytes;
  const locks = locksStub();
  const root = fakeOpfs();
  let clock = 0;
  const tab = () => opfsTab(root, { locks, now: () => ++clock, limitBytes: () => Math.floor(recordBytes * 2.5) });
  const a = tab(), b = tab();
  for (let i = 0; i < 3; i++) {
    assert.equal(await a.put(`a-${i}`, 'p', { file: fileOf(10 + i), image }), true);
    assert.equal(await b.put(`b-${i}`, 'p', { file: fileOf(20 + i), image }), true);
  }
  const kept = [...(await recordFiles(root))].filter(([name]) => name !== 'index.ncdp');
  assert.equal(kept.length, 2, 'two proxies in the shared budget');
  assert.ok(kept.reduce((sum, [, node]) => sum + node.bytes.byteLength, 0) <= recordBytes * 2.5, 'within it');
  assert.equal((await tab().find('b-2')).length + (await tab().find('a-2')).length, 2, 'the most recent ones');
}

// ---- Without Web Locks (Safari before 15.4) a record missing from the index
// may be another tab's write in flight: nothing is deleted without a lock ----
{
  const records = memoryRecords();
  const young = 'a'.repeat(64), old = 'b'.repeat(64);
  records.data.set(young, { bytes: new Uint8Array(10), modifiedMs: Date.now() });
  records.data.set(old, { bytes: new Uint8Array(10), modifiedMs: Date.now() - 24 * 60 * 60 * 1000 });
  await createDisplayProxyStore({ port: localPort(), records, availableBytes: async () => 20 * GiB, locks: null }).load();
  assert.equal(records.data.has(young), true, 'a young record without an entry is kept');
  assert.equal(records.data.has(old), true, 'old records are also kept without ownership');
  // Under the lock no tab is between a record and its entry: every orphan goes.
  await createDisplayProxyStore({ port: localPort(), records, availableBytes: async () => 20 * GiB, locks: locksStub() }).load();
  assert.equal(records.data.has(young), false, 'under the lock every orphan is deleted');
}

// ---- Where a lock request fails (an origin without Web Locks), the store
// reads existing entries but makes no shared mutations; a lock that is not
// granted in time does not stall the app or bypass the live owner ----
{
  const image = proxyImage();
  const young = 'a'.repeat(64), old = 'b'.repeat(64);
  const withOrphans = () => {
    const records = memoryRecords();
    records.data.set(young, { bytes: new Uint8Array(10), modifiedMs: Date.now() });
    records.data.set(old, { bytes: new Uint8Array(10), modifiedMs: Date.now() - 24 * 60 * 60 * 1000 });
    return records;
  };
  let refused = 0;
  const refusing = { request: async () => { refused++; throw Object.assign(new Error('denied'), { name: 'SecurityError' }); } };
  const records = withOrphans();
  const store = createDisplayProxyStore({ port: localPort(), records, availableBytes: async () => 20 * GiB, locks: refusing });
  await store.load();
  assert.equal(records.data.has(young), true, 'a refused lock: a young orphan is kept');
  assert.equal(records.data.has(old), true, 'a denied lock does not authorize orphan deletion');
  assert.equal(await store.put('file-a', 'p', { file: fileOf(1), image }), false, 'a refused lock skips the write');
  assert.equal((await store.find('file-a')).length, 0);
  assert.equal(refused, 1, 'the lock is asked for once');
  const never = {
    requests: 0,
    request(name, options) {
      never.requests++;
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('not granted', 'AbortError'))));
    }
  };
  const stalled = withOrphans();
  const waiting = createDisplayProxyStore({ port: localPort(), records: stalled, availableBytes: async () => 20 * GiB, locks: never, lockWaitMs: 20 });
  assert.equal(DISPLAY_PROXY_LOCK_WAIT_MS, 10_000);
  const started = Date.now();
  assert.equal(await waiting.put('file-b', 'p', { file: fileOf(2), image }), false, 'a lock never granted skips the write');
  assert.ok(Date.now() - started < 5000, 'it waits a bounded time');
  assert.equal(stalled.data.has(young), true, 'without the lock a young orphan is kept');
  assert.equal(stalled.data.has(old), true);
  assert.equal(await waiting.has('file-b', 'p'), false);
  assert.equal(never.requests, 3, 'and it is asked for again each time');
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

console.log('displayProxyStore: spill, persistent store, budgets, LRU, checksum purge, index restart, Clear cache, OPFS sync access handles, two tabs and desktop chunks passed');

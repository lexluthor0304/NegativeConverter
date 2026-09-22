import assert from 'node:assert/strict';
import { createAnalysisSampleStore, createIndexedDbSampleBackend, ANALYSIS_SAMPLE_DATABASE_PREFIX } from './analysisSampleStore.js';

function sample(seed) {
  return { width: 5, height: 3, data: Uint8ClampedArray.from({ length: 60 }, (_, i) => (i * 7 + seed) % 256),
    __image16: { width: 5, height: 3, data: Uint16Array.from({ length: 60 }, (_, i) => i * 731 + seed) } };
}
function disk() {
  const data = new Map();
  return {
    data,
    async put(key, value) { await Promise.resolve(); data.set(key, structuredClone(value)); },
    async get(key) { return data.has(key) ? structuredClone(data.get(key)) : null; },
    async delete(key) { data.delete(key); },
    async clear() { data.clear(); },
  };
}
const backend = disk();
const store = createAnalysisSampleStore({ maxBytes: 360, backend });
const samples = Array.from({ length: 12 }, (_, i) => sample(i));
await Promise.all(samples.map((value, i) => store.put(`frame-${i}`, value)));
assert.equal(store.bytes, 360);
assert.equal(store.stats.spilledEntries, 10);
assert.equal(store.stats.memoryEntries, 2);
for (let pass = 0; pass < 3; pass++) for (let i = 0; i < samples.length; i++) {
  const retrieved = await store.get(`frame-${i}`);
  assert.deepEqual(retrieved, samples[i], 'lossless 8-bit and 16-bit samples survive every pass');
  assert.ok(retrieved.__image16.data instanceof Uint16Array);
  if (i >= 10) assert.equal(retrieved, samples[i], 'RAM reads do not clone');
  assert.equal(store.bytes, 360, 'disk reads do not create a second RAM cache');
}
await store.delete('frame-0');
assert.equal(await store.get('frame-0'), null);
assert.equal(backend.data.size, 9);
await store.put('frame-1', sample(99));
assert.deepEqual(await store.get('frame-1'), sample(99), 'overwriting a spilled key cannot return the old record');
await store.clear();
assert.equal(backend.data.size, 0, 'private spill storage cleaned up');
assert.equal(store.bytes, 0);
assert.equal(store.stats.memoryEntries + store.stats.spilledEntries, 0);

const direct = createAnalysisSampleStore({ maxBytes: 1, backend: disk() });
await direct.put('large', samples[0]);
assert.equal(direct.bytes, 0, 'samples larger than the budget spill directly');
assert.deepEqual(await direct.get('large'), samples[0]);
const fallback = createAnalysisSampleStore({ maxBytes: 180, backend: null });
await fallback.put(1, samples[0]); await fallback.put(2, samples[1]);
assert.equal(fallback.bytes, 180);
assert.equal(await fallback.get(1), null, 'no-IDB eviction requests a decode through a cache miss');
assert.equal(await fallback.get(2), samples[1]);
assert.equal(fallback.stats.droppedSamples, 1);
const failingDisk = disk();
failingDisk.put = async () => { throw new Error('QuotaExceededError'); };
const failed = createAnalysisSampleStore({ maxBytes: 180, backend: failingDisk });
await Promise.all(samples.map((value, i) => failed.put(i, value)));
assert.equal(failed.bytes, 180);
assert.equal(failed.stats.failedOperations, 1, 'failed spill backend is not retried for every frame');
assert.equal(failed.stats.droppedSamples, 11);
assert.equal(await failed.get(0), null);
assert.equal(await failed.get(11), samples[11]);
assert.equal(createIndexedDbSampleBackend(null), null);
// A view retains its entire backing buffer, even if only a few elements are read.
const backing = new Uint8ClampedArray(1000);
await fallback.clear();
await fallback.put('view', { width: 1, height: 1, data: backing.subarray(0, 4) });
assert.equal(fallback.bytes, 0, 'backing buffers count against the RAM budget');
console.log('analysisSampleStore: lossless spill, repeated passes, concurrent puts, memory cap, cleanup and failure fallback passed');

// Deterministic Web Locks + IDB stand-ins exercise real backend lifetime logic,
// including a killed tab (lock released, database still present).
const heldLocks = new Map();
const locks = {
  async request(name, options, callback) {
    if (heldLocks.has(name)) {
      assert.ok(options.ifAvailable, 'ownership must not wait on an active database');
      return callback(null);
    }
    const lock = { name };
    heldLocks.set(name, lock);
    try { return await callback(lock); }
    finally { if (heldLocks.get(name) === lock) heldLocks.delete(name); }
  },
};
const databases = new Map();
const connections = new Map();
const deleted = [];
const indexedDB = {
  async databases() { return [...databases.keys()].map(name => ({ name })); },
  open(name) {
    const request = {};
    queueMicrotask(() => {
      assert.ok(heldLocks.has(`negativeconverter-analysis-database:${name}`), 'hold ownership before opening the database');
      const fresh = !databases.has(name);
      if (fresh) databases.set(name, new Map());
      const values = databases.get(name);
      connections.set(name, (connections.get(name) || 0) + 1);
      const db = {
        createObjectStore() {},
        close() { connections.set(name, Math.max(0, (connections.get(name) || 0) - 1)); },
        transaction() {
          const transaction = {
            objectStore() {
              const perform = operation => {
                const op = {};
                queueMicrotask(() => { op.result = operation(); op.onsuccess?.(); transaction.oncomplete?.(); });
                return op;
              };
              return {
                put: (value, key) => perform(() => values.set(key, structuredClone(value))),
                get: key => perform(() => values.has(key) ? structuredClone(values.get(key)) : undefined),
                delete: key => perform(() => values.delete(key)),
              };
            },
            abort() { transaction.onabort?.(); },
          };
          return transaction;
        },
      };
      request.result = db;
      if (fresh) request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request;
  },
  deleteDatabase(name) {
    const request = {};
    queueMicrotask(() => {
      if (connections.get(name)) { request.onblocked?.(); return; }
      databases.delete(name); deleted.push(name); request.onsuccess?.();
    });
    return request;
  },
};
const orphan = `${ANALYSIS_SAMPLE_DATABASE_PREFIX}crashed-old-session`;
const legacy = 'negativeconverter-analysis-samples-uncoordinated-legacy';
databases.set(orphan, new Map()); databases.set(legacy, new Map());
const firstBackend = createIndexedDbSampleBackend(indexedDB, locks);
await firstBackend.put('first', samples[0]);
assert.ok(deleted.includes(orphan), 'unlocked previous-session database reclaimed');
assert.ok(databases.has(legacy), 'uncoordinated databases are not assumed abandoned');
const firstName = [...databases.keys()].find(name => name.startsWith(ANALYSIS_SAMPLE_DATABASE_PREFIX));
const secondBackend = createIndexedDbSampleBackend(indexedDB, locks);
await secondBackend.put('second', samples[1]);
assert.ok(databases.has(firstName), 'a different live tab keeps its database');
assert.deepEqual(await firstBackend.get('first'), samples[0], 'cleanup preserves another session exact samples');
// Simulate first tab/process death. Its async callback no longer owns a lock or
// connection; no application finally/unload cleanup has run.
heldLocks.delete(`negativeconverter-analysis-database:${firstName}`);
connections.set(firstName, 0);
const thirdBackend = createIndexedDbSampleBackend(indexedDB, locks);
await thirdBackend.put('third', samples[2]);
assert.ok(deleted.includes(firstName), 'crash leftovers reclaimed by next spill session');
assert.deepEqual(await secondBackend.get('second'), samples[1], 'live sibling survives crash cleanup');
await secondBackend.clear(); await thirdBackend.clear();
assert.equal(heldLocks.size, 0, 'normal clear releases all live ownership locks');
assert.deepEqual([...databases.keys()], [legacy], 'normal sessions leave no spill databases');
assert.equal(createIndexedDbSampleBackend({}, locks), null, 'no databases enumeration uses bounded RAM fallback');
assert.equal(createIndexedDbSampleBackend(indexedDB, {}), null, 'no Web Locks uses bounded RAM fallback');
console.log('analysisSampleStore: exclusive ownership, active-tab isolation, orphan cleanup, crash recovery and API fallback passed');

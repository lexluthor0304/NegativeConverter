import assert from 'node:assert/strict';
import { fetchModelBlob, fetchModelBytes, isModelFamilyKey, readCachedModel, writeCachedModel } from './modelCache.js';
import { DEFAULT_MODEL_URL, fetchModelBytes as fetchMiganBytes } from './aiInpaint.js';

// A small in-memory IndexedDB: requests run in order after the current task,
// callbacks may queue more, and a failed request aborts the whole transaction.
function createFakeIndexedDB() {
  const databases = new Map();
  let failPut = () => false;
  const later = fn => setTimeout(fn, 0);
  return {
    databases,
    failPutWhen(predicate) { failPut = predicate; },
    open(name) {
      const request = {};
      later(() => {
        const upgrade = !databases.has(name);
        if (upgrade) databases.set(name, new Map());
        const db = databases.get(name);
        request.result = {
          createObjectStore(storeName) { db.set(storeName, new Map()); },
          close() {},
          transaction(storeName, mode) {
            const store = db.get(storeName);
            const staged = new Map(store);
            const queue = [];
            let failed = null;
            const transaction = { error: null };
            const enqueue = operation => {
              const req = {};
              queue.push(() => {
                try { req.result = operation(); req.onsuccess?.(); } catch (error) { req.error = failed = error; req.onerror?.(); }
              });
              return req;
            };
            transaction.objectStore = () => ({
              get: key => enqueue(() => staged.get(key)),
              put: (value, key) => enqueue(() => {
                if (mode !== 'readwrite') throw new Error('ReadOnlyError');
                if (failPut(value, key)) throw new Error('QuotaExceededError');
                staged.set(key, value);
              }),
              getAllKeys: () => enqueue(() => [...staged.keys()]),
              delete: key => enqueue(() => { staged.delete(key); }),
            });
            later(() => {
              while (queue.length && !failed) queue.shift()();
              if (failed) { transaction.error = failed; transaction.onerror?.(); transaction.onabort?.(); return; }
              if (mode === 'readwrite') { store.clear(); for (const [key, value] of staged) store.set(key, value); }
              transaction.oncomplete?.();
            });
            return transaction;
          },
        };
        if (upgrade) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
}

const idb = createFakeIndexedDB();
globalThis.indexedDB = idb;
const stored = () => [...idb.databases.get('nc_ai_models').get('models').keys()].sort();
let fetches = [];
globalThis.fetch = async url => {
  fetches.push(url);
  if (String(url).includes('missing')) return { ok: false, status: 404 };
  const body = Uint8Array.from(String(url), char => char.charCodeAt(0) & 255);
  return {
    ok: true, headers: { get: () => String(body.length) }, body: null,
    arrayBuffer: async () => body.buffer.slice(0),
    blob: async () => new Blob([body]),
  };
};
const originalWarn = console.warn;
console.warn = () => {};

try {
  // Family keys: the unversioned key of older builds and any fingerprinted one.
  for (const key of ['./models/migan_pipeline_v2.onnx', '/models/migan_pipeline_v2.onnx',
    'https://negative-converter.tokugai.com/assets/migan_pipeline_v2-Ab3_x9Qz.onnx', 'tauri://localhost/assets/migan_pipeline_v2-0000aaaa.onnx?x=1']) {
    assert.ok(isModelFamilyKey(key, 'migan_pipeline_v2'), key);
  }
  for (const key of ['https://x/assets/efficientvit-b1-ade20k-Dx8aB3kQ.onnx', '/models/other.onnx', 'migan_pipeline_v2.onnx.bak', 42]) {
    assert.equal(isModelFamilyKey(key, 'migan_pipeline_v2'), false, String(key));
  }
  assert.ok(isModelFamilyKey('https://x/assets/efficientvit-b1-ade20k-Dx8aB3kQ.onnx', 'efficientvit-b1-ade20k'));
  assert.equal(isModelFamilyKey('/models/migan_pipeline_v2.onnx', null), false);

  // MI-GAN moved to a hashed URL: the old IndexedDB key goes once the new one is written.
  const legacy = './models/migan_pipeline_v2.onnx';
  const semanticKey = 'https://x/assets/efficientvit-b1-ade20k-Dx8aB3kQ.onnx';
  assert.equal(await writeCachedModel(legacy, new ArrayBuffer(3)), true);
  assert.equal(await writeCachedModel(semanticKey, new Blob([new Uint8Array(2)])), true);
  assert.equal(await readCachedModel('absent'), null);
  assert.ok(DEFAULT_MODEL_URL.endsWith('/src/assets/models/migan_pipeline_v2.onnx'), DEFAULT_MODEL_URL);
  const miganBytes = await fetchMiganBytes(DEFAULT_MODEL_URL);
  assert.equal(new TextDecoder().decode(miganBytes), DEFAULT_MODEL_URL);
  assert.deepEqual(stored(), [DEFAULT_MODEL_URL, semanticKey].sort(), 'legacy MI-GAN key removed, other models kept');
  fetches = [];
  assert.equal(new TextDecoder().decode(await fetchMiganBytes(DEFAULT_MODEL_URL)), DEFAULT_MODEL_URL);
  assert.deepEqual(fetches, [], 'the second load reads IndexedDB');

  // A user-supplied URL is cached without touching the bundled model's keys.
  await fetchMiganBytes('https://example.com/custom/migan_pipeline_v2.onnx');
  assert.ok(stored().includes(DEFAULT_MODEL_URL));

  // A failed write aborts its deletes too: the previous copy survives.
  idb.failPutWhen((value, key) => key.includes('-NEWHASH1'));
  assert.equal(await writeCachedModel('https://x/assets/efficientvit-b1-ade20k-NEWHASH1.onnx', new ArrayBuffer(1), { family: 'efficientvit-b1-ade20k' }), false);
  assert.ok(stored().includes(semanticKey), 'the old key stays when the new one could not be written');
  idb.failPutWhen(() => false);

  // fetchModelBlob: a Blob from the network, then from IndexedDB.
  const url = 'https://x/assets/efficientvit-b1-ade20k-Zz9Yy8Xx.onnx';
  fetches = [];
  const blob = await fetchModelBlob(url, { family: 'efficientvit-b1-ade20k' });
  assert.ok(blob instanceof Blob);
  assert.equal(await blob.text(), url);
  assert.deepEqual(fetches, [url]);
  await new Promise(resolve => setTimeout(resolve, 20)); // the IndexedDB copy is written in the background
  assert.ok(stored().includes(url) && !stored().includes(semanticKey), 'the new semantic key replaced the old hash');
  fetches = [];
  const again = await fetchModelBlob(url, { family: 'efficientvit-b1-ade20k' });
  assert.ok(again instanceof Blob);
  assert.equal(await again.text(), url);
  assert.deepEqual(fetches, [], 'read back from IndexedDB, no request');
  // A legacy ArrayBuffer record still comes back as a Blob.
  await writeCachedModel('legacy-buffer.onnx', Uint8Array.from([7]).buffer);
  assert.deepEqual([...new Uint8Array(await (await fetchModelBlob('legacy-buffer.onnx')).arrayBuffer())], [7]);
  // Desktop (cache: false) never touches IndexedDB.
  const before = stored();
  fetches = [];
  await fetchModelBlob('https://x/assets/desktop-only.onnx', { cache: false });
  assert.deepEqual(fetches, ['https://x/assets/desktop-only.onnx']);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(stored(), before);
  await assert.rejects(fetchModelBlob('https://x/missing.onnx'), /404/);
  await assert.rejects(fetchModelBytes('https://x/missing.onnx'), /404/);

  // Without IndexedDB (private windows, Node) the models still load.
  delete globalThis.indexedDB;
  assert.equal(await writeCachedModel('k', new ArrayBuffer(1)), false);
  assert.equal(await readCachedModel('k'), null);
  assert.equal(await (await fetchModelBlob('https://x/plain.onnx')).text(), 'https://x/plain.onnx');
} finally {
  console.warn = originalWarn;
  delete globalThis.indexedDB;
  delete globalThis.fetch;
}
console.log('modelCache: hashed keys, stale family keys removed after a successful write, Blob reuse');

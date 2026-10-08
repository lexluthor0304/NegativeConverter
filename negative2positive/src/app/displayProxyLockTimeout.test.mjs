import assert from 'node:assert/strict';
import { createDisplayProxyStore } from './displayProxyStore.js';
const data = new Map();
let holdWrite = false, release, reached;
const entered = new Promise(r => { reached = r; });
const gate = new Promise(r => { release = r; });
const records = {
 async read(name) { return data.get(name)?.slice(0) ?? null; },
 async write(name, bytes) {
  if (holdWrite && name !== 'index') { holdWrite = false; reached(); await gate; }
  data.set(name, bytes.slice(0));
 },
 async list() { return [...data].map(([name, bytes]) => ({ name, bytes: bytes.byteLength, modifiedMs: Date.now() })); },
 async delete(name) { data.delete(name); },
 async clear() { data.clear(); }
};
let tail = Promise.resolve();
const locks = { request(name, { signal }, callback) {
 let abort;
 const cancelled = new Promise((_, reject) => { abort = () => reject(new DOMException('Lock wait timed out', 'AbortError')); signal.addEventListener('abort', abort, { once: true }); });
 const run = tail.then(() => { if (signal.aborted) throw new DOMException('Aborted', 'AbortError'); signal.removeEventListener('abort', abort); return callback(); });
 tail = run.catch(() => {});
 return Promise.race([run, cancelled]);
}};
const tab = () => createDisplayProxyStore({ records, locks, lockWaitMs: 20, availableBytes: async () => 30 * 1024 ** 3 });
const a = tab(), b = tab();
await a.load(); await b.load();
holdWrite = true;
const pendingA = a.putBytes('file-a', 'p', new Uint8Array([1,2,3]).buffer);
await entered;
let savedB;
try {
  savedB = await b.putBytes('file-b', 'p', new Uint8Array([4,5,6]).buffer);
  assert.equal(savedB, false, 'a timed-out waiter must not overwrite the active owner');
  await b.clear();
  await b.forget('file-a');
  await b.trim();
  await b.settled();
  assert.equal(data.has('index'), false, 'a waiting tab performs no shared mutations');
} finally { release(); }
assert.equal(await pendingA, true);
assert.equal(await b.putBytes('file-b', 'p', new Uint8Array([4,5,6]).buffer), true, 'the next operation retries the lock');
const indexedFiles = () => JSON.parse(new TextDecoder().decode(data.get('index'))).entries.map(([,e]) => e.fileKey).sort();
assert.deepEqual(indexedFiles(), ['file-a', 'file-b'], 'both successful writers remain indexed');

for (const unavailable of [null, { request: async () => { throw new DOMException('Unavailable', 'SecurityError'); } }]) {
  const readonly = createDisplayProxyStore({ records, locks: unavailable, availableBytes: async () => 30 * 1024 ** 3 });
  const before = [...data].map(([key,value]) => [key, Buffer.from(value).toString('hex')]);
  assert.deepEqual(new Uint8Array(await readonly.readBytes('file-a', 'p')), new Uint8Array([1,2,3]), 'existing cached data is still readable');
  assert.equal(await readonly.putBytes('file-c', 'p', new Uint8Array([7]).buffer), false);
  await readonly.forget('file-a');
  await readonly.trim();
  await readonly.clear();
  await readonly.settled();
  assert.deepEqual([...data].map(([key,value]) => [key, Buffer.from(value).toString('hex')]), before, 'no lock means no shared writes or deletes');
}
console.log('displayProxyLockTimeout: bounded lock waits preserve the active writer, retry safely and keep unlocked reads read-only');

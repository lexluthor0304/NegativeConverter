// The display-proxy spill (#249): Tier B photo sessions that no longer fit
// the session budget, and proxies the roll analysis and the lanes fill, kept
// on disk for this session. Records are packed, checksummed and written in a
// worker (displayProxyWorker.js), so neither the packing nor IndexedDB's
// serialisation runs on the main thread; the main thread keeps only an index
// (which photo has which proxy key, and its size) to answer `has` at once.
//
// Web: a private per-tab IndexedDB database with the analysis samples' lock
// protocol (orphans of closed tabs are reclaimed). Desktop: the worker hands
// the encoded record back and the Rust store in the app's cache directory
// holds it, so no pixels reach WebKit's origin storage. Where neither is
// available the spill is off and a Tier B entry that does not fit is dropped
// (the photo reopens from a decode).
import { createPrivateIndexedDbBackend } from './analysisSampleStore.js';
import {
  packDisplayPlane, encodeDisplayProxyRecord, decodeDisplayProxyRecord, unpackDisplayPlane, checksum32
} from './displayProxy.js';

export const DISPLAY_PROXY_SPILL_PREFIX = 'negativeconverter-display-proxies-v1-';
const spillLockName = name => `negativeconverter-display-proxy-database:${name}`;

// Leave this much free space: on the audit machine the data volume also
// holds swap.
export const DISPLAY_PROXY_SPILL_FLOOR_BYTES = 2 * 1024 ** 3;
// And never use more than this, or a quarter of what is free.
export const DISPLAY_PROXY_SPILL_MAX_BYTES = 4 * 1024 ** 3;

export function createDisplayProxySpillBackend({ indexedDB = globalThis.indexedDB, locks = globalThis.navigator?.locks } = {}) {
  return createPrivateIndexedDbBackend({ prefix: DISPLAY_PROXY_SPILL_PREFIX, lockName: spillLockName, indexedDB, locks });
}

/**
 * The worker's side. `backend` (put/get/delete/clear by string key) may be
 * null: records then only pass through (`target: 'record'` on put, `record`
 * on get), as on the desktop.
 */
export function createDisplayProxyWorkerCore({ backend = null, records = null } = {}) {
  let store = backend;
  // The persistent store's records (#249 part 3), created on first use.
  let recordStore = null;
  const persistent = () => (recordStore ||= typeof records === 'function' ? records() : records);
  return {
    get hasBackend() { return Boolean(store); },
    async handle(message) {
      switch (message?.type) {
        case 'put': {
          const { key, proxyKey, meta = {}, image, sample = null, target = 'store' } = message;
          const packed = packDisplayPlane({ width: image.width, height: image.height, data: image.data8, __image16: image.data16 ? { width: image.width, height: image.height, data: image.data16 } : undefined });
          const record = encodeDisplayProxyRecord({ key: proxyKey, meta, plane: packed, sample });
          if (target === 'records') {
            // Encoded and written here, for the persistent store.
            await persistent().write(message.name, record);
            return { reply: { bytes: record.byteLength } };
          }
          if (target === 'record' || !store) return { reply: { bytes: record.byteLength, record }, transfer: [record] };
          await store.put(key, record);
          return { reply: { bytes: record.byteLength } };
        }
        case 'records-read': {
          const record = await persistent().read(message.name);
          return { reply: { record }, transfer: record ? [record] : [] };
        }
        case 'records-write':
          await persistent().write(message.name, message.record);
          return { reply: { ok: true } };
        case 'records-delete':
          await persistent().delete(message.name);
          return { reply: { ok: true } };
        case 'records-clear':
          await persistent().clear();
          return { reply: { ok: true } };
        case 'records-list':
          return { reply: { entries: await persistent().list() } };
        case 'records-probe':
          return { reply: { records: Boolean(persistent()) } };
        case 'get': {
          const record = message.record || (store ? await store.get(message.key) : null);
          if (!record) return { reply: { miss: true } };
          const decoded = decodeDisplayProxyRecord(record, { expectKey: message.proxyKey ?? null });
          if (!decoded) {
            if (!message.record && store) await store.delete(message.key).catch(() => {});
            return { reply: { miss: true, corrupt: true } };
          }
          const image = unpackDisplayPlane(decoded.plane, null);
          const data16 = image.__image16?.data || null;
          // A display level (#248) has no 8-bit plane.
          const transfer = image.data ? [image.data.buffer] : [];
          if (data16) transfer.push(data16.buffer);
          if (decoded.sample?.data) transfer.push(decoded.sample.data.buffer);
          return {
            reply: { image: { width: image.width, height: image.height, data8: image.data || null, data16 }, sample: decoded.sample, meta: decoded.meta, key: decoded.key },
            transfer
          };
        }
        case 'delete':
          if (store) await store.delete(message.key);
          return { reply: { ok: true } };
        case 'clear':
          if (store) await store.clear();
          return { reply: { ok: true } };
        case 'probe':
          return { reply: { store: Boolean(store) } };
        default:
          return { reply: { error: `Unknown display proxy request: ${message?.type}` } };
      }
    }
  };
}

// The image a worker reply carries: an ImageData with its 16-bit plane, or a
// 16-bit-only display level { width, height, __image16 } (#248).
function imageOfReply({ width, height, data8, data16 }, ImageDataCtor) {
  if (!data8) return { width, height, __image16: { width, height, data: data16 } };
  const image = typeof ImageDataCtor === 'function' ? new ImageDataCtor(data8, width, height) : { width, height, data: data8 };
  if (data16) image.__image16 = { width, height, data: data16 };
  return image;
}

// A request/response port to a worker running the core, or the core itself
// on this thread (tests, and hosts without module workers).
export function createDisplayProxyPort({ workerFactory = null, core = null } = {}) {
  let worker = null;
  let broken = false;
  let sequence = 0;
  const pending = new Map();
  const local = core || null;
  function spawn() {
    if (worker || broken || !workerFactory) return worker;
    try {
      worker = workerFactory();
      worker.onmessage = ({ data }) => {
        const entry = pending.get(data?.id);
        if (!entry) return;
        pending.delete(data.id);
        if (data.error) entry.reject(new Error(data.error));
        else entry.resolve(data.reply);
      };
      worker.onerror = event => {
        broken = true;
        for (const entry of pending.values()) entry.reject(new Error(event?.message || 'Display proxy worker failed'));
        pending.clear();
        try { worker.terminate(); } catch { /* already gone */ }
        worker = null;
      };
    } catch {
      broken = true;
      worker = null;
    }
    return worker;
  }
  return {
    get available() { return Boolean(local) || (!broken && Boolean(workerFactory)); },
    async request(message, transfer = []) {
      if (local) return (await local.handle(message)).reply;
      const target = spawn();
      if (!target) throw new Error('Display proxy worker unavailable');
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try { target.postMessage({ ...message, id }, transfer); } catch (error) { pending.delete(id); reject(error); }
      });
    },
    dispose() {
      for (const entry of pending.values()) entry.reject(new DOMException('Display proxy port closed', 'AbortError'));
      pending.clear();
      try { worker?.terminate(); } catch { /* already gone */ }
      worker = null;
    }
  };
}

/**
 * The main thread's spill: an index of what is on disk and the admission
 * policy. `port` runs the worker core. `recordStore` (desktop) keeps the
 * encoded records instead of the worker's IndexedDB: { write(key, record),
 * read(key), delete(key), clear() }. `availableBytes()` resolves the free
 * space the spill may count on (null when unknown); below the floor nothing
 * is written. Every operation resolves; failures count and read as misses.
 */
export function createDisplayProxySpill({
  port, recordStore = null, availableBytes = async () => null,
  floorBytes = DISPLAY_PROXY_SPILL_FLOOR_BYTES, maxBytes = DISPLAY_PROXY_SPILL_MAX_BYTES
} = {}) {
  const index = new Map();
  let bytes = 0;
  let queue = Promise.resolve();
  let enabled = Boolean(port?.available);
  const stats = { writes: 0, reads: 0, misses: 0, corrupt: 0, failures: 0, refusedForSpace: 0, evictions: 0 };
  // The worker says once whether it has a database to write to.
  let probed = null;
  function ready() {
    if (recordStore) return Promise.resolve(true);
    probed ||= port.request({ type: 'probe' }).then(reply => Boolean(reply?.store), () => false).then(store => {
      if (!store) enabled = false;
      return store;
    });
    return probed;
  }

  function enqueue(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }

  function forget(key) {
    const entry = index.get(key);
    if (!entry) return null;
    index.delete(key);
    bytes -= entry.bytes;
    return entry;
  }

  async function removeStored(key) {
    try {
      if (recordStore) await recordStore.delete(key);
      else await port.request({ type: 'delete', key });
    } catch { stats.failures++; }
  }

  async function budget(extra) {
    const free = await availableBytes().catch(() => null);
    let limit = maxBytes;
    if (Number.isFinite(free)) {
      if (free - extra < floorBytes) return -1;
      limit = Math.min(limit, Math.floor((free + bytes) / 4));
    }
    return limit;
  }

  return {
    get enabled() { return enabled; },
    has(key) { return index.has(key); },
    proxyKey(key) { return index.get(key)?.proxyKey ?? null; },
    meta(key) { return index.get(key)?.meta ?? null; },
    /**
     * Spills `image` (an ImageData with its __image16, the display proxy)
     * and `sample` under `key`. The planes are posted as copies (the caller
     * keeps them), or moved with `transfer`. Resolves whether the record is
     * on disk.
     */
    put(key, { image, sample = null, proxyKey, meta = {}, transfer = false }) {
      if (!enabled || !image) return Promise.resolve(false);
      return enqueue(async () => {
        if (!(await ready())) return false;
        const previous = forget(key);
        if (previous) await removeStored(key);
        const estimate = image.width * image.height * 6 + (sample?.data?.byteLength || 0);
        const limit = await budget(estimate);
        if (limit < 0 || estimate > limit) {
          stats.refusedForSpace++;
          return false;
        }
        while (bytes + estimate > limit && index.size) {
          const oldest = index.keys().next().value;
          forget(oldest);
          stats.evictions++;
          await removeStored(oldest);
        }
        const message = {
          type: 'put', key, proxyKey, meta, sample: sample ? { width: sample.width, height: sample.height, data: sample.data } : null,
          image: { width: image.width, height: image.height, data8: image.data, data16: image.__image16?.data || null },
          target: recordStore ? 'record' : 'store'
        };
        try {
          // A proxy the caller owns (a fill) moves to the worker; a cached one is copied.
          const moved = transfer ? [image.data?.buffer, image.__image16?.data?.buffer].filter(Boolean) : [];
          const reply = await port.request(message, moved);
          if (recordStore) await recordStore.write(key, reply.record);
          index.set(key, { proxyKey, bytes: reply.bytes, meta });
          bytes += reply.bytes;
          stats.writes++;
          return true;
        } catch (error) {
          stats.failures++;
          // A backend that cannot write (quota, private mode) stays off.
          if (stats.failures >= 3) enabled = false;
          console.warn('Display proxy spill write failed:', error?.message || error);
          return false;
        }
      });
    },
    /**
     * The spilled proxy of `key` when its proxy key is `proxyKey`:
     * { image: ImageData with __image16, sample, meta }, or null.
     */
    get(key, { proxyKey = null, ImageDataCtor = globalThis.ImageData } = {}) {
      const entry = index.get(key);
      if (!entry || (proxyKey !== null && entry.proxyKey !== proxyKey)) return Promise.resolve(null);
      return enqueue(async () => {
        if (index.get(key) !== entry) return null;
        try {
          const record = recordStore ? await recordStore.read(key) : null;
          if (recordStore && !record) {
            forget(key);
            stats.misses++;
            return null;
          }
          const reply = await port.request({ type: 'get', key, proxyKey: entry.proxyKey, record }, record ? [record] : []);
          if (!reply || reply.miss) {
            forget(key);
            if (reply?.corrupt) stats.corrupt++;
            stats.misses++;
            return null;
          }
          // Recently used.
          index.delete(key);
          index.set(key, entry);
          stats.reads++;
          const image = imageOfReply(reply.image, ImageDataCtor);
          return { image, sample: reply.sample || null, meta: reply.meta || entry.meta };
        } catch (error) {
          stats.failures++;
          console.warn('Display proxy spill read failed:', error?.message || error);
          return null;
        }
      });
    },
    delete(key) {
      if (!index.has(key)) return Promise.resolve(false);
      forget(key);
      return enqueue(async () => { await removeStored(key); return true; });
    },
    /** Drops every entry whose key is not in `keys` (queue removal). */
    retain(keys) {
      const kept = new Set(keys);
      const gone = [...index.keys()].filter(key => !kept.has(key));
      for (const key of gone) forget(key);
      if (!gone.length) return Promise.resolve();
      return enqueue(async () => { for (const key of gone) await removeStored(key); });
    },
    clear() {
      index.clear();
      bytes = 0;
      return enqueue(async () => {
        try {
          if (recordStore) await recordStore.clear();
          else await port.request({ type: 'clear' });
        } catch { stats.failures++; }
      });
    },
    get bytes() { return bytes; },
    get size() { return index.size; },
    get stats() { return { ...stats, bytes, entries: index.size, enabled }; },
    /** Resolves once every queued operation has settled (tests). */
    settled() { return queue; }
  };
}

// ===========================================
// The persistent store (#249 part 3)
// ===========================================
// Display proxies kept across restarts and project reopens, keyed by the
// file's content and the proxy's geometry, lens, analysis area and target.
// Only exact decode routes are stored, never a recipe; a record carries its
// full key and a checksum, verified on read. The budget follows the disk on
// the desktop: at most `min(setting, 25 % of the free space above a 10 GiB
// floor)`, off below the floor. The web knows only the origin's quota left,
// which no disk floor applies to (Firefox caps an origin at 10 GiB, Chrome
// reports its usage plus 10 GiB: R2-068): at most `min(setting, half of
// it)`, the store's own records counted as left, off below 512 MiB.

export const DISPLAY_PROXY_STORE_FLOOR_BYTES = 10 * 1024 ** 3;
export const DISPLAY_PROXY_STORE_QUOTA_FLOOR_BYTES = 512 * 1024 ** 2;
export const DISPLAY_PROXY_STORE_DEFAULT_LIMIT_BYTES = 2 * 1024 ** 3;
export const DISPLAY_PROXY_TAIL_BYTES = 64 * 1024;
const RECORD_NAME = /^[0-9a-f]{64}$/;
const BYTES_MAGIC = 0x4250434e; // 'NCPB'

// Opaque bytes (#235's encoded presentation previews) with a checksum of
// their own: magic, checksum, length, bytes.
export function wrapStoredBytes(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const out = new Uint8Array(12 + data.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, BYTES_MAGIC, true);
  view.setUint32(4, checksum32(data), true);
  view.setUint32(8, data.byteLength, true);
  out.set(data, 12);
  return out.buffer;
}

export function unwrapStoredBytes(record) {
  if (!record || record.byteLength < 12) return null;
  const view = new DataView(record);
  if (view.getUint32(0, true) !== BYTES_MAGIC || view.getUint32(8, true) !== record.byteLength - 12) return null;
  const data = new Uint8Array(record, 12);
  return checksum32(data) === view.getUint32(4, true) ? data : null;
}

export async function sha256Hex(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The store's budget for this much free space and this setting. `free` is
 * the free space of the volume that holds the records (bytes, or
 * `{ bytes, kind: 'volume' }`: desktop) or the origin's quota left
 * (`{ bytes, kind: 'quota' }`: web), whose usage includes the store's own
 * `storedBytes`.
 */
export function displayProxyStoreBudget(free, limitBytes, floorBytes = DISPLAY_PROXY_STORE_FLOOR_BYTES, storedBytes = 0) {
  const limit = Math.max(0, Number(limitBytes) || 0);
  const { bytes, kind = 'volume' } = free !== null && typeof free === 'object' ? free : { bytes: free };
  if (!Number.isFinite(bytes)) return limit;
  if (kind === 'quota') {
    const left = bytes + Math.max(0, Number(storedBytes) || 0);
    return left < DISPLAY_PROXY_STORE_QUOTA_FLOOR_BYTES ? 0 : Math.min(limit, Math.floor(0.5 * left));
  }
  if (bytes < floorBytes) return 0;
  return Math.min(limit, Math.floor(0.25 * (bytes - floorBytes)));
}

/**
 * The file part of a content key: size, lastModified, SHA-256 of the first
 * MiB plus the size (the project's own hash) and SHA-256 of the last 64
 * KiB, with the decoder and code hashes of the build. `hashHead` is
 * rollProject's hashFileForProject.
 */
export async function displayProxyFileKey(file, { hashHead, decoderHash = 'dev', codeHash = 'dev' }) {
  if (!file || typeof file.slice !== 'function' || !globalThis.crypto?.subtle) return null;
  const head = await hashHead(file);
  if (!head) return null;
  const tailStart = Math.max(0, file.size - DISPLAY_PROXY_TAIL_BYTES);
  const tail = await sha256Hex(new Uint8Array(await file.slice(tailStart, file.size).arrayBuffer()));
  return JSON.stringify(['ncdp-file', 1, file.size, file.lastModified || 0, head, tail, decoderHash, codeHash]);
}

// Records by string key over records named by hash (the spill on the desktop).
export function namedRecords(records, nameOf = key => sha256Hex(String(key))) {
  return {
    write: async (key, record) => records.write(await nameOf(key), record),
    read: async key => records.read(await nameOf(key)),
    delete: async key => records.delete(await nameOf(key)),
    clear: () => records.clear()
  };
}

// Records in the worker's origin-private file system (sync access handles):
// write(name, bytes), read(name), delete(name), clear(), list(). WebKit
// before Safari 17 (15.2-16.x) returns promises from getSize(), truncate(),
// flush() and close(): all four are awaited, which costs nothing where they
// return at once (R2-067: unawaited, every read came back empty, the index
// with it, and each start deleted every record as an orphan). Only a record
// that does not exist reads as null: a size that is no byte count or a short
// read rejects, so an unreadable index is never taken for a lost one.
export function createOpfsRecords(getDirectory = () => globalThis.navigator?.storage?.getDirectory?.()) {
  let folder = null;
  const directory = async () => {
    folder ||= (async () => {
      const root = await getDirectory();
      if (!root) throw new Error('No origin-private file system');
      return root.getDirectoryHandle('display-proxies', { create: true });
    })();
    return folder;
  };
  const fileName = name => `${name}.ncdp`;
  return {
    async write(name, record) {
      const dir = await directory();
      const bytes = record instanceof ArrayBuffer ? new Uint8Array(record) : record;
      const handle = await dir.getFileHandle(fileName(name), { create: true });
      const access = await handle.createSyncAccessHandle();
      try {
        await access.truncate(0);
        if (await access.write(bytes, { at: 0 }) !== bytes.byteLength) throw new Error('Display proxy record not written in full');
        await access.flush();
      } finally {
        await access.close();
      }
      return bytes.byteLength;
    },
    async read(name) {
      const dir = await directory();
      let handle;
      try {
        handle = await dir.getFileHandle(fileName(name));
      } catch (error) {
        if (error?.name === 'NotFoundError') return null;
        throw error;
      }
      const access = await handle.createSyncAccessHandle();
      try {
        const size = await access.getSize();
        if (!Number.isSafeInteger(size) || size < 0) throw new Error('Display proxy record size unreadable');
        const bytes = new Uint8Array(size);
        if (await access.read(bytes, { at: 0 }) !== size) throw new Error('Display proxy record not read in full');
        return bytes.buffer;
      } finally {
        await access.close();
      }
    },
    async delete(name) {
      const dir = await directory();
      try { await dir.removeEntry(fileName(name)); } catch { /* already gone */ }
    },
    async clear() {
      const dir = await directory();
      const names = [];
      for await (const [entry] of dir.entries()) names.push(entry);
      for (const entry of names) { try { await dir.removeEntry(entry); } catch { /* already gone */ } }
    },
    async list() {
      const dir = await directory();
      const entries = [];
      for await (const [entry, handle] of dir.entries()) {
        const name = entry.replace(/\.ncdp$/, '');
        if (!RECORD_NAME.test(name) && name !== 'index') continue;
        const file = await handle.getFile();
        entries.push({ name, bytes: file.size, modifiedMs: file.lastModified });
      }
      return entries;
    }
  };
}

// The fallback where OPFS sync access handles are missing: one IndexedDB
// database of Blobs shared by the origin's tabs.
export function createIndexedDbRecords(indexedDB = globalThis.indexedDB, name = 'negativeconverter-display-proxy-store-v1') {
  if (!indexedDB) return null;
  let opened = null;
  const database = () => {
    opened ||= new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('records');
      request.onerror = () => reject(request.error || new Error('Display proxy store could not open'));
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
    });
    return opened;
  };
  const transact = async (mode, operation) => {
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('records', mode);
      let result;
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error('Display proxy store transaction failed'));
      const request = operation(transaction.objectStore('records'));
      if (request) request.onsuccess = () => { result = request.result; };
    });
  };
  return {
    write: (key, record) => transact('readwrite', store => store.put({ blob: new Blob([record]), modifiedMs: Date.now() }, key)),
    async read(key) {
      const value = await transact('readonly', store => store.get(key));
      return value?.blob ? value.blob.arrayBuffer() : null;
    },
    delete: key => transact('readwrite', store => store.delete(key)),
    clear: () => transact('readwrite', store => store.clear()),
    async list() {
      const entries = [];
      await transact('readonly', store => {
        const request = store.openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          entries.push({ name: String(cursor.key), bytes: cursor.value?.blob?.size || 0, modifiedMs: cursor.value?.modifiedMs || 0 });
          cursor.continue();
        };
        return null;
      });
      return entries;
    }
  };
}

// The worker's records: OPFS where sync access handles exist, else IndexedDB.
export function createWorkerRecords() {
  const opfs = typeof globalThis.FileSystemSyncAccessHandle === 'function' && typeof globalThis.navigator?.storage?.getDirectory === 'function';
  return opfs ? createOpfsRecords() : createIndexedDbRecords();
}

// The worker's records seen from the main thread, through the port.
export function createPortRecords(port) {
  return {
    async write(name, record) { await port.request({ type: 'records-write', name, record }, [record instanceof ArrayBuffer ? record : record.buffer]); },
    async read(name) { return (await port.request({ type: 'records-read', name }))?.record || null; },
    async delete(name) { await port.request({ type: 'records-delete', name }); },
    async clear() { await port.request({ type: 'records-clear' }); },
    async list() { return (await port.request({ type: 'records-list' }))?.entries || []; }
  };
}

// Every tab of the origin opens the same records (OPFS, or the IndexedDB
// fallback), and each keeps its own copy of their index (R2-010). Whatever
// changes the index (a put, has, forget, trim, Clear cache and the first
// load) runs under this Web Lock on the index as the records hold it, with
// the changes of this tab's reads since it last wrote merged in (their last
// uses and purges: successful reads take no lock), and writes it back. No tab writes
// over another tab's entries or deletes its records as orphans, and the
// budget and LRU count every tab's records.
export const DISPLAY_PROXY_STORE_LOCK = 'negativeconverter-display-proxy-store';
// Without Web Locks (Safari before 15.4), where a lock request fails (an
// origin without them) or is not granted within this wait (a tab whose
// operation never ends), the store is read-only for that operation. A
// bounded wait must not become permission to overwrite another tab's index
// or delete records while its writer still holds the lock.
export const DISPLAY_PROXY_LOCK_WAIT_MS = 10_000;

/**
 * The persistent store, main-thread side: the index (content key -> record
 * name, size, last use and what installs it), the budget and LRU eviction.
 * `records` holds the bytes (Rust store, or the worker's OPFS through the
 * port); `port` encodes and decodes records in the worker. With
 * `encodeInWorker`, a put writes from the worker directly (web).
 * `availableBytes()` resolves the free space displayProxyStoreBudget reads
 * (a volume's, or `{ bytes, kind: 'quota' }` on the web). `locks` is
 * navigator.locks (DISPLAY_PROXY_STORE_LOCK, awaited at most `lockWaitMs`).
 */
export function createDisplayProxyStore({
  port, records, availableBytes = async () => null, limitBytes = () => DISPLAY_PROXY_STORE_DEFAULT_LIMIT_BYTES,
  floorBytes = DISPLAY_PROXY_STORE_FLOOR_BYTES, encodeInWorker = false, now = () => Date.now(),
  locks = globalThis.navigator?.locks, lockWaitMs = DISPLAY_PROXY_LOCK_WAIT_MS
} = {}) {
  const index = new Map();
  // What this tab's reads changed since it last wrote the index: a record's
  // last use, or null for a record they purged.
  const changes = new Map();
  let loaded = null;
  let bytes = 0;
  let queue = Promise.resolve();
  let indexDirty = false;
  let budgetCache = { at: -Infinity, value: 0 };
  const stats = { writes: 0, reads: 0, misses: 0, corrupt: 0, failures: 0, refused: 0, evictions: 0 };
  let lockable = typeof locks?.request === 'function';

  // Runs `operation(held)` under the lock, or without it (`held` false) when
  // the request fails, which turns the lock off for good, or is not granted
  // within lockWaitMs.
  async function exclusive(operation) {
    if (!lockable) return operation(false);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), lockWaitMs);
    let granted = false;
    try {
      return await locks.request(DISPLAY_PROXY_STORE_LOCK, { mode: 'exclusive', signal: controller.signal }, () => {
        granted = true;
        clearTimeout(timer);
        return operation(true);
      });
    } catch (error) {
      if (granted) throw error;
      clearTimeout(timer);
      if (!controller.signal.aborted) lockable = false;
      stats.failures++;
      return operation(false);
    }
  }

  function enqueue(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }

  // The index the records hold: empty when there is none or it does not
  // parse (lost: its records are orphans); a rejection when it cannot be
  // read, so nothing is written over it and nothing deleted.
  async function readIndex() {
    const raw = await records.read('index');
    const entries = new Map();
    let parsed = null;
    try { parsed = raw ? JSON.parse(new TextDecoder().decode(raw)) : null; } catch { /* lost */ }
    for (const [name, entry] of parsed?.entries || []) {
      if (RECORD_NAME.test(name) && entry && Number.isFinite(entry.bytes)) entries.set(name, entry);
    }
    return entries;
  }

  // Under the lock: this tab's copy becomes the index the records hold, with
  // its reads' changes merged in (indexDirty when they change it).
  async function sync() {
    const entries = await readIndex();
    indexDirty = false;
    for (const [name, lastUsed] of changes) {
      const entry = entries.get(name);
      if (!entry || (lastUsed !== null && entry.lastUsed >= lastUsed)) continue;
      if (lastUsed === null) entries.delete(name);
      else entry.lastUsed = lastUsed;
      indexDirty = true;
    }
    changes.clear();
    index.clear();
    bytes = 0;
    for (const [name, entry] of entries) {
      index.set(name, entry);
      bytes += entry.bytes;
    }
  }

  async function saveIndex() {
    if (!indexDirty) return;
    indexDirty = false;
    const data = new TextEncoder().encode(JSON.stringify({ version: 1, entries: [...index] }));
    try { await records.write('index', data.buffer); } catch { stats.failures++; }
  }

  // Once per tab, under the lock: entries whose record is gone are dropped
  // and records without an entry deleted (a lost index leaves orphans): no
  // tab is between writing a record and its entry then.
  function load() {
    loaded ||= exclusive(async held => {
      try { await sync(); } catch { stats.failures++; return; }
      if (!held) return;
      try {
        const listed = await records.list();
        const present = new Set(listed.map(entry => entry.name));
        for (const [name, entry] of [...index]) if (!present.has(name)) drop(name, entry);
        for (const entry of listed) {
          if (entry.name === 'index' || index.has(entry.name)) continue;
          await records.delete(entry.name).catch(() => {});
        }
      } catch { stats.failures++; }
      await saveIndex();
    }).catch(() => { stats.failures++; });
    return loaded;
  }

  // A change of the index: under the lock, on the index as the records hold
  // it now (another tab may have added, used or removed records since) and
  // written back when it changed. `fresh` is false when the lock is not
  // held or the index cannot be read: the operation then writes nothing.
  function locked(operation) {
    return enqueue(async () => {
      await load();
      return exclusive(async held => {
        let fresh = held;
        try { await sync(); } catch { fresh = false; stats.failures++; }
        try {
          return await operation(fresh);
        } finally {
          if (fresh) await saveIndex();
          indexDirty = false;
        }
      });
    });
  }

  async function budget() {
    if (now() - budgetCache.at < 10_000) return budgetCache.value;
    const free = await availableBytes().catch(() => null);
    const value = displayProxyStoreBudget(free, limitBytes(), floorBytes, bytes);
    budgetCache = { at: now(), value };
    return value;
  }

  function drop(name, entry) {
    index.delete(name);
    bytes -= entry.bytes;
    indexDirty = true;
  }

  async function evict(target) {
    const byAge = [...index].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [name, entry] of byAge) {
      if (bytes <= target) break;
      drop(name, entry);
      stats.evictions++;
      await records.delete(name).catch(() => { stats.failures++; });
    }
  }

  // A read's changes, merged into the index by the next change of it.
  function touch(name, entry) {
    entry.lastUsed = now();
    changes.set(name, entry.lastUsed);
  }

  // A read's record that cannot be read back: gone, with its entry.
  async function purge(name, entry) {
    drop(name, entry);
    changes.set(name, null);
    await exclusive(async held => {
      if (held) await records.delete(name).catch(() => {});
    });
  }

  return {
    load,
    /**
     * Whether an entry of a file of this size and date exists (no hashing):
     * this tab's copy of the index, as of its last change.
     */
    hasCandidate(file, { kind = null } = {}) {
      if (!file) return false;
      const identity = `${file.size}:${file.lastModified || 0}`;
      for (const entry of index.values()) if (entry.identity === identity && (entry.kind || null) === kind) return true;
      return false;
    },
    /** Entries of `fileKey`, most recently used first. */
    async find(fileKey) {
      await load();
      return [...index].filter(([, entry]) => entry.fileKey === fileKey && !entry.kind)
        .sort((a, b) => b[1].lastUsed - a[1].lastUsed).map(([name, entry]) => ({ name, ...entry }));
    },
    /**
     * Whether the proxy of `fileKey` and `proxyKey` is stored, marking it
     * used as a put of it would (#249, R2-003: a fill finds it before it
     * renders the level again only for put() to find it).
     */
    has(fileKey, proxyKey) {
      return locked(async fresh => {
        for (const entry of index.values()) {
          if (entry.kind || entry.fileKey !== fileKey || entry.proxyKey !== proxyKey) continue;
          if (fresh) { entry.lastUsed = now(); indexDirty = true; }
          return true;
        }
        return false;
      });
    },
    /** Stores a proxy (copies its planes) unless the budget is zero. */
    put(fileKey, proxyKey, { file, image, sample = null, meta = {} }) {
      return locked(async fresh => {
        if (!fresh) return false;
        const limit = await budget();
        const estimate = image.width * image.height * 6 + (sample?.data?.byteLength || 0);
        if (!limit || estimate > limit) { stats.refused++; return false; }
        const key = `${fileKey}\n${proxyKey}`;
        const name = await sha256Hex(key);
        const existing = index.get(name);
        if (existing) {
          existing.lastUsed = now();
          indexDirty = true;
          return true;
        }
        await evict(Math.max(0, limit - estimate));
        const message = {
          type: 'put', key: name, proxyKey: key, meta, sample: sample ? { width: sample.width, height: sample.height, data: sample.data } : null,
          image: { width: image.width, height: image.height, data8: image.data, data16: image.__image16?.data || null },
          target: encodeInWorker ? 'records' : 'record', name
        };
        try {
          const reply = await port.request(message);
          if (!encodeInWorker) await records.write(name, reply.record);
          index.set(name, { fileKey, proxyKey, identity: `${file?.size}:${file?.lastModified || 0}`, meta, bytes: reply.bytes, lastUsed: now() });
          bytes += reply.bytes;
          indexDirty = true;
          stats.writes++;
          return true;
        } catch (error) {
          stats.failures++;
          console.warn('Display proxy store write failed:', error?.message || error);
          return false;
        }
      });
    },
    /**
     * Stores opaque bytes (an encoded presentation preview, #235 slice 3)
     * under `fileKey` and `key`, with a checksum; the proxies' budget and
     * LRU apply. Never a source: only presented.
     */
    putBytes(fileKey, key, data, { file, kind = 'presentation', meta = {} } = {}) {
      return locked(async fresh => {
        if (!fresh) return false;
        const limit = await budget();
        const record = wrapStoredBytes(data);
        if (!limit || record.byteLength > limit) { stats.refused++; return false; }
        const name = await sha256Hex(`${kind}\n${fileKey}\n${key}`);
        const existing = index.get(name);
        if (existing) {
          existing.lastUsed = now();
          indexDirty = true;
          return true;
        }
        await evict(Math.max(0, limit - record.byteLength));
        try {
          await records.write(name, record);
          index.set(name, { fileKey, proxyKey: key, kind, identity: `${file?.size}:${file?.lastModified || 0}`, meta, bytes: record.byteLength, lastUsed: now() });
          bytes += record.byteLength;
          indexDirty = true;
          stats.writes++;
          return true;
        } catch (error) {
          stats.failures++;
          console.warn('Display proxy store write failed:', error?.message || error);
          return false;
        }
      });
    },
    /** The bytes putBytes stored for `fileKey` and `key`, or null. */
    readBytes(fileKey, key, { kind = 'presentation' } = {}) {
      return enqueue(async () => {
        await load();
        const name = await sha256Hex(`${kind}\n${fileKey}\n${key}`);
        const entry = index.get(name);
        if (!entry) return null;
        try {
          const data = unwrapStoredBytes(await records.read(name));
          if (!data) {
            stats.corrupt++;
            await purge(name, entry);
            return null;
          }
          touch(name, entry);
          stats.reads++;
          return data;
        } catch { stats.failures++; return null; }
      });
    },
    /** The stored proxy: { image, sample, meta }, or null (a failed checksum purges it). */
    read(name, { ImageDataCtor = globalThis.ImageData } = {}) {
      return enqueue(async () => {
        await load();
        const entry = index.get(name);
        if (!entry) { stats.misses++; return null; }
        try {
          const record = await records.read(name);
          const reply = record ? await port.request({ type: 'get', record, proxyKey: `${entry.fileKey}\n${entry.proxyKey}` }, [record]) : { miss: true };
          if (!reply || reply.miss) {
            if (reply?.corrupt || record) stats.corrupt++;
            else stats.misses++;
            await purge(name, entry);
            return null;
          }
          touch(name, entry);
          stats.reads++;
          const image = imageOfReply(reply.image, ImageDataCtor);
          return { image, sample: reply.sample || null, meta: reply.meta || entry.meta, proxyKey: entry.proxyKey };
        } catch (error) {
          stats.failures++;
          console.warn('Display proxy store read failed:', error?.message || error);
          return null;
        }
      });
    },
    /** Removes every entry of `fileKey` (a failed self-check). */
    forget(fileKey) {
      return locked(async fresh => {
        if (!fresh) return false;
        for (const [name, entry] of [...index]) {
          if (entry.fileKey !== fileKey) continue;
          drop(name, entry);
          await records.delete(name).catch(() => {});
        }
      });
    },
    /** Removes every record (every tab's: Clear cache). */
    clear() {
      return enqueue(() => exclusive(async held => {
        if (!held) return false;
        index.clear();
        changes.clear();
        bytes = 0;
        indexDirty = false;
        loaded = Promise.resolve();
        budgetCache = { at: -Infinity, value: 0 };
        try { await records.clear(); } catch { stats.failures++; }
      }));
    },
    /** Applies a new limit at once (the setting changed). */
    trim() {
      budgetCache = { at: -Infinity, value: 0 };
      return locked(async fresh => { if (fresh) await evict(await budget()); });
    },
    async budget() { await load(); return budget(); },
    get bytes() { return bytes; },
    get size() { return index.size; },
    get stats() { return { ...stats, bytes, entries: index.size }; },
    /** Resolves once every queued operation has settled and this tab's reads' changes are written. */
    settled() {
      return enqueue(async () => {
        await loaded;
        if (!changes.size) return;
        await exclusive(async held => {
          if (!held) return;
          try { await sync(); } catch { stats.failures++; return; }
          await saveIndex();
        });
      });
    }
  };
}

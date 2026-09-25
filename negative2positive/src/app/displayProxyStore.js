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
  packDisplayPlane, encodeDisplayProxyRecord, decodeDisplayProxyRecord, unpackDisplayPlane
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
export function createDisplayProxyWorkerCore({ backend = null } = {}) {
  let store = backend;
  return {
    get hasBackend() { return Boolean(store); },
    async handle(message) {
      switch (message?.type) {
        case 'put': {
          const { key, proxyKey, meta = {}, image, sample = null, target = 'store' } = message;
          const packed = packDisplayPlane({ width: image.width, height: image.height, data: image.data8, __image16: image.data16 ? { width: image.width, height: image.height, data: image.data16 } : undefined });
          const record = encodeDisplayProxyRecord({ key: proxyKey, meta, plane: packed, sample });
          if (target === 'record' || !store) return { reply: { bytes: record.byteLength, record }, transfer: [record] };
          await store.put(key, record);
          return { reply: { bytes: record.byteLength } };
        }
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
          const transfer = [image.data.buffer];
          if (data16) transfer.push(data16.buffer);
          if (decoded.sample?.data) transfer.push(decoded.sample.data.buffer);
          return {
            reply: { image: { width: image.width, height: image.height, data8: image.data, data16 }, sample: decoded.sample, meta: decoded.meta, key: decoded.key },
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
          const moved = transfer ? [image.data.buffer, image.__image16?.data?.buffer].filter(Boolean) : [];
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
          const { width, height, data8, data16 } = reply.image;
          const image = typeof ImageDataCtor === 'function' ? new ImageDataCtor(data8, width, height) : { width, height, data: data8 };
          if (data16) image.__image16 = { width, height, data: data16 };
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

// Temporary, lossless roll-analysis samples. The RAM budget is independent of
// roll length; evicted samples spill to a private IndexedDB database and remain
// readable for every analysis pass. No settings or original files are stored.
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
export const ANALYSIS_SAMPLE_DATABASE_PREFIX = 'negativeconverter-analysis-samples-v2-';
const lockName = name => `negativeconverter-analysis-database:${name}`;

function sampleBytes(sample) {
  const buffers = new Set([sample?.data?.buffer, sample?.__image16?.data?.buffer, sample?.__analysisReference?.data?.buffer,
    sample?.__tileWorking?.data?.buffer, sample?.__tileWorking?.__image16?.data?.buffer]);
  let bytes = 0;
  for (const buffer of buffers) if (buffer) bytes += buffer.byteLength;
  return bytes;
}

// ImageData's custom __image16 property is not preserved by native structured
// cloning. Store an explicit plain container to retain the attached precision,
// and what the sample's canonical tile needs (#247): the base's size, the
// small analysis reference taken from it and the tile's working image. A
// sample of a small base references the base's planes, which may live in
// shared memory (#264): IndexedDB cannot store a SharedArrayBuffer, so such a
// plane is stored as a copy.
const storable = data => (typeof SharedArrayBuffer === 'function' && data?.buffer instanceof SharedArrayBuffer ? data.slice() : data);
export function serializableSample(sample) {
  const plane = value => ({ width: value.width, height: value.height, data: storable(value.data) });
  const image = value => ({ ...plane(value), ...(value.__image16 ? { __image16: plane(value.__image16) } : {}) });
  return {
    ...image(sample),
    ...(sample.__baseSize ? { __baseSize: { width: sample.__baseSize.width, height: sample.__baseSize.height } } : {}),
    ...(sample.__analysisReference ? { __analysisReference: plane(sample.__analysisReference) } : {}),
    ...(sample.__tileWorking ? { __tileWorking: image(sample.__tileWorking) } : {}),
  };
}

export function createIndexedDbSampleBackend(indexedDB = globalThis.indexedDB, locks = globalThis.navigator?.locks) {
  return createPrivateIndexedDbBackend({
    prefix: ANALYSIS_SAMPLE_DATABASE_PREFIX, lockName, serialize: serializableSample, indexedDB, locks
  });
}

/**
 * A private, per-tab IndexedDB database (#214), reused by the display-proxy
 * spill (#249) under its own prefix: the tab holds a Web Lock on its
 * database for its lifetime, and a database of the prefix whose lock is free
 * belongs to a closed or crashed tab and is deleted. Values pass through
 * `serialize` on put. Null without IndexedDB.databases or Web Locks.
 */
export function createPrivateIndexedDbBackend({
  prefix, lockName, serialize = value => value, indexedDB = globalThis.indexedDB, locks = globalThis.navigator?.locks
}) {
  // Without both APIs a crashed tab's spill cannot be reclaimed safely. The
  // store still provides its bounded RAM cache and lossless decode fallback.
  if (!indexedDB || typeof indexedDB.databases !== 'function' || typeof locks?.request !== 'function') return null;
  const token = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const name = `${prefix}${token}`;
  let databasePromise = null;
  let releaseOwnership = null;
  let ownershipFinished = null;

  function deleteDatabase(target) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(target);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error || new Error('Sample database cleanup failed'));
      request.onblocked = () => reject(new Error('Sample database cleanup is blocked'));
    });
  }

  async function releaseLock() {
    releaseOwnership?.();
    releaseOwnership = null;
    await ownershipFinished?.catch(() => {});
    ownershipFinished = null;
  }

  async function acquireOwnershipAndCleanOrphans() {
    await new Promise((resolve, reject) => {
      ownershipFinished = locks.request(lockName(name), { mode: 'exclusive' }, async () => {
        const lifetime = new Promise(release => { releaseOwnership = release; });
        resolve();
        await lifetime;
      });
      ownershipFinished.catch(reject);
    });
    try {
      for (const entry of await indexedDB.databases()) {
        const orphan = entry.name;
        if (!orphan?.startsWith(prefix) || orphan === name) continue;
        // The versioned prefix is reserved for this lock protocol. A live tab
        // owns the lock before its database exists; tab/process termination
        // releases it automatically, without relying on timestamps or unload.
        await locks.request(lockName(orphan), { mode: 'exclusive', ifAvailable: true }, async lock => {
          if (!lock) return;
          try { await deleteDatabase(orphan); } catch { /* Retry this orphan next session. */ }
        });
      }
    } catch (error) {
      await releaseLock();
      throw error;
    }
  }

  function database() {
    if (!databasePromise) {
      databasePromise = (async () => {
        await acquireOwnershipAndCleanOrphans();
        try {
          return await new Promise((resolve, reject) => {
            const request = indexedDB.open(name, 1);
            request.onupgradeneeded = () => request.result.createObjectStore('samples');
            request.onerror = () => reject(request.error || new Error('Sample database could not open'));
            request.onsuccess = () => {
              const db = request.result;
              db.onversionchange = () => db.close();
              resolve(db);
            };
          });
        } catch (error) {
          await releaseLock();
          throw error;
        }
      })();
    }
    return databasePromise;
  }
  async function transact(mode, operation) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('samples', mode);
      let result;
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error('Sample database transaction failed'));
      try {
        const request = operation(transaction.objectStore('samples'));
        request.onsuccess = () => { result = request.result; };
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    });
  }
  return {
    put: (key, sample) => transact('readwrite', store => store.put(serialize(sample), key)),
    get: key => transact('readonly', store => store.get(key)),
    delete: key => transact('readwrite', store => store.delete(key)),
    async clear() {
      if (!databasePromise) return;
      try { (await databasePromise).close(); } catch { /* An unsuccessful open has no usable connection. */ }
      databasePromise = null;
      try { await deleteDatabase(name); } finally { await releaseLock(); }
    },
  };
}

export function createAnalysisSampleStore({ maxBytes = DEFAULT_MAX_BYTES, backend = createIndexedDbSampleBackend() } = {}) {
  if (!Number.isFinite(maxBytes) || maxBytes < 0) throw new RangeError('Sample store byte budget must be non-negative');
  const memory = new Map();
  const spilled = new Map();
  let bytes = 0;
  let sequence = 0;
  let queue = Promise.resolve();
  let canSpill = Boolean(backend);
  let failedOperations = 0;
  let droppedSamples = 0;
  let spillReads = 0;

  // Callers use parallel import lanes. Serialize ownership changes and wait for
  // each spill before accepting another sample into the bounded RAM cache.
  function enqueue(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }
  async function remove(key) {
    const resident = memory.get(key);
    if (resident) { memory.delete(key); bytes -= resident.bytes; }
    const diskKey = spilled.get(key);
    spilled.delete(key);
    if (diskKey !== undefined) {
      try { await backend.delete(diskKey); } catch { failedOperations++; }
    }
  }
  async function spill(key, sample) {
    if (canSpill) {
      const diskKey = ++sequence;
      try {
        await backend.put(diskKey, sample);
        spilled.set(key, diskKey);
        return true;
      } catch {
        failedOperations++;
        canSpill = false;
      }
    }
    // Private mode/quota failures may prevent persistence. Keep RAM bounded and
    // return a cache miss later so the caller can decode the original again.
    droppedSamples++;
    return false;
  }

  return {
    put(key, sample) {
      return enqueue(async () => {
        await remove(key);
        const size = sampleBytes(sample);
        if (size > maxBytes) return spill(key, sample);
        while (bytes + size > maxBytes && memory.size) {
          const [oldKey, old] = memory.entries().next().value;
          memory.delete(oldKey); bytes -= old.bytes;
          await spill(oldKey, old.sample);
        }
        memory.set(key, { sample, bytes: size }); bytes += size;
        return true;
      });
    },
    get(key) {
      return enqueue(async () => {
        const resident = memory.get(key);
        if (resident) return resident.sample;
        const diskKey = spilled.get(key);
        if (diskKey === undefined) return null;
        try {
          const sample = await backend.get(diskKey);
          if (sample) spillReads++;
          // Do not promote reads back into RAM: later passes and parallel reads
          // must not quietly double the retained sample cache.
          return sample || null;
        } catch { failedOperations++; return null; }
      });
    },
    delete(key) { return enqueue(() => remove(key)); },
    clear() {
      return enqueue(async () => {
        memory.clear(); spilled.clear(); bytes = 0;
        try { await backend?.clear(); } catch { failedOperations++; }
        canSpill = Boolean(backend);
      });
    },
    get bytes() { return bytes; },
    get stats() {
      return { memoryBytes: bytes, memoryEntries: memory.size, spilledEntries: spilled.size, canSpill, failedOperations, droppedSamples, spillReads };
    },
  };
}

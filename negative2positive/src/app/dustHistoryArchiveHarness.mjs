// Test-only IndexedDB transport: clone at put time, resolve only on commit,
// and keep failed transactions atomic. Browser smoke uses real IndexedDB.
export function archiveDatabaseFixture() {
  const records = new Map(), failures = { open: false, write: false, read: false, writeAt: null };
  let writes = 0;
  const db = {
    createObjectStore() {}, close() {},
    transaction(_store, mode) {
      let next, key, removed = false;
      const tx = { error: null, abort() { tx.error = Error('Transaction aborted'); queueMicrotask(() => tx.onabort?.()); } };
      const request = {};
      tx.objectStore = () => ({
        put(value, name) { next = structuredClone(value); key = name; return request; },
        get(name) { key = name; return request; },
        delete(name) { key = name; removed = true; return request; }
      });
      queueMicrotask(() => {
        if (tx.error) return;
        if (mode === 'readwrite') writes++;
        if ((mode === 'readwrite' && (failures.write || writes === failures.writeAt)) || (mode === 'readonly' && failures.read)) {
          tx.error = Error(mode === 'readwrite' ? 'Quota exceeded' : 'Storage read failed'); tx.onabort?.(); return;
        }
        if (mode === 'readonly') request.result = records.has(key) ? structuredClone(records.get(key)) : undefined;
        else if (removed) records.delete(key);
        else records.set(key, next);
        tx.oncomplete?.();
      });
      return tx;
    }
  };
  return { records, failures, indexedDB: { open() {
    const request = {};
    queueMicrotask(() => {
      if (failures.open) { request.error = Error('Storage denied'); request.onerror?.(); }
      else { request.result = db; request.onupgradeneeded?.(); request.onsuccess?.(); }
    });
    return request;
  } } };
}

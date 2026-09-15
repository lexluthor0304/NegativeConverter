import { sanitizeLearnedRecord } from './learnedDefaults.js';
const DB = 'nc_learned_defaults_v1';
let opening;
function open() {
  if (!opening) opening = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('stocks', { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { opening = null; reject(request.error); };
  });
  return opening;
}
async function transaction(mode, action) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('stocks', mode), req = action(tx.objectStore('stocks'));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}
export async function readLearnedDefaults() { return (await transaction('readonly', store => store.getAll())).map(sanitizeLearnedRecord).filter(Boolean); }
export async function writeLearnedDefaults(record) { const safe = sanitizeLearnedRecord(record); if (safe) await transaction('readwrite', store => store.put(safe)); }
export async function resetLearnedDefaults() { await transaction('readwrite', store => store.clear()); }

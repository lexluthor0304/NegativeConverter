// IndexedDB copy of the bundled ONNX models, shared by AI repair (MI-GAN) and
// the semantic colour pass (EfficientViT). The web app downloads a model once
// and keeps it through HTTP-cache eviction and offline sessions. Keys are the
// model URLs, which Vite fingerprints: a replaced model is a new key, and a
// successful write deletes the older keys of the same model family (earlier
// hashes, and the unversioned /models/… key of older builds).

const MODEL_DB = 'nc_ai_models';
const MODEL_STORE = 'models';

function openModelDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    const request = indexedDB.open(MODEL_DB, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(MODEL_STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Whether a cache key holds a version of `family`: the file name of the key is
 * `<family>.onnx` (unversioned) or `<family>-<hash>.onnx` (fingerprinted).
 */
export function isModelFamilyKey(key, family) {
  if (typeof key !== 'string' || !family) return false;
  const name = key.split(/[?#]/)[0].split('/').pop();
  return name === `${family}.onnx` || (name.startsWith(`${family}-`) && name.endsWith('.onnx'));
}

/** The cached bytes (ArrayBuffer, or Blob for models stored as one), or null. */
export async function readCachedModel(key) {
  const db = await openModelDb();
  if (!db) return null;
  try {
    const record = await requestToPromise(db.transaction(MODEL_STORE, 'readonly').objectStore(MODEL_STORE).get(key));
    const bytes = record?.bytes;
    return bytes instanceof ArrayBuffer || (typeof Blob === 'function' && bytes instanceof Blob) ? bytes : null;
  } finally { db.close(); }
}

/**
 * Stores a model under `key`. With a `family`, the same transaction deletes
 * every other key of that family, so an aborted write keeps the old copy.
 */
export async function writeCachedModel(key, bytes, { family = null } = {}) {
  const db = await openModelDb();
  if (!db) return false;
  try {
    const transaction = db.transaction(MODEL_STORE, 'readwrite');
    const store = transaction.objectStore(MODEL_STORE);
    store.put({ bytes, savedAt: Date.now() }, key);
    if (family) {
      const keys = store.getAllKeys();
      keys.onsuccess = () => {
        for (const stale of keys.result) if (stale !== key && isModelFamilyKey(stale, family)) store.delete(stale);
      };
    }
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('model cache write aborted'));
    });
    return true;
  } catch (error) {
    console.warn('AI model cache write failed:', error);
    return false;
  } finally { db.close(); }
}

/** Downloads the model once (IndexedDB afterwards), reporting bytes received. */
export async function fetchModelBytes(url, { onProgress = null, family = null } = {}) {
  const cached = await readCachedModel(url).catch(() => null);
  if (cached) return cached instanceof ArrayBuffer ? cached : cached.arrayBuffer();
  const response = await fetch(url);
  if (!response.ok) throw new Error(`model download failed (${response.status})`);
  const total = Number(response.headers.get('content-length')) || 0;
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = await response.arrayBuffer();
    await writeCachedModel(url, bytes, { family }).catch(() => false);
    return bytes;
  }
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (onProgress) onProgress(received, total);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  await writeCachedModel(url, bytes.buffer, { family }).catch(() => false);
  return bytes.buffer;
}

/**
 * The model as a Blob: posting it to a worker copies nothing on the main
 * thread and keeps the bytes off the JS heap. `cache: false` skips IndexedDB
 * (the desktop app reads its embedded assets locally anyway).
 */
export async function fetchModelBlob(url, { family = null, cache = true } = {}) {
  if (cache) {
    const cached = await readCachedModel(url).catch(() => null);
    if (cached) return cached instanceof ArrayBuffer ? new Blob([cached]) : cached;
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`model download failed (${response.status})`);
  const blob = await response.blob();
  // The analysis need not wait for the IndexedDB copy.
  if (cache) void writeCachedModel(url, blob, { family }).catch(() => false);
  return blob;
}

const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;

// Session snapshots are object/array graphs containing image planes and undo
// history. Walk containers, never the numeric properties of individual pixels.
// ImageData.data is a native getter, not an enumerable own property. A
// geometry frame descriptor (#244) has pixel getters that would build the
// frame; only its recipe (and pixels already built) is walked.
// History uses the same walk to count the bytes it holds exclusively.
// `buffers` lets a caller count several graphs once (#241 resident bytes).
export function backingBuffers(value, buffers = new Set()) {
  const seen = new Set();
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (!current || (typeof current !== 'object' && typeof current !== 'function') || seen.has(current)) continue;
    seen.add(current);
    if (ArrayBuffer.isView(current)) {
      buffers.add(current.buffer);
      continue;
    }
    if (current instanceof ArrayBuffer
      || (typeof SharedArrayBuffer !== 'undefined' && current instanceof SharedArrayBuffer)) {
      buffers.add(current);
      continue;
    }
    // The original File/Blob is already held by the queue. It is not a decoded
    // pixel allocation, and must not consume this cache's retained-plane budget.
    if (typeof Blob !== 'undefined' && current instanceof Blob) continue;
    if (!current.__geometryFrame && ArrayBuffer.isView(current.data)) pending.push(current.data);
    if (current instanceof Map) {
      for (const [key, item] of current) pending.push(key, item);
    } else if (current instanceof Set) {
      for (const item of current) pending.push(item);
    }
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor && 'value' in descriptor) pending.push(descriptor.value);
    }
  }
  return buffers;
}

/**
 * Bounded LRU for inactive photo-session snapshots.
 *
 * put stores the value by reference; take removes it and transfers it back to
 * the active editor. peek is a borrowed, read-only lookup AND marks it recently
 * used. While cached, the caller must not change the graph, mutate/resize its
 * buffers or transfer them to a worker. take first, edit, then put to recalculate
 * ownership. Whole backing buffers count once across all retained snapshots,
 * even when different views/history entries share them.
 *
 * This is a retained ArrayBuffer budget, not total browser memory: it excludes
 * object/string overhead, original File/Blob storage, active snapshots and
 * opaque native resources. Do not use it to own canvases/ImageBitmaps; eviction
 * drops references only and never detaches buffers or closes shared resources.
 * A zero budget disables storage, including entries without pixel buffers.
 *
 * `onEvict(key, value)` (#249) is called for each entry a put pushed out of
 * the budget or a trim let go (#258), once that put or trim is complete,
 * oldest first; never for take, delete, clear or retainKeys. The callback may
 * store a smaller form of the entry again (`putIfRoom(key, value, { oldest:
 * true })`, which never displaces a more recent entry) or keep it elsewhere.
 */
export function createPhotoSessionCache({ maxBytes = DEFAULT_MAX_BYTES, onEvict = null } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('Photo-session maxBytes must be a non-negative safe integer');
  }
  let entries = new Map();
  const owners = new Map();
  let bytes = 0;
  // The entry stored last (the photo the user just left, #258): pressure and
  // idle trimming keep it, so the warm 1-back switch survives them.
  let lastStoredKey;

  function register(key, value, buffers, { oldest = false } = {}) {
    if (oldest) entries = new Map([[key, { value, buffers }], ...entries]);
    else entries.set(key, { value, buffers });
    for (const buffer of buffers) {
      const owner = owners.get(buffer);
      if (owner) owner.count++;
      else {
        const size = buffer.byteLength;
        owners.set(buffer, { count: 1, bytes: size });
        bytes += size;
      }
    }
  }

  // Evicted entries are handed to onEvict after the put that evicted them.
  function notifyEvicted(evicted) {
    if (!onEvict) return;
    for (const [key, value] of evicted) {
      try { onEvict(key, value); } catch (error) { console.warn('Photo-session eviction handler failed:', error); }
    }
  }

  function remove(key) {
    const entry = entries.get(key);
    if (!entry) return null;
    entries.delete(key);
    if (key === lastStoredKey) lastStoredKey = undefined;
    for (const buffer of entry.buffers) {
      const owner = owners.get(buffer);
      owner.count--;
      if (owner.count === 0) {
        owners.delete(buffer);
        bytes -= owner.bytes;
      }
    }
    return entry;
  }

  return {
    put(key, value) {
      // A rejected newer snapshot must not leave an older same-key version
      // available for a later restore. Unrelated entries need not be evicted.
      remove(key);
      if (maxBytes === 0) return false;
      const buffers = backingBuffers(value);
      let ownBytes = 0;
      for (const buffer of buffers) ownBytes += buffer.byteLength;
      if (ownBytes > maxBytes) return false;

      // Register the new owner before eviction: removing the old LRU entry
      // must not release a backing store shared with this newly cached value.
      register(key, value, buffers);
      const evicted = [];
      while (bytes > maxBytes) {
        const oldest = entries.keys().next().value;
        const entry = remove(oldest);
        if (entry) evicted.push([oldest, entry.value]);
      }
      if (entries.has(key)) lastStoredKey = key;
      notifyEvicted(evicted);
      return true;
    },
    // Stores only if it fits next to everything retained, evicting nothing
    // (#243: a background lane's finished base never displaces a photo the
    // user visited). Buffers this cache already holds count once. `oldest`
    // (#249) files it as the least recently used entry: a demoted session
    // is evicted before any photo visited after it.
    putIfRoom(key, value, { oldest = false } = {}) {
      if (maxBytes === 0) return false;
      const previous = entries.get(key);
      const releasing = new Set();
      if (previous) for (const buffer of previous.buffers) if (owners.get(buffer).count === 1) releasing.add(buffer);
      let total = bytes;
      for (const buffer of releasing) total -= owners.get(buffer).bytes;
      const buffers = backingBuffers(value);
      for (const buffer of buffers) {
        if (!owners.has(buffer) || releasing.has(buffer)) total += buffer.byteLength;
      }
      if (total > maxBytes) return false;
      if (!oldest) return this.put(key, value);
      remove(key);
      register(key, value, buffers, { oldest: true });
      return true;
    },
    take(key) { return remove(key)?.value ?? null; },
    peek(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    /** The retained value without marking it recently used (#249). */
    get(key) { return entries.get(key)?.value ?? null; },
    /** Keys from least to most recently used. */
    keys() { return [...entries.keys()]; },
    /** Whether `key` is retained, without marking it recently used. */
    has(key) { return entries.has(key); },
    delete(key) { return remove(key) !== null; },
    clear() {
      entries.clear();
      owners.clear();
      bytes = 0;
      lastStoredKey = undefined;
    },
    retainKeys(keys) {
      const retained = new Set(keys);
      for (const key of entries.keys()) if (!retained.has(key)) remove(key);
    },
    /**
     * Evict least recently used entries until at most `targetBytes` are
     * retained, never one of the keys in `keep` (#258). The entries it lets
     * go reach onEvict like a put's, so a session is demoted to its display
     * form rather than dropped (#249). Returns the bytes this cache let go,
     * net of what onEvict stored again; a buffer another retained entry
     * shares stays.
     */
    trim(targetBytes, { keep = [] } = {}) {
      const target = Math.max(0, Number(targetBytes) || 0);
      const kept = new Set(keep);
      const before = bytes;
      const evicted = [];
      for (const key of [...entries.keys()]) {
        if (bytes <= target) break;
        if (kept.has(key)) continue;
        const entry = remove(key);
        if (entry) evicted.push([key, entry.value]);
      }
      notifyEvicted(evicted);
      return Math.max(0, before - bytes);
    },
    /** The unique backing buffers retained, to count them with other graphs. */
    buffers() { return owners.keys(); },
    get bytes() { return bytes; },
    get size() { return entries.size; },
    /** The key of the entry stored last, while it is still retained. */
    get lastStoredKey() { return lastStoredKey; },
  };
}

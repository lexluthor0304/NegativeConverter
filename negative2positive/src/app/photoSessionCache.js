const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;

// Session snapshots are object/array graphs containing image planes and undo
// history. Walk containers, never the numeric properties of individual pixels.
// ImageData.data is a native getter, not an enumerable own property.
function backingBuffers(value) {
  const buffers = new Set();
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
    if (ArrayBuffer.isView(current.data)) pending.push(current.data);
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
 */
export function createPhotoSessionCache({ maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('Photo-session maxBytes must be a non-negative safe integer');
  }
  const entries = new Map();
  const owners = new Map();
  let bytes = 0;

  function remove(key) {
    const entry = entries.get(key);
    if (!entry) return null;
    entries.delete(key);
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
      entries.set(key, { value, buffers });
      for (const buffer of buffers) {
        const owner = owners.get(buffer);
        if (owner) owner.count++;
        else {
          const size = buffer.byteLength;
          owners.set(buffer, { count: 1, bytes: size });
          bytes += size;
        }
      }
      while (bytes > maxBytes) remove(entries.keys().next().value);
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
    delete(key) { return remove(key) !== null; },
    clear() {
      entries.clear();
      owners.clear();
      bytes = 0;
    },
    retainKeys(keys) {
      const retained = new Set(keys);
      for (const key of entries.keys()) if (!retained.has(key)) remove(key);
    },
    get bytes() { return bytes; },
    get size() { return entries.size; },
  };
}

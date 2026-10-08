import { hasDerivedEightBit, markDerivedEightBit } from './crossOriginIsolation.js';

// Parking must release the full mutable planes dust history patches, while
// retaining their exact bytes and shared identities. These records are undo
// data, never cache entries: no LRU or quota eviction may discard them.
function pack(roots, base, { createGeometryFrame, geometryKeyOf }) {
  const seen = new Map(), nodes = [], buffers = [], bufferIds = new Map();
  function bufferId(buffer) {
    if (!bufferIds.has(buffer)) { bufferIds.set(buffer, buffers.length); buffers.push(buffer); }
    return bufferIds.get(buffer);
  }
  function visit(value) {
    if (typeof value === 'function' || typeof value === 'symbol') throw Error('Unsupported dust history value');
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return { ref: seen.get(value) };
    const ref = nodes.length;
    seen.set(value, ref);
    const node = {};
    nodes.push(node);
    if (value === base) {
      node.kind = 'base';
    } else if (ArrayBuffer.isView(value)) {
      Object.assign(node, { kind: 'view', buffer: bufferId(value.buffer), type: value.constructor.name,
        byteOffset: value.byteOffset, length: value instanceof DataView ? value.byteLength : value.length });
    } else if (value instanceof ArrayBuffer) {
      node.kind = 'buffer'; node.buffer = bufferId(value);
    } else if (value instanceof Map) {
      node.kind = 'map'; node.fields = [...value].map(([key, item]) => [visit(key), visit(item)]);
    } else if (value instanceof Set) {
      node.kind = 'set'; node.fields = [...value].map(visit);
    } else if (value instanceof Date) {
      node.kind = 'date'; node.value = value.getTime();
    } else if (Object.getOwnPropertyDescriptor(value, '__geometryFrame')?.value) {
      if (typeof createGeometryFrame !== 'function') throw Error('Geometry history restoration is unavailable');
      // Never touch a descriptor's pixel getters, even to classify it. The
      // recipe retains the base, key and only pixels already materialized.
      node.kind = 'geometry';
      node.recipe = visit(value.__geometryFrame);
      node.fields = Object.entries(value).filter(([key]) => !['data', '__image16', '__geometryFrame'].includes(key))
        .map(([key, item]) => [key, visit(item)]);
      node.geometryKey = visit(geometryKeyOf?.(value) || null);
    } else {
      const image = value.data instanceof Uint8ClampedArray && Number.isInteger(value.width) && Number.isInteger(value.height);
      node.kind = image ? 'image' : Array.isArray(value) ? 'array' : 'object';
      // ImageData's native fields and a genuine 16-bit plane may be
      // nonenumerable. Store the precision explicitly, never promote it.
      const fields = image ? { ...value, width: value.width, height: value.height, data: value.data } : value;
      if (image) {
        if (value.__image16) fields.__image16 = value.__image16;
        node.image16Enumerable = Object.prototype.propertyIsEnumerable.call(value, '__image16');
        node.derived8 = hasDerivedEightBit(value);
        node.geometryKey = visit(geometryKeyOf?.(value) || null);
      }
      node.fields = Object.entries(fields).map(([key, item]) => [key, visit(item)]);
    }
    return { ref };
  }
  return { record: { version: 1, root: visit(roots), nodes }, buffers };
}

function unpack(record, buffers, base, ImageDataCtor, { createGeometryFrame, restoreGeometryKey }) {
  if (record?.version !== 1 || !Array.isArray(record.nodes)) throw Error('Invalid dust history record');
  const values = new Map();
  function visit(value) {
    if (!value || typeof value !== 'object') return value;
    const node = record.nodes[value.ref];
    if (!node) throw Error('Missing dust history node');
    if (values.has(value.ref)) return values.get(value.ref);
    if (node.kind === 'base' || node.kind === 'buffer' || node.kind === 'view') {
      const types = { Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array, Float32Array, Float64Array, DataView };
      const buffer = buffers[node.buffer];
      if (node.kind !== 'base' && !buffer) throw Error('Missing dust history bytes');
      const result = node.kind === 'base' ? base : node.kind === 'buffer' ? buffer
        : new types[node.type](buffer, node.byteOffset, node.length);
      if (!result) throw Error('Missing retained dust history base');
      values.set(value.ref, result);
      return result;
    }
    if (node.kind === 'date') { const result = new Date(node.value); values.set(value.ref, result); return result; }
    if (node.kind === 'map' || node.kind === 'set') {
      const result = node.kind === 'map' ? new Map() : new Set();
      values.set(value.ref, result);
      for (const item of node.fields) {
        if (node.kind === 'map') result.set(visit(item[0]), visit(item[1]));
        else result.add(visit(item));
      }
      return result;
    }
    if (!['array', 'object', 'image', 'geometry'].includes(node.kind)) throw Error('Invalid dust history node');
    let result = node.kind === 'array' ? [] : {};
    if (node.kind === 'geometry') {
      if (typeof createGeometryFrame !== 'function') throw Error('Geometry history restoration is unavailable');
      const recipe = visit(node.recipe);
      if (!recipe?.base || !recipe.key) throw Error('Invalid parked geometry recipe');
      result = createGeometryFrame(recipe.base, recipe.key, recipe);
    }
    if (node.kind === 'image' && ImageDataCtor) {
      const fields = new Map(node.fields);
      result = new ImageDataCtor(visit(fields.get('data')), fields.get('width'), fields.get('height'));
    }
    values.set(value.ref, result);
    if (!Array.isArray(node.fields)) throw Error('Invalid dust history fields');
    for (const [key, item] of node.fields) {
      if (node.kind === 'image' && ImageDataCtor && ['width', 'height', 'data'].includes(key)) continue;
      Object.defineProperty(result, key, { value: visit(item), enumerable: key !== '__image16' || node.image16Enumerable !== false,
        configurable: true, writable: true });
    }
    if (node.derived8) markDerivedEightBit(result);
    if (node.geometryKey) {
      const key = visit(node.geometryKey);
      if (key) restoreGeometryKey?.(result, key);
    }
    return result;
  }
  return visit(record.root);
}

export function createDustHistoryArchive({ indexedDB = globalThis.indexedDB, ImageDataCtor = globalThis.ImageData,
  chunkBytes = 8 * 1024 * 1024, createGeometryFrame = null, geometryKeyOf = null, restoreGeometryKey = null } = {}) {
  const geometry = { createGeometryFrame, geometryKeyOf, restoreGeometryKey };
  let opened = null;
  function database() {
    if (!indexedDB) return Promise.reject(Error('Dust history storage is unavailable'));
    if (opened) return opened;
    opened = new Promise((resolve, reject) => {
      let failed = false;
      const request = indexedDB.open('nc-dust-history-park-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('history');
      request.onsuccess = () => {
        const db = request.result;
        if (failed) { db.close(); return; }
        db.onversionchange = () => { db.close(); opened = null; };
        db.onclose = () => { opened = null; };
        resolve(db);
      };
      request.onerror = () => { failed = true; opened = null; reject(request.error || Error('Opening dust history storage failed')); };
      request.onblocked = () => { failed = true; opened = null; reject(Error('Dust history storage is blocked')); };
    });
    return opened;
  }
  async function transaction(mode, operation) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('history', mode);
      let request;
      tx.oncomplete = () => resolve(request?.result);
      tx.onabort = tx.onerror = () => reject(tx.error || request?.error || Error('Dust history transaction failed'));
      try { request = operation(tx.objectStore('history')); }
      catch (error) { tx.abort(); reject(error); }
    });
  }
  async function remove(key, record = null) {
    record ||= await transaction('readonly', store => store.get(key));
    for (let i = 0; i < (record?.buffers?.length || 0); i++) {
      for (let n = 0; n < record.buffers[i].chunks; n++) await transaction('readwrite', store => store.delete(`${key}:${i}:${n}`));
    }
    await transaction('readwrite', store => store.delete(key));
  }
  return {
    async save(roots, { base = null } = {}) {
      const { record, buffers } = pack(roots, base, geometry);
      const key = globalThis.crypto.randomUUID?.()
        || Array.from(globalThis.crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16).padStart(8, '0')).join('');
      const size = Math.max(1, Math.floor(chunkBytes));
      record.buffers = buffers.map(buffer => ({ bytes: buffer.byteLength, chunks: Math.ceil(buffer.byteLength / size) }));
      try {
        // A typed-array subview would make structured clone copy its entire
        // backing buffer. Slice each bounded chunk instead; metadata is only
        // published after every chunk's transaction has committed.
        for (let i = 0; i < buffers.length; i++) {
          const bytes = new Uint8Array(buffers[i]);
          for (let n = 0; n < record.buffers[i].chunks; n++) {
            const chunk = bytes.slice(n * size, Math.min(bytes.length, (n + 1) * size));
            await transaction('readwrite', store => store.put(chunk, `${key}:${i}:${n}`));
          }
        }
        await transaction('readwrite', store => store.put(record, key));
        return key;
      } catch (error) {
        await remove(key, record).catch(() => {});
        throw error;
      }
    },
    async load(key, { base = null, onBytes = null } = {}) {
      const record = await transaction('readonly', store => store.get(key));
      if (!record) throw Error('The parked dust history record is missing');
      if (record.version !== 1 || !Array.isArray(record.buffers)) throw Error('Invalid parked dust history record');
      onBytes?.(record.buffers.reduce((sum, buffer) => sum + buffer.bytes, 0));
      const buffers = [];
      for (let i = 0; i < record.buffers.length; i++) {
        const bytes = new Uint8Array(record.buffers[i].bytes);
        let offset = 0;
        for (let n = 0; n < record.buffers[i].chunks; n++) {
          const chunk = await transaction('readonly', store => store.get(`${key}:${i}:${n}`));
          if (!(chunk instanceof Uint8Array) || offset + chunk.length > bytes.length) throw Error('Missing parked dust history chunk');
          bytes.set(chunk, offset); offset += chunk.length;
        }
        if (offset !== bytes.length) throw Error('Incomplete parked dust history plane');
        buffers.push(bytes.buffer);
      }
      return unpack(record, buffers, base, ImageDataCtor, geometry);
    },
    remove
  };
}

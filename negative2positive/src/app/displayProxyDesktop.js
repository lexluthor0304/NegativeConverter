// Display-proxy records on the desktop (#249): the Rust side
// (src-tauri/src/display_proxy_store.rs) keeps them in the app's cache
// directory, so no pixels reach WebKit's origin storage. Records move in
// chunks of the export stream's IPC size; names are 64 hex digits or `index`.

// Must equal CHUNK_LIMIT in src-tauri/src/display_proxy_store.rs.
export const DISPLAY_PROXY_CHUNK_BYTES = 8 * 1024 * 1024;

function bytesOf(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) return Uint8Array.from(data);
  return new Uint8Array(0);
}

/**
 * Records of one scope ('store' across runs, 'spill' for this run) through
 * `invoke` (window.__TAURI__.core.invoke): write(name, bytes), read(name)
 * (null when absent), delete(name), clear(), list() and space().
 */
export function createDesktopProxyRecords(invoke, scope) {
  return {
    async write(name, record) {
      const bytes = bytesOf(record);
      let offset = 0;
      do {
        const end = Math.min(bytes.byteLength, offset + DISPLAY_PROXY_CHUNK_BYTES);
        const chunk = bytes.slice(offset, end);
        await invoke('display_proxy_write', chunk, {
          headers: { 'x-proxy-scope': scope, 'x-proxy-name': name, 'x-proxy-offset': String(offset), 'x-proxy-last': end >= bytes.byteLength ? '1' : '0' }
        });
        offset = end;
      } while (offset < bytes.byteLength);
      return bytes.byteLength;
    },
    async read(name) {
      const parts = [];
      let offset = 0;
      for (;;) {
        const chunk = bytesOf(await invoke('display_proxy_read', { scope, name, offset, length: DISPLAY_PROXY_CHUNK_BYTES }));
        if (chunk.byteLength) parts.push(chunk);
        offset += chunk.byteLength;
        if (chunk.byteLength < DISPLAY_PROXY_CHUNK_BYTES) break;
      }
      if (!offset) return null;
      const record = new Uint8Array(offset);
      let at = 0;
      for (const part of parts) { record.set(part, at); at += part.byteLength; }
      return record.buffer;
    },
    delete: name => invoke('display_proxy_delete', { scope, name }),
    clear: () => invoke('display_proxy_clear', { scope }),
    list: () => invoke('display_proxy_list', { scope }),
    async space() {
      const space = await invoke('display_proxy_space');
      return { freeBytes: space?.freeBytes ?? null, totalBytes: space?.totalBytes ?? null };
    }
  };
}

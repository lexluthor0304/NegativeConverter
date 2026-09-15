export const IMPORT_CHUNK_BYTES = 1024 * 1024;
export async function readDesktopImportFile(arrival, invoke, isCurrent = () => true) {
  if (!Number.isSafeInteger(arrival.size) || arrival.size <= 0 || arrival.size > 1024 * 1024 * 1024) throw new Error('Invalid import size');
  const parts = [];
  for (let offset = 0; offset < arrival.size; offset += IMPORT_CHUNK_BYTES) {
    if (!isCurrent()) throw new Error('Folder watch stopped');
    const data = await invoke('read_import_file', { path: arrival.path, session: arrival.session, offset, expectedSize: arrival.size, modified: arrival.modified });
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
    if (bytes.length !== Math.min(IMPORT_CHUNK_BYTES, arrival.size - offset)) throw new Error('Incomplete import chunk');
    parts.push(bytes);
  }
  if (!isCurrent()) throw new Error('Folder watch stopped');
  return new File(parts, arrival.name, { lastModified: Number(BigInt(arrival.modified) / 1000000n) });
}

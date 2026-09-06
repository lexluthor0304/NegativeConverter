export const EXPORT_CHUNK_BYTES = 1024 * 1024;

// Blob全体のBase64化を避け、確認済みの1チャンクずつネイティブ側へ渡す。
export async function writeDesktopBlob(blob, destination, invoke) {
  const id = await invoke('begin_export_write', { ...destination, expectedBytes: blob.size });
  try {
    for (let offset = 0; offset < blob.size; offset += EXPORT_CHUNK_BYTES) {
      const bytes = new Uint8Array(await blob.slice(offset, offset + EXPORT_CHUNK_BYTES).arrayBuffer());
      await invoke('append_export_chunk', bytes, { headers: { 'x-export-id': id } });
    }
    return await invoke('finish_export_write', { id });
  } catch (error) {
    try { await invoke('abort_export_write', { id }); } catch { /* 元のエラーを保持 */ }
    throw error;
  }
}

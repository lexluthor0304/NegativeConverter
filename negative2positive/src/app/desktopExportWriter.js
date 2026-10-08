// Must equal CHUNK_LIMIT in src-tauri/src/export_stream.rs (the test reads
// it): a larger chunk here fails every desktop export.
export const EXPORT_CHUNK_BYTES = 8 * 1024 * 1024;

function abortError() {
  const err = new Error('Export write cancelled');
  err.name = 'AbortError';
  return err;
}

// Blob全体のBase64化を避け、確認済みの1チャンクずつネイティブ側へ渡す。
// 追記は常に1件だけ実行し（順序はネイティブ側の単純な追記に任せる）、その間に次の
// スライスを読み込んでおく。`onProgress(written, total)` は書き込み済みバイト数を返し、
// `signal` の中断では実行中の追記の完了を待って abort_export_write を呼ぶ
// （一時ファイルとリネームにより既存の保存先は変わらない）。
export async function writeDesktopBlob(blob, destination, invoke, { onProgress = null, signal = null } = {}) {
  if (signal && signal.aborted) throw abortError();
  const total = blob.size;
  const id = await invoke('begin_export_write', { ...destination, expectedBytes: total });
  const readSlice = (offset) => blob.slice(offset, Math.min(total, offset + EXPORT_CHUNK_BYTES)).arrayBuffer();
  let next = total > 0 ? readSlice(0) : null;
  try {
    let written = 0;
    if (onProgress) onProgress(0, total);
    while (next) {
      const bytes = new Uint8Array(await next);
      if (bytes.length !== Math.min(EXPORT_CHUNK_BYTES, total - written)) throw new Error('Incomplete export chunk read');
      const end = written + bytes.length;
      // Read ahead by one: the next slice loads while this chunk is appended.
      next = end < total ? readSlice(end) : null;
      if (signal && signal.aborted) throw abortError();
      await invoke('append_export_chunk', bytes, { headers: { 'x-export-id': id } });
      written = end;
      if (onProgress) onProgress(written, total);
    }
    if (signal && signal.aborted) throw abortError();
    return await invoke('finish_export_write', { id });
  } catch (error) {
    // A read-ahead that is still pending must not surface as unhandled.
    if (next) next.catch(() => {});
    try { await invoke('abort_export_write', { id }); } catch { /* 元のエラーを保持 */ }
    throw error;
  }
}

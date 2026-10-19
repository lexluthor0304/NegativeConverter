// Mobile originals live in the native app's persistent directory, separately
// from the portable .ncroll.json recipe. Only opaque source IDs cross IPC.
// Uploads are sequential binary chunks; checkpoints never race one another.
export const RECOVERY_CHUNK_BYTES = 1024 * 1024;
// Reopening currently reconstructs compressed File objects for the shared
// loaders. Refuse a larger roll before reading it, rather than risk killing
// WebContent. Lazy native file-backed sources are a separate P2 follow-up.
export const RECOVERY_RESTORE_LIMIT = 256 * 1024 * 1024;

const aborted = () => Object.assign(new Error('Recovery operation superseded'), { name: 'AbortError' });
const sourceInfo = file => ({ name: file.name, size: file.size, lastModified: Math.max(0, file.lastModified || 0), mimeType: file.type || '' });

export function createMobileRecovery({ invoke, onStatus = () => {}, FileCtor = globalThis.File, maxRestoreBytes = RECOVERY_RESTORE_LIMIT, uuid = () => globalThis.crypto.randomUUID() } = {}) {
  if (typeof invoke !== 'function') throw new TypeError('Native recovery requires an IPC bridge');
  let opening = null;
  let opened = null;
  let sources = new WeakMap();
  let queueIds = new WeakMap();
  let sequence = 0;
  let clearing = 0;
  let tail = Promise.resolve();
  let status = 'idle';
  const report = (next, error = null) => { status = next; onStatus(next, error); };
  const serial = fn => {
    const operation = tail.then(fn);
    tail = operation.catch(() => {});
    return operation;
  };
  const itemId = file => {
    if (!queueIds.has(file)) queueIds.set(file, uuid());
    return queueIds.get(file);
  };

  async function open() {
    if (!opening) opening = Promise.resolve().then(() => invoke('mobile_recovery_open')).then(record => {
      if (!record || typeof record.session !== 'string' || !Number.isSafeInteger(record.revision)) throw new Error('Invalid native recovery response');
      opened = record;
      return record;
    }).catch(error => { opening = null; throw error; });
    return opening;
  }
  // An IPC error may be an acknowledgement lost after the rename. Reopen
  // before the next mutation to learn the durable revision. Old source IDs
  // cannot be reused: opening also reclaims uncommitted copies.
  function uncertain() { opening = null; opened = null; sources = new WeakMap(); }

  async function preserve(file, isCurrent) {
    if (sources.has(file)) return sources.get(file);
    const session = opened.session;
    const id = await invoke('mobile_recovery_begin', { session, info: sourceInfo(file) });
    try {
      for (let offset = 0; offset < file.size; offset += RECOVERY_CHUNK_BYTES) {
        if (!isCurrent()) throw aborted();
        const length = Math.min(RECOVERY_CHUNK_BYTES, file.size - offset);
        const bytes = new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
        if (bytes.byteLength !== length) throw new Error('Incomplete recovery source read');
        if (!isCurrent()) throw aborted();
        await invoke('mobile_recovery_append', bytes, { headers: {
          'x-recovery-session': session, 'x-source-id': id, 'x-source-offset': String(offset)
        } });
      }
      if (!isCurrent()) throw aborted();
      await invoke('mobile_recovery_finish', { session, id });
      sources.set(file, id);
      return id;
    } catch (error) {
      try { await invoke('mobile_recovery_abort', { session, id }); } catch { /* retain the first error */ }
      throw error;
    }
  }

  return {
    get status() { return status; },
    itemId,
    open,
    dirty() { ++sequence; report('saving'); },
    flush() { return tail; },
    save({ project, items, activeIndex = 0 }) {
      const request = ++sequence;
      const clearEpoch = clearing;
      // Capture identities at the request, not after the asynchronous copy.
      const entries = items.map(item => ({ file: item.file, id: item.id || itemId(item.file) }));
      report('saving');
      return serial(async () => {
        if (request !== sequence) return false;
        try {
          await open();
          const current = () => clearEpoch === clearing;
          const ids = [];
          for (const { file } of entries) {
            if (!current() || request !== sequence) return false;
            ids.push(await preserve(file, current));
          }
          if (!current() || request !== sequence) return false;
          const checkpoint = await invoke('mobile_recovery_commit', {
            session: opened.session, expectedRevision: opened.revision, project,
            sourceIds: ids, queueIds: entries.map(item => item.id),
            activeIndex: entries.length ? Math.max(0, Math.min(entries.length - 1, activeIndex)) : 0
          });
          opened = { ...opened, revision: checkpoint.revision, checkpoint, sources: entries.map(item => sourceInfo(item.file)) };
          // Native GC retains the two committed generations. Keep only the
          // current map so a removed/re-added File is never a stale ID hit.
          sources = new WeakMap(entries.map((item, index) => [item.file, ids[index]]));
          if (request === sequence) report('saved');
          return true;
        } catch (error) {
          if (error?.name === 'AbortError') return false;
          uncertain();
          if (request === sequence) report('error', error);
          throw error;
        }
      });
    },
    clear() {
      const request = ++sequence;
      ++clearing;
      return serial(async () => {
        try {
          await open();
          const checkpoint = await invoke('mobile_recovery_clear', { session: opened.session, expectedRevision: opened.revision });
          opened = { ...opened, revision: checkpoint.revision, checkpoint, sources: [] };
          sources = new WeakMap(); queueIds = new WeakMap();
          if (request === sequence) report('idle');
          return true;
        } catch (error) {
          uncertain(); report('error', error); throw error;
        }
      });
    },
    restore(record) {
      const request = ++sequence;
      return serial(async () => {
        const current = await open();
        const checkpoint = record?.checkpoint;
        if (!checkpoint || !Array.isArray(record.sources) || checkpoint.sourceIds.length !== record.sources.length
            || checkpoint.queueIds.length !== record.sources.length) throw new Error('Invalid recovery record');
        const total = record.sources.reduce((sum, info) => sum + info.size, 0);
        if (!Number.isSafeInteger(total) || total < 0 || total > maxRestoreBytes) {
          throw Object.assign(new Error('This roll exceeds the safe recovery memory limit; its originals are still saved.'), { code: 'restore-too-large' });
        }
        if (record.session !== current.session) throw new Error('The recovery record belongs to an earlier page');
        const files = [];
        for (let i = 0; i < record.sources.length; i++) {
          const info = record.sources[i], id = checkpoint.sourceIds[i];
          if (request !== sequence) throw aborted();
          await invoke('mobile_recovery_verify', { session: current.session, id });
          const parts = [];
          for (let offset = 0; offset < info.size; offset += RECOVERY_CHUNK_BYTES) {
            if (request !== sequence) throw aborted();
            const length = Math.min(RECOVERY_CHUNK_BYTES, info.size - offset);
            const result = await invoke('mobile_recovery_read', { session: current.session, id, offset, length });
            const bytes = result instanceof ArrayBuffer ? new Uint8Array(result) : new Uint8Array(result);
            if (bytes.byteLength !== length) throw new Error('Incomplete recovery original');
            parts.push(new Blob([bytes]));
          }
          const file = new FileCtor(parts, info.name, { type: info.mimeType, lastModified: info.lastModified });
          sources.set(file, id); queueIds.set(file, checkpoint.queueIds[i]);
          files.push(file);
        }
        if (request !== sequence) throw aborted();
        return { files, project: checkpoint.project, activeIndex: checkpoint.activeIndex };
      });
    }
  };
}

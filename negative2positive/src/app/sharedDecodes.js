/**
 * One decode per file for background jobs and the foreground (#243).
 *
 * A background lane opens a lease on a file: that starts the decode, or joins
 * one already running. The foreground (loadFile) only adopts: when a lane is
 * decoding the file the user just opened, or still holds its finished decode
 * while it analyses it, the activation waits for that decode instead of
 * reading and decoding the file a second time.
 *
 * Leases are reference counts:
 *  - the decode is aborted only when every lease has aborted or been released
 *    before it finished, so a superseded foreground activation detaches
 *    without cancelling the lane's decode, and a lane job that gives up leaves
 *    the decode running for a foreground that adopted it;
 *  - the entry, and with it the adoptable base, lives until the last lease is
 *    released (the owning job releases once it no longer needs the base), not
 *    merely until the decode settles.
 *
 * The decoded base is shared read-only: nothing may mutate or transfer it
 * while a lease holds it (the host lists `bases()` among the buffers an export
 * never transfers). `decode(file, { signal })` must resolve
 * `{ base, rawMetadata }` from the same options every consumer would use.
 *
 * Pure: no DOM, no workers.
 */

function abortError(signal) {
  const reason = signal?.reason;
  return reason?.name === 'AbortError' ? reason : new DOMException('Shared decode was released', 'AbortError');
}

export function createSharedDecodes({ decode }) {
  if (typeof decode !== 'function') throw new TypeError('createSharedDecodes needs a decode function');
  const entries = new Map();

  function active(entry) {
    for (const lease of entry.leases) if (lease.state !== 'done') return true;
    return false;
  }

  function drop(entry) {
    if (entries.get(entry.file) === entry) entries.delete(entry.file);
  }

  // A lease finished (released, aborted or failed): stop the decode nobody
  // waits for, and forget an entry nobody holds.
  function reconsider(entry) {
    if (active(entry)) return;
    drop(entry);
    if (!entry.settled && !entry.controller.signal.aborted) {
      entry.controller.abort(new DOMException('Shared decode was released', 'AbortError'));
    }
  }

  function createLease(entry, signal, role) {
    const lease = { file: entry.file, role, state: 'waiting', entry };
    let resolveResult, rejectResult;
    lease.result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    // Nobody is obliged to await it (a released lease, a detached adopter).
    lease.result.catch(() => {});
    const onAbort = () => {
      if (lease.state !== 'waiting') return;
      lease.state = 'done';
      entry.leases.delete(lease);
      rejectResult(abortError(signal));
      reconsider(entry);
    };
    lease.deliver = () => {
      if (lease.state !== 'waiting') return;
      signal?.removeEventListener?.('abort', onAbort);
      if (entry.error) {
        lease.state = 'done';
        entry.leases.delete(lease);
        rejectResult(entry.error);
        return;
      }
      lease.state = 'holding';
      resolveResult(entry.value);
    };
    lease.release = () => {
      if (lease.state === 'done') return;
      signal?.removeEventListener?.('abort', onAbort);
      const wasWaiting = lease.state === 'waiting';
      lease.state = 'done';
      entry.leases.delete(lease);
      if (wasWaiting) rejectResult(new DOMException('Shared decode lease was released', 'AbortError'));
      reconsider(entry);
    };
    entry.leases.add(lease);
    if (signal?.aborted) { onAbort(); return lease; }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (entry.settled) queueMicrotask(lease.deliver);
    return lease;
  }

  function start(file) {
    const entry = { file, controller: new AbortController(), leases: new Set(), settled: false, value: null, error: null };
    entries.set(file, entry);
    let running;
    try {
      running = Promise.resolve(decode(file, { signal: entry.controller.signal }));
    } catch (error) {
      running = Promise.reject(error);
    }
    entry.promise = running.then((value) => {
      entry.settled = true;
      entry.value = value;
    }, (error) => {
      entry.settled = true;
      entry.error = error || new Error('Shared decode failed');
      // A failed decode is never adopted later: the next open starts afresh.
      drop(entry);
    }).then(() => {
      for (const lease of [...entry.leases]) lease.deliver();
      if (!entry.error) reconsider(entry);
    });
    return entry;
  }

  return {
    /** A background job's lease: starts the decode, or joins the one running. */
    open(file, { signal = null } = {}) {
      const entry = entries.get(file) || start(file);
      return createLease(entry, signal, 'lane');
    },
    /** The foreground's lease on a decode a lane started, or null. */
    adopt(file, { signal = null } = {}) {
      const entry = entries.get(file);
      if (!entry || entry.error) return null;
      return createLease(entry, signal, 'foreground');
    },
    has: (file) => entries.has(file),
    inFlight: (file) => Boolean(entries.get(file) && !entries.get(file).settled),
    /** Finished bases still held by a lease (read-only while listed). */
    *bases() {
      for (const entry of entries.values()) if (entry.settled && entry.value?.base) yield entry.value.base;
    },
    files: () => [...entries.keys()],
    get size() { return entries.size; }
  };
}

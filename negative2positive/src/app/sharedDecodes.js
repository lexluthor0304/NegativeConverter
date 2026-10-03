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
 * never transfers). `decode(file, { signal, context, planes })` must resolve
 * `{ base, rawMetadata }` from the same options every consumer would use;
 * `context` is what the lease that started the decode passed to `open()`
 * (its memory claim, #258).
 *
 * A roll-analysis decode (#252) may keep its planes in its lane's worker: it
 * resolves `{ base: null, held, rawMetadata }`, where `held.takePlanes()`
 * brings the base to the page and `held.release()` drops it there. A lane
 * opens such a decode with its own `decode` function. When the foreground
 * adopts it, `planes.wanted` turns true (and `planes.onWanted` callbacks
 * run) so the decode can return the planes early, and the foreground's lease
 * resolves only once the base is on the page. A held frame nobody adopted is
 * released with the entry. `adoptable: false` keeps the foreground away from
 * a decode it cannot use.
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

  function wantPlanes(entry) {
    if (entry.planesWanted) return;
    entry.planesWanted = true;
    for (const listener of [...entry.planeListeners]) {
      try { listener(); } catch {}
    }
    entry.planeListeners.clear();
  }

  // A held frame's base, fetched once for every lease that needs it. A worker
  // that lost the frame is answered with a decode of the file (the shared
  // decode function, today's options), so an adopter never fails for it.
  async function takeHeldBase(entry, lease) {
    const held = entry.value?.held;
    if (!held) return entry.value;
    // Share the worker transfer, but a failed transfer's replacement decode
    // belongs to the adopter: its claim, CPU priority and cancellation.
    entry.taking ||= Promise.resolve().then(() => held.takePlanes()).then((base) => {
      if (!base) throw new Error('The held frame came back empty');
      entry.value = { ...entry.value, base, held: null };
      return entry.value;
    });
    try {
      return await entry.taking;
    } catch {
      const signal = lease.controller.signal;
      if (signal.aborted) throw abortError(signal);
      const value = await decode(entry.file, { signal, context: lease.context });
      if (signal.aborted) throw abortError(signal);
      entry.value = { ...value, held: null };
      return entry.value;
    }
  }

  // A lease finished (released, aborted or failed): stop the decode nobody
  // waits for, and forget an entry nobody holds.
  function reconsider(entry) {
    if (active(entry)) return;
    drop(entry);
    if (!entry.settled && !entry.controller.signal.aborted) {
      entry.controller.abort(new DOMException('Shared decode was released', 'AbortError'));
    }
    // Nobody took the held planes: drop them in the worker.
    if (entry.settled && entry.value?.held) entry.value.held.release?.();
  }

  function createLease(entry, signal, role, context = null) {
    const lease = { file: entry.file, role, context, state: 'waiting', entry, controller: new AbortController() };
    let resolveResult, rejectResult;
    lease.result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    // Nobody is obliged to await it (a released lease, a detached adopter).
    lease.result.catch(() => {});
    const finish = (error) => {
      if (lease.state === 'done') return;
      signal?.removeEventListener?.('abort', onAbort);
      const pending = lease.state === 'waiting' || lease.state === 'taking';
      lease.state = 'done';
      entry.leases.delete(lease);
      lease.controller.abort(error);
      if (pending) rejectResult(error);
      reconsider(entry);
    };
    const onAbort = () => finish(abortError(signal));
    const deliverValue = (value) => {
      if (lease.state === 'done') return;
      lease.state = 'holding';
      resolveResult(value);
    };
    lease.deliver = () => {
      if (lease.state !== 'waiting') return;
      if (entry.error) { finish(entry.error); return; }
      // Keep the abort listener until release, including the worker transfer
      // and any fallback. A settled lane result is not a settled adoption.
      if (role === 'foreground' && !entry.value?.base && entry.value?.held) {
        lease.state = 'taking';
        takeHeldBase(entry, lease).then(deliverValue, finish);
        return;
      }
      deliverValue(entry.value);
    };
    lease.release = () => finish(new DOMException('Shared decode lease was released', 'AbortError'));
    entry.leases.add(lease);
    if (signal?.aborted) { onAbort(); return lease; }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (entry.settled) queueMicrotask(lease.deliver);
    return lease;
  }

  function start(file, context, decodeFile = decode, adoptable = true) {
    const entry = {
      file, controller: new AbortController(), leases: new Set(), settled: false, value: null, error: null,
      planesWanted: false, planeListeners: new Set(), taking: null, adoptable
    };
    entries.set(file, entry);
    const planes = {
      get wanted() { return entry.planesWanted; },
      onWanted(listener) {
        if (entry.planesWanted) { listener(); return; }
        entry.planeListeners.add(listener);
      }
    };
    let running;
    try {
      running = Promise.resolve(decodeFile(file, { signal: entry.controller.signal, context, planes }));
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
    /**
     * A background job's lease: starts the decode (with `decode` when given,
     * else the shared one), or joins the one running. `context` reaches the
     * decode (its memory claim, #258).
     */
    open(file, { signal = null, context = null, decode: decodeFile = null, adoptable = true } = {}) {
      const entry = entries.get(file) || start(file, context, decodeFile || decode, adoptable);
      return createLease(entry, signal, 'lane', context);
    },
    /** The foreground's lease; context covers a failed held-frame transfer's fallback. */
    adopt(file, { signal = null, context = null } = {}) {
      const entry = entries.get(file);
      // A decode the foreground cannot use (a flagged half-size analysis
      // decode, #252 part 6) is never adopted.
      if (!entry || entry.error || !entry.adoptable) return null;
      // A finished decode whose frame is neither on the page nor held is gone.
      if (entry.settled && !entry.value?.base && !entry.value?.held) return null;
      wantPlanes(entry);
      return createLease(entry, signal, 'foreground', context);
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

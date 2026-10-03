import { markDerivedEightBit } from './crossOriginIsolation.js';
function createScanDecodeWorker() {
  return new Worker(new URL('../workers/scanDecodeWorker.js', import.meta.url), { type: 'module' });
}
const defaultWorkerFactory = typeof Worker === 'function' ? createScanDecodeWorker : null;

function abortError(signal) {
  const reason = signal?.reason;
  return reason?.name === 'AbortError' ? reason : new DOMException('Scan decode was aborted', 'AbortError');
}

// Each scan decode owns its worker, so inflate/UTIF heaps are released as soon
// as the transferred pixel planes arrive. There is no full-resolution clone.
// `signal` (#243): an abort before the input is dispatched keeps it with the
// caller; after that the worker is terminated. Either way the call rejects
// with an AbortError (never null, which would start a main-thread decode).
export async function decodeScanInWorker(buffer, format, {
  workerFactory = defaultWorkerFactory,
  timeoutMs = 120000,
  signal = null,
  // The 16-bit plane in shared memory where the page is isolated (#264).
  sharedPlanes = false
} = {}) {
  if (signal?.aborted) throw abortError(signal);
  if (!workerFactory) return null;
  let worker;
  try { worker = workerFactory(); } catch { return null; }
  return new Promise((resolve, reject) => {
    let finished = false;
    let dispatched = false;
    const onAbort = () => finish(abortError(signal));
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      worker.terminate();
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Scan decode timed out')), timeoutMs);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    worker.onerror = () => {
      // Module workers can fail asynchronously during startup (CSP, browser
      // support, unavailable chunk). Keep input ownership until ready so the
      // existing decoder can still handle these environments.
      if (!dispatched) finish(null, null);
      else finish(new Error('Scan decoder worker failed'));
    };
    worker.onmessageerror = () => finish(new Error('Scan decoder returned unreadable pixels'));
    worker.onmessage = ({ data }) => {
      if (data.ready && !dispatched) {
        dispatched = true;
        try { worker.postMessage({ buffer, format, sharedPlanes }, [buffer]); }
        catch (error) {
          if (buffer.byteLength) finish(null, null);
          else finish(error);
        }
        return;
      }
      if (data.ready) return;
      if (data.error) return finish(Object.assign(new Error(data.error), { code: data.code }));
      try {
        const result = new ImageData(data.data, data.width, data.height);
        if (data.image16) {
          result.__image16 = data.image16;
          // A 16-bit TIFF or PNG: the 8-bit plane is the 16-bit one >>> 8.
          markDerivedEightBit(result);
        }
        finish(null, result);
      } catch (error) { finish(error); }
    };
  });
}

/**
 * Decode an extracted HE NEF preview JPEG in the scan-decode worker.
 *
 * Resolves `ImageData` with `__image16` (the ×257 mirror built in the worker),
 * or null so the caller runs today's main-thread decoder. Without the worker's
 * image capability it resolves null BEFORE anything is transferred, so the
 * stashed bytes are never detached ahead of that fallback. A decode error hands
 * the bytes back into `extracted.jpegBytes`.
 */
export async function decodeJpegInWorker(extracted, {
  workerFactory = defaultWorkerFactory,
  timeoutMs = 60000,
  signal = null
} = {}) {
  if (signal?.aborted) throw abortError(signal);
  const input = extracted?.jpegBytes;
  if (!workerFactory || !input || input.byteLength < 4) return null;
  let worker;
  try { worker = workerFactory(); } catch { return null; }
  return new Promise((resolve, reject) => {
    let finished = false;
    let dispatched = false;
    const onAbort = () => finish(null, abortError(signal));
    const finish = (result, error = null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      worker.terminate();
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    worker.onerror = () => finish(null);
    worker.onmessageerror = () => finish(null);
    worker.onmessage = ({ data }) => {
      if (data?.ready) {
        if (dispatched) return;
        if (!data.canDecodeImages) return finish(null);
        dispatched = true;
        // Transfer only a buffer that holds exactly the JPEG: a view into a
        // larger container is copied so the container stays intact.
        const bytes = input.byteOffset === 0 && input.byteLength === input.buffer.byteLength ? input : input.slice();
        try { worker.postMessage({ type: 'jpeg', id: 1, bytes: bytes.buffer }, [bytes.buffer]); }
        catch { finish(null); }
        return;
      }
      if (data?.id !== 1) return;
      if (data.error) {
        if (data.bytes instanceof ArrayBuffer && data.bytes.byteLength) extracted.jpegBytes = new Uint8Array(data.bytes);
        return finish(null);
      }
      try {
        const result = new ImageData(new Uint8ClampedArray(data.data), data.width, data.height);
        result.__image16 = { width: data.width, height: data.height, data: new Uint16Array(data.image16) };
        finish(result);
      } catch { finish(null); }
    };
  });
}

/**
 * Pool of scan-decode workers for embedded RAW preview jobs (viewer frames and
 * filmstrip tiles).
 *
 * - At most `maxWorkers` (2) workers and `maxInFlight` (4) jobs, so slice
 *   reads overlap decodes. Lower `priority` runs first; ties keep FIFO order.
 * - `setKeepWarm(true)` keeps one worker alive while idle, so a cold switch
 *   does not pay a module-worker start; otherwise idle workers terminate.
 *   `clear()` terminates everything and resolves pending jobs with null.
 * - The first ready message decides the capability. Without it, viewer jobs
 *   resolve null (no provisional frame) and tile jobs run through
 *   `mainThreadRender` one per animation frame.
 * - Results are `{ bitmap | dataUrl, width, height, located, preview,
 *   bytesRead }`, `{ empty: true, ... }` (no usable preview) or null.
 */
export function createEmbeddedPreviewPool({
  workerFactory = defaultWorkerFactory,
  maxWorkers = 2,
  maxInFlight = 4,
  timeoutMs = 20000,
  idleMs = 2000,
  mainThreadRender = null,
  requestFrame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : fn => setTimeout(fn, 16),
  onResult = null,
} = {}) {
  const queue = [];
  const workers = [];
  const located = new WeakMap();
  let capability = workerFactory ? null : false;
  let keepWarm = false;
  let seq = 0;
  let idleTimer = null;
  let fallbackScheduled = false;

  const inFlight = () => workers.reduce((sum, w) => sum + w.jobs.size, 0);
  const settle = (entry, result) => {
    if (entry.settled) { result?.bitmap?.close?.(); return; }
    entry.settled = true;
    entry.signal?.removeEventListener?.('abort', entry.onAbort);
    if (entry.signal?.aborted) { result?.bitmap?.close?.(); entry.resolve(null); return; }
    if (result && !result.empty && result.located && entry.job.file) located.set(entry.job.file, result.located);
    if (result && result.located === null && entry.job.file) located.set(entry.job.file, null);
    try { onResult?.(entry.job, result); } catch { /* instrumentation only */ }
    entry.resolve(result);
  };

  function retire(w, { failJobs = true } = {}) {
    const index = workers.indexOf(w);
    if (index >= 0) workers.splice(index, 1);
    clearTimeout(w.startTimer);
    w.worker.onmessage = w.worker.onerror = w.worker.onmessageerror = null;
    try { w.worker.terminate(); } catch { /* already gone */ }
    for (const [id, entry] of w.jobs) {
      clearTimeout(entry.timer);
      w.jobs.delete(id);
      if (failJobs) settle(entry, null);
    }
  }

  function markIncapable() {
    capability = false;
    for (const w of workers.slice()) {
      // Jobs posted before the handshake cannot exist: nothing is dispatched
      // until a worker reports ready with the capability.
      retire(w);
    }
    pump();
  }

  function spawn() {
    let worker;
    try { worker = workerFactory(); } catch { markIncapable(); return null; }
    const w = { worker, ready: false, jobs: new Map() };
    workers.push(w);
    w.startTimer = setTimeout(() => { if (!w.ready) { retire(w); if (!workers.some(x => x.ready)) markIncapable(); } }, timeoutMs);
    worker.onmessage = ({ data }) => {
      if (data?.ready) {
        if (w.ready) return;
        clearTimeout(w.startTimer);
        if (!data.canDecodeImages) { markIncapable(); return; }
        w.ready = true;
        capability = true;
        pump();
        return;
      }
      const entry = w.jobs.get(data?.id);
      if (!entry) { data?.bitmap?.close?.(); return; }
      w.jobs.delete(data.id);
      clearTimeout(entry.timer);
      settle(entry, data.error ? null : data);
      pump();
    };
    worker.onerror = () => {
      const wasReady = w.ready;
      retire(w);
      if (!wasReady && !workers.some(x => x.ready) && capability !== true) markIncapable();
      else pump();
    };
    worker.onmessageerror = () => { retire(w); pump(); };
    return w;
  }

  function scheduleIdle() {
    clearTimeout(idleTimer);
    idleTimer = null;
    if (queue.length || inFlight()) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (queue.length || inFlight()) return;
      const keep = keepWarm && capability !== false ? 1 : 0;
      for (const w of workers.slice(keep)) retire(w, { failJobs: false });
    }, idleMs);
  }

  function runFallback() {
    if (fallbackScheduled || !queue.length) return;
    fallbackScheduled = true;
    requestFrame(async () => {
      fallbackScheduled = false;
      const entry = queue.shift();
      if (!entry) return;
      if (entry.job.purpose !== 'tile' || !mainThreadRender || entry.signal?.aborted) settle(entry, null);
      else {
        try { settle(entry, await mainThreadRender({ ...entry.job, located: entry.job.located ?? located.get(entry.job.file) })); }
        catch { settle(entry, null); }
      }
      runFallback();
    });
  }

  function pump() {
    if (capability === false) {
      // Viewer frames are skipped outright; tiles decode one per frame.
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].job.purpose !== 'tile' || !mainThreadRender) settle(queue.splice(i, 1)[0], null);
      }
      runFallback();
      return;
    }
    const perWorker = Math.max(1, Math.ceil(maxInFlight / maxWorkers));
    while (queue.length && inFlight() < maxInFlight) {
      const ready = workers.filter(w => w.ready && w.jobs.size < perWorker).sort((a, b) => a.jobs.size - b.jobs.size)[0];
      if (!ready || ready.jobs.size) {
        if (workers.length < maxWorkers && workers.every(w => w.ready)) spawn();
        // A failed spawn retires every worker and drains the queue itself.
        if (!ready || capability === false) break;
      }
      const entry = queue.shift();
      if (entry.signal?.aborted) { settle(entry, null); continue; }
      const id = ++seq;
      const cached = entry.job.located ?? located.get(entry.job.file);
      const message = { ...entry.job, type: 'embedded-preview', id, located: cached || null };
      entry.timer = setTimeout(() => { retire(ready); pump(); }, timeoutMs);
      ready.jobs.set(id, entry);
      try { ready.worker.postMessage(message); }
      catch { ready.jobs.delete(id); clearTimeout(entry.timer); settle(entry, null); }
    }
    scheduleIdle();
  }

  function request(job, { priority = 1, signal = null } = {}) {
    if (signal?.aborted) return Promise.resolve(null);
    if (job?.file && located.has(job.file) && located.get(job.file) === null) {
      return Promise.resolve({ empty: true, located: null, bytesRead: 0 });
    }
    return new Promise(resolve => {
      const entry = { job, priority, order: ++seq, resolve, signal, settled: false };
      if (signal) {
        entry.onAbort = () => {
          const index = queue.indexOf(entry);
          if (index >= 0) queue.splice(index, 1);
          settle(entry, null);
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      let index = queue.findIndex(other => other.priority > priority);
      if (index < 0) index = queue.length;
      queue.splice(index, 0, entry);
      if (capability !== false && !workers.length) spawn();
      pump();
    });
  }

  return {
    request,
    // Move queued jobs (e.g. rows that scrolled into view) ahead of others.
    reprioritize(priorityOf) {
      for (const entry of queue) entry.priority = priorityOf(entry.job, entry.priority);
      queue.sort((a, b) => a.priority - b.priority || a.order - b.order);
    },
    cancel(predicate) {
      for (let i = queue.length - 1; i >= 0; i--) {
        if (predicate(queue[i].job)) settle(queue.splice(i, 1)[0], null);
      }
    },
    setKeepWarm(flag) {
      keepWarm = Boolean(flag);
      if (keepWarm && capability !== false && !workers.length) spawn();
      scheduleIdle();
    },
    clear() {
      clearTimeout(idleTimer);
      idleTimer = null;
      keepWarm = false;
      for (const entry of queue.splice(0)) settle(entry, null);
      for (const w of workers.slice()) retire(w);
    },
    get capability() { return capability; },
    stats: () => ({ workers: workers.length, ready: workers.filter(w => w.ready).length, inFlight: inFlight(), queued: queue.length }),
  };
}

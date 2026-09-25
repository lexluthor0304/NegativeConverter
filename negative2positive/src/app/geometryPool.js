// Geometry worker pool (#244 stage 2). The output window of a geometry plan is
// split into row bands; each band's source rectangle is copied row by row on
// the main thread (a short task per band) and rendered by a worker with the
// same row-range core the synchronous path runs. Only copies are posted, so
// the base, which sessions, history and analysis samples share, is never
// transferred or detached.
import {
  planGeometryBands, sliceGeometrySource, renderGeometryRows, wrapGeometryOutput
} from './imageGeometry.js';
import { displayLevelFactor, displayLevelRows, adoptDisplayLevel } from './displayPreview.js';

// Below this many output pixels a band is not worth a worker round trip.
const MIN_BAND_PIXELS = 1_000_000;
// Without workers each band is one main-thread task: keep them short.
const SYNC_BAND_PIXELS = 1_000_000;

export function defaultGeometryPoolSize(hardwareConcurrency = globalThis.navigator?.hardwareConcurrency) {
  const cores = Number(hardwareConcurrency) || 4;
  return Math.max(1, Math.min(6, cores - 2));
}

// Four to six bands for full-resolution outputs, fewer for small ones.
export function geometryBandCount(plan, poolSize = defaultGeometryPoolSize()) {
  const bySize = Math.max(1, Math.floor((plan.outWidth * plan.outHeight) / MIN_BAND_PIXELS));
  const target = Math.max(4, Math.min(6, poolSize));
  return Math.max(1, Math.min(plan.outHeight, bySize, target));
}

// A macrotask boundary that is not throttled like chained timers in hidden
// windows, so input and paint can run between band slices.
export function yieldToEventLoop() {
  if (typeof MessageChannel !== 'function') return new Promise(resolve => setTimeout(resolve, 0));
  return new Promise(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(0);
  });
}

// The display level rows of a rendered band (#248), when the band starts on
// a multiple of k.
function bandLevelRows(plan, band, part, k) {
  const image = { width: plan.outWidth, height: band.y1 - band.y0, data: part.data8,
    __image16: part.data16 ? { data: part.data16 } : undefined };
  return displayLevelRows(image, k, Math.floor(plan.outWidth / k));
}

// The worker side: one band of one plan, and with `levelFactor` > 1 its rows
// of the display level (#248).
export function runGeometryBand(message) {
  const { id, plan, y0, y1, src, levelFactor = 1 } = message;
  const length = (y1 - y0) * plan.outWidth * 4;
  const data8 = new Uint8ClampedArray(length);
  const data16 = plan.has16 ? new Uint16Array(length) : null;
  renderGeometryRows(plan, src, { data8, data16 }, y0, y1);
  const transfers = [data8.buffer];
  if (data16) transfers.push(data16.buffer);
  const payload = { id, data8, data16 };
  if (levelFactor > 1) {
    payload.level16 = bandLevelRows(plan, { y0, y1 }, { data8, data16 }, levelFactor);
    transfers.push(payload.level16.buffer);
  }
  return { payload, transfers };
}

function renderBandHere(source, plan, band) {
  const length = (band.y1 - band.y0) * plan.outWidth * 4;
  const data8 = new Uint8ClampedArray(length);
  const data16 = plan.has16 ? new Uint16Array(length) : null;
  renderGeometryRows(plan, {
    x: 0, y: 0, width: plan.baseWidth, height: plan.baseHeight,
    data8: source.data, data16: plan.has16 ? source.__image16.data : null
  }, { data8, data16 }, band.y0, band.y1);
  return { data8, data16 };
}

export function createGeometryPool({
  workerFactory = () => new Worker(new URL('../workers/geometryWorker.js', import.meta.url), { type: 'module' }),
  workersSupported = typeof Worker === 'function',
  size = defaultGeometryPoolSize(),
  maxBandsInFlight = null,
  timeoutMs = 120000,
  idleTimeoutMs = 30000,
  yieldTask = yieldToEventLoop,
  onError = error => console.warn('Geometry workers unavailable, using the synchronous path:', error)
} = {}) {
  const poolSize = Math.max(1, Math.floor(size) || 1);
  const workers = [];
  const waiters = [];
  let sequence = 0;
  let broken = !workersSupported;
  let idleTimer = null;
  const counters = { jobs: 0, rotations: 0, copies: 0, workerBands: 0, syncBands: 0, fallbacks: 0 };

  function scheduleIdle() {
    clearTimeout(idleTimer);
    if (workers.some(entry => entry.busy) || waiters.length) return;
    idleTimer = setTimeout(() => {
      for (const entry of workers.slice()) if (!entry.busy) terminate(entry, new Error('Geometry worker idle'));
    }, idleTimeoutMs);
    idleTimer.unref?.();
  }

  function terminate(entry, error) {
    const index = workers.indexOf(entry);
    if (index >= 0) workers.splice(index, 1);
    entry.worker.onmessage = entry.worker.onerror = entry.worker.onmessageerror = null;
    try { entry.worker.terminate(); } catch { /* already stopped */ }
    const pending = entry.pending;
    entry.pending = null;
    entry.busy = false;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  // Any failure moves this pool to the synchronous path for good: the bands
  // still waiting render on this thread with the same core.
  function fail(entry, error) {
    if (!broken) {
      broken = true;
      counters.fallbacks++;
      onError?.(error);
    }
    terminate(entry, error);
    while (waiters.length) waiters.shift()(null);
  }

  // Hands a worker that finished a band to the next waiting band, of any job.
  function handOver(entry) {
    entry.busy = false;
    if (broken) return;
    const next = waiters.shift();
    if (next) {
      entry.busy = true;
      next(entry);
    } else {
      scheduleIdle();
    }
  }

  function spawn() {
    const entry = { worker: workerFactory(), pending: null, busy: true };
    entry.worker.onerror = event => fail(entry, new Error(event?.message || 'Geometry worker crashed'));
    entry.worker.onmessageerror = () => fail(entry, new Error('Invalid geometry worker message'));
    entry.worker.onmessage = ({ data }) => {
      const pending = entry.pending;
      if (!pending || data?.id !== pending.id) return;
      entry.pending = null;
      clearTimeout(pending.timer);
      if (data.error) {
        const error = new Error(data.error);
        pending.reject(error);
        fail(entry, error);
        return;
      }
      pending.resolve({ data8: data.data8, data16: data.data16 || null, level16: data.level16 || null });
      handOver(entry);
    };
    workers.push(entry);
    return entry;
  }

  // Resolves with a reserved worker, or null once workers are unavailable.
  function acquire() {
    clearTimeout(idleTimer);
    if (broken) return Promise.resolve(null);
    const free = workers.find(entry => !entry.busy);
    if (free) {
      free.busy = true;
      return Promise.resolve(free);
    }
    if (workers.length < poolSize) {
      try {
        return Promise.resolve(spawn());
      } catch (error) {
        broken = true;
        counters.fallbacks++;
        onError?.(error);
        return Promise.resolve(null);
      }
    }
    return new Promise(resolve => waiters.push(resolve));
  }

  function postBand(entry, plan, band, src, levelFactor = 1) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => fail(entry, new Error('Geometry worker timed out')), timeoutMs);
      entry.pending = { id, resolve, reject, timer };
      const transfers = [];
      if (src.data8) transfers.push(src.data8.buffer);
      if (src.data16) transfers.push(src.data16.buffer);
      try {
        entry.worker.postMessage({ type: 'geometry-band', id, plan, y0: band.y0, y1: band.y1, src, levelFactor }, transfers);
      } catch (error) {
        fail(entry, error);
      }
    });
  }

  /**
   * Renders `plan` from `source`. Resolves with the ImageData, or null when
   * `isCurrent()` turned false: later bands are then skipped and results of
   * bands in flight are dropped. Bands render on this thread with the same
   * core (one band per task, yielding between them) when workers are
   * unavailable or fail. `level` (#248: true for the frame's own factor, or a
   * factor) also builds the display level of the output with the bands, as
   * `__displayLevel`; the bands then start on multiples of its k.
   */
  async function render(source, plan, { isCurrent = () => true, bands: bandCount = null, maxInFlight = null, level = false } = {}) {
    if (plan.identity) return source;
    const k = level === true ? displayLevelFactor(plan.outWidth, plan.outHeight) : Math.max(1, Math.floor(Number(level) || 1));
    const requested = bandCount || geometryBandCount(plan, poolSize);
    const bands = planGeometryBands(plan, broken
      ? Math.max(requested, Math.ceil((plan.outWidth * plan.outHeight) / SYNC_BAND_PIXELS))
      : requested, k);
    const out8 = new Uint8ClampedArray(plan.outWidth * plan.outHeight * 4);
    const out16 = plan.has16 ? new Uint16Array(out8.length) : null;
    const rowWords = plan.outWidth * 4;
    const levelWidth = Math.floor(plan.outWidth / k);
    const levelHeight = Math.floor(plan.outHeight / k);
    const level16 = k > 1 ? new Uint16Array(levelWidth * levelHeight * 4) : null;
    const place = (band, part) => {
      out8.set(part.data8, band.y0 * rowWords);
      if (out16) out16.set(part.data16, band.y0 * rowWords);
      if (level16) level16.set(part.level16 || bandLevelRows(plan, band, part, k), (band.y0 / k) * levelWidth * 4);
    };
    const limit = Math.max(1, Math.min(poolSize, Number(maxInFlight) || Number(maxBandsInFlight) || poolSize));
    const queue = bands.slice();
    const running = new Map();
    let token = 0;
    while (queue.length || running.size) {
      if (!isCurrent()) return null;
      if (queue.length && running.size < limit) {
        const entry = await acquire();
        if (!isCurrent()) {
          if (entry) handOver(entry);
          return null;
        }
        const band = queue.shift();
        if (!entry) {
          place(band, renderBandHere(source, plan, band));
          counters.syncBands++;
        } else {
          // Copy the band's rows now; the base itself is never transferred.
          const slice = sliceGeometrySource(source, plan, band.rect);
          const key = ++token;
          running.set(key, postBand(entry, plan, band, slice, k).then(
            part => ({ key, band, part }),
            error => ({ key, band, error })
          ));
          counters.workerBands++;
        }
        await yieldTask();
        continue;
      }
      const settled = await Promise.race(running.values());
      running.delete(settled.key);
      if (!isCurrent()) return null;
      if (settled.error) {
        place(settled.band, renderBandHere(source, plan, settled.band));
        counters.syncBands++;
      } else {
        place(settled.band, settled.part);
      }
      await yieldTask();
    }
    if (!isCurrent()) return null;
    counters.jobs++;
    if (plan.step === 1) {
      if (plan.rotates) counters.rotations++;
      else counters.copies++;
    }
    const output = wrapGeometryOutput(plan, out8, out16);
    if (level16) {
      output.__displayLevel = adoptDisplayLevel(level16, levelWidth, levelHeight, { sourceWidth: plan.outWidth, sourceHeight: plan.outHeight, k });
    }
    return output;
  }

  return {
    render,
    get size() { return poolSize; },
    get available() { return !broken; },
    counters,
    // Moves this pool to the synchronous path, as a worker failure would
    // (tests and the smoke run compare both paths).
    disableWorkers() {
      broken = true;
      for (const entry of workers.slice()) if (!entry.busy) terminate(entry, new Error('Geometry workers disabled'));
      while (waiters.length) waiters.shift()(null);
    },
    dispose() {
      clearTimeout(idleTimer);
      for (const entry of workers.slice()) terminate(entry, new DOMException('Geometry pool released', 'AbortError'));
      while (waiters.length) waiters.shift()(null);
    }
  };
}

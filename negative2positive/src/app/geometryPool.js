// Geometry worker pool (#244 stage 2). The output window of a geometry plan is
// split into row bands; each band's source rectangle is copied row by row on
// the main thread (a short task per band) and rendered by a worker with the
// same row-range core the synchronous path runs. Only copies are posted, so
// the base, which sessions, history and analysis samples share, is never
// transferred or detached.
import {
  planGeometryBands, sliceGeometrySource, renderGeometryRows, wrapGeometryOutput, geometrySourceRect
} from './imageGeometry.js';
import { displayLevelFactor, displayLevelRows, adoptDisplayLevel } from './displayPreview.js';
import { allocPlane16, hasDerivedEightBit, markDerivedEightBit, isSharedPlane, deriveEightBit, guardSharedPlanes } from './crossOriginIsolation.js';

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

// Rows [y0, y1) of the 16-bit output only (#256: a batch frame whose later
// stages read the 16-bit plane alone). The kernels still write their 8-bit
// bytes, into a few rows of scratch, so the 16-bit samples are those of the
// full render; no frame-sized 8-bit plane is allocated.
const SCRATCH8_ROWS = 32;
function renderRows16(plan, src, data16, y0, y1) {
  const rowLength = plan.outWidth * 4;
  const scratch8 = new Uint8ClampedArray(Math.max(1, Math.min(y1 - y0, SCRATCH8_ROWS)) * rowLength);
  for (let a = y0; a < y1; a += SCRATCH8_ROWS) {
    const b = Math.min(y1, a + SCRATCH8_ROWS);
    renderGeometryRows(plan, src, {
      data8: scratch8.subarray(0, (b - a) * rowLength),
      data16: data16.subarray((a - y0) * rowLength, (b - y0) * rowLength)
    }, a, b);
  }
}

// A band's source when the base is shared (#264): full-width rows [y, y +
// height) of the base, as a view of its shared 16-bit plane (no copy), and
// the 8-bit rows an index plan reads, derived here (`derive8`) or posted.
function bandSource(src) {
  if (!src.shared16) return src;
  const data16 = new Uint16Array(src.shared16.buffer, src.shared16.byteOffset, src.shared16.length);
  const data8 = src.needs8 ? (src.derive8 ? deriveEightBit(data16) : src.data8) : null;
  return { x: src.x, y: src.y, width: src.width, height: src.height, data8, data16 };
}

// The worker side: one band of one plan, and with `levelFactor` > 1 its rows
// of the display level (#248); with `planes16` (#256) its 16-bit rows only.
// `out16` (#264): the band's rows of a shared output plane, written in place
// (only the 8-bit rows go back).
export function runGeometryBand(message) {
  const { id, plan, y0, y1, levelFactor = 1, planes16 = false, levelOnly = false } = message;
  const src = bandSource(message.src);
  const length = (y1 - y0) * plan.outWidth * 4;
  if (planes16 && plan.has16) {
    const data16 = new Uint16Array(length);
    renderRows16(plan, src, data16, y0, y1);
    return { payload: { id, data8: null, data16 }, transfers: [data16.buffer] };
  }
  const data8 = new Uint8ClampedArray(length);
  const sharedOut = plan.has16 && message.out16 ? new Uint16Array(message.out16.buffer, message.out16.byteOffset, message.out16.length) : null;
  const data16 = sharedOut || (plan.has16 ? new Uint16Array(length) : null);
  renderGeometryRows(plan, src, { data8, data16 }, y0, y1);
  // A display proxy band (#249) sends back its level rows only.
  if (levelOnly) {
    const level16 = bandLevelRows(plan, { y0, y1 }, { data8, data16 }, levelFactor);
    return { payload: { id, level16 }, transfers: [level16.buffer] };
  }
  const transfers = [data8.buffer];
  if (data16 && !sharedOut) transfers.push(data16.buffer);
  const payload = { id, data8, data16: sharedOut ? null : data16 };
  if (levelFactor > 1) {
    payload.level16 = bandLevelRows(plan, { y0, y1 }, { data8, data16 }, levelFactor);
    transfers.push(payload.level16.buffer);
  }
  return { payload, transfers };
}

// What a band posts for a shared base (#264): a view description of its
// full-width source rows, and for index plans the 8-bit rows (derived in the
// worker when the base's 8-bit plane is its 16-bit one >>> 8, else copied).
function sharedBandSlice(source, plan, rect) {
  const width = plan.baseWidth;
  const data16 = source.__image16.data;
  const rowWords = width * 4;
  const needs8 = plan.kind === 'index';
  const derive8 = needs8 && hasDerivedEightBit(source);
  return {
    x: 0, y: rect.y, width, height: rect.height,
    shared16: { buffer: data16.buffer, byteOffset: data16.byteOffset + rect.y * rowWords * 2, length: rect.height * rowWords },
    needs8, derive8,
    data8: needs8 && !derive8 ? source.data.slice(rect.y * rowWords, (rect.y + rect.height) * rowWords) : null
  };
}

function renderBandHere(source, plan, band, planes16 = false) {
  const length = (band.y1 - band.y0) * plan.outWidth * 4;
  const src = {
    x: 0, y: 0, width: plan.baseWidth, height: plan.baseHeight,
    data8: source.data, data16: plan.has16 ? source.__image16.data : null
  };
  if (planes16 && plan.has16) {
    const data16 = new Uint16Array(length);
    renderRows16(plan, src, data16, band.y0, band.y1);
    return { data8: null, data16 };
  }
  const data8 = new Uint8ClampedArray(length);
  const data16 = plan.has16 ? new Uint16Array(length) : null;
  renderGeometryRows(plan, src, { data8, data16 }, band.y0, band.y1);
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

  function postBand(entry, plan, band, src, levelFactor = 1, { planes16 = false, levelOnly = false, out16 = null } = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => fail(entry, new Error('Geometry worker timed out')), timeoutMs);
      entry.pending = { id, resolve, reject, timer };
      const transfers = [];
      if (src.data8) transfers.push(src.data8.buffer);
      if (src.data16) transfers.push(src.data16.buffer);
      try {
        entry.worker.postMessage({
          type: 'geometry-band', id, plan, y0: band.y0, y1: band.y1, src, levelFactor,
          ...(planes16 ? { planes16: true } : {}), ...(levelOnly ? { levelOnly: true } : {}), ...(out16 ? { out16 } : {})
        }, transfers);
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
   * `__displayLevel`; the bands then start on multiples of its k. `planes:
   * '16'` (#256, a 16-bit source) builds the 16-bit plane only, without a
   * display level, and resolves `{ width, height, __image16 }`. `shared`
   * (#264, the editor's frame on a cross-origin isolated page) builds the
   * 16-bit output in shared memory, here where it is assembled; nothing
   * writes it once it is returned.
   */
  async function render(source, plan, options = {}) {
    if (plan.identity) return source;
    const guarded = { guard: null };
    try {
      return await renderBands(source, plan, options, guarded);
    } finally {
      guarded.guard?.verify();
    }
  }

  async function renderBands(source, plan, { isCurrent = () => true, bands: bandCount = null, maxInFlight = null, level = false, planes = null, shared = false } = {}, guarded = {}) {
    const planes16 = planes === '16' && plan.has16;
    const k = planes16 ? 1 : (level === true ? displayLevelFactor(plan.outWidth, plan.outHeight) : Math.max(1, Math.floor(Number(level) || 1)));
    const requested = bandCount || geometryBandCount(plan, poolSize);
    const bands = planGeometryBands(plan, broken
      ? Math.max(requested, Math.ceil((plan.outWidth * plan.outHeight) / SYNC_BAND_PIXELS))
      : requested, k);
    const length = plan.outWidth * plan.outHeight * 4;
    const out8 = planes16 ? null : new Uint8ClampedArray(length);
    const out16 = plan.has16 ? allocPlane16(length, { shared }) : null;
    const rowWords = plan.outWidth * 4;
    // A shared base and a shared output (#264): the bands read the base's
    // rows through views and write their 16-bit rows into the output in
    // place; neither 16-bit plane is copied on this thread.
    const sharedBands = !planes16 && isSharedPlane(out16) && isSharedPlane(source.__image16?.data);
    if (sharedBands) guarded.guard = guardSharedPlanes('geometry bands', [source.__image16.data]);
    const levelWidth = Math.floor(plan.outWidth / k);
    const levelHeight = Math.floor(plan.outHeight / k);
    const level16 = k > 1 ? new Uint16Array(levelWidth * levelHeight * 4) : null;
    const place = (band, part) => {
      if (out8) out8.set(part.data8, band.y0 * rowWords);
      if (out16 && part.data16) out16.set(part.data16, band.y0 * rowWords);
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
          place(band, renderBandHere(source, plan, band, planes16));
          counters.syncBands++;
        } else {
          // Copy the band's rows now; the base itself is never transferred.
          // A shared base is not copied at all (#264).
          const slice = sharedBands ? sharedBandSlice(source, plan, band.rect) : sliceGeometrySource(source, plan, band.rect);
          const outRows = sharedBands
            ? { buffer: out16.buffer, byteOffset: out16.byteOffset + band.y0 * rowWords * 2, length: (band.y1 - band.y0) * rowWords }
            : null;
          const key = ++token;
          running.set(key, postBand(entry, plan, band, slice, k, { planes16, out16: outRows }).then(
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
        place(settled.band, renderBandHere(source, plan, settled.band, planes16));
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
    if (planes16) return { width: plan.outWidth, height: plan.outHeight, __image16: { width: plan.outWidth, height: plan.outHeight, data: out16 } };
    const output = wrapGeometryOutput(plan, out8, out16);
    if (level16) {
      output.__displayLevel = adoptDisplayLevel(level16, levelWidth, levelHeight, { sourceWidth: plan.outWidth, sourceHeight: plan.outHeight, k });
    }
    // The kernels copy or derive both planes alike: the output's 8-bit plane
    // is its 16-bit one >>> 8 whenever the source's was (#264).
    if (out16 && hasDerivedEightBit(source)) markDerivedEightBit(output);
    return output;
  }

  /**
   * The display level (#248) of the output of `plan` from `source`, without
   * building that output (#249: display proxies of roll-analysed and lane
   * frames): each band renders only whole k-row groups of the output and
   * sends back their box-averaged level rows, the same arithmetic as
   * buildDisplayLevel of the whole output. The base rows are copied per
   * band, never transferred. Resolves the level (adopted with its source
   * geometry), null once `isCurrent()` turned false, or null for k = 1
   * (such a level is the output itself).
   */
  async function renderDisplayLevel(source, plan, { k = displayLevelFactor(plan.outWidth, plan.outHeight), isCurrent = () => true, levelRowsPerBand = 16, maxInFlight = null } = {}) {
    if (!(k > 1)) return null;
    const levelWidth = Math.floor(plan.outWidth / k);
    const levelHeight = Math.floor(plan.outHeight / k);
    const level16 = new Uint16Array(levelWidth * levelHeight * 4);
    const step = Math.max(1, levelRowsPerBand) * k;
    const queue = [];
    for (let y0 = 0; y0 < levelHeight * k; y0 += step) {
      const y1 = Math.min(levelHeight * k, y0 + step);
      queue.push({ y0, y1, rect: geometrySourceRect(plan, y0, y1) });
    }
    const place = (band, rows) => level16.set(rows, (band.y0 / k) * levelWidth * 4);
    const here = band => runGeometryBand({
      id: 0, plan, y0: band.y0, y1: band.y1, levelFactor: k, levelOnly: true,
      src: { x: 0, y: 0, width: plan.baseWidth, height: plan.baseHeight, data8: source.data, data16: plan.has16 ? source.__image16.data : null }
    }).payload.level16;
    const limit = Math.max(1, Math.min(poolSize, Number(maxInFlight) || Number(maxBandsInFlight) || poolSize));
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
          place(band, here(band));
          counters.syncBands++;
        } else {
          const slice = sliceGeometrySource(source, plan, band.rect);
          const key = ++token;
          running.set(key, postBand(entry, plan, band, slice, k, { levelOnly: true }).then(
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
      place(settled.band, settled.error || !settled.part.level16 ? here(settled.band) : settled.part.level16);
      if (settled.error) counters.syncBands++;
      await yieldTask();
    }
    if (!isCurrent()) return null;
    counters.levels = (counters.levels || 0) + 1;
    return adoptDisplayLevel(level16, levelWidth, levelHeight, { sourceWidth: plan.outWidth, sourceHeight: plan.outHeight, k });
  }

  return {
    render,
    renderDisplayLevel,
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

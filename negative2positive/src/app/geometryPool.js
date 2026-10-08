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
import { applyLensMapRows, lensRowExtents, lensSourceRows, sliceLensMaps, lensMapBuffers } from './lensMaps.js';

// Below this many output pixels a band is not worth a worker round trip.
const MIN_BAND_PIXELS = 1_000_000;
// Without workers each band is one main-thread task: keep them short.
const SYNC_BAND_PIXELS = 1_000_000;
// A display level's band (#249) renders this many level rows at a time into
// scratch, so a band of any height never holds its output rows (R2-003).
const LEVEL_ROWS_PER_PASS = 16;
// The copies of a display level's bands in flight (R2-003) stay within this
// many bytes per base pixel: what a roll frame's claim (#258,
// rollAnalysisFootprint: 14 B/px) leaves beside its planes on the page
// (12 B/px) while its proxy is filled from them.
export const LEVEL_BAND_BYTES_PER_BASE_PIXEL = 2;
// A tilted band also copies the rows its output rows span (outWidth x |sin|
// of them): a level's band copies at most this much more than its own rows.
const LEVEL_BAND_MAX_OVERLAP = 1 / 3;
// A level band's rows are copied at most this many bytes per main-thread
// task (a steep angle's single band holds the whole window's rows).
const LEVEL_COPY_TASK_BYTES = 32 * 1024 * 1024;
// A lens-corrected level's band on the main thread (#278) renders the rows
// its remap reads this many at a time per task.
const LENS_WINDOW_ROWS_PER_TASK = 32;

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

/**
 * The bands of a display level (#249) whose source rows are copied here,
 * planned by the bytes they copy (R2-003). A band of a tilted plan copies the
 * rows its output rows span besides its own, so thin bands copied that
 * overlap many times over (16 level rows: 0.5-1.9 GiB per 60 MP fill). As
 * many bands run at once as `maxBytes` holds, each as tall as its share of
 * it allows (at most one band per worker), while a band copies at most a
 * third more than its own rows. When no band in flight keeps to that, one at
 * a time takes the whole budget while that copies each row at most twice;
 * beyond that (steep angles) one band reads the window once.
 *
 * A lens-corrected level's band (#278) holds what `held(y0, y1)` says
 * instead (its copy and the output rows it renders, which differ along the
 * frame), at least `heldCopies` times its own rows.
 *
 * @returns {{ rows: number, inFlight: number }} output rows per band (a
 *   multiple of k) and bands in flight
 */
export function planDisplayLevelBands(plan, k, { workers = 1, maxBytes, bytesPerPixel = plan.has16 ? 8 : 4, held = null, heldCopies = 1 } = {}) {
  const groups = Math.floor(plan.outHeight / k);
  if (groups < 1) return { rows: k, inFlight: 1 };
  const middle = Math.floor(groups / 2);
  // The copy of a band of `count` k-row groups at the window's middle, where
  // a band's rectangle is the tallest (the base clamps it near its edges);
  // with `held`, the most any band of that partition holds.
  const copy = held ? count => {
    let most = 0;
    for (let group = 0; group < groups; group += count) most = Math.max(most, held(group * k, Math.min(groups, group + count) * k));
    return most;
  } : count => {
    const y0 = Math.max(0, Math.min(middle, groups - count)) * k;
    const rect = geometrySourceRect(plan, y0, y0 + count * k);
    return rect.width * rect.height * bytesPerPixel;
  };
  const own = count => heldCopies * count * k * plan.step * plan.outWidth * plan.step * bytesPerPixel;
  // The most groups (up to `cap`) whose copy fits `budget`; 0 if none does.
  const tallest = (budget, cap) => {
    let low = 0;
    let high = cap;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (copy(mid) <= budget) low = mid;
      else high = mid - 1;
    }
    return low;
  };
  for (let inFlight = Math.max(1, Math.floor(workers) || 1); inFlight >= 1; inFlight--) {
    const count = tallest(maxBytes / inFlight, Math.ceil(groups / inFlight));
    if (count && copy(count) <= own(count) * (1 + LEVEL_BAND_MAX_OVERLAP)) return { rows: count * k, inFlight };
  }
  const count = tallest(maxBytes, groups);
  if (count && copy(count) <= own(count) * 2) return { rows: count * k, inFlight: 1 };
  return { rows: groups * k, inFlight: 1 };
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

// The display level rows of output rows [y0, y1) (whole k-row groups),
// rendered LEVEL_ROWS_PER_PASS level rows at a time into one scratch band
// (R2-003), zeroed between passes as a fresh output is (the bilinear kernel
// leaves pixels outside the base as it finds them).
function renderLevelRows(plan, src, y0, y1, k) {
  const levelWidth = Math.floor(plan.outWidth / k);
  const out = new Uint16Array(((y1 - y0) / k) * levelWidth * 4);
  const pass = LEVEL_ROWS_PER_PASS * k;
  const rowLength = plan.outWidth * 4;
  const scratch8 = new Uint8ClampedArray(Math.min(pass, y1 - y0) * rowLength);
  const scratch16 = plan.has16 ? new Uint16Array(scratch8.length) : null;
  for (let a = y0; a < y1; a += pass) {
    const b = Math.min(y1, a + pass);
    const length = (b - a) * rowLength;
    if (a > y0) {
      scratch8.fill(0, 0, length);
      scratch16?.fill(0, 0, length);
    }
    const part = { data8: scratch8.subarray(0, length), data16: scratch16 ? scratch16.subarray(0, length) : null };
    renderGeometryRows(plan, src, part, a, b);
    out.set(bandLevelRows(plan, { y0: a, y1: b }, part, k), ((a - y0) / k) * levelWidth * 4);
  }
  return out;
}

// The level of a 16-bit frame reads its 16-bit rows only (R2-003): an index
// plan's level band gets no 8-bit rows, and its kernels, which still write
// 8-bit bytes into scratch, read a byte view of the band's 16-bit rows.
function levelBandSource(plan, src) {
  if (src.data8 || plan.kind !== 'index' || !src.data16) return src;
  return { ...src, data8: new Uint8ClampedArray(src.data16.buffer, src.data16.byteOffset, src.data16.length) };
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

// The display level rows of lens-corrected output rows [y0, y1) (#278):
// the output rows they read (`lens.window`, lensSourceRows) rendered from
// `src` (16-bit only, from zeros as a fresh output), then lensLevelRows.
function renderLensLevelRows(plan, src, lens, y0, y1, k) {
  const { y0: wy0, y1: wy1 } = lens.window;
  const window16 = new Uint16Array((wy1 - wy0) * plan.outWidth * 4);
  renderRows16(plan, src, window16, wy0, wy1);
  return lensLevelRows(plan, window16, lens, y0, y1, k);
}

// Output rows [y0, y1) remapped from `window16` (the output's rows of
// `lens.window`), LEVEL_ROWS_PER_PASS level rows at a time into one scratch
// band, and box-averaged: buildDisplayLevel of applyLensMapsToImage of the
// whole output, those rows. `lens.maps` holds at least the grid rows these
// rows read (sliceLensMaps).
function lensLevelRows(plan, window16, lens, y0, y1, k) {
  const width = plan.outWidth;
  const rowLength = width * 4;
  const input = { source: window16, sourceRow0: lens.window.y0, width, height: plan.outHeight, maxValue: 65535 };
  const levelWidth = Math.floor(width / k);
  const out = new Uint16Array(((y1 - y0) / k) * levelWidth * 4);
  const pass = LEVEL_ROWS_PER_PASS * k;
  const scratch = new Uint16Array(Math.min(pass, y1 - y0) * rowLength);
  for (let a = y0; a < y1; a += pass) {
    const b = Math.min(y1, a + pass);
    const rows = scratch.subarray(0, (b - a) * rowLength);
    applyLensMapRows(input, lens.maps, lens.modes, { out16: rows }, a, b);
    out.set(displayLevelRows({ width, height: b - a, __image16: { data: rows } }, k, levelWidth), ((a - y0) / k) * levelWidth * 4);
  }
  return out;
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
// of the display level (#248); with `levelOnly` (#249) those level rows
// alone, of the lens-corrected output with `lens` (#278); with `planes16`
// (#256) its 16-bit rows only. `out16` (#264): the band's rows of a shared
// output plane, written in place (only the 8-bit rows go back).
export function runGeometryBand(message) {
  const { id, plan, y0, y1, levelFactor = 1, planes16 = false, levelOnly = false, lens = null } = message;
  const src = bandSource(message.src);
  // A display proxy band (#249) sends back its level rows only, and the
  // buffers of the rows it was sent, for the page to copy the next band's
  // rows into (R2-003); never a shared base's.
  if (levelOnly) {
    const level16 = lens ? renderLensLevelRows(plan, levelBandSource(plan, src), lens, y0, y1, levelFactor)
      : renderLevelRows(plan, levelBandSource(plan, src), y0, y1, levelFactor);
    const spent = [...new Set([src.data16?.buffer, src.data8?.buffer])].filter(buffer => buffer instanceof ArrayBuffer);
    return { payload: { id, level16, spent }, transfers: [level16.buffer, ...spent] };
  }
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
// worker when the base's 8-bit plane is its 16-bit one >>> 8, else copied;
// none for a display level, `needs8` false, R2-003).
function sharedBandSlice(source, plan, rect, { needs8 = plan.kind === 'index' } = {}) {
  const width = plan.baseWidth;
  const data16 = source.__image16.data;
  const rowWords = width * 4;
  const derive8 = needs8 && hasDerivedEightBit(source);
  return {
    x: 0, y: rect.y, width, height: rect.height,
    shared16: { buffer: data16.buffer, byteOffset: data16.byteOffset + rect.y * rowWords * 2, length: rect.height * rowWords },
    needs8, derive8,
    data8: needs8 && !derive8 ? source.data.slice(rect.y * rowWords, (rect.y + rect.height) * rowWords) : null
  };
}

// The rows a display level's band reads, of the plane the level reads (the
// 16-bit one of a 16-bit frame, R2-003), copied here into a buffer an
// earlier band's worker handed back when one is large enough (its pages are
// mapped already, so the copy takes about 40 % less time than one into a
// new array), `taskBytes` per task. Null once `isCurrent()` turned false
// between tasks.
async function sliceLevelSource(source, plan, rect, spare, { taskBytes, pause, isCurrent }) {
  const plane = plan.has16 ? source.__image16.data : source.data;
  const Type = plan.has16 ? Uint16Array : Uint8ClampedArray;
  const rowLength = rect.width * 4;
  const length = rowLength * rect.height;
  const index = spare.findIndex(buffer => buffer.byteLength >= length * Type.BYTES_PER_ELEMENT);
  const rows = index >= 0 ? new Type(spare.splice(index, 1)[0], 0, length) : new Type(length);
  const rowsPerTask = Math.max(1, Math.floor(taskBytes / (rowLength * Type.BYTES_PER_ELEMENT)));
  for (let row = 0; row < rect.height; row++) {
    if (row && row % rowsPerTask === 0) {
      await pause();
      if (!isCurrent()) return null;
    }
    const start = ((rect.y + row) * plan.baseWidth + rect.x) * 4;
    rows.set(plane.subarray(start, start + rowLength), row * rowLength);
  }
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, data8: plan.has16 ? null : rows, data16: plan.has16 ? rows : null };
}

// The bytes a band's slice copied here (a shared base's view is no copy).
function copiedBytes(slice) {
  return (slice.data8?.byteLength || 0) + (slice.data16?.byteLength || 0);
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
  // `copiedBytes`: band source rows copied on this thread (R2-003).
  const counters = { jobs: 0, rotations: 0, copies: 0, workerBands: 0, syncBands: 0, fallbacks: 0, levels: 0, copiedBytes: 0 };

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
      pending.resolve({ data8: data.data8, data16: data.data16 || null, level16: data.level16 || null, spent: data.spent || null });
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

  function postBand(entry, plan, band, src, levelFactor = 1, { planes16 = false, levelOnly = false, out16 = null, lens = null } = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => fail(entry, new Error('Geometry worker timed out')), timeoutMs);
      entry.pending = { id, resolve, reject, timer };
      const transfers = [];
      if (src.data8) transfers.push(src.data8.buffer);
      if (src.data16) transfers.push(src.data16.buffer);
      // A lens band's grid rows are its own copies (sliceLensMaps).
      if (lens) transfers.push(...lensMapBuffers(lens.maps));
      try {
        entry.worker.postMessage({
          type: 'geometry-band', id, plan, y0: band.y0, y1: band.y1, src, levelFactor,
          ...(planes16 ? { planes16: true } : {}), ...(levelOnly ? { levelOnly: true } : {}), ...(out16 ? { out16 } : {}),
          ...(lens ? { lens } : {})
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
    // The display level of a shared frame is shared too (#264), assembled
    // here like the frame.
    const level16 = k > 1 ? allocPlane16(levelWidth * levelHeight * 4, { shared }) : null;
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
          counters.copiedBytes += copiedBytes(slice);
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
   * buildDisplayLevel of the whole output. The base is never transferred. A
   * shared base (#264) is read through views, so nothing is copied here; a
   * plain one is copied once per band, the plane the level reads only (its
   * 16-bit rows when it has them), in bands planned by planDisplayLevelBands
   * within `maxBytesInFlight` (R2-003), at most `copyTaskBytes` per task.
   * `levelRowsPerBand` fixes the bands instead (tests). Resolves the level
   * (adopted with its source geometry), null once `isCurrent()` turned
   * false, or null for k = 1 (such a level is the output itself).
   */
  async function renderDisplayLevel(source, plan, options = {}) {
    const guarded = { guard: null };
    try {
      return await renderLevelBands(source, plan, options, guarded);
    } finally {
      guarded.guard?.verify();
    }
  }

  async function renderLevelBands(source, plan, {
    k = displayLevelFactor(plan.outWidth, plan.outHeight), isCurrent = () => true, levelRowsPerBand = null,
    maxInFlight = null, maxBytesInFlight = null, copyTaskBytes = LEVEL_COPY_TASK_BYTES
  } = {}, guarded = {}) {
    if (!(k > 1)) return null;
    const levelWidth = Math.floor(plan.outWidth / k);
    const levelHeight = Math.floor(plan.outHeight / k);
    const level16 = new Uint16Array(levelWidth * levelHeight * 4);
    const limit = Math.max(1, Math.min(poolSize, Number(maxInFlight) || Number(maxBandsInFlight) || poolSize));
    const shared = plan.has16 && isSharedPlane(source.__image16?.data);
    if (shared) guarded.guard = guardSharedPlanes('display level bands', [source.__image16.data]);
    // Bands that copy nothing here (a shared base, or no workers) keep a few
    // level rows each, as short tasks.
    const fixed = Math.floor(Number(levelRowsPerBand)) || (shared || broken ? LEVEL_ROWS_PER_PASS : 0);
    const bands = fixed > 0 ? { rows: fixed * k, inFlight: limit } : planDisplayLevelBands(plan, k, {
      workers: limit,
      maxBytes: Number(maxBytesInFlight) || LEVEL_BAND_BYTES_PER_BASE_PIXEL * plan.baseWidth * plan.baseHeight
    });
    const queue = [];
    for (let y0 = 0; y0 < levelHeight * k; y0 += bands.rows) {
      const y1 = Math.min(levelHeight * k, y0 + bands.rows);
      queue.push({ y0, y1, rect: geometrySourceRect(plan, y0, y1) });
    }
    const place = (band, rows) => level16.set(rows, (band.y0 / k) * levelWidth * 4);
    const base = { x: 0, y: 0, width: plan.baseWidth, height: plan.baseHeight, data8: source.data, data16: plan.has16 ? source.__image16.data : null };
    // A band on this thread (no workers, or its worker failed), a few level
    // rows per task; null once the job is stale.
    const here = async band => {
      const rows = new Uint16Array(((band.y1 - band.y0) / k) * levelWidth * 4);
      const pass = LEVEL_ROWS_PER_PASS * k;
      for (let a = band.y0; a < band.y1; a += pass) {
        if (a > band.y0) {
          await yieldTask();
          if (!isCurrent()) return null;
        }
        rows.set(renderLevelRows(plan, base, a, Math.min(band.y1, a + pass), k), ((a - band.y0) / k) * levelWidth * 4);
      }
      counters.syncBands++;
      return rows;
    };
    // Buffers of copied rows the workers handed back, for the next bands.
    const spare = [];
    const running = new Map();
    let token = 0;
    while (queue.length || running.size) {
      if (!isCurrent()) return null;
      if (queue.length && running.size < bands.inFlight) {
        const entry = await acquire();
        if (!isCurrent()) {
          if (entry) handOver(entry);
          return null;
        }
        const band = queue.shift();
        if (!entry) {
          const rows = await here(band);
          if (!rows) return null;
          place(band, rows);
        } else {
          const slice = shared ? sharedBandSlice(source, plan, band.rect, { needs8: false })
            : await sliceLevelSource(source, plan, band.rect, spare, { taskBytes: copyTaskBytes, pause: yieldTask, isCurrent });
          if (!slice) {
            handOver(entry);
            return null;
          }
          counters.copiedBytes += copiedBytes(slice);
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
      if (settled.part?.spent) spare.push(...settled.part.spent);
      if (!isCurrent()) return null;
      const rows = settled.error || !settled.part.level16 ? await here(settled.band) : settled.part.level16;
      if (!rows) return null;
      place(settled.band, rows);
      await yieldTask();
    }
    if (!isCurrent()) return null;
    counters.levels++;
    return adoptDisplayLevel(level16, levelWidth, levelHeight, { sourceWidth: plan.outWidth, sourceHeight: plan.outHeight, k });
  }

  /**
   * The display level (#248) of the lens-corrected output of `plan` (#278):
   * buildDisplayLevel of applyLensMapsToImage of the whole output, the remap
   * the editor runs after the crop, without building either. `lens` is
   * `{ maps, modes }`: lensfun's maps for a plan.outWidth x plan.outHeight
   * output; 16-bit plans only. Each band renders the output rows its
   * corrected rows read (lensSourceRows) from the base rows those read,
   * remaps its rows and box-averages them, as renderDisplayLevel's bands
   * do; a worker gets only the band's grid rows. Bands are planned by what
   * they hold (their copied base rows and the output rows they render) and
   * stay within `maxBytesInFlight`, renderDisplayLevel's 2 bytes per base
   * pixel (the maps, about 0.7 bytes per pixel at 60 MP, come beside them
   * as the level does).
   * Resolves the level, or null once `isCurrent()` turned false, for k = 1,
   * or when no band fits that budget (a lens that moves rows that far is
   * not filled).
   */
  async function renderLensDisplayLevel(source, plan, lens, options = {}) {
    const guarded = { guard: null };
    try {
      return await renderLensLevelBands(source, plan, lens, options, guarded);
    } finally {
      guarded.guard?.verify();
    }
  }

  async function renderLensLevelBands(source, plan, { maps, modes }, {
    k = displayLevelFactor(plan.outWidth, plan.outHeight), isCurrent = () => true, levelRowsPerBand = null,
    maxInFlight = null, maxBytesInFlight = null, copyTaskBytes = LEVEL_COPY_TASK_BYTES
  } = {}, guarded = {}) {
    if (!(k > 1) || !plan.has16) return null;
    const width = plan.outWidth;
    const levelWidth = Math.floor(width / k);
    const levelHeight = Math.floor(plan.outHeight / k);
    const limit = Math.max(1, Math.min(poolSize, Number(maxInFlight) || Number(maxBandsInFlight) || poolSize));
    const shared = isSharedPlane(source.__image16?.data);
    if (shared) guarded.guard = guardSharedPlanes('lens display level bands', [source.__image16.data]);
    const extents = lensRowExtents(maps, modes);
    const windowOf = (y0, y1) => lensSourceRows(maps, modes, y0, y1, plan.outHeight, extents);
    const maxBytes = Number(maxBytesInFlight) || LEVEL_BAND_BYTES_PER_BASE_PIXEL * plan.baseWidth * plan.baseHeight;
    // A band copies its base rows here unless it reads them through views
    // (a shared base) or on this thread (no workers), and renders the
    // output rows its window holds.
    const copies = !shared && !broken;
    const held = (y0, y1) => {
      const window = windowOf(y0, y1);
      const rendered = (window.y1 - window.y0) * width * 8;
      if (!copies) return rendered;
      const rect = geometrySourceRect(plan, window.y0, window.y1);
      return rect.width * rect.height * 8 + rendered;
    };
    const fixed = Math.floor(Number(levelRowsPerBand)) || (broken ? LEVEL_ROWS_PER_PASS : 0);
    const bands = fixed > 0 ? { rows: fixed * k, inFlight: broken ? 1 : limit }
      : planDisplayLevelBands(plan, k, { workers: limit, maxBytes, held, heldCopies: copies ? 2 : 1 });
    const queue = [];
    let largest = 0;
    for (let y0 = 0; y0 < levelHeight * k; y0 += bands.rows) {
      const y1 = Math.min(levelHeight * k, y0 + bands.rows);
      const window = windowOf(y0, y1);
      queue.push({ y0, y1, window, rect: geometrySourceRect(plan, window.y0, window.y1) });
      largest = Math.max(largest, held(y0, y1));
    }
    if (largest * Math.min(bands.inFlight, queue.length) > maxBytes) return null;
    const level16 = new Uint16Array(levelWidth * levelHeight * 4);
    const place = (band, rows) => level16.set(rows, (band.y0 / k) * levelWidth * 4);
    const base = { x: 0, y: 0, width: plan.baseWidth, height: plan.baseHeight, data8: source.data, data16: source.__image16.data };
    // A band on this thread (no workers, or its worker failed), a few level
    // rows at a time, the window each reads rendered a few rows per task;
    // null once stale.
    const here = async band => {
      const rows = new Uint16Array(((band.y1 - band.y0) / k) * levelWidth * 4);
      const pass = LEVEL_ROWS_PER_PASS * k;
      const rowLength = width * 4;
      for (let a = band.y0; a < band.y1; a += pass) {
        const b = Math.min(band.y1, a + pass);
        const window = windowOf(a, b);
        const window16 = new Uint16Array((window.y1 - window.y0) * rowLength);
        for (let r = window.y0; r < window.y1; r += LENS_WINDOW_ROWS_PER_TASK) {
          if (a > band.y0 || r > window.y0) {
            await yieldTask();
            if (!isCurrent()) return null;
          }
          const end = Math.min(window.y1, r + LENS_WINDOW_ROWS_PER_TASK);
          renderRows16(plan, base, window16.subarray((r - window.y0) * rowLength, (end - window.y0) * rowLength), r, end);
        }
        rows.set(lensLevelRows(plan, window16, { window, maps, modes }, a, b, k), ((a - band.y0) / k) * levelWidth * 4);
      }
      counters.syncBands++;
      return rows;
    };
    const bandModes = { includeTca: Boolean(modes.includeTca), includeVignetting: Boolean(modes.includeVignetting) };
    const spare = [];
    const running = new Map();
    let token = 0;
    while (queue.length || running.size) {
      if (!isCurrent()) return null;
      if (queue.length && running.size < bands.inFlight) {
        const entry = await acquire();
        if (!isCurrent()) {
          if (entry) handOver(entry);
          return null;
        }
        const band = queue.shift();
        if (!entry) {
          const rows = await here(band);
          if (!rows) return null;
          place(band, rows);
        } else {
          const slice = shared ? sharedBandSlice(source, plan, band.rect, { needs8: false })
            : await sliceLevelSource(source, plan, band.rect, spare, { taskBytes: copyTaskBytes, pause: yieldTask, isCurrent });
          if (!slice) {
            handOver(entry);
            return null;
          }
          counters.copiedBytes += copiedBytes(slice);
          const lens = { window: band.window, maps: sliceLensMaps(maps, modes, band.y0, band.y1), modes: bandModes };
          const key = ++token;
          running.set(key, postBand(entry, plan, band, slice, k, { levelOnly: true, lens }).then(
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
      if (settled.part?.spent) spare.push(...settled.part.spent);
      if (!isCurrent()) return null;
      const rows = settled.error || !settled.part.level16 ? await here(settled.band) : settled.part.level16;
      if (!rows) return null;
      place(settled.band, rows);
      await yieldTask();
    }
    if (!isCurrent()) return null;
    counters.levels++;
    return adoptDisplayLevel(level16, levelWidth, levelHeight, { sourceWidth: plan.outWidth, sourceHeight: plan.outHeight, k });
  }

  return {
    render,
    renderDisplayLevel,
    renderLensDisplayLevel,
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

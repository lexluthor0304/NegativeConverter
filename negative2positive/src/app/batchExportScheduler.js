/**
 * Batch export scheduler — runs the per-file export pipeline for several
 * files at once while writing the results out in the original order.
 *
 * The old loops awaited decode → convert → adjust → encode → write for one
 * file before touching the next, so the conversion worker sat idle while the
 * main thread decoded, and the main thread sat idle while the worker
 * converted. Here up to `maxParallel` files are in flight together: their
 * stages interleave, the pooled workers stay busy, and the sink (ZIP entry,
 * desktop file, browser download) still receives file 1, then 2, then 3, so
 * archives and download order stay stable.
 *
 * Pure: no DOM, no workers. The caller supplies `process` (file → payload)
 * and `sink` (payload → written); both may reject, and a rejection marks that
 * job as failed without stopping the others.
 */

import { budgetFor, LOW_MEMORY_RAM_BYTES } from './memoryBudget.js';

// One in-flight frame keeps roughly 50 bytes per pixel alive across the RAW
// decoder heap, the 16-bit source, the worker clone, the 16-bit and 8-bit
// results and the encoder canvas (measured: four 18.5 MP DNG lanes peak at
// ~3.7 GB of renderer RSS in Chrome). Lanes are planned in bytes (#258): a
// roll of 18 MP camera scans runs four wide, 24 MP three wide, 36 MP two wide
// and a 100 MP flatbed scan stays sequential within the historical 4.0 GB
// (80 MP) lane budget; devices with 4 GiB or less get 1.4 GB (28 MP). When
// the real RAM is known, half of the renderer-wide budget may be used
// instead, which only ever raises the plan (32 GiB and more: 7.5 GB, two
// 60 MP lanes). The runtime reservations (memoryBudget.js) admit fewer lanes
// where the plan is optimistic: the planned count is only a ceiling.
export const LANE_BYTES_PER_PIXEL = 50;
export const LEGACY_LANE_BUDGET_BYTES = 80e6 * LANE_BYTES_PER_PIXEL;
export const LEGACY_LOW_MEMORY_LANE_BUDGET_BYTES = 28e6 * LANE_BYTES_PER_PIXEL;
export const BACKGROUND_SHARE = 0.5;
// The pixel budgets these replace (for callers that still speak pixels).
export const BATCH_PIXEL_BUDGET = LEGACY_LANE_BUDGET_BYTES / LANE_BYTES_PER_PIXEL;
export const BATCH_PIXEL_BUDGET_LOW_MEMORY = LEGACY_LOW_MEMORY_LANE_BUDGET_BYTES / LANE_BYTES_PER_PIXEL;
export const BATCH_MAX_PARALLEL = 4;
export const BATCH_LOW_MEMORY_GB = 4;

/**
 * The bytes the lanes of one batch may plan with.
 *
 * @param {{deviceMemory?: number, ramBytes?: number|null}} [options]
 */
export function planLaneBudgetBytes({ deviceMemory, ramBytes = null } = {}) {
  const ramKnown = Number.isFinite(ramBytes) && ramBytes > 0;
  const lowMemory = (Number.isFinite(deviceMemory) && deviceMemory > 0 && deviceMemory <= BATCH_LOW_MEMORY_GB)
    || (ramKnown && ramBytes <= LOW_MEMORY_RAM_BYTES);
  // A device that reports 4 GB or less keeps the low-memory plan whatever
  // else is known; otherwise real RAM can only raise the historical plan.
  if (lowMemory) return LEGACY_LOW_MEMORY_LANE_BUDGET_BYTES;
  return ramKnown ? Math.max(LEGACY_LANE_BUDGET_BYTES, BACKGROUND_SHARE * budgetFor({ ramBytes })) : LEGACY_LANE_BUDGET_BYTES;
}

/**
 * How many files may be processed at once.
 *
 * @param {object} options
 * @param {number} [options.hardwareConcurrency] navigator.hardwareConcurrency
 * @param {number} [options.deviceMemory] navigator.deviceMemory (GB), when reported
 * @param {number|null} [options.ramBytes] the machine's RAM when known (the
 *   desktop command, or deviceMemory on the web; null when unknown)
 * @param {number} [options.pixelsPerFile] largest frame in the batch, in pixels
 * @param {number} [options.fileCount]
 * @returns {number} 1..BATCH_MAX_PARALLEL
 */
export function planBatchParallelism({
  hardwareConcurrency,
  deviceMemory,
  ramBytes = null,
  pixelsPerFile,
  fileCount = Infinity,
  maxParallel = BATCH_MAX_PARALLEL
} = {}) {
  const cores = Number.isFinite(hardwareConcurrency) && hardwareConcurrency > 0
    ? Math.floor(hardwareConcurrency)
    : 4;
  // The main thread and the encoder need cores of their own.
  const byCores = Math.max(1, Math.min(maxParallel, cores - 2));
  const laneBudget = planLaneBudgetBytes({ deviceMemory, ramBytes });
  const pixels = Number.isFinite(pixelsPerFile) && pixelsPerFile > 0 ? pixelsPerFile : laneBudget / LANE_BYTES_PER_PIXEL;
  const byMemory = Math.max(1, Math.floor(laneBudget / (LANE_BYTES_PER_PIXEL * pixels)));
  const byFiles = Number.isFinite(fileCount) && fileCount > 0 ? Math.floor(fileCount) : maxParallel;
  return Math.max(1, Math.min(byCores, byMemory, byFiles, maxParallel));
}

// A geometry band in flight (#244) holds a copy of its source rows and its
// output rows: about 20 bytes per output pixel for a 16-bit frame. The lanes
// share the geometry pool, so they share this transient budget too; WebKit's
// content process has less headroom than Chrome. The memory budget (#258)
// reserves each lane's frame; these bands are inside that reservation.
export const GEOMETRY_BAND_BUDGET_BYTES = 768 * 1024 * 1024;
export const GEOMETRY_BAND_BUDGET_BYTES_LOW_MEMORY = 256 * 1024 * 1024;
export const GEOMETRY_BYTES_PER_BAND_PIXEL = 20;

/**
 * How many geometry bands one lane may keep in flight.
 *
 * @param {object} options
 * @param {number} [options.lanes] files processed at once
 * @param {number} [options.pixelsPerFile] largest frame in the batch
 * @param {number} [options.poolSize] geometry workers
 * @param {number} [options.bandCount] bands per frame
 * @param {number} [options.deviceMemory] navigator.deviceMemory (GB)
 * @returns {number} 1..poolSize
 */
export function planGeometryBandsInFlight({ lanes = 1, pixelsPerFile, poolSize = 6, bandCount = 6, deviceMemory } = {}) {
  const lowMemory = Number.isFinite(deviceMemory) && deviceMemory > 0 && deviceMemory <= BATCH_LOW_MEMORY_GB;
  const budget = lowMemory ? GEOMETRY_BAND_BUDGET_BYTES_LOW_MEMORY : GEOMETRY_BAND_BUDGET_BYTES;
  const pixels = Number.isFinite(pixelsPerFile) && pixelsPerFile > 0 ? pixelsPerFile : 60_000_000;
  const bandBytes = Math.max(1, pixels / Math.max(1, bandCount)) * GEOMETRY_BYTES_PER_BAND_PIXEL;
  const perLane = Math.floor(Math.floor(budget / bandBytes) / Math.max(1, Math.floor(lanes) || 1));
  const workers = Math.max(1, Math.floor(poolSize) || 1);
  return Math.max(1, Math.min(workers, perLane));
}

/**
 * How many workers the PNG16 band pool of one export operation gets (#257).
 * A single export or a one-lane batch has the cores to itself, minus the
 * main thread and one for the rest of the page; two lanes get two band
 * workers each; with three or more lanes every core is already busy with a
 * frame, so there is no pool and each lane's export worker encodes its bands
 * one after another (the same bytes).
 *
 * @param {{lanes?: number, hardwareConcurrency?: number}} [options]
 * @returns {number} 0 means no pool
 */
export function planPng16BandWorkers({ lanes = 1, hardwareConcurrency } = {}) {
  const laneCount = Number.isFinite(lanes) && lanes >= 1 ? Math.floor(lanes) : 1;
  if (laneCount >= 3) return 0;
  if (laneCount === 2) return 4;
  const cores = Number.isFinite(hardwareConcurrency) && hardwareConcurrency > 0
    ? Math.floor(hardwareConcurrency)
    : 4;
  return Math.max(1, cores - 2);
}

/**
 * Run `jobs` through `process` with bounded parallelism and hand each result
 * to `sink` in job order.
 *
 * @template TJob, TPayload
 * @param {TJob[]} jobs
 * @param {object} options
 * @param {(job: TJob, index: number) => Promise<TPayload>} options.process
 * @param {(job: TJob, payload: TPayload, index: number) => Promise<void>} options.sink
 * @param {number} [options.maxParallel]
 * @param {AbortSignal} [options.signal] stops scheduling new jobs; in-flight
 *   jobs still finish and are written so nothing already converted is lost
 * @param {(event: {type: string, job: TJob, index: number, error?: Error, done: number, total: number}) => void} [options.onEvent]
 * @param {(context: {signal: AbortSignal|null, index: number}) => Promise<(() => void)|void>} [options.beforeStart]
 *   admission (the hidden-job gate, #241): awaited by a lane before it claims
 *   the next index, never after, so a lane waiting here holds no index that
 *   later sinks wait for. `index` is only the next unclaimed one at the time
 *   of the call. The returned release runs once the claimed job's payload has
 *   been sunk; a rejection while `signal` is aborted counts as cancellation
 * @returns {Promise<{successCount: number, failCount: number, cancelled: boolean, results: Array<{job: TJob, index: number, ok: boolean, error?: Error}>}>}
 */
export async function runBatchPipeline(jobs, { process, sink, maxParallel = 1, signal = null, onEvent = null, beforeStart = null } = {}) {
  if (typeof process !== 'function' || typeof sink !== 'function') {
    throw new TypeError('runBatchPipeline needs process() and sink()');
  }
  const total = jobs.length;
  const width = Math.max(1, Math.min(Math.floor(maxParallel) || 1, total || 1));
  const results = new Array(total);
  const emit = (event) => { if (onEvent) onEvent(event); };
  let successCount = 0;
  let failCount = 0;
  let done = 0;
  let nextToStart = 0;
  let nextToSink = 0;
  let cancelled = false;

  const isCancelled = () => Boolean(signal && signal.aborted);
  // Written strictly in job order: a job waits here for its predecessors.
  const sinkQueue = new Map();
  let drainPromise = Promise.resolve();

  const drain = () => {
    drainPromise = drainPromise.then(async () => {
      while (sinkQueue.has(nextToSink)) {
        const index = nextToSink;
        const entry = sinkQueue.get(index);
        sinkQueue.delete(index);
        const job = jobs[index];
        if (entry.ok) {
          try {
            await sink(job, entry.payload, index);
            results[index] = { job, index, ok: true };
            successCount += 1;
            done += 1;
            emit({ type: 'done', job, index, done, total });
          } catch (error) {
            results[index] = { job, index, ok: false, error };
            failCount += 1;
            done += 1;
            emit({ type: 'error', job, index, error, done, total });
          }
        } else {
          results[index] = { job, index, ok: false, error: entry.error };
          failCount += 1;
          done += 1;
          emit({ type: 'error', job, index, error: entry.error, done, total });
        }
        nextToSink += 1;
        // Keep this lane occupied until its payload has actually been consumed.
        // A later frame may finish first, but it must not start another decode
        // while its encoded output waits behind a slow predecessor.
        entry.release();
      }
    });
    return drainPromise;
  };

  const runOne = async (index) => {
    const job = jobs[index];
    emit({ type: 'start', job, index, done, total });
    let entry;
    try {
      const payload = await process(job, index);
      entry = { ok: true, payload };
    } catch (error) {
      entry = { ok: false, error };
    }
    const consumed = new Promise(resolve => { entry.release = resolve; });
    sinkQueue.set(index, entry);
    await drain();
    await consumed;
  };

  const worker = async () => {
    while (nextToStart < total) {
      if (isCancelled()) { cancelled = true; return; }
      let release = null;
      if (beforeStart) {
        try {
          release = await beforeStart({ signal, index: nextToStart });
        } catch (error) {
          if (isCancelled()) { cancelled = true; return; }
          throw error;
        }
        // Another lane may have taken the last index, or the batch was
        // cancelled, while this one waited for admission.
        if (isCancelled() || nextToStart >= total) {
          if (typeof release === 'function') release();
          if (isCancelled()) cancelled = true;
          return;
        }
      }
      const index = nextToStart;
      nextToStart += 1;
      try {
        await runOne(index);
      } finally {
        if (typeof release === 'function') release();
      }
    }
  };

  await Promise.all(Array.from({ length: width }, () => worker()));
  await drainPromise;
  if (isCancelled()) cancelled = true;
  return { successCount, failCount, cancelled, results: results.filter(Boolean) };
}

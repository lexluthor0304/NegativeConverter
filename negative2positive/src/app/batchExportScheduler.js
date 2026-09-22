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

// One in-flight frame keeps roughly 50 bytes per pixel alive across the RAW
// decoder heap, the 16-bit source, the worker clone, the 16-bit and 8-bit
// results and the encoder canvas (measured: four 18.5 MP DNG lanes peak at
// ~3.7 GB of renderer RSS in Chrome). Budget the parallelism by pixels so a
// roll of 18 MP camera scans runs four wide, 24 MP three wide, 36 MP two wide
// and a 100 MP flatbed scan stays sequential; devices that report 4 GB or
// less get a third of that.
export const BATCH_PIXEL_BUDGET = 80_000_000;
export const BATCH_PIXEL_BUDGET_LOW_MEMORY = 28_000_000;
export const BATCH_MAX_PARALLEL = 4;
export const BATCH_LOW_MEMORY_GB = 4;

/**
 * How many files may be processed at once.
 *
 * @param {object} options
 * @param {number} [options.hardwareConcurrency] navigator.hardwareConcurrency
 * @param {number} [options.deviceMemory] navigator.deviceMemory (GB), when reported
 * @param {number} [options.pixelsPerFile] largest frame in the batch, in pixels
 * @param {number} [options.fileCount]
 * @returns {number} 1..BATCH_MAX_PARALLEL
 */
export function planBatchParallelism({
  hardwareConcurrency,
  deviceMemory,
  pixelsPerFile,
  fileCount = Infinity,
  maxParallel = BATCH_MAX_PARALLEL
} = {}) {
  const cores = Number.isFinite(hardwareConcurrency) && hardwareConcurrency > 0
    ? Math.floor(hardwareConcurrency)
    : 4;
  // The main thread and the encoder need cores of their own.
  const byCores = Math.max(1, Math.min(maxParallel, cores - 2));
  const lowMemory = Number.isFinite(deviceMemory) && deviceMemory > 0 && deviceMemory <= BATCH_LOW_MEMORY_GB;
  const budget = lowMemory ? BATCH_PIXEL_BUDGET_LOW_MEMORY : BATCH_PIXEL_BUDGET;
  const pixels = Number.isFinite(pixelsPerFile) && pixelsPerFile > 0 ? pixelsPerFile : budget;
  const byMemory = Math.max(1, Math.floor(budget / pixels));
  const byFiles = Number.isFinite(fileCount) && fileCount > 0 ? Math.floor(fileCount) : maxParallel;
  return Math.max(1, Math.min(byCores, byMemory, byFiles, maxParallel));
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
 * @returns {Promise<{successCount: number, failCount: number, cancelled: boolean, results: Array<{job: TJob, index: number, ok: boolean, error?: Error}>}>}
 */
export async function runBatchPipeline(jobs, { process, sink, maxParallel = 1, signal = null, onEvent = null } = {}) {
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
      const index = nextToStart;
      nextToStart += 1;
      await runOne(index);
    }
  };

  await Promise.all(Array.from({ length: width }, () => worker()));
  await drainPromise;
  if (isCancelled()) cancelled = true;
  return { successCount, failCount, cancelled, results: results.filter(Boolean) };
}

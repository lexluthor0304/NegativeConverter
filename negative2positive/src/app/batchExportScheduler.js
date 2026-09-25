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
 *
 * Since #256 the stages of a frame's life are budgeted apart: a frame being
 * decoded ahead of the lanes (the prepare stage), the frames the lanes
 * process, and encoded payloads waiting for their write (the byte cap).
 */

import { budgetFor, LOW_MEMORY_RAM_BYTES } from './memoryBudget.js';
import { estimateRawDecodeBytes } from './rawDecodeEstimate.js';

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
//
// #256 shrinks a lane to its processing stage (geometry, conversion, dust,
// adjustment, encode): by code accounting a 60 MP colour negative at an 81 %
// crop holds about 1.2-1.5 GB there once #250 hands the planes to the workers
// without copies and #256 releases the decoded base and the geometry output
// as soon as the conversion resolves (`releaseEarly`) and drops the unadjusted
// 16-bit plane of an 8-bit output before the adjustment: about 20-25 bytes
// per pixel. The decode is budgeted apart, in the prepare stage below.
// LANE_BYTES_PER_PIXEL keeps the old 50 until the #230 harness measures the
// new per-lane peak; the other cores go to the decode-ahead stage and the
// conversion band pool (#256).
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


// ------------------------------------------------------------------ bytes

// Unwritten payloads (#256 Part 2). A finished frame's encoded file waiting
// for its write used to hold its lane like a frame still being processed, so
// the next frame's decode waited for a 0.5-1 s desktop write or ZIP CRC. A
// lane is now released as soon as its payload fits this cap; the payload
// waits for its turn at the in-order sink and counts here until it has been
// written. A 60 MP 16-bit TIFF is about 362 MB, a JPEG about 7 MB.
export const EXPORT_MAX_UNWRITTEN_BYTES = 512 * 1024 * 1024;

// Decode-ahead admission (#256 Part 3), in estimated bytes. The ceiling is a
// placeholder until #258 supplies the renderer-wide budget; it is to be
// re-set from the per-lane peak the #230 harness measures. With a 60 MP
// photo open: the editor (~1.7 GB idle in the desktop app, measured) and its
// photo sessions (<= 0.77 GB), one processing lane (~1.5 GB at 25 B/px), one
// decode ahead (~1.8 GB) and one unwritten TIFF16 (0.36 GB) come to about
// 6.1 GB and are admitted; the pre-#256 lane (50 B/px) would reach 7.6 GB,
// at WebKit's 8 GB WebContent kill limit, and is refused.
export const DECODE_AHEAD_CEILING_BYTES = 6.5e9;
// A decoded frame waiting for its lane: the RGBA16 plane and its 8-bit mirror.
export const DECODED_BASE_BYTES_PER_PIXEL = 12;
// One processing lane after #250 and #256 Part 1, by code accounting
// (1.2-1.5 GB at 60 MP). Replace with the #230 harness measurement.
export const PROCESSING_SLOT_BYTES_PER_PIXEL = 25;

/**
 * Whether one more frame may be decoded ahead of the lanes.
 *
 * @param {object} options
 * @param {number} options.candidatePixels the frame to decode (header size)
 * @param {number[]} [options.decodingPixels] frames prepared and still decoding
 * @param {number[]} [options.waitingPixels] frames prepared and waiting for a lane
 * @param {number[]} [options.processingPixels] frames the lanes are processing
 * @param {number} [options.unwrittenBytes] encoded payloads waiting for their write
 * @param {number} [options.residentBytes] the editor's planes and photo caches
 * @param {number} [options.deviceMemory] navigator.deviceMemory (GB); WebKit reports none
 * @param {boolean} [options.hiddenLimited] the hidden-window gate limits jobs (#241)
 * @param {number} [options.ceilingBytes]
 * @returns {{admit: boolean, bytes: number, reason: 'fits'|'ceiling'|'low-memory'|'hidden'}}
 */
export function planDecodeAhead({
  candidatePixels,
  decodingPixels = [],
  waitingPixels = [],
  processingPixels = [],
  unwrittenBytes = 0,
  residentBytes = 0,
  deviceMemory,
  hiddenLimited = false,
  ceilingBytes = DECODE_AHEAD_CEILING_BYTES
} = {}) {
  if (Number.isFinite(deviceMemory) && deviceMemory > 0 && deviceMemory <= BATCH_LOW_MEMORY_GB) {
    return { admit: false, bytes: 0, reason: 'low-memory' };
  }
  // A hidden macOS window runs one item at a time (hiddenJobGate.js); the
  // lane's frame is that item.
  if (hiddenLimited) return { admit: false, bytes: 0, reason: 'hidden' };
  const count = (value) => Math.max(0, Number(value) || 0);
  const decode = (pixels) => estimateRawDecodeBytes(count(pixels), 1);
  let bytes = decode(candidatePixels);
  for (const pixels of decodingPixels) bytes += decode(pixels);
  for (const pixels of waitingPixels) bytes += count(pixels) * DECODED_BASE_BYTES_PER_PIXEL;
  for (const pixels of processingPixels) bytes += count(pixels) * PROCESSING_SLOT_BYTES_PER_PIXEL;
  bytes += count(unwrittenBytes) + count(residentBytes);
  const admit = bytes <= count(ceilingBytes);
  return { admit, bytes, reason: admit ? 'fits' : 'ceiling' };
}

/**
 * The prepare stage (#256 Part 3): frames decoded ahead of the lanes that
 * will process them. At most `depth` frames are prepared at once, whether
 * still decoding or waiting for a lane, and a new one starts only when the
 * caller offers it and `admit` agrees. A frame's prepare runs with its own
 * AbortController, linked to `signal` until a lane takes the frame: a
 * cancelled batch aborts (and so disposes the decoder of) every frame no lane
 * has taken, releases those that were ready (`dispose`), and never hands
 * them out. A failed prepare is kept and rethrown to the lane that takes the
 * frame, so only that frame fails.
 *
 * Sub-stages (#256 Part 4): a prepare may report `stage('postDecode')` when
 * its decoder is done and only the post-decode pass is left. The decode slot
 * is then free for the next frame (`decoding` counts only the frames still in
 * their decoder), and the returned promise resolves once no other frame is
 * in its post-decode pass, so each sub-stage holds one frame at a time.
 *
 * Pure. runBatchPipeline drives it for exports; other roll jobs (roll
 * analysis #252, the contact sheet #247) can offer their frames the same way.
 *
 * @param {object} options
 * @param {(job: any, context: {signal: AbortSignal, stage: (name: string) => Promise<void>}) => Promise<any>} options.prepare
 * @param {number} [options.depth] prepared frames at most
 * @param {(request: {job: any, index: number, prepared: Array<{job: any, index: number, stage: string}>}) => boolean|Promise<boolean>} [options.admit]
 * @param {(value: any, job: any) => void} [options.dispose] releases a prepared value no lane took
 * @param {AbortSignal} [options.signal] cancels the frames no lane has taken
 * @param {() => void} [options.onChange] a frame left its decoder or settled
 */
export function createPrepareStage({ prepare, depth = 1, admit = null, dispose = null, signal = null, onChange = null } = {}) {
  if (typeof prepare !== 'function') throw new TypeError('createPrepareStage needs prepare()');
  const limit = Math.max(0, Math.floor(depth) || 0);
  const entries = new Map();
  const stats = {
    offered: 0, admitted: 0, refused: 0, started: 0, taken: 0, failed: 0, aborted: 0, disposed: 0, peakPrepared: 0
  };
  let cancelled = Boolean(signal && signal.aborted);
  let postDecodeHolder = null;
  const postDecodeWaiters = [];

  const untaken = () => [...entries.values()].filter((entry) => !entry.taken && entry.state !== 'admitting');
  const decoding = () => [...entries.values()].filter((entry) => entry.state === 'running' && entry.subStage === 'decode').length;
  const changed = () => { try { onChange?.(); } catch { /* the caller's problem */ } };

  function leavePostDecode(entry) {
    if (postDecodeHolder !== entry) return;
    postDecodeHolder = null;
    const next = postDecodeWaiters.shift();
    if (next) {
      postDecodeHolder = next.entry;
      next.resolve();
    }
  }

  function enterStage(entry, name) {
    if (name !== 'postDecode' || entry.subStage !== 'decode' || entry.state !== 'running') return Promise.resolve();
    entry.subStage = 'postDecode';
    changed();
    if (!postDecodeHolder) {
      postDecodeHolder = entry;
      return Promise.resolve();
    }
    return new Promise((resolve) => postDecodeWaiters.push({ entry, resolve }));
  }

  function finish(entry) {
    entry.subStage = 'done';
    const waiting = postDecodeWaiters.findIndex((waiter) => waiter.entry === entry);
    if (waiting >= 0) postDecodeWaiters.splice(waiting, 1)[0].resolve();
    leavePostDecode(entry);
  }

  function start(entry) {
    entry.state = 'running';
    entry.subStage = 'decode';
    entry.controller = new AbortController();
    stats.started += 1;
    const context = { signal: entry.controller.signal, stage: (name) => enterStage(entry, name) };
    entry.promise = Promise.resolve()
      .then(() => prepare(entry.job, context))
      .then((value) => {
        entry.state = 'ready';
        entry.value = value;
        finish(entry);
        // Cancelled while it finished: nobody will take it.
        if (!entry.taken && (cancelled || entry.controller.signal.aborted)) discard(entry);
        changed();
        return value;
      }, (error) => {
        entry.state = 'failed';
        entry.error = error;
        finish(entry);
        if (entry.controller.signal.aborted && !entry.taken) {
          stats.aborted += 1;
          entries.delete(entry.index);
        } else {
          stats.failed += 1;
        }
        changed();
        throw error;
      });
    // Kept for the lane that takes the frame; never an unhandled rejection.
    entry.promise.catch(() => {});
    stats.peakPrepared = Math.max(stats.peakPrepared, untaken().length);
  }

  function discard(entry) {
    if (entry.discarded) return;
    entry.discarded = true;
    entries.delete(entry.index);
    if (entry.state === 'ready' && typeof dispose === 'function') {
      stats.disposed += 1;
      try { dispose(entry.value, entry.job); } catch { /* releasing is best effort */ }
    }
    entry.value = null;
  }

  function cancelUntaken() {
    cancelled = true;
    for (const entry of [...entries.values()]) {
      if (entry.taken) continue;
      if (entry.state === 'admitting') {
        entry.state = 'void';
        entries.delete(entry.index);
      } else if (entry.state === 'running') {
        entry.controller.abort(signal?.reason);
      } else if (entry.state === 'ready') {
        stats.aborted += 1;
        entry.controller.abort(signal?.reason);
        discard(entry);
      } else {
        entries.delete(entry.index);
      }
    }
    changed();
  }
  signal?.addEventListener?.('abort', cancelUntaken, { once: true });

  return {
    /**
     * Offers frame `index` for preparing. Resolves true when its prepare
     * started: depth and the decode slot allow it and `admit` agreed.
     */
    async offer(index, job) {
      stats.offered += 1;
      if (cancelled || limit === 0 || entries.has(index)) return false;
      if (untaken().length >= limit || decoding() > 0) return false;
      const entry = { index, job, state: 'admitting', subStage: null, taken: false };
      entries.set(index, entry);
      let admitted = true;
      if (typeof admit === 'function') {
        const prepared = untaken().filter((other) => other !== entry)
          .map((other) => ({ job: other.job, index: other.index, stage: other.state === 'ready' ? 'ready' : other.subStage }));
        try {
          admitted = Boolean(await admit({ job, index, prepared }));
        } catch {
          admitted = false;
        }
      }
      // A lane claimed the frame, or the batch stopped, meanwhile.
      if (entry.state !== 'admitting' || cancelled) {
        if (entries.get(index) === entry) entries.delete(index);
        return false;
      }
      if (!admitted || untaken().length >= limit || decoding() > 0) {
        if (!admitted) stats.refused += 1;
        entries.delete(index);
        return false;
      }
      stats.admitted += 1;
      start(entry);
      return true;
    },
    /**
     * The lane that processes frame `index` takes its prepared value: a
     * promise of it (rejecting with the prepare's error), or null when the
     * frame was not prepared and the lane decodes it itself. From here on a
     * cancelled batch no longer stops the frame.
     */
    take(index) {
      const entry = entries.get(index);
      if (!entry || entry.state === 'void') return null;
      if (entry.state === 'admitting') {
        entry.state = 'void';
        entries.delete(index);
        return null;
      }
      entry.taken = true;
      stats.taken += 1;
      const settle = () => { if (entries.get(index) === entry) entries.delete(index); };
      const taken = entry.promise.then((value) => { settle(); entry.value = null; return value; }, (error) => { settle(); throw error; });
      changed();
      return taken;
    },
    /** Frames prepared or being prepared that no lane has taken yet. */
    get size() { return untaken().length; },
    /** Frames (taken or not) still in their decoder. */
    get decoding() { return decoding(); },
    get cancelled() { return cancelled; },
    stats,
    /** Resolves once every prepare that was started has settled. */
    async settled() {
      const running = [...entries.values()].filter((entry) => entry.promise).map((entry) => entry.promise.catch(() => {}));
      await Promise.all(running);
      if (cancelled) for (const entry of [...entries.values()]) if (!entry.taken) discard(entry);
    },
    cancel: cancelUntaken
  };
}

/**
 * Learned import defaults keep a one-lane batch's order (#256 Part 2). Frame
 * N's sink records what the user changed on it (`learnFromExport`), and a
 * later never-analysed frame reads the learned records when it builds its
 * import settings. With lanes released early, frame N+1 would read them
 * before N's write. `before(i)` resolves once every frame before `i` that
 * may learn (`mayLearn(j)`) has settled: sunk and its learning write done,
 * or failed. Frames that learn nothing never hold anyone.
 *
 * @param {number} count jobs in the batch
 * @param {(index: number) => boolean} mayLearn
 */
export function createLearningBarrier(count, mayLearn = () => false) {
  const total = Math.max(0, Math.floor(count) || 0);
  const gates = new Array(total).fill(null);
  for (let i = 0; i < total; i++) {
    if (!mayLearn(i)) continue;
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    gates[i] = { promise, resolve, settled: false, pending: false };
  }
  return {
    before(index) {
      const waits = [];
      for (let j = 0; j < Math.min(index, total); j++) {
        if (gates[j] && !gates[j].settled) waits.push(gates[j].promise);
      }
      return waits.length ? Promise.all(waits).then(() => undefined) : Promise.resolve();
    },
    /** Frame `index` is done: after `learned` (its learning write) settles. */
    settle(index, learned = null) {
      const gate = gates[index];
      if (!gate || gate.pending) return;
      gate.pending = true;
      Promise.resolve(learned).then(() => {}, () => {}).then(() => {
        gate.settled = true;
        gate.resolve();
      });
    },
    /** Predecessors of `index` that can still hold it. */
    waitingFor(index) {
      let waiting = 0;
      for (let j = 0; j < Math.min(index, total); j++) if (gates[j] && !gates[j].settled) waiting += 1;
      return waiting;
    }
  };
}

/**
 * Run `jobs` through `process` with bounded parallelism and hand each result
 * to `sink` in job order.
 *
 * @template TJob, TPayload
 * @param {TJob[]} jobs
 * @param {object} options
 * @param {(job: TJob, index: number, prepared?: any, context?: {decoded: () => void, prepared: boolean}) => Promise<TPayload>} options.process
 *   `prepared` is the frame's prepared value when the prepare stage ran
 *   ahead for it; otherwise the job decodes itself and calls `decoded()` once
 *   its base exists, which lets the next frame's decode start
 * @param {(job: TJob, payload: TPayload, index: number) => Promise<void>} options.sink
 * @param {number} [options.maxParallel]
 * @param {AbortSignal} [options.signal] stops scheduling new jobs; in-flight
 *   jobs still finish and are written so nothing already converted is lost;
 *   frames prepared for jobs not yet started are aborted and never written
 * @param {(event: {type: string, job: TJob, index: number, error?: Error, done: number, total: number}) => void} [options.onEvent]
 * @param {(context: {signal: AbortSignal|null, index: number}) => Promise<(() => void)|void>} [options.beforeStart]
 *   admission (the hidden-job gate, #241): awaited by a lane before it claims
 *   the next index, never after, so a lane waiting here holds no index that
 *   later sinks wait for. `index` is only the next unclaimed one at the time
 *   of the call. The returned release runs once the claimed job's payload has
 *   been sunk; a rejection while `signal` is aborted counts as cancellation
 * @param {(payload: TPayload) => number} [options.payloadBytes] size of a payload
 * @param {number} [options.maxUnwrittenBytes] 0 (default): a lane is held
 *   until its own payload has been sunk (#199). Otherwise a lane is released
 *   as soon as its payload fits: unwritten payload bytes never exceed the cap
 * @param {(job: TJob, context: {signal: AbortSignal, stage: Function}) => Promise<any>} [options.prepare]
 *   decode-ahead (createPrepareStage); off unless `prepareDepth` > 0
 * @param {number} [options.prepareDepth]
 * @param {(request: object) => boolean|Promise<boolean>} [options.admitPrepare]
 *   asked before each prepare with `{ job, index, prepared, unwrittenBytes,
 *   bytes, processing }` (`bytes` is `unwrittenBytes`, `processing` the jobs
 *   the lanes hold)
 * @param {(value: any, job: TJob) => void} [options.disposePrepared]
 * @param {object} [options.stats] filled with `peakUnwrittenBytes`,
 *   `earlyReleases` and the prepare stage's counters
 * @returns {Promise<{successCount: number, failCount: number, cancelled: boolean, results: Array<{job: TJob, index: number, ok: boolean, error?: Error}>}>}
 */
export async function runBatchPipeline(jobs, {
  process, sink, maxParallel = 1, signal = null, onEvent = null, beforeStart = null,
  payloadBytes = null, maxUnwrittenBytes = 0,
  prepare = null, prepareDepth = 0, admitPrepare = null, disposePrepared = null,
  stats = null
} = {}) {
  if (typeof process !== 'function' || typeof sink !== 'function') {
    throw new TypeError('runBatchPipeline needs process() and sink()');
  }
  const total = jobs.length;
  const width = Math.max(1, Math.min(Math.floor(maxParallel) || 1, total || 1));
  const results = new Array(total);
  const emit = (event) => { if (onEvent) onEvent(event); };
  const cap = Number.isFinite(maxUnwrittenBytes) && maxUnwrittenBytes > 0 ? maxUnwrittenBytes : 0;
  let successCount = 0;
  let failCount = 0;
  let done = 0;
  let nextToStart = 0;
  let nextToSink = 0;
  let cancelled = false;
  let unwrittenBytes = 0;
  let peakUnwrittenBytes = 0;
  let earlyReleases = 0;
  // Jobs the lanes hold, and those among them still decoding their own frame.
  let processing = 0;
  let selfDecoding = 0;

  const isCancelled = () => Boolean(signal && signal.aborted);
  // Written strictly in job order: a job waits here for its predecessors.
  const sinkQueue = new Map();
  let drainPromise = Promise.resolve();

  const depth = typeof prepare === 'function' && Number.isFinite(prepareDepth) ? Math.max(0, Math.floor(prepareDepth)) : 0;
  const stage = depth > 0 && total > 1 ? createPrepareStage({
    prepare,
    depth,
    admit: typeof admitPrepare === 'function'
      ? (request) => admitPrepare({ ...request, unwrittenBytes, bytes: unwrittenBytes, processing })
      : null,
    dispose: disposePrepared,
    signal,
    onChange: () => offerPrepare()
  }) : null;

  // The next frame no lane has claimed or prepared may start decoding once
  // no frame is in a decoder: every lane's job has its base, and no prepared
  // frame is still decoding. So at most one decode runs at a time.
  function offerPrepare() {
    if (!stage || isCancelled() || selfDecoding > 0 || stage.decoding > 0) return;
    const index = nextToStart + stage.size;
    if (index >= total) return;
    void stage.offer(index, jobs[index]);
  }

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
        entry.payload = null;
        if (entry.early) {
          unwrittenBytes -= entry.bytes;
          offerPrepare();
        }
        // A lane held for its payload is freed only now: a later frame may
        // finish first, but it must not start another decode while its
        // encoded output waits behind a slow predecessor (#199), unless the
        // payload fits the byte cap (then its lane went on already).
        entry.release();
      }
    });
    return drainPromise;
  };

  // Resolves null once the job's payload has been consumed (the lane is held
  // until then), or with `{ consumed }`, a promise of that, when the payload
  // fits the byte cap and the lane may go on.
  const runOne = async (index) => {
    const job = jobs[index];
    emit({ type: 'start', job, index, done, total });
    processing += 1;
    let decodingHere = false;
    let hasBase = false;
    const noteBase = () => {
      if (hasBase) return;
      hasBase = true;
      if (decodingHere) {
        decodingHere = false;
        selfDecoding -= 1;
      }
      offerPrepare();
    };
    let entry;
    try {
      const taken = stage ? stage.take(index) : null;
      let prepared;
      if (taken) {
        prepared = await taken;
        noteBase();
      } else {
        decodingHere = true;
        selfDecoding += 1;
      }
      const payload = await process(job, index, prepared, { decoded: noteBase, prepared: Boolean(taken) });
      entry = { ok: true, payload };
    } catch (error) {
      entry = { ok: false, error };
    }
    processing -= 1;
    // A job that ended without reporting its base no longer decodes.
    if (decodingHere) {
      decodingHere = false;
      selfDecoding -= 1;
      offerPrepare();
    }
    const consumed = new Promise(resolve => { entry.release = resolve; });
    let bytes = 0;
    let early = false;
    if (cap > 0) {
      try {
        bytes = entry.ok && typeof payloadBytes === 'function' ? Math.max(0, Number(payloadBytes(entry.payload)) || 0) : 0;
        early = unwrittenBytes + bytes <= cap;
      } catch {
        early = false;
      }
    }
    if (early) {
      entry.early = true;
      entry.bytes = bytes;
      unwrittenBytes += bytes;
      peakUnwrittenBytes = Math.max(peakUnwrittenBytes, unwrittenBytes);
      earlyReleases += 1;
    }
    sinkQueue.set(index, entry);
    if (early) {
      void drain();
      return { consumed };
    }
    await drain();
    await consumed;
    return null;
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
      let early = null;
      try {
        early = await runOne(index);
      } finally {
        // An admission lasts until the payload has been sunk, even when the
        // byte cap let the lane go on before.
        if (typeof release === 'function') {
          if (early) early.consumed.then(release);
          else release();
        }
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: width }, () => worker()));
    await drainPromise;
  } finally {
    if (stage) {
      if (isCancelled()) stage.cancel();
      await stage.settled();
    }
    if (stats && typeof stats === 'object') {
      stats.peakUnwrittenBytes = peakUnwrittenBytes;
      stats.earlyReleases = earlyReleases;
      stats.prepare = stage ? { ...stage.stats } : null;
    }
  }
  if (isCancelled()) cancelled = true;
  return { successCount, failCount, cancelled, results: results.filter(Boolean) };
}

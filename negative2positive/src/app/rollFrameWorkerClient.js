/**
 * The roll-frame workers of one roll analysis (#252 parts 2 and 3).
 *
 * One worker per frame in flight, created once per roll and held across its
 * retry attempts until `dispose()`. A lane takes one for a frame with
 * `frame()`, whose adapter is the RAW loader's post-decode step (the same
 * `run`/`terminate` interface as #232's per-decode client): LibRaw's result
 * is transferred to the worker, which runs the post-decode steps, the frame
 * detection and the film-edge read on its own planes and keeps them. The
 * page gets plain data (`analysis`) and a `held` handle that builds the roll
 * sample there (or hands the planes back) once the settings are merged.
 *
 * Every failure keeps today's result for the frame:
 *  - a worker that does not answer its ping in time, or cannot take the
 *    transfer: the post-decode steps run on this thread, with the same
 *    functions, and the frame is analysed on the page as before;
 *  - a worker error that hands pixels back: finished here from that stage;
 *  - a worker that dies holding the pixels: RAW_POST_DECODE_LOST, which the
 *    loader answers with its embedded-preview path, as it does for #232;
 *  - an abort while the worker runs: that worker is terminated (the pool
 *    starts a fresh one for the next frame).
 */
import {
  runRawPostDecode, finishRawPostDecode, describeView, viewFromDescription, isTransferableRawData
} from './rawPostDecode.js';
import { answerOpenCvWorker } from './opencvRuntime.js';
import { restoreRollSample } from './rollSample.js';
import { primeFilmStats } from './filmStatsCache.js';

const READY_TIMEOUT_MS = 5000;

function lostError(message) {
  const err = new Error(message);
  err.code = 'RAW_POST_DECODE_LOST';
  return err;
}

function abortError(signal) {
  const reason = signal?.reason;
  return reason?.name === 'AbortError' ? reason : new DOMException('Roll frame was aborted', 'AbortError');
}

/** The decoded frame as the RAW loader returns it, over planes a worker handed back. */
export function imageFromRollPlanes({ width, height, rgba8, rgba16, filmStats = null }, { makeImage = (data, w, h) => new ImageData(data, w, h) } = {}) {
  const image = makeImage(rgba8, width, height);
  image.__image16 = { width, height, data: rgba16 };
  if (filmStats) primeFilmStats(image, filmStats);
  return image;
}

/**
 * @param {object} [config]
 * @param {number} [config.size] frames in flight (workers kept)
 * @param {() => Worker} [config.workerFactory]
 * @param {number} [config.readyTimeoutMs]
 * @param {(data, w, h) => object} [config.makeImage]
 */
export function createRollFramePool({
  size = 1,
  workerFactory = () => new Worker(new URL('../workers/rollFrameWorker.js', import.meta.url), { type: 'module' }),
  readyTimeoutMs = READY_TIMEOUT_MS,
  makeImage
} = {}) {
  let keep = Math.max(1, Math.floor(size) || 1);
  let disposed = false;
  let nextId = 1;
  let created = 0;
  const idle = [];
  const slots = new Set();

  function kill(slot, error) {
    if (!slot.alive) return;
    slot.alive = false;
    slots.delete(slot);
    const at = idle.indexOf(slot);
    if (at >= 0) idle.splice(at, 1);
    slot.worker.onmessage = slot.worker.onerror = slot.worker.onmessageerror = null;
    try { slot.worker.terminate(); } catch {}
    slot.settleReady(false);
    for (const entry of slot.pending.values()) entry.reject(error);
    slot.pending.clear();
  }

  function spawn() {
    let worker;
    try { worker = workerFactory(); }
    catch (error) {
      console.warn('[roll] frame worker unavailable, analysing on the page:', error?.message || error);
      return null;
    }
    created += 1;
    const slot = { worker, alive: true, pending: new Map(), settleReady: () => {} };
    slot.ready = new Promise((resolve) => { slot.settleReady = resolve; });
    worker.onmessage = ({ data }) => {
      // The worker asks for the session's compiled OpenCV module (part 5).
      if (answerOpenCvWorker(worker, data)) return;
      if (data?.type === 'pong') { slot.settleReady(true); return; }
      const entry = slot.pending.get(data?.id);
      if (!entry) return;
      slot.pending.delete(data.id);
      entry.resolve(data);
    };
    const crashed = (event) => {
      try { event?.preventDefault?.(); } catch {}
      console.warn('[roll] frame worker failed:', event?.message || event?.type || 'error');
      kill(slot, lostError('Roll-frame worker crashed'));
    };
    worker.onerror = crashed;
    worker.onmessageerror = crashed;
    slots.add(slot);
    try { worker.postMessage({ type: 'ping', id: 0 }); } catch { kill(slot, lostError('Roll-frame worker refused a message')); }
    return slot;
  }

  function send(slot, message, transfers = []) {
    return new Promise((resolve, reject) => {
      if (!slot?.alive) { reject(lostError('Roll-frame worker is gone')); return; }
      slot.pending.set(message.id, { resolve, reject });
      try { slot.worker.postMessage(message, transfers); }
      catch (error) { slot.pending.delete(message.id); reject(error); }
    });
  }

  async function ready(slot) {
    if (!slot?.alive) return false;
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), readyTimeoutMs); });
    try {
      const ok = await Promise.race([slot.ready, timeout]);
      if (!ok) console.warn('[roll] frame worker did not answer, analysing on the page');
      return Boolean(ok) && slot.alive;
    } finally {
      clearTimeout(timer);
    }
  }

  function acquire() {
    while (idle.length) {
      const slot = idle.pop();
      if (slot.alive) return slot;
    }
    return disposed ? null : spawn();
  }

  function giveBack(slot) {
    if (!slot?.alive) return;
    // More workers than frames in flight (a lane started while another
    // still finished): the extra one goes.
    if (disposed || slots.size > keep) {
      kill(slot, lostError('Roll-frame worker released'));
      return;
    }
    idle.push(slot);
  }

  /**
   * One frame's adapter. `options`: the worker's analysis request
   * `{ frame, filmTypeChoice, filmEdge }` (snapshotted when the job starts);
   * `returnPlanes(size)`: whether the page wants the planes back with the
   * analysis (a prefetch, or a base the session cache has room for).
   */
  function frame({ options = {}, returnPlanes = () => false } = {}) {
    let slot = acquire();
    let id = 0;
    let running = false;
    let wanted = false;
    let ranInWorker = false;
    let finished = false;
    const adapter = {
      analysis: null,
      held: null,
      async run(result, loaderOptions = {}, { signal = null } = {}) {
        ranInWorker = false;
        if (signal?.aborted) throw abortError(signal);
        const data = result?.data;
        const postOptions = { suppressSensorDefects: loaderOptions.suppressSensorDefects, filmStats: loaderOptions.filmStats || null };
        if (slot && isTransferableRawData(data) && !(await ready(slot))) {
          // A worker that does not answer is not asked again.
          kill(slot, lostError('Roll-frame worker did not answer'));
          slot = null;
        }
        if (!slot || !isTransferableRawData(data)) {
          if (signal?.aborted) throw abortError(signal);
          return runRawPostDecode(result, postOptions);
        }
        const shape = { width: result.width, height: result.height, bits: result.bits, colors: result.colors };
        const input = describeView(data);
        id = nextId++;
        running = true;
        let reply;
        try {
          const posting = send(slot, {
            type: 'process', id, ...shape, input,
            options: { ...postOptions, ...options, returnPlanes: Boolean(returnPlanes(shape)) }
          }, [input.buffer]);
          if (wanted) adapter.wantPlanes();
          reply = await posting;
        } catch (err) {
          if (signal?.aborted) throw abortError(signal);
          if (input.buffer.byteLength > 0) return runRawPostDecode({ ...shape, data }, postOptions);
          throw err?.code === 'RAW_POST_DECODE_LOST' ? err : lostError(err?.message || String(err));
        } finally {
          running = false;
        }
        if (reply.type === 'result') {
          ranInWorker = true;
          if (reply.garbled) return { garbled: true };
          adapter.analysis = {
            complete: Boolean(reply.complete), interrupted: Boolean(reply.interrupted),
            frameFilmType: reply.frameFilmType, filmStats: reply.filmStats || null,
            detection: reply.detection ?? null, detectionError: reply.detectionError || null,
            edge: reply.edge ?? null, edgeError: reply.edgeError || null
          };
          const outcome = { garbled: false, width: reply.width, height: reply.height, defects: reply.defects, filmStats: reply.filmStats || null };
          if (reply.planes) {
            return { ...outcome, rgba16: viewFromDescription(reply.planes.rgba16), rgba8: viewFromDescription(reply.planes.rgba8) };
          }
          adapter.held = createHeld(reply.width, reply.height, reply.filmStats || null);
          return { ...outcome, held: true };
        }
        if (signal?.aborted) throw abortError(signal);
        console.warn('[roll] frame worker failed, finishing on the page:', reply.message);
        if (reply.input) return runRawPostDecode({ ...shape, data: viewFromDescription(reply.input) }, postOptions);
        if (reply.rgba16) {
          return finishRawPostDecode({ width: shape.width, height: shape.height, data: viewFromDescription(reply.rgba16) }, postOptions, {
            from: reply.stage === 'repaired' ? 'repaired' : 'packed', defects: reply.defects || null
          });
        }
        throw lostError(reply.message || 'Roll-frame worker lost the decode');
      },
      // The loader calls this on every exit; only a run still in the worker
      // (an abort) costs the worker.
      terminate() {
        if (running && slot) {
          kill(slot, lostError('Roll-frame worker terminated'));
          slot = null;
        }
      },
      // The foreground adopts the frame: its planes, as soon as the worker
      // is between steps.
      wantPlanes() {
        wanted = true;
        if (running && slot?.alive && id) {
          try { slot.worker.postMessage({ type: 'return-planes', id }); } catch {}
        }
      },
      // The worker goes back to the pool (after the sample or a release).
      done() {
        if (finished) return;
        finished = true;
        if (adapter.held && !adapter.held.settled) adapter.held.release();
        giveBack(slot);
        slot = null;
      },
      get usesWorker() { return Boolean(slot?.alive); },
      get ranInWorker() { return ranInWorker; }
    };

    function createHeld(width, height, filmStats) {
      const frameId = id;
      const handle = {
        width, height, settled: false,
        /** The roll sample of `settings` (rollSampleSettings), built in the worker; the frame is dropped there. */
        async sample(settings, { tileMax, returnPlanes: withPlanes = false, fullSize = null } = {}) {
          if (handle.settled) throw new Error('The roll frame was already released');
          handle.settled = true;
          let reply;
          try { reply = await send(slot, { type: 'sample', id: frameId, settings, tileMax, returnPlanes: withPlanes, fullSize }); }
          finally { adapter.done(); }
          if (reply.type === 'sample') {
            const sample = restoreRollSample(reply.sample, makeImage ? { toImageData: makeImage } : undefined);
            const base = reply.planes ? imageFromRollPlanes({ width, height, filmStats, rgba8: viewFromDescription(reply.planes.rgba8), rgba16: viewFromDescription(reply.planes.rgba16) }, makeImage ? { makeImage } : undefined) : null;
            return { sample, base };
          }
          if (reply.planes) {
            const base = imageFromRollPlanes({ width, height, filmStats, rgba8: viewFromDescription(reply.planes.rgba8), rgba16: viewFromDescription(reply.planes.rgba16) }, makeImage ? { makeImage } : undefined);
            return { sample: null, base, error: new Error(reply.message) };
          }
          throw new Error(reply.message || 'The roll sample failed');
        },
        /** The frame's planes back on the page (the foreground adopts it); the worker drops it. */
        async takePlanes() {
          if (handle.settled) throw new Error('The roll frame was already released');
          handle.settled = true;
          let reply;
          try { reply = await send(slot, { type: 'release', id: frameId, returnPlanes: true }); }
          finally { adapter.done(); }
          if (!reply.planes) throw lostError('The roll frame was not held');
          return imageFromRollPlanes({ width, height, filmStats, rgba8: viewFromDescription(reply.planes.rgba8), rgba16: viewFromDescription(reply.planes.rgba16) }, makeImage ? { makeImage } : undefined);
        },
        release() {
          if (handle.settled) return;
          handle.settled = true;
          if (slot?.alive) send(slot, { type: 'release', id: frameId }).catch(() => {});
          adapter.done();
        }
      };
      return handle;
    }
    return adapter;
  }

  return {
    frame,
    /** Starts the workers and their OpenCV realms ahead of the first frame. */
    warm(count = keep) {
      const started = [];
      while (!disposed && slots.size < count) {
        const slot = spawn();
        if (!slot) break;
        idle.push(slot);
        started.push(slot);
      }
      for (const slot of [...slots]) {
        if (slot.warmed) continue;
        slot.warmed = true;
        send(slot, { type: 'warm-up', id: nextId++ }).then((reply) => { slot.opencv = reply?.opencv || null; }, () => {});
      }
      return started.length;
    },
    /** The plan changed (a recomputed frames-in-flight). */
    resize(next) {
      keep = Math.max(1, Math.floor(next) || 1);
      while (idle.length > keep) kill(idle.pop(), lostError('Roll-frame worker released'));
    },
    dispose() {
      disposed = true;
      for (const slot of [...slots]) kill(slot, lostError('Roll-frame workers released'));
      idle.length = 0;
    },
    get created() { return created; },
    // Each warmed worker's OpenCV realm: shared module or own compile, and
    // its time to cv.Mat (#252 acceptance; read by the harness).
    get realms() { return [...slots].map(slot => slot.opencv || null); },
    get alive() { return slots.size; },
    get size() { return keep; }
  };
}

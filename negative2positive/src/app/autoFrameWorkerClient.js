import { answerOpenCvWorker } from './opencvRuntime.js';
import { isSharedPlane, hasDerivedEightBit, guardSharedPlanes } from './crossOriginIsolation.js';
import { ROLL_OPENCV_REALM_BYTES } from './batchExportScheduler.js';

const abortError = () => new DOMException('Auto-frame request was superseded', 'AbortError');

// The planes of one request (#264). A shared 16-bit plane goes as it is: no
// copy and no transfer, and a frame whose 8-bit plane is that plane >>> 8
// sends no 8-bit bytes at all (`derive8`: the worker derives them). Otherwise
// the 8-bit plane (and a plain 16-bit one, when asked for) goes as before.
function framePlanes(image, { with16 = false, owned = false } = {}) {
  const data16 = image.__image16?.data;
  const shared16 = isSharedPlane(data16) ? data16 : null;
  const derive8 = Boolean(shared16) && hasDerivedEightBit(image);
  const rgba = derive8 ? undefined : (owned ? image.data : image.data.slice());
  const image16 = shared16 || (with16 && data16 ? (owned ? data16 : data16.slice()) : undefined);
  const transfers = [];
  if (rgba) transfers.push(rgba.buffer);
  if (image16 && !shared16) transfers.push(image16.buffer);
  return { rgba, image16, derive8, shared16, transfers };
}

function isDetached(buffer) {
  return typeof buffer.detached === 'boolean' ? buffer.detached : buffer.byteLength === 0;
}

// A frame result from the worker: its rotated planes become an ImageData
// again, and a frame that is the source itself (#251 `rotatedIsSource`,
// never sent back) is the caller's `source` when rotated pixels were asked
// for.
function restoreFrameResult(result, source, options) {
  if (!result) return result;
  if (result.rotatedImageData) {
    const raw = result.rotatedImageData;
    const rotated = new ImageData(raw.data, raw.width, raw.height);
    if (raw.image16) rotated.__image16 = { width: raw.width, height: raw.height, data: raw.image16 };
    result.rotatedImageData = rotated;
  } else if (result.rotatedIsSource && options?.rotatedOutput !== 'none' && !result.needsFullResolution) {
    result.rotatedImageData = source;
  }
  return result;
}

/**
 * The frame whose planes were transferred to the worker and handed back: a
 * new ImageData over the returned buffer, with every property of `previous`
 * (its untouched 16-bit plane unless that came back too). Readers that key
 * caches by the ImageData object move them with `onRebuilt`.
 */
export function rebuildTransferredImage(previous, rgba, image16 = null) {
  const rebuilt = new ImageData(rgba, previous.width, previous.height);
  for (const key of Object.getOwnPropertyNames(previous)) {
    if (key === 'data' || key === 'width' || key === 'height' || key === 'colorSpace') continue;
    Object.defineProperty(rebuilt, key, Object.getOwnPropertyDescriptor(previous, key));
  }
  if (image16) rebuilt.__image16 = { width: previous.width, height: previous.height, data: image16 };
  return rebuilt;
}

/**
 * `helperFactory` (#252 part 4, the shared foreground worker only): creates
 * one detection helper worker. `warmHelpers()` starts two and hands the
 * worker a MessagePort to each, so its frame detections spread their
 * independent stages over three workers (workers/autoFrameParallel.js).
 * Helpers see only the 1600 px preview, are released `helperIdleMs` after
 * the worker's last request, with the worker, or by `releaseHelpers()`
 * (memory pressure); one that fails to start or errors releases both, and
 * the worker then detects serially, with the same result.
 */
export function createAutoFrameWorkerClient({
  workerFactory = () => new Worker(new URL('../workers/autoFrameWorker.js', import.meta.url), { type: 'module' }),
  timeoutMs = 120000,
  idleTimeoutMs = 30000,
  helperFactory = null,
  helperIdleMs = 30000,
} = {}) {
  let worker = null, sequence = 0;
  let idleTimer = null;
  let idleHolds = 0;
  let abortReleases = 0;
  // The OpenCV heap the worker last reported (#258's ledger); 0 without one.
  let heapBytes = 0;
  let helperSet = null; // { workers, timer }
  let helperStarts = 0;
  const pending = new Map();
  function releaseHelpers({ tellWorker = true } = {}) {
    if (!helperSet) return;
    const released = helperSet;
    helperSet = null;
    clearTimeout(released.timer);
    for (const helper of released.workers) {
      helper.onmessage = helper.onerror = helper.onmessageerror = null;
      try { helper.terminate(); } catch {}
    }
    if (tellWorker && worker) {
      try { worker.postMessage({ type: 'helpers', ports: [] }); } catch {}
    }
  }
  function armHelperIdleTimer() {
    if (!helperSet) return;
    clearTimeout(helperSet.timer);
    helperSet.timer = setTimeout(() => releaseHelpers(), helperIdleMs);
    helperSet.timer.unref?.();
  }
  function fail(error) {
    clearTimeout(idleTimer);
    releaseHelpers({ tellWorker: false });
    if (worker) worker.onmessage = worker.onerror = worker.onmessageerror = null;
    worker?.terminate();
    worker = null;
    heapBytes = 0;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  }
  function armIdleTimer() {
    clearTimeout(idleTimer);
    armHelperIdleTimer();
    // A roll analysis still has frames to measure (#252): keep the realm.
    if (idleHolds > 0) return;
    idleTimer = setTimeout(() => fail(new Error('Auto-frame worker idle')), idleTimeoutMs);
    idleTimer.unref?.();
  }
  // Posts one message on the shared worker, started on demand; resolves with
  // the worker's `result`. `signal` lets a superseded photo activation drop
  // its request: a posted one settles at once and its late reply is ignored.
  // A worker that owes nobody else is terminated (#243): it holds the
  // request's full-frame copies (about 724 MB at 60 MP) until it would have
  // finished. The next request starts a fresh one; the caller may warm it up
  // while the next photo decodes. (No caller aborts an owned analyzeImport,
  // whose transferred planes would go with the worker.)
  const post = (message, transfers, { signal = null } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    try {
      clearTimeout(idleTimer);
      if (helperSet) clearTimeout(helperSet.timer);
      if (!worker) {
        worker = workerFactory();
        worker.onerror = () => fail(new Error('Auto-frame worker crashed'));
        worker.onmessageerror = () => fail(new Error('Auto-frame worker returned invalid data'));
        const started = worker;
        worker.onmessage = ({ data }) => {
          // The worker asks for the session's compiled OpenCV module (#252).
          if (answerOpenCvWorker(started, data)) return;
          if (Number.isFinite(data?.heapBytes)) heapBytes = data.heapBytes;
          const entry = pending.get(data.id);
          if (!entry) {
            // The reply to an aborted request: the worker is free again.
            if (!pending.size) armIdleTimer();
            return;
          }
          clearTimeout(entry.timer);
          pending.delete(data.id);
          if (data.taskError) {
            // The analysis itself failed (#245); the worker is fine and stays.
            const error = new Error(data.error);
            error.workerReported = true;
            entry.reject(error);
            if (!pending.size) armIdleTimer();
            return;
          }
          try {
            if (data.error) throw new Error(data.error);
            entry.resolve(data.result);
            if (!pending.size) armIdleTimer();
          } catch (error) {
            entry.reject(error);
            fail(error);
          }
        };
      }
      const id = ++sequence;
      const timer = setTimeout(() => fail(new Error('Auto-frame worker timed out')), timeoutMs);
      const onAbort = () => {
        const entry = pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(id);
        if (!pending.size && worker) {
          clearTimeout(idleTimer);
          releaseHelpers({ tellWorker: false });
          worker.onmessage = worker.onerror = worker.onmessageerror = null;
          worker.terminate();
          worker = null;
          heapBytes = 0;
          abortReleases += 1;
        }
        entry.reject(abortError());
      };
      const settle = fn => value => { signal?.removeEventListener('abort', onAbort); fn(value); };
      pending.set(id, { resolve: settle(resolve), reject: settle(reject), timer });
      signal?.addEventListener('abort', onAbort, { once: true });
      worker.postMessage({ ...message, id }, transfers);
    } catch (error) { fail(error); reject(error); }
  });

  // One analysis on copies of the planes: an aborted request never copies.
  // 'analyze-frame' sends both planes (the Auto Frame button installs the
  // rotated 16-bit planes it gets back); 'read-film-edge' the 8-bit one. A
  // shared 16-bit plane is sent instead of copies where it can be (#264).
  const request = (image, options, type = 'analyze-frame', { signal = null } = {}) => {
    if (signal?.aborted) return Promise.reject(abortError());
    let planes;
    try {
      planes = framePlanes(image, { with16: type === 'analyze-frame' });
    } catch (error) { return Promise.reject(error); }
    const { rgba, image16, derive8, transfers } = planes;
    const guard = guardSharedPlanes(`auto-frame ${type}`, [planes.shared16]);
    return post({ type, width: image.width, height: image.height, rgba, image16, derive8, options }, transfers, { signal })
      .finally(() => guard.verify())
      .then(result => (type === 'analyze-frame' ? restoreFrameResult(result, image, options) : result));
  };

  /**
   * The import analyses of one frame in one request (#251): the frame
   * detection (`frame`: analyzer options, or null) and the film-edge read
   * (`filmEdge`: reader options, or null) on the same 8-bit buffer.
   *
   * - `owned: false` (the photo on screen): one copy of the 8-bit plane.
   * - `owned: true` (a decode no one else references, e.g. a roll lane's):
   *   the 8-bit buffer is transferred without a copy and handed back; the
   *   result's `image` is the frame rebuilt over it. The caller must use
   *   that image from then on.
   * The 16-bit plane stays here. A detection that needs the exact
   * full-resolution rotation after all (`needsFullResolution`) is retried
   * once with both planes (transferred when owned, else copied).
   *
   * Resolves { image, imageLost, frame, frameError, filmEdge, filmEdgeError }.
   * A failed request reports its error per analysis; `imageLost` says that
   * the transferred planes did not come back (the frame must be decoded
   * again before anything reads it). Only an abort rejects.
   */
  request.analyzeImport = async (image, { frame = null, filmEdge = null, owned = false, signal = null } = {}) => {
    const has16 = Boolean(image.__image16?.data);
    const outcome = { image, imageLost: false, frame: null, frameError: null, filmEdge: null, filmEdgeError: null };
    const send = async (withImage16, askFrame, askEdge) => {
      if (signal?.aborted) throw abortError();
      const current = outcome.image;
      // A shared 16-bit plane (#264) goes with every request, without a copy
      // or a transfer, so the worker can rotate at full resolution at once;
      // nothing else is moved, and the frame stays the caller's.
      const { rgba, image16, derive8, shared16, transfers } = framePlanes(current, { with16: withImage16, owned });
      const moved = owned && transfers.length > 0;
      const guard = guardSharedPlanes('auto-frame analyze-import', [shared16]);
      try {
        const reply = await post({
          type: 'analyze-import', width: current.width, height: current.height, rgba, image16, derive8,
          frame: askFrame, filmEdge: askEdge, image16Omitted: has16 && !image16, returnPlanes: moved
        }, transfers, { signal });
        if (moved) outcome.image = rebuildTransferredImage(current, rgba ? reply.rgba : current.data, shared16 ? null : (reply.image16 || null));
        return reply;
      } catch (error) {
        if (moved && ((rgba && isDetached(rgba.buffer)) || (image16 && !shared16 && isDetached(image16.buffer)))) outcome.imageLost = true;
        throw error;
      } finally {
        guard.verify();
      }
    };
    let reply;
    try { reply = await send(false, frame, filmEdge); }
    catch (error) {
      if (error?.name === 'AbortError') throw error;
      if (frame) outcome.frameError = error;
      if (filmEdge) outcome.filmEdgeError = error;
      return outcome;
    }
    outcome.filmEdge = reply.filmEdge ?? null;
    outcome.filmEdgeError = reply.filmEdgeError ? new Error(reply.filmEdgeError) : null;
    let frameReply = reply;
    if (frame && reply.frame?.needsFullResolution) {
      try { frameReply = await send(true, frame, null); }
      catch (error) {
        if (error?.name === 'AbortError') throw error;
        outcome.frameError = error;
        return outcome;
      }
    }
    if (frame) {
      outcome.frameError = frameReply.frameError ? new Error(frameReply.frameError) : null;
      outcome.frame = frameReply.frameError ? null : restoreFrameResult(frameReply.frame ?? null, outcome.image, frame);
    }
    return outcome;
  };
  // A request whose buffers the page built for it (#245's analysis types):
  // they are transferred as they are, without a copy.
  request.run = (type, payload, transfers = []) => post({ ...payload, type }, transfers);
  request.dispose = () => fail(new Error('Auto-frame worker released'));
  // Two detection helpers connected to the running worker (see above).
  // Nothing happens without a helperFactory, a running worker or
  // MessageChannel; a set already connected only has its idle timer reset.
  request.warmHelpers = () => {
    if (!helperFactory || !worker || typeof MessageChannel !== 'function') return false;
    if (helperSet) { armHelperIdleTimer(); return true; }
    const workers = [];
    try {
      for (let i = 0; i < 2; i++) workers.push(helperFactory());
    } catch (error) {
      for (const helper of workers) { try { helper.terminate(); } catch {} }
      console.warn('Detection helpers unavailable, detecting serially:', error?.message || error);
      return false;
    }
    helperSet = { workers, timer: null };
    helperStarts += 1;
    const set = helperSet;
    const failed = (event) => {
      try { event?.preventDefault?.(); } catch {}
      if (helperSet === set) {
        console.warn('Detection helper failed, detecting serially:', event?.message || event?.type || 'error');
        releaseHelpers();
      }
    };
    const ports = [];
    try {
      for (const helper of workers) {
        // The helper asks for the session's compiled OpenCV module (part 5).
        helper.onmessage = ({ data }) => { answerOpenCvWorker(helper, data); };
        helper.onerror = failed;
        helper.onmessageerror = failed;
        const channel = new MessageChannel();
        helper.postMessage({ type: 'port', port: channel.port2 }, [channel.port2]);
        helper.postMessage({ type: 'warm-up' });
        ports.push(channel.port1);
      }
      worker.postMessage({ type: 'helpers', ports }, ports);
    } catch (error) {
      console.warn('Detection helpers could not be connected, detecting serially:', error?.message || error);
      releaseHelpers();
      return false;
    }
    armHelperIdleTimer();
    return true;
  };
  request.releaseHelpers = () => releaseHelpers();
  Object.defineProperty(request, 'helpersAlive', { get: () => Boolean(helperSet) });
  Object.defineProperty(request, 'helperStarts', { get: () => helperStarts });
  // While any hold is taken, an idle worker is not released after
  // idleTimeoutMs (#252: a roll analysis with frames left keeps OpenCV warm
  // for a cold switch). The returned function ends this hold; the last one
  // re-arms the idle release of an idle worker.
  request.holdIdle = () => {
    idleHolds += 1;
    clearTimeout(idleTimer);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      idleHolds -= 1;
      if (!idleHolds && worker && !pending.size) armIdleTimer();
    };
  };
  // How many workers an abort terminated, and whether one is running now.
  Object.defineProperty(request, 'abortReleases', { get: () => abortReleases });
  Object.defineProperty(request, 'alive', { get: () => Boolean(worker) });
  // The memory ledger's worker resident (#258): the OpenCV heap while a
  // worker lives, whether it has work, and a release for the idle check
  // (the next request starts a fresh worker).
  Object.defineProperty(request, 'residentBytes', { get: () => (worker ? heapBytes : 0) });
  Object.defineProperty(request, 'busy', { get: () => pending.size > 0 });
  Object.defineProperty(request, 'held', { get: () => idleHolds > 0 });
  // A roll analysis's hold (#252) keeps it through the idle check too.
  request.releaseIdle = () => {
    if (!worker || pending.size || idleHolds) return false;
    fail(new Error('Auto-frame worker released while idle'));
    return true;
  };
  return request;
}

export const analyzeFrameInWorker = createAutoFrameWorkerClient({
  helperFactory: () => new Worker(new URL('../workers/autoFrameHelperWorker.js', import.meta.url), { type: 'module' })
});

// The page's OpenCV analyses on the shared foreground worker (never a roll
// lane): see openCvAnalysisTasks.js.
export const runAnalysisInWorker = (type, payload, transfers) => analyzeFrameInWorker.run(type, payload, transfers);

// Starts the shared worker and loads OpenCV ahead of the first detection.
// Safe to call repeatedly; failures are ignored (the detection will load it).
// `helpers` also starts its two detection helpers (#252 part 4): for a
// detection that is about to run (a first import, a cold open of a frame
// without auto-frame results, the Auto Frame button).
export function warmUpAutoFrameWorker({ helpers = false } = {}) {
  if (typeof Worker !== 'function' || typeof OffscreenCanvas !== 'function') return Promise.resolve(false);
  const pixel = { width: 1, height: 1, data: new Uint8ClampedArray(4) };
  const warming = analyzeFrameInWorker(pixel, {}, 'warm-up').then(() => true, () => false);
  if (helpers) analyzeFrameInWorker.warmHelpers();
  return warming;
}

/**
 * Several auto-frame workers for the import roll analysis: each lane gets
 * the analyzer with the fewest requests in flight, so frames of a roll are
 * detected side by side instead of queueing on the single shared worker.
 * `dispose()` releases every worker once the roll is done (each holds an
 * OpenCV heap).
 */
export function createAutoFrameWorkerPool({ size = 2, workerFactory } = {}) {
  const laneCount = Math.max(1, Math.floor(size) || 1);
  const options = workerFactory ? { workerFactory } : {};
  const lanes = Array.from({ length: laneCount }, () => ({ inFlight: 0, analyze: createAutoFrameWorkerClient(options) }));
  let disposed = false;
  async function onLane(run) {
    if (disposed) throw new Error('Auto-frame worker pool was released');
    let lane = lanes[0];
    for (const candidate of lanes) if (candidate.inFlight < lane.inFlight) lane = candidate;
    lane.inFlight += 1;
    try {
      return await run(lane.analyze);
    } finally {
      lane.inFlight -= 1;
    }
  }
  const analyze = (image, analyzeOptions, type = 'analyze-frame') => onLane(client => client(image, analyzeOptions, type));
  return {
    size: laneCount,
    // In-flight requests are covered by their lane claims; idle OpenCV
    // heaps remain resident until the pool is disposed or its clients idle.
    // Some OpenCV builds do not expose HEAPU8; never count a live realm as 0.
    get idleResidentBytes() {
      return lanes.reduce((bytes, lane) => bytes + (!lane.inFlight && lane.analyze.alive
        ? Math.max(ROLL_OPENCV_REALM_BYTES, lane.analyze.residentBytes) : 0), 0);
    },
    analyze,
    // Frame and film edge of one frame on one lane's worker, one buffer.
    analyzeImport: (image, importOptions) => onLane(client => client.analyzeImport(image, importOptions)),
    dispose() {
      disposed = true;
      // A rejected ping-sized request is enough to make the client terminate
      // its worker: fail() runs on every path, including our own error.
      for (const lane of lanes) lane.analyze.dispose?.();
    }
  };
}

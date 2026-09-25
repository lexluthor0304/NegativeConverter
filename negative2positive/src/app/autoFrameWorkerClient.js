import { answerOpenCvWorker } from './opencvRuntime.js';

const abortError = () => new DOMException('Auto-frame request was superseded', 'AbortError');

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

export function createAutoFrameWorkerClient({
  workerFactory = () => new Worker(new URL('../workers/autoFrameWorker.js', import.meta.url), { type: 'module' }),
  timeoutMs = 120000,
  idleTimeoutMs = 30000,
} = {}) {
  let worker = null, sequence = 0;
  let idleTimer = null;
  let abortReleases = 0;
  // The OpenCV heap the worker last reported (#258's ledger); 0 without one.
  let heapBytes = 0;
  const pending = new Map();
  function fail(error) {
    clearTimeout(idleTimer);
    if (worker) worker.onmessage = worker.onerror = worker.onmessageerror = null;
    worker?.terminate();
    worker = null;
    heapBytes = 0;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  }
  function armIdleTimer() {
    clearTimeout(idleTimer);
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
  // rotated 16-bit planes it gets back); 'read-film-edge' the 8-bit one.
  const request = (image, options, type = 'analyze-frame', { signal = null } = {}) => {
    if (signal?.aborted) return Promise.reject(abortError());
    let rgba, image16;
    try {
      rgba = image.data.slice();
      image16 = type === 'analyze-frame' ? image.__image16?.data.slice() : undefined;
    } catch (error) { return Promise.reject(error); }
    const transfers = [rgba.buffer];
    if (image16) transfers.push(image16.buffer);
    return post({ type, width: image.width, height: image.height, rgba, image16, options }, transfers, { signal })
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
      const rgba = owned ? current.data : current.data.slice();
      const image16 = withImage16 && has16 ? (owned ? current.__image16.data : current.__image16.data.slice()) : undefined;
      const transfers = [rgba.buffer];
      if (image16) transfers.push(image16.buffer);
      try {
        const reply = await post({
          type: 'analyze-import', width: current.width, height: current.height, rgba, image16,
          frame: askFrame, filmEdge: askEdge, image16Omitted: has16 && !image16, returnPlanes: owned
        }, transfers, { signal });
        if (owned) outcome.image = rebuildTransferredImage(current, reply.rgba, reply.image16 || null);
        return reply;
      } catch (error) {
        if (owned && (isDetached(rgba.buffer) || (image16 && isDetached(image16.buffer)))) outcome.imageLost = true;
        throw error;
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
  // How many workers an abort terminated, and whether one is running now.
  Object.defineProperty(request, 'abortReleases', { get: () => abortReleases });
  Object.defineProperty(request, 'alive', { get: () => Boolean(worker) });
  // The memory ledger's worker resident (#258): the OpenCV heap while a
  // worker lives, whether it has work, and a release for the idle check
  // (the next request starts a fresh worker).
  Object.defineProperty(request, 'residentBytes', { get: () => (worker ? heapBytes : 0) });
  Object.defineProperty(request, 'busy', { get: () => pending.size > 0 });
  request.releaseIdle = () => {
    if (!worker || pending.size) return false;
    fail(new Error('Auto-frame worker released while idle'));
    return true;
  };
  return request;
}

export const analyzeFrameInWorker = createAutoFrameWorkerClient();

// The page's OpenCV analyses on the shared foreground worker (never a roll
// lane): see openCvAnalysisTasks.js.
export const runAnalysisInWorker = (type, payload, transfers) => analyzeFrameInWorker.run(type, payload, transfers);

// Starts the shared worker and loads OpenCV ahead of the first detection.
// Safe to call repeatedly; failures are ignored (the detection will load it).
export function warmUpAutoFrameWorker() {
  if (typeof Worker !== 'function' || typeof OffscreenCanvas !== 'function') return Promise.resolve(false);
  const pixel = { width: 1, height: 1, data: new Uint8ClampedArray(4) };
  return analyzeFrameInWorker(pixel, {}, 'warm-up').then(() => true, () => false);
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

export function createAutoFrameWorkerClient({
  workerFactory = () => new Worker(new URL('../workers/autoFrameWorker.js', import.meta.url), { type: 'module' }),
  timeoutMs = 120000,
  idleTimeoutMs = 30000,
} = {}) {
  let worker = null, sequence = 0;
  let idleTimer = null;
  const pending = new Map();
  function fail(error) {
    clearTimeout(idleTimer);
    if (worker) worker.onmessage = worker.onerror = worker.onmessageerror = null;
    worker?.terminate();
    worker = null;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  }
  const request = (image, options, type = 'analyze-frame') => new Promise((resolve, reject) => {
    try {
      clearTimeout(idleTimer);
      if (!worker) {
        worker = workerFactory();
        worker.onerror = () => fail(new Error('Auto-frame worker crashed'));
        worker.onmessageerror = () => fail(new Error('Auto-frame worker returned invalid data'));
        worker.onmessage = ({ data }) => {
          const entry = pending.get(data.id);
          if (!entry) return;
          clearTimeout(entry.timer);
          pending.delete(data.id);
          try {
            if (data.error) throw new Error(data.error);
            const result = data.result;
            if (result?.rotatedImageData) {
              const raw = result.rotatedImageData;
              const rotated = new ImageData(raw.data, raw.width, raw.height);
              if (raw.image16) rotated.__image16 = { width: raw.width, height: raw.height, data: raw.image16 };
              result.rotatedImageData = rotated;
            }
            entry.resolve(result);
            if (!pending.size) {
              idleTimer = setTimeout(() => fail(new Error('Auto-frame worker idle')), idleTimeoutMs);
              idleTimer.unref?.();
            }
          } catch (error) {
            entry.reject(error);
            fail(error);
          }
        };
      }
      const id = ++sequence;
      const timer = setTimeout(() => fail(new Error('Auto-frame worker timed out')), timeoutMs);
      pending.set(id, { resolve, reject, timer });
      const rgba = image.data.slice();
      const image16 = type === 'analyze-frame' ? image.__image16?.data.slice() : undefined;
      const transfers = [rgba.buffer];
      if (image16) transfers.push(image16.buffer);
      worker.postMessage({ type, id, width: image.width, height: image.height, rgba, image16, options }, transfers);
    } catch (error) { fail(error); reject(error); }
  });
  request.dispose = () => fail(new Error('Auto-frame worker released'));
  return request;
}

export const analyzeFrameInWorker = createAutoFrameWorkerClient();

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
  async function analyze(image, analyzeOptions, type = 'analyze-frame') {
    if (disposed) throw new Error('Auto-frame worker pool was released');
    let lane = lanes[0];
    for (const candidate of lanes) if (candidate.inFlight < lane.inFlight) lane = candidate;
    lane.inFlight += 1;
    try {
      return await lane.analyze(image, analyzeOptions, type);
    } finally {
      lane.inFlight -= 1;
    }
  }
  return {
    size: laneCount,
    analyze,
    readFilmEdge: (image, readOptions = {}) => analyze(image, readOptions, 'read-film-edge'),
    dispose() {
      disposed = true;
      // A rejected ping-sized request is enough to make the client terminate
      // its worker: fail() runs on every path, including our own error.
      for (const lane of lanes) lane.analyze.dispose?.();
    }
  };
}
// Shares the auto-frame worker so the full-resolution image is posted to a
// single worker instance; the film edge reader does not need OpenCV.
export const readFilmEdgeInWorker = (image, options = {}) => analyzeFrameInWorker(image, options, 'read-film-edge');

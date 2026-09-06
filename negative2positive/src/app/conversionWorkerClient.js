/**
 * Promise bridge to the conversion worker. Callers should fall back to the
 * main-thread convertFrameWithRouter when convertFrameInWorker rejects
 * (worker creation blocked, crash, structured-clone failure...).
 */

// Callers fall back to the main thread when this module rejects, and some of
// them disable the worker for the rest of the session. Only an infrastructure
// failure justifies that; a conversion that threw inside the worker would throw
// on the main thread too, and giving up on the worker for it costs every later
// full-resolution render a frozen UI.
export const WORKER_UNAVAILABLE = 'WORKER_UNAVAILABLE';
export const WORKER_CRASHED = 'WORKER_CRASHED';
export const CONVERSION_FAILED = 'CONVERSION_FAILED';
export const WORKER_TIMEOUT = 'WORKER_TIMEOUT';

// A worker that never answers used to leave the caller's promise pending for
// the rest of the session, so the loading overlay and any export waiting on it
// hung forever. Scale the deadline with the frame size, matching workerBridge.
const TIMEOUT_BASE_MS = 30_000;
const TIMEOUT_PER_MEGAPIXEL_MS = 1_000;
const TIMEOUT_MAX_MS = 600_000;

function conversionTimeoutMs(pixelCount) {
  const megapixels = Math.max(0, Number(pixelCount) || 0) / 1_000_000;
  return Math.min(TIMEOUT_MAX_MS, TIMEOUT_BASE_MS + Math.ceil(megapixels * TIMEOUT_PER_MEGAPIXEL_MS));
}

function workerError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// 原寸の書き出しと操作中のプレビューでキューを共有しない。
export function createConversionWorkerClient({ cacheInput = false, workerFactory = () => new Worker(
  new URL('../workers/conversionWorker.js', import.meta.url), { type: 'module' }
) } = {}) {
  let worker = null;
  let requestId = 0;
  const pending = new Map();
  let lastSource = null;
  let lastAnalysis = null;
  function getWorker() {
    if (worker) return worker;
    worker = workerFactory();
    lastSource = null;
    lastAnalysis = null;
    const currentWorker = worker;
    worker.onmessage = (e) => {
      const msg = e.data;
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.type === 'result') entry.resolve(msg);
      else entry.reject(workerError(msg.message || 'Conversion worker error', CONVERSION_FAILED));
    };
    worker.onerror = (err) => {
      if (worker !== currentWorker) return;
      console.error('Conversion worker crashed:', err);
      for (const [id, entry] of pending) {
        entry.reject(workerError('Conversion worker crashed', WORKER_CRASHED));
        pending.delete(id);
      }
      try { worker.terminate(); } catch {}
      worker = null;
    };
    return worker;
  }

  /**
   * Run convertFrameWithRouter in the worker.
   * Returns an ImageData with __image16 attached (same contract as the router).
   */
  return async function convert({ imageData, settings, options = {} }) {

    let w;
    try {
      w = getWorker();
    } catch (err) {
      throw workerError(`Conversion worker could not start: ${err?.message || err}`, WORKER_UNAVAILABLE);
    }
    const id = ++requestId;
    const message = {
      type: 'convert',
      id,
      width: imageData.width,
      height: imageData.height,
      settings,
      options: { ...options }
    };

    const analysis = options.analysisImageData || null;
    if (cacheInput) {
      message.cacheInput = true;
      message.reuseSource = lastSource === imageData;
      message.reuseAnalysis = lastAnalysis === analysis;
      if (message.reuseAnalysis) delete message.options.analysisImageData;
    }

    // The adapter works from __image16 when present, so for genuinely 16-bit
    // sources we skip cloning the redundant 8-bit plane (~370 MB on big scans).
    const src16 = imageData.__image16;
    const exactBuffer = (data) => data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
      ? data.buffer : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    if (!message.reuseSource) {
      if (src16 && src16.data instanceof Uint16Array) {
        message.image16 = exactBuffer(src16.data);
      } else {
        message.rgba = exactBuffer(imageData.data);
      }
    }
    // No transfer list: the caller keeps using its source buffers, so they are
    // structured-cloned. That copy blocks the poster briefly but frees the main
    // thread from the seconds-long conversion itself.

    const timeoutMs = conversionTimeoutMs(imageData.width * imageData.height);
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        // Drop this worker so the next call gets a fresh one, but only if it is
        // still the current one: an earlier failure may already have replaced it,
        // and terminating that would kill a healthy worker.
        if (worker === w) {
          try { w.terminate(); } catch { /* already gone */ }
          worker = null;
          // Everything else queued on this worker will never answer either.
          for (const [otherId, entry] of pending) {
            pending.delete(otherId);
            entry.reject(workerError('Conversion worker was terminated after a timeout', WORKER_TIMEOUT));
          }
        }
        reject(workerError(`Conversion worker timed out after ${Math.round(timeoutMs / 1000)}s`, WORKER_TIMEOUT));
      }, timeoutMs);
      const settle = (fn) => (value) => { clearTimeout(timer); fn(value); };
      pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      try {
        w.postMessage(message);
        if (cacheInput) {
          lastSource = imageData;
          lastAnalysis = analysis;
        }
      } catch (err) {
        // A structured-clone failure means this worker can never take our data.
        clearTimeout(timer);
        pending.delete(id);
        reject(workerError(`Conversion worker postMessage failed: ${err?.message || err}`, WORKER_UNAVAILABLE));
      }
    });

    const out = new ImageData(
      new Uint8ClampedArray(result.rgba),
      result.width,
      result.height
    );
    if (result.image16) {
      out.__image16 = {
        width: result.width,
        height: result.height,
        data: new Uint16Array(result.image16)
      };
    }
    if (result.analysisPreview) {
      const sample = result.analysisPreview;
      out.__analysisPreview = new ImageData(new Uint8ClampedArray(sample.rgba), sample.width, sample.height);
    }
    return out;
  };
}

export const convertFrameInWorker = createConversionWorkerClient();
export const convertPreviewFrameInWorker = createConversionWorkerClient({ cacheInput: true });

/**
 * Worker Bridge — Promise-based API for communicating with the export Worker.
 * Falls back to main-thread execution when Workers are unavailable.
 *
 * Every request is bounded by a timeout and can be cancelled through an
 * AbortSignal. A Worker that stalls without throwing (a lost message, a renderer
 * OOM-kill that fires no `error` event, a runaway loop) would otherwise leave
 * the export overlay spinning forever.
 */

import { selectExportSamples } from './imageEncoders.js';
import { computeAdjustmentParams, isIdentityAdjustmentParams } from './pixelAdjustments.js';

let worker = null;
let requestId = 0;
const pending = new Map();

/** Base allowance for a request, plus a per-megapixel allowance on top. */
export const WORKER_TIMEOUT_BASE_MS = 30_000;
export const WORKER_TIMEOUT_PER_MEGAPIXEL_MS = 1_000;
export const WORKER_TIMEOUT_MAX_MS = 600_000;

export function computeWorkerTimeoutMs(pixelCount) {
  const megapixels = Math.max(0, Number(pixelCount) || 0) / 1_000_000;
  return Math.min(
    WORKER_TIMEOUT_MAX_MS,
    WORKER_TIMEOUT_BASE_MS + Math.ceil(megapixels * WORKER_TIMEOUT_PER_MEGAPIXEL_MS)
  );
}

function makeError(message, name) {
  const err = new Error(message);
  err.name = name;
  return err;
}

export function isAbortError(err) {
  return Boolean(err) && err.name === 'AbortError';
}

export function isWorkerTimeoutError(err) {
  return Boolean(err) && err.name === 'WorkerTimeoutError';
}

function settleEntry(id, entry) {
  pending.delete(id);
  if (entry.timer !== null) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  if (entry.detachAbort) {
    entry.detachAbort();
    entry.detachAbort = null;
  }
}

function rejectAllPending(error) {
  for (const [id, entry] of Array.from(pending)) {
    settleEntry(id, entry);
    entry.reject(error);
  }
  pending.clear();
}

/**
 * Drop the current Worker. The instance is terminated (not merely dropped) so a
 * crashed-but-alive Worker does not keep its heap until page unload.
 */
function disposeWorker() {
  const dying = worker;
  worker = null;
  if (!dying) return;
  try {
    dying.terminate();
  } catch {
    // Terminating a dead worker is not actionable.
  }
}

function getWorker() {
  if (worker) return worker;
  try {
    worker = new Worker(
      new URL('./exportWorker.js', import.meta.url),
      { type: 'module' }
    );
    worker.onmessage = handleWorkerMessage;
    worker.onmessageerror = () => {
      // The event carries no usable payload, so the failing request cannot be
      // identified — fail everything in flight rather than stranding it.
      console.error('Export worker message could not be deserialized');
      disposeWorker();
      rejectAllPending(new Error('Worker message could not be deserialized'));
    };
    worker.onerror = (err) => {
      console.error('Export worker error:', err);
      disposeWorker();
      rejectAllPending(new Error('Worker crashed'));
    };
    return worker;
  } catch (err) {
    console.warn('Failed to create export worker, will use main thread:', err);
    worker = null;
    return null;
  }
}

function handleWorkerMessage(e) {
  const msg = e.data;
  const entry = pending.get(msg.id);
  if (!entry) return;

  switch (msg.type) {
    case 'progress':
      if (entry.onProgress) {
        entry.onProgress(msg.percent, msg.phase);
      }
      break;
    case 'result':
      settleEntry(msg.id, entry);
      entry.resolve({
        data: new Uint8ClampedArray(msg.data),
        width: msg.width,
        height: msg.height
      });
      break;
    case 'blobResult':
      settleEntry(msg.id, entry);
      entry.resolve(msg.blob);
      break;
    case 'error':
      settleEntry(msg.id, entry);
      entry.reject(new Error(msg.message));
      break;
  }
}

/**
 * @param {object} message
 * @param {Transferable[]} [transfers]
 * @param {function} [onProgress]
 * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
 */
function sendToWorker(message, transfers, onProgress, options = {}) {
  return new Promise((resolve, reject) => {
    const { signal } = options;
    if (signal && signal.aborted) {
      reject(makeError('Worker request aborted', 'AbortError'));
      return;
    }

    const w = getWorker();
    if (!w) {
      reject(new Error('Worker unavailable'));
      return;
    }

    const id = ++requestId;
    message.id = id;
    const entry = { resolve, reject, onProgress, timer: null, detachAbort: null };
    pending.set(id, entry);

    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : WORKER_TIMEOUT_BASE_MS;
    if (timeoutMs > 0) {
      entry.timer = setTimeout(() => {
        if (!pending.has(id)) return;
        // A hung worker cannot be reasoned with: kill it and let the next call
        // spin up a fresh one.
        console.warn(`Export worker request ${message.type} timed out after ${timeoutMs}ms`);
        disposeWorker();
        settleEntry(id, entry);
        entry.reject(makeError(`Worker request timed out after ${timeoutMs}ms`, 'WorkerTimeoutError'));
        rejectAllPending(makeError('Worker terminated after a timed-out request', 'WorkerTimeoutError'));
      }, timeoutMs);
      // Never hold a Node process (or the test runner) open on this timer.
      if (typeof entry.timer === 'object' && entry.timer && typeof entry.timer.unref === 'function') {
        entry.timer.unref();
      }
    }

    if (signal) {
      const onAbort = () => {
        if (!pending.has(id)) return;
        // The worker is single-threaded and already busy; the only way to free
        // it is to terminate it.
        disposeWorker();
        settleEntry(id, entry);
        entry.reject(makeError('Worker request aborted', 'AbortError'));
        rejectAllPending(makeError('Worker terminated by cancellation', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      entry.detachAbort = () => signal.removeEventListener('abort', onAbort);
    }

    try {
      w.postMessage(message, transfers || []);
    } catch (err) {
      // A synchronous postMessage failure (e.g. DataCloneError) must not leave
      // the id in `pending` forever.
      settleEntry(id, entry);
      entry.reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Serialize settings for worker transfer.
 * Curves are copied as Uint8Array (structured clone handles them natively).
 */
function serializeSettings(settings) {
  const copy = { ...settings };
  if (copy.curves) {
    copy.curves = {
      r: new Uint8Array(copy.curves.r),
      g: new Uint8Array(copy.curves.g),
      b: new Uint8Array(copy.curves.b)
    };
  }
  return copy;
}

function copyTypedArrayBuffer(view) {
  const { buffer, byteOffset, byteLength } = view;
  return buffer.slice(byteOffset, byteOffset + byteLength);
}

function copyImageDataBuffer(imageData) {
  return copyTypedArrayBuffer(imageData.data);
}

/**
 * Pick the sample plane to encode from and copy it for transfer. Returns the
 * detached-on-transfer buffer plus the bit depth it holds, so the worker can
 * view it as the right typed array.
 */
function copyExportSamples(imageData, bitDepth) {
  const { samples, sampleBits } = selectExportSamples(imageData, bitDepth);
  return { buffer: copyTypedArrayBuffer(samples), sampleBits };
}

function normalizeRequestOptions(onProgressOrOptions) {
  if (typeof onProgressOrOptions === 'function') return { onProgress: onProgressOrOptions };
  return onProgressOrOptions || {};
}

function requestOptionsFor(imageData, opts) {
  return {
    timeoutMs: Number.isFinite(opts.timeoutMs)
      ? opts.timeoutMs
      : computeWorkerTimeoutMs(imageData.width * imageData.height),
    signal: opts.signal
  };
}

/**
 * Apply adjustments to image data via Worker.
 * @param {ImageData} imageData
 * @param {object} settings - Sanitized settings with curves
 * @param {string} quality - 'preview' or 'full'
 * @param {function|{onProgress?:function,signal?:AbortSignal,timeoutMs?:number}} [onProgressOrOptions]
 * @returns {Promise<ImageData|null>} null when the worker failed and the caller
 *   should fall back to the main thread. Cancellation rejects instead, so a
 *   cancelled export does not silently redo the work on the main thread.
 */
export async function workerApplyAdjustments(imageData, settings, quality = 'full', onProgressOrOptions = null) {
  const opts = normalizeRequestOptions(onProgressOrOptions);
  // Must copy: if worker fails, caller's fallback still needs the original buffer.
  const inputBuffer = copyImageDataBuffer(imageData);

  try {
    const result = await sendToWorker(
      {
        type: 'applyAdjustments',
        inputBuffer,
        width: imageData.width,
        height: imageData.height,
        settings: serializeSettings(settings),
        quality
      },
      [inputBuffer],
      opts.onProgress,
      requestOptionsFor(imageData, opts)
    );
    const output = new ImageData(result.data, result.width, result.height);
    // The adjustment stage is 8-bit only. When it is a no-op the engine's
    // 16-bit plane is still an exact description of the result, so keep it
    // attached for the exporter; otherwise it must be dropped as stale.
    if (imageData.__image16 && settings && settings.curves
      && isIdentityAdjustmentParams(computeAdjustmentParams(settings))) {
      output.__image16 = imageData.__image16;
    }
    return output;
  } catch (err) {
    if (isAbortError(err)) throw err;
    // Fallback to main thread
    return null;
  }
}

/**
 * Encode 16-bit PNG via Worker.
 * @param {ImageData} imageData
 * @param {function|{onProgress?:function,signal?:AbortSignal,timeoutMs?:number}} [onProgressOrOptions]
 * @returns {Promise<Blob|null>}
 */
export async function workerEncodePng16(imageData, onProgressOrOptions = null) {
  const opts = normalizeRequestOptions(onProgressOrOptions);
  // Transfer a copy so worker success/failure never detaches the caller's ImageData.
  const { buffer, sampleBits } = copyExportSamples(imageData, 16);

  try {
    return await sendToWorker(
      {
        type: 'encodePng16',
        pixelData: buffer,
        sourceBits: sampleBits,
        width: imageData.width,
        height: imageData.height
      },
      [buffer],
      opts.onProgress,
      requestOptionsFor(imageData, opts)
    );
  } catch (err) {
    if (isAbortError(err)) throw err;
    return null;
  }
}

/**
 * Encode TIFF via Worker.
 * @param {ImageData} imageData
 * @param {number} bitDepth
 * @param {function|{onProgress?:function,signal?:AbortSignal,timeoutMs?:number}} [onProgressOrOptions]
 * @returns {Promise<Blob|null>}
 */
export async function workerEncodeTiff(imageData, bitDepth = 8, onProgressOrOptions = null, metadata = null) {
  const opts = normalizeRequestOptions(onProgressOrOptions);
  // Transfer a copy so worker success/failure never detaches the caller's ImageData.
  const { buffer, sampleBits } = copyExportSamples(imageData, bitDepth);

  try {
    return await sendToWorker(
      {
        type: 'encodeTiff',
        pixelData: buffer,
        sourceBits: sampleBits,
        width: imageData.width,
        height: imageData.height,
        bitDepth,
        // Analog metadata (EXIF fields + XMP packet) written into the IFD.
        metadata: metadata || null
      },
      [buffer],
      opts.onProgress,
      requestOptionsFor(imageData, opts)
    );
  } catch (err) {
    if (isAbortError(err)) throw err;
    return null;
  }
}

/**
 * Check if the export worker is available.
 */
export function isWorkerAvailable() {
  return getWorker() !== null;
}

/**
 * Cancel every in-flight request without tearing the bridge down permanently.
 * The Worker is terminated (there is no way to interrupt a running encode) and
 * the next call transparently spins up a fresh one.
 */
export function cancelWorkerRequests(reason = 'Worker request cancelled') {
  disposeWorker();
  rejectAllPending(makeError(reason, 'AbortError'));
}

/**
 * Terminate the worker (cleanup).
 */
export function terminateWorker() {
  disposeWorker();
  rejectAllPending(new Error('Worker terminated'));
}

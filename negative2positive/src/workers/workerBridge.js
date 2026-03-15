/**
 * Worker Bridge — Promise-based API for communicating with the export Worker.
 * Falls back to main-thread execution when Workers are unavailable.
 */

let worker = null;
let requestId = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  try {
    worker = new Worker(
      new URL('./exportWorker.js', import.meta.url),
      { type: 'module' }
    );
    worker.onmessage = handleWorkerMessage;
    worker.onerror = (err) => {
      console.error('Export worker error:', err);
      // Reject all pending requests
      for (const [id, entry] of pending) {
        entry.reject(new Error('Worker crashed'));
        pending.delete(id);
      }
      worker = null;
    };
    return worker;
  } catch (err) {
    console.warn('Failed to create export worker, will use main thread:', err);
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
      pending.delete(msg.id);
      entry.resolve({
        data: new Uint8ClampedArray(msg.data),
        width: msg.width,
        height: msg.height
      });
      break;
    case 'blobResult':
      pending.delete(msg.id);
      entry.resolve(msg.blob);
      break;
    case 'error':
      pending.delete(msg.id);
      entry.reject(new Error(msg.message));
      break;
  }
}

function sendToWorker(message, transfers, onProgress) {
  return new Promise((resolve, reject) => {
    const w = getWorker();
    if (!w) {
      reject(new Error('Worker unavailable'));
      return;
    }
    const id = ++requestId;
    message.id = id;
    pending.set(id, { resolve, reject, onProgress });
    w.postMessage(message, transfers || []);
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

/**
 * Apply adjustments to image data via Worker.
 * @param {ImageData} imageData
 * @param {object} settings - Sanitized settings with curves
 * @param {string} quality - 'preview' or 'full'
 * @param {function} [onProgress] - Optional progress callback(percent, phase)
 * @returns {Promise<ImageData>}
 */
export async function workerApplyAdjustments(imageData, settings, quality = 'full', onProgress = null) {
  // Must copy: if worker fails, caller's fallback still needs the original buffer.
  const inputBuffer = imageData.data.buffer.slice(0);

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
      onProgress
    );
    return new ImageData(result.data, result.width, result.height);
  } catch {
    // Fallback to main thread
    return null;
  }
}

/**
 * Encode 16-bit PNG via Worker.
 * @param {ImageData} imageData
 * @param {function} [onProgress]
 * @returns {Promise<Blob>}
 */
export async function workerEncodePng16(imageData, onProgress = null) {
  try {
    return await sendToWorker(
      {
        type: 'encodePng16',
        pixelData: imageData.data.buffer,
        width: imageData.width,
        height: imageData.height
      },
      [imageData.data.buffer],
      onProgress
    );
  } catch {
    return null;
  }
}

/**
 * Encode TIFF via Worker.
 * @param {ImageData} imageData
 * @param {number} bitDepth
 * @param {function} [onProgress]
 * @returns {Promise<Blob>}
 */
export async function workerEncodeTiff(imageData, bitDepth = 8, onProgress = null) {
  try {
    return await sendToWorker(
      {
        type: 'encodeTiff',
        pixelData: imageData.data.buffer,
        width: imageData.width,
        height: imageData.height,
        bitDepth
      },
      [imageData.data.buffer],
      onProgress
    );
  } catch {
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
 * Terminate the worker (cleanup).
 */
export function terminateWorker() {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  for (const [, entry] of pending) {
    entry.reject(new Error('Worker terminated'));
  }
  pending.clear();
}

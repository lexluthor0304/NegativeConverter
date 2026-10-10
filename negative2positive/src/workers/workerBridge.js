/**
 * Worker Bridge — Promise-based API for communicating with the export Worker.
 * Falls back to main-thread execution when Workers are unavailable.
 *
 * Every request is bounded by a timeout and can be cancelled through an
 * AbortSignal. A Worker that stalls without throwing (a lost message, a renderer
 * OOM-kill that fires no `error` event, a runaway loop) would otherwise leave
 * the export overlay spinning forever.
 *
 * `createExportWorkerBridge()` builds an independent bridge with its own
 * Worker. A single export makes one for itself and disposes of it when the
 * export ends, and a batch export runs a pool of them (`createExportWorkerPool`)
 * for the batch's lifetime (#250). A disposed bridge never starts a worker
 * again: a request in flight when it is disposed of, one still copying its
 * inputs (the copy stops at its next slice) and any later one reject with an
 * AbortError, so nothing falls back to the main thread for a file that is no
 * longer being written. The module-level functions are the default
 * bridge for the remaining callers (contact sheet, multi-shot merge); it
 * releases its worker a few seconds after a large request leaves it idle.
 * `createPng16BandPool` spreads the row bands of one 16-bit PNG across
 * several workers.
 *
 * Planes (#250): a request copies its input for the worker unless the caller
 * sets `transferPlane` and the buffer is stamped export-owned and referenced by
 * no live editor plane (app/planeRelease.js); then the buffer itself moves to
 * the worker. Copies of large planes are spread over several tasks, except for
 * planes the editor rewrites in place (the dust-repaired image, #259, marked
 * with markLiveMutableBuffer), which are copied in one task so an undo cannot
 * tear them. When the worker fails before it wrote a transferred input
 * it hands the buffer back and the bridge re-attaches it (the request then
 * resolves null and the caller falls back); otherwise the request rejects with
 * ExportInputLostError and the caller renders the frame again.
 */

import { selectExportSamples, exportChannelCount } from './imageEncoders.js';
import { planPng16Bands, assemblePng16Blob, combineBandAdlers } from './png16Bands.js';
import { computeAdjustmentParams, isIdentityAdjustmentParams } from './pixelAdjustments.js';
import { downconvertPlane16 } from './pixelAdjustments16.js';
import { isLiveMutableBuffer, markOwnedPlanes, mayTransferBuffer } from '../app/planeRelease.js';

/** Base allowance for a request, plus a per-megapixel allowance on top. */
export const WORKER_TIMEOUT_BASE_MS = 30_000;
export const WORKER_TIMEOUT_PER_MEGAPIXEL_MS = 1_000;
export const WORKER_TIMEOUT_MAX_MS = 600_000;

/** Requests above this many pixels arm the idle release of a bridge that has one. */
export const IDLE_RELEASE_MIN_PIXELS = 16_000_000;
/** Idle delay before the default bridge terminates its worker. */
export const DEFAULT_BRIDGE_IDLE_RELEASE_MS = 4_000;

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

// A request to a disposed bridge: nothing was posted, so its inputs are
// still the caller's (see reclaimUnlessNotPosted).
function disposedBridgeError() {
  const err = makeError('Export worker bridge disposed', 'AbortError');
  err.notPosted = true;
  return err;
}

export function isWorkerTimeoutError(err) {
  return Boolean(err) && err.name === 'WorkerTimeoutError';
}

/**
 * A plane transferred to the worker did not come back (the worker crashed,
 * timed out, was terminated, or failed after writing it). The caller no
 * longer holds its pixels and has to render the frame again.
 */
export function isExportInputLostError(err) {
  return Boolean(err) && err.name === 'ExportInputLostError';
}

export function inputLostError(what, cause) {
  const lost = makeError(`The frame's ${what} was lost with the export worker: ${cause && cause.message ? cause.message : cause}`, 'ExportInputLostError');
  lost.cause = cause;
  return lost;
}

// A silent main-thread fallback hid a broken worker result for weeks (#240):
// say so once per request type and page session.
const warnedFallbacks = new Set();

function warnWorkerFallbackOnce(requestType, err) {
  if (warnedFallbacks.has(requestType)) return;
  warnedFallbacks.add(requestType);
  console.warn(`Export worker ${requestType} failed, falling back to the main thread (reported once per session):`, err);
}

/** Test hook: forget which fallbacks have already been reported. */
export function resetWorkerFallbackWarnings() {
  warnedFallbacks.clear();
}

// Whether a worker can encode PNG8/JPEG (OffscreenCanvas.convertToBlob). It is
// a property of the engine, not of one worker, so it is learnt once per page
// and shared by every bridge: per-export bridges must not probe per frame.
let encodeImageSupport = null;

/** Test hook: forget what the worker said about OffscreenCanvas encoding. */
export function resetEncodeImageSupport() {
  encodeImageSupport = null;
}

export function encodeImageSupported() {
  return encodeImageSupport;
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
  // A shared plane's slice is shared too (#264) and cannot be in a transfer
  // list: a small shared plane is copied into a plain buffer instead (#293;
  // the sliced copy below always makes one).
  if (!(buffer instanceof ArrayBuffer)) {
    const copy = new Uint8Array(byteLength);
    copy.set(new Uint8Array(buffer, byteOffset, byteLength));
    return copy.buffer;
  }
  return buffer.slice(byteOffset, byteOffset + byteLength);
}

/** Bytes per task when a large plane is copied for the worker. */
export const COPY_SLICE_BYTES = 32 << 20;

// A message task rather than a timer: hidden pages throttle chained timers to
// one per second or slower, and a batch export may run in a hidden window.
function yieldToEventLoop() {
  if (typeof MessageChannel !== 'function') return new Promise((resolve) => setTimeout(resolve, 0));
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/**
 * Copy a typed array's bytes into a new ArrayBuffer, one `sliceBytes` slice
 * per task, so copying a 480 MB plane does not block the main thread for one
 * long task. The destination is allocated once; the abort signal is honoured
 * between slices. The source must not be written while the copy runs:
 * conversion planes and export frames are write-once, and prepareInput copies
 * a plane the editor rewrites in place (isLiveMutableBuffer) in one task.
 * @returns {Promise<ArrayBuffer>}
 */
export async function copyTypedArrayInSlices(view, { sliceBytes = COPY_SLICE_BYTES, signal = null } = {}) {
  if (signal && signal.aborted) throw makeError('Worker request aborted', 'AbortError');
  const source = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const step = Math.max(1, Math.floor(sliceBytes) || COPY_SLICE_BYTES);
  if (source.length <= step) return copyTypedArrayBuffer(view);
  const target = new Uint8Array(source.length);
  for (let offset = 0; offset < source.length; offset += step) {
    if (offset > 0) {
      await yieldToEventLoop();
      if (signal && signal.aborted) throw makeError('Worker request aborted', 'AbortError');
    }
    target.set(source.subarray(offset, Math.min(source.length, offset + step)), offset);
  }
  return target.buffer;
}

// A plane can be handed over without a copy only when its view owns the whole
// (non-shared) buffer; otherwise a transfer would detach unrelated views.
function isWholeBufferView(view) {
  return view.byteOffset === 0
    && view.buffer instanceof ArrayBuffer
    && view.byteLength === view.buffer.byteLength
    && view.byteLength > 0;
}

function isRgbaPlaneOf(plane, width, height) {
  return Boolean(plane)
    && plane.data instanceof Uint16Array
    && plane.width === width
    && plane.height === height
    && plane.data.length === width * height * 4;
}

// A real ImageData's `data` is read-only: a buffer that comes back cannot be
// put into it again. Only plain objects (16-bit planes, plane-only results)
// can be re-attached in place.
function isPlatformImageData(value) {
  return typeof ImageData === 'function' && value instanceof ImageData;
}

/**
 * The buffer a request sends for `view`: the buffer itself when the caller
 * may give it away (`transfer`, a whole-buffer view of an export-owned plane
 * nothing live references), a one-task copy of a plane the editor rewrites in
 * place, and a sliced copy otherwise. Small inputs are copied
 * synchronously, so a request still reaches the worker in the caller's task.
 * @returns {{buffer: ArrayBuffer, transferred: boolean}|Promise<{buffer: ArrayBuffer, transferred: boolean}>}
 */
function prepareInput(view, { transfer = false, signal = null } = {}) {
  if (transfer && isWholeBufferView(view) && mayTransferBuffer(view.buffer)) {
    return { buffer: view.buffer, transferred: true };
  }
  if (view.byteLength <= COPY_SLICE_BYTES || isLiveMutableBuffer(view.buffer)) {
    if (signal && signal.aborted) throw makeError('Worker request aborted', 'AbortError');
    return { buffer: copyTypedArrayBuffer(view), transferred: false };
  }
  return copyTypedArrayInSlices(view, { signal }).then((buffer) => ({ buffer, transferred: false }));
}

function isPromise(value) {
  return Boolean(value) && typeof value.then === 'function';
}

// Error payloads carry the unwritten input buffers the worker handed back.
function takeReturned(err) {
  const returned = err && err.returned ? err.returned : null;
  // Do not let a logged error keep the returned buffers alive.
  if (err && err.returned) delete err.returned;
  return returned || {};
}

/**
 * After a failed request that transferred an input: re-attach the buffer the
 * worker handed back (stamped again: only an owned plane was transferred),
 * or report the input as lost. Cancellation stays a
 * cancellation (the caller gave up on the frame).
 */
function reclaimInput(err, returned, { transferred, byteLength, reattach, what }) {
  if (!transferred) return;
  if (returned instanceof ArrayBuffer && returned.byteLength === byteLength) {
    reattach(returned);
    return;
  }
  if (isAbortError(err)) {
    // The caller gave up on the frame; say that its input went with it.
    err.inputLost = true;
    return;
  }
  throw inputLostError(what, err);
}

// 8-bit inputs of a real ImageData move only when the caller can take a
// replacement frame back (`onRestore`), since the original cannot be refilled.
function mayTransfer8(imageData, opts) {
  return Boolean(opts.transferPlane) && (!isPlatformImageData(imageData) || typeof opts.onRestore === 'function');
}

function restore8(imageData, buffer, opts) {
  // It was stamped to be transferred; the returned buffer is a new object.
  if (!isPlatformImageData(imageData)) {
    imageData.data = markOwnedPlanes(new Uint8ClampedArray(buffer));
    return;
  }
  const frame = new ImageData(new Uint8ClampedArray(buffer), imageData.width, imageData.height);
  // Carry the attachments (`__image16`, `__gainMapSource`, ...). Chrome lists
  // `data` among an ImageData's own keys and makes it read-only: the new
  // frame's own fields stay.
  for (const key of Object.keys(imageData)) if (!(key in frame)) frame[key] = imageData[key];
  markOwnedPlanes(frame.data);
  opts.onRestore(frame);
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
    signal: opts.signal,
    pixels: imageData.width * imageData.height
  };
}

function defaultWorkerFactory() {
  return new Worker(
    new URL('./exportWorker.js', import.meta.url),
    { type: 'module' }
  );
}

// A 16-bit result is viewed, not converted: `new Uint16Array(buffer)` shares
// the transferred buffer (offset 0, even length).
function viewAdjustmentResult(msg) {
  return {
    data: msg.bits === 16 ? new Uint16Array(msg.data) : new Uint8ClampedArray(msg.data),
    data8: msg.data8 ? new Uint8ClampedArray(msg.data8) : null,
    bits: msg.bits === 16 ? 16 : 8,
    width: msg.width,
    height: msg.height
  };
}

function viewGainMapResult(msg) {
  return {
    data: new Uint8ClampedArray(msg.data),
    width: msg.width,
    height: msg.height,
    gainMax: msg.gainMax,
    gainMin: msg.gainMin
  };
}

// Bytes of the pixel planes a request posts: typed arrays and buffers at the
// top level of the message or one object below it (an __image16 plane).
function messagePlaneBytes(message) {
  const seen = new Set();
  let bytes = 0;
  const add = (value) => {
    const buffer = ArrayBuffer.isView(value) ? value.buffer : value instanceof ArrayBuffer ? value : null;
    if (!buffer || seen.has(buffer)) return false;
    seen.add(buffer);
    bytes += buffer.byteLength;
    return true;
  };
  for (const value of Object.values(message || {})) {
    if (add(value) || !value || typeof value !== 'object') continue;
    for (const inner of Object.values(value)) add(inner);
  }
  return bytes;
}

function isBlob(value) {
  return Boolean(value) && typeof value.size === 'number' && typeof value.arrayBuffer === 'function';
}

/**
 * One export Worker with its own request queue.
 * @param {{workerFactory?: () => Worker, idleReleaseMs?: number}} [options]
 *   `idleReleaseMs` > 0: once a request over IDLE_RELEASE_MIN_PIXELS has run
 *   and nothing is pending, terminate the worker after that delay (any new
 *   request cancels the timer), so its dead planes do not wait for the next
 *   export.
 */
export function createExportWorkerBridge({ workerFactory = defaultWorkerFactory, idleReleaseMs = 0 } = {}) {
  let worker = null;
  let requestId = 0;
  const pending = new Map();
  let idleTimer = null;
  let largeSinceIdle = false;
  // Set by dispose(): the export that owned the bridge is over.
  let disposed = false;
  // The planes of the last request stay in the worker's heap until it is
  // terminated (the memory ledger's worker resident, #258).
  let lastJobBytes = 0;

  function clearIdleRelease() {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
  }

  // The flag stays set until the worker is released: a small request after a
  // large one must not leave the large one's dead planes in the worker.
  function armIdleRelease() {
    clearIdleRelease();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (pending.size === 0) disposeWorker();
    }, idleReleaseMs);
    if (typeof idleTimer === 'object' && idleTimer && typeof idleTimer.unref === 'function') idleTimer.unref();
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
    if (idleReleaseMs > 0 && largeSinceIdle && pending.size === 0 && worker) armIdleRelease();
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
    clearIdleRelease();
    largeSinceIdle = false;
    lastJobBytes = 0;
    const dying = worker;
    worker = null;
    if (!dying) return;
    try {
      dying.terminate();
    } catch {
      // Terminating a dead worker is not actionable.
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
      case 'gainMapResult': {
        settleEntry(msg.id, entry);
        let result;
        try {
          result = msg.type === 'result' ? viewAdjustmentResult(msg) : viewGainMapResult(msg);
        } catch (err) {
          // A malformed buffer (e.g. an odd byte length for 16 bits) must fail
          // the request, not strand it.
          entry.reject(err);
          break;
        }
        entry.resolve(result);
        break;
      }
      case 'blobResult':
        settleEntry(msg.id, entry);
        entry.resolve(msg.blob);
        break;
      case 'bandResult':
        settleEntry(msg.id, entry);
        entry.resolve({ blob: msg.blob, adler: msg.adler, length: msg.length });
        break;
      case 'dngResult':
        settleEntry(msg.id, entry);
        entry.resolve({ blob: msg.blob, gain: msg.gain || null, buildMs: msg.buildMs, blobMs: msg.blobMs });
        break;
      case 'imageResult':
        settleEntry(msg.id, entry);
        entry.resolve({ blob: msg.blob, gain: msg.gain || null });
        break;
      case 'error': {
        settleEntry(msg.id, entry);
        const err = new Error(msg.message);
        if (msg.code) err.code = msg.code;
        // Input buffers a request transferred and the worker handed back.
        if (msg.returned) err.returned = msg.returned;
        entry.reject(err);
        break;
      }
    }
  }

  function getWorker() {
    if (worker) return worker;
    if (disposed) return null;
    try {
      worker = workerFactory();
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

  /**
   * @param {object} message
   * @param {Transferable[]} [transfers]
   * @param {function} [onProgress]
   * @param {{timeoutMs?: number, signal?: AbortSignal, pixels?: number}} [options]
   */
  function sendToWorker(message, transfers, onProgress, options = {}) {
    return new Promise((resolve, reject) => {
      const { signal } = options;
      if (signal && signal.aborted) {
        reject(makeError('Worker request aborted', 'AbortError'));
        return;
      }
      // A request that gets here after the bridge was disposed of (made
      // later, or its input copy ended just then) neither starts a worker
      // nor falls back.
      if (disposed) {
        reject(disposedBridgeError());
        return;
      }

      const w = getWorker();
      if (!w) {
        reject(new Error('Worker unavailable'));
        return;
      }
      clearIdleRelease();
      if (idleReleaseMs > 0 && Number(options.pixels) > IDLE_RELEASE_MIN_PIXELS) largeSinceIdle = true;
      lastJobBytes = messagePlaneBytes(message);

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
        // the id in `pending` forever. Nothing was transferred.
        settleEntry(id, entry);
        const failure = err instanceof Error ? err : new Error(String(err));
        failure.notPosted = true;
        entry.reject(failure);
      }
    });
  }

  // A postMessage that threw moved nothing: the input is still the caller's.
  function reclaimUnlessNotPosted(err, returned, input) {
    if (err && err.notPosted) return;
    reclaimInput(err, returned, input);
  }

  // A request's inputs are prepared under its own signal and the bridge's
  // end: once the bridge is disposed of, a copy still running stops at its
  // next slice (an AbortError) instead of copying the rest for nothing.
  function prepareRequestInput(view, { transfer = false, signal = null } = {}) {
    return prepareInput(view, { transfer, signal: { get aborted() { return disposed || Boolean(signal && signal.aborted); } } });
  }

  /**
   * Apply adjustments to image data via Worker. The worker adjusts its input
   * in place and hands the same buffer back.
   * @param {ImageData} imageData
   * @param {object} settings - Sanitized settings with curves
   * @param {string} quality - 'preview' or 'full'
   * @param {function|{onProgress?:function,signal?:AbortSignal,timeoutMs?:number,transferPlane?:boolean,onRestore?:function}} [onProgressOrOptions]
   *   `transferPlane`: hand `imageData.data` over without a copy (export-owned
   *   planes only; a real ImageData also needs `onRestore(frame)`, which gets
   *   a refilled copy of the frame when the worker hands the buffer back).
   * @returns {Promise<ImageData|null>} null when the worker failed and the caller
   *   should fall back to the main thread. Cancellation rejects instead, so a
   *   cancelled export does not silently redo the work on the main thread.
   */
  async function workerApplyAdjustments(imageData, settings, quality = 'full', onProgressOrOptions = null) {
    const opts = normalizeRequestOptions(onProgressOrOptions);
    const { width, height } = imageData;
    const byteLength = imageData.data.byteLength;
    let input = prepareRequestInput(imageData.data, { transfer: mayTransfer8(imageData, opts), signal: opts.signal });
    if (isPromise(input)) input = await input;
    const { buffer: inputBuffer, transferred } = input;

    try {
      const result = await sendToWorker(
        {
          type: 'applyAdjustments',
          inputBuffer,
          width,
          height,
          settings: serializeSettings(settings),
          quality
        },
        [inputBuffer],
        opts.onProgress,
        requestOptionsFor(imageData, opts)
      );
      const output = new ImageData(result.data, result.width, result.height);
      markOwnedPlanes(output.data);
      // The adjustment stage is 8-bit only. When it is a no-op the engine's
      // 16-bit plane is still an exact description of the result, so keep it
      // attached for the exporter; otherwise it must be dropped as stale.
      if (imageData.__image16 && settings && settings.curves
        && isIdentityAdjustmentParams(computeAdjustmentParams(settings))) {
        output.__image16 = imageData.__image16;
      }
      return output;
    } catch (err) {
      const returned = takeReturned(err);
      reclaimUnlessNotPosted(err, returned.input, {
        transferred, byteLength, what: '8-bit frame',
        reattach: (buffer) => restore8(imageData, buffer, opts)
      });
      if (isAbortError(err)) throw err;
      // Fallback to main thread
      warnWorkerFallbackOnce('applyAdjustments', err);
      return null;
    }
  }

  /**
   * Apply adjustments to the engine's 16-bit plane via Worker. Resolves to an
   * ImageData whose `data` holds the high bytes and whose `__image16` is the
   * adjusted plane; with `planeOnly`, to `{ width, height, __image16 }` with no
   * 8-bit mirror. Null when there is no plane of the image's own size (the
   * main-thread path then runs the 8-bit stage) or the worker failed.
   * @param {function|{onProgress?:function,signal?:AbortSignal,timeoutMs?:number,planeOnly?:boolean,transferPlane?:boolean}} [onProgressOrOptions]
   */
  async function workerApplyAdjustments16(imageData, settings, quality = 'full', onProgressOrOptions = null) {
    const plane = imageData && imageData.__image16;
    if (!plane || !isRgbaPlaneOf(plane, imageData.width, imageData.height)) return null;
    const opts = normalizeRequestOptions(onProgressOrOptions);
    const planeOnly = Boolean(opts.planeOnly);
    const { width, height } = plane;
    const sampleCount = width * height * 4;
    // Snapshot the settings before the copy yields to other tasks.
    const serializedSettings = serializeSettings(settings);
    // Copied unless the caller hands over an export-owned plane: the caller's
    // fallback, and later frames, may still read it.
    let input = prepareRequestInput(plane.data, { transfer: opts.transferPlane, signal: opts.signal });
    if (isPromise(input)) input = await input;
    const { buffer: inputBuffer, transferred } = input;
    try {
      const result = await sendToWorker(
        {
          type: 'applyAdjustments16',
          inputBuffer,
          width,
          height,
          settings: serializedSettings,
          quality,
          planeOnly
        },
        [inputBuffer],
        opts.onProgress,
        requestOptionsFor(imageData, opts)
      );
      const out16 = result.data;
      if (!(out16 instanceof Uint16Array) || out16.length !== sampleCount || result.width !== width || result.height !== height) {
        throw new Error(`Unexpected 16-bit adjustment result (${out16 && out16.constructor && out16.constructor.name} of ${out16 && out16.length} for ${width}x${height})`);
      }
      const plane16 = { width, height, data: out16 };
      markOwnedPlanes(out16);
      if (planeOnly) return { width, height, __image16: plane16 };
      const data8 = result.data8 || downconvertPlane16(out16, new Uint8ClampedArray(sampleCount));
      if (data8.length !== sampleCount) {
        throw new Error(`Unexpected 8-bit mirror length ${data8.length} for ${width}x${height}`);
      }
      const output = new ImageData(data8, width, height);
      output.__image16 = plane16;
      markOwnedPlanes(output.data);
      return output;
    } catch (err) {
      const returned = takeReturned(err);
      reclaimUnlessNotPosted(err, returned.input, {
        transferred, byteLength: sampleCount * 2, what: '16-bit plane',
        reattach: (buffer) => { plane.data = markOwnedPlanes(new Uint16Array(buffer)); }
      });
      if (isAbortError(err)) throw err;
      warnWorkerFallbackOnce('applyAdjustments16', err);
      return null;
    }
  }

  /**
   * The JPEG gain map for `sdr`, the SDR frame being encoded: the worker runs
   * the 16-bit adjustment pass on `source.__image16` (the unadjusted plane)
   * and the exact table map; the adjusted plane never comes back.
   *
   * The SDR bytes are always copied (the main thread still encodes them). The
   * plane is copied too unless `transferPlane` is set, when the caller hands
   * it over without a copy: on success its buffer stays detached; when the
   * worker reports an error before the pass wrote it, it hands the buffer back
   * and it is re-attached to the plane object before resolving null.
   *
   * @param {ImageData} source - carries `__image16`, the unadjusted plane
   * @param {ImageData} sdr - the 8-bit frame being encoded, same size
   * @param {object} settings - buildAdjustmentSettings(...) output
   * @param {{transferPlane?:boolean,signal?:AbortSignal,timeoutMs?:number,onProgress?:function}} [options]
   * @returns {Promise<{width:number,height:number,data:Uint8ClampedArray,gainMax:number,gainMin:number}|null>}
   *   null when the inputs do not qualify or the worker failed (the caller
   *   falls back to the main thread). Rejects with an AbortError on
   *   cancellation, and with an ExportInputLostError when a transferred plane
   *   did not come back.
   */
  async function workerGainMap16(source, sdr, settings, options = {}) {
    const opts = normalizeRequestOptions(options);
    const plane = source && source.__image16;
    if (!plane || !sdr || !isRgbaPlaneOf(plane, source.width, source.height)) return null;
    const { width, height } = plane;
    if (sdr.width !== width || sdr.height !== height || !sdr.data || sdr.data.length !== width * height * 4) return null;
    const serializedSettings = serializeSettings(settings);
    let sdrInput = prepareRequestInput(sdr.data, { signal: opts.signal });
    if (isPromise(sdrInput)) sdrInput = await sdrInput;
    let input = prepareRequestInput(plane.data, { transfer: opts.transferPlane, signal: opts.signal });
    if (isPromise(input)) input = await input;
    const sdrBuffer = sdrInput.buffer;
    const { buffer: inputBuffer, transferred } = input;
    try {
      const map = await sendToWorker(
        {
          type: 'gainMap16',
          inputBuffer,
          sdrBuffer,
          width,
          height,
          settings: serializedSettings,
          quality: 'full'
        },
        [inputBuffer, sdrBuffer],
        opts.onProgress,
        requestOptionsFor(source, opts)
      );
      const mapWidth = Math.ceil(width / 4);
      const mapHeight = Math.ceil(height / 4);
      if (!(map.data instanceof Uint8ClampedArray) || map.width !== mapWidth || map.height !== mapHeight
        || map.data.length !== mapWidth * mapHeight * 4 || !Number.isFinite(map.gainMax)) {
        throw new Error(`Unexpected gain map result for ${width}x${height}`);
      }
      return map;
    } catch (err) {
      const returned = takeReturned(err);
      reclaimUnlessNotPosted(err, returned.plane, {
        transferred, byteLength: width * height * 8, what: '16-bit plane',
        reattach: (buffer) => { plane.data = markOwnedPlanes(new Uint16Array(buffer)); }
      });
      if (isAbortError(err)) throw err;
      warnWorkerFallbackOnce('gainMap16', err);
      return null;
    }
  }

  /**
   * One request per 16-bit file (#250 Part 2): the worker adjusts the
   * unadjusted plane `source.__image16` in place and encodes it as TIFF or
   * PNG. Only the Blob comes back (PNG metadata is attached at Blob level by
   * the caller).
   * @param {{__image16: object, width: number, height: number}} source
   * @param {object} settings - buildAdjustmentSettings(...) output
   * @param {{format: 'tiff'|'png', metadata?: object|null, level?: number, strategy?: number, bandBytes?: number, transferPlane?: boolean, signal?: AbortSignal, timeoutMs?: number, onProgress?: function}} options
   * @returns {Promise<Blob|null>} null when there is no plane of the frame's
   *   size or the worker failed before writing the plane (the caller runs
   *   today's path). Rejects with an AbortError on cancellation and with an
   *   ExportInputLostError when a transferred plane did not come back.
   */
  async function workerAdjust16AndEncode(source, settings, options = {}) {
    const opts = normalizeRequestOptions(options);
    const plane = source && source.__image16;
    const format = opts.format;
    if ((format !== 'tiff' && format !== 'png') || !plane || !isRgbaPlaneOf(plane, source.width, source.height)) return null;
    const { width, height } = plane;
    const serializedSettings = serializeSettings(settings);
    let input = prepareRequestInput(plane.data, { transfer: opts.transferPlane, signal: opts.signal });
    if (isPromise(input)) input = await input;
    const { buffer: inputBuffer, transferred } = input;
    try {
      const blob = await sendToWorker(
        {
          type: 'adjust16AndEncode',
          inputBuffer,
          width,
          height,
          settings: serializedSettings,
          quality: 'full',
          format,
          metadata: format === 'tiff' ? (opts.metadata || null) : null,
          // PNG compression (#257): the same band encoder and settings as the
          // band pool and workerEncodePng16, so the bytes match.
          level: opts.level,
          strategy: opts.strategy,
          bandBytes: opts.bandBytes
        },
        [inputBuffer],
        opts.onProgress,
        requestOptionsFor(source, opts)
      );
      if (!isBlob(blob)) throw new Error('Unexpected adjust16AndEncode result');
      return blob;
    } catch (err) {
      const returned = takeReturned(err);
      reclaimUnlessNotPosted(err, returned.input, {
        transferred, byteLength: width * height * 8, what: '16-bit plane',
        reattach: (buffer) => { plane.data = markOwnedPlanes(new Uint16Array(buffer)); }
      });
      if (isAbortError(err)) throw err;
      warnWorkerFallbackOnce('adjust16AndEncode', err);
      return null;
    }
  }

  /**
   * PNG8 or JPEG through OffscreenCanvas in the worker (#250 Part 3), with the
   * JPEG gain map in the same request.
   * @param {ImageData} imageData - the 8-bit frame, opaque
   * @param {object} options
   * @param {string} options.mimeType - 'image/png' or 'image/jpeg'
   * @param {number} [options.quality] - JPEG quality 0..1
   * @param {{source?: object, plane16?: object, settings?: object|null, transferPlane?: boolean}|null} [options.gainMap]
   *   `source.__image16` (unadjusted, with `settings`) or `plane16` (already
   *   adjusted, `settings` null). A plane that does not match the frame
   *   produces no map, as before.
   * @param {boolean} [options.transferPlane] - hand the frame's pixels over
   * @param {function} [options.onRestore] - receives a refilled frame when
   *   transferred pixels come back (a real ImageData cannot be refilled)
   * @returns {Promise<{blob: Blob, gain: {blob: Blob, gainMax: number, gainMin: number}|null}|null>}
   *   null: encode on the main thread (no OffscreenCanvas encode, a non-opaque
   *   frame, or a worker failure). Rejects with an AbortError on cancellation
   *   and with an ExportInputLostError when a transferred input did not come back.
   */
  async function workerEncodeImage(imageData, options = {}) {
    const opts = normalizeRequestOptions(options);
    if (encodeImageSupport === false) return null;
    const { width, height } = imageData || {};
    if (!imageData || !(imageData.data instanceof Uint8ClampedArray) || !(width > 0) || !(height > 0)
      || imageData.data.length !== width * height * 4) return null;
    const mimeType = opts.mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const gainRequest = mimeType === 'image/jpeg' && opts.gainMap ? opts.gainMap : null;
    const gainPlane = gainRequest ? (gainRequest.source ? gainRequest.source.__image16 : gainRequest.plane16) : null;
    const withGain = Boolean(gainPlane) && isRgbaPlaneOf(gainPlane, width, height);
    const serializedGainSettings = withGain && gainRequest.settings ? serializeSettings(gainRequest.settings) : null;
    const byteLength = imageData.data.byteLength;
    let pixelsInput = prepareRequestInput(imageData.data, { transfer: mayTransfer8(imageData, opts), signal: opts.signal });
    if (isPromise(pixelsInput)) pixelsInput = await pixelsInput;
    let planeInput = withGain ? prepareRequestInput(gainPlane.data, { transfer: Boolean(gainRequest.transferPlane), signal: opts.signal }) : null;
    if (isPromise(planeInput)) planeInput = await planeInput;
    const transfers = [pixelsInput.buffer];
    if (planeInput) transfers.push(planeInput.buffer);
    try {
      const result = await sendToWorker(
        {
          type: 'encodeImage',
          pixelData: pixelsInput.buffer,
          width,
          height,
          mimeType,
          quality: mimeType === 'image/jpeg' && Number.isFinite(opts.quality) ? opts.quality : undefined,
          gainMap: planeInput ? { plane: planeInput.buffer, settings: serializedGainSettings } : null
        },
        transfers,
        opts.onProgress,
        requestOptionsFor(imageData, opts)
      );
      if (!result || !isBlob(result.blob)) throw new Error('Unexpected encodeImage result');
      encodeImageSupport = true;
      return result;
    } catch (err) {
      const returned = takeReturned(err);
      if (err && err.code === 'unsupported') encodeImageSupport = false;
      reclaimUnlessNotPosted(err, returned.pixels, {
        transferred: pixelsInput.transferred, byteLength, what: '8-bit frame',
        reattach: (buffer) => restore8(imageData, buffer, opts)
      });
      if (planeInput) {
        reclaimUnlessNotPosted(err, returned.plane, {
          transferred: planeInput.transferred, byteLength: width * height * 8, what: '16-bit plane',
          reattach: (buffer) => { gainPlane.data = markOwnedPlanes(new Uint16Array(buffer)); }
        });
      }
      if (isAbortError(err)) throw err;
      if (err && (err.code === 'unsupported' || err.code === 'unsupported-alpha')) return null;
      warnWorkerFallbackOnce('encodeImage', err);
      return null;
    }
  }

  /**
   * Pick the sample plane to encode from and prepare it for the worker. The
   * 16-bit plane is a plain object and can be refilled; an 8-bit frame only
   * with `onRestore` (or when it is a plain object).
   */
  async function sendEncode(type, imageData, bitDepth, opts, extra) {
    const { samples, sampleBits } = selectExportSamples(imageData, bitDepth);
    const is16 = sampleBits === 16;
    const plane = is16 ? imageData.__image16 : null;
    const transfer = is16 ? Boolean(opts.transferPlane) : mayTransfer8(imageData, opts);
    const byteLength = samples.byteLength;
    let input = prepareRequestInput(samples, { transfer, signal: opts.signal });
    if (isPromise(input)) input = await input;
    const { buffer, transferred } = input;
    try {
      return await sendToWorker(
        {
          type,
          pixelData: buffer,
          sourceBits: sampleBits,
          width: imageData.width,
          height: imageData.height,
          ...extra
        },
        [buffer],
        opts.onProgress,
        requestOptionsFor(imageData, opts)
      );
    } catch (err) {
      const returned = takeReturned(err);
      reclaimUnlessNotPosted(err, returned.input, {
        transferred, byteLength, what: is16 ? '16-bit plane' : '8-bit frame',
        reattach: (returnedBuffer) => {
          if (plane) plane.data = markOwnedPlanes(new Uint16Array(returnedBuffer));
          else restore8(imageData, returnedBuffer, opts);
        }
      });
      if (isAbortError(err)) throw err;
      return null;
    }
  }

  /**
   * Encode 16-bit PNG via Worker: the whole frame, its bands one after another
   * (the same bytes as the band pool).
   * @param {ImageData} imageData
   * @param {function|{onProgress?:function,signal?:AbortSignal,timeoutMs?:number,level?:number,strategy?:number,bandBytes?:number,transferPlane?:boolean,onRestore?:function}} [onProgressOrOptions]
   * @returns {Promise<Blob|null>}
   */
  async function workerEncodePng16(imageData, onProgressOrOptions = null) {
    const opts = normalizeRequestOptions(onProgressOrOptions);
    return sendEncode('encodePng16', imageData, 16, opts, {
      level: opts.level,
      strategy: opts.strategy,
      bandBytes: opts.bandBytes
    });
  }

  /**
   * One row band of a 16-bit PNG (see createPng16BandPool). `request.pixelData`
   * is the band's own RGBA buffer and is transferred. Rejects on any failure;
   * the pool decides what to do.
   * @returns {Promise<{blob: Blob, adler: number, length: number}>}
   */
  function workerEncodePng16Band(request, options = {}) {
    return sendToWorker(
      { type: 'encodePng16Band', ...request },
      [request.pixelData],
      null,
      { timeoutMs: options.timeoutMs, signal: options.signal }
    );
  }

  /**
   * Encode TIFF via Worker.
   * @param {ImageData} imageData
   * @param {number} bitDepth
   * @param {function|{onProgress?:function,signal?:AbortSignal,timeoutMs?:number,transferPlane?:boolean,onRestore?:function}} [onProgressOrOptions]
   * @returns {Promise<Blob|null>}
   */
  async function workerEncodeTiff(imageData, bitDepth = 8, onProgressOrOptions = null, metadata = null) {
    const opts = normalizeRequestOptions(onProgressOrOptions);
    return sendEncode('encodeTiff', imageData, bitDepth, opts, {
      bitDepth,
      // Analog metadata (EXIF fields + XMP packet) written into the IFD.
      metadata: metadata || null
    });
  }

  /**
   * The linear DNG in the worker (#293): `source` is the geometry-applied
   * negative (its `__image16` plane when it has one of its own size, else
   * its 8-bit frame, which the worker upcasts as main.js's toImage16 does).
   * The worker runs buildLinearPositive, the DNG parts and the Blob; only
   * the Blob comes back, with the worker's build and Blob times. The plane
   * is copied unless `transferPlane` (an export-owned plane; an 8-bit real
   * ImageData also needs `onRestore`). The kernel never writes its input,
   * so a transferred plane comes back with any worker error.
   * @param {{filmBase?: object|null, positive?: boolean, metadata?: object|null, transferPlane?: boolean, onRestore?: function, signal?: AbortSignal, timeoutMs?: number, onProgress?: function}} [options]
   * @returns {Promise<{blob: Blob, gain: number[]|null, buildMs: number, blobMs: number}|null>}
   *   null when the worker failed (the caller builds on the main thread).
   *   Rejects with an AbortError on cancellation and with an
   *   ExportInputLostError when a transferred plane did not come back.
   */
  async function workerEncodeLinearDng(source, options = {}) {
    const opts = normalizeRequestOptions(options);
    const { width, height } = source || {};
    if (!source || !(width > 0) || !(height > 0)) return null;
    const plane = source.__image16 && isRgbaPlaneOf(source.__image16, width, height) ? source.__image16 : null;
    const view = plane ? plane.data : source.data;
    const bits = plane ? 16 : 8;
    if (!(view instanceof Uint16Array || view instanceof Uint8ClampedArray) || view.length !== width * height * 4) return null;
    const transfer = plane ? Boolean(opts.transferPlane) : mayTransfer8(source, opts);
    const byteLength = view.byteLength;
    let input = prepareRequestInput(view, { transfer, signal: opts.signal });
    if (isPromise(input)) input = await input;
    const { buffer: inputBuffer, transferred } = input;
    try {
      const result = await sendToWorker(
        {
          type: 'encodeLinearDng',
          inputBuffer,
          width,
          height,
          bits,
          filmBase: opts.filmBase ? { r: opts.filmBase.r, g: opts.filmBase.g, b: opts.filmBase.b } : null,
          positive: Boolean(opts.positive),
          metadata: opts.metadata || null
        },
        [inputBuffer],
        opts.onProgress,
        requestOptionsFor(source, opts)
      );
      if (!result || !isBlob(result.blob)) throw new Error('Unexpected encodeLinearDng result');
      return result;
    } catch (err) {
      const returned = takeReturned(err);
      reclaimUnlessNotPosted(err, returned.input, {
        transferred, byteLength, what: plane ? '16-bit plane' : '8-bit frame',
        reattach: (buffer) => {
          if (plane) plane.data = markOwnedPlanes(new Uint16Array(buffer));
          else restore8(source, buffer, opts);
        }
      });
      if (isAbortError(err)) throw err;
      warnWorkerFallbackOnce('encodeLinearDng', err);
      return null;
    }
  }

  /**
   * Check if the export worker is available.
   */
  function isWorkerAvailable() {
    return getWorker() !== null;
  }

  /**
   * Cancel every in-flight request without tearing the bridge down permanently.
   * The Worker is terminated (there is no way to interrupt a running encode) and
   * the next call transparently spins up a fresh one.
   */
  function cancelWorkerRequests(reason = 'Worker request cancelled') {
    disposeWorker();
    rejectAllPending(makeError(reason, 'AbortError'));
  }

  /**
   * Terminate the worker (cleanup). In-flight requests fail and fall back;
   * the next request starts a fresh worker.
   */
  function terminateWorker() {
    disposeWorker();
    rejectAllPending(new Error('Worker terminated'));
  }

  /**
   * End the bridge for good, when the export that owns it is over (#250).
   * The worker is terminated, and every request still in flight, still
   * copying its inputs (at its next slice) or made later rejects with an
   * AbortError: none of them starts a worker again or falls back to the
   * main thread, and isWorkerAvailable() is false from then on. Per-export
   * bridges and pool lanes release no worker on their own: a worker started
   * after the export would keep its planes until the bridge is collected.
   */
  function dispose() {
    disposed = true;
    disposeWorker();
    rejectAllPending(makeError('Export worker bridge disposed', 'AbortError'));
  }

  return {
    workerApplyAdjustments,
    workerApplyAdjustments16,
    workerGainMap16,
    workerAdjust16AndEncode,
    workerEncodeImage,
    workerEncodePng16,
    workerEncodePng16Band,
    workerEncodeTiff,
    workerEncodeLinearDng,
    isWorkerAvailable,
    cancelWorkerRequests,
    terminateWorker,
    dispose,
    /** True once dispose() ran. */
    get disposed() { return disposed; },
    /** Requests in flight on this bridge (for least-busy dispatch). */
    get pendingCount() { return pending.size; },
    /** Whether a Worker currently exists (never spawns one, unlike isWorkerAvailable). */
    get workerAlive() { return worker !== null; },
    /** True while a worker instance exists (tests and idle checks). */
    get hasWorker() { return worker !== null; },
    /** Plane bytes of the last request, while its worker lives (#258). */
    get residentBytes() { return worker !== null ? lastJobBytes : 0; }
  };
}

/**
 * Several bridges for a batch export. Each call goes to the bridge with the
 * fewest requests in flight; `dispose()` disposes of every lane once the
 * batch is over (no lane starts a worker again). The same API as a single
 * bridge, so callers can take either.
 */
export function createExportWorkerPool({ size = 2, workerFactory } = {}) {
  const laneCount = Math.max(1, Math.floor(size) || 1);
  const options = workerFactory ? { workerFactory } : {};
  const lanes = Array.from({ length: laneCount }, () => createExportWorkerBridge(options));
  const pick = () => lanes.reduce((best, lane) => (lane.pendingCount < best.pendingCount ? lane : best), lanes[0]);
  return {
    size: laneCount,
    workerApplyAdjustments: (...args) => pick().workerApplyAdjustments(...args),
    workerApplyAdjustments16: (...args) => pick().workerApplyAdjustments16(...args),
    workerGainMap16: (...args) => pick().workerGainMap16(...args),
    workerAdjust16AndEncode: (...args) => pick().workerAdjust16AndEncode(...args),
    workerEncodeImage: (...args) => pick().workerEncodeImage(...args),
    workerEncodePng16: (...args) => pick().workerEncodePng16(...args),
    workerEncodeTiff: (...args) => pick().workerEncodeTiff(...args),
    workerEncodeLinearDng: (...args) => pick().workerEncodeLinearDng(...args),
    isWorkerAvailable: () => lanes.every(lane => lane.isWorkerAvailable()),
    cancelWorkerRequests: (reason) => lanes.forEach(lane => lane.cancelWorkerRequests(reason)),
    terminateWorker: () => lanes.forEach(lane => lane.terminateWorker()),
    dispose: () => lanes.forEach(lane => lane.dispose()),
    get disposed() { return lanes.every(lane => lane.disposed); },
    get pendingCount() { return lanes.reduce((sum, lane) => sum + lane.pendingCount, 0); }
  };
}

/**
 * The PNG16 band pool (#257): `size` export workers encode the row bands of
 * 16-bit PNGs in parallel. One pool serves one export operation (a single
 * export or a batch) and is disposed when it ends.
 *
 * Bands wait in one ordered queue and are sliced from the frame only when a
 * worker takes them, so at most `size` band copies exist at a time. Each band
 * request has its own timeout from its own pixel count, counted from
 * dispatch. A failed or timed-out band, or an abort, stops the frame's other
 * bands, which terminates every worker still busy with it. The layout is
 * fixed per frame size, so the file is the same with any `size`, with one
 * export worker (`workerEncodePng16`) and on the main thread.
 *
 * @param {{size?: number, workerFactory?: () => Worker}} [options]
 */
export function createPng16BandPool({ size = 1, workerFactory } = {}) {
  const count = Math.max(1, Math.floor(size) || 1);
  const options = workerFactory ? { workerFactory } : {};
  const slots = Array.from({ length: count }, () => createExportWorkerBridge(options));
  const idle = [...slots];
  const queue = [];
  let disposed = false;
  const disposedError = () => makeError('PNG16 band pool disposed', 'AbortError');

  function pump() {
    while (!disposed && idle.length > 0 && queue.length > 0) {
      const slot = idle.shift();
      const task = queue.shift();
      task.run(slot).then(task.resolve, task.reject).finally(() => {
        if (disposed) return;
        idle.push(slot);
        pump();
      });
    }
  }

  function schedule(run) {
    if (disposed) return Promise.reject(disposedError());
    return new Promise((resolve, reject) => {
      queue.push({ run, resolve, reject });
      pump();
    });
  }

  /**
   * @param {ImageData} imageData - `__image16` is encoded when it fits, else the 8-bit data
   * @param {{onProgress?:function, signal?:AbortSignal, level?:number, strategy?:number, bandBytes?:number}} [encodeOptions]
   * @returns {Promise<Blob|null>} null when a worker failed (the caller falls
   *   back to one export worker, then to the main thread). Rejects with an
   *   AbortError on cancellation.
   */
  async function encode(imageData, { onProgress = null, signal = null, level, strategy, bandBytes } = {}) {
    if (signal && signal.aborted) throw makeError('Worker request aborted', 'AbortError');
    if (disposed) throw disposedError();
    const { samples, sampleBits } = selectExportSamples(imageData, 16);
    const { width, height } = imageData;
    const channels = exportChannelCount(samples);
    const { bands, filteredRowBytes } = planPng16Bands(width, height, channels, { bandBytes });
    const frame = new AbortController();
    const forwardAbort = () => frame.abort();
    if (signal) signal.addEventListener('abort', forwardAbort, { once: true });
    let finished = 0;
    try {
      const results = await Promise.all(bands.map((band) => schedule(async (slot) => {
        if (frame.signal.aborted) throw makeError('Worker request aborted', 'AbortError');
        const from = band.y * width * 4;
        const pixelData = copyTypedArrayBuffer(samples.subarray(from, from + band.rows * width * 4));
        const result = await slot.workerEncodePng16Band({
          pixelData,
          sourceBits: sampleBits,
          width,
          rows: band.rows,
          channels,
          index: band.index,
          isLast: band.index === bands.length - 1,
          level,
          strategy
        }, { signal: frame.signal, timeoutMs: computeWorkerTimeoutMs(width * band.rows) });
        if (!result || !(result.blob instanceof Blob) || result.length !== band.rows * filteredRowBytes
          || !Number.isInteger(result.adler) || result.adler < 0 || result.adler > 0xFFFFFFFF) {
          throw new Error(`Unexpected PNG16 band result for band ${band.index} of ${width}x${height}`);
        }
        finished += 1;
        if (onProgress) onProgress(Math.round((finished / bands.length) * 100), 'encoding');
        return result;
      })));
      return assemblePng16Blob({ width, height, channels, idats: results.map((result) => result.blob), adler: combineBandAdlers(results) });
    } catch (err) {
      frame.abort();
      if (signal && signal.aborted) throw makeError('Worker request aborted', 'AbortError');
      if (disposed) throw disposedError();
      warnWorkerFallbackOnce('encodePng16Band', err);
      return null;
    } finally {
      if (signal) signal.removeEventListener('abort', forwardAbort);
    }
  }

  /** Terminate every band worker; queued bands reject. */
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const task of queue.splice(0)) task.reject(disposedError());
    for (const slot of slots) slot.terminateWorker();
  }

  return {
    size: count,
    encode,
    dispose,
    get disposed() { return disposed; }
  };
}

const defaultBridge = createExportWorkerBridge({ idleReleaseMs: DEFAULT_BRIDGE_IDLE_RELEASE_MS });

export const workerApplyAdjustments = defaultBridge.workerApplyAdjustments;
export const workerApplyAdjustments16 = defaultBridge.workerApplyAdjustments16;
export const workerGainMap16 = defaultBridge.workerGainMap16;
export const workerAdjust16AndEncode = defaultBridge.workerAdjust16AndEncode;
export const workerEncodeImage = defaultBridge.workerEncodeImage;
export const workerEncodePng16 = defaultBridge.workerEncodePng16;
export const workerEncodeTiff = defaultBridge.workerEncodeTiff;
export const workerEncodeLinearDng = defaultBridge.workerEncodeLinearDng;
export const isWorkerAvailable = defaultBridge.isWorkerAvailable;
export const cancelWorkerRequests = defaultBridge.cancelWorkerRequests;
export const terminateWorker = defaultBridge.terminateWorker;
// Hidden-window memory shedding (#241) terminates the singleton only between
// requests; the next call respawns it lazily.
export const exportWorkerPendingCount = () => defaultBridge.pendingCount;
export const isExportWorkerAlive = () => defaultBridge.workerAlive;
export const exportWorkerResidentBytes = () => defaultBridge.residentBytes;
/** The default bridge itself (tests, idle checks). */
export const defaultExportBridge = defaultBridge;

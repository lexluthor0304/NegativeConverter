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
 * Worker; the module-level functions are the default bridge that the single
 * export path uses. A batch export runs several bridges side by side
 * (`createExportWorkerPool`) so the adjustment and encode stages of different
 * frames do not queue behind each other. `createPng16BandPool` spreads the
 * row bands of one 16-bit PNG across several workers.
 */

import { selectExportSamples, exportChannelCount } from './imageEncoders.js';
import { planPng16Bands, assemblePng16Blob, combineBandAdlers } from './png16Bands.js';
import { computeAdjustmentParams, isIdentityAdjustmentParams } from './pixelAdjustments.js';
import { downconvertPlane16 } from './pixelAdjustments16.js';

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

/**
 * A plane transferred to the worker did not come back (the worker crashed,
 * timed out or was terminated). The caller no longer holds its pixels and
 * has to render the frame again.
 */
export function isExportInputLostError(err) {
  return Boolean(err) && err.name === 'ExportInputLostError';
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
 * between slices. The source must not be written while the copy runs
 * (conversion planes and export frames are write-once).
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

/**
 * One export Worker with its own request queue.
 * @param {{workerFactory?: () => Worker}} [options]
 */
export function createExportWorkerBridge({ workerFactory = defaultWorkerFactory } = {}) {
  let worker = null;
  let requestId = 0;
  const pending = new Map();

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
      case 'error': {
        settleEntry(msg.id, entry);
        const err = new Error(msg.message);
        // Input buffers a request transferred and the worker handed back.
        if (msg.returned) err.returned = msg.returned;
        entry.reject(err);
        break;
      }
    }
  }

  function getWorker() {
    if (worker) return worker;
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
   * Apply adjustments to image data via Worker.
   * @param {ImageData} imageData
   * @param {object} settings - Sanitized settings with curves
   * @param {string} quality - 'preview' or 'full'
   * @param {function|{onProgress?:function,signal?:AbortSignal,timeoutMs?:number}} [onProgressOrOptions]
   * @returns {Promise<ImageData|null>} null when the worker failed and the caller
   *   should fall back to the main thread. Cancellation rejects instead, so a
   *   cancelled export does not silently redo the work on the main thread.
   */
  async function workerApplyAdjustments(imageData, settings, quality = 'full', onProgressOrOptions = null) {
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
   * @param {function|{onProgress?:function,signal?:AbortSignal,timeoutMs?:number,planeOnly?:boolean}} [onProgressOrOptions]
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
    // Must copy: the caller's fallback, and later frames, still read the plane.
    const inputBuffer = await copyTypedArrayInSlices(plane.data, { signal: opts.signal });
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
      if (planeOnly) return { width, height, __image16: plane16 };
      const data8 = result.data8 || downconvertPlane16(out16, new Uint8ClampedArray(sampleCount));
      if (data8.length !== sampleCount) {
        throw new Error(`Unexpected 8-bit mirror length ${data8.length} for ${width}x${height}`);
      }
      const output = new ImageData(data8, width, height);
      output.__image16 = plane16;
      return output;
    } catch (err) {
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
   * worker reports an error it hands the buffer back and it is re-attached to
   * the plane object before resolving null.
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
    const sdrBuffer = await copyTypedArrayInSlices(sdr.data, { signal: opts.signal });
    const transferring = Boolean(opts.transferPlane) && isWholeBufferView(plane.data);
    const inputBuffer = transferring
      ? plane.data.buffer
      : await copyTypedArrayInSlices(plane.data, { signal: opts.signal });
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
      const returnedPlane = err && err.returned && err.returned.plane;
      // Do not let a logged error keep the returned buffers alive.
      if (err && err.returned) delete err.returned;
      if (transferring && plane.data.byteLength === 0) {
        if (returnedPlane instanceof ArrayBuffer && returnedPlane.byteLength === width * height * 8) {
          plane.data = new Uint16Array(returnedPlane);
        } else if (!isAbortError(err)) {
          const lost = makeError(`The frame's 16-bit plane was lost with the export worker: ${err && err.message ? err.message : err}`, 'ExportInputLostError');
          lost.cause = err;
          throw lost;
        }
      }
      if (isAbortError(err)) throw err;
      warnWorkerFallbackOnce('gainMap16', err);
      return null;
    }
  }

  /**
   * Encode 16-bit PNG via Worker: the whole frame, its bands one after another
   * (the same bytes as the band pool).
   * @param {ImageData} imageData
   * @param {function|{onProgress?:function,signal?:AbortSignal,timeoutMs?:number,level?:number,strategy?:number}} [onProgressOrOptions]
   * @returns {Promise<Blob|null>}
   */
  async function workerEncodePng16(imageData, onProgressOrOptions = null) {
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
          height: imageData.height,
          level: opts.level,
          strategy: opts.strategy,
          bandBytes: opts.bandBytes
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
   * @param {function|{onProgress?:function,signal?:AbortSignal,timeoutMs?:number}} [onProgressOrOptions]
   * @returns {Promise<Blob|null>}
   */
  async function workerEncodeTiff(imageData, bitDepth = 8, onProgressOrOptions = null, metadata = null) {
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
   * Terminate the worker (cleanup).
   */
  function terminateWorker() {
    disposeWorker();
    rejectAllPending(new Error('Worker terminated'));
  }

  return {
    workerApplyAdjustments,
    workerApplyAdjustments16,
    workerGainMap16,
    workerEncodePng16,
    workerEncodePng16Band,
    workerEncodeTiff,
    isWorkerAvailable,
    cancelWorkerRequests,
    terminateWorker,
    /** Requests in flight on this bridge (for least-busy dispatch). */
    get pendingCount() { return pending.size; },
    /** Whether a Worker currently exists (never spawns one, unlike isWorkerAvailable). */
    get workerAlive() { return worker !== null; }
  };
}

/**
 * Several bridges for a batch export. Each call goes to the bridge with the
 * fewest requests in flight; `dispose()` terminates every worker once the
 * batch is over. The same API as a single bridge, so callers can take either.
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
    workerEncodePng16: (...args) => pick().workerEncodePng16(...args),
    workerEncodeTiff: (...args) => pick().workerEncodeTiff(...args),
    isWorkerAvailable: () => lanes.every(lane => lane.isWorkerAvailable()),
    cancelWorkerRequests: (reason) => lanes.forEach(lane => lane.cancelWorkerRequests(reason)),
    terminateWorker: () => lanes.forEach(lane => lane.terminateWorker()),
    dispose: () => lanes.forEach(lane => lane.terminateWorker()),
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

const defaultBridge = createExportWorkerBridge();

export const workerApplyAdjustments = defaultBridge.workerApplyAdjustments;
export const workerApplyAdjustments16 = defaultBridge.workerApplyAdjustments16;
export const workerGainMap16 = defaultBridge.workerGainMap16;
export const workerEncodePng16 = defaultBridge.workerEncodePng16;
export const workerEncodeTiff = defaultBridge.workerEncodeTiff;
export const isWorkerAvailable = defaultBridge.isWorkerAvailable;
export const cancelWorkerRequests = defaultBridge.cancelWorkerRequests;
export const terminateWorker = defaultBridge.terminateWorker;
// Hidden-window memory shedding (#241) terminates the singleton only between
// requests; the next call respawns it lazily.
export const exportWorkerPendingCount = () => defaultBridge.pendingCount;
export const isExportWorkerAlive = () => defaultBridge.workerAlive;

import { isLargeImage } from './imageMemoryBudget.js';
import { markOwnedPlanes, mayTransferBuffer } from './planeRelease.js';

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
// A source handed to the worker (#250) did not come back: the caller no
// longer holds its pixels and must decode the frame again. Never a reason to
// convert on the main thread, which would read a detached plane.
export const INPUT_LOST = 'INPUT_LOST';

export function isConversionInputLost(err) {
  return Boolean(err) && err.code === INPUT_LOST;
}

// The caller gave up on the request (its settings moved on). Not a failure:
// callers must neither retire the worker nor retry on the main thread.
export const WORKER_ABORTED = 'WORKER_ABORTED';

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
export function createConversionWorkerClient({ cacheInput = false, retainWorker = false, workerFactory = () => new Worker(
  new URL('../workers/conversionWorker.js', import.meta.url), { type: 'module' }
) } = {}) {
  let worker = null;
  let requestId = 0;
  const pending = new Map();
  // Results whose 16-bit plane stayed in the worker (#233), keyed by the
  // ImageData handed to the caller: { id, worker }.
  const retainedPlanes = new WeakMap();
  let lastSource = null;
  let lastAnalysis = null;
  let lastLocalExposure = null;
  let lastRecipe = null;
  let releaseWhenIdle = false;
  function getWorker() {
    if (worker) return worker;
    worker = workerFactory();
    lastSource = null;
    lastAnalysis = null;
    lastLocalExposure = null;
    lastRecipe = null;
    const currentWorker = worker;
    worker.onmessage = (e) => {
      const msg = e.data;
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.type === 'result' || msg.type === 'committed' || msg.type === 'ready' || msg.type === 'prepared' || msg.type === 'analyzed'
        || msg.type === 'displayNegative' || msg.type === 'resampled' || msg.type === 'roi') entry.resolve(msg);
      else {
        const err = workerError(msg.message || 'Conversion worker error', CONVERSION_FAILED);
        // A lent source the worker hands back with its error.
        if (msg.returned && msg.returned.source16 instanceof ArrayBuffer) err.returnedSource = msg.returned.source16;
        entry.reject(err);
      }
      // The result buffers have transferred to the caller. Release the large
      // source/pristine planes and the worker heap instead of pinning them in
      // the adapter cache until the next photo or application restart.
      if (releaseWhenIdle && !pending.size && worker === currentWorker) {
        currentWorker.terminate();
        worker = null;
        lastSource = lastAnalysis = lastLocalExposure = lastRecipe = null;
        releaseWhenIdle = false;
      }
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
   * Posts one request carrying a frame (convert, or the GPU preview's prepare
   * and analyze, #239) and resolves with the worker's reply. With cacheInput
   * the source, the analysis sample and the strokes are sent only when they
   * changed.
   *
   * `handoff` (#250, batch export only) moves a genuine 16-bit source to the
   * worker instead of cloning it, when its buffer is export-owned and nothing
   * live references it: 'lend' gets it back with the result (the caller reads
   * the base again after the conversion) and 'consume' lets the adapter write
   * the result into it (the caller never reads it again). 8-bit sources are
   * always cloned: `ImageData.data` cannot be re-attached. If a moved source
   * does not come back, the request rejects with INPUT_LOST. `releaseAfter`
   * drops the lane's cached planes once the frame is converted.
   *
   * With `adjust` (prepared Step-3 adjustment settings) the worker also runs
   * the adjustment stage and returns the adjusted 8-bit ImageData only. A
   * `recipe` object keeps `settings` and `adjust` in the worker while the
   * same recipe is passed again. `transfer` hands the frame's 8-bit pixels to
   * the worker instead of copying them; the caller must not read them afterwards.
   *
   * `display` ({ target, geometry }, #248) makes `imageData` a display level: the
   * worker keeps it as the cached source and converts its resample to `target`,
   * so a new display size sends no pixels. `wbSample` asks for the auto-WB
   * sample of the frame as well.
   */
  async function request(type, { imageData, settings, options = {}, handoff = null, releaseAfter = false, adjust = null, recipe = null, transfer = false, signal = null, display = null, wbSample = null }, extra = null) {
    if (signal?.aborted) throw workerError('Conversion was aborted', WORKER_ABORTED);

    let w;
    try {
      w = getWorker();
    } catch (err) {
      throw workerError(`Conversion worker could not start: ${err?.message || err}`, WORKER_UNAVAILABLE);
    }
    const id = ++requestId;
    // A batch lane keeps its worker for the whole roll: restarting a module
    // worker per frame re-fetches the engine and rebuilds its tables.
    if (!cacheInput && !retainWorker && isLargeImage(imageData)) releaseWhenIdle = true;
    const message = {
      type,
      id,
      width: imageData.width,
      height: imageData.height,
      settings,
      options: { ...options },
      ...extra
    };
    if (display) message.display = display;
    if (wbSample) message.wbSample = wbSample;
    if (recipe && recipe === lastRecipe) {
      message.reuseRecipe = true;
      delete message.settings;
    } else {
      if (recipe) message.cacheRecipe = true;
      if (adjust) message.adjust = adjust;
    }

    const analysis = options.analysisImageData || null;
    if (cacheInput) {
      message.cacheInput = true;
      // Keep the 16-bit plane in the worker until commit() asks for it.
      if (options.retain16) message.retain16 = true;
      message.reuseSource = lastSource === imageData;
      message.reuseAnalysis = lastAnalysis === analysis;
      if (message.reuseAnalysis) delete message.options.analysisImageData;
      // Dodge-and-burn strokes arrive as sanitised settings, which are shared
      // and replaced on every edit, never changed in place: the same object is
      // the same strokes, so the worker keeps the last set instead of a clone
      // per slider frame.
      message.reuseLocalExposure = Boolean(settings?.localExposure) && settings.localExposure === lastLocalExposure;
      if (message.reuseLocalExposure) message.settings = { ...settings, localExposure: null };
    }

    // The adapter works from __image16 when present, so for genuinely 16-bit
    // sources we skip cloning the redundant 8-bit plane (~370 MB on big scans).
    const src16 = imageData.__image16;
    const exactBuffer = (data) => data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
      ? data.buffer : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    const transfers = [];
    const moving = !cacheInput && (handoff === 'lend' || handoff === 'consume')
      && src16 && src16.data instanceof Uint16Array
      && src16.data.byteOffset === 0 && src16.data.byteLength === src16.data.buffer.byteLength
      && mayTransferBuffer(src16.data.buffer);
    const lent = moving && handoff === 'lend';
    if (!message.reuseSource) {
      if (src16 && src16.data instanceof Uint16Array) {
        message.image16 = exactBuffer(src16.data);
        if (moving) {
          transfers.push(message.image16);
          if (lent) message.returnSource = true;
          else message.options.ownedSource = true;
        }
      } else {
        message.rgba = exactBuffer(imageData.data);
      }
    }
    if (releaseAfter) message.releaseAfter = true;
    // Without a hand-off or `transfer` there is no transfer list: the caller
    // keeps using its source buffers, so they are structured-cloned. That copy
    // blocks the poster briefly but frees the main thread from the
    // seconds-long conversion itself.
    if (transfer && message.rgba) transfers.push(message.rgba);
    const expectedSourceBytes = moving ? src16.data.byteLength : 0;

    const timeoutMs = conversionTimeoutMs(imageData.width * imageData.height);
    let result;
    try {
      result = await new Promise((resolve, reject) => {
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
        const onAbort = () => {
          if (!pending.has(id)) return;
          pending.delete(id);
          clearTimeout(timer);
          // A worker busy with nothing else is stopped (above 16 MP it is
          // single-use anyway); one that still owes other callers finishes this
          // conversion and its reply is dropped.
          if (worker === w && !pending.size) {
            try { w.terminate(); } catch { /* already gone */ }
            worker = null;
            lastSource = lastAnalysis = lastLocalExposure = lastRecipe = null;
            releaseWhenIdle = false;
          }
          reject(workerError('Conversion was aborted', WORKER_ABORTED));
        };
        const settle = (fn) => (value) => {
          clearTimeout(timer);
          signal?.removeEventListener?.('abort', onAbort);
          fn(value);
        };
        pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
        signal?.addEventListener?.('abort', onAbort, { once: true });
        try {
          w.postMessage(message, transfers);
          if (recipe) lastRecipe = recipe;
          if (cacheInput) {
            lastSource = imageData;
            lastAnalysis = analysis;
            lastLocalExposure = settings?.localExposure || null;
          }
        } catch (err) {
          // A structured-clone failure means this worker can never take our data.
          clearTimeout(timer);
          pending.delete(id);
          reject(workerError(`Conversion worker postMessage failed: ${err?.message || err}`, WORKER_UNAVAILABLE));
        }
      });
    } catch (err) {
      if (moving) {
        // A lent source that came back with the error is intact again; one
        // that did not (a crash, a timeout, a consumed source) is gone.
        if (lent && err && err.returnedSource instanceof ArrayBuffer && err.returnedSource.byteLength === expectedSourceBytes) {
          src16.data = markOwnedPlanes(new Uint16Array(err.returnedSource));
        } else if (src16.data.byteLength === 0) {
          const lost = workerError(`The frame's source was lost with the conversion worker: ${err?.message || err}`, INPUT_LOST);
          lost.cause = err;
          throw lost;
        }
      }
      if (err && err.returnedSource) delete err.returnedSource;
      throw err;
    }

    if (lent) {
      if (result.source16 instanceof ArrayBuffer && result.source16.byteLength === expectedSourceBytes) {
        src16.data = markOwnedPlanes(new Uint16Array(result.source16));
      } else {
        throw workerError('Conversion worker did not return the lent source', INPUT_LOST);
      }
    }
    return { result, w, id };
  }

  /**
   * Run convertFrameWithRouter in the worker.
   * Returns an ImageData with __image16 attached (same contract as the router).
   */
  async function convert(frame) {
    const { result, w, id } = await request('convert', frame);
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
    if (result.retained16) {
      out.__retained16 = true;
      retainedPlanes.set(out, { id, worker: w });
    }
    if (result.histogram) {
      const sample = result.histogram;
      const histogram = new ImageData(new Uint8ClampedArray(sample.rgba), sample.width, sample.height);
      if (sample.image16) histogram.__image16 = { width: sample.width, height: sample.height, data: new Uint16Array(sample.image16) };
      out.__histogramSample = histogram;
    }
    // The display preview a full-resolution render brings along (#248 part 4)
    // and the histogram sample of it.
    if (result.displayPreview) {
      const built = result.displayPreview;
      const preview = new ImageData(new Uint8ClampedArray(built.rgba), built.width, built.height);
      if (built.image16) preview.__image16 = { width: built.width, height: built.height, data: new Uint16Array(built.image16) };
      if (built.histogram) {
        const sample = built.histogram;
        const histogram = new ImageData(new Uint8ClampedArray(sample.rgba), sample.width, sample.height);
        if (sample.image16) histogram.__image16 = { width: sample.width, height: sample.height, data: new Uint16Array(sample.image16) };
        preview.__histogramSample = histogram;
      }
      out.__displayPreview = preview;
    }
    // The viewport-independent auto-WB sample (#248 part 3), a converted positive.
    if (result.wbSample) {
      const sample = result.wbSample;
      out.__wbSample = new ImageData(new Uint8ClampedArray(sample.rgba), sample.width, sample.height);
    }
    // A fresh allocation: an export may hand it on or release it (#250).
    markOwnedPlanes(out);
    return out;
  }

  // The GPU preview's inputs for this frame (#239), from the same cached source:
  // { width, height, pristine, stops, histogram } with typed arrays, where
  // pristine and stops are null when there is nothing to upload.
  convert.prepare = async (frame) => {
    const { result } = await request('prepare', frame);
    const { histogram } = result;
    return {
      width: result.width,
      height: result.height,
      pristine: result.pristine ? new Uint16Array(result.pristine) : null,
      stops: result.stops ? new Float32Array(result.stops) : null,
      histogram: {
        width: histogram.width,
        height: histogram.height,
        data: new Uint16Array(histogram.image16),
        stops: histogram.stops ? new Float32Array(histogram.stops) : null,
      },
    };
  };

  // Runs the analysis the next frame of these settings uses and returns it:
  // { key, channelData, autoColor, positiveAnalysis }. `key` is echoed.
  convert.analyze = async (frame, key = null) => {
    const { result } = await request('analyze', frame, { key });
    return { key: result.key, channelData: result.channelData, autoColor: result.autoColor, positiveAnalysis: result.positiveAnalysis };
  };

  // Whether the worker keeps `imageData` and `analysis` as its cached source
  // and sample (#248: a detail region reuses the cached level).
  convert.holds = (imageData, analysis = null) => Boolean(worker) && lastSource === imageData && lastAnalysis === (analysis || null);

  // A copy of the display negative of a display target (#248), from the
  // cached level: an ImageData with its __image16.
  convert.displayNegative = async (frame) => {
    const { result } = await request('displayNegative', frame);
    const image = new ImageData(new Uint8ClampedArray(result.rgba), result.width, result.height);
    image.__image16 = { width: result.width, height: result.height, data: new Uint16Array(result.image16) };
    return image;
  };

  // Posts a request that leaves the cached source, analysis and strokes alone
  // (#248: the display resample of a full-resolution frame, the detail layer's
  // regions). Resolves with the worker's reply.
  function postUncached(type, body, transfers, pixelCount, signal = null) {
    if (signal?.aborted) return Promise.reject(workerError('Conversion was aborted', WORKER_ABORTED));
    let w;
    try {
      w = getWorker();
    } catch (err) {
      return Promise.reject(workerError(`Conversion worker could not start: ${err?.message || err}`, WORKER_UNAVAILABLE));
    }
    const id = ++requestId;
    const timeoutMs = conversionTimeoutMs(pixelCount);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(workerError(`Conversion worker timed out after ${Math.round(timeoutMs / 1000)}s`, WORKER_TIMEOUT));
      }, timeoutMs);
      const onAbort = () => {
        if (!pending.has(id)) return;
        pending.delete(id);
        clearTimeout(timer);
        reject(workerError('Conversion was aborted', WORKER_ABORTED));
      };
      const settle = (fn) => (value) => {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        fn(value);
      };
      pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      signal?.addEventListener?.('abort', onAbort, { once: true });
      try {
        w.postMessage({ type, id, ...body }, transfers);
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(workerError(`Conversion worker postMessage failed: ${err?.message || err}`, WORKER_UNAVAILABLE));
      }
    });
  }
  convert.postUncached = postUncached;

  // The display preview of a full-resolution frame at `target` with the
  // display filter (#248 part 4), made in the worker and not kept there. Only
  // the 16-bit plane crosses when there is one (a clone, never a transfer: the
  // frame stays the caller's). Resolves to an ImageData (with __image16).
  // `transfer` moves the pixels instead (the caller's own copy of a region).
  convert.resample = async (image, target, { signal = null, transfer = false } = {}) => {
    const plane = image.__image16?.data instanceof Uint16Array ? image.__image16.data : null;
    const body = { width: image.width, height: image.height, target: { width: target.width, height: target.height } };
    if (plane) body.image16 = plane.byteOffset === 0 && plane.buffer.byteLength === plane.byteLength ? plane.buffer : plane.slice().buffer;
    else body.rgba = image.data.byteOffset === 0 && image.data.buffer.byteLength === image.data.byteLength ? image.data.buffer : image.data.slice().buffer;
    const reply = await postUncached('resample', body, transfer ? [body.image16 || body.rgba] : [], image.width * image.height, signal);
    const out = new ImageData(new Uint8ClampedArray(reply.rgba), reply.width, reply.height);
    if (reply.image16) out.__image16 = { width: reply.width, height: reply.height, data: new Uint16Array(reply.image16) };
    return out;
  };

  // A detail region (#248 part 5), converted from `rows` (the region's native
  // 16- or 8-bit pixels, transferred) or from the cached level, with the base's
  // analysis. `warm` only sets up the roi slot. Resolves to the region's 8-bit
  // ImageData (null for `warm`).
  convert.roi = async ({ settings, base = null, region, rows = null, warm = false, signal = null }) => {
    const body = { settings, base, region, warm };
    const transfers = [];
    if (rows) {
      if (rows instanceof Uint16Array) body.image16 = rows.buffer;
      else body.rgba = rows.buffer;
      transfers.push(rows.buffer);
    }
    const reply = await postUncached('roi', body, transfers, region.slotWidth * region.slotHeight, signal);
    if (reply.warm) return null;
    return new ImageData(new Uint8ClampedArray(reply.rgba), reply.width, reply.height);
  };

  // Brings back the 16-bit plane a retaining conversion left in the worker.
  // Resolves to the Uint16Array, or null when the plane is gone: a newer
  // request reused it, or the worker holding it was replaced.
  convert.commit = async (image) => {
    const handle = retainedPlanes.get(image);
    if (!handle) return null;
    retainedPlanes.delete(image);
    const w = worker;
    if (!w || handle.worker !== w) return null;
    const id = ++requestId;
    const timeoutMs = conversionTimeoutMs(image.width * image.height);
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(workerError(`Conversion worker commit timed out after ${Math.round(timeoutMs / 1000)}s`, WORKER_TIMEOUT));
      }, timeoutMs);
      const settle = (fn) => (value) => { clearTimeout(timer); fn(value); };
      pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      try {
        w.postMessage({ type: 'commit', id, resultId: handle.id });
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(workerError(`Conversion worker postMessage failed: ${err?.message || err}`, WORKER_UNAVAILABLE));
      }
    });
    return reply.image16 ? new Uint16Array(reply.image16) : null;
  };

  // Start the worker (module imports, engine tables) ahead of the first
  // conversion, e.g. when the user opens the file picker. It never touches the
  // cached preview source, so it is safe while a photo is open; a dummy
  // convert() would replace that cache. Resolves false instead of rejecting.
  convert.warmUp = () => {
    let w;
    try { w = getWorker(); } catch { return Promise.resolve(false); }
    const id = ++requestId;
    return new Promise((resolve) => {
      pending.set(id, { resolve: () => resolve(true), reject: () => resolve(false) });
      try { w.postMessage({ type: 'warm-up', id }); }
      catch { pending.delete(id); resolve(false); }
    });
  };

  // Terminate the worker and fail whatever it still owed. The next convert()
  // call starts a fresh worker, so this is safe to call at the end of a batch.
  convert.dispose = () => {
    const dying = worker;
    worker = null;
    lastSource = lastAnalysis = lastLocalExposure = lastRecipe = null;
    releaseWhenIdle = false;
    for (const [id, entry] of pending) {
      pending.delete(id);
      entry.reject(workerError('Conversion worker was released', WORKER_CRASHED));
    }
    if (dying) { try { dying.terminate(); } catch { /* already gone */ } }
  };

  return convert;
}

/**
 * Several independent conversion workers for batch export. Each request goes
 * to the lane with the fewest conversions in flight, so up to `size` frames
 * convert at the same time instead of queueing on one worker while the main
 * thread decodes the next file. The interactive preview / full-resolution
 * clients above are untouched; a pool lives only for one batch and is
 * released with dispose().
 */
export function createConversionWorkerPool({ size = 2, workerFactory } = {}) {
  const laneCount = Math.max(1, Math.floor(size) || 1);
  const lanes = [];
  const laneOptions = { retainWorker: true };
  if (workerFactory) laneOptions.workerFactory = workerFactory;
  for (let i = 0; i < laneCount; i++) {
    lanes.push({ inFlight: 0, convert: createConversionWorkerClient(laneOptions) });
  }
  let disposed = false;

  async function convert(request) {
    if (disposed) throw workerError('Conversion worker pool was released', WORKER_UNAVAILABLE);
    let lane = lanes[0];
    for (const candidate of lanes) if (candidate.inFlight < lane.inFlight) lane = candidate;
    lane.inFlight += 1;
    try {
      return await lane.convert(request);
    } finally {
      lane.inFlight -= 1;
    }
  }

  convert.size = laneCount;
  convert.dispose = () => {
    disposed = true;
    for (const lane of lanes) lane.convert.dispose();
  };
  return convert;
}

export const convertFrameInWorker = createConversionWorkerClient();
// The exact renders startFullResolutionRender asks for above 16 MP: a client
// of their own, so aborting a superseded one never fails another caller.
export const convertFullResolutionFrameInWorker = createConversionWorkerClient();
export const convertPreviewFrameInWorker = createConversionWorkerClient({ cacheInput: true });

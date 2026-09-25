// Page side of the multi-shot merge worker (#260). One disposable worker per
// merge: the page decodes each selected file, samples the small grey proxy
// the alignment needs and transfers the full-resolution plane, keeping no
// reference to it. Alignment, warps, the exposure ratio, the merge and the
// PNG encode run in the worker, which is terminated after the result, on any
// failure and on Cancel, so its OpenCV heap and planes are released and the
// page never loads OpenCV for a merge.
import { alignmentSide, sampleAlignmentGray } from './imageAlignment.js';
import { MultiShotError, describeMultiShotError } from './multiShotErrors.js';
import { answerOpenCvWorker } from './opencvRuntime.js';

// Longest side of the grey proxies ORB matches on.
export const MULTI_SHOT_ALIGN_SIDE = 1200;
// OpenCV.js's WASM heap cap (getHeapMax in dist/opencv.js).
const OPENCV_HEAP_CAP = 1073741824;

// Estimated peak of one merge worker for frames of these pixel counts: every
// frame held as a 16-bit RGBA plane (8 B/px), the merged output (8 B/px) and
// the OpenCV heap a plane-only warp leaves behind (16 B/px at its peak, which
// Emscripten's heap growth overshoots by about a fifth; never above the cap).
// Frames are warped to the first frame's size; the largest bounds them.
export function estimateMultiShotWorkerBytes(pixelCounts) {
  const counts = Array.from(pixelCounts || [], (value) => Math.max(0, Number(value) || 0));
  if (!counts.length) return 0;
  const pixels = Math.max(...counts);
  return 8 * pixels * (counts.length + 1) + Math.min(OPENCV_HEAP_CAP, 20 * pixels);
}

// Whether a selection fits the memory budget; with no budget (not finite),
// every selection is attempted and a failure is reported when it happens.
export function multiShotFitsBudget(pixelCounts, budgetBytes) {
  return !Number.isFinite(budgetBytes) || estimateMultiShotWorkerBytes(pixelCounts) <= budgetBytes;
}

// A view that owns its whole ArrayBuffer, so transferring it moves exactly
// these samples (a partial or shared view is copied first).
function ownBuffer(view) {
  const whole = view.buffer instanceof ArrayBuffer && view.byteOffset === 0 && view.byteLength === view.buffer.byteLength;
  return whole ? view : view.slice();
}

function defaultWorkerFactory() {
  return new Worker(new URL('../workers/multiShotWorker.js', import.meta.url), { type: 'module' });
}

/**
 * @param {object} options
 * @param {string} [options.mode] 'average' | 'hdr'
 * @param {function} [options.workerFactory]
 * @param {function} [options.createInlineProcessor] ({ post, signal }) =>
 *   Promise<processor | null>: the Stage 1 path on the main thread, used only
 *   when the module worker cannot start; null when OpenCV is unavailable.
 * @param {function} [options.onProgress] receives the worker's progress
 *   messages plus { stage: 'posted', index, reference } and { stage: 'merging' }.
 */
export function createMultiShotMergeJob({
  mode = 'average',
  workerFactory = defaultWorkerFactory,
  createInlineProcessor = null,
  onProgress = () => {},
  helloTimeoutMs = 15000,
  idleTimeoutMs = 180000,
  maxSide = MULTI_SHOT_ALIGN_SIDE,
  fault = null
} = {}) {
  let worker = null;
  let failure = null;
  let finished = false;
  let fallback = false;
  let reference = null;
  let framesPosted = 0;
  let unacknowledged = 0;
  let merging = false;
  let idleTimer = null;
  let helloTimer = null;
  const abort = new AbortController();
  let rejectFailed;
  const failed = new Promise((_, reject) => { rejectFailed = reject; });
  failed.catch(() => {});
  let resolveResult; let rejectResult;
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  result.catch(() => {});

  function stopWorker() {
    clearTimeout(idleTimer);
    clearTimeout(helloTimer);
    idleTimer = helloTimer = null;
    const dying = worker;
    worker = null;
    if (dying) {
      dying.onmessage = dying.onerror = dying.onmessageerror = null;
      try { dying.terminate(); } catch { /* already stopped */ }
    }
  }

  function fail(error) {
    if (failure || finished) return failure;
    const { code, message } = describeMultiShotError(error);
    failure = error instanceof MultiShotError ? error : new MultiShotError(code, message);
    stopWorker();
    abort.abort(failure);
    rejectFailed(failure);
    rejectResult(failure);
    return failure;
  }

  function report(event) {
    try { onProgress(event); } catch (error) { console.warn('Multi-shot progress update failed:', error); }
  }

  // A worker with work in hand that stays silent this long has died without
  // an error event (a renderer can drop an out-of-memory worker that way).
  function touch() {
    clearTimeout(idleTimer);
    idleTimer = null;
    if (worker && (unacknowledged > 0 || merging)) {
      idleTimer = setTimeout(() => fail(new MultiShotError('memory', 'The merge worker stopped responding')), idleTimeoutMs);
      idleTimer.unref?.();
    }
  }

  function receive(data) {
    if (failure || finished) return;
    if (data?.type === 'progress') {
      if (data.stage === 'frame') unacknowledged = Math.max(0, unacknowledged - 1);
      touch();
      report(data);
    } else if (data?.type === 'result') {
      finished = true;
      merging = false;
      stopWorker();
      resolveResult({
        blob: data.blob || null, width: data.width || 0, height: data.height || 0,
        used: data.used || 0, skipped: data.skipped || 0
      });
    } else if (data?.type === 'error') {
      fail(new MultiShotError(data.code || 'failed', data.message || 'The merge failed'));
    }
  }

  function waitForHello(current) {
    return new Promise((resolve) => {
      helloTimer = setTimeout(() => resolve(false), helloTimeoutMs);
      const settle = (ok) => { clearTimeout(helloTimer); helloTimer = null; resolve(ok); };
      current.onmessage = ({ data }) => {
        if (answerOpenCvWorker(current, data)) return;
        if (data?.type === 'hello') settle(true);
      };
      current.onerror = (event) => { event?.preventDefault?.(); settle(false); };
      current.onmessageerror = () => settle(false);
    });
  }

  const started = (async () => {
    let current = null;
    try {
      current = workerFactory();
    } catch (error) {
      console.warn('Multi-shot worker could not be created:', error?.message || error);
    }
    if (current) {
      worker = current;
      const ok = await Promise.race([waitForHello(current), failed.catch(() => false)]);
      if (failure) throw failure;
      if (ok) {
        // The worker asks for the session's compiled OpenCV module (#252).
        current.onmessage = ({ data }) => { if (worker === current && !answerOpenCvWorker(current, data)) receive(data); };
        current.onerror = (event) => {
          event?.preventDefault?.();
          if (worker === current) fail(new MultiShotError('memory', 'The merge worker stopped unexpectedly'));
        };
        current.onmessageerror = () => {
          if (worker === current) fail(new MultiShotError('failed', 'The merge worker sent an unreadable message'));
        };
        current.postMessage({ type: 'start', mode, fault });
        return (message, transfers) => { current.postMessage(message, transfers); touch(); };
      }
      console.warn('Multi-shot worker did not start; merging on the main thread');
      stopWorker();
    }
    // Nothing was posted yet, so no plane was lost with the worker.
    const process = createInlineProcessor ? await createInlineProcessor({ post: receive, signal: abort.signal }) : null;
    if (failure) throw failure;
    if (!process) throw fail(new MultiShotError('opencv', 'OpenCV is not available'));
    fallback = true;
    void process({ type: 'start', mode, fault });
    return (message) => { void process(message); };
  })();
  started.catch(() => {});

  function frameMessage(index, imageData) {
    const { width, height } = imageData;
    const isReference = !reference;
    let gray;
    let referenceGray = null;
    if (isReference) {
      const long = Math.max(width, height);
      const side = Math.min(maxSide, long);
      gray = sampleAlignmentGray(imageData, side);
      // Pairs are sampled at the larger longest side, capped at maxSide. A
      // reference under the cap is sampled again when a larger frame raises
      // that side, so its (small) samples are kept; above the cap the side
      // never changes and its planes can go.
      reference = { width, height, side, samples: long < maxSide ? { width, height, data: imageData.data.slice() } : null };
    } else {
      const side = alignmentSide(reference, imageData, maxSide);
      gray = sampleAlignmentGray(imageData, side);
      if (side !== reference.side) referenceGray = sampleAlignmentGray(reference.samples, side);
    }
    // The decoded 16-bit plane when there is one (every RAW), else the 8-bit
    // samples; the other plane stays behind with the caller's ImageData.
    const plane = imageData.__image16 && imageData.__image16.data instanceof Uint16Array ? imageData.__image16.data : null;
    const pixels = ownBuffer(plane || imageData.data);
    const message = { type: 'frame', index, width, height, gray };
    message[plane ? 'image16' : 'rgba'] = pixels;
    const transfers = [pixels.buffer, gray.gray.buffer];
    if (referenceGray) {
      message.referenceGray = referenceGray;
      transfers.push(referenceGray.gray.buffer);
    }
    return { message, transfers, isReference };
  }

  async function addFrame(index, imageData) {
    const send = await Promise.race([started, failed]);
    if (failure) throw failure;
    let frame;
    try {
      frame = frameMessage(index, imageData);
      unacknowledged++;
      framesPosted++;
      send(frame.message, frame.transfers);
    } catch (error) {
      throw fail(error);
    }
    report({ stage: 'posted', index, reference: frame.isReference });
  }

  async function merge() {
    const send = await Promise.race([started, failed]);
    if (failure) throw failure;
    merging = true;
    try {
      send({ type: 'merge' }, []);
    } catch (error) {
      throw fail(error);
    }
    report({ stage: 'merging' });
    return result;
  }

  return {
    addFrame,
    merge,
    // Rejects when the job fails or is cancelled; race long waits with it.
    failed,
    cancel: () => { fail(new MultiShotError('cancelled', 'The merge was cancelled')); },
    dispose: () => {
      if (!finished && !failure) fail(new MultiShotError('cancelled', 'The merge was released'));
      stopWorker();
    },
    get framesPosted() { return framesPosted; },
    get fallback() { return fallback; },
    get running() { return !!worker; }
  };
}

// Progress model for the merge modal: an overall fraction and the label of
// the stage now running ("Aligning 2 / 3", "Merging 42 %", "Encoding…").
// `index` is the selected photo a label is about.
const FRAME_STEP = { decode: 0.05, posted: 0.4, align: 0.6, warp: 0.85, exposure: 0.95, frame: 1 };

function stageLabel(event, total) {
  const params = { current: String((event.index ?? 0) + 1), total: String(total) };
  switch (event.stage) {
    case 'decode':
      return { key: 'multiShotStageDecode', fallback: 'Decoding {current} / {total}', params, index: event.index };
    case 'posted':
      return event.reference ? null : { key: 'multiShotStageAlign', fallback: 'Aligning {current} / {total}', params, index: event.index };
    case 'align':
      return event.aligned ? { key: 'multiShotStageWarp', fallback: 'Warping {current} / {total}', params, index: event.index } : null;
    case 'warp':
      return { key: 'multiShotStageExposure', fallback: 'Matching exposure {current} / {total}', params, index: event.index };
    case 'merging':
    case 'merge': {
      const percent = event.total ? Math.floor((100 * event.done) / event.total) : 0;
      return { key: 'multiShotStageMerge', fallback: 'Merging {percent} %', params: { percent: String(percent) }, index: null };
    }
    case 'encode':
      return { key: 'multiShotStageEncode', fallback: 'Encoding…', params: {}, index: null };
    default:
      return null;
  }
}

export function createMultiShotProgress(total) {
  const frames = new Float64Array(Math.max(1, total));
  let merged = 0;
  let encoding = false;
  let label = null;
  return {
    update(event) {
      const step = FRAME_STEP[event.stage];
      if (step && event.index >= 0 && event.index < total) frames[event.index] = Math.max(frames[event.index], step);
      if (event.stage === 'merge' && event.total) merged = event.done / event.total;
      if (event.stage === 'encode') { merged = 1; encoding = true; }
      label = stageLabel(event, total) || label;
      let framePart = 0;
      for (const value of frames) framePart += value;
      framePart /= Math.max(1, total);
      const fraction = Math.min(1, 0.6 * framePart + 0.35 * merged + (encoding ? 0.05 : 0));
      return { fraction, ...(label || { key: null, fallback: '', params: {}, index: null }) };
    }
  };
}

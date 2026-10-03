/**
 * Per-decode bridge to the RAW post-decode worker (#232).
 *
 * `startRawPostDecode()` spawns a disposable module worker and pings it at
 * once, so the module fetch, compile and handshake overlap LibRaw's decode.
 * Each decode owns its worker: there is no shared queue, so a foreground
 * decode never waits behind a background pass, and whoever owns a decode can
 * terminate its worker without touching anyone else's.
 *
 * LibRaw's result buffer is transferred (not copied) to the worker, so every
 * failure mode keeps the pixels or says it lost them:
 *  - no Worker, a worker that fails to start, or a handshake that fails or
 *    does not answer within the timeout: the same steps run on this thread;
 *  - postMessage refusing the transfer: the pixels are still ours, same;
 *  - a worker error that hands pixels back: finish on this thread from the
 *    stage it reached, with the same functions;
 *  - a worker that dies holding the pixels: `run` rejects with
 *    code RAW_POST_DECODE_LOST and the loader takes its embedded-preview path.
 */
import {
  runRawPostDecode,
  finishRawPostDecode,
  describeView,
  viewFromDescription,
  isTransferableRawData
} from './rawPostDecode.js';
import { isSharedPlane } from './crossOriginIsolation.js';

const READY_TIMEOUT_MS = 5000;

function lostError(message) {
  const err = new Error(message);
  err.code = 'RAW_POST_DECODE_LOST';
  return err;
}

// A superseded decode (#243) never finishes on this thread: whatever the
// worker did not do is simply not done.
function abortError(signal) {
  const reason = signal?.reason;
  return reason?.name === 'AbortError' ? reason : new DOMException('RAW post-decode was aborted', 'AbortError');
}

/**
 * @param {{ readyTimeoutMs?: number }} [config]
 * @returns {{ run(result: object, options?: object): Promise<object>, terminate(): void, readonly usesWorker: boolean }}
 */
export function startRawPostDecode({ readyTimeoutMs = READY_TIMEOUT_MS } = {}) {
  let worker = null;
  let settleReady = () => {};
  const ready = new Promise((resolve) => { settleReady = resolve; });
  let pending = null; // { id, resolve, reject }
  let nextId = 1;
  let ranInWorker = false; // diagnostics: did the last run's pixels go through the worker

  function failPending(err) {
    if (!pending) return;
    const entry = pending;
    pending = null;
    entry.reject(err);
  }

  function drop() {
    if (!worker) return;
    try { worker.terminate(); } catch {}
    worker = null;
  }

  if (typeof Worker !== 'undefined') {
    try {
      worker = new Worker(new URL('../workers/rawPostDecodeWorker.js', import.meta.url), { type: 'module' });
    } catch (err) {
      console.warn('[RAW] post-decode worker unavailable, finishing on the main thread:', err?.message || err);
      worker = null;
    }
  }
  if (worker) {
    worker.onmessage = (event) => {
      const msg = event.data;
      if (msg?.type === 'pong') {
        settleReady(true);
        return;
      }
      if (pending && msg?.id === pending.id) {
        const entry = pending;
        pending = null;
        entry.resolve(msg);
      }
    };
    const crashed = (event) => {
      try { event?.preventDefault?.(); } catch {}
      console.warn('[RAW] post-decode worker failed:', event?.message || event?.type || 'error');
      settleReady(false);
      failPending(lostError('RAW post-decode worker crashed'));
      drop();
    };
    worker.onerror = crashed;
    worker.onmessageerror = crashed;
    try {
      worker.postMessage({ type: 'ping', id: 0 });
    } catch (err) {
      settleReady(false);
      drop();
    }
  } else {
    settleReady(false);
  }

  async function workerReady() {
    if (!worker) return false;
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), readyTimeoutMs); });
    try {
      const ok = await Promise.race([ready, timeout]);
      if (!ok) console.warn('[RAW] post-decode worker did not answer, finishing on the main thread');
      return ok && Boolean(worker);
    } finally {
      clearTimeout(timer);
    }
  }

  async function settle(reply, shape, options, signal, reserveDecode) {
    if (reply.type === 'result') {
      ranInWorker = true;
      if (reply.garbled) return { garbled: true };
      return {
        garbled: false,
        width: reply.width,
        height: reply.height,
        rgba16: viewFromDescription(reply.rgba16),
        rgba8: viewFromDescription(reply.rgba8),
        defects: reply.defects,
        filmStats: reply.filmStats || null
      };
    }
    if (signal?.aborted) throw abortError(signal);
    if (reserveDecode) await reserveDecode();
    if (signal?.aborted) throw abortError(signal);
    console.warn('[RAW] post-decode worker failed, finishing on the main thread:', reply.message);
    if (reply.input) {
      return runRawPostDecode({ ...shape, data: viewFromDescription(reply.input) }, options);
    }
    if (reply.rgba16) {
      const data16 = viewFromDescription(reply.rgba16);
      // A shared plane (#264) the worker may have been repairing when it
      // failed is lost: running the pass again on it would not be exact.
      if (reply.stage !== 'repaired' && isSharedPlane(data16)) throw lostError(reply.message || 'RAW post-decode worker failed on a shared plane');
      const image16 = { width: shape.width, height: shape.height, data: data16 };
      return finishRawPostDecode(image16, options, {
        from: reply.stage === 'repaired' ? 'repaired' : 'packed',
        defects: reply.defects || null
      });
    }
    throw lostError(reply.message || 'RAW post-decode worker lost the decode');
  }

  /**
   * Run steps 1–6 of rawPostDecode.js on LibRaw's `result`.
   * `options`: `{ suppressSensorDefects?: boolean, filmStats?: { borderBufferPct } | null }`.
   * `signal` (#243): an aborted decode never runs a step on this thread; the
   * owner terminates the worker to stop the steps running there.
   */
  async function run(result, options = {}, { signal = null, reserveDecode = null } = {}) {
    ranInWorker = false;
    if (signal?.aborted) throw abortError(signal);
    const data = result?.data;
    const ready = isTransferableRawData(data) && await workerReady();
    // Readiness and worker-to-page retries are actual dispatch boundaries.
    // Gate outside the transport catch so refusal cannot run a fallback.
    try { if (reserveDecode) await reserveDecode(); }
    catch (error) { terminate(); throw error; }
    if (!ready || !worker) {
      if (signal?.aborted) throw abortError(signal);
      return runRawPostDecode(result, options);
    }
    if (signal?.aborted) throw abortError(signal);
    const shape = { width: result.width, height: result.height, bits: result.bits, colors: result.colors };
    const input = describeView(data);
    const id = nextId++;
    let reply;
    try {
      reply = await new Promise((resolve, reject) => {
        pending = { id, resolve, reject };
        try {
          worker.postMessage({ type: 'process', id, ...shape, input, options }, [input.buffer]);
        } catch (err) {
          pending = null;
          reject(err);
        }
      });
    } catch (err) {
      if (signal?.aborted) throw abortError(signal);
      if (input.buffer.byteLength > 0) {
        // postMessage refused the transfer (or the worker died before it
        // happened): the pixels are still ours.
        if (reserveDecode) await reserveDecode();
        if (signal?.aborted) throw abortError(signal);
        return runRawPostDecode({ ...shape, data }, options);
      }
      throw err?.code === 'RAW_POST_DECODE_LOST' ? err : lostError(err?.message || String(err));
    }
    return settle(reply, shape, options, signal, reserveDecode);
  }

  function terminate() {
    settleReady(false);
    failPending(lostError('RAW post-decode worker terminated'));
    drop();
  }

  return {
    run,
    terminate,
    get usesWorker() { return Boolean(worker); },
    get ranInWorker() { return ranInWorker; }
  };
}

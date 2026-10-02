// Which LibRaw build runs a decode, and on how many threads (#264 Part D, the
// web app's side).
//
// A libraw-wasm build compiled with OpenMP over Emscripten pthreads says so
// on its class (`LibRaw.features.threads`), sizes its pthread pool inside the
// LibRaw worker from `self.crossOriginIsolated`, and takes the thread count
// per instance (`new LibRaw({ threads })`). Its output does not depend on the
// thread count (#264 Part B). The app asks for threads only where they can
// run: a threaded build on a cross-origin isolated page. Everywhere else,
// and with a build without the flag (libraw-wasm 1.6.0), LibRaw is
// constructed exactly as before: `new LibRaw()`, one thread.
//
// The contract this detects is written down in notes/264.md ("Track A ->
// Track B"); `librawThreadSupport` is the only place that reads it.
//
// A threaded instance that cannot start (its worker, its pthread pool or its
// 4 GB shared memory: nested workers and large shared reservations are what
// the single-threaded build does not need) falls back to `new LibRaw()` for
// the same decode, before any bytes are handed over, and the page stops
// asking for threads. Both builds decode to the same pixels, so this changes
// only the speed.
//
// Every instance's worker is watched (`watchLibRawWorker`): one that fails
// fails the decode at once instead of leaving it to the loader's timeout.
import LibRaw from 'libraw-wasm';
import { isCrossOriginIsolated, sharedMemoryAvailable } from './crossOriginIsolation.js';

// The foreground decode may use every core up to this; the spec's pool is
// min(cores, 8) - 1 workers plus the calling thread.
const MAX_LIBRAW_THREADS = 8;
// A background lane (roll analysis, batch export, warm switching) decodes
// while the user works and while other lanes decode.
const BACKGROUND_LIBRAW_THREADS = 2;
// How long a threaded instance may take to answer its first call (its module
// and pool are up then; 31-62 ms per decode on an M1 Pro): long enough for a
// slow compile, short enough that the single-threaded retry still fits the
// loader's 15 s open budget of a preview decode.
export const THREADED_START_TIMEOUT_MS = 8_000;

// Set when a threaded instance did not start on this page: later decodes go
// straight to the single-threaded build.
let threadedStartFailed = false;

/** Tests: forget that a threaded instance failed to start. */
export function resetLibRawRuntime() {
  threadedStartFailed = false;
}

/**
 * `{ threads, maxThreads }` when `LibRawClass` is a threaded build, else null
 * (libraw-wasm 1.6.0 and any build without the flag).
 */
export function librawThreadSupport(LibRawClass = LibRaw) {
  const features = LibRawClass && typeof LibRawClass === 'function' ? LibRawClass.features : null;
  if (!features || typeof features !== 'object' || features.threads !== true) return null;
  const maxThreads = Number.isFinite(features.maxThreads) && features.maxThreads >= 1
    ? Math.floor(features.maxThreads) : MAX_LIBRAW_THREADS;
  return { threads: true, maxThreads };
}

/**
 * Threads to ask a threaded build for: all the pool offers in the foreground
 * (min(cores, 8, the build's cap)), 2 in a background lane, 1 without
 * cross-origin isolation (the pool is empty there anyway).
 */
export function planLibRawThreads({ isolated = false, hardwareConcurrency = 4, background = false, maxThreads = MAX_LIBRAW_THREADS } = {}) {
  if (!isolated) return 1;
  const cores = Number.isFinite(hardwareConcurrency) && hardwareConcurrency > 0 ? Math.floor(hardwareConcurrency) : 4;
  const pool = Math.max(1, Math.min(cores, MAX_LIBRAW_THREADS, Math.floor(maxThreads) || MAX_LIBRAW_THREADS));
  return background ? Math.min(BACKGROUND_LIBRAW_THREADS, pool) : pool;
}

/**
 * The LibRaw instance for one decode, and how it was chosen:
 * `{ raw, threads, threaded }`. `background`: a lane's decode (capped). A
 * threaded `raw` is a wrapper with libraw-wasm's interface whose first call
 * waits for the instance to start (`startTimeoutMs`) and otherwise runs the
 * decode on `new LibRaw()`; its `threads` then reads 1.
 */
export function createLibRaw({ background = false, LibRawClass = LibRaw, env = globalThis, startTimeoutMs = THREADED_START_TIMEOUT_MS } = {}) {
  const support = librawThreadSupport(LibRawClass);
  // Threads need shared memory, not only the isolation flag: macOS WKWebView
  // reports crossOriginIsolated without a SharedArrayBuffer constructor.
  const isolated = sharedMemoryAvailable(env);
  if (!support || !isolated || threadedStartFailed) return { raw: watchLibRawWorker(new LibRawClass()), threads: 1, threaded: false };
  const threads = planLibRawThreads({
    isolated, background, maxThreads: support.maxThreads,
    hardwareConcurrency: env?.navigator?.hardwareConcurrency
  });
  return { raw: threadedLibRaw(LibRawClass, threads, startTimeoutMs), threads, threaded: true };
}

// `new LibRaw({ threads })` behind libraw-wasm's interface. The instance's
// first call (`runtimeInfo()`, queued behind the pool size the constructor
// sends) answers once its module and pool are up; until then nothing else is
// posted, so the bytes `open()` transfers are still here when the instance
// fails to start, and the single-threaded build decodes them instead.
function threadedLibRaw(LibRawClass, threads, startTimeoutMs) {
  let current = watchLibRawWorker(new LibRawClass({ threads }));
  let started = null;
  let disposed = false;
  const decoder = {
    threads,
    threaded: true,
    open: (...args) => call('open', args),
    metadata: (...args) => call('metadata', args),
    imageData: () => call('imageData', []),
    runtimeInfo: () => call('runtimeInfo', []),
    dispose() {
      if (disposed) return;
      disposed = true;
      disposeInstance(current);
    }
  };

  function start() {
    started ??= (async () => {
      if (typeof current.runtimeInfo !== 'function') return;
      let timer = null;
      try {
        await Promise.race([
          current.runtimeInfo(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`no answer in ${startTimeoutMs} ms`)), startTimeoutMs);
          })
        ]);
      } catch (err) {
        // A dispose (an abort) rejects the pending call: that is no failure.
        if (disposed) throw err;
        threadedStartFailed = true;
        console.warn('[RAW] the threaded LibRaw build did not start; decoding with the single-threaded build:', err?.message || err);
        disposeInstance(current);
        current = watchLibRawWorker(new LibRawClass());
        decoder.threads = 1;
        decoder.threaded = false;
      } finally {
        clearTimeout(timer);
      }
    })();
    return started;
  }

  async function call(fn, args) {
    await start();
    if (disposed) throw new Error('LibRaw disposed');
    if (typeof current[fn] !== 'function') return undefined;
    return current[fn](...args);
  }

  return decoder;
}

function disposeInstance(raw) {
  try {
    if (typeof raw?.dispose === 'function') raw.dispose();
    else raw?.worker?.terminate?.();
  } catch { /* gone */ }
}

const LIBRAW_CALLS = ['open', 'metadata', 'imageData', 'rawImageData', 'thumbnailData', 'runtimeInfo'];

/**
 * libraw-wasm's instance behind its own interface, with its worker watched
 * (#229 review R2-046). A worker that fails fires 'error' and never answers:
 * its script did not load (an isolated page refuses a worker script that a
 * browser cached before the site sent COEP) or an error escaped it.
 * libraw-wasm 1.6.0 does not listen, so each call would wait out the
 * loader's timeout (30 s for `open()`). Here the instance is disposed at once
 * and every pending and later call rejects with the loader's timeout code,
 * so rawFileLoader.js takes its timeout path (the embedded JPEG) without the
 * wait. `dispose()` (an abort) rejects as before, with "LibRaw disposed".
 * An instance without a worker to watch is returned as it is.
 */
export function watchLibRawWorker(raw) {
  const worker = raw?.worker;
  if (typeof worker?.addEventListener !== 'function') return raw;
  let failure = null;
  const pending = new Set();
  const onError = (event) => {
    if (failure) return;
    failure = new Error(`LibRaw's worker failed: ${event?.message || 'its script did not load'}`);
    failure.code = 'RAW_DECODE_TIMEOUT';
    console.warn('[RAW]', failure.message);
    worker.removeEventListener('error', onError);
    for (const entry of pending) entry.reject(failure);
    pending.clear();
    disposeInstance(raw);
  };
  worker.addEventListener('error', onError);
  const watched = {
    get worker() { return raw.worker; },
    dispose() {
      worker.removeEventListener('error', onError);
      disposeInstance(raw);
    }
  };
  for (const fn of LIBRAW_CALLS) {
    if (typeof raw[fn] !== 'function') continue;
    watched[fn] = (...args) => {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const entry = { reject };
        pending.add(entry);
        Promise.resolve(raw[fn](...args)).then(
          (value) => { pending.delete(entry); resolve(value); },
          (error) => { pending.delete(entry); reject(error); }
        );
      });
    };
  }
  return watched;
}

// The script URL LibRaw starts its worker from: constructed once with the
// global Worker constructor wrapped, then disposed.
function captureLibRawWorkerUrl(LibRawClass) {
  const Native = globalThis.Worker;
  if (typeof Native !== 'function') return null;
  let captured = null;
  function Capturing(url, options) {
    captured = String(url);
    return new Native(url, options);
  }
  Capturing.prototype = Native.prototype;
  let raw = null;
  globalThis.Worker = Capturing;
  try {
    raw = new LibRawClass();
  } finally {
    globalThis.Worker = Native;
  }
  try {
    if (typeof raw?.dispose === 'function') raw.dispose();
    else raw?.worker?.terminate?.();
  } catch { /* gone */ }
  return captured;
}

/**
 * The isolation report's LibRaw entry. A threaded build answers from inside
 * its worker (`runtimeInfo()`); otherwise the worker script's response is
 * checked for COEP: a module worker of an isolated page is isolated exactly
 * when its own response carries it. Never rejects.
 */
export async function probeLibRawWorker({ pageIsolated = isCrossOriginIsolated(), LibRawClass = LibRaw, fetchImpl = globalThis.fetch } = {}) {
  try {
    const support = librawThreadSupport(LibRawClass);
    if (support) {
      const { raw } = createLibRaw({ LibRawClass });
      try {
        if (typeof raw.runtimeInfo === 'function') {
          const info = await raw.runtimeInfo();
          return {
            crossOriginIsolated: info?.crossOriginIsolated === true,
            sharedArrayBuffer: info?.crossOriginIsolated === true,
            threads: Number(info?.threads) || 1,
            poolSize: Number(info?.poolSize) || 0,
            // False on a page without shared memory, or when the threaded
            // build did not start: the single-threaded one answered.
            threaded: typeof info?.threaded === 'boolean' ? info.threaded : raw.threaded === true
          };
        }
      } finally {
        try { raw.dispose?.(); } catch { /* gone */ }
      }
    }
    const url = captureLibRawWorkerUrl(LibRawClass);
    if (!url) return { error: 'no worker URL' };
    // The response the worker load gets, from the HTTP cache where it has
    // one: a copy cached before the site sent COEP is refused by the
    // isolated page, while a fresh fetch would report it isolated (#229
    // review R2-046).
    const response = await fetchImpl(url, { cache: 'default' });
    const coep = String(response.headers.get('cross-origin-embedder-policy') || '').trim().toLowerCase();
    try { await response.body?.cancel?.(); } catch { /* already read */ }
    const embedderPolicy = coep === 'require-corp' || coep === 'credentialless';
    return { crossOriginIsolated: pageIsolated && embedderPolicy, inferred: true, coep: coep || null, threaded: Boolean(support) };
  } catch (error) {
    return { error: String(error?.message || error) };
  }
}

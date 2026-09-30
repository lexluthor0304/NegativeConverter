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
import LibRaw from 'libraw-wasm';
import { isCrossOriginIsolated } from './crossOriginIsolation.js';

// The foreground decode may use every core up to this; the spec's pool is
// min(cores, 8) - 1 workers plus the calling thread.
const MAX_LIBRAW_THREADS = 8;
// A background lane (roll analysis, batch export, warm switching) decodes
// while the user works and while other lanes decode.
const BACKGROUND_LIBRAW_THREADS = 2;

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
 * `{ raw, threads, threaded }`. `background`: a lane's decode (capped).
 */
export function createLibRaw({ background = false, LibRawClass = LibRaw, env = globalThis } = {}) {
  const support = librawThreadSupport(LibRawClass);
  const isolated = isCrossOriginIsolated(env);
  if (!support || !isolated) return { raw: new LibRawClass(), threads: 1, threaded: false };
  const threads = planLibRawThreads({
    isolated, background, maxThreads: support.maxThreads,
    hardwareConcurrency: env?.navigator?.hardwareConcurrency
  });
  return { raw: new LibRawClass({ threads }), threads, threaded: true };
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
            threaded: true
          };
        }
      } finally {
        try { raw.dispose?.(); } catch { /* gone */ }
      }
    }
    const url = captureLibRawWorkerUrl(LibRawClass);
    if (!url) return { error: 'no worker URL' };
    const response = await fetchImpl(url, { cache: 'no-store' });
    const coep = String(response.headers.get('cross-origin-embedder-policy') || '').trim().toLowerCase();
    try { await response.body?.cancel?.(); } catch { /* already read */ }
    const embedderPolicy = coep === 'require-corp' || coep === 'credentialless';
    return { crossOriginIsolated: pageIsolated && embedderPolicy, inferred: true, coep: coep || null, threaded: Boolean(support) };
  } catch (error) {
    return { error: String(error?.message || error) };
  }
}

import { defaultInferencePreference } from './inferenceBackend.js';
import { sharedMemoryAvailable } from './crossOriginIsolation.js';

const inWorkerRealm = () => typeof globalThis.WorkerGlobalScope === 'function'
  && globalThis instanceof globalThis.WorkerGlobalScope;

/**
 * ONNX Runtime's WASM threads for this realm (#264 Part A phase 1): with
 * cross-origin isolation and SharedArrayBuffer the threaded runtime can start
 * its pthreads, so a worker gets min(4, cores - 2), at least 1; everywhere
 * else (macOS WKWebView reports isolation without SharedArrayBuffer), and on
 * the page's main thread (the inference fallback, which must not block on its
 * pool), one thread as before.
 */
export function inferenceThreadCount({
  isolated = sharedMemoryAvailable(),
  hardwareConcurrency = globalThis.navigator?.hardwareConcurrency,
  worker = inWorkerRealm()
} = {}) {
  if (!isolated || !worker) return 1;
  const cores = Number.isFinite(hardwareConcurrency) && hardwareConcurrency > 0 ? Math.floor(hardwareConcurrency) : 4;
  return Math.min(4, Math.max(1, cores - 2));
}

let runtimePromise;
let runtimeThreads = 1;
// Keep one runtime per realm: registering both bundles would overwrite ORT's
// provider registry. CPU fallback in Chromium can still use its JSEP runtime.
// `numThreads` and `preference` override the defaults for the first load only
// (measurements compare thread counts in separate worker realms); ORT fixes
// its thread count when the first session initialises the WASM.
export function loadInferenceRuntime({ numThreads = null, preference = null } = {}) {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const cpu = (preference || defaultInferencePreference()) === 'wasm';
      const ort = await (cpu ? import('onnxruntime-web') : import('onnxruntime-web/webgpu'));
      const { wasmUrl, jsepUrl } = await import('./inferenceRuntimeAssets.js');
      // Explicit URLs also work inside Vite's dev-optimized worker chunks.
      const name = cpu ? 'ort-wasm-simd-threaded.wasm' : 'ort-wasm-simd-threaded.jsep.wasm';
      ort.env.wasm.wasmPaths = { [name]: cpu ? wasmUrl : jsepUrl };
      runtimeThreads = Number.isInteger(numThreads) && numThreads >= 1 ? numThreads : inferenceThreadCount();
      ort.env.wasm.numThreads = runtimeThreads;
      return ort;
    })().catch(error => { runtimePromise = null; throw error; });
  }
  return runtimePromise;
}

/** The thread count this realm's runtime was loaded with (1 before loading). */
export function loadedInferenceThreads() {
  return runtimeThreads;
}

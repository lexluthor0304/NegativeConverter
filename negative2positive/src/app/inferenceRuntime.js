import { defaultInferencePreference } from './inferenceBackend.js';

let runtimePromise;
// Keep one runtime per realm: registering both bundles would overwrite ORT's
// provider registry. CPU fallback in Chromium can still use its JSEP runtime.
export function loadInferenceRuntime() {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const cpu = defaultInferencePreference() === 'wasm';
      const ort = await (cpu ? import('onnxruntime-web') : import('onnxruntime-web/webgpu'));
      const { wasmUrl, jsepUrl } = await import('./inferenceRuntimeAssets.js');
      // Explicit URLs also work inside Vite's dev-optimized worker chunks.
      const name = cpu ? 'ort-wasm-simd-threaded.wasm' : 'ort-wasm-simd-threaded.jsep.wasm';
      ort.env.wasm.wasmPaths = { [name]: cpu ? wasmUrl : jsepUrl };
      ort.env.wasm.numThreads = 1;
      return ort;
    })().catch(error => { runtimePromise = null; throw error; });
  }
  return runtimePromise;
}

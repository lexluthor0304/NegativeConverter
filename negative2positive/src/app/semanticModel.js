import { defaultInferencePreference } from './inferenceBackend.js';
import { fetchModelBlob } from './modelCache.js';

// A literal new URL() so Vite fingerprints the model into immutable /assets.
export const SEMANTIC_MODEL_URL = new URL('../assets/models/efficientvit-b1-ade20k.onnx', import.meta.url).href;
const SEMANTIC_MODEL_FAMILY = 'efficientvit-b1-ade20k';
// The desktop app reads the model from its embedded assets; only the web keeps
// an IndexedDB copy, which survives HTTP-cache eviction and offline sessions.
const isDesktopApp = () => typeof globalThis.__TAURI__?.core?.invoke === 'function';

// Serialize model heaps, and recheck relevance when a queued task actually
// starts: a photo switched away from while waiting needs no model inference.
// The model bytes are loaded at most once per page session (one 19 MB Blob,
// memoised, reset on failure) and posted to each short-lived worker; the
// worker and its ORT session still end after every photo.
export function createSemanticAnalyzer({
  workerFactory = () => new Worker(new URL('../workers/semanticWorker.js', import.meta.url), { type: 'module' }),
  modelUrl = () => SEMANTIC_MODEL_URL,
  loadModel = () => fetchModelBlob(modelUrl(), { family: SEMANTIC_MODEL_FAMILY, cache: !isDesktopApp() })
} = {}) {
  let pending = Promise.resolve();
  let warned = false;
  let model = null, loadedModel = null;
  let modelLoads = 0;
  const loadModelOnce = () => {
    if (!model) {
      modelLoads++;
      model = Promise.resolve().then(loadModel)
        .then(value => { loadedModel = value; return value; })
        .catch(error => { model = null; throw error; });
    }
    return model;
  };
  function analyze(image, { timeoutMs = 30000, isCurrent = () => true, pollMs = 200 } = {}) {
    const task = pending.then(async () => {
      if (!isCurrent()) return null;
      // Without the page's copy the worker fetches the model itself, as before.
      const bytes = loadedModel ?? await loadModelOnce().catch(() => null);
      if (!isCurrent()) return null;
      return new Promise((resolve) => {
        let worker, timer, poll, finished = false;
        const finish = (result, error) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          clearInterval(poll);
          if (worker) {
            worker.onmessage = worker.onerror = worker.onmessageerror = null;
            worker.terminate();
          }
          if (error && !warned) { warned = true; console.warn('Semantic anchors unavailable; keeping statistical colour:', error); }
          resolve(result);
        };
        try {
          worker = workerFactory();
          timer = setTimeout(() => finish(null, 'timeout'), timeoutMs);
          // A photo left (or edited) mid-inference needs no answer: terminate
          // the model heap then instead of when the inference ends.
          poll = setInterval(() => { if (!isCurrent()) finish(null); }, pollMs);
          worker.onerror = event => finish(null, event.message);
          worker.onmessageerror = () => finish(null, 'invalid worker message');
          worker.onmessage = ({ data }) => finish(data.error ? null : data, data.error);
          worker.postMessage({ image: { width: image.width, height: image.height, data: image.data },
            preferGpu: defaultInferencePreference() === 'webgpu', modelUrl: modelUrl(), model: bytes });
        } catch (error) { finish(null, error); }
      });
    });
    pending = task.catch(() => null);
    return task;
  }
  // How many times this page session started loading the model (DEBUG_UI and tests).
  analyze.modelLoads = () => modelLoads;
  return analyze;
}

export const analyzeSemanticPreview = createSemanticAnalyzer();

import { defaultInferencePreference } from './inferenceBackend.js';

// Serialize model heaps, and recheck relevance when a queued task actually
// starts: a photo switched away from while waiting needs no model inference.
export function createSemanticAnalyzer({
  workerFactory = () => new Worker(new URL('../workers/semanticWorker.js', import.meta.url), { type: 'module' }),
  modelUrl = () => new URL(`${import.meta.env?.BASE_URL || '/'}models/efficientvit-b1-ade20k.onnx`, location.href).href
} = {}) {
  let pending = Promise.resolve();
  let warned = false;
  return function analyze(image, { timeoutMs = 30000, isCurrent = () => true } = {}) {
    const task = pending.then(() => {
      if (!isCurrent()) return null;
      return new Promise((resolve) => {
        let worker, timer, finished = false;
        const finish = (result, error) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
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
          worker.onerror = event => finish(null, event.message);
          worker.onmessageerror = () => finish(null, 'invalid worker message');
          worker.onmessage = ({ data }) => finish(data.error ? null : data, data.error);
          worker.postMessage({ image: { width: image.width, height: image.height, data: image.data },
            preferGpu: defaultInferencePreference() === 'webgpu', modelUrl: modelUrl() });
        } catch (error) { finish(null, error); }
      });
    });
    pending = task.catch(() => null);
    return task;
  };
}

export const analyzeSemanticPreview = createSemanticAnalyzer();

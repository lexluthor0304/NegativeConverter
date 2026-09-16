import { defaultInferencePreference } from './inferenceBackend.js';

// A disposable worker bounds memory and time. Calls are serialized so a roll
// cannot allocate several ONNX heaps while the first frame is being rendered.
let pending = Promise.resolve();
let warned = false;
export function analyzeSemanticPreview(image, { timeoutMs = 30000 } = {}) {
  const task = pending.then(() => new Promise((resolve) => {
    const worker = new Worker(new URL('../workers/semanticWorker.js', import.meta.url), { type: 'module' });
    const finish = (result, error) => {
      clearTimeout(timer); worker.terminate();
      if (error && !warned) { warned = true; console.warn('Semantic anchors unavailable; keeping statistical colour:', error); }
      resolve(result);
    };
    const timer = setTimeout(() => finish(null, 'timeout'), timeoutMs);
    worker.onerror = event => finish(null, event.message);
    worker.onmessage = ({ data }) => finish(data.error ? null : data, data.error);
    worker.postMessage({ image: { width: image.width, height: image.height, data: image.data }, preferGpu: defaultInferencePreference() === 'webgpu', modelUrl: new URL(`${import.meta.env.BASE_URL}models/efficientvit-b1-ade20k.onnx`, location.href).href });
  }));
  pending = task.catch(() => null);
  return task;
}

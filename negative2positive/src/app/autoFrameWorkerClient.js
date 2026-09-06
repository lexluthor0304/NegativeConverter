export function createAutoFrameWorkerClient({
  workerFactory = () => new Worker(new URL('../workers/autoFrameWorker.js', import.meta.url), { type: 'module' }),
  timeoutMs = 120000,
  idleTimeoutMs = 30000,
} = {}) {
  let worker = null, sequence = 0;
  let idleTimer = null;
  const pending = new Map();
  function fail(error) {
    clearTimeout(idleTimer);
    if (worker) worker.onmessage = worker.onerror = worker.onmessageerror = null;
    worker?.terminate();
    worker = null;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  }
  return (image, options) => new Promise((resolve, reject) => {
    try {
      clearTimeout(idleTimer);
      if (!worker) {
        worker = workerFactory();
        worker.onerror = () => fail(new Error('Auto-frame worker crashed'));
        worker.onmessageerror = () => fail(new Error('Auto-frame worker returned invalid data'));
        worker.onmessage = ({ data }) => {
          const entry = pending.get(data.id);
          if (!entry) return;
          clearTimeout(entry.timer);
          pending.delete(data.id);
          try {
            if (data.error) throw new Error(data.error);
            const result = data.result;
            if (result?.rotatedImageData) {
              const raw = result.rotatedImageData;
              const rotated = new ImageData(raw.data, raw.width, raw.height);
              if (raw.image16) rotated.__image16 = { width: raw.width, height: raw.height, data: raw.image16 };
              result.rotatedImageData = rotated;
            }
            entry.resolve(result);
            if (!pending.size) {
              idleTimer = setTimeout(() => fail(new Error('Auto-frame worker idle')), idleTimeoutMs);
              idleTimer.unref?.();
            }
          } catch (error) {
            entry.reject(error);
            fail(error);
          }
        };
      }
      const id = ++sequence;
      const timer = setTimeout(() => fail(new Error('Auto-frame worker timed out')), timeoutMs);
      pending.set(id, { resolve, reject, timer });
      const rgba = image.data.slice();
      const image16 = image.__image16?.data.slice();
      const transfers = [rgba.buffer];
      if (image16) transfers.push(image16.buffer);
      worker.postMessage({ type: 'analyze-frame', id, width: image.width, height: image.height, rgba, image16, options }, transfers);
    } catch (error) { fail(error); reject(error); }
  });
}

export const analyzeFrameInWorker = createAutoFrameWorkerClient();

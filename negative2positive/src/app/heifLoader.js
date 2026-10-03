// Each decode owns a worker: timeout and completion release the WASM heap.
export const HEIF_PACKAGE_VERSION = '1.19.8';
export function decodeHeifInWorker(file, { signal = null, timeoutMs = 60000, workerFactory = () => new Worker(`${import.meta.env.BASE_URL}codecs/heif-worker.js`) } = {}) {
  return new Promise((resolve, reject) => {
    let worker;
    let timer;
    let finished = false;
    const onAbort = () => finish(signal?.reason?.name === 'AbortError' ? signal.reason
      : new DOMException('HEIF decode was aborted', 'AbortError'));
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      worker?.terminate();
      if (worker) worker.onmessage = worker.onerror = worker.onmessageerror = null;
      if (error) {
        if (error.name !== 'AbortError' && !error.code) error.code = 'HEIC_DECODE_FAILED';
        reject(error);
      } else resolve(value);
    };
    if (signal?.aborted) { onAbort(); return; }
    try {
      worker = workerFactory();
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      timer = setTimeout(() => finish(new Error('HEIF decode timed out')), timeoutMs);
      worker.onerror = () => finish(new Error('HEIF decoder could not start'));
      worker.onmessageerror = () => finish(new Error('HEIF decoder returned unreadable pixels'));
      worker.onmessage = ({ data }) => {
        if (data.error) return finish(Object.assign(new Error(data.error), { code: data.code }));
        finish(null, data);
      };
      worker.postMessage({ file });
    } catch (error) { finish(error); }
  });
}

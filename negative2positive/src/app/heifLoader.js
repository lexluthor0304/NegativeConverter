// Each decode owns a worker: timeout and completion release the WASM heap.
export const HEIF_PACKAGE_VERSION = '1.19.8';
export function decodeHeifInWorker(file, { timeoutMs = 60000, workerFactory = () => new Worker(`${import.meta.env.BASE_URL}codecs/heif-worker.js`) } = {}) {
  return new Promise((resolve, reject) => {
    let worker;
    let timer;
    const finish = (error, value) => {
      clearTimeout(timer);
      worker?.terminate();
      if (error) reject(Object.assign(error, { code: error.code || 'HEIC_DECODE_FAILED' }));
      else resolve(value);
    };
    try {
      worker = workerFactory();
      timer = setTimeout(() => finish(new Error('HEIF decode timed out')), timeoutMs);
      worker.onerror = () => finish(new Error('HEIF decoder could not start'));
      worker.onmessage = ({ data }) => {
        if (data.error) return finish(Object.assign(new Error(data.error), { code: data.code }));
        finish(null, data);
      };
      worker.postMessage({ file });
    } catch (error) { finish(error); }
  });
}

// Each decode owns a worker: timeout and completion release the WASM heap.
export const HEIF_PACKAGE_VERSION = '1.19.8';
export function decodeHeifInWorker(file, {
  timeoutMs = 60000, workerFactory = () => new Worker(`${import.meta.env?.BASE_URL ?? '/'}codecs/heif-worker.js`),
  signal = null, reserveDecode = null
} = {}) {

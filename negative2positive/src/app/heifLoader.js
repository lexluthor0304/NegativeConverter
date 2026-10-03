// Each decode owns a worker: timeout and completion release the WASM heap.
export const HEIF_PACKAGE_VERSION = '1.19.8';
export function decodeHeifInWorker(file, {
  timeoutMs = 60000, workerFactory = () => new Worker(`${import.meta.env?.BASE_URL ?? '/'}codecs/heif-worker.js`),
  signal = null, reserveDecode = null
} = {}) {
  return new Promise((resolve, reject) => {
    let worker;
    let timer;
    let finished = false;
    let admitting = false;
    const aborted = () => signal?.reason?.name === 'AbortError' ? signal.reason
      : new DOMException('HEIF decode was aborted', 'AbortError');
    const onAbort = () => finish(aborted());
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      worker?.terminate();
      if (worker) worker.onmessage = worker.onerror = worker.onmessageerror = null;
      if (error) reject(error);
      else resolve(value);
    };
    const failed = error => finish(Object.assign(error, { code: error.code || 'HEIC_DECODE_FAILED' }));
    if (signal?.aborted) { onAbort(); return; }
    try {
      worker = workerFactory();
      timer = setTimeout(() => failed(new Error('HEIF decode timed out')), timeoutMs);
      signal?.addEventListener?.('abort', onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      worker.onerror = () => failed(new Error('HEIF decoder could not start'));
      worker.onmessageerror = () => failed(new Error('HEIF decoder returned unreadable pixels'));
      worker.onmessage = ({ data }) => {
        if (finished) return;
        if (data.error) return failed(Object.assign(new Error(data.error), { code: data.code }));
        if (data.ready) {
          if (admitting) return;
          admitting = true;
          // Module readiness and the input read precede the actual transfer.
          // No WASM factory or file read remains inside the decode dispatch.
          void (async () => {
            try {
              const buffer = await file.arrayBuffer();
              if (finished) return;
              if (signal?.aborted) { onAbort(); return; }
              if (reserveDecode) await reserveDecode({ kind: 'scan' });
              if (finished) return;
              if (signal?.aborted) { onAbort(); return; }
              worker.postMessage({ buffer }, [buffer]);
            } catch (error) { finish(error); }
          })();
          return;
        }
        finish(null, data);
      };
    } catch (error) { failed(error); }
  });
}

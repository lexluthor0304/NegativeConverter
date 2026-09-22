// Each scan decode owns its worker, so inflate/UTIF heaps are released as soon
// as the transferred pixel planes arrive. There is no full-resolution clone.
export async function decodeScanInWorker(buffer, format, {
  workerFactory = typeof Worker === 'function'
    ? () => new Worker(new URL('../workers/scanDecodeWorker.js', import.meta.url), { type: 'module' }) : null,
  timeoutMs = 120000
} = {}) {
  if (!workerFactory) return null;
  let worker;
  try { worker = workerFactory(); } catch { return null; }
  return new Promise((resolve, reject) => {
    let finished = false;
    let dispatched = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      worker.terminate();
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Scan decode timed out')), timeoutMs);
    worker.onerror = () => {
      // Module workers can fail asynchronously during startup (CSP, browser
      // support, unavailable chunk). Keep input ownership until ready so the
      // existing decoder can still handle these environments.
      if (!dispatched) finish(null, null);
      else finish(new Error('Scan decoder worker failed'));
    };
    worker.onmessageerror = () => finish(new Error('Scan decoder returned unreadable pixels'));
    worker.onmessage = ({ data }) => {
      if (data.ready && !dispatched) {
        dispatched = true;
        try { worker.postMessage({ buffer, format }, [buffer]); }
        catch (error) {
          if (buffer.byteLength) finish(null, null);
          else finish(error);
        }
        return;
      }
      if (data.error) return finish(Object.assign(new Error(data.error), { code: data.code }));
      try {
        const result = new ImageData(data.data, data.width, data.height);
        if (data.image16) result.__image16 = data.image16;
        finish(null, result);
      } catch (error) { finish(error); }
    };
  });
}

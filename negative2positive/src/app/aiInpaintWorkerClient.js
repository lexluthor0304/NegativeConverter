import { createInpaintSession } from './aiInpaint.js';

/** A single model session in its own realm, retaining no model bytes on the UI. */
export async function createInpaintWorkerSession(modelBytes, options = {}, {
  workerFactory = () => new Worker(new URL('../workers/aiInpaintWorker.js', import.meta.url), { type: 'module' }),
  timeoutMs = 120000
} = {}) {
  let worker;
  try { worker = workerFactory(); }
  catch (cause) {
    const error = new Error('AI repair worker is unavailable', { cause });
    error.code = 'WORKER_UNAVAILABLE';
    throw error;
  }
  let sequence = 0, closing = false, releasePromise = null, runQueue = Promise.resolve();
  const pending = new Map();
  function stop(error) {
    const dying = worker;
    worker = null;
    if (dying) {
      dying.onmessage = dying.onerror = dying.onmessageerror = null;
      try { dying.terminate(); } catch { /* already stopped */ }
    }
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  }
  worker.onerror = () => stop(new Error('AI repair worker crashed'));
  worker.onmessageerror = () => stop(new Error('Invalid AI repair worker message'));
  worker.onmessage = ({ data }) => {
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    clearTimeout(entry.timer);
    if (data.error) entry.reject(new Error(data.error));
    else entry.resolve(data);
  };
  function request(type, payload = {}, transfers = []) {
    return new Promise((resolve, reject) => {
      if (!worker) { reject(new Error('AI repair worker was released')); return; }
      const id = ++sequence;
      const timer = setTimeout(() => stop(new Error('AI repair worker timed out')), timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { worker.postMessage({ type, id, ...payload }, transfers); }
      catch (error) { stop(error); }
    });
  }
  let metadata;
  try {
    // Clone model bytes only once, retaining the caller's copy for backend or
    // session retries. Tile and result buffers use transfers below.
    metadata = await request('initialize', { modelBytes, options });
  } catch (error) { stop(error); throw error; }
  const run = (image, mask, size, { transferInputs = false, signal = null, shouldContinue = null } = {}) => {
    if (closing) return Promise.reject(new Error('AI repair session was released'));
    const task = runQueue.then(async () => {
      if (signal?.aborted || (shouldContinue && !shouldContinue())) {
        throw new DOMException('AI repair was superseded', 'AbortError');
      }
      const transferable = (data) => transferInputs && data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
        ? data : data.slice();
      const rgb = transferable(image), repair = transferable(mask);
      const response = await request('run', { image: rgb, mask: repair, size }, [rgb.buffer, repair.buffer]);
      return response.output;
    });
    runQueue = task.catch(() => {});
    return task;
  };
  const release = () => {
    if (releasePromise) return releasePromise;
    closing = true;
    releasePromise = (async () => {
      await runQueue;
      if (!worker) return;
      try { await request('release'); }
      finally { stop(new Error('AI repair session was released')); }
    })();
    return releasePromise;
  };
  return { provider: metadata.provider, inputNames: metadata.inputNames,
    outputNames: metadata.outputNames, run, release };
}

export async function createInpaintSessionInWorker(modelBytes, options = {}) {
  if (typeof Worker !== 'function') return createInpaintSession(modelBytes, options);
  try { return await createInpaintWorkerSession(modelBytes, options); }
  catch (error) {
    if (error?.code !== 'WORKER_UNAVAILABLE') throw error;
    return createInpaintSession(modelBytes, options);
  }
}

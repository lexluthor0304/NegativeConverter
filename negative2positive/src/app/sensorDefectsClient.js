/**
 * Promise bridge to the sensor-defect suppression worker.
 *
 * The decoded RAW buffer is transferred (not copied) to the worker, so a
 * worker that never comes up would swallow the pixels. We therefore ping the
 * worker once before the first transfer and fall back to the main-thread
 * implementation whenever the worker is unavailable; a crash mid-run is
 * surfaced as a rejection so the loader can take its embedded-preview path.
 */
import { suppressSensorDefects } from '../silvercore/util/sensorDefects.js';

const PING_TIMEOUT_MS = 5000;

let worker = null;
let workerReady = null; // Promise<boolean>
let requestId = 0;
const pending = new Map();

function rejectAll(err) {
  for (const [id, entry] of pending) {
    pending.delete(id);
    entry.reject(err);
  }
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(
    new URL('../workers/sensorDefectsWorker.js', import.meta.url),
    { type: 'module' }
  );
  worker.onmessage = (e) => {
    const msg = e.data;
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.type === 'result' || msg.type === 'pong') entry.resolve(msg);
    else entry.reject(new Error(msg.message || 'Sensor defect worker error'));
  };
  worker.onerror = (err) => {
    console.error('Sensor defect worker crashed:', err);
    rejectAll(new Error('Sensor defect worker crashed'));
    try { worker.terminate(); } catch {}
    worker = null;
    workerReady = null;
  };
  return worker;
}

function request(message, transfer) {
  const w = getWorker();
  const id = ++requestId;
  message.id = id;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      w.postMessage(message, transfer || []);
    } catch (err) {
      pending.delete(id);
      reject(err);
    }
  });
}

function ensureWorkerReady() {
  if (workerReady) return workerReady;
  workerReady = (async () => {
    try {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Sensor defect worker ping timed out')), PING_TIMEOUT_MS);
      });
      await Promise.race([request({ type: 'ping' }), timeout]);
      clearTimeout(timer);
      return true;
    } catch (err) {
      console.warn('[RAW] sensor defect worker unavailable, repairing on the main thread:', err?.message || err);
      try { worker?.terminate?.(); } catch {}
      worker = null;
      return false;
    }
  })();
  return workerReady;
}

/**
 * Repair isolated sensor defects in `image16` (RGBA Uint16Array), preferring
 * the worker. On success `image16.data` is replaced by the returned buffer.
 * Rejects only if the buffer was lost to a worker crash after transfer.
 *
 * @returns {Promise<{ repaired: number, dead: number, hot: number, perChannel: number[] }>}
 */
export async function suppressSensorDefectsInWorker(image16) {
  const data = image16?.data;
  const wholeBuffer = data instanceof Uint16Array
    && data.byteOffset === 0
    && data.byteLength === data.buffer.byteLength;
  if (typeof Worker === 'undefined' || !wholeBuffer) {
    return suppressSensorDefects(image16);
  }
  if (!(await ensureWorkerReady())) {
    return suppressSensorDefects(image16);
  }

  const { width, height } = image16;
  const buffer = data.buffer;
  let result;
  try {
    result = await request({ type: 'suppress', width, height, buffer }, [buffer]);
  } catch (err) {
    if (buffer.byteLength > 0) {
      // postMessage refused the transfer — pixels are still ours.
      return suppressSensorDefects(image16);
    }
    throw err;
  }
  image16.data = new Uint16Array(result.buffer);
  return result.stats;
}

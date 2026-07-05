/**
 * Promise bridge to the conversion worker. Callers should fall back to the
 * main-thread convertFrameWithRouter when convertFrameInWorker rejects
 * (worker creation blocked, crash, structured-clone failure...).
 */

let worker = null;
let requestId = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(
    new URL('../workers/conversionWorker.js', import.meta.url),
    { type: 'module' }
  );
  worker.onmessage = (e) => {
    const msg = e.data;
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.type === 'result') entry.resolve(msg);
    else entry.reject(new Error(msg.message || 'Conversion worker error'));
  };
  worker.onerror = (err) => {
    console.error('Conversion worker crashed:', err);
    for (const [id, entry] of pending) {
      entry.reject(new Error('Conversion worker crashed'));
      pending.delete(id);
    }
    try { worker.terminate(); } catch {}
    worker = null;
  };
  return worker;
}

/**
 * Run convertFrameWithRouter in the worker.
 * Returns an ImageData with __image16 attached (same contract as the router).
 */
export async function convertFrameInWorker({ imageData, settings, options = {} }) {
  if (typeof Worker === 'undefined') throw new Error('Workers unavailable');

  const w = getWorker();
  const id = ++requestId;
  const message = {
    type: 'convert',
    id,
    width: imageData.width,
    height: imageData.height,
    settings,
    options
  };

  // The adapter works from __image16 when present, so for genuinely 16-bit
  // sources we skip cloning the redundant 8-bit plane (~370 MB on big scans).
  const src16 = imageData.__image16;
  if (src16 && src16.data instanceof Uint16Array) {
    message.image16 = src16.data.buffer;
  } else {
    message.rgba = imageData.data.buffer;
  }
  // No transfer list: the caller keeps using its source buffers, so they are
  // structured-cloned. That copy blocks the poster briefly but frees the main
  // thread from the seconds-long conversion itself.

  const result = await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage(message);
  });

  const out = new ImageData(
    new Uint8ClampedArray(result.rgba),
    result.width,
    result.height
  );
  if (result.image16) {
    out.__image16 = {
      width: result.width,
      height: result.height,
      data: new Uint16Array(result.image16)
    };
  }
  return out;
}

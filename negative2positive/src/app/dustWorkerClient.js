/** Reusable full-resolution dust worker; source pixels and morphology stay there. */
export function createDustWorkerClient({
  workerFactory = () => new Worker(new URL('../workers/dustWorker.js', import.meta.url), { type: 'module' }),
  timeoutMs = 120000, idleTimeoutMs = 30000
} = {}) {
  let worker = null, sequence = 0, source = null, precision = null, idleTimer = null;
  const pending = new Map();
  function release(error) {
    clearTimeout(idleTimer);
    const dying = worker;
    worker = source = precision = null;
    if (dying) {
      dying.onmessage = dying.onerror = dying.onmessageerror = null;
      try { dying.terminate(); } catch { /* already stopped */ }
    }
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  }
  function getWorker() {
    if (worker) return worker;
    const current = workerFactory();
    worker = current;
    current.onerror = () => { if (worker === current) release(new Error('Dust worker crashed')); };
    current.onmessageerror = () => { if (worker === current) release(new Error('Invalid dust worker message')); };
    current.onmessage = ({ data }) => {
      if (worker !== current) return;
      const entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      clearTimeout(entry.timer);
      if (data.error) {
        entry.reject(new Error(data.error));
        release(new Error(data.error));
        return;
      }
      try {
        if (data.image) {
          const raw = data.image;
          const image = new ImageData(raw.data, raw.width, raw.height);
          if (raw.image16) image.__image16 = { width: raw.width, height: raw.height, data: raw.image16 };
          entry.resolve(data.mask ? { imageData: image, mask: data.mask, particleCount: data.particleCount } : image);
        } else entry.resolve({ mask: data.mask, particleCount: data.particleCount, _state: null });
      } catch (error) { entry.reject(error); release(error); }
      if (worker && !pending.size) {
        idleTimer = setTimeout(() => release(new Error('Dust worker idle')), idleTimeoutMs);
        idleTimer.unref?.();
      }
    };
    return current;
  }
  function request(type, image, options) {
    return new Promise((resolve, reject) => {
      try {
        clearTimeout(idleTimer);
        const current = getWorker();
        const id = ++sequence;
        const reuseSource = source === image;
        const message = { type, id, width: image.width, height: image.height, reuseSource, ...options };
        const transfers = [];
        if (!reuseSource) {
          message.rgba = image.data.slice();
          transfers.push(message.rgba.buffer);
        }
        const image16 = type === 'detect' ? null : image.__image16?.data;
        if (image16 && (!reuseSource || precision !== image16)) {
          message.image16 = image16.slice();
          transfers.push(message.image16.buffer);
        }
        if (message.mask) {
          message.mask = message.mask.slice();
          transfers.push(message.mask.buffer);
        }
        if (message.brushMask) {
          message.brushMask = message.brushMask.slice();
          transfers.push(message.brushMask.buffer);
        }
        const timer = setTimeout(() => release(new Error('Dust worker timed out')), timeoutMs);
        pending.set(id, { resolve, reject, timer });
        current.postMessage(message, transfers);
        source = image;
        precision = image16 || (reuseSource ? precision : null);
      } catch (error) { release(error); reject(error); }
    });
  }
  return {
    detect: (image, options = {}) => request('detect', image, options),
    inpaint: (image, mask, radius = 3) => request('inpaint', image, { mask, radius }),
    refine: (image, mask, brushMask, mode) => request('refine', image, { mask, brushMask, mode, radius: 3 }),
    dispose: () => release(new DOMException('Dust worker released', 'AbortError')),
    get pendingCount() { return pending.size; }
  };
}

const shared = createDustWorkerClient();
export const detectDustInWorker = shared.detect;
export const inpaintDustInWorker = shared.inpaint;
export const refineDustMaskInWorker = shared.refine;
export const disposeDustWorker = shared.dispose;

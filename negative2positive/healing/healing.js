export default class HealingEngine {
  constructor() {
    this._nextId = 1;
    this._pending = new Map();
    this._ready = false;

    this.worker = new Worker(new URL('./heal_worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event) => {
      const msg = event.data;
      const pending = this._pending.get(msg?.id);
      if (!pending) return;
      this._pending.delete(msg.id);
      if (msg.ok) pending.resolve(msg.result);
      else pending.reject(new Error(msg.error || 'Healing worker error'));
    };
  }

  async init() {
    if (this._ready) return;
    await this._call('init', {});
    this._ready = true;
  }

  terminate() {
    try {
      this.worker?.terminate();
    } finally {
      this._pending.clear();
      this.worker = null;
      this._ready = false;
    }
  }

  async setPreviewImage(imageData) {
    if (!imageData) return;
    await this.init();
    const width = imageData.width | 0;
    const height = imageData.height | 0;
    const src = imageData.data;
    const rgba = new Uint8Array(src.length);
    rgba.set(src);
    await this._call('setPreviewImage', { width, height, rgba }, [rgba.buffer]);
  }

  async applyPreviewDab(dab, params) {
    await this.init();
    return await this._call('applyPreviewDab', { dab, params });
  }

  async applyStrokeOnRoi(roi, roiW, roiH, roiX0, roiY0, dabs, params) {
    await this.init();
    const rgba = roi instanceof Uint8Array ? roi : new Uint8Array(roi);
    const payload = {
      roiX0: roiX0 | 0,
      roiY0: roiY0 | 0,
      roiW: roiW | 0,
      roiH: roiH | 0,
      rgba,
      dabs,
      params
    };
    const result = await this._call('applyStrokeOnRoi', payload, [rgba.buffer]);
    return result;
  }

  _call(cmd, payload, transfer = []) {
    const id = this._nextId++;
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error('Healing worker not available'));

    const promise = new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
    });
    worker.postMessage({ id, cmd, payload }, transfer);
    return promise;
  }
}


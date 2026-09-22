import {
  detectDust, updateDustStrength, inpaintMasked,
  refineMaskIntelligent, refineMaskDirect, refineMaskRemove
} from '../silvercore/engine/DustRemoval.js';

function countParticles(mask, width, height) {
  const cv = globalThis.cv;
  let mat, contours, hierarchy;
  try {
    mat = new cv.Mat(height, width, cv.CV_8UC1);
    mat.data.set(mask);
    contours = new cv.MatVector();
    hierarchy = new cv.Mat();
    cv.findContours(mat, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    return contours.size();
  } finally { mat?.delete(); contours?.delete(); hierarchy?.delete(); }
}

// The queue also protects cached source/state while OpenCV is initializing.
export function createDustWorkerProcessor({ loadCv = async () => {} } = {}) {
  let source = null, detectionState = null, pending = Promise.resolve();
  async function process(message) {
    if (!['detect', 'inpaint', 'refine'].includes(message.type)) throw new Error('Unknown dust worker request');
    await loadCv();
    const { width, height, id } = message;
    if (!message.reuseSource) {
      source = new ImageData(message.rgba, width, height);
      detectionState = null;
    } else if (!source || source.width !== width || source.height !== height) {
      throw new Error('Missing dust worker source');
    }
    if (message.image16) source.__image16 = { width, height, data: message.image16 };
    if (message.type === 'detect') {
      const result = detectionState
        ? updateDustStrength(source, detectionState, message.strength ?? 3, message.maxParticleSize)
        : detectDust(source, { strength: message.strength, maxParticleSize: message.maxParticleSize });
      detectionState = result._state;
      return { payload: { id, mask: result.mask, particleCount: result.particleCount }, transfers: [result.mask.buffer] };
    }
    let mask = message.mask;
    if (message.type === 'refine') {
      mask = message.mode === 'intelligent'
        ? refineMaskIntelligent(source, mask, message.brushMask)
        : message.mode === 'direct' ? refineMaskDirect(mask, message.brushMask)
          : refineMaskRemove(mask, message.brushMask);
    }
    const image = inpaintMasked(source, mask, message.radius);
    const raw = { width, height, data: image.data, image16: image.__image16?.data };
    const transfers = [raw.data.buffer];
    if (raw.image16) transfers.push(raw.image16.buffer);
    const payload = { id, image: raw };
    if (message.type === 'refine') {
      payload.mask = mask;
      payload.particleCount = countParticles(mask, width, height);
      transfers.push(mask.buffer);
    }
    return { payload, transfers };
  }
  return (message) => {
    const task = pending.then(() => process(message));
    pending = task.catch(() => {});
    return task;
  };
}

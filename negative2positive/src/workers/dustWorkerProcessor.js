import {
  detectDust, updateDustStrength, inpaintMasked,
  refineMaskIntelligent, refineMaskDirect, refineMaskRemove
} from '../silvercore/engine/DustRemoval.js';
import { murmurHash3x86_128 } from '../app/contentHash.js';

// What the page needs to reuse a dust pass without scanning a 60 MP mask on
// its own thread: a hash of the mask's content, and the 64 px blocks holding a
// masked pixel (the only pixels TELEA changes).
export function summarizeDustMask(mask, width, height, blockSize = 64) {
  const columns = Math.ceil(width / blockSize), rows = Math.ceil(height / blockSize);
  const occupied = new Uint8Array(columns * rows);
  for (let y = 0; y < height; y++) {
    const line = y * width, row = ((y / blockSize) | 0) * columns;
    for (let x = 0; x < width; x++) if (mask[line + x]) occupied[row + ((x / blockSize) | 0)] = 1;
  }
  const keys = [];
  for (let key = 0; key < occupied.length; key++) if (occupied[key]) keys.push(key);
  return { hash: murmurHash3x86_128(mask, width), blocks: { size: blockSize, columns, keys: Uint32Array.from(keys) } };
}

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
      return { payload: { id, mask: result.mask, particleCount: result.particleCount,
        maskInfo: summarizeDustMask(result.mask, width, height) }, transfers: [result.mask.buffer] };
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
      payload.maskInfo = summarizeDustMask(mask, width, height);
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

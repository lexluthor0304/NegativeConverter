import { detectDust, updateDustStrength, inpaintMasked } from '../silvercore/engine/DustRemoval.js';
import { applyDustStroke, countMaskParticles, pasteMaskRect } from '../silvercore/engine/DustBrush.js';
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

const PLANE_TYPES = { rgba: Uint8ClampedArray, image16: Uint16Array, mask: Uint8Array };

// The queue also protects cached source/state while OpenCV is initializing.
//
// Besides the clean source (8-bit, and the 16-bit plane once sent) the worker
// keeps the current dust mask under the tag the page gave it and that mask's
// full-frame particle count. Brush strokes then send only their points and
// get back patches sized to the rect they touched (#259). The worker never
// holds a repaired image: patches are recomputed from the clean source.
export function createDustWorkerProcessor({ loadCv = async () => {} } = {}) {
  let source = null, detectionState = null, pending = Promise.resolve();
  let mask = null, maskTag = null, particleCount = null, countWanted = false;
  let upload = null;

  function resetSource(image) {
    source = image;
    detectionState = null;
    mask = maskTag = particleCount = null;
  }

  function adoptMask(next, tag, count, pinned) {
    mask = next;
    maskTag = tag;
    particleCount = Number.isInteger(count) ? count : null;
    countWanted = Boolean(pinned) && particleCount === null;
  }

  // A plane arrives in slices so no single copy blocks the page.
  function receivePlane(message) {
    const { kind, offset, total, chunk, width, height } = message;
    const Type = PLANE_TYPES[kind];
    if (!Type) throw new Error('Unknown dust worker plane');
    if (offset === 0) upload = { kind, data: new Type(total) };
    else if (!upload || upload.kind !== kind || upload.data.length !== total) {
      throw new Error('Dust worker plane arrived out of order');
    }
    upload.data.set(chunk, offset);
    if (!message.done) return;
    const { data } = upload;
    upload = null;
    if (kind === 'rgba') {
      resetSource(new ImageData(data, width, height));
      return;
    }
    if (!source || source.width !== width || source.height !== height) throw new Error('Missing dust worker source');
    if (kind === 'image16') source.__image16 = { width, height, data };
    else adoptMask(data, message.tag, message.particleCount, message.pinned);
  }

  async function process(message) {
    const { width, height, id } = message;
    if (message.type === 'plane') {
      receivePlane(message);
      return { payload: { id }, transfers: [] };
    }
    if (message.type === 'maskDelta') {
      // Undo/redo moved the page's mask by this rect; follow it or forget ours.
      if (mask && maskTag === message.baseTag && source?.width === width && source?.height === height) {
        pasteMaskRect(mask, width, message.rect, message.bytes);
        maskTag = message.tag;
        particleCount = Number.isInteger(message.particleCount) ? message.particleCount : null;
      } else mask = maskTag = particleCount = null;
      return { payload: { id }, transfers: [] };
    }
    if (!['detect', 'inpaint', 'stroke'].includes(message.type)) throw new Error('Unknown dust worker request');
    await loadCv();
    if (!message.reuseSource) {
      resetSource(new ImageData(message.rgba, width, height));
    } else if (!source || source.width !== width || source.height !== height) {
      throw new Error('Missing dust worker source');
    }
    if (message.image16) source.__image16 = { width, height, data: message.image16 };
    if (message.type === 'detect') {
      const result = detectionState
        ? updateDustStrength(source, detectionState, message.strength ?? 3, message.maxParticleSize)
        : detectDust(source, { strength: message.strength, maxParticleSize: message.maxParticleSize });
      detectionState = result._state;
      // A tagged request keeps its mask here for the brush (the reply's copy
      // is transferred to the page).
      if (message.maskTag != null) adoptMask(result.mask.slice(), message.maskTag, null, message.pinned);
      return { payload: { id, mask: result.mask, particleCount: result.particleCount,
        maskInfo: summarizeDustMask(result.mask, width, height) }, transfers: [result.mask.buffer] };
    }
    if (message.type === 'stroke') {
      if (message.mask) adoptMask(message.mask, message.baseTag, message.particleCount, false);
      if (!mask || maskTag !== message.baseTag) {
        throw Object.assign(new Error('Dust worker mask is out of date'), { staleMask: true });
      }
      const state = { source, mask, particleCount };
      let patch;
      try {
        patch = applyDustStroke(state, message);
      } catch (error) {
        // The mask may be half refined: make the next stroke re-send it.
        mask = maskTag = particleCount = null;
        throw error;
      }
      particleCount = state.particleCount;
      maskTag = message.tag;
      if (!patch) return { payload: { id, patch: null, particleCount }, transfers: [] };
      const transfers = [patch.rgba8.buffer, patch.maskBytes.buffer];
      if (patch.rgba16) transfers.push(patch.rgba16.buffer);
      delete patch.maskBefore;
      return { payload: { id, patch }, transfers };
    }
    const image = inpaintMasked(source, message.mask, message.radius);
    const raw = { width, height, data: image.data, image16: image.__image16?.data };
    const transfers = [raw.data.buffer];
    if (raw.image16) transfers.push(raw.image16.buffer);
    return { payload: { id, image: raw }, transfers };
  }

  // While the page edits dust, the first stroke should not pay for the
  // full-frame count (about 0.2 s at 60 MP): take it right after the reply.
  async function countIfWanted() {
    if (!countWanted) return;
    countWanted = false;
    await new Promise(resolve => setTimeout(resolve, 0));
    await loadCv();
    if (mask && particleCount === null && source) particleCount = countMaskParticles(mask, source.width, source.height);
  }

  return (message) => {
    const task = pending.then(() => process(message));
    pending = task.catch(() => {}).then(countIfWanted).catch(() => {});
    return task;
  };
}

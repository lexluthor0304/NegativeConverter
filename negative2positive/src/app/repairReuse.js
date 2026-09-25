// Reuse between AI-repair commits (#246): the recipe stamped on a committed
// repair, so an export can take the result on screen instead of repairing
// again, and the dust half of a commit, kept as the 64 px blocks it changed so
// the next stroke on the same photo can skip it.
import { cloneImageDataChunked } from './aiInpaint.js';

// A very dusty 60 MP frame keeps a few tens of MB of blocks. Beyond this the
// pass is simply run again.
export const DUST_PASS_CACHE_BYTES = 128 * 1024 * 1024;

const weakRef = (value) => (typeof WeakRef === 'function' ? new WeakRef(value) : { deref: () => value });

/**
 * A repair recipe: { source, token, dustEnabled, dustMask, dustRevision,
 * strokes, lensMapping, revision, dustUsedAi }. Fields hold the identities of
 * objects the state already retains, never copies; `dustRevision` is the dust
 * state's revision, since brush strokes patch the mask in place (#259). `dustUsedAi` is which inpainter
 * repaired the dust (true = MI-GAN), or null when the dust mask was empty and
 * either would have left the source unchanged. The stroke pass always uses
 * MI-GAN; `revision` is the model revision both passes ran with.
 */
export function repairRecipesMatch(stamped, current) {
  if (!stamped || !current) return false;
  if (stamped.source !== current.source || stamped.token !== current.token
    || stamped.strokes !== current.strokes || stamped.lensMapping !== current.lensMapping
    || stamped.revision !== current.revision || stamped.dustEnabled !== current.dustEnabled) return false;
  if (!current.dustEnabled) return true;
  return stamped.dustMask === current.dustMask && stamped.dustRevision === current.dustRevision
    && (stamped.dustUsedAi === null || stamped.dustUsedAi === current.dustUsedAi);
}

/** Recipes by result object. A result without one (a TELEA stand-in) never matches. */
export function createRepairStamps() {
  const recipes = new WeakMap();
  return {
    stamp(result, recipe) { if (result && recipe) recipes.set(result, recipe); },
    /** A result patched in place (a dust-brush stroke, #259) no longer matches its recipe. */
    forget(result) { if (result) recipes.delete(result); },
    recipeOf: (result) => (result && recipes.get(result)) || null,
    matches: (result, current) => repairRecipesMatch(result && recipes.get(result), current)
  };
}

/** Whether two sanitised stroke lists select the same pixels (size and points). */
export function sameRepairStrokes(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const pa = a[i]?.points, pb = b[i]?.points;
    if (a[i]?.size !== b[i]?.size || !Array.isArray(pa) || !Array.isArray(pb) || pa.length !== pb.length) return false;
    for (let j = 0; j < pa.length; j++) {
      if (pa[j].x !== pb[j].x || pa[j].y !== pb[j].y || (pa[j].p ?? 1) !== (pb[j].p ?? 1)) return false;
    }
  }
  return true;
}

const plane16Of = (image) => (image?.__image16?.data instanceof Uint16Array ? image.__image16.data : null);

/**
 * Keeps the dust pass's output inside `blocks` ({ size, columns, keys }, the
 * blocks it wrote; everywhere else the output equals `source`), with the key
 * it was made under: the source, the dust mask's content hash, the inpainter
 * and the model revision. Returns null when the blocks would exceed `maxBytes`.
 */
export function captureDustPass(result, { source, maskHash, usedAi, revision, blocks, maxBytes = DUST_PASS_CACHE_BYTES }) {
  if (!result || !source || !maskHash || !blocks) return null;
  const { width, height, data } = result;
  if (source.width !== width || source.height !== height) return null;
  const plane16 = plane16Of(result);
  const { size, columns, keys } = blocks;
  if (keys.length * size * size * (plane16 ? 12 : 4) > maxBytes) return null;
  const saved = [];
  let bytes = 0;
  for (const key of keys) {
    const bx = key % columns, by = (key - bx) / columns;
    const x = bx * size, y = by * size;
    const w = Math.min(size, width - x), h = Math.min(size, height - y);
    if (w <= 0 || h <= 0) continue;
    const data8 = new Uint8ClampedArray(w * h * 4);
    const data16 = plane16 ? new Uint16Array(w * h * 4) : null;
    for (let row = 0; row < h; row++) {
      const from = ((y + row) * width + x) * 4;
      data8.set(data.subarray(from, from + w * 4), row * w * 4);
      if (data16) data16.set(plane16.subarray(from, from + w * 4), row * w * 4);
    }
    saved.push({ x, y, w, h, data8, data16 });
    bytes += data8.byteLength + (data16 ? data16.byteLength : 0);
  }
  return { source: weakRef(source), width, height, has16: Boolean(plane16), maskHash, usedAi, revision, blocks: saved, bytes };
}

export function dustPassMatches(entry, { source, maskHash, usedAi, revision }) {
  return Boolean(entry && maskHash && entry.source.deref() === source && entry.maskHash === maskHash
    && entry.usedAi === usedAi && entry.revision === revision);
}

/**
 * The dust pass's output again: a chunked copy of the source with the kept
 * blocks written back. No mask scan, extraction or inference. Null when the
 * source no longer has the planes the pass produced.
 */
export async function restoreDustPass(entry, source, { check = null, chunkBytes } = {}) {
  const image = await cloneImageDataChunked(source, { check, ...(chunkBytes ? { chunkBytes } : {}) });
  const plane16 = plane16Of(image);
  if (image.width !== entry.width || image.height !== entry.height || Boolean(plane16) !== entry.has16) return null;
  for (const { x, y, w, h, data8, data16 } of entry.blocks) {
    for (let row = 0; row < h; row++) {
      const to = ((y + row) * image.width + x) * 4;
      image.data.set(data8.subarray(row * w * 4, (row + 1) * w * 4), to);
      if (plane16) plane16.set(data16.subarray(row * w * 4, (row + 1) * w * 4), to);
    }
  }
  return image;
}

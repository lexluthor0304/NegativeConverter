// Undo entries for dust-brush strokes (#259). A stroke changes a few thousand
// pixels, so its history entry holds only the bytes it changed, before and
// after, instead of pinning another 720 MB image and 60 MB mask per stroke.
//
// The repaired image and the mask are patched in place. Undo and redo apply
// the bytes to the very objects the stroke patched and make those current
// again. They must run strictly LIFO: then the reference snapshots of other
// history labels, which point at the same objects, always find the content
// that matches their position in the history.

/** Copies `rect` of an RGBA image: its 8-bit bytes and, when present, its 16-bit plane. */
export function copyImageRect(image, rect) {
  const { width } = image;
  const row = rect.width * 4;
  const rgba8 = new Uint8ClampedArray(row * rect.height);
  const plane = image.__image16?.data || null;
  const rgba16 = plane ? new Uint16Array(row * rect.height) : null;
  for (let y = 0; y < rect.height; y++) {
    const start = ((rect.y + y) * width + rect.x) * 4;
    rgba8.set(image.data.subarray(start, start + row), y * row);
    if (rgba16) rgba16.set(plane.subarray(start, start + row), y * row);
  }
  return { rgba8, rgba16 };
}

/** Writes rect-sized RGBA bytes (and the 16-bit plane when both have one) into `image`. */
export function pasteImageRect(image, rect, rgba8, rgba16 = null) {
  const { width } = image;
  const row = rect.width * 4;
  const plane = image.__image16?.data || null;
  for (let y = 0; y < rect.height; y++) {
    const start = ((rect.y + y) * width + rect.x) * 4;
    image.data.set(rgba8.subarray(y * row, (y + 1) * row), start);
    if (plane && rgba16) plane.set(rgba16.subarray(y * row, (y + 1) * row), start);
  }
}

function copyMaskBytes(mask, width, rect) {
  const out = new Uint8Array(rect.width * rect.height);
  for (let y = 0; y < rect.height; y++) {
    const start = (rect.y + y) * width + rect.x;
    out.set(mask.subarray(start, start + rect.width), y * rect.width);
  }
  return out;
}

function pasteMaskBytes(mask, width, rect, bytes) {
  for (let y = 0; y < rect.height; y++) {
    mask.set(bytes.subarray(y * rect.width, (y + 1) * rect.width), (rect.y + y) * width + rect.x);
  }
}

/**
 * Applies a worker's stroke patch to the page's repaired image `target` and
 * `mask` in place, and returns the history entry that can take it back.
 * `context` names the clean source, the particle counts and mask tags before
 * and after, and the worker's own contour counts.
 */
export function applyStrokePatch(target, mask, patch, context) {
  const before = copyImageRect(target, patch.rect);
  const maskBefore = copyMaskBytes(mask, target.width, patch.maskRect);
  pasteImageRect(target, patch.rect, patch.rgba8, patch.rgba16);
  pasteMaskBytes(mask, target.width, patch.maskRect, patch.maskBytes);
  return {
    target, mask, cleanSource: context.cleanSource,
    patches: [{ rect: patch.rect, before8: before.rgba8, before16: before.rgba16, after8: patch.rgba8, after16: patch.rgba16 || null }],
    maskRect: patch.maskRect, maskBefore, maskAfter: patch.maskBytes,
    countBefore: context.countBefore, countAfter: patch.particleCount,
    workerCountBefore: patch.countBefore ?? null, workerCountAfter: patch.particleCount,
    tagBefore: context.tagBefore, tagAfter: context.tagAfter,
    // Whether the image outside a learned-repair refresh was free of TELEA
    // stand-ins before and after this stroke (see amendDustDelta).
    aiCleanBefore: Boolean(context.aiCleanBefore), aiCleanAfter: false,
  };
}

/**
 * Takes a stroke back (`undo`) or puts it back (`redo`) on the objects it
 * patched. Returns what the page must make current again.
 */
export function applyDustDelta(delta, direction) {
  const undo = direction === 'undo';
  const { target, mask, patches } = delta;
  if (undo) {
    for (let i = patches.length - 1; i >= 0; i--) pasteImageRect(target, patches[i].rect, patches[i].before8, patches[i].before16);
    pasteMaskBytes(mask, target.width, delta.maskRect, delta.maskBefore);
  } else {
    for (const patch of patches) pasteImageRect(target, patch.rect, patch.after8, patch.after16);
    pasteMaskBytes(mask, target.width, delta.maskRect, delta.maskAfter);
  }
  return {
    target, mask, cleanSource: delta.cleanSource,
    particleCount: undo ? delta.countBefore : delta.countAfter,
    maskTag: undo ? delta.tagBefore : delta.tagAfter,
    // What the worker's copy must follow: the same mask rect, from tag to tag.
    worker: {
      baseTag: undo ? delta.tagAfter : delta.tagBefore,
      tag: undo ? delta.tagBefore : delta.tagAfter,
      rect: delta.maskRect,
      bytes: undo ? delta.maskBefore : delta.maskAfter,
      particleCount: undo ? delta.workerCountBefore : delta.workerCountAfter,
    },
    rects: patches.map(patch => patch.rect),
    aiClean: undo ? delta.aiCleanBefore : delta.aiCleanAfter,
  };
}

/**
 * Records a later write into `delta.target` over `rect` (the learned-repair
 * refresh of a stroke) as part of the same history entry: `write` runs
 * between the before and after copies. The entry must be the newest one, so
 * LIFO undo takes the refresh back first.
 */
export function amendDustDelta(delta, rect, write) {
  const before = copyImageRect(delta.target, rect);
  write();
  const after = copyImageRect(delta.target, rect);
  delta.patches.push({ rect, before8: before.rgba8, before16: before.rgba16, after8: after.rgba8, after16: after.rgba16 });
}

/**
 * Bytes a history entry keeps alive that `seen` has not counted yet: a
 * delta's own copies and the objects it patches, or a snapshot's references
 * (image planes, and typed arrays such as the dust mask).
 */
export function historyEntryBytes(entry, seen) {
  let bytes = 0;
  const count = (value) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (ArrayBuffer.isView(value)) {
      if (!seen.has(value.buffer)) { seen.add(value.buffer); bytes += value.byteLength; }
      return;
    }
    if (ArrayBuffer.isView(value.data)) count(value.data);
    if (value.__image16?.data) count(value.__image16.data);
  };
  const delta = entry?.dustDelta;
  if (delta) {
    for (const patch of delta.patches) {
      count(patch.before8); count(patch.before16); count(patch.after8); count(patch.after16);
    }
    count(delta.maskBefore); count(delta.maskAfter);
    count(delta.target); count(delta.mask); count(delta.cleanSource);
    return bytes;
  }
  for (const value of Object.values(entry?.refs || {})) count(value);
  return bytes;
}

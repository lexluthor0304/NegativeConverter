// Phase 2 of #237: while a drag waits for the idle repair pass, preview
// conversions read a copy of the display preview source whose specks and
// brushed areas are already filled, so the dust does not flicker back. UI
// only: the settled view and every export come from the exact pass.

// Marks, in a target raster of targetWidth x targetHeight, every pixel whose
// bilinear resample (resizeDisplayPreview) can read a set pixel of `mask`: the
// target cell holding it and its eight neighbours. `bounds` limits the scan to
// a rectangle of the source. Returns whether anything was marked.
export function poolRepairMask(mask, width, height, out, targetWidth, targetHeight, bounds = null) {
  if (!mask || !(width > 0) || !(height > 0)) return false;
  const sx = targetWidth / width, sy = targetHeight / height;
  let any = false;
  const mark = (x, y) => {
    const cx = Math.min(targetWidth - 1, Math.floor((x + 0.5) * sx));
    const cy = Math.min(targetHeight - 1, Math.floor((y + 0.5) * sy));
    const left = Math.max(0, cx - 1), right = Math.min(targetWidth - 1, cx + 1);
    for (let ty = Math.max(0, cy - 1), bottom = Math.min(targetHeight - 1, cy + 1); ty <= bottom; ty++) {
      const row = ty * targetWidth;
      for (let tx = left; tx <= right; tx++) out[row + tx] = 255;
    }
    any = true;
  };
  const x0 = bounds ? Math.max(0, bounds.x) : 0;
  const y0 = bounds ? Math.max(0, bounds.y) : 0;
  const x1 = bounds ? Math.min(width, bounds.x + bounds.width) : width;
  const y1 = bounds ? Math.min(height, bounds.y + bounds.height) : height;
  if (!bounds && mask.byteOffset % 4 === 0) {
    // A dust mask covers the frame sparsely: skip four clear bytes at a time.
    const words = new Uint32Array(mask.buffer, mask.byteOffset, mask.length >> 2);
    for (let w = 0; w < words.length; w++) {
      if (!words[w]) continue;
      for (let i = w << 2, end = i + 4; i < end; i++) {
        if (mask[i]) mark(i % width, (i / width) | 0);
      }
    }
    for (let i = words.length << 2; i < mask.length; i++) {
      if (mask[i]) mark(i % width, (i / width) | 0);
    }
    return any;
  }
  for (let y = y0; y < y1; y++) {
    const row = y * width;
    for (let x = x0; x < x1; x++) if (mask[row + x]) mark(x, y);
  }
  return any;
}

// The number of marked cells of a pooled raster.
export function countPooledCells(out) {
  let count = 0;
  for (let i = 0; i < out.length; i++) if (out[i]) count++;
  return count;
}

// After a brush stroke changed `mask` in place inside `rect` (#259), brings
// `out` up to date: the raster poolRepairMask made from the mask as it was,
// with `extra` (another pooled raster of the same size, or null) OR-ed in.
// Only the target cells a changed pixel can mark are cleared and pooled again,
// from every source pixel that reaches them, so the result equals pooling the
// whole mask again while the scan stays next to the rect. Returns the change
// in the number of marked cells.
export function repoolRepairMaskRect(mask, width, height, out, targetWidth, targetHeight, rect, extra = null) {
  const x0 = Math.max(0, rect.x), y0 = Math.max(0, rect.y);
  const x1 = Math.min(width, rect.x + rect.width), y1 = Math.min(height, rect.y + rect.height);
  if (!mask || x1 <= x0 || y1 <= y0) return 0;
  const sx = targetWidth / width, sy = targetHeight / height;
  const cellX = x => Math.min(targetWidth - 1, Math.floor((x + 0.5) * sx));
  const cellY = y => Math.min(targetHeight - 1, Math.floor((y + 0.5) * sy));
  // The cells a pixel of the rect marks: its own and the eight around it.
  const tx0 = Math.max(0, cellX(x0) - 1), tx1 = Math.min(targetWidth - 1, cellX(x1 - 1) + 1);
  const ty0 = Math.max(0, cellY(y0) - 1), ty1 = Math.min(targetHeight - 1, cellY(y1 - 1) + 1);
  let before = 0;
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let i = ty * targetWidth + tx0, end = ty * targetWidth + tx1; i <= end; i++) {
      if (out[i]) before++;
      out[i] = 0;
    }
  }
  // Every source pixel whose cell lies within one cell of them, with a pixel
  // to spare for rounding: a pixel outside the rect marks only cells that it
  // marked before, which are either cleared above or still marked.
  const span = (c0, c1, scale, cells, size) => {
    const first = Math.max(0, Math.ceil(c0 / scale - 0.5) - 1);
    const last = c1 >= cells - 1 ? size - 1 : Math.min(size - 1, Math.ceil((c1 + 1) / scale - 0.5));
    return [first, last];
  };
  const [sx0, sx1] = span(tx0 - 1, tx1 + 1, sx, targetWidth, width);
  const [sy0, sy1] = span(ty0 - 1, ty1 + 1, sy, targetHeight, height);
  poolRepairMask(mask, width, height, out, targetWidth, targetHeight,
    { x: sx0, y: sy0, width: sx1 - sx0 + 1, height: sy1 - sy0 + 1 });
  let after = 0;
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let i = ty * targetWidth + tx0, end = ty * targetWidth + tx1; i <= end; i++) {
      if (extra && extra[i]) out[i] = 255;
      if (out[i]) after++;
    }
  }
  return after - before;
}

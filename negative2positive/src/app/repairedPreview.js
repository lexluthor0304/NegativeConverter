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

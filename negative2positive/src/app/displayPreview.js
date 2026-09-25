// 表示領域の物理ピクセルに合わせる。解析用の縮小画像とは独立させる。
export function displayPreviewSize(width, height, {
  viewportWidth = 1280, viewportHeight = 900, dpr = 1, zoom = 1,
  maxPixels = 4_000_000, maxDimension = 8192
} = {}) {
  const fit = Math.min(1, Math.max(1, viewportWidth) / width, Math.max(1, viewportHeight) / height);
  const scale = Math.min(1, fit * Math.max(1, dpr) * Math.max(1, zoom),
    Math.sqrt(maxPixels / (width * height)), maxDimension / width, maxDimension / height);
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

// Canvas の 8bit 変換を通さず、RAW の 16bit 値を保ったまま補間する。
export function resizeDisplayPreview(image, { width, height }) {
  if (width >= image.width && height >= image.height) return image;
  const output = new ImageData(width, height);
  if (image.__image16?.data) output.__image16 = { width, height, data: new Uint16Array(width * height * 4) };
  resamplePreview(image, output, 0, width, 0, height);
  return output;
}

// Two bilinear taps per axis. Preview pixel x reads source columns x0 and x1.
function previewTap(x, scale) {
  return Math.max(0, (x + 0.5) * scale - 0.5);
}

function resamplePreview(image, output, px0, px1, py0, py1) {
  const { width } = output;
  const source16 = image.__image16?.data;
  const source = source16 || image.data;
  const data = source16 ? output.__image16.data : output.data;
  const sx = image.width / width;
  const sy = image.height / output.height;
  const span = px1 - px0;
  const left = new Int32Array(span), right = new Int32Array(span), weight = new Float64Array(span);
  for (let i = 0; i < span; i++) {
    const fx = previewTap(px0 + i, sx);
    left[i] = Math.floor(fx);
    right[i] = Math.min(image.width - 1, left[i] + 1);
    weight[i] = fx - left[i];
  }
  for (let y = py0; y < py1; y++) {
    const fy = previewTap(y, sy);
    const y0 = Math.floor(fy);
    const y1 = Math.min(image.height - 1, y0 + 1);
    const dy = fy - y0;
    for (let i = 0; i < span; i++) {
      const x0 = left[i], x1 = right[i], dx = weight[i];
      const a = (y0 * image.width + x0) * 4;
      const b = (y0 * image.width + x1) * 4;
      const c = (y1 * image.width + x0) * 4;
      const d = (y1 * image.width + x1) * 4;
      const dest = (y * width + px0 + i) * 4;
      for (let ch = 0; ch < 4; ch++) {
        const top = source[a + ch] + (source[b + ch] - source[a + ch]) * dx;
        const bottom = source[c + ch] + (source[d + ch] - source[c + ch]) * dx;
        data[dest + ch] = Math.round(top + (bottom - top) * dy);
        if (source16) output.data[dest + ch] = Math.round(data[dest + ch] / 257);
      }
    }
  }
}

// Preview indices [first, last + 1) whose two taps reach source span [start, end).
function previewSpan(start, end, scale, count, limit) {
  let first = -1, last = -1;
  for (let i = 0; i < count; i++) {
    const x0 = Math.floor(previewTap(i, scale));
    const x1 = Math.min(limit - 1, x0 + 1);
    if (x1 < start || x0 >= end) continue;
    if (first < 0) first = i;
    last = i;
  }
  return first < 0 ? null : [first, last + 1];
}

/**
 * After `image` changed inside `rect`, recomputes only the pixels of
 * `preview` (made from it by resizeDisplayPreview) whose taps fall in the
 * rect, with the same arithmetic, so the result equals a full resize. The
 * dust brush uses this to avoid rebuilding a display preview per stroke.
 * Returns the preview rect it rewrote, or null.
 */
export function updateDisplayPreviewRect(image, preview, rect) {
  if (preview === image) return { ...rect };
  const columns = previewSpan(rect.x, rect.x + rect.width, image.width / preview.width, preview.width, image.width);
  const rows = previewSpan(rect.y, rect.y + rect.height, image.height / preview.height, preview.height, image.height);
  if (!columns || !rows) return null;
  resamplePreview(image, preview, columns[0], columns[1], rows[0], rows[1]);
  return { x: columns[0], y: rows[0], width: columns[1] - columns[0], height: rows[1] - rows[0] };
}

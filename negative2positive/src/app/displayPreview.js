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
  const source16 = image.__image16?.data;
  const source = source16 || image.data;
  const data = source16 ? new Uint16Array(width * height * 4) : output.data;
  const sx = image.width / width;
  const sy = image.height / height;
  for (let y = 0; y < height; y++) {
    const fy = Math.max(0, (y + 0.5) * sy - 0.5);
    const y0 = Math.floor(fy);
    const y1 = Math.min(image.height - 1, y0 + 1);
    const dy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.max(0, (x + 0.5) * sx - 0.5);
      const x0 = Math.floor(fx);
      const x1 = Math.min(image.width - 1, x0 + 1);
      const dx = fx - x0;
      const a = (y0 * image.width + x0) * 4;
      const b = (y0 * image.width + x1) * 4;
      const c = (y1 * image.width + x0) * 4;
      const d = (y1 * image.width + x1) * 4;
      const dest = (y * width + x) * 4;
      for (let ch = 0; ch < 4; ch++) {
        const top = source[a + ch] + (source[b + ch] - source[a + ch]) * dx;
        const bottom = source[c + ch] + (source[d + ch] - source[c + ch]) * dx;
        data[dest + ch] = Math.round(top + (bottom - top) * dy);
        if (source16) output.data[dest + ch] = Math.round(data[dest + ch] / 257);
      }
    }
  }
  if (source16) output.__image16 = { width, height, data };
  return output;
}

import { composeSprocketFrame, composeSprocketFrameBackground, getSprocketFrameMetrics,
  areSprocketFrameFontsReady } from './sprocketFrame.js';

// Retain only border strips, never a second full photograph. Returned pixels
// always belong to the caller. One entry bounds the cache across a whole roll.
export function createSprocketFrameCache(maxBytes = 128 * 1024 * 1024) {
  let cached = null;
  const compose = (source, options = {}) => {
    // Smear samples the photograph itself, which callers may edit in place.
    if (options.edgeMarkings?.overexposedSprockets) return composeSprocketFrame(source, options);
    const key = JSON.stringify([source.width, source.height, options, areSprocketFrameFontsReady(options)]);
    if (cached?.key !== key) {
      cached = null;
      const portrait = source.height > source.width;
      const metrics = getSprocketFrameMetrics(portrait ? source.height : source.width,
        portrait ? source.width : source.height, options);
      const x = portrait ? metrics.bandHeight : metrics.sideMargin;
      const y = portrait ? metrics.sideMargin : metrics.bandHeight;
      const width = portrait ? metrics.outputHeight : metrics.outputWidth;
      const height = portrait ? metrics.outputWidth : metrics.outputHeight;
      const bytes = (width * height - source.width * source.height) * 4;
      if (bytes > maxBytes) return composeSprocketFrame(source, options);
      const background = composeSprocketFrameBackground(source, options);
      const rects = [[0, 0, width, y], [0, y + source.height, width, y],
        [0, y, x, source.height], [x + source.width, y, x, source.height]];
      const strips = rects.map(([left, top, w, h]) => {
        const data = new Uint8ClampedArray(w * h * 4);
        for (let row = 0; row < h; row++) {
          const offset = ((top + row) * width + left) * 4;
          data.set(background.data.subarray(offset, offset + w * 4), row * w * 4);
        }
        return { left, top, w, h, data };
      });
      cached = { key, width, height, x, y, strips, bytes };
    }
    const { width, height, x, y, strips } = cached;
    const data = new Uint8ClampedArray(width * height * 4);
    for (const strip of strips) for (let row = 0; row < strip.h; row++) {
      data.set(strip.data.subarray(row * strip.w * 4, (row + 1) * strip.w * 4),
        ((strip.top + row) * width + strip.left) * 4);
    }
    for (let row = 0; row < source.height; row++) {
      data.set(source.data.subarray(row * source.width * 4, (row + 1) * source.width * 4),
        ((y + row) * width + x) * 4);
    }
    return new ImageData(data, width, height);
  };
  compose.clear = () => { cached = null; };
  Object.defineProperty(compose, 'bytes', { get: () => cached?.bytes || 0 });
  return compose;
}

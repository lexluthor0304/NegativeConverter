// The 2D display canvas (#242). #canvas holds the buffer that is drawn — at
// most the display preview, plus the film-border margins — never the whole
// image. Its CSS box is fitted to the full-resolution frame that buffer
// stands for, so the image keeps its on-screen footprint and the pointer
// mappings, which work by ratio, stay correct.

// Above this many pixels the settled Step-3 display frame is adjusted in the
// export worker; at or below it the pass is short enough for this thread.
export const SETTLED_DISPLAY_WORKER_MIN_PIXELS = 1_000_000;

/** 'worker' or 'sync': where the settled display frame of `pixels` is adjusted. */
export function settledDisplayRoute(pixels, workerAvailable) {
  return pixels > SETTLED_DISPLAY_WORKER_MIN_PIXELS && workerAvailable ? 'worker' : 'sync';
}

/**
 * The full-resolution frame a Step-3 display stands for: the processed plane
 * once it is exact, otherwise the conversion source it will be converted
 * from (a preview-only frame is a stand-in for it).
 */
export function step3FrameReference({ processedImageData, processedImageDataIsPreview, conversionSourceImageData }) {
  if (processedImageData && !processedImageDataIsPreview) return processedImageData;
  return conversionSourceImageData || processedImageData || null;
}

/**
 * The size to fit the CSS box against when a smaller buffer stands in for
 * `reference`; null when the reference is not larger in both directions, so
 * a buffer is never shown larger than 100 % of the image it represents.
 */
export function upscaleReference(reference, width, height) {
  if (!reference || !(reference.width > 0) || !(reference.height > 0)) return null;
  if (reference.width <= width || reference.height <= height) return null;
  return { width: reference.width, height: reference.height };
}

/**
 * CSS percentages that lay an element over the photo of a framed canvas
 * (`layout` from getSprocketFrameLayout), whatever size the canvas is shown at.
 */
export function photoRectPercent({ frameWidth, frameHeight, x, y, width, height }) {
  const percent = (value, total) => `${(value / total) * 100}%`;
  return {
    left: percent(x, frameWidth),
    top: percent(y, frameHeight),
    width: percent(width, frameWidth),
    height: percent(height, frameHeight)
  };
}

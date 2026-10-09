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
 * The CSS transform that lays an element with the photo canvas's box (its
 * left, top, width and height, transform-origin 0 0) over `rect` of the
 * frameWidth x frameHeight frame the canvas shows: the photo of a framed
 * canvas (`layout` from getSprocketFrameLayout) or a region of the image.
 *
 * Not a box of its own (#279 follow-up): the compositor puts a canvas at its
 * box rounded to whole CSS pixels in the wrapper's space, before the zoom
 * scales it, so a fractional box drifts off the photo's pixel grid by up to
 * half a CSS pixel times the zoom. The photo canvas's box is whole pixels,
 * and a transform is applied as it is. The translation is a percentage of
 * that box, so the element follows a new fit without being placed again.
 */
export function frameRectTransform({ x, y, width, height }, frameWidth, frameHeight) {
  return `translate(${(x / frameWidth) * 100}%, ${(y / frameHeight) * 100}%) scale(${width / frameWidth}, ${height / frameHeight})`;
}

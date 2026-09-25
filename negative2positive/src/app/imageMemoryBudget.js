// Beyond this size, keep interactive work at display resolution. Export and
// pixel repair explicitly request the original resolution when they need it.
// `?largeImagePixels=N` lowers it for a page, so the browser smoke can drive
// the large-image paths with small fixtures.
function thresholdFromPage() {
  try {
    const value = Number(new URLSearchParams(globalThis.location?.search || '').get('largeImagePixels'));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export const LARGE_IMAGE_PIXELS = thresholdFromPage() ?? 16_000_000;

export function isLargeImage(image) {
  return Number(image?.width) * Number(image?.height) > LARGE_IMAGE_PIXELS;
}

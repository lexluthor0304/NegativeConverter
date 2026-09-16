// Beyond this size, keep interactive work at display resolution. Export and
// pixel repair explicitly request the original resolution when they need it.
export const LARGE_IMAGE_PIXELS = 16_000_000;

export function isLargeImage(image) {
  return Number(image?.width) * Number(image?.height) > LARGE_IMAGE_PIXELS;
}

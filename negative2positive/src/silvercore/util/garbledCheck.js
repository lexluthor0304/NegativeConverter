// Detects whether a freshly decoded RAW image is most likely garbled
// (un-demosaiced Bayer data shown as colorful snow). Used as a sanity gate
// after LibRaw decode — when a new sensor format isn't fully supported by
// the bundled LibRaw, the decoder can return raw mosaic data instead of a
// real image, which the user then sees as random color speckle.
//
// Heuristic: in any real photograph (including film negatives), neighboring
// pixels are strongly correlated, so |pixel - neighbor| is small. In Bayer
// snow, neighbors are nearly independent and the mean absolute neighbor
// difference approaches ~1/3 of full range. We sample 1024 points and
// declare snow when that mean exceeds 25% of full range (very conservative
// — even noisy high-ISO film negatives stay well under 10%).

const SAMPLE_COUNT = 1024;
const SNOW_THRESHOLD_RATIO = 0.25;

export function looksLikeBayerSnow(image16) {
  if (!image16 || !image16.data || !image16.width || !image16.height) return false;
  const { width, height, data } = image16;
  if (width < 4 || height < 4) return false;

  const maxValue = data instanceof Uint16Array ? 65535 : 255;
  const threshold = maxValue * SNOW_THRESHOLD_RATIO;

  // Stride-based pseudo-random sampling — covers the full image without RNG.
  // Stay one pixel inside the right/bottom edges so we always have a right and
  // down neighbor.
  const innerW = width - 1;
  const innerH = height - 1;
  const total = innerW * innerH;
  const stride = Math.max(1, Math.floor(total / SAMPLE_COUNT));

  let sum = 0;
  let count = 0;
  for (let s = 0; s < total && count < SAMPLE_COUNT; s += stride) {
    const x = s % innerW;
    const y = (s / innerW) | 0;
    const i = (y * width + x) * 4;
    const r = data[i];
    const rRight = data[i + 4];          // pixel to the right, R channel
    const rDown = data[i + width * 4];   // pixel below, R channel
    sum += Math.abs(r - rRight) + Math.abs(r - rDown);
    count++;
  }
  if (count === 0) return false;

  const mean = sum / (count * 2);
  return mean > threshold;
}

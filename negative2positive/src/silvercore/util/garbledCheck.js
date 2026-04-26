// Detects whether a freshly decoded RAW image is most likely garbled
// (un-demosaiced Bayer data shown as colorful snow). Used as a sanity gate
// after LibRaw decode — when a new sensor format isn't fully supported by
// the bundled LibRaw, the decoder can return raw mosaic data instead of a
// real image, which the user then sees as random color speckle.
//
// Heuristic: in any real photograph (including film negatives), neighboring
// pixels are strongly correlated, so |pixel - neighbor| is small. In Bayer
// snow, neighbors are nearly independent and the mean absolute neighbor
// difference is close to ~1/3 of full range.
//
// We sample over a 4×4 tile grid and take the MAX tile mean rather than the
// global mean. This catches partial garble — when LibRaw aborts mid-decode
// it often emits a buffer with one half noisy and the other half a flat
// fallback color (Nikon Z f HE mode does this with "data corrupted at N").
// A global mean would average those into a normal-looking number; per-tile
// max pinpoints the noisy region.

const TILES_PER_AXIS = 4;          // 4×4 = 16 tiles
const SAMPLES_PER_TILE = 64;       // ~1024 total samples
// Per-tile mean above 15% of full range = garbled. Calibrated against real
// Nikon Z f HE-mode failure (DSC_4127.NEF) where the noisiest tile averages
// ~16%. Drops well above any realistic film-negative tile mean (sharp
// 4-row banding pattern in the test suite peaks around 10%).
const SNOW_THRESHOLD_RATIO = 0.15;

export function looksLikeBayerSnow(image16) {
  if (!image16 || !image16.data || !image16.width || !image16.height) return false;
  const { width, height, data } = image16;
  if (width < 16 || height < 16) return false;

  const maxValue = data instanceof Uint16Array ? 65535 : 255;
  const threshold = maxValue * SNOW_THRESHOLD_RATIO;

  let maxTileMean = 0;
  for (let ty = 0; ty < TILES_PER_AXIS; ty++) {
    for (let tx = 0; tx < TILES_PER_AXIS; tx++) {
      const x0 = Math.floor((tx * width) / TILES_PER_AXIS);
      const x1 = Math.min(width - 1, Math.floor(((tx + 1) * width) / TILES_PER_AXIS));
      const y0 = Math.floor((ty * height) / TILES_PER_AXIS);
      const y1 = Math.min(height - 1, Math.floor(((ty + 1) * height) / TILES_PER_AXIS));
      const innerW = x1 - x0;
      const innerH = y1 - y0;
      if (innerW < 2 || innerH < 2) continue;
      const total = innerW * innerH;
      const stride = Math.max(1, Math.floor(total / SAMPLES_PER_TILE));

      let sum = 0;
      let count = 0;
      for (let s = 0; s < total && count < SAMPLES_PER_TILE; s += stride) {
        const lx = s % innerW;
        const ly = (s / innerW) | 0;
        const x = x0 + lx;
        const y = y0 + ly;
        if (x + 1 >= width || y + 1 >= height) continue;
        const i = (y * width + x) * 4;
        const r = data[i];
        sum += Math.abs(r - data[i + 4]) + Math.abs(r - data[i + width * 4]);
        count++;
      }
      if (count === 0) continue;
      const mean = sum / (count * 2);
      if (mean > maxTileMean) maxTileMean = mean;
    }
  }

  return maxTileMean > threshold;
}

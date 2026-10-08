// Area (box) reduction of an 8-bit RGBA image, row by row, for display
// proxies such as the crop view's (#245). Output pixel (x, y) is the average
// of the source block of columns [floor(x * W / w), floor((x + 1) * W / w))
// and the rows likewise, so every source pixel counts exactly once and grain
// averages out instead of aliasing as a point sample does. The caller runs
// `rows(y0, y1)` in slices of its choosing; the result does not depend on
// how the rows are split. Alpha is opaque. Display only: the averages are
// rounded to the nearest byte.

function blockStarts(source, target) {
  const starts = new Int32Array(target + 1);
  for (let i = 0; i <= target; i++) starts[i] = Math.floor((i * source) / target);
  return starts;
}

/**
 * @param {{width:number, height:number, data:ArrayLike<number>}} source 8-bit RGBA
 * @param {number} width target width, at most source.width
 * @param {number} height target height, at most source.height
 */
export function createAreaResampler(source, width, height) {
  const sw = source.width;
  const sh = source.height;
  if (!(width >= 1 && height >= 1 && width <= sw && height <= sh)) {
    throw new RangeError(`area reduction ${sw}x${sh} -> ${width}x${height}`);
  }
  const data = new Uint8ClampedArray(width * height * 4);
  const columns = blockStarts(sw, width);
  const rowStarts = blockStarts(sh, height);
  const sums = new Float64Array(width * 3);
  const src = source.data;
  return {
    width,
    height,
    data,
    rows(y0, y1) {
      for (let y = y0; y < y1; y++) {
        sums.fill(0);
        const top = rowStarts[y];
        const bottom = rowStarts[y + 1];
        for (let sy = top; sy < bottom; sy++) {
          let i = sy * sw * 4;
          for (let x = 0, s = 0; x < width; x++, s += 3) {
            let r = 0; let g = 0; let b = 0;
            for (let sx = columns[x], end = columns[x + 1]; sx < end; sx++, i += 4) {
              r += src[i]; g += src[i + 1]; b += src[i + 2];
            }
            sums[s] += r; sums[s + 1] += g; sums[s + 2] += b;
          }
        }
        const rowCount = bottom - top;
        let o = y * width * 4;
        for (let x = 0, s = 0; x < width; x++, s += 3, o += 4) {
          const n = rowCount * (columns[x + 1] - columns[x]);
          data[o] = sums[s] / n;
          data[o + 1] = sums[s + 1] / n;
          data[o + 2] = sums[s + 2] / n;
          data[o + 3] = 255;
        }
      }
    }
  };
}

/** The whole reduction in one call. */
export function areaDownsample(source, width, height) {
  const resampler = createAreaResampler(source, width, height);
  resampler.rows(0, height);
  return { width, height, data: resampler.data };
}

// Local exposure (dodge and burn) pixel operation shared by the engine and the
// app: multiplies a 16-bit RGBA negative by 2^stops per pixel in linear light.
// The data is display-encoded (gamma 2.2); pixels with 0 stops are untouched.

// Exported for the GPU preview (#239), which uploads the table as it is.
export const LINEAR_STEPS = 4096;
export const LINEAR_LUT = new Float32Array(LINEAR_STEPS + 1);
for (let i = 0; i <= LINEAR_STEPS; i++) LINEAR_LUT[i] = Math.pow(i / LINEAR_STEPS, 2.2);

// `stops` is a dense Float32Array (one value per pixel) or a tiled map
// (isTiledStops, #254) of the same frame; either way each pixel gets the same
// arithmetic, and pixels with 0 stops are untouched.
export function applyExposureStopsToImage16(image16, stops) {
  if (!image16 || !image16.data) return image16;
  if (!exposureStopsCover(stops, image16.width, image16.height)) return image16;
  if (isTiledStops(stops)) {
    forEachStopsTile(stops, (tile, x0, y0, w, h) => {
      for (let y = 0; y < h; y++) exposeRgbaRun(image16.data, (y0 + y) * image16.width + x0, tile, y * stops.tileSize, w);
    });
    return image16;
  }
  exposeRgbaRun(image16.data, 0, stops, 0, image16.width * image16.height);
  return image16;
}

// applyExposureStopsToImage16() inside `rect` ({ x, y, width, height }) of the
// frame only: `stops` is the frame's dense map. The pixels outside keep their values.
export function applyExposureStopsToImage16Rect(image16, stops, rect) {
  if (!image16 || !image16.data || !stops || stops.length !== image16.width * image16.height) return image16;
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    const p = y * image16.width + rect.x;
    exposeRgbaRun(image16.data, p, stops, p, rect.width);
  }
  return image16;
}

// `count` pixels of an RGBA16 plane from pixel `p`, with stops read from `stops[q]` on.
export function exposeRgbaRun(data, p, stops, q, count) {
  const max = 65535;
  for (let k = 0; k < count; k++) {
    const s = stops[q + k];
    if (s === 0) continue;
    const gain = Math.pow(2, s);
    const o = (p + k) * 4;
    for (let ch = 0; ch < 3; ch++) {
      const idx = (data[o + ch] / max) * LINEAR_STEPS;
      const i0 = Math.floor(idx); const f = idx - i0;
      const linear = LINEAR_LUT[i0] * (1 - f) + LINEAR_LUT[Math.min(LINEAR_STEPS, i0 + 1)] * f;
      const out = Math.pow(Math.min(1, linear * gain), 1 / 2.2);
      data[o + ch] = Math.round(out * max);
    }
  }
}

// ---- Tiled stops maps (#254 D5) ----
//
// A full-resolution map as tiles of tileSize x tileSize Float32 values, allocated
// only where a stroke reaches: { tiled: true, width, height, tileSize, columns,
// rows, tiles } with tiles[row * columns + column] a Float32Array(tileSize^2) or
// null (every value 0). Edge tiles keep the full size; values past the frame stay 0.

export function isTiledStops(stops) {
  return Boolean(stops && stops.tiled === true && Array.isArray(stops.tiles));
}

// Whether `stops` is a map of a width x height frame (dense length, or tile grid).
export function exposureStopsCover(stops, width, height) {
  if (!stops) return false;
  if (isTiledStops(stops)) return stops.width === width && stops.height === height;
  return stops.length === width * height;
}

// Calls visit(tile, x0, y0, w, h) for each allocated tile, with its frame origin
// and the part of it inside the frame.
export function forEachStopsTile(stops, visit) {
  const { tileSize, columns, rows, tiles, width, height } = stops;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const tile = tiles[row * columns + column];
      if (!tile) continue;
      const x0 = column * tileSize; const y0 = row * tileSize;
      visit(tile, x0, y0, Math.min(tileSize, width - x0), Math.min(tileSize, height - y0));
    }
  }
}

// applyExposureStopsToImage16() for a grey plane (one value per pixel). The RGBA
// version maps each channel through the same arithmetic, so on a grey pixel all
// three channels come out equal to this value.
export function exposeGreyValue(v, s) {
  const max = 65535;
  const gain = Math.pow(2, s);
  const idx = (v / max) * LINEAR_STEPS;
  const i0 = Math.floor(idx); const f = idx - i0;
  const linear = LINEAR_LUT[i0] * (1 - f) + LINEAR_LUT[Math.min(LINEAR_STEPS, i0 + 1)] * f;
  const out = Math.pow(Math.min(1, linear * gain), 1 / 2.2);
  return Math.round(out * max);
}

export function applyExposureStopsToGrey(grey, stops) {
  if (!grey || !stops || stops.length !== grey.length) return grey;
  for (let p = 0; p < grey.length; p++) {
    const s = stops[p];
    if (s === 0) continue;
    grey[p] = exposeGreyValue(grey[p], s);
  }
  return grey;
}

// applyExposureStopsToGrey() inside `rect` of a `width`-wide grey plane only.
export function applyExposureStopsToGreyRect(grey, width, stops, rect) {
  if (!grey || !stops || stops.length !== grey.length) return grey;
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let p = y * width + rect.x, end = p + rect.width; p < end; p++) {
      const s = stops[p];
      if (s === 0) continue;
      grey[p] = exposeGreyValue(grey[p], s);
    }
  }
  return grey;
}

export function hasExposureStops(stops) {
  if (!stops) return false;
  if (isTiledStops(stops)) return stops.tiles.some((tile) => tile && tile.some((s) => s !== 0));
  for (let i = 0; i < stops.length; i++) if (stops[i] !== 0) return true;
  return false;
}

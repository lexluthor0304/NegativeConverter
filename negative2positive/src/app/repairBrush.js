import { sanitizeLocalExposureStrokes, forEachStrokeCoverage, strokeSanitizerStats } from './localExposure.js';

// Cached by input array like sanitizeLocalExposureForSettings: every write
// site assigns a new array, and a result is shared, never mutated.
const sanitizedRepairStrokes = new WeakMap();

// Reuse base-image coordinates so repair strokes follow rotation, mirror and crop.
// These strokes are a selection, never exposure adjustments or automatic dust.
export function sanitizeRepairStrokes(input) {
  if (!Array.isArray(input)) return [];
  let result = sanitizedRepairStrokes.get(input);
  if (!result) {
    strokeSanitizerStats.misses += 1;
    result = sanitizeRepairStrokeList(input);
    sanitizedRepairStrokes.set(input, result);
  }
  return result;
}

function sanitizeRepairStrokeList(input) {
  return sanitizeLocalExposureStrokes({ strokes: input.slice(0, 200).map(stroke => ({
    ...stroke, stops: 1, feather: 0,
    points: stroke?.points?.length > 400
      ? Array.from({ length: 400 }, (_, i) => stroke.points[Math.round(i * (stroke.points.length - 1) / 399)])
      : stroke?.points
  })) })?.strokes.map(({ points, size }) => ({ points, size })) || [];
}

// Lensfun maps corrected destination pixels to their uncorrected source.
// Use the green channel for the shared repair selection when TCA is enabled.
export function lensSourcePoint(point, mapping) {
  if (!mapping) return point;
  const { maps, includeTca } = mapping;
  const useTca = includeTca && maps.tca;
  const grid = useTca || maps.geometry, channels = useTca ? 6 : 2, offset = useTca ? 2 : 0;
  const step = Math.max(1, maps.step || 1);
  const gx = Math.max(0, Math.min(maps.gridWidth - 1, point.x / step));
  const gy = Math.max(0, Math.min(maps.gridHeight - 1, point.y / step));
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const x1 = Math.min(x0 + 1, maps.gridWidth - 1), y1 = Math.min(y0 + 1, maps.gridHeight - 1);
  const sample = c => {
    const at = (x,y) => grid[(y * maps.gridWidth + x) * channels + offset + c];
    const top = at(x0,y0) * (1 - gx + x0) + at(x1,y0) * (gx - x0);
    const bottom = at(x0,y1) * (1 - gx + x0) + at(x1,y1) * (gx - x0);
    return top * (1 - gy + y0) + bottom * (gy - y0);
  };
  return { x: sample(0), y: sample(1) };
}

// The repair selection and the rectangle it occupies ({ x, y, width, height },
// null when empty). Each stroke is rasterised inside its own bounding box only:
// a 60 MP frame must not pay a frame-sized float plane or a per-pixel callback
// for one dab. Strokes are rasterised hard (stops 1, feather 0), so a pixel is
// selected exactly where some stroke's coverage is above zero.
export function buildRepairMask(strokes, geometry, lensMapping = null) {
  const { width, height } = geometry;
  const mask = new Uint8Array(width * height);
  let minX = width, minY = height, maxX = -1, maxY = -1;
  forEachStrokeCoverage({ strokes: strokes.map(stroke => ({
    ...stroke, stops: 1, feather: 0
  })) }, geometry, (stroke, bx0, by0, bw, bh, coverage) => {
    for (let row = 0; row < bh; row++) {
      const y = by0 + row, line = y * width + bx0, offset = row * bw;
      let first = -1, last = -1;
      for (let col = 0; col < bw; col++) {
        if (!(coverage[offset + col] > 0)) continue;
        mask[line + col] = 255;
        if (first < 0) first = col;
        last = col;
      }
      if (first < 0) continue;
      if (bx0 + first < minX) minX = bx0 + first;
      if (bx0 + last > maxX) maxX = bx0 + last;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  });
  const bounds = maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  if (!lensMapping) return { mask, bounds };
  return remapRepairMask(mask, bounds, width, height, lensMapping);
}

// The selection is painted in uncorrected source pixels; lens correction moves
// each displayed pixel to the source point lensSourcePoint gives. Rather than
// sampling the map for every frame pixel, look at it one Lensfun grid cell at a
// time: a cell's bilinear samples stay inside the hull of its four corners, and
// rounding moves them by at most half a pixel, so a cell whose padded hull
// misses the selection cannot read a selected pixel and stays empty. Surviving
// cells sample exactly as lensSourcePoint does, with the same clamps and the
// same expression order, so the result is the per-pixel remap byte for byte.
function remapRepairMask(mask, bounds, width, height, { maps, includeTca }) {
  const corrected = new Uint8Array(width * height);
  if (!bounds) return { mask: corrected, bounds: null };
  const useTca = includeTca && maps.tca;
  const grid = useTca || maps.geometry, channels = useTca ? 6 : 2, offset = useTca ? 2 : 0;
  const step = Math.max(1, maps.step || 1);
  const gridWidth = maps.gridWidth, gridHeight = maps.gridHeight;
  const axis = (length, cells) => {
    const g = new Float64Array(length), cell = new Int32Array(length);
    for (let i = 0; i < length; i++) {
      g[i] = Math.max(0, Math.min(cells - 1, i / step));
      cell[i] = Math.floor(g[i]);
    }
    // Pixels of one cell are contiguous: the cell index never decreases.
    const start = new Int32Array(cells).fill(-1), end = new Int32Array(cells);
    for (let i = 0; i < length; i++) {
      if (start[cell[i]] < 0) start[cell[i]] = i;
      end[cell[i]] = i + 1;
    }
    return { g, cell, start, end };
  };
  const columns = axis(width, gridWidth), rows = axis(height, gridHeight);
  const left = bounds.x, right = bounds.x + bounds.width - 1;
  const top = bounds.y, bottom = bounds.y + bounds.height - 1;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let cy = 0; cy < gridHeight; cy++) {
    const ys = rows.start[cy];
    if (ys < 0) continue;
    const ye = rows.end[cy];
    const y0 = cy, y1 = Math.min(y0 + 1, gridHeight - 1);
    for (let cx = 0; cx < gridWidth; cx++) {
      const xs = columns.start[cx];
      if (xs < 0) continue;
      const x0 = cx, x1 = Math.min(x0 + 1, gridWidth - 1);
      const i00 = (y0 * gridWidth + x0) * channels + offset, i10 = (y0 * gridWidth + x1) * channels + offset;
      const i01 = (y1 * gridWidth + x0) * channels + offset, i11 = (y1 * gridWidth + x1) * channels + offset;
      const a00x = grid[i00], a10x = grid[i10], a01x = grid[i01], a11x = grid[i11];
      const a00y = grid[i00 + 1], a10y = grid[i10 + 1], a01y = grid[i01 + 1], a11y = grid[i11 + 1];
      const loX = Math.min(a00x, a10x, a01x, a11x), hiX = Math.max(a00x, a10x, a01x, a11x);
      const loY = Math.min(a00y, a10y, a01y, a11y), hiY = Math.max(a00y, a10y, a01y, a11y);
      // NaN corners fail every comparison, as their samples fail the frame test.
      if (!(hiX + 1 >= left && loX - 1 <= right && hiY + 1 >= top && loY - 1 <= bottom)) continue;
      const xe = columns.end[cx];
      for (let y = ys; y < ye; y++) {
        const gy = rows.g[y];
        const wy0 = 1 - gy + y0, wy1 = gy - y0;
        const line = y * width;
        for (let x = xs; x < xe; x++) {
          const gx = columns.g[x];
          const wx0 = 1 - gx + x0, wx1 = gx - x0;
          const sx = Math.round((a00x * wx0 + a10x * wx1) * wy0 + (a01x * wx0 + a11x * wx1) * wy1);
          const sy = Math.round((a00y * wx0 + a10y * wx1) * wy0 + (a01y * wx0 + a11y * wx1) * wy1);
          if (!(sx >= 0 && sx < width && sy >= 0 && sy < height) || !mask[sy * width + sx]) continue;
          corrected[line + x] = mask[sy * width + sx];
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
  }
  return { mask: corrected,
    bounds: maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } };
}

export function repairMask(strokes, geometry, lensMapping = null) {
  return buildRepairMask(strokes, geometry, lensMapping).mask;
}

export function pointerToRepairPoint(event, rect, width, height) {
  if (!(rect.width > 0 && rect.height > 0)) return null;
  return {
    x: Math.max(0, Math.min(width, (event.clientX - rect.left) * width / rect.width)),
    y: Math.max(0, Math.min(height, (event.clientY - rect.top) * height / rect.height))
  };
}

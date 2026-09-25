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
  // With a lens map, also note which blocks hold a selected pixel.
  const blocks = lensMapping ? createBlockGrid(width, height) : null;
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
      blocks?.mark(bx0 + first, bx0 + last, y);
    }
  });
  const bounds = maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  if (!lensMapping) return { mask, bounds };
  return remapRepairMask(mask, bounds, blocks, width, height, lensMapping);
}

// Coarse occupancy of the selection in BLOCK px squares, with a summed-area
// table so that "does this rectangle hold a selected pixel?" is four reads.
// Marking may over-cover (a whole row run), never under-cover.
const BLOCK = 16;
function createBlockGrid(width, height) {
  const columns = Math.ceil(width / BLOCK), rows = Math.ceil(height / BLOCK);
  const occupied = new Uint8Array(columns * rows);
  const rowMarked = new Uint8Array(rows);
  let sums = null, rowSums = null;
  return {
    mark(x0, x1, y) {
      const by = (y / BLOCK) | 0, row = by * columns;
      rowMarked[by] = 1;
      for (let bx = (x0 / BLOCK) | 0, end = (x1 / BLOCK) | 0; bx <= end; bx++) occupied[row + bx] = 1;
    },
    // Whether any selected pixel can lie in rows [top, bottom].
    anyRows(top, bottom) {
      if (!rowSums) {
        rowSums = new Int32Array(rows + 1);
        for (let r = 0; r < rows; r++) rowSums[r + 1] = rowSums[r] + rowMarked[r];
      }
      const r0 = Math.max(0, Math.floor(top / BLOCK)), r1 = Math.min(rows - 1, Math.floor(bottom / BLOCK));
      return r0 <= r1 && rowSums[r1 + 1] - rowSums[r0] > 0;
    },
    // Whether any selected pixel can lie in [left, right] x [top, bottom].
    any(left, right, top, bottom) {
      if (!sums) {
        sums = new Int32Array((columns + 1) * (rows + 1));
        for (let r = 0; r < rows; r++) {
          let line = 0;
          for (let c = 0; c < columns; c++) {
            line += occupied[r * columns + c];
            sums[(r + 1) * (columns + 1) + c + 1] = sums[r * (columns + 1) + c + 1] + line;
          }
        }
      }
      const c0 = Math.max(0, Math.floor(left / BLOCK)), c1 = Math.min(columns - 1, Math.floor(right / BLOCK));
      const r0 = Math.max(0, Math.floor(top / BLOCK)), r1 = Math.min(rows - 1, Math.floor(bottom / BLOCK));
      if (!(c0 <= c1 && r0 <= r1)) return false;
      const stride = columns + 1;
      return sums[(r1 + 1) * stride + c1 + 1] - sums[r0 * stride + c1 + 1]
        - sums[(r1 + 1) * stride + c0] + sums[r0 * stride + c0] > 0;
    }
  };
}

// The selection is painted in uncorrected source pixels; lens correction moves
// each displayed pixel to the source point lensSourcePoint gives. Rather than
// sampling the map for every frame pixel, look at it one Lensfun grid cell at a
// time: a cell's bilinear samples stay inside the hull of its four corners, and
// rounding moves them by at most half a pixel, so a cell whose padded hull
// misses the selection (its rectangle, then the occupied 16 px blocks) cannot
// read a selected pixel and stays empty. Surviving
// cells sample exactly as lensSourcePoint does, with the same clamps and the
// same expression order, so the result is the per-pixel remap byte for byte.
function remapRepairMask(mask, bounds, blocks, width, height, { maps, includeTca }) {
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
    // Every cell of this row has its corners on grid rows y0 and y1: when their
    // source rows miss the selection, so does the whole row of cells. NaN
    // nodes are left out; a cell touching one samples NaN and stays empty.
    let rowLo = Infinity, rowHi = -Infinity;
    for (let i = y0 * gridWidth * channels + offset + 1, j = y1 * gridWidth * channels + offset + 1,
      end = i + gridWidth * channels; i < end; i += channels, j += channels) {
      const a = grid[i], b = grid[j];
      if (a < rowLo) rowLo = a;
      if (a > rowHi) rowHi = a;
      if (b < rowLo) rowLo = b;
      if (b > rowHi) rowHi = b;
    }
    if (!(rowHi + 1 >= top && rowLo - 1 <= bottom) || !blocks.anyRows(rowLo - 1, rowHi + 1)) continue;
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
      if (!blocks.any(loX - 1, hiX + 1, loY - 1, hiY + 1)) continue;
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

// The dust mask's tint at display size (#254 B). A tint cell is set when any
// mask pixel inside it is set (max-pooling), so a one-pixel speck stays
// visible at fit, where sampling the nearest mask pixel could skip it. The dust
// worker pools a detection's mask and a brush stroke's rectangle, the page only
// draws the result; masks that change without a worker reply (undo, a restored
// session, a new display size) are pooled here in short row bands.

// 50 % red over the photo, as the mask has always been shown.
export const DUST_TINT_RGBA = [255, 0, 0, 128];
const TINT_WORD = new Uint32Array(new Uint8ClampedArray(DUST_TINT_RGBA).buffer)[0];

// cellOf[i]: the cell of source column (or row) i; start[c]: the first source
// column of cell c (start[cells] = size). Cells are floor(i * cells / size).
function cellMap(size, cells) {
  const cellOf = new Int32Array(size);
  const start = new Int32Array(cells + 1).fill(size);
  for (let i = size - 1; i >= 0; i--) {
    const cell = Math.min(cells - 1, Math.floor(i * cells / size));
    cellOf[i] = cell;
    start[cell] = i;
  }
  // A cell no column falls in (cells > size) starts where the next one does.
  for (let c = cells - 1; c >= 0; c--) if (start[c] > start[c + 1]) start[c] = start[c + 1];
  return { cellOf, start };
}

const mapCache = new Map();
function cachedCellMap(size, cells) {
  const key = `${size}:${cells}`;
  let map = mapCache.get(key);
  if (!map) {
    if (mapCache.size > 8) mapCache.clear();
    map = cellMap(size, cells);
    mapCache.set(key, map);
  }
  return map;
}

/**
 * The tint cells whose source pixels overlap `rect` (mask pixels), as a cell
 * rectangle { x, y, width, height }, or null when empty.
 */
export function dustTintCellRect(rect, width, height, tintWidth, tintHeight) {
  const x0 = Math.max(0, rect.x); const y0 = Math.max(0, rect.y);
  const x1 = Math.min(width, rect.x + rect.width); const y1 = Math.min(height, rect.y + rect.height);
  if (x1 <= x0 || y1 <= y0) return null;
  const columns = cachedCellMap(width, tintWidth); const rows = cachedCellMap(height, tintHeight);
  const cx0 = columns.cellOf[x0]; const cx1 = columns.cellOf[x1 - 1];
  const cy0 = rows.cellOf[y0]; const cy1 = rows.cellOf[y1 - 1];
  return { x: cx0, y: cy0, width: cx1 - cx0 + 1, height: cy1 - cy0 + 1 };
}

/**
 * Pools `mask` (width x height, non-zero = dust) into a tint of tintWidth x
 * tintHeight cells, for the cells in `cells` (default: all). Each of those cells
 * is rewritten: tinted when a mask pixel inside it is set, clear otherwise.
 * `target` = { data, x, y, width }: RGBA bytes holding the cells from (x, y)
 * in rows of `width` cells (the whole tint, or just the cell rectangle).
 * Returns whether any cell is tinted.
 */
export function poolDustTint(mask, width, height, tintWidth, tintHeight, cells, target) {
  const box = cells || { x: 0, y: 0, width: tintWidth, height: tintHeight };
  const words = new Uint32Array(target.data.buffer, target.data.byteOffset, target.data.length >> 2);
  const columns = cachedCellMap(width, tintWidth); const rows = cachedCellMap(height, tintHeight);
  for (let cy = box.y; cy < box.y + box.height; cy++) {
    const line = (cy - target.y) * target.width - target.x;
    words.fill(0, line + box.x, line + box.x + box.width);
  }
  const xs = columns.start[box.x]; const xe = columns.start[box.x + box.width];
  const ys = rows.start[box.y]; const ye = rows.start[box.y + box.height];
  const { cellOf } = columns;
  let any = false;
  for (let y = ys; y < ye; y++) {
    const line = (rows.cellOf[y] - target.y) * target.width - target.x;
    const row = y * width;
    for (let x = xs; x < xe; x++) {
      if (mask[row + x]) {
        words[line + cellOf[x]] = TINT_WORD;
        any = true;
      }
    }
  }
  return any;
}

/** A full-size tint of `mask`: RGBA bytes of tintWidth x tintHeight. */
export function buildDustTint(mask, width, height, tintWidth, tintHeight) {
  const data = new Uint8ClampedArray(tintWidth * tintHeight * 4);
  poolDustTint(mask, width, height, tintWidth, tintHeight, null, { data, x: 0, y: 0, width: tintWidth });
  return data;
}

/** The cells over mask rectangle `rect` only: { x, y, width, height, rgba } or null. */
export function buildDustTintRect(mask, width, height, tintWidth, tintHeight, rect) {
  const cells = dustTintCellRect(rect, width, height, tintWidth, tintHeight);
  if (!cells) return null;
  const data = new Uint8ClampedArray(cells.width * cells.height * 4);
  poolDustTint(mask, width, height, tintWidth, tintHeight, cells, { data, x: cells.x, y: cells.y, width: cells.width });
  return { ...cells, rgba: data };
}

/**
 * buildDustTint in row bands of about `budgetMs` each, yielding between them
 * (`yieldTask`), for masks the page pools itself: no task runs long even at
 * 60 MP. Resolves to the tint, or null when `isCurrent()` turned false.
 */
export async function buildDustTintInBands(mask, width, height, tintWidth, tintHeight, { isCurrent = () => true, yieldTask, budgetMs = 8, now = () => performance.now() } = {}) {
  const data = new Uint8ClampedArray(tintWidth * tintHeight * 4);
  const out = { data, x: 0, y: 0, width: tintWidth };
  // Rows of cells per band, grown or shrunk to the budget.
  let band = Math.max(1, Math.floor(tintHeight / 64));
  for (let cy = 0; cy < tintHeight;) {
    const rowsNow = Math.min(band, tintHeight - cy);
    const started = now();
    poolDustTint(mask, width, height, tintWidth, tintHeight, { x: 0, y: cy, width: tintWidth, height: rowsNow }, out);
    cy += rowsNow;
    const spent = now() - started;
    band = Math.max(1, Math.round(rowsNow * (spent > 0 ? budgetMs / spent : 2)));
    if (cy < tintHeight) {
      await yieldTask();
      if (!isCurrent()) return null;
    }
  }
  return data;
}

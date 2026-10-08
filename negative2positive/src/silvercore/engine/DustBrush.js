/**
 * DustBrush.js - regional dust-brush strokes (#259)
 *
 * A stroke touches a few thousand pixels, so everything it does stays inside
 * rectangles around it: the brush is rasterised into its own bounding box,
 * the mask is refined in place there, and the repair is recomputed only over
 * the affected rect R, from the clean source. R starts at the stroke box
 * grown by the TELEA margin and is closed over every dust cluster (the
 * partition inpaintMasked uses) of the old or the new mask it reaches, so the
 * patch equals the same rect of a full-frame repair.
 */

import { dustInpaintPad, inpaintMaskedRect, refineMaskInRect } from './DustRemoval.js';

function cv() {
  return globalThis.window?.cv || globalThis.cv;
}

/**
 * Rasterises a stroke into its own bounding box with the full-frame rule it
 * replaces: a disc of radius r at every point and at every rounded step
 * between consecutive points, clipped to the frame. Points may lie off the
 * frame. Returns the tight bounds of the set pixels and their raster, or null
 * when the stroke sets no pixel.
 *
 * @returns {{ rect: {x,y,width,height}, brush: Uint8Array } | null}
 */
export function rasterizeBrushStroke(points, brushRadius, width, height) {
  if (!points?.length) return null;
  const r = brushRadius;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { x, y } of points) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const bx = Math.max(0, minX - r), by = Math.max(0, minY - r);
  const bw = Math.min(width - 1, maxX + r) - bx + 1, bh = Math.min(height - 1, maxY + r) - by + 1;
  if (!(bw > 0 && bh > 0)) return null;
  const box = new Uint8Array(bw * bh);
  const stamp = (cx, cy) => {
    if (cx + r < 0 || cy + r < 0 || cx - r >= width || cy - r >= height) return;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const nx = cx + dx, ny = cy + dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) box[(ny - by) * bw + (nx - bx)] = 255;
      }
    }
  };
  for (const pt of points) stamp(pt.x, pt.y);
  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 1], p1 = points[i];
    const dist = Math.sqrt((p1.x - p0.x) ** 2 + (p1.y - p0.y) ** 2);
    const steps = Math.max(1, Math.ceil(dist));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      stamp(Math.round(p0.x + (p1.x - p0.x) * t), Math.round(p0.y + (p1.y - p0.y) * t));
    }
  }
  let x0 = bw, y0 = bh, x1 = -1, y1 = -1;
  for (let y = 0; y < bh; y++) {
    const row = y * bw;
    for (let x = 0; x < bw; x++) {
      if (!box[row + x]) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  const rect = { x: bx + x0, y: by + y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
  const brush = new Uint8Array(rect.width * rect.height);
  for (let y = 0; y < rect.height; y++) {
    const start = (y0 + y) * bw + x0;
    brush.set(box.subarray(start, start + rect.width), y * rect.width);
  }
  return { rect, brush };
}

/** Copies `rect` out of a width-wide single-channel plane. */
export function copyMaskRect(mask, width, rect) {
  const out = new Uint8Array(rect.width * rect.height);
  for (let y = 0; y < rect.height; y++) {
    const start = (rect.y + y) * width + rect.x;
    out.set(mask.subarray(start, start + rect.width), y * rect.width);
  }
  return out;
}

/** Writes a rect-sized single-channel block back into a width-wide plane. */
export function pasteMaskRect(mask, width, rect, bytes) {
  for (let y = 0; y < rect.height; y++) {
    mask.set(bytes.subarray(y * rect.width, (y + 1) * rect.width), (rect.y + y) * width + rect.x);
  }
}

/**
 * External contours of a mask (or of `rect` of it): the particle count the
 * brush reports, as a full-frame findContours(RETR_EXTERNAL) has since #200.
 */
export function countMaskParticles(mask, width, height, rect = null) {
  const c = cv();
  const region = rect || { x: 0, y: 0, width, height };
  let mat, contours, hierarchy;
  try {
    mat = new c.Mat(region.height, region.width, c.CV_8UC1);
    if (rect) mat.data.set(copyMaskRect(mask, width, region));
    else mat.data.set(mask);
    contours = new c.MatVector();
    hierarchy = new c.Mat();
    c.findContours(mat, contours, hierarchy, c.RETR_EXTERNAL, c.CHAIN_APPROX_SIMPLE);
    return contours.size();
  } finally { mat?.delete(); contours?.delete(); hierarchy?.delete(); }
}

/**
 * Grows the stroke box to the affected rect R: the box grown by `pad`, then
 * every cluster of the old or new mask whose grid cells reach R, grown by
 * `pad`, until no cluster crosses R's border. Clusters follow inpaintMasked's
 * grid (cells 2 × pad wide from the frame origin, 8-connected). `oldBox`
 * holds the mask bytes of `box` before the stroke; elsewhere old == new.
 */
export function closeStrokeRect(mask, oldBox, box, width, height, pad) {
  const cell = Math.max(1, 2 * pad);
  const columns = Math.ceil(width / cell), rows = Math.ceil(height / cell);
  const cells = new Map();
  // Occupancy and pixel extent of one cell in old ∪ new.
  const inspect = (k) => {
    let info = cells.get(k);
    if (info) return info;
    const cx = k % columns, cy = (k - cx) / columns;
    const x0 = cx * cell, y0 = cy * cell;
    const x1 = Math.min(width, x0 + cell), y1 = Math.min(height, y0 + cell);
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
    for (let y = y0; y < y1; y++) {
      const row = y * width;
      const inBoxRow = y >= box.y && y < box.y + box.height;
      for (let x = x0; x < x1; x++) {
        let set = mask[row + x];
        if (!set && inBoxRow && x >= box.x && x < box.x + box.width) {
          set = oldBox[(y - box.y) * box.width + (x - box.x)];
        }
        if (!set) continue;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    info = { occupied: maxX >= 0, minX, minY, maxX, maxY, cluster: false };
    cells.set(k, info);
    return info;
  };
  let x0 = Math.max(0, box.x - pad), y0 = Math.max(0, box.y - pad);
  let x1 = Math.min(width, box.x + box.width + pad), y1 = Math.min(height, box.y + box.height + pad);
  for (let changed = true; changed;) {
    changed = false;
    const c0 = Math.floor(x0 / cell), c1 = Math.floor((x1 - 1) / cell);
    const r0 = Math.floor(y0 / cell), r1 = Math.floor((y1 - 1) / cell);
    for (let cy = r0; cy <= r1; cy++) for (let cx = c0; cx <= c1; cx++) {
      const start = cy * columns + cx;
      const first = inspect(start);
      if (!first.occupied || first.cluster) continue;
      // Flood the whole cluster, wherever it reaches.
      first.cluster = true;
      const stack = [start];
      let bx0 = Infinity, by0 = Infinity, bx1 = -1, by1 = -1;
      while (stack.length) {
        const k = stack.pop();
        const info = cells.get(k);
        if (info.minX < bx0) bx0 = info.minX; if (info.maxX > bx1) bx1 = info.maxX;
        if (info.minY < by0) by0 = info.minY; if (info.maxY > by1) by1 = info.maxY;
        const kx = k % columns, ky = (k - kx) / columns;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = kx + dx, ny = ky + dy;
          if (nx < 0 || ny < 0 || nx >= columns || ny >= rows) continue;
          const n = ny * columns + nx;
          const next = inspect(n);
          if (next.occupied && !next.cluster) { next.cluster = true; stack.push(n); }
        }
      }
      const gx0 = Math.max(0, bx0 - pad), gy0 = Math.max(0, by0 - pad);
      const gx1 = Math.min(width, bx1 + 1 + pad), gy1 = Math.min(height, by1 + 1 + pad);
      if (gx0 < x0 || gy0 < y0 || gx1 > x1 || gy1 > y1) {
        x0 = Math.min(x0, gx0); y0 = Math.min(y0, gy0);
        x1 = Math.max(x1, gx1); y1 = Math.max(y1, gy1);
        changed = true;
      }
    }
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

// The enclosure search gives up after this many expansions per pixel of the
// frame's width + height: about 5× what dense dust with hairs needed at
// 12 MP (DustBrush.enclosure.test.mjs).
const ENCLOSURE_SEARCH_FACTOR = 8;

/**
 * Searches the 4-connected background around `rect`, whose border ring is
 * background, for the frame edge. Four bucket queues hold the same reached
 * pixels and take turns, each expanding the one nearest its own edge (left,
 * right, top, bottom): open background is crossed in straight lines, and a
 * pocket that holds one direction back leaves the others free.
 *
 * @returns {'open'|'closed'|'unknown'} 'open' once a frame-edge pixel is
 *   reached (or `rect` touches the edge itself), 'closed' when the background
 *   runs out first, 'unknown' after `budget` expansions.
 */
export function searchBackgroundToEdge(mask, width, height, rect,
  budget = ENCLOSURE_SEARCH_FACTOR * (width + height)) {
  const right = rect.x + rect.width, bottom = rect.y + rect.height;
  if (rect.x === 0 || rect.y === 0 || right === width || bottom === height) return 'open';
  const seen = new Uint8Array((width * height + 7) >> 3);
  const queues = [new Array(width), new Array(width), new Array(height), new Array(height)];
  const lowest = [width, width, height, height];
  const add = (k, d, p) => {
    const level = queues[k][d];
    if (level) level.push(p); else queues[k][d] = [p];
    if (d < lowest[k]) lowest[k] = d;
  };
  // Queues a background pixel outside rect; true when it lies on the frame edge.
  const reach = (x, y) => {
    if (x >= rect.x && x < right && y >= rect.y && y < bottom) return false;
    const p = y * width + x;
    if (mask[p] || seen[p >> 3] & (1 << (p & 7))) return false;
    seen[p >> 3] |= 1 << (p & 7);
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1) return true;
    add(0, x, p); add(1, width - 1 - x, p); add(2, y, p); add(3, height - 1 - y, p);
    return false;
  };
  // The ring joins every background pixel next to rect.
  for (let x = rect.x; x < right; x++) if (reach(x, rect.y - 1) || reach(x, bottom)) return 'open';
  for (let y = rect.y; y < bottom; y++) if (reach(rect.x - 1, y) || reach(right, y)) return 'open';
  for (;;) {
    for (let k = 0; k < 4; k++) {
      const levels = queues[k];
      let d = lowest[k];
      while (d < levels.length && !levels[d]?.length) d++;
      // Every reached pixel enters every queue: one empty queue means all of
      // them have been expanded.
      if (d === levels.length) return 'closed';
      lowest[k] = d;
      if (--budget < 0) return 'unknown';
      const p = levels[d].pop();
      const x = p % width, y = (p - x) / width;
      if (reach(x - 1, y) || reach(x + 1, y) || reach(x, y - 1) || reach(x, y + 1)) return 'open';
    }
  }
}

// RETR_EXTERNAL skips a component lying in another's hole, and holes are
// 4-connected background. R's border ring is background (every cluster inside
// R keeps `pad` from it), so once the background around R reaches the frame
// edge, nothing outside R can enclose what is inside it and counting R alone
// is exact. A straight run from R's corners usually shows it; behind dust that
// blocks all four, the search decides. Closed or undecided: recount.
export function mayBeEnclosed(mask, width, height, rect) {
  const right = rect.x + rect.width, bottom = rect.y + rect.height;
  if (rect.x === 0 || rect.y === 0 || right === width || bottom === height) return false;
  const clearRow = (y, from, to) => {
    for (let x = from; x < to; x++) if (mask[y * width + x]) return false;
    return true;
  };
  const clearColumn = (x, from, to) => {
    for (let y = from; y < to; y++) if (mask[y * width + x]) return false;
    return true;
  };
  if (clearRow(rect.y, 0, rect.x) || clearRow(rect.y, right, width)
    || clearColumn(rect.x, 0, rect.y) || clearColumn(rect.x, bottom, height)) return false;
  return searchBackgroundToEdge(mask, width, height, rect) !== 'open';
}

/**
 * Applies one brush stroke to a worker-held dust state and returns the patch.
 *
 * `state.source` is the clean source (8-bit, optional 16-bit plane),
 * `state.mask` the current mask, refined here in place, and
 * `state.particleCount` the full-frame contour count of that mask (null until
 * known; it is then counted once). The patch covers R: the clean source
 * everywhere except new-mask pixels, which take TELEA values (16-bit = 8-bit
 * × 257), plus the new mask bytes of the stroke box and the updated count.
 *
 * @returns {null | { rect, rgba8, rgba16, maskRect, maskBytes, maskBefore,
 *   particleCount, countBefore }}
 */
export function applyDustStroke(state, { points, brushRadius, mode, radius = 3 }) {
  const { source } = state;
  const { width, height } = source;
  const raster = rasterizeBrushStroke(points, brushRadius, width, height);
  if (!raster) return null;
  if (state.particleCount == null) state.particleCount = countMaskParticles(state.mask, width, height);
  const box = raster.rect;
  const maskBefore = copyMaskRect(state.mask, width, box);
  refineMaskInRect(source, state.mask, box, raster.brush, mode);
  const pad = dustInpaintPad(radius);
  const rect = closeStrokeRect(state.mask, maskBefore, box, width, height, pad);
  const { rgba8, rgba16 } = inpaintMaskedRect(source, state.mask, rect, radius);

  const countBefore = state.particleCount;
  let particleCount;
  if (mayBeEnclosed(state.mask, width, height, rect)) {
    particleCount = countMaskParticles(state.mask, width, height);
  } else {
    const after = copyMaskRect(state.mask, width, rect);
    const before = after.slice();
    pasteMaskRect(before, rect.width, { x: box.x - rect.x, y: box.y - rect.y, width: box.width, height: box.height }, maskBefore);
    particleCount = countBefore
      - countMaskParticles(before, rect.width, rect.height)
      + countMaskParticles(after, rect.width, rect.height);
  }
  state.particleCount = particleCount;
  return {
    rect, rgba8, rgba16,
    maskRect: box, maskBytes: copyMaskRect(state.mask, width, box), maskBefore,
    particleCount, countBefore,
  };
}

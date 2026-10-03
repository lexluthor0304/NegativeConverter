// The detail layer (#248 part 5): a second canvas over the base display image
// that shows the visible region of a zoomed view at up to one source pixel per
// device pixel. The base (fit x DPR, capped at 4 MP) never follows zoom; this
// module plans the region, its density and the fixed conversion slot. main.js
// owns the canvas, the requests and when the layer is drawn.
import { displayLevelFactor, displayLevelRows } from './displayPreview.js';

// One base texel spans more than this many device pixels: the layer is worth it.
export const DETAIL_TRIGGER_TEXEL = 1.25;
// Converted beyond the visible rect so a short pan reveals no base pixels.
export const DETAIL_MARGIN_PX = 128;
// Prefer the retained level above this native-row budget. It covers the whole
// view; a source without a level falls back to a bounded centred cut.
export const DETAIL_MAX_NATIVE_PIXELS = 16_000_000;
export const DETAIL_MAX_OUTPUT_PIXELS = 8_388_608;
export const DETAIL_MAX_DIMENSION = 8192;
export const DETAIL_MAX_TILE_PIXELS = 1_000_000;
// The conversion slot is the container's device size rounded up to this, plus
// the margin, so panning never rebuilds the engine.
export const DETAIL_SLOT_ROUND = 256;
// Zoom and pan settle for this long before the region is planned.
export const DETAIL_SETTLE_MS = 100;
// The level stands in for native pixels while it holds at least this share of
// the density the view needs.
export const DETAIL_LEVEL_DENSITY_SHARE = 0.9;

/**
 * The detail region of a view, or null when the base is sharp enough.
 *
 * `view`: sourceWidth/sourceHeight (the conversion source, post-geometry),
 * baseWidth (the base texture's width), fit (CSS px per source px at zoom 1),
 * zoom, dpr, panX/panY and baseX/baseY (the wrapper's untransformed offset in
 * the container), containerWidth/containerHeight (CSS px), levelFactor (the
 * retained level's k).
 *
 * Returns { x, y, width, height } (the source rect, integers), density (output
 * pixels per source pixel), outWidth/outHeight (the converted size), fromLevel
 * (the level holds enough detail), visible (the visible source rect) and the
 * device pixels per source pixel of the view (`needed`).
 */
export function planDetailRegion(view, { margin = DETAIL_MARGIN_PX, withMargin = true, maxNativePixels = DETAIL_MAX_NATIVE_PIXELS } = {}) {
  const { sourceWidth: W, sourceHeight: H, baseWidth, fit, zoom, dpr, panX, panY, baseX, baseY, containerWidth, containerHeight } = view;
  if (!(W > 0) || !(H > 0) || !(baseWidth > 0) || !(fit > 0) || !(zoom > 0)) return null;
  if (!detailSlotSize(containerWidth, containerHeight, dpr, margin)) return null;
  const needed = fit * zoom * Math.max(1, dpr || 1);
  const baseDensity = baseWidth / W;
  if (needed / baseDensity <= DETAIL_TRIGGER_TEXEL) return null;
  const density = Math.min(1, needed);
  // The container in the wrapper's pre-transform CSS space, then in source px.
  const toSource = value => value / fit;
  const vx0 = Math.max(0, toSource((0 - baseX - panX) / zoom));
  const vy0 = Math.max(0, toSource((0 - baseY - panY) / zoom));
  const vx1 = Math.min(W, toSource((containerWidth - baseX - panX) / zoom));
  const vy1 = Math.min(H, toSource((containerHeight - baseY - panY) / zoom));
  if (!(vx1 > vx0) || !(vy1 > vy0)) return null;
  const visible = { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 };
  const k = Math.max(1, Math.floor(view.levelFactor || 1));
  // The level's density is 1 / k: while that holds 90 % of what the view
  // needs, the worker crops the level it already keeps.
  let fromLevel = k > 1 && 1 / k >= DETAIL_LEVEL_DENSITY_SHARE * density;
  const pad = withMargin ? margin / density : 0;
  let rect = snapRect(vx0 - pad, vy0 - pad, vx1 + pad, vy1 + pad, W, H, fromLevel ? k : 1);
  if (!fromLevel && rect.width * rect.height > maxNativePixels && k > 1) {
    fromLevel = true;
    rect = snapRect(vx0 - pad, vy0 - pad, vx1 + pad, vy1 + pad, W, H, k);
  }
  if (!fromLevel && rect.width * rect.height > maxNativePixels) {
    // Without the margin first, then a centred cut of the visible rect.
    rect = snapRect(vx0, vy0, vx1, vy1, W, H, 1);
    if (rect.width * rect.height > maxNativePixels) {
      const scale = Math.sqrt(maxNativePixels / (rect.width * rect.height));
      const cx = (vx0 + vx1) / 2, cy = (vy0 + vy1) / 2;
      const width = Math.max(1, Math.floor(rect.width * scale));
      const height = Math.max(1, Math.floor(rect.height * scale));
      rect = { x: Math.max(0, Math.min(W - width, Math.round(cx - width / 2))),
        y: Math.max(0, Math.min(H - height, Math.round(cy - height / 2))), width, height };
    }
  }
  const outWidth = Math.max(1, Math.round(rect.width * density));
  const outHeight = Math.max(1, Math.round(rect.height * density));
  if (!detailSizeAllowed(outWidth, outHeight, DETAIL_MAX_OUTPUT_PIXELS, DETAIL_MAX_DIMENSION)) return null;
  return { ...rect, density, outWidth, outHeight, fromLevel, levelFactor: k, visible, needed };
}

// Integer source rect, outwards, inside the frame; its corners on multiples of
// `step` (the level's box) so a level crop covers it exactly.
function snapRect(x0, y0, x1, y1, W, H, step) {
  const left = Math.max(0, Math.floor(x0 / step) * step);
  const top = Math.max(0, Math.floor(y0 / step) * step);
  const limitX = Math.floor(W / step) * step;
  const limitY = Math.floor(H / step) * step;
  const right = Math.min(step > 1 ? limitX : W, Math.ceil(x1 / step) * step);
  const bottom = Math.min(step > 1 ? limitY : H, Math.ceil(y1 / step) * step);
  return { x: left, y: top, width: Math.max(step, right - left), height: Math.max(step, bottom - top) };
}

/** Whether a planned region still serves a newer plan: same density bucket, and it covers the view. */
export function detailRegionServes(shown, plan) {
  if (!shown || !plan) return false;
  if (shown.fromLevel !== plan.fromLevel) return false;
  if (Math.abs(shown.density - plan.density) > plan.density * 0.1) return false;
  // A bounded cut may not cover the view, but asking for the same cut again
  // cannot improve it. Source identity is checked by the caller's tag.
  if (shown.x === plan.x && shown.y === plan.y && shown.width === plan.width && shown.height === plan.height
    && shown.density === plan.density && shown.levelFactor === plan.levelFactor) return true;
  const v = plan.visible;
  return shown.x <= v.x + 0.5 && shown.y <= v.y + 0.5
    && shown.x + shown.width >= v.x + v.width - 0.5 && shown.y + shown.height >= v.y + v.height - 0.5;
}

/** The fixed conversion slot for a container: its device size rounded up to 256, plus the margin. */
export function detailSlotSize(containerWidth, containerHeight, dpr, margin = DETAIL_MARGIN_PX) {
  const round = value => Math.ceil(Math.max(1, value) / DETAIL_SLOT_ROUND) * DETAIL_SLOT_ROUND;
  const scale = Math.max(1, dpr || 1);
  const slot = { width: round(containerWidth * scale + 2 * margin), height: round(containerHeight * scale + 2 * margin) };
  return detailSizeAllowed(slot.width, slot.height, DETAIL_MAX_OUTPUT_PIXELS, DETAIL_MAX_DIMENSION) ? slot : null;
}

export function detailSizeAllowed(width, height, maxPixels, maxDimension = Infinity) {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
    && width <= maxDimension && height <= maxDimension && width * height <= maxPixels;
}

export function assertDetailAllocation(width, height, maxPixels = DETAIL_MAX_NATIVE_PIXELS, maxDimension = Infinity) {
  if (!detailSizeAllowed(width, height, maxPixels, maxDimension)) throw new RangeError('Detail allocation exceeds its pixel limit');
}

// Check the sizes the worker actually allocates, including a padded slot larger
// than either its requested slot or output alone. Run before copying/posting too.
export function assertDetailRoiAllocation(region, warm = false) {
  assertDetailAllocation(region.slotWidth, region.slotHeight, DETAIL_MAX_OUTPUT_PIXELS, DETAIL_MAX_DIMENSION);
  if (warm) return;
  assertDetailAllocation(region.outWidth, region.outHeight, DETAIL_MAX_OUTPUT_PIXELS, DETAIL_MAX_DIMENSION);
  assertDetailAllocation(Math.max(region.slotWidth, region.outWidth), Math.max(region.slotHeight, region.outHeight),
    DETAIL_MAX_OUTPUT_PIXELS, DETAIL_MAX_DIMENSION);
  const k = region.fromLevel ? region.levelFactor : 1;
  if (!Number.isSafeInteger(k) || k < 1) throw new RangeError('Invalid detail level factor');
  assertDetailAllocation(region.width / k, region.height / k);
}

export function assertDetailGeometry(geometry, width, height) {
  const { sourceWidth, sourceHeight, k } = geometry;
  if (!Number.isSafeInteger(k) || k < 1 || !Number.isSafeInteger(sourceWidth) || !Number.isSafeInteger(sourceHeight)
    || Math.floor(sourceWidth / k) !== width || Math.floor(sourceHeight / k) !== height) throw new RangeError('Invalid detail level geometry');
}

// The exact crop's own box filter, not the source's retained level. Copy native
// bands on the same k grid as filterDisplayImage, preserving its arithmetic and
// discarded edge cells, then transfer only the bounded RGBA16 level.
export async function buildDetailFrameLevel(frame, rect, { signal = null, tilePixels = DETAIL_MAX_TILE_PIXELS, k = displayLevelFactor(rect.width, rect.height),
  pause = () => new Promise(resolve => setTimeout(resolve, 0)) } = {}) {
  if (signal?.aborted) return null;
  if (!Number.isSafeInteger(k) || k < 1) throw new RangeError('Invalid detail level factor');
  const width = Math.floor(rect.width / k), height = Math.floor(rect.height / k);
  assertDetailAllocation(width, height);
  assertDetailAllocation(rect.width, k, Math.min(tilePixels, DETAIL_MAX_TILE_PIXELS));
  const rows = Math.floor(Math.min(tilePixels, DETAIL_MAX_TILE_PIXELS) / (rect.width * k));
  const data = new Uint16Array(width * height * 4);
  for (let y = 0; y < height; y += rows) {
    if (signal?.aborted) return null;
    const count = Math.min(rows, height - y);
    const band = { x: rect.x, y: rect.y + y * k, width: rect.width, height: count * k };
    const pixels = copyRegionRows(frame.data, frame.width, band);
    const level = displayLevelRows({ width: band.width, height: band.height, data: pixels }, k, width);
    data.set(level, y * width * 4);
    if (y + count < height) await pause();
  }
  return { width, height, data, geometry: { sourceWidth: rect.width, sourceHeight: rect.height, k } };
}

// Conservative live plane/texture accounting, not process RSS. Row resampling
// may hold native rows, a decimated plane and the output; conversion later
// holds the owned pad, sparse stops, RGBA8 output/crop and old/new GL surfaces.
// The base/analysis are retained independently and driver scratch is unknown.
export function estimateDetailRoiBytes(plan, slot, { exactFrame = false } = {}) {
  const exactLevel = exactFrame && plan.width * plan.height > DETAIL_MAX_NATIVE_PIXELS
    ? displayLevelFactor(plan.width, plan.height) : 1;
  const inputPixels = exactFrame
    ? Math.floor(plan.width / exactLevel) * Math.floor(plan.height / exactLevel) : plan.fromLevel
    ? Math.floor(plan.width / plan.levelFactor) * Math.floor(plan.height / plan.levelFactor)
    : plan.width * plan.height;
  const slotPixels = Math.max(slot.width, plan.outWidth) * Math.max(slot.height, plan.outHeight);
  // A superseded active conversion can finish its synchronous pass while one
  // newer row payload waits. Older queued payloads are removed on cancellation.
  const pendingRows = !exactFrame && plan.fromLevel ? 0 : 8 * inputPixels;
  const bands = exactLevel > 1 ? 12 * DETAIL_MAX_TILE_PIXELS : 0;
  return Math.max(10 * inputPixels + 16 * slotPixels, 32 * slotPixels) + pendingRows + bands + 1024 * 1024;
}

/**
 * The pan (CSS px) that puts the region's top-left corner on a whole device
 * pixel, within half a device pixel of `pan`: at 100 % one source pixel then
 * covers exactly one device pixel.
 */
export function snapPanToDevicePixels(pan, base, zoom, offsetCss, dpr) {
  const scale = Math.max(1, dpr || 1);
  const device = (base + pan + zoom * offsetCss) * scale;
  return Math.round(device) / scale - base - zoom * offsetCss;
}

/** Rows [y, y + height) and columns [x, x + width) of an RGBA plane, as a new plane. */
export function copyRegionRows(data, width, rect) {
  assertDetailAllocation(rect.width, rect.height);
  if (!Number.isSafeInteger(rect.x) || !Number.isSafeInteger(rect.y) || rect.x < 0 || rect.y < 0
    || rect.x + rect.width > width) throw new RangeError('Invalid detail crop');
  const Plane = data.constructor;
  const out = new Plane(rect.width * rect.height * 4);
  for (let row = 0; row < rect.height; row++) {
    const from = ((rect.y + row) * width + rect.x) * 4;
    out.set(data.subarray(from, from + rect.width * 4), row * rect.width * 4);
  }
  return out;
}

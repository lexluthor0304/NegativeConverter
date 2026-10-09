// The detail layer (#248 part 5): a second canvas over the base display image
// that shows the visible region of a zoomed view at up to one source pixel per
// device pixel. The base (fit x DPR, capped at 4 MP) never follows zoom; this
// module plans the region, its density, the row bands several workers convert
// it in (#270) and the slot that bounds the viewport. main.js owns the canvas,
// the requests and when the layer is drawn.
import { displayLevelFactor, displayLevelRows, displayResampleRows } from './displayPreview.js';

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
// The slot is the container's device size rounded up to this, plus the margin:
// the largest region a viewport plans, which bounds what planning allows and
// sizes nothing else since #270 (a region converts at its own size).
export const DETAIL_SLOT_ROUND = 256;
// Continuous gestures (wheel, pinch, pan) settle for this long before the
// region is planned. A discrete step (a zoom button or key, a double-click,
// 1:1) is the end of its gesture: its region is asked for at once (#270).
export const DETAIL_SETTLE_MS = 100;
export const DETAIL_STEP_SETTLE_MS = 0;
// A band of a region converts at least this many output rows: below it the
// fixed cost of a message and the engine's tables outweighs the split.
export const DETAIL_BAND_MIN_ROWS = 128;
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
  // At or above true 100 % the view takes one source pixel per device pixel
  // (#270): a region converted below that no longer serves, so zooming on
  // past 100 % still refines to native pixels.
  if (plan.density === 1 && shown.density !== 1) return false;
  // A bounded cut may not cover the view, but asking for the same cut again
  // cannot improve it. Source identity is checked by the caller's tag.
  if (shown.x === plan.x && shown.y === plan.y && shown.width === plan.width && shown.height === plan.height
    && shown.density === plan.density && shown.levelFactor === plan.levelFactor) return true;
  const v = plan.visible;
  return shown.x <= v.x + 0.5 && shown.y <= v.y + 0.5
    && shown.x + shown.width >= v.x + v.width - 0.5 && shown.y + shown.height >= v.y + v.height - 0.5;
}

/**
 * How many workers convert a detail region at once (#270): the preview worker
 * and up to three detail workers, by core count, two where memory is short,
 * one when a stage reads neighbours (sharpening), whose band edges would
 * differ from the whole region's.
 */
export function planDetailBandCount({ hardwareConcurrency = globalThis.navigator?.hardwareConcurrency, lowMemory = false, pointwise = true } = {}) {
  if (!pointwise) return 1;
  const cores = Number.isFinite(hardwareConcurrency) && hardwareConcurrency > 0 ? Math.floor(hardwareConcurrency) : 4;
  const count = cores >= 8 ? 4 : cores >= 6 ? 3 : cores >= 4 ? 2 : 1;
  return lowMemory ? Math.min(2, count) : count;
}

/**
 * Row bands of a planned region for `count` workers (#270). Each converts the
 * output rows [y0, y1) and needs `rows` input rows from `rowY`: rows of the
 * region's native rect (`input: 'native'`, columns [x, x + width)), or of the
 * region's block of the retained level (`input: 'level'`, columns
 * [x / k, (x + width) / k), rows from y / k). Below full density these are the
 * rows the resample's taps read (whole boxes of the native box filter), so a
 * band's resample equals the same rows of the whole region's.
 */
export function planDetailBands(region, count, { minRows = DETAIL_BAND_MIN_ROWS } = {}) {
  const out = { width: region.outWidth, height: region.outHeight };
  const n = Math.max(1, Math.min(Math.floor(count) || 1, Math.floor(out.height / Math.max(1, minRows)) || 1));
  const native = !region.fromLevel && out.width === region.width && out.height === region.height;
  const k = region.fromLevel ? region.levelFactor
    : Math.max(1, Math.floor(Math.min(region.width / out.width, region.height / out.height)));
  const geometry = { sourceWidth: region.width, sourceHeight: region.height, k };
  const levelHeight = Math.floor(region.height / k);
  const bands = [];
  for (let i = 0; i < n; i++) {
    const y0 = Math.floor((i * out.height) / n);
    const y1 = Math.floor(((i + 1) * out.height) / n);
    if (native) {
      bands.push({ y0, y1, rowY: y0, rows: y1 - y0, input: 'native' });
      continue;
    }
    const [lo, hi] = displayResampleRows(geometry, out, levelHeight, y0, y1);
    if (region.fromLevel) bands.push({ y0, y1, rowY: lo, rows: hi - lo, input: 'level' });
    else bands.push({ y0, y1, rowY: lo * k, rows: (hi - lo) * k, input: 'native' });
  }
  return bands;
}

/** The slot of a container: its device size plus the margin, rounded up to 256; null when too large. */
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

// Check the sizes the worker actually allocates (the slot only bounds the
// viewport and sizes nothing since #270: a region converts at its own size).
// With a `band` (#270), its input rows and output rows too. Run before
// copying/posting too.
export function assertDetailRoiAllocation(region, warm = false, band = null) {
  assertDetailAllocation(region.slotWidth, region.slotHeight, DETAIL_MAX_OUTPUT_PIXELS, DETAIL_MAX_DIMENSION);
  if (warm) return;
  assertDetailAllocation(region.outWidth, region.outHeight, DETAIL_MAX_OUTPUT_PIXELS, DETAIL_MAX_DIMENSION);
  const k = region.fromLevel ? region.levelFactor : 1;
  if (!Number.isSafeInteger(k) || k < 1) throw new RangeError('Invalid detail level factor');
  assertDetailAllocation(region.width / k, region.height / k);
  if (!band) return;
  const { y0, y1, rowY, rows } = band;
  if (![y0, y1, rowY, rows].every(Number.isSafeInteger) || y0 < 0 || y1 <= y0 || y1 > region.outHeight || rowY < 0
    || (band.input !== 'native' && band.input !== 'level') || (band.input === 'level') !== Boolean(region.fromLevel)) throw new RangeError('Invalid detail band');
  assertDetailAllocation(band.input === 'level' ? region.width / k : region.width, rows);
  if (rowY + rows > (band.input === 'level' ? region.height / k : region.height)) throw new RangeError('Invalid detail band');
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

// Conservative live plane/texture accounting, not process RSS (#248 review
// R1-092, revised for #270). A region converts at its own size, in one or
// several workers (no padded slot). Input pixels are the native rows, the
// level block or the exact crop's own level, in 16-bit RGBA (8 B). Per band a
// worker holds its input rows, the box level of native rows (k > 1) and the
// resampled plane, then converts that plane in place next to its RGBA8 output
// and, at worst, a dense float stops map. One superseding request's rows may
// wait meanwhile (older queued payloads are removed on cancellation). Main
// holds the band replies, the assembled region and the old and new GL texture
// and drawing buffer. Each band peaks at most at
//   8 × input (rows) + 8 × input (a superseding payload) + box + 16 × output,
// and main's display side adds 8 × output while bands run and 24 × output
// (replies, assembly, old/new texture and drawing buffer) after they ended,
// so the whole stays under 16 × input + box + 24 × output + band scratch +
// 1 MiB. The base/analysis are retained independently; driver scratch is
// unknown.
export function estimateDetailRoiBytes(plan, { exactFrame = false } = {}) {
  const exactLevel = exactFrame && plan.width * plan.height > DETAIL_MAX_NATIVE_PIXELS
    ? displayLevelFactor(plan.width, plan.height) : 1;
  const inputPixels = exactFrame
    ? Math.floor(plan.width / exactLevel) * Math.floor(plan.height / exactLevel) : plan.fromLevel
    ? Math.floor(plan.width / plan.levelFactor) * Math.floor(plan.height / plan.levelFactor)
    : plan.width * plan.height;
  const outPixels = plan.outWidth * plan.outHeight;
  const boxK = exactFrame || plan.fromLevel ? 1
    : Math.max(1, Math.floor(Math.min(plan.width / plan.outWidth, plan.height / plan.outHeight)));
  const box = boxK > 1 ? 8 * Math.floor(plan.width / boxK) * Math.floor(plan.height / boxK) : 0;
  const bands = exactLevel > 1 ? 12 * DETAIL_MAX_TILE_PIXELS : 0;
  return 16 * inputPixels + box + 24 * outPixels + bands + 1024 * 1024;
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

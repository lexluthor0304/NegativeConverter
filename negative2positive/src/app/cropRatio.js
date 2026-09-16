// Aspect-ratio lock for the crop tool. Pure geometry, no DOM: the lock only
// shapes the draft rectangle, so applying the crop is unchanged.
//
// A preset ratio is long side ÷ short side (≥ 1) of the nominal film format.
// The numbers are the exact nominal fractions ("6×7" is 7:6) rather than
// AUTO_FRAME_FORMAT_RATIOS, whose rounded values are frame-detection priors.
export const CROP_RATIO_PRESETS = Object.freeze([
  { id: 'free', ratio: null, label: 'Free' },
  { id: '135', ratio: 3 / 2, label: '135 (3:2)' },
  { id: '120-6x4.5', ratio: 6 / 4.5, label: '120 6×4.5' },
  { id: '120-6x6', ratio: 1, label: '120 6×6' },
  { id: '120-6x7', ratio: 7 / 6, label: '120 6×7' },
  // 6×9 is 3:2 like 135, but users think in formats, so it keeps its own entry.
  { id: '120-6x9', ratio: 9 / 6, label: '120 6×9' },
  // 8×10 has the same ratio as 4×5.
  { id: '4x5', ratio: 5 / 4, label: '4×5 / 8×10' },
  { id: '5x7', ratio: 7 / 5, label: '5×7' }
].map(preset => Object.freeze(preset)));

export const DEFAULT_CROP_RATIO_CHOICE = Object.freeze({ id: 'free', orientation: 'landscape' });

const RESIZE_MODES = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);

export function findCropRatioPreset(id) {
  return CROP_RATIO_PRESETS.find(preset => preset.id === id) || CROP_RATIO_PRESETS[0];
}

// The remembered choice (localStorage JSON). Anything malformed is "free".
export function parseCropRatioChoice(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const id = findCropRatioPreset(parsed?.id).id;
    const orientation = parsed?.orientation === 'portrait' ? 'portrait' : 'landscape';
    return { id, orientation };
  } catch {
    return { ...DEFAULT_CROP_RATIO_CHOICE };
  }
}

export function serializeCropRatioChoice(choice) {
  const { id, orientation } = parseCropRatioChoice(choice);
  return JSON.stringify({ id, orientation });
}

export function orientationForRect(rect) {
  return rect && Number(rect.height) > Number(rect.width) ? 'portrait' : 'landscape';
}

export function flipOrientation(orientation) {
  return orientation === 'portrait' ? 'landscape' : 'portrait';
}

// A frame that is clearly landscape or portrait decides the box orientation
// (a rotated portrait shot gets a portrait box). Only a near-square frame has
// no say, so the remembered orientation is used there.
export function preferredCropOrientation(rect, fallback = 'landscape', tolerance = 0.05) {
  const remembered = fallback === 'portrait' ? 'portrait' : 'landscape';
  const width = Number(rect?.width);
  const height = Number(rect?.height);
  const longest = Math.max(width, height);
  if (!(longest > 0) || Math.abs(width - height) <= longest * tolerance) return remembered;
  return orientationForRect(rect);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeRect(rect) {
  if (!rect) return null;
  let left = Number(rect.left);
  let top = Number(rect.top);
  let width = Number(rect.width);
  let height = Number(rect.height);
  if (![left, top, width, height].every(Number.isFinite)) return null;
  if (width < 0) {
    left += width;
    width = -width;
  }
  if (height < 0) {
    top += height;
    height = -height;
  }
  return { left, top, width, height };
}

function normalizeBounds(bounds) {
  const width = Number(bounds?.width);
  const height = Number(bounds?.height);
  return width > 0 && height > 0 ? { width, height } : null;
}

function normalizeMinSize(minSize) {
  return {
    width: Math.max(0, Number(minSize?.width) || 0),
    height: Math.max(0, Number(minSize?.height) || 0)
  };
}

// Width ÷ height of the box for a preset ratio in the given orientation.
function aspectFor(ratio, orientation) {
  return orientation === 'portrait' ? 1 / ratio : ratio;
}

// Smallest width that satisfies both minimum sides at this aspect.
function minWidthForAspect(aspect, minSize) {
  return Math.max(minSize.width, minSize.height * aspect);
}

// Largest width that fits in the bounds at this aspect.
function maxWidthForAspect(aspect, bounds) {
  return Math.min(bounds.width, bounds.height * aspect);
}

// The width the drag asks for, kept between the minimum size and the room
// available, with the bounds winning over the minimum size in a tight spot.
function constrainWidth(width, aspect, room, bounds, minSize) {
  const fits = maxWidthForAspect(aspect, bounds);
  const maxWidth = Math.max(0, Math.min(fits, room.width, room.height * aspect));
  const minWidth = Math.min(minWidthForAspect(aspect, minSize), fits);
  return Math.max(minWidth, Math.min(width, maxWidth));
}

// Keeps a box of the given size inside the bounds, moving it as little as
// possible from the requested position.
function placeBox(left, top, width, height, bounds) {
  return {
    left: clamp(left, 0, Math.max(0, bounds.width - width)),
    top: clamp(top, 0, Math.max(0, bounds.height - height)),
    width,
    height
  };
}

// Re-shapes `rect` to `ratio` around its own centre by shrinking one side,
// then keeps it inside `bounds` without breaking the ratio. A free ratio
// (null) only sanitises the rect.
export function fitRectToRatio(rect, ratio, bounds, options = {}) {
  const box = normalizeRect(rect);
  if (!box) return null;
  const area = normalizeBounds(bounds);
  if (!area) return box;
  if (!(ratio > 0)) {
    const width = Math.min(box.width, area.width);
    const height = Math.min(box.height, area.height);
    return placeBox(box.left, box.top, width, height, area);
  }

  const orientation = options.orientation || orientationForRect(box);
  const aspect = aspectFor(ratio, orientation);
  const minSize = normalizeMinSize(options.minSize);
  const requested = box.height > 0 && box.width / box.height > aspect ? box.height * aspect : box.width;
  const width = constrainWidth(requested, aspect, area, area, minSize);
  const height = width / aspect;
  const centreX = box.left + box.width / 2;
  const centreY = box.top + box.height / 2;
  return placeBox(centreX - width / 2, centreY - height / 2, width, height, area);
}

// Ratio-locked counterpart of a handle drag. Corner handles anchor the
// opposite corner and follow the dominant pointer delta; edge handles anchor
// the opposite edge, take the dragged dimension from the pointer and keep the
// box centred on the other axis. The result stays inside `bounds` at the
// ratio and is never smaller than `minSize`.
export function resizeRectWithRatio(startRect, mode, position, ratio, bounds, minSize, options = {}) {
  const start = normalizeRect(startRect);
  const area = normalizeBounds(bounds);
  if (!start || !area || !position || !(ratio > 0) || !RESIZE_MODES.has(mode)) return null;

  const orientation = options.orientation || orientationForRect(start);
  const aspect = aspectFor(ratio, orientation);
  const horizontal = mode.includes('e') ? 'e' : mode.includes('w') ? 'w' : null;
  const vertical = mode.includes('s') ? 's' : mode.includes('n') ? 'n' : null;
  const right = start.left + start.width;
  const bottom = start.top + start.height;
  const anchorX = horizontal === 'e' ? start.left : right;
  const anchorY = vertical === 's' ? start.top : bottom;
  const x = Number(position.x);
  const y = Number(position.y);
  const dx = horizontal ? Math.max(0, horizontal === 'e' ? x - anchorX : anchorX - x) : 0;
  const dy = vertical ? Math.max(0, vertical === 's' ? y - anchorY : anchorY - y) : 0;
  const requested = horizontal && vertical ? Math.max(dx, dy * aspect) : horizontal ? dx : dy * aspect;

  const room = {
    width: horizontal === 'e' ? area.width - anchorX : horizontal === 'w' ? anchorX : area.width,
    height: vertical === 's' ? area.height - anchorY : vertical === 'n' ? anchorY : area.height
  };
  const width = constrainWidth(requested, aspect, room, area, normalizeMinSize(minSize));
  const height = width / aspect;
  const left = horizontal === 'e' ? anchorX : horizontal === 'w' ? anchorX - width : start.left + (start.width - width) / 2;
  const top = vertical === 's' ? anchorY : vertical === 'n' ? anchorY - height : start.top + (start.height - height) / 2;
  return placeBox(left, top, width, height, area);
}

// A fresh box drawn from `start`: it grows in the drag direction at the ratio,
// anchored at the start point, and stays inside `bounds`.
export function drawRectWithRatio(start, position, ratio, bounds, minSize, options = {}) {
  const area = normalizeBounds(bounds);
  if (!start || !position || !area || !(ratio > 0)) return null;

  const aspect = aspectFor(ratio, options.orientation || 'landscape');
  const startX = Number(start.x);
  const startY = Number(start.y);
  const dx = Number(position.x) - startX;
  const dy = Number(position.y) - startY;
  if (![startX, startY, dx, dy].every(Number.isFinite)) return null;
  const towardsLeft = dx < 0;
  const towardsTop = dy < 0;
  const room = {
    width: towardsLeft ? startX : area.width - startX,
    height: towardsTop ? startY : area.height - startY
  };
  const width = constrainWidth(Math.max(Math.abs(dx), Math.abs(dy) * aspect), aspect, room, area, normalizeMinSize(minSize));
  const height = width / aspect;
  return placeBox(towardsLeft ? startX - width : startX, towardsTop ? startY - height : startY, width, height, area);
}

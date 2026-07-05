// Pure curve-editor math: spline interpolation, LUT building, and control
// point manipulation. No DOM, no app state — the editor UI in main.js feeds
// in points and canvas coordinates.

/** Monotonic cubic spline through control points; returns y(x). */
export function computeSpline(points) {
  const n = points.length;
  if (n < 2) return (x) => x;

  // Sort points by x
  points = [...points].sort((a, b) => a.x - b.x);

  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);

  // Calculate slopes
  const dxs = [], dys = [], ms = [];
  for (let i = 0; i < n - 1; i++) {
    dxs.push(xs[i + 1] - xs[i]);
    dys.push(ys[i + 1] - ys[i]);
    ms.push(dys[i] / dxs[i]);
  }

  // Calculate degree-1 coefficients
  const c1s = [ms[0]];
  for (let i = 0; i < dxs.length - 1; i++) {
    const m = ms[i], mNext = ms[i + 1];
    if (m * mNext <= 0) {
      c1s.push(0);
    } else {
      const dx = dxs[i], dxNext = dxs[i + 1], common = dx + dxNext;
      c1s.push(3 * common / ((common + dxNext) / m + (common + dx) / mNext));
    }
  }
  c1s.push(ms[ms.length - 1]);

  // Calculate degree-2 and degree-3 coefficients
  const c2s = [], c3s = [];
  for (let i = 0; i < c1s.length - 1; i++) {
    const c1 = c1s[i], m = ms[i], invDx = 1 / dxs[i], common = c1 + c1s[i + 1] - 2 * m;
    c2s.push((m - c1 - common) * invDx);
    c3s.push(common * invDx * invDx);
  }

  // Return interpolation function
  return function (x) {
    let i = xs.length - 1;
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];

    // Binary search
    let low = 0, high = c3s.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (xs[mid] < x) low = mid + 1;
      else high = mid - 1;
    }
    i = Math.max(0, high);

    const diff = x - xs[i];
    return ys[i] + c1s[i] * diff + c2s[i] * diff * diff + c3s[i] * diff * diff * diff;
  };
}

/** 256-entry LUT (0-255 clamped) from control points. */
export function buildCurveLut(points) {
  const spline = computeSpline(points);
  const lut = new Array(256);
  for (let i = 0; i < 256; i++) {
    lut[i] = Math.max(0, Math.min(255, Math.round(spline(i))));
  }
  return lut;
}

/** Control point sets for the editor's preset buttons. */
export const CURVE_PRESETS = {
  linear: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
  scurve: [{ x: 0, y: 0 }, { x: 64, y: 48 }, { x: 192, y: 208 }, { x: 255, y: 255 }],
  log: [{ x: 0, y: 0 }, { x: 64, y: 128 }, { x: 128, y: 192 }, { x: 255, y: 255 }],
};

export function getCurvePresetPoints(preset) {
  const points = CURVE_PRESETS[preset] || CURVE_PRESETS.linear;
  return points.map((p) => ({ ...p }));
}

/** Insert a new point keeping x order; returns its index. Mutates `points`. */
export function insertCurvePoint(points, x, y) {
  let insertIndex = points.findIndex((p) => p.x > x);
  if (insertIndex === -1) insertIndex = points.length;
  points.splice(insertIndex, 0, { x, y });
  return insertIndex;
}

/**
 * Move a control point to (x, y) under editor rules: endpoints slide only
 * vertically, middle points keep x strictly between their neighbours.
 * Mutates the point in place.
 */
export function moveCurvePoint(points, index, x, y) {
  const point = points[index];
  if (!point) return;
  if (index === 0 || index === points.length - 1) {
    point.y = y;
    return;
  }
  const prevX = points[index - 1].x + 1;
  const nextX = points[index + 1].x - 1;
  point.x = Math.max(prevX, Math.min(nextX, x));
  point.y = y;
}

/** Index of the first point within `threshold` canvas px of (canvasX, canvasY), else -1. */
export function findNearPointIndex(points, canvasX, canvasY, canvasW, canvasH, threshold = 15) {
  for (let i = 0; i < points.length; i++) {
    const px = (points[i].x / 255) * canvasW;
    const py = canvasH - (points[i].y / 255) * canvasH;
    const dist = Math.sqrt((canvasX - px) ** 2 + (canvasY - py) ** 2);
    if (dist < threshold) return i;
  }
  return -1;
}

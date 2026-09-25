// Dodge and burn: local exposure strokes and their rasterisation into a gain
// map. Strokes are stored as vector paths in normalised coordinates of the
// unrotated, unmirrored base image (0..1 in x and y), each with an exposure
// delta in stops: negative dodges (less exposure, lighter print), positive
// burns (more exposure, darker print). The renderer maps them into the
// working frame (rotation, mirror, crop) and multiplies the negative in linear
// light by 2^stops before the tone curves, exactly where the enlarger's light
// would have been held back or added.

const MAX_STROKES = 200;
const MAX_POINTS = 400;

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

// sanitizeSettings runs per preview request, GL draw and tile rebuild, and
// every write site assigns a new localExposure object (strokes are never
// edited in place), so the result is cached by input identity. Only by input:
// the sanitiser is not idempotent (a feather that clamps to 0 becomes 0.5 on
// a second pass), so an output must not be returned for itself. Cached
// results are shared and must not be mutated; stored settings copy them
// (deepCopySanitizedSettings).
const sanitizedLocalExposure = new WeakMap();
// Cache misses of both stroke sanitisers (repair strokes: repairBrush.js),
// read by tests and the darkroom smoke.
export const strokeSanitizerStats = { misses: 0 };

export function sanitizeLocalExposureForSettings(input) {
  if (!input || typeof input !== 'object') return null;
  if (sanitizedLocalExposure.has(input)) return sanitizedLocalExposure.get(input);
  strokeSanitizerStats.misses += 1;
  const result = sanitizeLocalExposureStrokes(input);
  sanitizedLocalExposure.set(input, result);
  return result;
}

// The uncached sanitiser, also used for repair strokes (repairBrush.js).
export function sanitizeLocalExposureStrokes(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.strokes)) return null;
  const strokes = [];
  for (const stroke of input.strokes.slice(0, MAX_STROKES)) {
    if (!stroke || !Array.isArray(stroke.points) || !stroke.points.length) continue;
    const stops = Number(stroke.stops);
    const size = Number(stroke.size);
    if (!Number.isFinite(stops) || !Number.isFinite(size)) continue;
    const points = [];
    for (const point of stroke.points.slice(0, MAX_POINTS)) {
      const x = Number(point?.x); const y = Number(point?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const pressure = Number(point?.p);
      points.push({ x: Number(clamp(x, -0.5, 1.5).toFixed(5)), y: Number(clamp(y, -0.5, 1.5).toFixed(5)), p: Number.isFinite(pressure) ? Number(clamp(pressure, 0.05, 1).toFixed(3)) : 1 });
    }
    if (!points.length) continue;
    strokes.push({
      stops: Number(clamp(stops, -3, 3).toFixed(3)),
      size: Number(clamp(size, 0.005, 1).toFixed(4)),
      feather: Number(clamp(Number(stroke.feather) || 0.5, 0, 1).toFixed(3)),
      points
    });
  }
  if (!strokes.length) return null;
  return { strokes };
}

// One size rule for the rotated frame lives in imageGeometry.js.
export { rotatedDimensions } from './imageGeometry.js';

// Maps a base-normalised point through the geometry chain to working-frame
// pixel coordinates. `geometry` = { baseWidth, baseHeight, rotationAngle,
// mirrored, rotatedWidth, rotatedHeight, cropRegion|null, width, height } where
// width/height are the working image size the gain map is built for.
export function basePointToWorking(point, geometry) {
  const { baseWidth, baseHeight } = geometry;
  const angle = (Number(geometry.rotationAngle) || 0) * Math.PI / 180;
  const cos = Math.cos(angle); const sin = Math.sin(angle);
  const rotatedWidth = geometry.rotatedWidth || baseWidth;
  const rotatedHeight = geometry.rotatedHeight || baseHeight;
  // Base pixel, centred, rotated about the centre into the rotated canvas.
  const bx = point.x * baseWidth - baseWidth / 2;
  const by = point.y * baseHeight - baseHeight / 2;
  let x = bx * cos - by * sin + rotatedWidth / 2;
  let y = bx * sin + by * cos + rotatedHeight / 2;
  if (geometry.mirrored) x = rotatedWidth - x;
  const crop = geometry.cropRegion;
  const cropX = crop ? (crop.left ?? crop.x ?? 0) : 0; const cropY = crop ? (crop.top ?? crop.y ?? 0) : 0;
  const cropW = crop ? crop.width : rotatedWidth; const cropH = crop ? crop.height : rotatedHeight;
  // Scale from the cropped full-resolution frame to the working size.
  const sx = geometry.width / cropW; const sy = geometry.height / cropH;
  return { x: (x - cropX) * sx, y: (y - cropY) * sy, scale: Math.min(sx * cropW, sy * cropH) };
}

// Inverse of basePointToWorking for a working-frame pixel.
export function workingPointToBase(point, geometry) {
  const { baseWidth, baseHeight } = geometry;
  const angle = (Number(geometry.rotationAngle) || 0) * Math.PI / 180;
  const cos = Math.cos(angle); const sin = Math.sin(angle);
  const rotatedWidth = geometry.rotatedWidth || baseWidth;
  const rotatedHeight = geometry.rotatedHeight || baseHeight;
  const crop = geometry.cropRegion;
  const cropX = crop ? (crop.left ?? crop.x ?? 0) : 0; const cropY = crop ? (crop.top ?? crop.y ?? 0) : 0;
  const cropW = crop ? crop.width : rotatedWidth; const cropH = crop ? crop.height : rotatedHeight;
  let x = point.x * (cropW / geometry.width) + cropX;
  let y = point.y * (cropH / geometry.height) + cropY;
  if (geometry.mirrored) x = rotatedWidth - x;
  const rx = x - rotatedWidth / 2; const ry = y - rotatedHeight / 2;
  const bx = rx * cos + ry * sin + baseWidth / 2;
  const by = -rx * sin + ry * cos + baseHeight / 2;
  return { x: bx / baseWidth, y: by / baseHeight };
}

// Visits each stroke's coverage in the working frame: `visit(stroke, bx0,
// by0, bw, bh, coverage)` receives the stroke's pixel bounding box and a
// Float32 buffer over that box holding the maximum falloff (0..1) of its
// segments. Brush size is a fraction of the base short side; feather widens
// the soft edge. Only the stroke's box is allocated, so a full-resolution
// export or repair mask never needs a frame-sized buffer per stroke.
// `geometry.window` ({ x, y, width, height } in working-frame pixels) clips the
// boxes to a region (#248's detail layer): each pixel's coverage is its own
// maximum over the segments, so the clipped values equal the frame's.
export function forEachStrokeCoverage(localExposure, geometry, visit) {
  const width = geometry.width; const height = geometry.height;
  const clip = geometry.window || null;
  const strokes = localExposure?.strokes;
  if (!Array.isArray(strokes) || !strokes.length) return;
  const shortSide = Math.min(geometry.baseWidth, geometry.baseHeight);
  for (const stroke of strokes) {
    const points = stroke.points.map((p) => ({ ...basePointToWorking(p, geometry), p: p.p ?? 1 }));
    if (!points.length) continue;
    const scale = points[0].scale / Math.min(geometry.cropRegion ? geometry.cropRegion.width : (geometry.rotatedWidth || geometry.baseWidth), geometry.cropRegion ? geometry.cropRegion.height : (geometry.rotatedHeight || geometry.baseHeight));
    const radius = Math.max(1, stroke.size * shortSide * scale / 2);
    const feather = clamp(stroke.feather ?? 0.5, 0, 1);
    const hard = radius * (1 - feather);
    const segments = points.length === 1 ? [[points[0], points[0]]] : points.slice(1).map((p, i) => [points[i], p]);
    // Coverage keeps the maximum falloff per stroke so overlapping segments
    // of one stroke do not double up.
    const maxR = radius * Math.max(...points.map((p) => p.p));
    let bx0 = Math.max(0, Math.floor(Math.min(...points.map((p) => p.x)) - maxR));
    let bx1 = Math.min(width - 1, Math.ceil(Math.max(...points.map((p) => p.x)) + maxR));
    let by0 = Math.max(0, Math.floor(Math.min(...points.map((p) => p.y)) - maxR));
    let by1 = Math.min(height - 1, Math.ceil(Math.max(...points.map((p) => p.y)) + maxR));
    if (clip) {
      bx0 = Math.max(bx0, clip.x); bx1 = Math.min(bx1, clip.x + clip.width - 1);
      by0 = Math.max(by0, clip.y); by1 = Math.min(by1, clip.y + clip.height - 1);
    }
    if (bx1 < bx0 || by1 < by0) continue;
    const bw = bx1 - bx0 + 1;
    const bh = by1 - by0 + 1;
    const coverage = new Float32Array(bw * bh);
    for (const [a, b] of segments) {
      const r = radius * Math.max(a.p, b.p);
      const x0 = Math.max(bx0, Math.floor(Math.min(a.x, b.x) - r)); const x1 = Math.min(bx1, Math.ceil(Math.max(a.x, b.x) + r));
      const y0 = Math.max(by0, Math.floor(Math.min(a.y, b.y) - r)); const y1 = Math.min(by1, Math.ceil(Math.max(a.y, b.y) + r));
      if (x1 < x0 || y1 < y0) continue;
      const dx = b.x - a.x; const dy = b.y - a.y;
      const lengthSq = dx * dx + dy * dy;
      const ph = hard * Math.max(a.p, b.p);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5; const py = y + 0.5;
          let t = lengthSq > 0 ? ((px - a.x) * dx + (py - a.y) * dy) / lengthSq : 0;
          t = clamp(t, 0, 1);
          const cx = a.x + t * dx; const cy = a.y + t * dy;
          const dist = Math.hypot(px - cx, py - cy);
          if (dist >= r) continue;
          const falloff = dist <= ph ? 1 : 0.5 + 0.5 * Math.cos(Math.PI * (dist - ph) / Math.max(1e-6, r - ph));
          const idx = (y - by0) * bw + (x - bx0);
          if (falloff > coverage[idx]) coverage[idx] = falloff;
        }
      }
    }
    visit(stroke, bx0, by0, bw, bh, coverage);
  }
}

// Rasterises strokes into a Float32Array of stops per pixel (0 = untouched).
// Overlapping strokes add up, so a second pass burns twice. With
// `geometry.window` it covers that region of the frame only, with the frame's
// values (#248's detail layer).
export function rasterizeExposureStops(localExposure, geometry) {
  const window = geometry.window || { x: 0, y: 0, width: geometry.width, height: geometry.height };
  const stride = window.width;
  const stops = new Float32Array(window.width * window.height);
  forEachStrokeCoverage(localExposure, geometry, (stroke, bx0, by0, bw, bh, coverage) => {
    for (let y = by0; y < by0 + bh; y++) {
      for (let x = bx0; x < bx0 + bw; x++) {
        const c = coverage[(y - by0) * bw + (x - bx0)];
        if (c > 0) stops[(y - window.y) * stride + (x - window.x)] += stroke.stops * c;
      }
    }
  });
  return stops;
}

export { applyExposureStopsToImage16, hasExposureStops } from '../silvercore/util/localExposure.js';

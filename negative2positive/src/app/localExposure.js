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

export function sanitizeLocalExposureForSettings(input) {
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

// Size of the frame after applyRotationToImageData (imageGeometry.js): right
// angles swap the sides, other angles grow the canvas to the rotated bounds.
export function rotatedDimensions(width, height, angle) {
  let normalized = ((Number(angle) || 0) + 180) % 360;
  if (normalized < 0) normalized += 360;
  normalized -= 180;
  if (Math.abs(normalized) < 0.001) return { width, height };
  const rightAngle = Math.round(normalized / 90) * 90;
  if (Math.abs(normalized - rightAngle) < 0.001) {
    return Math.abs(rightAngle) % 180 === 90 ? { width: height, height: width } : { width, height };
  }
  const rad = normalized * Math.PI / 180;
  const cos = Math.abs(Math.cos(rad)); const sin = Math.abs(Math.sin(rad));
  return { width: Math.max(1, Math.ceil(width * cos + height * sin)), height: Math.max(1, Math.ceil(width * sin + height * cos)) };
}

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

// Rasterises strokes into a Float32Array of stops per pixel (0 = untouched).
// Brush size is a fraction of the base short side; feather widens the soft
// edge. Overlapping strokes add up, so a second pass burns twice.
export function rasterizeExposureStops(localExposure, geometry) {
  const width = geometry.width; const height = geometry.height;
  const stops = new Float32Array(width * height);
  const strokes = localExposure?.strokes;
  if (!Array.isArray(strokes) || !strokes.length) return stops;
  const shortSide = Math.min(geometry.baseWidth, geometry.baseHeight);
  for (const stroke of strokes) {
    const points = stroke.points.map((p) => ({ ...basePointToWorking(p, geometry), p: p.p ?? 1 }));
    if (!points.length) continue;
    const scale = points[0].scale / Math.min(geometry.cropRegion ? geometry.cropRegion.width : (geometry.rotatedWidth || geometry.baseWidth), geometry.cropRegion ? geometry.cropRegion.height : (geometry.rotatedHeight || geometry.baseHeight));
    const radius = Math.max(1, stroke.size * shortSide * scale / 2);
    const feather = clamp(stroke.feather ?? 0.5, 0, 1);
    const hard = radius * (1 - feather);
    const segments = points.length === 1 ? [[points[0], points[0]]] : points.slice(1).map((p, i) => [points[i], p]);
    // Coverage accumulates the maximum falloff per stroke so overlapping
    // segments of one stroke do not double up, then the stroke adds once. The
    // buffer only spans the stroke's bounding box (a full-resolution export
    // must not allocate a frame-sized buffer per stroke).
    const maxR = radius * Math.max(...points.map((p) => p.p));
    const bx0 = Math.max(0, Math.floor(Math.min(...points.map((p) => p.x)) - maxR));
    const bx1 = Math.min(width - 1, Math.ceil(Math.max(...points.map((p) => p.x)) + maxR));
    const by0 = Math.max(0, Math.floor(Math.min(...points.map((p) => p.y)) - maxR));
    const by1 = Math.min(height - 1, Math.ceil(Math.max(...points.map((p) => p.y)) + maxR));
    if (bx1 < bx0 || by1 < by0) continue;
    const bw = bx1 - bx0 + 1;
    const coverage = new Float32Array(bw * (by1 - by0 + 1));
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
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const c = coverage[(y - by0) * bw + (x - bx0)];
        if (c > 0) stops[y * width + x] += stroke.stops * c;
      }
    }
  }
  return stops;
}

export { applyExposureStopsToImage16, hasExposureStops } from '../silvercore/util/localExposure.js';

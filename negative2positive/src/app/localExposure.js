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

// One base-normalised point as stored strokes keep it (clamped just outside
// the frame, 5 decimals, pressure 0.05-1 to 3 decimals), or null. The live
// dodge-and-burn request rounds its points with it too (#254), so the stroke
// painted is the stroke stored.
export function sanitizeStrokePoint(point) {
  const x = Number(point?.x); const y = Number(point?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const pressure = Number(point?.p);
  return { x: Number(clamp(x, -0.5, 1.5).toFixed(5)), y: Number(clamp(y, -0.5, 1.5).toFixed(5)), p: Number.isFinite(pressure) ? Number(clamp(pressure, 0.05, 1).toFixed(3)) : 1 };
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
      const clean = sanitizeStrokePoint(point);
      if (clean) points.push(clean);
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

// One stroke in working-frame pixels: its points, brush radius and hard core,
// and its pixel bounding box clipped to the frame (and to `geometry.window`),
// or null when that box is empty.
export function prepareStrokeCoverage(stroke, geometry) {
  const width = geometry.width; const height = geometry.height;
  const clip = geometry.window || null;
  const shortSide = Math.min(geometry.baseWidth, geometry.baseHeight);
  const points = stroke.points.map((p) => ({ ...basePointToWorking(p, geometry), p: p.p ?? 1 }));
  if (!points.length) return null;
  const scale = points[0].scale / Math.min(geometry.cropRegion ? geometry.cropRegion.width : (geometry.rotatedWidth || geometry.baseWidth), geometry.cropRegion ? geometry.cropRegion.height : (geometry.rotatedHeight || geometry.baseHeight));
  const radius = Math.max(1, stroke.size * shortSide * scale / 2);
  const feather = clamp(stroke.feather ?? 0.5, 0, 1);
  const hard = radius * (1 - feather);
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
  if (bx1 < bx0 || by1 < by0) return null;
  return { stroke, points, radius, hard, bx0, by0, bx1, by1 };
}

// Maximum falloff of the segment a-b (points with x, y, p) into `coverage`, a
// buffer whose index is (y - oy) * stride + (x - ox), for the pixels of its box
// inside [cx0, cx1] x [cy0, cy1]. The per-pixel arithmetic is the original
// raster's (#254 D2, bitwise equal): pixels already at 1 are skipped (the
// falloff never exceeds 1), a squared distance clearly at or beyond r skips
// Math.hypot for pixels it would reject, and one clearly inside the hard core
// is 1 without it. The guards are 1e-12 relative, far above the few-ulp errors
// of the squared sum and of Math.hypot, so they only skip what the original
// test decides the same way.
export function segmentCoverageInto(coverage, ox, oy, stride, cx0, cy0, cx1, cy1, a, b, radius, hard) {
  const r = radius * Math.max(a.p, b.p);
  const x0 = Math.max(cx0, Math.floor(Math.min(a.x, b.x) - r)); const x1 = Math.min(cx1, Math.ceil(Math.max(a.x, b.x) + r));
  const y0 = Math.max(cy0, Math.floor(Math.min(a.y, b.y) - r)); const y1 = Math.min(cy1, Math.ceil(Math.max(a.y, b.y) + r));
  if (x1 < x0 || y1 < y0) return false;
  const ax = a.x; const ay = a.y;
  const dx = b.x - ax; const dy = b.y - ay;
  const lengthSq = dx * dx + dy * dy;
  const ph = hard * Math.max(a.p, b.p);
  const w = Math.max(1e-6, r - ph);
  const outside = r * r * (1 + 1e-12);
  const inside = ph * ph * (1 - 1e-12);
  for (let y = y0; y <= y1; y++) {
    const py = y + 0.5;
    // The second product of the projection's numerator, as the original computes it.
    const rowTerm = (py - ay) * dy;
    const row = (y - oy) * stride - ox;
    for (let x = x0; x <= x1; x++) {
      const idx = row + x;
      const current = coverage[idx];
      if (current === 1) continue;
      const px = x + 0.5;
      let t = lengthSq > 0 ? ((px - ax) * dx + rowTerm) / lengthSq : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = px - (ax + t * dx); const ey = py - (ay + t * dy);
      const d2 = ex * ex + ey * ey;
      if (d2 >= outside) continue;
      if (d2 < inside) { coverage[idx] = 1; continue; }
      const dist = Math.hypot(ex, ey);
      if (dist >= r) continue;
      const falloff = dist <= ph ? 1 : 0.5 + 0.5 * Math.cos(Math.PI * (dist - ph) / w);
      if (falloff > current) coverage[idx] = falloff;
    }
  }
  return true;
}

// The segments of a prepared stroke: consecutive points, or the point itself
// for a one-point stroke (a disc).
export function strokeSegments(points) {
  return points.length === 1 ? [[points[0], points[0]]] : points.slice(1).map((p, i) => [points[i], p]);
}

// Every segment of a prepared stroke into `coverage` over the clip box.
// `scratch` (a Float64Array of at least the clip box's size, optional) lets a
// soft stroke of uniform pressure take the nearest-segment path.
function strokeCoverageInto(prepared, coverage, ox, oy, stride, cx0, cy0, cx1, cy1, scratch = null) {
  const { points, radius, hard } = prepared;
  if (points.length === 1) {
    segmentCoverageInto(coverage, ox, oy, stride, cx0, cy0, cx1, cy1, points[0], points[0], radius, hard);
    return;
  }
  if (points.length > 2 && nearestSegmentApplies(prepared)) {
    const width = cx1 - cx0 + 1; const height = cy1 - cy0 + 1;
    if (width > 0 && height > 0) {
      const best = scratch && scratch.length >= width * height ? scratch : new Float64Array(width * height);
      nearestSegmentCoverageInto(prepared, coverage, ox, oy, stride, cx0, cy0, cx1, cy1, best);
    }
    return;
  }
  for (let i = 1; i < points.length; i++) {
    segmentCoverageInto(coverage, ox, oy, stride, cx0, cy0, cx1, cy1, points[i - 1], points[i], radius, hard);
  }
}

// The nearest-segment path (#254 D3, bitwise equal to segmentCoverageInto over
// every segment). With one pressure for the whole stroke every segment has the
// same r, core and feather width, so a pixel's coverage is the largest computed
// falloff, which belongs to the segment nearest to it up to rounding. The falloff
// is evaluated (Math.hypot and Math.cos, most of the raster's time) only for
// segments whose squared distance is within 1e-6 of the pixel's nearest one; a
// segment farther than that has a true falloff smaller by at least 1e-13 (the
// cosine argument lies in [2e-3, pi - 2e-3] and moves by at least 4e-7 of
// itself), far more than the ~2e-15 error of computing it, so it could never be
// the maximum. Pixels whose nearest distance puts the argument within 2e-3 of 0
// or pi, where the falloff is flat, evaluate every segment as before.
function nearestSegmentApplies({ points, radius, hard }) {
  if (!(hard < radius)) return false;
  const p = points[0].p;
  for (let i = 1; i < points.length; i++) if (points[i].p !== p) return false;
  return true;
}

// Each segment's pixel box and projection terms, as segmentCoverageInto has them.
function segmentLoop(a, b, r, cx0, cy0, cx1, cy1) {
  const x0 = Math.max(cx0, Math.floor(Math.min(a.x, b.x) - r)); const x1 = Math.min(cx1, Math.ceil(Math.max(a.x, b.x) + r));
  const y0 = Math.max(cy0, Math.floor(Math.min(a.y, b.y) - r)); const y1 = Math.min(cy1, Math.ceil(Math.max(a.y, b.y) + r));
  if (x1 < x0 || y1 < y0) return null;
  const dx = b.x - a.x; const dy = b.y - a.y;
  return { x0, x1, y0, y1, ax: a.x, ay: a.y, dx, dy, lengthSq: dx * dx + dy * dy };
}

function nearestSegmentCoverageInto(prepared, coverage, ox, oy, stride, cx0, cy0, cx1, cy1, best) {
  const { points, radius, hard } = prepared;
  const pressure = points[0].p;
  const r = radius * pressure;
  const ph = hard * pressure;
  const w = Math.max(1e-6, r - ph);
  const outside = r * r * (1 + 1e-12);
  const inside = ph * ph * (1 - 1e-12);
  const bw = cx1 - cx0 + 1;
  const count = bw * (cy1 - cy0 + 1);
  best.fill(Infinity, 0, count);
  const loops = [];
  for (let i = 1; i < points.length; i++) {
    const loop = segmentLoop(points[i - 1], points[i], r, cx0, cy0, cx1, cy1);
    if (loop) loops.push(loop);
  }
  // Pass 1: each pixel's smallest squared distance (and the hard core).
  for (const { x0, x1, y0, y1, ax, ay, dx, dy, lengthSq } of loops) {
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      const rowTerm = (py - ay) * dy;
      const row = (y - oy) * stride - ox;
      const scratchRow = (y - cy0) * bw - cx0;
      for (let x = x0; x <= x1; x++) {
        const idx = row + x;
        if (coverage[idx] === 1) continue;
        const px = x + 0.5;
        let t = lengthSq > 0 ? ((px - ax) * dx + rowTerm) / lengthSq : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = px - (ax + t * dx); const ey = py - (ay + t * dy);
        const d2 = ex * ex + ey * ey;
        if (d2 < inside) { coverage[idx] = 1; continue; }
        const k = scratchRow + x;
        if (d2 < best[k]) best[k] = d2;
      }
    }
  }
  // The candidates' bound per pixel: -1 when every segment misses it, Infinity in
  // the flat zones (every segment evaluated), else 1e-6 above its nearest.
  for (let k = 0; k < count; k++) {
    const d2 = best[k];
    if (!(d2 < outside)) { best[k] = -1; continue; }
    const argument = Math.PI * (Math.sqrt(d2) - ph) / w;
    best[k] = argument < 2e-3 || argument > Math.PI - 2e-3 ? Infinity : d2 * (1 + 1e-6);
  }
  // Pass 2: the original per-segment test, for the candidates only.
  for (const { x0, x1, y0, y1, ax, ay, dx, dy, lengthSq } of loops) {
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      const rowTerm = (py - ay) * dy;
      const row = (y - oy) * stride - ox;
      const scratchRow = (y - cy0) * bw - cx0;
      for (let x = x0; x <= x1; x++) {
        const idx = row + x;
        const current = coverage[idx];
        if (current === 1) continue;
        const bound = best[scratchRow + x];
        if (bound < 0) continue;
        const px = x + 0.5;
        let t = lengthSq > 0 ? ((px - ax) * dx + rowTerm) / lengthSq : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = px - (ax + t * dx); const ey = py - (ay + t * dy);
        const d2 = ex * ex + ey * ey;
        if (d2 >= outside || d2 > bound) continue;
        const dist = Math.hypot(ex, ey);
        if (dist >= r) continue;
        const falloff = dist <= ph ? 1 : 0.5 + 0.5 * Math.cos(Math.PI * (dist - ph) / w);
        if (falloff > current) coverage[idx] = falloff;
      }
    }
  }
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
  const strokes = localExposure?.strokes;
  if (!Array.isArray(strokes) || !strokes.length) return;
  for (const stroke of strokes) {
    const prepared = prepareStrokeCoverage(stroke, geometry);
    if (!prepared) continue;
    const { bx0, by0, bx1, by1 } = prepared;
    const bw = bx1 - bx0 + 1;
    const bh = by1 - by0 + 1;
    const coverage = new Float32Array(bw * bh);
    strokeCoverageInto(prepared, coverage, bx0, by0, bw, bx0, by0, bx1, by1);
    visit(stroke, bx0, by0, bw, bh, coverage);
  }
}

// Adds one stroke's coverage (a box of `bw` x `bh` at bx0, by0 in frame pixels)
// times its stops into a dense map of the window, as the raster always has.
function addCoverageToStops(stops, window, stroke, bx0, by0, bw, bh, coverage) {
  const stride = window.width;
  for (let y = by0; y < by0 + bh; y++) {
    for (let x = bx0; x < bx0 + bw; x++) {
      const c = coverage[(y - by0) * bw + (x - bx0)];
      if (c > 0) stops[(y - window.y) * stride + (x - window.x)] += stroke.stops * c;
    }
  }
}

function geometryWindow(geometry) {
  return geometry.window || { x: 0, y: 0, width: geometry.width, height: geometry.height };
}

// Rasterises strokes into a Float32Array of stops per pixel (0 = untouched).
// Overlapping strokes add up, so a second pass burns twice. With
// `geometry.window` it covers that region of the frame only, with the frame's
// values (#248's detail layer).
export function rasterizeExposureStops(localExposure, geometry) {
  const window = geometryWindow(geometry);
  const stops = new Float32Array(window.width * window.height);
  forEachStrokeCoverage(localExposure, geometry, (stroke, bx0, by0, bw, bh, coverage) => {
    addCoverageToStops(stops, window, stroke, bx0, by0, bw, bh, coverage);
  });
  return stops;
}

// ---- Tiled full-resolution maps (#254 D5) ----

export const STOPS_TILE_SIZE = 256;

export function createTiledStops(width, height, tileSize = STOPS_TILE_SIZE) {
  const columns = Math.ceil(width / tileSize);
  const rows = Math.ceil(height / tileSize);
  return { tiled: true, width, height, tileSize, columns, rows, tiles: new Array(columns * rows).fill(null) };
}

// Bytes a map keeps: the dense array, or the allocated tiles.
export function exposureStopsBytes(stops) {
  if (!stops) return 0;
  if (stops.tiled) return stops.tiles.reduce((sum, tile) => sum + (tile ? tile.byteLength : 0), 0);
  return stops.byteLength || 0;
}

// rasterizeExposureStops() as 256 x 256 tiles allocated only where a stroke's
// coverage is above zero. Each stroke's coverage is computed one tile at a time
// (a max over the segments reaching the tile, which are all the segments whose
// box holds the pixel), and added in list order, so every pixel receives the
// same additions in the same order as the dense raster: the values are
// identical, and neither a frame-sized map nor a stroke-box-sized buffer exists.
export function rasterizeExposureStopsTiled(localExposure, geometry, tileSize = STOPS_TILE_SIZE) {
  const window = geometryWindow(geometry);
  const map = createTiledStops(window.width, window.height, tileSize);
  const strokes = localExposure?.strokes;
  if (!Array.isArray(strokes) || !strokes.length) return map;
  const coverage = new Float32Array(tileSize * tileSize);
  const scratch = new Float64Array(tileSize * tileSize);
  for (const stroke of strokes) {
    const prepared = prepareStrokeCoverage(stroke, geometry);
    if (!prepared) continue;
    const segments = strokeSegments(prepared.points);
    // Tile columns and rows of the window the stroke's box reaches.
    const c0 = Math.floor((prepared.bx0 - window.x) / tileSize); const c1 = Math.floor((prepared.bx1 - window.x) / tileSize);
    const r0 = Math.floor((prepared.by0 - window.y) / tileSize); const r1 = Math.floor((prepared.by1 - window.y) / tileSize);
    for (let row = r0; row <= r1; row++) {
      for (let column = c0; column <= c1; column++) {
        // The tile in frame pixels, clipped to the stroke's box.
        const tx = window.x + column * tileSize; const ty = window.y + row * tileSize;
        const cx0 = Math.max(prepared.bx0, tx); const cx1 = Math.min(prepared.bx1, tx + tileSize - 1);
        const cy0 = Math.max(prepared.by0, ty); const cy1 = Math.min(prepared.by1, ty + tileSize - 1);
        if (cx1 < cx0 || cy1 < cy0) continue;
        // Only segments whose box reaches this part of the tile.
        let reaches = false;
        for (const [a, b] of segments) {
          const r = prepared.radius * Math.max(a.p, b.p);
          if (Math.floor(Math.min(a.x, b.x) - r) <= cx1 && Math.ceil(Math.max(a.x, b.x) + r) >= cx0
            && Math.floor(Math.min(a.y, b.y) - r) <= cy1 && Math.ceil(Math.max(a.y, b.y) + r) >= cy0) { reaches = true; break; }
        }
        if (!reaches) continue;
        coverage.fill(0);
        strokeCoverageInto(prepared, coverage, tx, ty, tileSize, cx0, cy0, cx1, cy1, scratch);
        const index = row * map.columns + column;
        let tile = map.tiles[index];
        for (let y = cy0; y <= cy1; y++) {
          const base = (y - ty) * tileSize - tx;
          for (let x = cx0; x <= cx1; x++) {
            const c = coverage[base + x];
            if (c > 0) {
              if (!tile) tile = map.tiles[index] = new Float32Array(tileSize * tileSize);
              tile[base + x] += stroke.stops * c;
            }
          }
        }
      }
    }
  }
  return map;
}

// ---- Incremental maps for a persistent slot (#254 D1) ----
//
// A dense map that remembers which strokes it holds. A new stroke list that
// extends the held one adds only the new strokes, in order, into the same
// array: the additions each pixel receives, and their order, are those of a
// full raster, so the values are identical. Removing the last stroke writes
// back the values its box held before it was added (one snapshot, of the last
// stroke only). Any other change rasterises the map again.

// By content, never by identity: settings are structured-cloned into workers,
// and an edited stroke must never keep its old key.
function strokeKey(stroke) {
  return JSON.stringify(stroke);
}

// The identity of a stroke list on a working geometry: the geometry and each
// stroke's content (settings are copied per render, so identity is not enough).
export function exposureMapKey(localExposure, geometry) {
  const strokes = localExposure?.strokes || [];
  return `${JSON.stringify(geometry)}|${strokes.map(strokeKey).join('|')}`;
}

function isPrefix(shorter, longer) {
  if (shorter.length > longer.length) return false;
  for (let i = 0; i < shorter.length; i++) if (shorter[i] !== longer[i]) return false;
  return true;
}

// Adds strokes[from..] into `map.stops`; the last one's box is saved first.
// Returns the union of the boxes that received a stroke (window pixels) or null.
function addStrokesToMap(map, strokes, geometry, from) {
  const window = map.window;
  let dirty = null;
  for (let i = from; i < strokes.length; i++) {
    const prepared = prepareStrokeCoverage(strokes[i], geometry);
    if (!prepared) {
      if (i === strokes.length - 1) map.undo = { index: i, rect: null, values: null };
      continue;
    }
    const { bx0, by0, bx1, by1 } = prepared;
    const bw = bx1 - bx0 + 1; const bh = by1 - by0 + 1;
    const rect = { x: bx0 - window.x, y: by0 - window.y, width: bw, height: bh };
    if (i === strokes.length - 1) map.undo = { index: i, rect, values: copyMapRect(map.stops, window.width, rect) };
    const coverage = new Float32Array(bw * bh);
    strokeCoverageInto(prepared, coverage, bx0, by0, bw, bx0, by0, bx1, by1);
    addCoverageToStops(map.stops, window, strokes[i], bx0, by0, bw, bh, coverage);
    dirty = unionRect(dirty, rect);
  }
  return dirty;
}

function copyMapRect(stops, stride, rect) {
  const values = new Float32Array(rect.width * rect.height);
  for (let y = 0; y < rect.height; y++) {
    const from = (rect.y + y) * stride + rect.x;
    values.set(stops.subarray(from, from + rect.width), y * rect.width);
  }
  return values;
}

export function unionRect(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const x = Math.min(a.x, b.x); const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/**
 * The dense map of `localExposure` for `geometry`, reusing `previous` (a map this
 * function returned) where it can. Returns { map, key, change }: `key` identifies
 * the strokes and geometry; `change` is { fromKey, rect } when `previous` was
 * updated in place and only `rect` (window pixels) changed, else null. `stats`
 * counts the path taken, for the tests.
 */
export function updateExposureStopsMap(previous, localExposure, geometry, stats = null) {
  const window = geometryWindow(geometry);
  const geometryKey = JSON.stringify(geometry);
  const strokes = localExposure?.strokes || [];
  const strokeKeys = strokes.map(strokeKey);
  const key = `${geometryKey}|${strokeKeys.join('|')}`;
  if (previous && previous.key === key) return { map: previous, key, change: null };
  if (previous && previous.geometryKey === geometryKey && previous.stops.length === window.width * window.height) {
    const fromKey = previous.key;
    if (isPrefix(previous.strokeKeys, strokeKeys)) {
      const rect = addStrokesToMap(previous, strokes, geometry, previous.strokeKeys.length);
      previous.strokeKeys = strokeKeys;
      previous.key = key;
      if (stats) stats.extended = (stats.extended || 0) + 1;
      return { map: previous, key, change: { fromKey, rect } };
    }
    const undo = previous.undo;
    if (strokeKeys.length === previous.strokeKeys.length - 1 && undo && undo.index === strokeKeys.length
      && isPrefix(strokeKeys, previous.strokeKeys)) {
      const { rect, values } = undo;
      if (rect) {
        for (let y = 0; y < rect.height; y++) previous.stops.set(values.subarray(y * rect.width, (y + 1) * rect.width), (rect.y + y) * window.width + rect.x);
      }
      previous.strokeKeys = strokeKeys;
      previous.key = key;
      previous.undo = null;
      if (stats) stats.undone = (stats.undone || 0) + 1;
      return { map: previous, key, change: { fromKey, rect } };
    }
  }
  const map = { key, geometryKey, strokeKeys, window, stops: new Float32Array(window.width * window.height), undo: null };
  addStrokesToMap(map, strokes, geometry, 0);
  if (stats) stats.full = (stats.full || 0) + 1;
  return { map, key, change: null };
}

export { applyExposureStopsToImage16, hasExposureStops, isTiledStops, exposureStopsCover } from '../silvercore/util/localExposure.js';

// ---- A stroke being painted (#254 C) ----
//
// The coverage of the stroke under the pointer, kept as sparse tiles of the
// working frame and grown one segment at a time: each new segment's falloff is
// maxed into the tiles (segmentCoverageInto, the stored raster's arithmetic), and
// the box it touched is the rectangle to convert again. A one-point stroke is its
// disc; the second point replaces the disc with the first segment, as the stored
// raster does, so for the same points the store holds exactly the coverage the
// stroke gets once it is stored.

// The brush of a sanitised stroke in a working geometry: radius and hard core
// (prepareStrokeCoverage's, which depend on the geometry and the stroke only).
export function strokeBrush(stroke, geometry) {
  const scale = basePointToWorking({ x: 0.5, y: 0.5 }, geometry).scale
    / Math.min(geometry.cropRegion ? geometry.cropRegion.width : (geometry.rotatedWidth || geometry.baseWidth), geometry.cropRegion ? geometry.cropRegion.height : (geometry.rotatedHeight || geometry.baseHeight));
  const shortSide = Math.min(geometry.baseWidth, geometry.baseHeight);
  const radius = Math.max(1, stroke.size * shortSide * scale / 2);
  const feather = clamp(stroke.feather ?? 0.5, 0, 1);
  return { radius, hard: radius * (1 - feather) };
}

export function createLiveStrokeCoverage(stroke, geometry, tileSize = 64) {
  const { radius, hard } = strokeBrush(stroke, geometry);
  return {
    stroke, geometry, tileSize, radius, hard,
    columns: Math.ceil(geometry.width / tileSize),
    points: [],
    tiles: new Map(),
    // Union of the boxes painted so far (frame pixels), or null.
    bounds: null,
  };
}

function paintLiveSegment(store, a, b) {
  const { geometry, tileSize, radius, hard } = store;
  const r = radius * Math.max(a.p, b.p);
  const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - r)); const x1 = Math.min(geometry.width - 1, Math.ceil(Math.max(a.x, b.x) + r));
  const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - r)); const y1 = Math.min(geometry.height - 1, Math.ceil(Math.max(a.y, b.y) + r));
  if (x1 < x0 || y1 < y0) return null;
  for (let row = Math.floor(y0 / tileSize); row <= Math.floor(y1 / tileSize); row++) {
    for (let column = Math.floor(x0 / tileSize); column <= Math.floor(x1 / tileSize); column++) {
      const index = row * store.columns + column;
      let tile = store.tiles.get(index);
      if (!tile) store.tiles.set(index, tile = new Float32Array(tileSize * tileSize));
      const tx = column * tileSize; const ty = row * tileSize;
      segmentCoverageInto(tile, tx, ty, tileSize, Math.max(x0, tx), Math.max(y0, ty),
        Math.min(x1, tx + tileSize - 1), Math.min(y1, ty + tileSize - 1), a, b, radius, hard);
    }
  }
  const box = { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
  store.bounds = unionRect(store.bounds, box);
  return box;
}

// Adds base-normalised points (sanitised as stored strokes are) and returns the
// rectangle whose coverage changed, or null.
export function addLiveStrokePoints(store, basePoints) {
  let dirty = null;
  for (const point of basePoints) {
    const working = { ...basePointToWorking(point, store.geometry), p: point.p ?? 1 };
    const points = store.points;
    points.push(working);
    if (points.length === 1) {
      dirty = unionRect(dirty, paintLiveSegment(store, working, working));
      continue;
    }
    if (points.length === 2) {
      // The disc gives way to the first segment.
      dirty = unionRect(dirty, store.bounds);
      store.tiles.clear();
      store.bounds = null;
    }
    dirty = unionRect(dirty, paintLiveSegment(store, points[points.length - 2], working));
  }
  return dirty;
}

// The store's coverage over `rect` (frame pixels), 0 where nothing was painted.
export function liveStrokeCoverageRect(store, rect) {
  const { tileSize, columns, tiles } = store;
  const out = new Float32Array(rect.width * rect.height);
  for (let y = 0; y < rect.height; y++) {
    const fy = rect.y + y;
    const row = Math.floor(fy / tileSize);
    const ty = (fy - row * tileSize) * tileSize;
    for (let x = 0; x < rect.width; x++) {
      const fx = rect.x + x;
      const column = Math.floor(fx / tileSize);
      const tile = tiles.get(row * columns + column);
      if (tile) out[y * rect.width + x] = tile[ty + fx - column * tileSize];
    }
  }
  return out;
}

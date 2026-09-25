// Parity of the stroke-bounded repair mask with the frame-wide mask it
// replaces (#246). The reference below is a frozen copy of repairMask,
// lensSourcePoint and rasterizeExposureStops as of 1703835; the new code must
// select the same pixels byte for byte in every geometry and lens case.
import assert from 'node:assert/strict';
import { repairMask, buildRepairMask, sanitizeRepairStrokes } from './repairBrush.js';
import { basePointToWorking, rasterizeExposureStops, rotatedDimensions } from './localExposure.js';

// ---- frozen reference (1703835) ----
function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}
function headRasterizeExposureStops(localExposure, geometry) {
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
function headLensSourcePoint(point, mapping) {
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
function headRepairMask(strokes, geometry, lensMapping = null) {
  const coverage = headRasterizeExposureStops({ strokes: strokes.map(stroke => ({
    ...stroke, stops: 1, feather: 0
  })) }, geometry);
  const mask = Uint8Array.from(coverage, value => value > 0 ? 255 : 0);
  if (!lensMapping) return mask;
  const { width, height } = geometry;
  const corrected = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = headLensSourcePoint({ x, y }, lensMapping);
    const sx = Math.round(p.x), sy = Math.round(p.y);
    if (sx >= 0 && sx < width && sy >= 0 && sy < height) corrected[y * width + x] = mask[sy * width + sx];
  }
  return corrected;
}

// ---- fixtures ----
let seed = 0x2468ace;
const random = () => {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

function geometryFor(baseWidth, baseHeight, angle, mirrored, crop, scale) {
  const rotated = rotatedDimensions(baseWidth, baseHeight, angle);
  const cropRegion = crop ? {
    left: Math.round(rotated.width * 0.12), top: Math.round(rotated.height * 0.08),
    width: Math.round(rotated.width * 0.7), height: Math.round(rotated.height * 0.75)
  } : null;
  const fullWidth = cropRegion ? cropRegion.width : rotated.width;
  const fullHeight = cropRegion ? cropRegion.height : rotated.height;
  return { baseWidth, baseHeight, rotationAngle: angle, mirrored, rotatedWidth: rotated.width,
    rotatedHeight: rotated.height, cropRegion,
    width: Math.max(1, Math.round(fullWidth * scale)), height: Math.max(1, Math.round(fullHeight * scale)) };
}

function strokeSet() {
  const strokes = [];
  // Dabs (single points), some with light pressure, one reaching past each edge.
  for (let i = 0; i < 5; i++) strokes.push({ size: 0.02 + random() * 0.05, points: [{ x: random(), y: random(), p: i % 2 ? 0.3 + random() * 0.6 : 1 }] });
  strokes.push({ size: 0.08, points: [{ x: -0.03, y: 0.4 }] });
  strokes.push({ size: 0.06, points: [{ x: 0.5, y: 1.02, p: 0.5 }] });
  strokes.push({ size: 0.05, points: [{ x: 1.4, y: -0.3 }] }); // fully outside
  // Drawn strokes with varying pressure, one crossing the frame edge.
  strokes.push({ size: 0.03, points: Array.from({ length: 9 }, (_, i) => ({ x: 0.2 + i * 0.07, y: 0.3 + Math.sin(i) * 0.1, p: 0.2 + (i % 4) * 0.2 })) });
  strokes.push({ size: 0.02, points: Array.from({ length: 6 }, (_, i) => ({ x: 0.9 + i * 0.03, y: 0.7 - i * 0.02 })) });
  return sanitizeRepairStrokes(strokes);
}

// Lensfun-like maps: each grid node holds the uncorrected source point of the
// corrected pixel (gx * step, gy * step), barrel (k > 0) or pincushion (k < 0),
// with per-channel TCA scaling. `extent` < 1 leaves pixels past the last grid
// column and row, where lensSourcePoint clamps. A half-pixel `shift` puts the
// samples on rounding ties, so a change in the bilinear expression order
// shows up as moved mask edges.
function lensFor(width, height, { step, k, tca = false, includeTca = tca, extent = 1, holes = false, shift = 0 }) {
  const gridWidth = Math.max(2, Math.ceil((width - 1) * extent / step) + 1);
  const gridHeight = Math.max(2, Math.ceil((height - 1) * extent / step) + 1);
  const cx = width / 2, cy = height / 2, norm = Math.hypot(cx, cy);
  const point = (x, y, scale) => {
    const dx = x - cx, dy = y - cy, r2 = (dx * dx + dy * dy) / (norm * norm);
    const f = (1 + k * r2) * scale;
    return [cx + dx * f + shift, cy + dy * f + shift];
  };
  const geometry = new Float32Array(gridWidth * gridHeight * 2);
  const tcaGrid = tca ? new Float32Array(gridWidth * gridHeight * 6) : null;
  for (let gy = 0; gy < gridHeight; gy++) for (let gx = 0; gx < gridWidth; gx++) {
    const i = gy * gridWidth + gx;
    const [x, y] = point(gx * step, gy * step, 1);
    geometry[i * 2] = x; geometry[i * 2 + 1] = y;
    if (tcaGrid) {
      const channels = [point(gx * step, gy * step, 1.004), point(gx * step, gy * step, 0.9995), point(gx * step, gy * step, 0.996)];
      channels.forEach(([px, py], c) => { tcaGrid[i * 6 + c * 2] = px; tcaGrid[i * 6 + c * 2 + 1] = py; });
    }
  }
  if (holes) {
    // Unmappable nodes and nodes far outside the frame.
    geometry[(1 * gridWidth + 2) * 2] = NaN;
    geometry[(2 * gridWidth + 1) * 2 + 1] = Infinity;
    geometry[(gridHeight - 1) * gridWidth * 2] = -1e6;
  }
  return { maps: { gridWidth, gridHeight, step, geometry, tca: tcaGrid }, includeTca };
}

const strokes = strokeSet();
const lenses = [
  null,
  { step: 8, k: 0.06 },
  { step: 8, k: -0.08 },
  { step: 7, k: 0.1, tca: true },
  { step: 5, k: -0.05, tca: true, extent: 0.8 },
  { step: 8, k: 0.04, tca: false, includeTca: true }, // TCA asked for but not in the maps
  { step: 6, k: 0.03, holes: true },
  { step: 7, k: 0, shift: 0.5 },
  { step: 3, k: 0, shift: -0.5, tca: true },
];
let cases = 0, selected = 0;
for (const angle of [0, 90, -90, 180, 3.7]) {
  for (const mirrored of [false, true]) {
    for (const crop of [false, true]) {
      for (const scale of [1, 0.37]) {
        const geometry = geometryFor(240, 170, angle, mirrored, crop, scale);
        for (const lensOptions of lenses) {
          if (scale !== 1 && lensOptions && lensOptions.step !== 8 && !lensOptions.shift) continue;
          const lens = lensOptions && lensFor(geometry.width, geometry.height, lensOptions);
          const label = JSON.stringify({ angle, mirrored, crop, scale, lensOptions });
          const expected = headRepairMask(strokes, geometry, lens);
          const actual = repairMask(strokes, geometry, lens);
          assert.deepEqual(actual, expected, label);
          const { mask, bounds } = buildRepairMask(strokes, geometry, lens);
          let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, count = 0;
          for (let i = 0; i < mask.length; i++) if (mask[i]) {
            const x = i % geometry.width, y = (i - x) / geometry.width;
            minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); count++;
          }
          assert.deepEqual(bounds, count ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
            `bounds are the rectangle actually selected: ${label}`);
          cases++; selected += count;
        }
      }
    }
  }
}
assert.ok(cases >= 160, `${cases} parity cases`);
assert.ok(selected > 0, 'the fixtures select pixels');
// Empty and fully outside selections.
{
  const geometry = geometryFor(200, 150, 0, false, false, 1);
  const lens = lensFor(200, 150, { step: 8, k: 0.05 });
  for (const input of [[], sanitizeRepairStrokes([{ size: 0.05, points: [{ x: 1.45, y: 1.45 }] }])]) {
    assert.deepEqual(buildRepairMask(input, geometry).bounds, null);
    assert.deepEqual(buildRepairMask(input, geometry, lens).bounds, null);
    assert.deepEqual(repairMask(input, geometry, lens), headRepairMask(input, geometry, lens));
  }
}

// The repair mask allocates no frame-sized float plane (240 MB at 60 MP).
{
  const geometry = geometryFor(640, 480, 3.7, true, true, 1);
  const lens = lensFor(geometry.width, geometry.height, { step: 8, k: 0.05, tca: true });
  const Native = globalThis.Float32Array;
  let largest = 0;
  globalThis.Float32Array = class extends Native {
    constructor(...args) { super(...args); largest = Math.max(largest, this.length); }
  };
  try {
    buildRepairMask(strokes, geometry);
    buildRepairMask(strokes, geometry, lens);
  } finally { globalThis.Float32Array = Native; }
  assert.ok(largest > 0 && largest < geometry.width * geometry.height / 4, `largest Float32Array ${largest} elements`);
}

// Dodge and burn keeps its bitwise output after the coverage helper split.
{
  const geometry = geometryFor(260, 190, 3.7, true, true, 0.8);
  for (const feather of [0, 0.5, 1]) {
    const layers = [];
    for (let stops = -3; stops <= 3; stops += 0.75) {
      layers.push({ stops, feather, size: 0.04 + random() * 0.2,
        points: Array.from({ length: 1 + (layers.length % 4) }, () => ({ x: random() * 1.2 - 0.1, y: random() * 1.2 - 0.1, p: 0.2 + random() * 0.8 })) });
    }
    const local = { strokes: layers };
    assert.deepEqual(rasterizeExposureStops(local, geometry), headRasterizeExposureStops(local, geometry), `feather ${feather}`);
  }
  assert.deepEqual(rasterizeExposureStops(null, geometry), headRasterizeExposureStops(null, geometry));
}

console.log(`repairBrush parity: ${cases} geometry/lens cases byte-identical to 1703835; dodge-and-burn bitwise identical`);

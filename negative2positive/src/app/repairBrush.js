import { sanitizeLocalExposureForSettings, rasterizeExposureStops } from './localExposure.js';

// Reuse base-image coordinates so repair strokes follow rotation, mirror and crop.
// These strokes are a selection, never exposure adjustments or automatic dust.
export function sanitizeRepairStrokes(input) {
  if (!Array.isArray(input)) return [];
  return sanitizeLocalExposureForSettings({ strokes: input.slice(0, 200).map(stroke => ({
    ...stroke, stops: 1, feather: 0,
    points: stroke?.points?.length > 400
      ? Array.from({ length: 400 }, (_, i) => stroke.points[Math.round(i * (stroke.points.length - 1) / 399)])
      : stroke?.points
  })) })?.strokes.map(({ points, size }) => ({ points, size })) || [];
}

// Lensfun maps corrected destination pixels to their uncorrected source.
// Use the green channel for the shared repair selection when TCA is enabled.
export function lensSourcePoint(point, mapping) {
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

export function repairMask(strokes, geometry, lensMapping = null) {
  const coverage = rasterizeExposureStops({ strokes: strokes.map(stroke => ({
    ...stroke, stops: 1, feather: 0
  })) }, geometry);
  const mask = Uint8Array.from(coverage, value => value > 0 ? 255 : 0);
  if (!lensMapping) return mask;
  const { width, height } = geometry;
  const corrected = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = lensSourcePoint({ x, y }, lensMapping);
    const sx = Math.round(p.x), sy = Math.round(p.y);
    if (sx >= 0 && sx < width && sy >= 0 && sy < height) corrected[y * width + x] = mask[sy * width + sx];
  }
  return corrected;
}

export function pointerToRepairPoint(event, rect, width, height) {
  if (!(rect.width > 0 && rect.height > 0)) return null;
  return {
    x: Math.max(0, Math.min(width, (event.clientX - rect.left) * width / rect.width)),
    y: Math.max(0, Math.min(height, (event.clientY - rect.top) * height / rect.height))
  };
}

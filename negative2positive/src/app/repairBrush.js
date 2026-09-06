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

export function repairMask(strokes, geometry) {
  const coverage = rasterizeExposureStops({ strokes: strokes.map(stroke => ({
    ...stroke, stops: 1, feather: 0
  })) }, geometry);
  return Uint8Array.from(coverage, value => value > 0 ? 255 : 0);
}

export function pointerToRepairPoint(event, rect, width, height) {
  if (!(rect.width > 0 && rect.height > 0)) return null;
  return {
    x: Math.max(0, Math.min(width, (event.clientX - rect.left) * width / rect.width)),
    y: Math.max(0, Math.min(height, (event.clientY - rect.top) * height / rect.height))
  };
}
